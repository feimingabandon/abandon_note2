#include "CaptureEngine.h"
#include "DesktopCapture.h"
#include "SaveActions.h"
#include <QApplication>
#include <QDir>
#include <QFileDialog>
#include <QInputMethodEvent>
#include <QJsonDocument>
#include <QLocalSocket>
#include <QPushButton>
#include <QScopeGuard>
#include <QSettings>
#include <QTemporaryDir>
#include <QTimer>
#include <QToolButton>
#include <QUuid>
#include <QtTest>
#include <windows.h>

class UiTest : public QObject {
  Q_OBJECT
private slots:
  void completionReturnsToRequestingForm() {
    QImage base(240, 180, QImage::Format_RGB32);
    base.fill(Qt::white);
    for (const QString origin : {"global", "note", "background"}) {
      CaptureOverlay overlay(QGuiApplication::primaryScreen(), base, origin);
      overlay.selection = base.rect();
      const auto expected = origin == "global" ? QString("copy") : QString("source");
      QString action;
      overlay.output = [&](QString value, QImage) { action = value; };
      auto primary = overlay.annotations->outputs->findChild<QToolButton *>("capturePrimary");
      QVERIFY(primary);
      QCOMPARE(primary->defaultAction()->data().toString(), expected);
      primary->defaultAction()->trigger();
      QCOMPARE(action, expected);
      action.clear();
      QTest::keyClick(&overlay, Qt::Key_Return);
      QCOMPARE(action, expected);
      action.clear();
      QTest::mouseDClick(&overlay, Qt::LeftButton, Qt::NoModifier, QPoint(30, 30));
      QCOMPARE(action, expected);
      action.clear();
      QTest::keyClick(&overlay, Qt::Key_C, Qt::ControlModifier);
      QCOMPARE(action, QString("copy"));
    }
  }
  void completionFeedbackOutlivesOverlay() {
    QTemporaryDir temp;
    CaptureEngine engine("feedback-" + QUuid::createUuid().toString(), "token",
                         temp.filePath("run"));
    {
      QSettings prefs(engine.settingsPath, QSettings::IniFormat);
      prefs.setValue("quickSaveDirectory", temp.path());
    }
    QImage base(80, 60, QImage::Format_RGB32);
    base.fill(Qt::red);
    for (QString action : {"copy", "quickSave"}) {
      auto overlay =
          new CaptureOverlay(QGuiApplication::primaryScreen(), base, "global");
      QPointer<CaptureOverlay> guard(overlay);
      overlay->selection = base.rect();
      engine.session = QUuid::createUuid().toString(QUuid::WithoutBraces);
      engine.selected = overlay;
      engine.overlays << overlay;
      engine.output(overlay, action, base);
      QVERIFY(engine.session.isEmpty());
      QTRY_VERIFY(guard.isNull());
      QVERIFY(engine.feedback.isVisible());
      const auto text = engine.feedback.findChild<QLabel *>()->text();
      if (action == "copy") {
        QCOMPARE(text, QStringLiteral("已复制到剪贴板"));
        QString error;
        QCOMPARE(Capture::readClipboardImage(&error),
                 base.convertToFormat(QImage::Format_ARGB32));
      } else {
        QVERIFY(text.startsWith(QStringLiteral("已保存\n")));
        const auto files = QDir(temp.path()).entryList({"*.png"}, QDir::Files);
        QCOMPARE(files.size(), 1);
        QVERIFY(text.contains(
            QDir::toNativeSeparators(temp.filePath(files.first()))));
        QCOMPARE(QImage(temp.filePath(files.first())), base);
      }
    }
    if (Capture::interactiveDesktopAvailable()) {
      engine.capture(
          {{"sessionId", QUuid::createUuid().toString(QUuid::WithoutBraces)},
           {"origin", "global"}});
      QVERIFY(!engine.feedback.isVisible());
      engine.finish("cancelled");
    }
  }
  void nativeControlDetection() {
    QWidget fixture(nullptr,
                    Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint);
    fixture.setGeometry(200, 200, 500, 300);
    QPushButton control("synthetic button", &fixture);
    control.setGeometry(80, 70, 200, 60);
    fixture.show();
    QTest::qWait(60);
    auto hwnd = reinterpret_cast<HWND>(fixture.winId());
    RECT native{};
    QVERIFY(GetWindowRect(hwnd, &native));
    POINT point{native.left + 100, native.top + 90};
    QRect result;
    Capture::accessibleTarget(&fixture, fixture.winId(),
                              QPoint(point.x, point.y),
                              [&](QRect rect) { result = rect; });
    QTRY_VERIFY_WITH_TIMEOUT(!result.isEmpty(), 4000);
    QVERIFY(result.contains(QPoint(point.x, point.y)));
    QVERIFY(result.width() < native.right - native.left);
    QVERIFY(result.height() < native.bottom - native.top);
    auto targets = Capture::desktopTargets(fixture.screen());
    QVERIFY(std::any_of(targets.begin(), targets.end(),
                        [&](auto t) { return t.window == fixture.winId(); }));
  }
  void newTools_data() {
    QTest::addColumn<QString>("tool");
    for (auto tool : {"line", "polyline", "marker", "blur", "eraser"})
      QTest::newRow(tool) << QString(tool);
  }
  void newTools() {
    QFETCH(QString, tool);
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    {
      QPainter p(&base);
      for (int x = 0; x < 800; x += 11)
        p.fillRect(x, 0, 4, 600, Qt::black);
    }
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "global");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    o.selectAll();
    o.document.append({"pen", {{100, 160}, {300, 260}}, Qt::red, 24});
    o.document.editable = -1;
    auto original = o.document.render();
    o.annotations->choose(tool);
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {110, 170});
    QTest::mouseMove(&o, {300, 260});
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {300, 260});
    if (tool == "polyline") {
      QTest::mouseClick(&o, Qt::LeftButton, Qt::NoModifier, {300, 260});
      QTest::mouseMove(&o, {180, 340});
      QTest::mouseClick(&o, Qt::LeftButton, Qt::NoModifier, {180, 340});
    }
    QVERIFY(o.annotations->hasCurrent());
    QVERIFY(o.document.render() != original);
    QTest::mouseClick(&o, Qt::RightButton, Qt::NoModifier, {500, 400});
    auto marked = o.document.render();
    QTest::keyClick(&o, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(o.document.render(), original);
    QTest::keyClick(&o, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(o.document.render(), marked);
    o.findChild<QSpinBox *>("annotationSize")->setValue(30);
    QVERIFY(o.document.render() != marked);
    QCOMPARE(o.document.base, base);
  }
  void completionGestures_data() {
    QTest::addColumn<QString>("gesture");
    QTest::addColumn<QString>("expected");
    QTest::newRow("enter") << "enter" << "source";
    QTest::newRow("double") << "double" << "source";
    QTest::newRow("middle") << "middle" << "pin";
    QTest::newRow("source") << "source" << "source";
  }
  void completionGestures() {
    QFETCH(QString, gesture);
    QFETCH(QString, expected);
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "note");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    o.selection = {100, 100, 400, 300};
    o.annotations->choose("arrow");
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {120, 130});
    QTest::mouseMove(&o, {230, 220});
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {230, 220});
    auto expectedImage = o.document.render().copy(o.selection);
    QString action;
    QImage exported;
    o.output = [&](QString a, QImage image) {
      action = a;
      exported = image;
    };
    if (gesture == "double")
      QTest::mouseDClick(&o, Qt::LeftButton, Qt::NoModifier, {400, 300});
    if (gesture == "middle")
      QTest::mouseClick(&o, Qt::MiddleButton, Qt::NoModifier, {400, 300});
    if (gesture == "enter" || gesture == "source")
      QTest::keyClick(&o, Qt::Key_Return,
                      gesture == "source" ? Qt::ControlModifier
                                          : Qt::NoModifier);
    QCOMPARE(action, expected);
    QCOMPARE(exported, expectedImage);
    QCOMPARE(o.selection, QRect(100, 100, 400, 300));
  }
  void selectionPrecisionAndSpace() {
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "global");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {100, 100});
    QTest::mouseMove(&o, {300, 250});
    QTest::keyPress(&o, Qt::Key_Space);
    QTest::mouseMove(&o, {320, 270});
    QTest::keyRelease(&o, Qt::Key_Space);
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {320, 270});
    QCOMPARE(o.selection, QRect(120, 120, 200, 150));
    QTest::keyClick(&o, Qt::Key_Left, Qt::ControlModifier);
    QCOMPARE(o.selection, QRect(119, 120, 201, 150));
    QTest::keyClick(&o, Qt::Key_Left, Qt::ShiftModifier);
    QCOMPARE(o.selection, QRect(120, 120, 200, 150));
    QTest::keyClick(&o, Qt::Key_Up, Qt::ControlModifier);
    QCOMPARE(o.selection, QRect(120, 119, 200, 151));
    QTest::keyClick(&o, Qt::Key_Down, Qt::ShiftModifier);
    QCOMPARE(o.selection, QRect(120, 119, 200, 150));
    o.resize(640, 480);
    QTest::keyClick(&o, Qt::Key_Right);
    QCOMPARE(o.selection.x(), 121);
    o.recalledSelection = {11, 22, 120, 80};
    QTest::keyClick(&o, Qt::Key_R);
    QCOMPARE(o.selection, o.recalledSelection);
  }
  void currentObjectParametersAndHistory() {
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "global");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    o.selectAll();
    o.annotations->choose("rectangle");
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {120, 160});
    QMouseEvent move(QEvent::MouseMove, QPointF(260, 230),
                     o.mapToGlobal(QPoint(260, 230)), Qt::NoButton,
                     Qt::LeftButton, Qt::ShiftModifier);
    QApplication::sendEvent(&o, &move);
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {260, 230});
    QCOMPARE(o.document.strokes.last().points.last(), QPointF(260, 300));
    QVERIFY(o.annotations->hasCurrent());
    auto small = o.document.render();
    auto size = o.findChild<QSpinBox *>("annotationSize");
    size->setValue(14);
    QVERIFY(o.document.render() != small);
    auto color = o.findChild<QComboBox *>("annotationColor");
    color->setCurrentIndex(1);
    QCOMPARE(o.document.render().pixelColor(120, 210), QColor("#e13c39"));
    auto colored = o.document.render();
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {180, 200});
    QTest::mouseMove(&o, {200, 220});
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {200, 220});
    QVERIFY(o.document.render() != colored);
    QTest::mouseClick(&o, Qt::RightButton, Qt::NoModifier, {450, 400});
    auto complete = o.document.render();
    QVERIFY(!o.annotations->hasCurrent());
    QVERIFY(complete != base);
    QTest::keyClick(&o, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(o.document.render(), base);
    QTest::keyClick(&o, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(o.document.render(), complete);
    QVERIFY(o.annotations->hasCurrent());
    size->setValue(2);
    QVERIFY(o.document.render() != complete);
    QTest::keyClick(&o, Qt::Key_Z, Qt::ControlModifier | Qt::ShiftModifier);
    QCOMPARE(o.document.render(), base);
    QVERIFY(o.document.redoStack.isEmpty());
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {400, 200});
    QTest::mouseMove(&o, {500, 300});
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {500, 300});
    QVERIFY(o.document.render() != base);
  }
  void textDraftParametersAndReopen() {
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "global");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    o.selectAll();
    o.annotations->choose("text");
    QTest::mouseClick(&o, Qt::LeftButton, Qt::NoModifier, {160, 180});
    auto text = o.annotations->textWidget();
    QVERIFY(text);
    QInputMethodEvent commit;
    commit.setCommitString(QStringLiteral("中文第一行\n第二行"));
    QApplication::sendEvent(text, &commit);
    o.findChild<QSpinBox *>("annotationSize")->setValue(32);
    QVERIFY(o.annotations->typing());
    QCOMPARE(text->toPlainText(), QStringLiteral("中文第一行\n第二行"));
    QTest::keyClick(text, Qt::Key_Return, Qt::ControlModifier);
    QVERIFY(!o.annotations->typing());
    QVERIFY(o.annotations->hasCurrent());
    auto before = o.document.render();
    o.findChild<QSpinBox *>("annotationRotation")->setValue(25);
    QVERIFY(o.document.render() != before);
    QTest::mouseDClick(&o, Qt::LeftButton, Qt::NoModifier, {190, 210});
    QVERIFY(o.annotations->typing());
    QTest::mouseClick(&o, Qt::RightButton, Qt::NoModifier, {600, 400});
    QVERIFY(!o.annotations->typing());
    QVERIFY(!o.annotations->hasCurrent());
    QCOMPARE(o.document.strokes.last().text,
             QStringLiteral("中文第一行\n第二行"));
    QVERIFY(o.document.render() != base);
    QTest::keyClick(&o, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(o.document.render(), base);
  }
  void pinTransformsEditingAndDisplay() {
    QImage base(300, 220, QImage::Format_RGB32);
    base.fill(Qt::white);
    {
      QPainter p(&base);
      p.fillRect(0, 0, 60, 40, Qt::red);
    }
    PinWindow p(base);
    p.setAttribute(Qt::WA_DeleteOnClose, false);
    p.show();
    auto originalSize = p.size();
    QTest::keyClick(&p, Qt::Key_Plus);
    QVERIFY(p.width() > originalSize.width());
    QTest::keyClick(&p, Qt::Key_Minus, Qt::ControlModifier);
    QVERIFY(p.windowOpacity() < 1);
    QCOMPARE(p.exportImage(), base);
    QTest::mouseClick(&p, Qt::MiddleButton);
    QCOMPARE(p.size(), originalSize);
    QCOMPARE(p.windowOpacity(), 1.0);
    QTest::keyClick(&p, Qt::Key_2);
    QTransform rotation;
    rotation.rotate(-90);
    QCOMPARE(p.exportImage(), base.transformed(rotation));
    QTest::keyClick(&p, Qt::Key_3);
    auto expected = base.transformed(rotation)
                        .mirrored(true, false)
                        .convertToFormat(QImage::Format_ARGB32);
    QCOMPARE(p.exportImage().convertToFormat(QImage::Format_ARGB32), expected);
    QTest::keyClick(&p, Qt::Key_Space);
    QVERIFY(p.isEditing());
    p.annotations->choose("line");
    auto a = p.annotations->displayTransform().map(QPointF(100, 80)).toPoint(),
         b = p.annotations->displayTransform().map(QPointF(200, 160)).toPoint();
    QTest::mousePress(&p, Qt::LeftButton, Qt::NoModifier, a);
    QTest::mouseMove(&p, b);
    QTest::mouseRelease(&p, Qt::LeftButton, Qt::NoModifier, b);
    QVERIFY(p.exportImage().convertToFormat(QImage::Format_ARGB32) != expected);
    auto marked = p.exportImage();
    QTest::keyClick(&p, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(p.exportImage().convertToFormat(QImage::Format_ARGB32), expected);
    QTest::keyClick(&p, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(p.exportImage(), marked);
    p.setEditing(false);
    auto size = p.size();
    QTest::mouseDClick(&p, Qt::LeftButton, Qt::ShiftModifier);
    QVERIFY(p.size() != size);
    QTest::mouseDClick(&p, Qt::LeftButton, Qt::ShiftModifier);
    QCOMPARE(p.size(), size);
    QCOMPARE(p.exportImage(), marked);
    p.close();
  }
  void pinDocumentHandoffAndRecovery() {
    QTemporaryDir root;
    CaptureEngine engine("ux-" + QUuid::createUuid().toString(), "token",
                         root.path());
    engine.authenticated = true;
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    auto o =
        new CaptureOverlay(QGuiApplication::primaryScreen(), base, "global");
    o->selection = {100, 100, 300, 200};
    o->document.append({"arrow", {{120, 120}, {260, 240}}, Qt::red, 5});
    auto expected = o->document.render().copy(o->selection);
    const auto expectedGeometry = o->selectionGeometry();
    engine.session = "synthetic";
    engine.selected = o;
    engine.overlays << o;
    engine.output(o, "pin", expected);
    QCOMPARE(engine.pins.size(), 1);
    auto pin = engine.pins.first();
    QCOMPARE(pin->geometry(), expectedGeometry);
    QCOMPARE(pin->exportImage(), expected);
    QVERIFY(!pin->document.strokes.isEmpty());
    pin->setEditing(true);
    QTest::keyClick(pin, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(pin->exportImage(), base.copy(100, 100, 300, 200));
    QTest::keyClick(pin, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(pin->exportImage(), expected);
    pin->setEditing(false);
    QTest::keyClick(pin, Qt::Key_Plus);
    pin->setWindowOpacity(0.5);
    auto state = pin->viewState();
    engine.receive({{"type", "togglePins"}});
    QVERIFY(!pin->isVisible());
    engine.receive({{"type", "togglePins"}});
    QVERIFY(pin->isVisible());
    pin->close();
    QTRY_VERIFY(engine.pins.isEmpty());
    QVERIFY(engine.closedPin.has_value());
    engine.receive({{"type", "restorePin"}});
    QCOMPARE(engine.pins.size(), 1);
    pin = engine.pins.first();
    QCOMPARE(pin->exportImage(), expected);
    QCOMPARE(pin->geometry(), state.geometry);
    QCOMPARE(pin->windowOpacity(), state.opacity);
    QVERIFY(!engine.closedPin);
    QTest::keyClick(pin, Qt::Key_Escape, Qt::ShiftModifier);
    QTRY_VERIFY(engine.pins.isEmpty());
    QVERIFY(!engine.closedPin);
    QString error;
    for (int i = 0; i < 10; ++i)
      QVERIFY(engine.pin(base.copy(0, 0, 8, 8), &error));
    engine.pins.first()->close();
    QTRY_COMPARE(engine.pins.size(), 9);
    QVERIFY(!engine.pin(base.copy(0, 0, 8, 8), &error));
    engine.receive({{"type", "restorePin"}});
    QCOMPARE(engine.pins.size(), 10);
  }
  void quickSaveAndCancellation() {
    QTemporaryDir root;
    QWidget owner;
    owner.show();
    QImage base(30, 40, QImage::Format_RGB32);
    base.fill(Qt::red);
    QString error;
    auto prefs = root.filePath("capture.ini");
    QTimer::singleShot(30, [] {
      for (auto w : QApplication::topLevelWidgets())
        if (auto d = qobject_cast<QFileDialog *>(w))
          d->reject();
    });
    QVERIFY(!Capture::saveWithDialog(&owner, base, true, prefs, &error));
    QVERIFY(error.isEmpty());
    QVERIFY(QDir(root.path()).entryList({"*.png"}, QDir::Files).isEmpty());
    {
      QSettings settings(prefs, QSettings::IniFormat);
      settings.setValue("quickSaveDirectory", root.path());
    }
    QVERIFY(Capture::saveWithDialog(&owner, base, true, prefs, &error));
    auto files = QDir(root.path()).entryList({"*.png"}, QDir::Files);
    QCOMPARE(files.size(), 1);
    QCOMPARE(QImage(root.filePath(files.first())), base);
    {
      QSettings settings(prefs, QSettings::IniFormat);
      settings.setValue("quickSaveDirectory", root.filePath("missing"));
    }
    QVERIFY(!Capture::saveWithDialog(&owner, base, true, prefs, &error));
    QVERIFY(!error.isEmpty());
    QCOMPARE(base.pixelColor(0, 0), QColor(Qt::red));
  }
  void interruptedAnnotation_data() {
    QTest::addColumn<QString>("tool");
    QTest::addColumn<QString>("action");
    for (auto tool : QStringList{QStringLiteral("矩形"), QStringLiteral("椭圆"),
                                 QStringLiteral("箭头"), QStringLiteral("画笔"),
                                 QStringLiteral("马赛克")})
      for (auto action :
           QStringList{"escape", "right-click", "undo", "full-screen"})
        QTest::newRow(qPrintable(tool + "/" + action)) << tool << action;
  }
  void interruptedAnnotation() {
    QFETCH(QString, tool);
    QFETCH(QString, action);
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "global");
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    overlay.resize(800, 600);
    overlay.show();
    overlay.selectAll();
    int cancellations = 0;
    overlay.cancel = [&] { ++cancellations; };
    auto toolbar = overlay.findChild<QToolBar *>();
    auto actions = toolbar->actions();
    auto chosen = std::find_if(actions.begin(), actions.end(),
                               [&](auto a) { return a->text() == tool; });
    QVERIFY(chosen != actions.end());
    (*chosen)->trigger();
    QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, {120, 160});
    QTest::mouseMove(&overlay, {200, 200});
    if (action == "escape")
      QTest::keyClick(&overlay, Qt::Key_Escape);
    else if (action == "right-click") {
      QTest::mousePress(&overlay, Qt::RightButton, Qt::NoModifier, {200, 200});
      QTest::mouseRelease(&overlay, Qt::RightButton, Qt::NoModifier,
                          {200, 200});
    } else if (action == "undo")
      QTest::keyClick(&overlay, Qt::Key_Z, Qt::ControlModifier);
    else
      QTest::keyClick(&overlay, Qt::Key_F);
    // Still holding left: cancellation/commit must not resume the old stroke.
    const auto completed = overlay.document.render();
    QTest::mouseMove(&overlay, {320, 260});
    QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier, {320, 260});
    QCOMPARE(cancellations, 0);
    QCOMPARE(overlay.document.render(), completed);
    const auto expected =
        action == "full-screen" || action == "right-click" ? 1 : 0;
    QCOMPARE(overlay.document.strokes.size(), expected);
    // The tool remains usable for a new gesture.
    QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, {150, 180});
    QTest::mouseMove(&overlay, {250, 280});
    QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier, {250, 280});
    QCOMPARE(overlay.document.strokes.size(), expected + 1);
    QCOMPARE(overlay.document.strokes.last().tool,
             tool == QStringLiteral("矩形")   ? QString("rectangle")
             : tool == QStringLiteral("椭圆") ? QString("ellipse")
             : tool == QStringLiteral("箭头") ? QString("arrow")
             : tool == QStringLiteral("画笔") ? QString("pen")
                                              : QString("mosaic"));
  }
  void systemCloseCleansUpAllOverlays() {
    QTemporaryDir root;
    CaptureEngine engine("close-" + QUuid::createUuid().toString(), "token",
                         root.path());
    auto cleanup = qScopeGuard([&] {
      engine.finish("cancelled");
      for (auto pin : engine.pins)
        if (pin)
          pin->close();
      QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
    });
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    engine.session = QUuid::createUuid().toString(QUuid::WithoutBraces);
    engine.delivery = "pending-output";
    engine.busy = true;
    QVector<QPointer<CaptureOverlay>> windows;
    for (int i = 0; i < 2; ++i) {
      auto overlay =
          new CaptureOverlay(QGuiApplication::primaryScreen(), image, "global");
      overlay->cancel = [&] { engine.finish("cancelled"); };
      overlay->resize(800, 600);
      overlay->show();
      engine.overlays.push_back(overlay);
      windows.push_back(overlay);
    }
    engine.selected = windows.first();
    QString error;
    QVERIFY(engine.pin(image.copy(0, 0, 20, 30), &error));
    QPointer<PinWindow> pin = engine.pins.first();
    SendMessageW(reinterpret_cast<HWND>(windows.first()->winId()),
                 WM_SYSCOMMAND, SC_CLOSE, 0);
    QTRY_VERIFY(engine.session.isEmpty());
    QVERIFY(engine.delivery.isEmpty());
    QVERIFY(!engine.busy);
    QVERIFY(engine.selected.isNull());
    QVERIFY(engine.overlays.isEmpty());
    for (auto window : windows)
      QTRY_VERIFY(window.isNull());
    QVERIFY(pin && pin->isVisible());
    QCOMPARE(engine.pins.size(), 1);
    pin->close();
    QTRY_VERIFY(pin.isNull());
  }
  void selectionAndExport() {
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "note");
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    overlay.resize(800, 600);
    overlay.show();
    overlay.claim = [](auto *) { return true; };
    QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, {500, 400});
    QTest::mouseMove(&overlay, {100, 100});
    QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier, {100, 100});
    QCOMPARE(overlay.selection, QRect(100, 100, 400, 300));
    QTest::keyClick(&overlay, Qt::Key_Right);
    QCOMPARE(overlay.selection.x(), 101);
    QTest::keyClick(&overlay, Qt::Key_Down, Qt::ShiftModifier);
    QCOMPARE(overlay.selection.height(), 299);
    Capture::Stroke arrow{"arrow", {{150, 150}, {250, 250}}, Qt::red, 4};
    overlay.document.append(arrow);
    QImage output;
    QString action;
    overlay.output = [&](QString a, QImage i) {
      action = a;
      output = i;
    };
    QTest::keyClick(&overlay, Qt::Key_C, Qt::ControlModifier);
    QCOMPARE(action, QString("copy"));
    QCOMPARE(output.size(), overlay.selection.size());
    QCOMPARE(output, overlay.document.render().copy(overlay.selection));
    QTest::mouseDClick(&overlay, Qt::LeftButton, Qt::NoModifier, {400, 300});
    QCOMPARE(action, QString("copy"));
    QCOMPARE(overlay.selection, QRect(101, 100, 400, 299));
    QTest::keyClick(&overlay, Qt::Key_A, Qt::ControlModifier);
    QCOMPARE(overlay.selection, image.rect());
    auto toolbar = overlay.annotations->outputs;
    QVERIFY(overlay.rect().contains(overlay.annotations->panel->geometry()));
    QVERIFY(overlay.grab().save(QCoreApplication::applicationDirPath() +
                                "/../capture-toolbar-preview.png"));
    overlay.resize(240, 600);
    overlay.selectAll();
    QTest::qWait(20);
    QVERIFY(overlay.rect().contains(overlay.annotations->panel->geometry()));
    for (auto id : {"pin", "save", "cancel", "copy"})
      QVERIFY(toolbar->widgetForAction(overlay.annotations->action(id))
                  ->isVisible());
    overlay.close();
  }
  void resizeHandles() {
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "note");
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    overlay.resize(800, 600);
    overlay.show();
    const QVector<QPoint> points = {{100, 100}, {200, 100}, {300, 100},
                                    {300, 150}, {300, 200}, {200, 200},
                                    {100, 200}, {100, 150}};
    const QVector<QRect> expected = {
        {110, 110, 190, 90},  {100, 110, 200, 90},  {100, 110, 210, 90},
        {100, 100, 210, 100}, {100, 100, 210, 110}, {100, 100, 200, 110},
        {110, 100, 190, 110}, {110, 100, 190, 100}};
    for (int i = 0; i < points.size(); ++i) {
      overlay.selection = {100, 100, 200, 100};
      QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, points[i]);
      QTest::mouseMove(&overlay, points[i] + QPoint(10, 10));
      QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier,
                          points[i] + QPoint(10, 10));
      QCOMPARE(overlay.selection, expected[i]);
    }
    overlay.close();
  }
  void pinLimitsAndOriginalPixels() {
    QTemporaryDir root;
    CaptureEngine engine("limit-" + QUuid::createUuid().toString(), "token",
                         root.path());
    QString error;
    QImage small(20, 30, QImage::Format_ARGB32);
    small.fill(Qt::red);
    for (int i = 0; i < 10; ++i)
      QVERIFY(engine.pin(small, &error));
    QVERIFY(!engine.pin(small, &error));
    QCOMPARE(engine.pins.size(), 10);
    auto first = engine.pins.first();
    first->resize(100, 150);
    first->setWindowOpacity(0.3);
    QCOMPARE(first->image, small);
    for (auto p : engine.pins)
      p->destroyPin();
    QTRY_VERIFY(engine.pins.isEmpty());
    // Shared immutable backing keeps this budget test from allocating 640 MiB.
    QImage large(8192, 4096, QImage::Format_ARGB32);
    large.fill(Qt::white);
    QVERIFY(engine.pin(large, &error));
    QApplication::processEvents();
    // Native halo bitmaps now count toward the total. A headless run has no
    // such surfaces; on a visible desktop they can consume the last few bytes
    // that previously allowed four images at exactly 128 MiB each.
    const auto capacity =
        Capture::MaxTotalBytes / engine.pins.first()->memoryCost();
    QVERIFY(capacity >= 3 && capacity <= 4);
    for (qint64 i = 1; i < capacity; ++i) {
      QVERIFY(engine.pin(large, &error));
      QApplication::processEvents();
    }
    QVERIFY(!engine.pin(large, &error));
    for (auto p : engine.pins)
      p->destroyPin();
    QTRY_VERIFY(engine.pins.isEmpty());
    QVERIFY(engine.pin(small, &error));
    engine.pins.first()->close();
    QTRY_VERIFY(engine.pins.isEmpty());
  }
  void saveDialogCancellation() {
    QTemporaryDir root;
    CaptureEngine engine("dialog-" + QUuid::createUuid().toString(), "token",
                         root.path());
    QImage image(20, 30, QImage::Format_RGB32);
    image.fill(Qt::white);
    auto overlay =
        new CaptureOverlay(QGuiApplication::primaryScreen(), image, "global");
    engine.overlays.push_back(overlay);
    engine.selected = overlay;
    engine.session = "test";
    QTimer::singleShot(30, [] {
      for (auto w : QApplication::topLevelWidgets())
        if (auto dialog = qobject_cast<QFileDialog *>(w))
          dialog->reject();
    });
    engine.output(overlay, "save", image);
    QCOMPARE(engine.session, QString("test"));
    QVERIFY(!engine.busy);
    overlay->selection = {0, 0, 20, 30};
    overlay->document.append({"line", {{2, 3}, {15, 23}}, Qt::red, 3});
    auto content = overlay->document.render();
    engine.settingsPath = root.filePath("capture.ini");
    {
      QSettings settings(engine.settingsPath, QSettings::IniFormat);
      settings.setValue("quickSaveDirectory", root.filePath("missing"));
    }
    engine.output(overlay, "quickSave", content);
    QCOMPARE(engine.session, QString("test"));
    QVERIFY(!engine.busy);
    QCOMPARE(overlay->document.render(), content);
    QCOMPARE(overlay->selection, QRect(0, 0, 20, 30));
    QPointer<CaptureOverlay> guard(overlay);
    QTimer::singleShot(30, [&] { engine.finish("cancelled"); });
    engine.output(overlay, "save", image);
    QTRY_VERIFY(guard.isNull());
    QVERIFY(engine.session.isEmpty());
    QVERIFY(!engine.busy);
  }
  void annotationToolsAndChineseInput() {
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "note");
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    overlay.resize(800, 600);
    overlay.show();
    overlay.selectAll();
    auto toolbar = overlay.findChild<QToolBar *>();
    auto choose = [&](QString name) {
      for (auto a : toolbar->actions())
        if (a->text() == name) {
          a->trigger();
          return true;
        }
      return false;
    };
    for (auto name : QStringList{QStringLiteral("矩形"), QStringLiteral("椭圆"),
                                 QStringLiteral("箭头"), QStringLiteral("画笔"),
                                 QStringLiteral("马赛克")}) {
      QVERIFY(choose(name));
      auto count = overlay.document.strokes.size();
      QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, {120, 160});
      QTest::mouseMove(&overlay, {320, 260});
      QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier, {320, 260});
      QCOMPARE(overlay.document.strokes.size(), count + 1);
    }
    QVERIFY(choose(QStringLiteral("文字")));
    QTest::mouseClick(&overlay, Qt::LeftButton, Qt::NoModifier, {200, 300});
    auto editor = overlay.annotations->textWidget();
    QVERIFY(editor);
    QInputMethodEvent commit;
    commit.setCommitString(QStringLiteral("中文标注\n第二行"));
    QApplication::sendEvent(editor, &commit);
    QTest::keyClick(editor, Qt::Key_Return, Qt::ControlModifier);
    QCOMPARE(overlay.document.strokes.last().text,
             QStringLiteral("中文标注\n第二行"));
    auto completed = overlay.document.render();
    QTest::keyClick(&overlay, Qt::Key_Z, Qt::ControlModifier);
    QVERIFY(overlay.document.render() != completed);
    QTest::keyClick(&overlay, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(overlay.document.render(), completed);
    // A smaller logical viewport still edits canonical physical-image pixels.
    overlay.resize(640, 480);
    overlay.annotations->complete();
    overlay.selection = QRect(100, 100, 200, 100);
    QTest::keyClick(&overlay, Qt::Key_Right);
    QCOMPARE(overlay.selection.x(), 101);
    overlay.close();
  }
  void displayChangeCancelsSessionAndRecoversPin() {
    QTemporaryDir root;
    CaptureEngine engine("topology-" + QUuid::createUuid().toString(), "token",
                         root.path());
    QImage image(100, 80, QImage::Format_RGB32);
    image.fill(Qt::white);
    QString error;
    QVERIFY(engine.pin(image, &error));
    QPointer<PinWindow> pin = engine.pins.first();
    const auto work = Capture::nativeWorkArea(QGuiApplication::primaryScreen());
    QVERIFY(pin->placeAtPhysicalGeometry(
        QRect(work.bottomRight() + QPoint(1000, 1000), QSize(100, 80))));
    auto overlay =
        new CaptureOverlay(QGuiApplication::primaryScreen(), image, "global");
    engine.overlays << overlay;
    engine.selected = overlay;
    engine.session = "topology-session";
    engine.lastArea = {10, 20, 50, 30};
    engine.lastScreen = "old-layout";
    overlay->cancel = [&] { engine.finish("cancelled"); };
    QPointer<CaptureOverlay> guard = overlay;
    auto screen = QGuiApplication::primaryScreen();
    // Simulate the Qt notification, without changing the user's display setup.
    QVERIFY(QMetaObject::invokeMethod(screen, "geometryChanged",
                                      Qt::DirectConnection,
                                      Q_ARG(QRect, screen->geometry())));
    QVERIFY(engine.session.isEmpty());
    QVERIFY(engine.lastArea.isEmpty());
    QVERIFY(engine.lastScreen.isEmpty());
    QTRY_VERIFY(guard.isNull());
    QVERIFY(pin && pin->isVisible());
    QVERIFY(Capture::nativeWorkArea(screen).contains(
        Capture::physicalWindowRect(pin->winId())));
  }
  void realDesktopSessionAndPins() {
    if (!Capture::interactiveDesktopAvailable())
      QSKIP("Windows session is locked; real desktop capture requires an "
            "unlocked session");
    // Every monitor is covered by test-owned pixels before freezing the
    // desktop.
    QVector<QWidget *> canvases;
    for (auto screen : QGuiApplication::screens()) {
      auto canvas = new QWidget(nullptr, Qt::FramelessWindowHint |
                                             Qt::WindowStaysOnTopHint);
      canvas->setScreen(screen);
      canvas->setGeometry(screen->geometry());
      canvas->setStyleSheet("background:#245080;");
      canvas->show();
      canvas->raise();
      canvases << canvas;
    }
    auto canvasCleanup = qScopeGuard([&] { qDeleteAll(canvases); });
    QTest::qWait(200);
    QTemporaryDir root;
    auto name =
        "capture-test-" + QUuid::createUuid().toString(QUuid::WithoutBraces);
    QString token(64, 'a');
    CaptureEngine engine(name, token, root.path());
    QLocalSocket socket;
    socket.connectToServer(name);
    QTRY_COMPARE(socket.state(), QLocalSocket::ConnectedState);
    auto send = [&](QJsonObject m) {
      socket.write(QJsonDocument(m).toJson(QJsonDocument::Compact) + '\n');
      socket.flush();
    };
    QByteArray incoming;
    QList<QJsonObject> messages;
    connect(&socket, &QLocalSocket::readyRead, this, [&] {
      incoming += socket.readAll();
      while (incoming.contains('\n')) {
        int e = incoming.indexOf('\n');
        qInfo().noquote() << incoming.left(e);
        messages.append(QJsonDocument::fromJson(incoming.left(e)).object());
        incoming.remove(0, e + 1);
      }
    });
    auto has = [&](QString type) {
      return std::any_of(messages.begin(), messages.end(),
                         [&](auto m) { return m["type"].toString() == type; });
    };
    send({{"type", "hello"}, {"version", 1}, {"token", token}});
    QTRY_VERIFY(has("ready"));
    auto id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    QDir(root.path()).mkdir(id);
    send({{"type", "capture"}, {"origin", "note"}, {"sessionId", id}});
    QTRY_VERIFY_WITH_TIMEOUT(has("captureReady"), 10000);
    CaptureOverlay *overlay = nullptr;
    for (auto w : QApplication::topLevelWidgets())
      if (auto o = qobject_cast<CaptureOverlay *>(w))
        overlay = o;
    QVERIFY(overlay);
    overlay->selectAll();
    QImage frozen = overlay->document.base;
    overlay->document.append({"arrow", {{120, 140}, {300, 260}}, Qt::red, 5});
    const auto annotated = overlay->document.render();
    QTest::qWait(100);
    QCOMPARE(overlay->document.base, frozen);
    overlay->output("source", frozen.copy(QRect(0, 0, 20, 30)));
    QTRY_VERIFY(has("output"));
    QJsonObject delivery;
    for (auto m : messages)
      if (m["type"] == "output")
        delivery = m;
    QString assetPath =
        QDir(root.path())
            .filePath(id + "/" + delivery["deliveryId"].toString() + ".png");
    QCOMPARE(QImage(assetPath).size(), QSize(20, 30));
    QVERIFY(!overlay->isVisible());
    send({{"type", "ack"},
          {"sessionId", id},
          {"deliveryId", delivery["deliveryId"]},
          {"accepted", false},
          {"message", "test rejection"}});
    QTRY_VERIFY(overlay->isVisible());
    QCOMPARE(overlay->document.base, frozen);
    QVERIFY(!QFile::exists(assetPath));
    QCOMPARE(overlay->document.render(), annotated);
    QTest::keyClick(overlay, Qt::Key_T, Qt::ControlModifier);
    QTRY_VERIFY(has("finished"));
    QCOMPARE(std::count_if(messages.begin(), messages.end(),
                           [](auto m) { return m["type"] == "finished"; }),
             1);
    QCOMPARE(messages.last()["status"].toString(), QString("pinned"));
    PinWindow *pin = nullptr;
    for (auto w : QApplication::topLevelWidgets())
      if (auto p = qobject_cast<PinWindow *>(w))
        pin = p;
    QVERIFY(pin);
    QCOMPARE(pin->image, frozen);
    QCOMPARE(pin->exportImage(), annotated);
    QVERIFY(pin->isVisible());
    auto position = pin->pos();
    send({{"type", "togglePins"}});
    QTRY_VERIFY(!pin->isVisible());
    send({{"type", "togglePins"}});
    QTRY_VERIFY(pin->isVisible());
    QCOMPARE(pin->pos(), position);
    // Exercise the actual capture wiring over IPC, including another capture
    // after a system close. Existing pins must survive both cancellations.
    for (bool systemClose : {true, false}) {
      messages.clear();
      auto nextId = QUuid::createUuid().toString(QUuid::WithoutBraces);
      send({{"type", "capture"}, {"origin", "global"}, {"sessionId", nextId}});
      QTRY_VERIFY_WITH_TIMEOUT(has("captureReady"), 10000);
      QVERIFY(!engine.overlays.isEmpty());
      QPointer<CaptureOverlay> current = engine.overlays.first();
      QVERIFY(current);
      current->selectAll();
      if (systemClose)
        SendMessageW(reinterpret_cast<HWND>(current->winId()), WM_SYSCOMMAND,
                     SC_CLOSE, 0);
      else
        QTest::keyClick(current, Qt::Key_Escape);
      QTRY_VERIFY(has("finished"));
      QTRY_VERIFY(current.isNull());
      QVERIFY(engine.session.isEmpty());
      QCOMPARE(std::count_if(messages.begin(), messages.end(),
                             [](auto m) { return m["type"] == "finished"; }),
               1);
      QCOMPARE(messages.last()["sessionId"].toString(), nextId);
      QCOMPARE(messages.last()["status"].toString(), QString("cancelled"));
      QVERIFY(pin->isVisible());
    }
    QPointer<PinWindow> guard = pin;
    QTest::keyClick(pin, Qt::Key_Escape);
    QTRY_VERIFY(guard.isNull());
    socket.disconnectFromServer();
  }
};
int main(int argc, char **argv) {
  QApplication::setAttribute(Qt::AA_DontUseNativeDialogs);
  QApplication app(argc, argv);
  app.setStyle("Fusion");
  app.setQuitOnLastWindowClosed(false);
  UiTest tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "ui_test.moc"
