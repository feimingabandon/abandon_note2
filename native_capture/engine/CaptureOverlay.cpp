#include "CaptureOverlay.h"
#include "CaptureAppearance.h"
#include <QClipboard>
#include <QCloseEvent>
#include <QGuiApplication>
#include <QWheelEvent>
#include <algorithm>
CaptureOverlay::CaptureOverlay(QScreen *screen, QImage image, QString source,
                               Capture::DesktopLayout layout,
                               QString settingsPath)
    : QWidget(nullptr,
              Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint | Qt::Tool),
      origin(source), desktop(std::move(layout)) {
  setAttribute(Qt::WA_DeleteOnClose);
  setWindowTitle(QStringLiteral("Abandon 截图"));
  setMouseTracking(true);
  setFocusPolicy(Qt::StrongFocus);
  setScreen(screen);
  setGeometry(screen->geometry());
  document.base = std::move(image);
  rendered = document.base;
  nativeBounds = desktop.monitors.isEmpty() ? Capture::nativeScreenRect(screen)
                                            : desktop.bounds();
  targets =
      Capture::desktopTargets(desktop.monitors.isEmpty() ? screen : nullptr);
  rebuildSnapTargets();
  annotations = new AnnotationEditor(this, document, settingsPath);
  if (!desktop.monitors.isEmpty())
    annotations->viewportTransform = [this] {
      return QTransform::fromScale(1.0 / devicePixelRatioF(),
                                   1.0 / devicePixelRatioF());
    };
  annotations->addAction("full", QStringLiteral("全屏"), "Ctrl+A / F");
  annotations->addAction("quickSave", QStringLiteral("快速保存"),
                         "Ctrl+Shift+S");
  if (origin == "global") {
    annotations->addAction("note", QStringLiteral("新建图文便签"), "Ctrl+N");
    annotations->addAction("background", QStringLiteral("用作应用背景"),
                           "Ctrl+B");
  } else
    annotations->addAction("source",
                           origin == "background" ? QStringLiteral("使用背景")
                                                  : QStringLiteral("加入便签"),
                           QStringLiteral("使用此次截图 · Ctrl+Enter"));
  annotations->addHelp(QStringLiteral(
      "截图\n未框选时 Tab：切换窗口 / 控件识别\n"
      "拖动框选；Ctrl：暂停边缘吸附；框选时按住空格：移动选区\n"
      "方向键：微调；Ctrl / Shift+方向键：向外扩展 / 向内收缩选区\n"
      "Enter / Ctrl+C / 双击：复制；中键 / Ctrl+T：原位贴图\n"
      "Ctrl+S：另存为；Ctrl+Shift+S：快速保存\n"
      "Ctrl+A / F：当前屏幕全选；R：上次选区\n"
      "空格：显隐工具栏；Alt：放大镜；C：复制颜色；Shift：切换颜色格式\n"
      "Esc：取消截图"));
  connect(annotations, &AnnotationEditor::changed, this,
          &CaptureOverlay::refresh);
  connect(annotations, &AnnotationEditor::notice, this,
          &CaptureOverlay::showError);
  connect(annotations, &AnnotationEditor::toolChanged, this, [this] {
    drag.clear();
    placeToolbar();
  });
  connect(annotations, &AnnotationEditor::layoutChanged, this,
          &CaptureOverlay::placeToolbar);
  connect(annotations, &AnnotationEditor::actionRequested, this,
          [this](QString a) {
            if (a == "full")
              selectAll();
            else if (a == "cancel") {
              if (cancel)
                cancel();
            } else if (QStringList{"copy", "save", "quickSave", "pin", "note",
                                   "background", "source"}
                           .contains(a))
              finish(a);
          });
  hint = new QLabel(
      QStringLiteral("拖动框选 · Tab 切换窗口/控件 · Ctrl+A 全屏 · Esc 取消"),
      this);
  hint->setStyleSheet(
      "background:#1d1d1f;color:white;padding:6px 9px;border-radius:5px;");
  hint->setAttribute(Qt::WA_TransparentForMouseEvents);
  hint->adjustSize();
  hint->move(12, 12);
  detector.setSingleShot(true);
  detector.setInterval(90);
  connect(&detector, &QTimer::timeout, this, &CaptureOverlay::detect);
  hover = mapFromGlobal(QCursor::pos());
  QTimer::singleShot(0, this, &CaptureOverlay::detect);
}
void CaptureOverlay::showDesktop() {
  // QWidget::show() applies its cached logical geometry after ShowEvent.
  // Position in native pixels only after that initial native show completes.
  show();
  if (!desktop.monitors.isEmpty()) {
    placementValid = Capture::placePhysicalWindow(winId(), nativeBounds);
    hover = mapFromGlobal(QCursor::pos());
    toolbarMonitor = monitorAt(pixel(hover));
    hint->move(monitorViewport(toolbarMonitor).topLeft() + QPoint(12, 12));
    placeToolbar();
  }
}
void CaptureOverlay::closeEvent(QCloseEvent *e) {
  QWidget::closeEvent(e);
  if (e->isAccepted() && cancel)
    cancel();
}
bool CaptureOverlay::event(QEvent *event) {
  if (event->type() == QEvent::KeyPress) {
    auto key = static_cast<QKeyEvent *>(event);
    if (key->key() == Qt::Key_Tab && key->modifiers() == Qt::NoModifier) {
      keyPressEvent(key);
      return true;
    }
  }
  return QWidget::event(event);
}
QPoint CaptureOverlay::pixel(QPointF p) const {
  const auto point = annotations->imagePoint(p);
  return {std::clamp(qRound(point.x()), 0, document.base.width()),
          std::clamp(qRound(point.y()), 0, document.base.height())};
}
QRect CaptureOverlay::logical(QRect r) const {
  return annotations->displayTransform().mapRect(r);
}
QRect CaptureOverlay::selectionGeometry() const {
  if (!desktop.monitors.isEmpty())
    return desktop.toLogical(selectionPhysicalGeometry());
  const auto area = logical(selection);
  return QRect(mapToGlobal(area.topLeft()), area.size());
}
QRect CaptureOverlay::selectionPhysicalGeometry() const {
  return desktop.monitors.isEmpty()
             ? QRect()
             : selection.translated(nativeBounds.topLeft());
}
QScreen *CaptureOverlay::selectionScreen() const {
  if (!desktop.monitors.isEmpty()) {
    const int index = desktop.monitorAt(selectionPhysicalGeometry().center());
    if (index >= 0)
      for (auto s : QGuiApplication::screens())
        if (Capture::nativeScreenRect(s) == desktop.monitors[index].physical)
          return s;
  }
  return screen();
}
QString CaptureOverlay::desktopSignature() const {
  return desktop.monitors.isEmpty() ? screen()->name() : desktop.signature();
}
int CaptureOverlay::monitorAt(QPoint point) const {
  return desktop.monitorAt(point + nativeBounds.topLeft());
}
QRect CaptureOverlay::monitorViewport(int index) const {
  return index < 0 || index >= desktop.monitors.size()
             ? rect()
             : logical(desktop.monitors[index].physical.translated(
                           -nativeBounds.topLeft()))
                   .intersected(rect());
}
void CaptureOverlay::rebuildSnapTargets() {
  QVector<QRect> screens, windows;
  for (auto m : desktop.monitors)
    screens << m.physical.translated(-nativeBounds.topLeft());
  if (screens.isEmpty())
    screens << document.base.rect();
  for (auto target : targets)
    windows << target.rect.translated(-nativeBounds.topLeft());
  snapping.reset(document.base.rect(), screens, windows);
}
int CaptureOverlay::snapThreshold(QPoint point) const {
  const int index = monitorAt(point);
  const double ratio = index >= 0
                           ? double(desktop.monitors[index].physical.width()) /
                                 desktop.monitors[index].logical.width()
                           : double(document.base.width()) / width();
  return std::max(1, qRound(6 * ratio));
}
QVector<QPoint> CaptureOverlay::handles() const {
  auto r = logical(selection);
  int l = r.x(), t = r.y(), rr = l + r.width(), b = t + r.height(),
      cx = (l + rr) / 2, cy = (t + b) / 2;
  return {{l, t},  {cx, t}, {rr, t}, {rr, cy},
          {rr, b}, {cx, b}, {l, b},  {l, cy}};
}
void CaptureOverlay::paintEvent(QPaintEvent *) {
  QPainter p(this);
  if (desktop.monitors.isEmpty())
    p.drawImage(rect(), rendered);
  else {
    p.fillRect(rect(), Qt::black);
    p.drawImage(QRectF(0, 0, rendered.width() / devicePixelRatioF(),
                       rendered.height() / devicePixelRatioF()),
                rendered);
  }
  auto area = selection.isEmpty() ? detected : selection;
  auto s = logical(area);
  QColor shade(0, 0, 0, 110);
  if (area.isEmpty())
    p.fillRect(rect(), shade);
  else {
    p.fillRect(QRect(0, 0, width(), s.y()), shade);
    p.fillRect(
        QRect(0, s.y() + s.height(), width(), height() - s.y() - s.height()),
        shade);
    p.fillRect(QRect(0, s.y(), s.x(), s.height()), shade);
    p.fillRect(QRect(s.x() + s.width(), s.y(), width() - s.x() - s.width(),
                     s.height()),
               shade);
    p.setPen(QPen(QColor("#0071e3"), 1));
    p.drawRect(s);
    p.setBrush(Qt::white);
    if (!selection.isEmpty() && annotations->tool == "select")
      for (auto pt : handles())
        p.drawRect(QRect(pt - QPoint(3, 3), QSize(6, 6)));
  }
  annotations->paintHandles(p);
  if ((selection.isEmpty() || alt) && rect().contains(hover)) {
    auto pt = pixel(hover);
    pt.setX(std::min(pt.x(), document.base.width() - 1));
    pt.setY(std::min(pt.y(), document.base.height() - 1));
    auto color = document.base.pixelColor(pt);
    QSize size(150, 174);
    const auto viewport = monitorViewport(monitorAt(pt));
    QPoint at = hover + QPoint(22, 22);
    if (at.x() + size.width() > viewport.x() + viewport.width())
      at.setX(hover.x() - size.width() - 22);
    if (at.y() + size.height() > viewport.y() + viewport.height())
      at.setY(hover.y() - size.height() - 22);
    at.setX(std::max(viewport.x(), at.x()));
    at.setY(std::max(viewport.y(), at.y()));
    p.fillRect(QRect(at, size), QColor("#292522"));
    QImage sample(15, 15, QImage::Format_RGB32);
    sample.fill(Qt::black);
    {
      QPainter q(&sample);
      q.drawImage(QPoint(7, 7) - pt, document.base);
    }
    p.drawImage(QRect(at + QPoint(7, 7), QSize(135, 135)), sample);
    p.setPen(QColor("#0071e3"));
    p.drawRect(QRect(at + QPoint(70, 70), QSize(9, 9)));
    p.setPen(Qt::white);
    auto label = hex ? color.name().toUpper()
                     : QString("%1, %2, %3")
                           .arg(color.red())
                           .arg(color.green())
                           .arg(color.blue());
    p.drawText(QRect(at + QPoint(5, 144), QSize(142, 28)), Qt::AlignCenter,
               QString("%1,%2  %3").arg(pt.x()).arg(pt.y()).arg(label));
  }
}
void CaptureOverlay::refresh() {
  rendered = document.render(annotations->typing() ? document.editable : -1);
  update();
}
void CaptureOverlay::placeToolbar() {
  if (!hint)
    return;
  annotations->editBounds =
      selection.isEmpty() ? document.base.rect() : selection;
  if (selection.isEmpty()) {
    annotations->panel->hide();
    return;
  }
  detector.stop();
  ++detectionSerial;
  auto viewport = monitorViewport(toolbarMonitor);
  if (!viewport.intersects(logical(selection))) {
    toolbarMonitor = monitorAt(selection.center());
    viewport = monitorViewport(toolbarMonitor);
  }
  annotations->fitPanel(viewport.width());
  auto bar = annotations->panel;
  bar->move(viewport.topLeft() +
            Capture::toolbarPosition(
                logical(selection).intersected(viewport).translated(
                    -viewport.topLeft()),
                bar->size(), viewport.size()));
  bar->setVisible(!barHidden && drag.isEmpty());
  hint->setText(QStringLiteral("%1 × %2 · %3")
                    .arg(selection.width())
                    .arg(selection.height())
                    .arg(annotations->contextHint()));
  hint->setMaximumWidth(viewport.width());
  hint->setWordWrap(true);
  hint->adjustSize();
  hint->move(
      std::clamp(logical(selection).x(), viewport.x(),
                 std::max(viewport.x(),
                          viewport.x() + viewport.width() - hint->width())),
      std::clamp(logical(selection).y() - hint->height() - 4, viewport.y(),
                 std::max(viewport.y(),
                          viewport.y() + viewport.height() - hint->height())));
  if (hint->geometry().intersects(bar->geometry())) {
    const int below = bar->geometry().bottom() + 5;
    hint->move(hint->x(),
               below + hint->height() <= viewport.y() + viewport.height()
                   ? below
                   : std::max(viewport.y(), bar->y() - hint->height() - 5));
  }
  bar->raise();
}
void CaptureOverlay::selectAll() {
  if (claim && !claim(this))
    return;
  drag.clear();
  annotations->complete();
  toolbarMonitor = monitorAt(pixel(hover));
  selection = toolbarMonitor < 0
                  ? document.base.rect()
                  : desktop.monitors[toolbarMonitor].physical.translated(
                        -nativeBounds.topLeft());
  placeToolbar();
  update();
}
void CaptureOverlay::clearSelection() {
  drag.clear();
  annotations->complete();
  selection = {};
  detected = {};
  annotations->choose("select");
  if (clearClaim)
    clearClaim();
  placeToolbar();
  update();
}
void CaptureOverlay::finish(QString action) {
  if (selection.isEmpty())
    return;
  drag.clear();
  annotations->complete();
  if (output)
    output(action, document.render().copy(selection));
}
void CaptureOverlay::mousePressEvent(QMouseEvent *e) {
  hover = e->position().toPoint();
  if (e->button() == Qt::MiddleButton) {
    finish("pin");
    return;
  }
  if (e->button() == Qt::RightButton) {
    drag.clear();
    if (annotations->press(e))
      return;
    if (!selection.isEmpty())
      clearSelection();
    else if (cancel)
      cancel();
    return;
  }
  if (e->button() != Qt::LeftButton || (claim && !claim(this)))
    return;
  if (!selection.isEmpty() && annotations->press(e))
    return;
  anchor = last = pixel(e->position());
  beforeDrag = selection;
  rawSelection = selection;
  toolbarMonitor = monitorAt(anchor);
  handle = -1;
  if (selection.isEmpty()) {
    drag = "new";
    annotations->panel->hide();
    return;
  }
  if (annotations->tool != "select")
    return;
  auto hs = handles();
  for (int i = 0; i < hs.size(); ++i)
    if ((hs[i] - e->position().toPoint()).manhattanLength() < 12) {
      handle = i;
      break;
    }
  drag = handle >= 0 ? "resize" : selection.contains(anchor) ? "move" : "";
}
void CaptureOverlay::mouseMoveEvent(QMouseEvent *e) {
  ++detectionSerial;
  hover = e->position().toPoint();
  if (annotations->move(e))
    return;
  if (!(e->buttons() & Qt::LeftButton) || drag.isEmpty()) {
    if (selection.isEmpty()) {
      detected = {};
      for (auto t : targets)
        if (t.rect.contains(pixel(hover) + nativeBounds.topLeft())) {
          detected = t.rect.translated(-nativeBounds.topLeft())
                         .intersected(document.base.rect());
          break;
        }
      detector.start();
    }
    update();
    return;
  }
  updateDrag(pixel(e->position()),
             e->modifiers().testFlag(Qt::ControlModifier));
  placeToolbar();
  update();
}
void CaptureOverlay::updateDrag(QPoint pt, bool bypass) {
  auto bound = document.base.size();
  const int threshold = snapThreshold(pt);
  if (space && !rawSelection.isEmpty()) {
    auto old = rawSelection.topLeft();
    rawSelection.moveTo(std::clamp(rawSelection.x() + pt.x() - last.x(), 0,
                                   bound.width() - rawSelection.width()),
                        std::clamp(rawSelection.y() + pt.y() - last.y(), 0,
                                   bound.height() - rawSelection.height()));
    auto delta = rawSelection.topLeft() - old;
    anchor += delta;
    beforeDrag.translate(delta);
    selection =
        bypass ? rawSelection
               : snapping.move(rawSelection, threshold, document.base.rect());
  } else if (drag == "new") {
    rawSelection = Capture::boundedSelection(anchor, pt, bound);
    selection = bypass ? rawSelection
                       : Capture::boundedSelection(
                             snapping.point(anchor, snapThreshold(anchor)),
                             snapping.point(pt, threshold), bound);
  } else if (drag == "move") {
    rawSelection = beforeDrag;
    rawSelection.moveTo(std::clamp(beforeDrag.x() + pt.x() - anchor.x(), 0,
                                   bound.width() - selection.width()),
                        std::clamp(beforeDrag.y() + pt.y() - anchor.y(), 0,
                                   bound.height() - selection.height()));
    selection =
        bypass ? rawSelection
               : snapping.move(rawSelection, threshold, document.base.rect());
  } else if (drag == "resize") {
    auto raw = pt;
    auto resized = [&](QPoint point) {
      auto a = beforeDrag.topLeft(),
           b = a + QPoint(beforeDrag.width(), beforeDrag.height());
      if (handle == 0 || handle == 6 || handle == 7)
        a.setX(point.x());
      if (handle <= 2)
        a.setY(point.y());
      if (handle >= 2 && handle <= 4)
        b.setX(point.x());
      if (handle >= 4 && handle <= 6)
        b.setY(point.y());
      return Capture::boundedSelection(a, b, bound);
    };
    rawSelection = resized(raw);
    if (!bypass)
      pt = snapping.point(pt, threshold, handle != 1 && handle != 5,
                          handle != 3 && handle != 7);
    auto next = resized(pt);
    if (!next.isEmpty())
      selection = next;
    pt = raw;
  }
  last = pt;
}
void CaptureOverlay::mouseReleaseEvent(QMouseEvent *e) {
  if (annotations->release(e))
    return;
  if (e->button() != Qt::LeftButton)
    return;
  if (!drag.isEmpty() &&
      (pixel(e->position()) != last || !rawSelection.isEmpty()))
    updateDrag(pixel(e->position()),
               e->modifiers().testFlag(Qt::ControlModifier));
  if (drag == "new" && selection.isEmpty())
    selection =
        detected.isEmpty()
            ? QRect(QPoint(std::min(anchor.x(), document.base.width() - 1),
                           std::min(anchor.y(), document.base.height() - 1)),
                    QSize(1, 1))
            : detected;
  drag.clear();
  toolbarMonitor = monitorAt(pixel(e->position()));
  placeToolbar();
  update();
}
void CaptureOverlay::mouseDoubleClickEvent(QMouseEvent *e) {
  if (annotations->doubleClick(e))
    return;
  if (e->button() == Qt::LeftButton &&
      selection.contains(pixel(e->position()))) {
    drag.clear();
    finish("copy");
  }
}
void CaptureOverlay::showError(const QString &message) {
  const auto viewport = monitorViewport(toolbarMonitor);
  hint->setText(message);
  hint->setMaximumWidth(viewport.width());
  hint->setWordWrap(true);
  hint->adjustSize();
  hint->move(viewport.topLeft());
  hint->raise();
}
void CaptureOverlay::detectionHint(const QString &status) {
  const auto viewport = monitorViewport(monitorAt(pixel(hover)));
  hint->setMaximumWidth(std::max(1, viewport.width() - 24));
  hint->setWordWrap(true);
  hint->setText(
      detectionMode == 0
          ? QStringLiteral("窗口识别 · Tab 切换控件 · Ctrl 暂停吸附")
          : QStringLiteral("%1 · Tab 切换窗口 · 拖动可手动框选")
                .arg(status.isEmpty() ? QStringLiteral("控件识别") : status));
  hint->adjustSize();
  hint->move(viewport.topLeft() + QPoint(12, 12));
}
void CaptureOverlay::detect() {
  if (!selection.isEmpty() || !drag.isEmpty())
    return;
  const auto serial = ++detectionSerial;
  detectionHint();
  detected = {};
  auto pt = pixel(hover) + nativeBounds.topLeft();
  for (auto t : targets)
    if (t.rect.contains(pt)) {
      detected = t.rect.translated(-nativeBounds.topLeft())
                     .intersected(document.base.rect());
      if (detectionMode == 0)
        break;
      const bool started =
          controlLookup(this, t.window, pt, [this, pt, t, serial](QRect r) {
            if (selection.isEmpty() && drag.isEmpty() && detectionMode == 1 &&
                serial == detectionSerial &&
                pixel(hover) + nativeBounds.topLeft() == pt) {
              const auto target = r.intersected(t.rect);
              if (target.contains(pt))
                detected = target.translated(-nativeBounds.topLeft())
                               .intersected(document.base.rect());
              detectionHint(
                  target.contains(pt) && target != t.rect
                      ? QStringLiteral("已识别控件")
                      : QStringLiteral("未识别到子控件，保留窗口选区"));
              update();
            }
          });
      if (!started) {
        // The active query may finish for a stale cursor position. Retry the
        // latest point even if there are no further mouse-move events.
        detector.start();
        detectionHint(QStringLiteral("控件识别中"));
      }
      break;
    }
  update();
}
void CaptureOverlay::keyPressEvent(QKeyEvent *e) {
  if (annotations->key(e))
    return;
  bool ctrl = e->modifiers().testFlag(Qt::ControlModifier),
       shift = e->modifiers().testFlag(Qt::ShiftModifier);
  const auto key = e->key();
  if (key == Qt::Key_Escape) {
    drag.clear();
    if (cancel)
      cancel();
    return;
  }
  if (key == Qt::Key_Control && !drag.isEmpty()) {
    updateDrag(last, true);
    placeToolbar();
    update();
    return;
  }
  if (key == Qt::Key_Return || key == Qt::Key_Enter) {
    finish(ctrl && origin != "global" ? "source" : "copy");
    return;
  }
  if (ctrl) {
    if (key == Qt::Key_C) {
      finish("copy");
      return;
    }
    if (key == Qt::Key_S) {
      finish(shift ? "quickSave" : "save");
      return;
    }
    if (key == Qt::Key_T) {
      finish("pin");
      return;
    }
    if (origin == "global" && key == Qt::Key_N) {
      finish("note");
      return;
    }
    if (origin == "global" && key == Qt::Key_B) {
      finish("background");
      return;
    }
  }
  if ((ctrl && key == Qt::Key_A) || key == Qt::Key_F) {
    selectAll();
    return;
  }
  if (key == Qt::Key_Space && !e->isAutoRepeat()) {
    space = true;
    if (drag.isEmpty()) {
      barHidden = !barHidden;
      placeToolbar();
    }
    return;
  }
  if (key == Qt::Key_Alt) {
    alt = true;
    update();
    return;
  }
  if (key == Qt::Key_Shift && (selection.isEmpty() || alt)) {
    hex = !hex;
    update();
    return;
  }
  if (key == Qt::Key_Tab) {
    if (!selection.isEmpty())
      return;
    detectionMode = 1 - detectionMode;
    detector.stop();
    detect();
    update();
    return;
  }
  if (key == Qt::Key_C && !ctrl && (selection.isEmpty() || alt)) {
    auto pt = pixel(hover);
    pt.setX(std::min(pt.x(), document.base.width() - 1));
    pt.setY(std::min(pt.y(), document.base.height() - 1));
    auto c = document.base.pixelColor(pt);
    QGuiApplication::clipboard()->setText(
        hex ? c.name().toUpper()
            : QString("%1, %2, %3").arg(c.red()).arg(c.green()).arg(c.blue()));
    return;
  }
  if (key == Qt::Key_R && !recalledSelection.isEmpty()) {
    if (claim && !claim(this))
      return;
    annotations->complete();
    selection = recalledSelection.intersected(document.base.rect());
    placeToolbar();
    update();
    return;
  }
  QPoint d;
  if (key == Qt::Key_Left || key == Qt::Key_A)
    d = {-1, 0};
  if (key == Qt::Key_Right || key == Qt::Key_D)
    d = {1, 0};
  if (key == Qt::Key_Up || key == Qt::Key_W)
    d = {0, -1};
  if (key == Qt::Key_Down || key == Qt::Key_S)
    d = {0, 1};
  if (d.isNull())
    return;
  if (key == Qt::Key_A || key == Qt::Key_D || key == Qt::Key_W ||
      key == Qt::Key_S) {
    Capture::movePhysicalCursor(d);
    return;
  }
  if (selection.isEmpty())
    return;
  if (annotations->hasCurrent())
    return;
  if (ctrl || shift) {
    int n = shift ? -1 : 1, l = selection.x(), t = selection.y(),
        r = l + selection.width(), b = t + selection.height();
    if (d.x() < 0)
      l = std::clamp(l - n, 0, r - 1);
    if (d.x() > 0)
      r = std::clamp(r + n, l + 1, document.base.width());
    if (d.y() < 0)
      t = std::clamp(t - n, 0, b - 1);
    if (d.y() > 0)
      b = std::clamp(b + n, t + 1, document.base.height());
    selection = QRect(l, t, r - l, b - t);
  } else
    selection.moveTo(std::clamp(selection.x() + d.x(), 0,
                                document.base.width() - selection.width()),
                     std::clamp(selection.y() + d.y(), 0,
                                document.base.height() - selection.height()));
  placeToolbar();
  update();
}
void CaptureOverlay::keyReleaseEvent(QKeyEvent *e) {
  if (e->key() == Qt::Key_Control && !drag.isEmpty()) {
    updateDrag(last, false);
    placeToolbar();
    update();
  }
  if (e->key() == Qt::Key_Space && !e->isAutoRepeat())
    space = false;
  if (e->key() == Qt::Key_Alt) {
    alt = false;
    update();
  }
}
void CaptureOverlay::wheelEvent(QWheelEvent *e) {
  if (!annotations->wheel(e))
    QWidget::wheelEvent(e);
}
