#include "PinWindow.h"
#include "CaptureAppearance.h"
#include "CaptureFeedback.h"
#include "DesktopCapture.h"
#include "DesktopLayout.h"
#include "DesktopTargets.h"
#include "PinHalo.h"
#include "SaveActions.h"
#include "SelectionSnap.h"
#include <QApplication>
#include <QCloseEvent>
#include <QContextMenuEvent>
#include <QMenu>
#include <QMessageBox>
#include <QPointer>
#include <QScreen>
#include <QToolTip>
#include <QWheelEvent>
#include <algorithm>
static Capture::ImageDocument makeDocument(QImage image) {
  Capture::ImageDocument d;
  d.base = std::move(image);
  return d;
}
PinWindow::PinWindow(QImage source)
    : PinWindow(makeDocument(std::move(source))) {}
PinWindow::PinWindow(Capture::ImageDocument source, QString prefs,
                     QRect initialGeometry, QScreen *initialScreen)
    : QWidget(nullptr,
              Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint | Qt::Tool),
      document(std::move(source)), image(document.base), settingsPath(prefs) {
  setAttribute(Qt::WA_DeleteOnClose);
  setWindowTitle(QStringLiteral("Abandon 贴图"));
  setFocusPolicy(Qt::StrongFocus);
  setMouseTracking(true);
  setMinimumSize(1, 1);
  if (auto s = initialScreen ? initialScreen
                             : QGuiApplication::screenAt(QCursor::pos()))
    setScreen(s);
  annotations = new AnnotationEditor(this, document, settingsPath);
  // An owned tool window keeps the shared toolbar accessible even for tiny
  // pins.
  annotations->panel->setWindowFlags(Qt::Tool | Qt::FramelessWindowHint |
                                     Qt::WindowStaysOnTopHint);
  annotations->addAction("quickSave", QStringLiteral("快速保存"),
                         "Ctrl+Shift+S");
  annotations->addHelp(QStringLiteral(
      "贴图\n拖动：移动贴图；Shift+拖动：吸附屏幕或其他贴图边缘\n"
      "滚轮 / +、-：缩放；Ctrl+滚轮 / Ctrl 加减号：透明度\n"
      "中键：恢复大小与透明度 100%\n"
      "E / 空格：开始或结束标注\n"
      "Ctrl+C：复制；Ctrl+S：另存为；Ctrl+Shift+S：快速保存\n"
      "非标注状态 1 / 2：旋转；3 / 4：水平 / 垂直翻转\n"
      "Esc：结束标注 / 关闭贴图；非标注时双击：关闭；Shift+Esc：销毁\n"
      "Shift+双击：缩略图 / 恢复大小\n"
      "关闭后可从便签托盘恢复最近一张贴图"));
  annotations->action("pin")->setVisible(false);
  annotations->action("copy")->setText(QStringLiteral("复制"));
  annotations->action("copy")->setToolTip(QStringLiteral("复制图像 · Ctrl+C"));
  annotations->action("cancel")->setToolTip(
      QStringLiteral("结束标注，保留贴图"));
  connect(annotations, &AnnotationEditor::layoutChanged, this,
          &PinWindow::placeToolbar);
  connect(annotations, &AnnotationEditor::changed, this, &PinWindow::refresh);
  connect(annotations, &AnnotationEditor::notice, this,
          [this](QString text) { showFeedback(text, 3500); });
  connect(annotations, &AnnotationEditor::actionRequested, this,
          [this](QString a) {
            if (a == "copy")
              copyImage();
            else if (a == "save" || a == "quickSave")
              saveImage(a == "quickSave");
            else if (a == "cancel")
              setEditing(false);
          });
  document.editable = -1;
  refresh();
  resetScale();
  if (!initialGeometry.isEmpty()) {
    setGeometry(initialGeometry);
    scale =
        double(width()) * devicePixelRatioF() / document.outputSize().width();
  } else {
    move(QCursor::pos() - QPoint(width() / 2, height() / 2));
    constrain();
  }
  halo = new Capture::PinHalo(this);
  feedback = new Capture::Feedback(this);
}
void PinWindow::refresh() {
  rendered = document.render(annotations->typing() ? document.editable : -1);
  update();
}
QImage PinWindow::exportImage() {
  annotations->complete();
  return document.render();
}
qint64 PinWindow::memoryCost() const {
  return document.memoryCost() + (halo ? halo->memoryCost() : 0) +
         (rendered.cacheKey() == document.base.cacheKey()
              ? 0
              : rendered.sizeInBytes());
}
PinWindow::ViewState PinWindow::viewState() const {
  return {geometry(),    windowOpacity(), scale,
          previousScale, thumbnail,       topmost};
}
void PinWindow::restoreView(const ViewState &state) {
  scale = state.scale;
  previousScale = state.previousScale;
  thumbnail = state.thumbnail;
  topmost = state.topmost;
  setWindowFlag(Qt::WindowStaysOnTopHint, topmost);
  setGeometry(state.geometry);
  setWindowOpacity(state.opacity);
  show();
  constrain();
}
void PinWindow::scaleTo(double value) {
  scale = std::clamp(value, 0.02, 8.0);
  auto out = document.outputSize();
  double ratio = scale / devicePixelRatioF();
  resize(std::max(1, qRound(out.width() * ratio)),
         std::max(1, qRound(out.height() * ratio)));
  constrain();
  showFeedback(QStringLiteral("缩放 %1%").arg(qRound(scale * 100)));
}
void PinWindow::resetScale() {
  thumbnail = false;
  scaleTo(1);
  setWindowOpacity(1);
  showFeedback(QStringLiteral("缩放 100% · 透明度 100%"));
}
bool PinWindow::placeAtPhysicalGeometry(QRect geometry) {
  const bool placed = Capture::placePhysicalWindow(winId(), geometry);
  if (placed)
    scale = double(geometry.width()) / document.outputSize().width();
  if (halo)
    halo->sync();
  return placed;
}
void PinWindow::opacityBy(double d) {
  setWindowOpacity(std::clamp(windowOpacity() + d, 0.2, 1.0));
  update();
  showFeedback(QStringLiteral("透明度 %1%").arg(qRound(windowOpacity() * 100)));
}
void PinWindow::constrain() {
  if (isVisible() && QGuiApplication::platformName() == "windows") {
    Capture::DesktopLayout layout;
    for (auto s : QGuiApplication::screens())
      layout.monitors << Capture::DesktopMonitor{Capture::nativeWorkArea(s),
                                                 s->availableGeometry()};
    const auto current = Capture::physicalWindowRect(winId());
    const int index = layout.monitorAt(current.center());
    // A pin spanning adjacent monitors must not jump onto just one of them at
    // mouse release. If only one panel is reached, retain the usual clamping.
    const auto touched =
        std::count_if(layout.monitors.begin(), layout.monitors.end(),
                      [&](auto m) { return m.physical.intersects(current); });
    if (index >= 0 && touched < 2)
      Capture::placePhysicalWindow(
          winId(), Capture::visiblePinGeometry(
                       current, layout.monitors[index].physical));
    placeToolbar();
    if (halo)
      halo->sync();
    return;
  }
  auto scr = QGuiApplication::screenAt(frameGeometry().center());
  if (!scr)
    scr = QGuiApplication::primaryScreen();
  if (!scr)
    return;
  auto r = scr->availableGeometry();
  move(Capture::visiblePinGeometry(geometry(), r).topLeft());
  placeToolbar();
  // Display topology can change without moving the image itself.
  if (halo)
    halo->sync();
}
void PinWindow::placeToolbar() {
  if (!annotations || !editing || !isVisible())
    return;
  auto s = screen()->availableGeometry();
  annotations->fitPanel(s.width());
  auto bar = annotations->panel;
  bar->move(s.topLeft() +
            Capture::toolbarPosition(geometry().translated(-s.topLeft()),
                                     bar->size(), s.size()));
  bar->show();
}
void PinWindow::setEditing(bool value) {
  annotations->complete();
  editing = value;
  dragging = false;
  if (value) {
    annotations->choose("select");
    placeToolbar();
  } else
    annotations->panel->hide();
  update();
}
void PinWindow::paintEvent(QPaintEvent *) {
  QPainter p(this);
  p.setRenderHint(QPainter::SmoothPixmapTransform);
  p.drawImage(rect(), rendered);
  if (editing)
    annotations->paintHandles(p);
}
void PinWindow::mousePressEvent(QMouseEvent *e) {
  if (e->button() == Qt::MiddleButton) {
    resetScale();
    return;
  }
  if (editing && annotations->press(e)) {
    suppressContext = e->button() == Qt::RightButton;
    return;
  }
  if (e->button() != Qt::LeftButton ||
      (editing && annotations->tool != "select"))
    return;
  dragging = true;
  dragStart = e->globalPosition().toPoint();
  origin = pos();
  initialSize = size();
  nativeDrag = QGuiApplication::platformName() == "windows";
  if (nativeDrag) {
    initialNative = Capture::physicalWindowRect(winId());
    nativeDragStart = Capture::physicalClientPoint(
        winId(), (e->position() * devicePixelRatioF()).toPoint());
  }
  resizeGrip = 0;
  if (!editing && width() >= 32 && height() >= 32) {
    if (e->position().x() < 7)
      resizeGrip |= 1;
    if (e->position().x() > width() - 7)
      resizeGrip |= 2;
    if (e->position().y() < 7)
      resizeGrip |= 4;
    if (e->position().y() > height() - 7)
      resizeGrip |= 8;
  }
  resizing = resizeGrip != 0;
}
void PinWindow::mouseMoveEvent(QMouseEvent *e) {
  if (editing && annotations->move(e))
    return;
  if (!(e->buttons() & Qt::LeftButton) || !dragging) {
    if (!editing) {
      bool xEdge = e->position().x() < 7 || e->position().x() > width() - 7,
           yEdge = e->position().y() < 7 || e->position().y() > height() - 7;
      const bool diagonal = (e->position().x() < 7) == (e->position().y() < 7);
      setCursor(xEdge && yEdge
                    ? (diagonal ? Qt::SizeFDiagCursor : Qt::SizeBDiagCursor)
                : xEdge ? Qt::SizeHorCursor
                : yEdge ? Qt::SizeVerCursor
                        : Qt::SizeAllCursor);
    }
    return;
  }
  if (nativeDrag) {
    dragInPhysicalPixels(e);
    return;
  }
  auto d = e->globalPosition().toPoint() - dragStart;
  if (resizing) {
    double ratio =
        (resizeGrip & 3)
            ? double(std::max(1, initialSize.width() +
                                     ((resizeGrip & 1) ? -d.x() : d.x()))) /
                  initialSize.width()
            : double(std::max(1, initialSize.height() +
                                     ((resizeGrip & 4) ? -d.y() : d.y()))) /
                  initialSize.height();
    scaleTo(initialSize.width() * ratio * devicePixelRatioF() /
            document.outputSize().width());
    move(origin +
         QPoint((resizeGrip & 1) ? initialSize.width() - width() : 0,
                (resizeGrip & 4) ? initialSize.height() - height() : 0));
  } else {
    auto next = origin + d;
    if (e->modifiers().testFlag(Qt::ShiftModifier)) {
      auto snap = [&](QRect r) {
        if (qAbs(next.x() - r.left()) < 12)
          next.setX(r.left());
        if (qAbs(next.x() + width() - r.x() - r.width()) < 12)
          next.setX(r.x() + r.width() - width());
        if (qAbs(next.y() - r.top()) < 12)
          next.setY(r.top());
        if (qAbs(next.y() + height() - r.y() - r.height()) < 12)
          next.setY(r.y() + r.height() - height());
      };
      snap(screen()->availableGeometry());
      for (auto w : QApplication::topLevelWidgets())
        if (w != this && qobject_cast<PinWindow *>(w) && w->isVisible()) {
          auto r = w->geometry();
          snap(r);
          if (qAbs(next.x() - r.x() - r.width()) < 12)
            next.setX(r.x() + r.width());
          if (qAbs(next.x() + width() - r.x()) < 12)
            next.setX(r.x() - width());
          if (qAbs(next.y() - r.y() - r.height()) < 12)
            next.setY(r.y() + r.height());
          if (qAbs(next.y() + height() - r.y()) < 12)
            next.setY(r.y() - height());
        }
    }
    move(next);
  }
}
void PinWindow::dragInPhysicalPixels(QMouseEvent *e) {
  const auto point = Capture::physicalClientPoint(
      winId(), (e->position() * devicePixelRatioF()).toPoint());
  const auto delta = point - nativeDragStart;
  QRect next = initialNative;
  if (resizing) {
    const double ratio =
        (resizeGrip & 3)
            ? double(std::max(1, initialNative.width() + ((resizeGrip & 1)
                                                              ? -delta.x()
                                                              : delta.x()))) /
                  initialNative.width()
            : double(std::max(1, initialNative.height() + ((resizeGrip & 4)
                                                               ? -delta.y()
                                                               : delta.y()))) /
                  initialNative.height();
    const auto out = document.outputSize();
    const double nextScale =
        std::clamp(initialNative.width() * ratio / out.width(), 0.02, 8.0);
    next.setSize({std::max(1, qRound(out.width() * nextScale)),
                  std::max(1, qRound(out.height() * nextScale))});
    next.moveTopLeft(
        initialNative.topLeft() +
        QPoint((resizeGrip & 1) ? initialNative.width() - next.width() : 0,
               (resizeGrip & 4) ? initialNative.height() - next.height() : 0));
  } else {
    next.translate(delta);
    if (e->modifiers().testFlag(Qt::ShiftModifier)) {
      QVector<QRect> screens, pins;
      QRect bounds;
      qreal ratio = devicePixelRatioF();
      for (auto s : QGuiApplication::screens()) {
        auto area = Capture::nativeWorkArea(s);
        screens << area;
        bounds = bounds.united(area);
        if (Capture::nativeScreenRect(s).contains(point))
          ratio = s->devicePixelRatio();
      }
      for (auto w : QApplication::topLevelWidgets())
        if (w != this && qobject_cast<PinWindow *>(w) && w->isVisible())
          pins << Capture::physicalWindowRect(w->winId());
      if (bounds.width() >= next.width() && bounds.height() >= next.height()) {
        Capture::SelectionSnap snap;
        snap.reset(bounds, screens, pins);
        next = snap.move(next, qRound(12 * ratio), bounds);
      }
    }
  }
  placeAtPhysicalGeometry(next);
}
void PinWindow::mouseReleaseEvent(QMouseEvent *e) {
  if (editing)
    annotations->release(e);
  dragging = false;
  constrain();
  if (resizing) {
    showFeedback(QStringLiteral("缩放 %1%").arg(qRound(scale * 100)));
    resizing = false;
  }
}
void PinWindow::mouseDoubleClickEvent(QMouseEvent *e) {
  if (editing) {
    annotations->doubleClick(e);
    return;
  }
  if (e->button() != Qt::LeftButton)
    return;
  if (e->modifiers().testFlag(Qt::ShiftModifier)) {
    if (!thumbnail) {
      previousScale = scale;
      scaleTo(120.0 * devicePixelRatioF() /
              std::max(document.outputSize().width(),
                       document.outputSize().height()));
      thumbnail = true;
    } else {
      thumbnail = false;
      scaleTo(previousScale);
    }
  } else
    close();
}
void PinWindow::wheelEvent(QWheelEvent *e) {
  if (e->modifiers().testFlag(Qt::ControlModifier))
    opacityBy(e->angleDelta().y() > 0 ? 0.05 : -0.05);
  else if (!editing || !annotations->wheel(e))
    scaleTo(scale * (e->angleDelta().y() > 0 ? 1.1 : 1 / 1.1));
}
void PinWindow::transform(int key) {
  annotations->complete();
  QTransform t;
  if (key == Qt::Key_1)
    t.rotate(90);
  if (key == Qt::Key_2)
    t.rotate(-90);
  if (key == Qt::Key_3)
    t.scale(-1, 1);
  if (key == Qt::Key_4)
    t.scale(1, -1);
  const auto center = geometry().center();
  document.transform *= t;
  refresh();
  scaleTo(scale);
  move(center - rect().center());
  constrain();
}
void PinWindow::keyPressEvent(QKeyEvent *e) {
  bool ctrl = e->modifiers().testFlag(Qt::ControlModifier),
       shift = e->modifiers().testFlag(Qt::ShiftModifier);
  auto k = e->key();
  if (k == Qt::Key_Escape && shift) {
    destroyPin();
    return;
  }
  if (editing && annotations->key(e))
    return;
  if (k == Qt::Key_Escape) {
    if (editing)
      setEditing(false);
    else
      close();
    return;
  }
  if (ctrl && k == Qt::Key_W) {
    close();
    return;
  }
  if (ctrl && k == Qt::Key_C) {
    copyImage();
    return;
  }
  if (ctrl && k == Qt::Key_S) {
    saveImage(shift);
    return;
  }
  if (k == Qt::Key_E || k == Qt::Key_Space) {
    setEditing(!editing);
    return;
  }
  if (k == Qt::Key_Plus || k == Qt::Key_Equal || k == Qt::Key_Minus) {
    if (ctrl)
      opacityBy(k == Qt::Key_Minus ? -0.05 : 0.05);
    else
      scaleTo(scale * (k == Qt::Key_Minus ? 1 / 1.1 : 1.1));
    return;
  }
  if (!editing && k >= Qt::Key_1 && k <= Qt::Key_4) {
    transform(k);
    return;
  }
  QPoint d;
  if (editing && annotations->hasCurrent())
    return;
  if (k == Qt::Key_Left)
    d = {-1, 0};
  if (k == Qt::Key_Right)
    d = {1, 0};
  if (k == Qt::Key_Up)
    d = {0, -1};
  if (k == Qt::Key_Down)
    d = {0, 1};
  if (!d.isNull()) {
    Capture::movePhysicalWindow(winId(), d);
    placeToolbar();
  }
}
void PinWindow::copyImage() {
  QString error;
  if (!Capture::writeClipboardImage(exportImage(), &error))
    QMessageBox::warning(this, QStringLiteral("复制失败"), error);
  else
    showFeedback(QStringLiteral("已复制到剪贴板"));
}
void PinWindow::showFeedback(const QString &message, int duration) {
  if (feedback && isVisible()) {
    // Keep feedback on this pin's display, including an image zoomed beyond
    // its work area. An off-desktop anchor would otherwise pick the primary.
    const auto visible = geometry().intersected(screen()->availableGeometry());
    const auto anchorPoint =
        visible.isEmpty() ? screen()->availableGeometry().center()
                          : QPoint(visible.center().x(), visible.bottom());
    feedback->showMessage(message, anchorPoint, duration);
  }
}
void PinWindow::saveImage(bool quick) {
  QPointer<PinWindow> guard(this);
  QString error, path;
  const bool saved = Capture::saveWithDialog(this, exportImage(), quick,
                                             settingsPath, &error, &path);
  if (guard && saved)
    showFeedback(QStringLiteral("已保存\n%1").arg(path), 4000);
  if (guard && !error.isEmpty())
    QMessageBox::warning(this, QStringLiteral("保存失败"), error);
}
void PinWindow::contextMenuEvent(QContextMenuEvent *e) {
  if (suppressContext) {
    suppressContext = false;
    return;
  }
  if (editing && annotations->hasCurrent()) {
    annotations->complete();
    return;
  }
  QPointer<PinWindow> guard(this);
  QMenu menu;
  menu.setStyleSheet(Capture::chromeStyle());
  connect(this, &QObject::destroyed, &menu, &QMenu::close);
  auto edit = menu.addAction(editing ? QStringLiteral("结束标注 · E")
                                     : QStringLiteral("标注 · E"));
  auto copy = menu.addAction(QStringLiteral("复制 · Ctrl+C")),
       save = menu.addAction(QStringLiteral("另存为 · Ctrl+S")),
       quick = menu.addAction(QStringLiteral("快速保存 · Ctrl+Shift+S"));
  auto folder = menu.addAction(QStringLiteral("快速保存目录…"));
  auto reset = menu.addAction(QStringLiteral("恢复大小与透明度 100% · 中键"));
  auto top = menu.addAction(QStringLiteral("置顶"));
  top->setCheckable(true);
  top->setChecked(topmost);
  auto help = menu.addAction(QStringLiteral("快捷键与操作说明"));
  menu.addSeparator();
  auto closed =
      menu.addAction(QStringLiteral("关闭 · Esc（可从托盘恢复最近一张）"));
  auto destroyed = menu.addAction(QStringLiteral("销毁 · Shift+Esc"));
  auto a = menu.exec(e->globalPos());
  if (!guard)
    return;
  if (a == edit)
    setEditing(!editing);
  else if (a == copy)
    copyImage();
  else if (a == save || a == quick)
    saveImage(a == quick);
  else if (a == folder)
    Capture::configureSaveDirectory(this, settingsPath);
  else if (a == reset)
    resetScale();
  else if (a == help)
    annotations->action("help")->trigger();
  else if (a == top) {
    topmost = !topmost;
    setWindowFlag(Qt::WindowStaysOnTopHint, topmost);
    show();
  } else if (a == closed)
    close();
  else if (a == destroyed)
    destroyPin();
}
void PinWindow::destroyPin() {
  destroying = true;
  close();
}
void PinWindow::closeEvent(QCloseEvent *e) {
  annotations->complete();
  annotations->panel->hide();
  if (closing)
    closing(this, destroying);
  QWidget::closeEvent(e);
}
void PinWindow::resizeEvent(QResizeEvent *) {
  if (annotations)
    placeToolbar();
}
void PinWindow::moveEvent(QMoveEvent *) {
  if (annotations)
    placeToolbar();
}
void PinWindow::hideEvent(QHideEvent *) {
  if (feedback)
    feedback->hide();
  if (annotations)
    annotations->panel->hide();
}
void PinWindow::showEvent(QShowEvent *) { placeToolbar(); }
