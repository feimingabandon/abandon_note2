#include "CaptureOverlay.h"
#include "PinWindow.h"
#include <QApplication>
#include <QDir>
#include <QPushButton>
#include <QScopeGuard>
#include <QtTest>
#include <memory>
#include <windows.h>

class SelectionTest : public QObject {
  Q_OBJECT
  static QImage frame(QSize size, QColor color) {
    QImage image(size, QImage::Format_ARGB32_Premultiplied);
    image.fill(color);
    // Alternating single pixels expose accidental DPR resampling at a seam.
    for (int x = 0; x < size.width(); ++x)
      image.setPixelColor(x, 0, x % 2 ? Qt::black : Qt::white);
    return image;
  }
  static void mouse(CaptureOverlay &o, QEvent::Type type, QPoint point,
                    Qt::KeyboardModifiers modifiers = Qt::NoModifier) {
    const auto local = o.annotations->displayTransform().map(QPointF(point));
    const auto button =
        type == QEvent::MouseMove ? Qt::NoButton : Qt::LeftButton;
    const auto buttons =
        type == QEvent::MouseButtonRelease ? Qt::NoButton : Qt::LeftButton;
    QMouseEvent event(type, local, o.mapToGlobal(local.toPoint()), button,
                      buttons, modifiers);
    QApplication::sendEvent(&o, &event);
  }
  static void targets(CaptureOverlay &o, QVector<QRect> rects) {
    o.targets.clear();
    for (auto r : rects)
      o.targets << Capture::DesktopTarget{
          0, r.translated(o.nativeBounds.topLeft())};
    o.rebuildSnapTargets();
  }
  static std::unique_ptr<CaptureOverlay> canvas() {
    auto o = std::make_unique<CaptureOverlay>(QGuiApplication::primaryScreen(),
                                              frame({800, 600}, Qt::white),
                                              "global");
    o->setAttribute(Qt::WA_DeleteOnClose, false);
    o->resize(800, 600);
    targets(*o, {{100, 100, 300, 200}});
    return o;
  }
private slots:
  void nativeTargetEligibility_data() {
    QTest::addColumn<quint32>("style");
    QTest::addColumn<bool>("expected");
    QTest::newRow("layered-click-through")
        << quint32(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE)
        << false;
    QTest::newRow("interactive-layered") << quint32(WS_EX_LAYERED) << true;
    QTest::newRow("interactive-tool") << quint32(WS_EX_TOOLWINDOW) << true;
    QTest::newRow("genuine-fullscreen") << quint32(0) << true;
    // WS_EX_TRANSPARENT alone specifies paint order, not mouse pass-through.
    QTest::newRow("transparent-paint-order")
        << quint32(WS_EX_TRANSPARENT) << true;
  }
  void nativeTargetEligibility() {
    QFETCH(quint32, style);
    QFETCH(bool, expected);
    auto screen = QGuiApplication::primaryScreen();
    const auto bounds = Capture::nativeScreenRect(screen);
    auto window = CreateWindowExW(
        style | WS_EX_TOPMOST, L"STATIC", L"Capture target test", WS_POPUP,
        bounds.x(), bounds.y(), bounds.width(), bounds.height(), nullptr,
        nullptr, GetModuleHandleW(nullptr), nullptr);
    QVERIFY(window);
    const auto cleanup = qScopeGuard([&] { DestroyWindow(window); });
    if (style & WS_EX_LAYERED)
      QVERIFY(SetLayeredWindowAttributes(window, 0, 1, LWA_ALPHA));
    ShowWindow(window, SW_SHOWNOACTIVATE);
    const auto targets = Capture::desktopTargets(screen);
    QCOMPARE(std::any_of(targets.begin(), targets.end(),
                         [&](auto target) {
                           return target.window ==
                                  reinterpret_cast<quintptr>(window);
                         }),
             expected);
  }
  void windowAndControlThroughFullscreenOverlay() {
    auto screen = QGuiApplication::primaryScreen();
    const auto bounds = Capture::nativeScreenRect(screen);
    QWidget fixture(nullptr,
                    Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint);
    fixture.setGeometry(QRect(screen->geometry().topLeft() + QPoint(180, 180),
                              QSize(500, 300)));
    QPushButton control("Capture fixture button", &fixture);
    control.setGeometry(80, 70, 200, 60);
    fixture.show();
    fixture.raise();
    QTest::qWait(60);
    const auto fixtureRect = Capture::physicalWindowRect(fixture.winId());
    const auto point = Capture::physicalClientPoint(
        fixture.winId(),
        (QPointF(control.geometry().center()) * fixture.devicePixelRatioF())
            .toPoint());
    auto helper = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
        L"STATIC", L"Capture pass-through fixture", WS_POPUP, bounds.x(),
        bounds.y(), bounds.width(), bounds.height(), nullptr, nullptr,
        GetModuleHandleW(nullptr), nullptr);
    QVERIFY(helper);
    const auto cleanup = qScopeGuard([&] { DestroyWindow(helper); });
    QVERIFY(SetLayeredWindowAttributes(helper, 0, 1, LWA_ALPHA));
    ShowWindow(helper, SW_SHOWNOACTIVATE);
    Capture::DesktopLayout layout{{{bounds, screen->geometry()}}};
    CaptureOverlay o(screen, frame(bounds.size(), Qt::white), "global", layout);
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    // Use the production native enumeration, without injecting target bounds.
    o.showDesktop();
    QTest::qWait(60);
    o.hover = o.logical(QRect(point - bounds.topLeft(), QSize(1, 1))).topLeft();
    o.detect();
    QCOMPARE(o.detected, fixtureRect.translated(-bounds.topLeft()));
    QVERIFY(o.selection.isEmpty());
    QTest::keyClick(&o, Qt::Key_Tab);
    QTRY_VERIFY_WITH_TIMEOUT(
        o.hint->text().contains(QStringLiteral("已识别控件")), 4000);
    const auto child = o.detected;
    QVERIFY(child.contains(point - bounds.topLeft()));
    QVERIFY(child.width() < fixtureRect.width());
    QVERIFY(child.height() < fixtureRect.height());
    mouse(o, QEvent::MouseButtonPress, point - bounds.topLeft());
    mouse(o, QEvent::MouseButtonRelease, point - bounds.topLeft());
    QCOMPARE(o.selection, child);
    o.clearSelection();
    QTest::keyClick(&o, Qt::Key_Tab);
    QCOMPARE(o.detected, fixtureRect.translated(-bounds.topLeft()));
    mouse(o, QEvent::MouseButtonPress, point - bounds.topLeft());
    mouse(o, QEvent::MouseButtonRelease, point - bounds.topLeft());
    QCOMPARE(o.selection, fixtureRect.translated(-bounds.topLeft()));
  }
  void snappingVisibilityAndBounds() {
    Capture::SelectionSnap snap;
    snap.reset({0, 0, 800, 600}, {{0, 0, 800, 600}},
               {{90, 90, 320, 220}, {100, 100, 300, 200}});
    // The lower window's hidden edge must not attract the selection.
    QCOMPARE(snap.point({102, 150}, 6), QPoint(102, 150));
    QCOMPARE(snap.point({93, 150}, 6), QPoint(90, 150));
    QCOMPARE(snap.point({407, 150}, 6), QPoint(410, 150));
    QCOMPARE(snap.point({793, 593}, 6), QPoint(793, 593));
    QCOMPARE(snap.point({796, 596}, 6), QPoint(800, 600));
    // Distant collinear segments and completely offscreen windows do not snap.
    QCOMPARE(snap.point({93, 400}, 6), QPoint(93, 400));
    snap.reset({0, 0, 800, 600}, {{0, 0, 800, 600}}, {{900, 0, 40, 300}});
    QCOMPARE(snap.point({798, 100}, 6), QPoint(800, 100));
  }
  void movementKeepsSizeAndExactAlignment() {
    Capture::SelectionSnap snap;
    snap.reset({0, 0, 800, 600}, {{0, 0, 800, 600}}, {{100, 100, 300, 200}});
    QCOMPARE(snap.move({104, 104, 200, 120}, 6, {0, 0, 800, 600}),
             QRect(100, 100, 200, 120));
    // An already aligned edge wins over another edge that is merely nearby.
    QCOMPARE(snap.move({100, 150, 296, 70}, 6, {0, 0, 800, 600}),
             QRect(100, 150, 296, 70));
    QCOMPARE(snap.move({604, 150, 196, 70}, 6, {0, 0, 800, 600}),
             QRect(604, 150, 196, 70));
  }
  void newSelectionBypassAndPrecision() {
    auto o = canvas();
    mouse(*o, QEvent::MouseButtonPress, {103, 103});
    mouse(*o, QEvent::MouseMove, {397, 297});
    QCOMPARE(o->selection, QRect(100, 100, 300, 200));
    QVERIFY(o->annotations->panel->isHidden());
    QTest::keyPress(o.get(), Qt::Key_Control);
    QCOMPARE(o->selection, QRect(103, 103, 294, 194));
    QTest::keyRelease(o.get(), Qt::Key_Control);
    QCOMPARE(o->selection, QRect(100, 100, 300, 200));
    mouse(*o, QEvent::MouseButtonRelease, {397, 297});
    QVERIFY(!o->annotations->panel->isHidden());
    QTest::keyClick(o.get(), Qt::Key_Right);
    QCOMPARE(o->selection.x(), 101);
    // Reversed drags and holding Ctrl for the complete gesture keep raw pixels.
    o->clearSelection();
    mouse(*o, QEvent::MouseButtonPress, {397, 297}, Qt::ControlModifier);
    mouse(*o, QEvent::MouseMove, {103, 103}, Qt::ControlModifier);
    mouse(*o, QEvent::MouseButtonRelease, {103, 103}, Qt::ControlModifier);
    QCOMPARE(o->selection, QRect(103, 103, 294, 194));
  }
  void resizeHandles_data() {
    QTest::addColumn<int>("handle");
    for (int i = 0; i < 8; ++i)
      QTest::newRow(qPrintable(QString::number(i))) << i;
  }
  void resizeHandles() {
    QFETCH(int, handle);
    auto o = canvas();
    o->selection = {150, 150, 200, 100};
    const QVector<QPoint> ends{{103, 103}, {250, 103}, {397, 103}, {397, 200},
                               {397, 297}, {250, 297}, {103, 297}, {103, 200}};
    const auto start = o->handles()[handle];
    mouse(*o, QEvent::MouseButtonPress, start);
    mouse(*o, QEvent::MouseMove, ends[handle]);
    mouse(*o, QEvent::MouseButtonRelease, ends[handle]);
    const int left = handle == 0 || handle == 6 || handle == 7 ? 100 : 150;
    const int right = handle >= 2 && handle <= 4 ? 400 : 350;
    const int top = handle <= 2 ? 100 : 150;
    const int bottom = handle >= 4 && handle <= 6 ? 300 : 250;
    QCOMPARE(o->selection, QRect(left, top, right - left, bottom - top));
  }
  void clickSelectionMoveAndSpace() {
    auto o = canvas();
    o->hover = {200, 150};
    o->detect();
    mouse(*o, QEvent::MouseButtonPress, {200, 150});
    mouse(*o, QEvent::MouseButtonRelease, {200, 150});
    QCOMPARE(o->selection, QRect(100, 100, 300, 200));
    mouse(*o, QEvent::MouseButtonPress, {200, 150});
    mouse(*o, QEvent::MouseMove, {203, 154});
    QCOMPARE(o->selection, QRect(100, 100, 300, 200));
    mouse(*o, QEvent::MouseMove, {220, 170});
    mouse(*o, QEvent::MouseButtonRelease, {220, 170});
    QCOMPARE(o->selection, QRect(120, 120, 300, 200));
    o->clearSelection();
    targets(*o, {});
    mouse(*o, QEvent::MouseButtonPress, {100, 100});
    mouse(*o, QEvent::MouseMove, {300, 250});
    QTest::keyPress(o.get(), Qt::Key_Space);
    mouse(*o, QEvent::MouseMove, {320, 270});
    QTest::keyRelease(o.get(), Qt::Key_Space);
    mouse(*o, QEvent::MouseButtonRelease, {320, 270});
    QCOMPARE(o->selection, QRect(120, 120, 200, 150));
  }
  void composition_data() {
    QTest::addColumn<QRect>("first");
    QTest::addColumn<QRect>("second");
    QTest::newRow("left-negative-mixed")
        << QRect(-160, 0, 160, 120) << QRect(0, 0, 240, 180);
    QTest::newRow("above-negative-portrait")
        << QRect(0, -240, 120, 240) << QRect(0, 0, 240, 160);
    QTest::newRow("vertical-offset")
        << QRect(0, 0, 160, 120) << QRect(160, -45, 240, 180);
    QTest::newRow("physical-gap")
        << QRect(0, 0, 160, 120) << QRect(195, 20, 240, 180);
    QTest::newRow("odd-fractional")
        << QRect(-161, -13, 161, 123) << QRect(0, 0, 239, 181);
  }
  void composition() {
    QFETCH(QRect, first);
    QFETCH(QRect, second);
    Capture::DesktopLayout layout{
        {{first, {first.topLeft(), first.size()}},
         {second, {second.topLeft(), second.size() / 2}}}};
    auto a = frame(first.size(), Qt::red), b = frame(second.size(), Qt::blue);
    b.setDevicePixelRatio(2);
    QString error;
    const auto result = Capture::composeDesktop(layout, {a, b}, &error);
    QVERIFY2(!result.isNull(), qPrintable(error));
    QCOMPARE(result.size(), first.united(second).size());
    a.setDevicePixelRatio(1);
    b.setDevicePixelRatio(1);
    QCOMPARE(result.copy(first.translated(-layout.bounds().topLeft())), a);
    QCOMPARE(result.copy(second.translated(-layout.bounds().topLeft())), b);
    for (int y = 0; y < result.height(); ++y)
      for (int x = 0; x < result.width(); ++x) {
        const auto global = QPoint(x, y) + layout.bounds().topLeft();
        if (!first.contains(global) && !second.contains(global))
          QCOMPARE(result.pixelColor(x, y).alpha(), 0);
      }
    QCOMPARE(layout.monitorAt(first.center()), 0);
    QCOMPARE(layout.monitorAt(second.center()), 1);
    QCOMPARE(layout.toLogical(second), layout.monitors[1].logical);
    const auto signature = layout.signature();
    std::reverse(layout.monitors.begin(), layout.monitors.end());
    QCOMPARE(layout.signature(), signature);
  }
  void compositionRejectsInvalidAndHugeLayouts() {
    QString error;
    QVERIFY(Capture::composeDesktop({}, {}, &error).isNull());
    Capture::DesktopLayout layout{{{{0, 0, 160, 120}, {0, 0, 160, 120}}}};
    QVERIFY(Capture::composeDesktop(layout, {}, &error).isNull());
    QVERIFY(
        Capture::composeDesktop(layout, {frame({159, 120}, Qt::red)}, &error)
            .isNull());
    layout.monitors << Capture::DesktopMonitor{{100000, 100000, 10, 10},
                                               {100000, 100000, 10, 10}};
    QVERIFY(Capture::composeDesktop(
                layout, {frame({160, 120}, Qt::red), frame({10, 10}, Qt::blue)},
                &error)
                .isNull());
  }
  void virtualScreensSelectionToolbarAndPin_data() {
    QTest::addColumn<bool>("negativeOrigin");
    QTest::newRow("positive") << false;
    QTest::newRow("negative") << true;
  }
  void virtualScreensSelectionToolbarAndPin() {
    QFETCH(bool, negativeOrigin);
    auto screen = QGuiApplication::primaryScreen();
    const auto screenRect = Capture::nativeScreenRect(screen);
    // Two synthetic monitors on one real screen. This exercises coordinates and
    // native placement, but deliberately does NOT claim two physical displays.
    const QRect bounds(screenRect.topLeft() +
                           QPoint(negativeOrigin ? -700 : 20, 20),
                       QSize(std::min(1577, screenRect.width() - 40),
                             std::min(797, screenRect.height() - 40)));
    const int split = bounds.width() / 2;
    const QRect left(bounds.topLeft(), QSize(split, bounds.height()));
    const QRect right(bounds.topLeft() + QPoint(split, 0),
                      QSize(bounds.width() - split, bounds.height()));
    Capture::DesktopLayout layout{
        {{left, {left.topLeft(), left.size()}},
         {right, {right.topLeft(), right.size() / 2}}}};
    QString error;
    const auto image = Capture::composeDesktop(
        layout, {frame(left.size(), Qt::red), frame(right.size(), Qt::blue)},
        &error);
    CaptureOverlay o(screen, image, "global", layout);
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    targets(o, {});
    o.showDesktop();
    QTest::qWait(80);
    QVERIFY(o.placementValid);
    RECT native{};
    QVERIFY(GetWindowRect(reinterpret_cast<HWND>(o.winId()), &native));
    QCOMPARE(QRect(native.left, native.top, native.right - native.left,
                   native.bottom - native.top),
             bounds);
    QCOMPARE(o.snapThreshold({10, 100}), 6);
    QCOMPARE(o.snapThreshold({split + 10, 100}), 12);
    // Include the top alternating-pixel row across the seam.
    mouse(o, QEvent::MouseButtonPress, {split - 160, 0}, Qt::ControlModifier);
    mouse(o, QEvent::MouseMove, {split + 160, 240}, Qt::ControlModifier);
    mouse(o, QEvent::MouseButtonRelease, {split + 160, 240},
          Qt::ControlModifier);
    QCOMPARE(o.selection, QRect(split - 160, 0, 320, 240));
    QVERIFY(o.monitorViewport(1).contains(o.annotations->panel->geometry()));
    QVERIFY(o.monitorViewport(1).contains(o.hint->geometry()));
    const auto fixedToolbar = o.annotations->panel->pos();
    // Hovering across screens after selection must not make the toolbar jump.
    QMouseEvent hover(QEvent::MouseMove, QPointF(20, 30), QPointF(20, 30),
                      Qt::NoButton, Qt::NoButton, Qt::NoModifier);
    QApplication::sendEvent(&o, &hover);
    QCOMPARE(o.annotations->panel->pos(), fixedToolbar);
    QImage exported;
    o.output = [&](QString action, QImage result) {
      QCOMPARE(action, QString("copy"));
      exported = result;
    };
    QTest::keyClick(&o, Qt::Key_Return);
    QCOMPARE(exported, image.copy(o.selection));
    o.annotations->choose("line");
    mouse(o, QEvent::MouseButtonPress, {split - 120, 70});
    mouse(o, QEvent::MouseMove, {split + 120, 170});
    mouse(o, QEvent::MouseButtonRelease, {split + 120, 170});
    QTest::keyClick(&o, Qt::Key_Return);
    QCOMPARE(exported, o.document.render().copy(o.selection));
    QVERIFY(exported != image.copy(o.selection));
    const auto physical = o.selectionPhysicalGeometry();
    PinWindow pin(exported);
    pin.setAttribute(Qt::WA_DeleteOnClose, false);
    pin.show();
    QVERIFY(pin.placeAtPhysicalGeometry(physical));
    QVERIFY(GetWindowRect(reinterpret_cast<HWND>(pin.winId()), &native));
    QCOMPARE(QRect(native.left, native.top, native.right - native.left,
                   native.bottom - native.top),
             physical);
    QCOMPARE(pin.exportImage(), exported);
    pin.hide();
    o.hover = o.logical(QRect(split + 40, 30, 1, 1)).topLeft();
    o.selectAll();
    QCOMPARE(o.selection, right.translated(-bounds.topLeft()));
    const auto evidence = qEnvironmentVariable("CAPTURE_SELECTION_EVIDENCE");
    if (!evidence.isEmpty()) {
      QDir().mkpath(evidence);
      QVERIFY(exported.save(
          QDir(evidence).filePath(negativeOrigin ? "negative-cross-screen.png"
                                                 : "cross-screen-pixels.png")));
    }
  }
  void pinDragUsesPhysicalCoordinates() {
    const auto work = Capture::nativeWorkArea(QGuiApplication::primaryScreen());
    PinWindow pin(frame({300, 160}, Qt::green));
    pin.setAttribute(Qt::WA_DeleteOnClose, false);
    pin.show();
    const QRect initial(work.topLeft() + QPoint(100, 100), QSize(300, 160));
    QVERIFY(pin.placeAtPhysicalGeometry(initial));
    auto send = [&](QEvent::Type type, QPoint physical) {
      const auto origin = Capture::physicalClientPoint(pin.winId(), {});
      const QPointF local =
          QPointF(physical - origin) / pin.devicePixelRatioF();
      // Deliberately unrelated Qt global coordinates: monitor transitions can
      // have logical gaps and must never determine a native dragging delta.
      QMouseEvent event(
          type, local, QPointF(90000, -50000),
          type == QEvent::MouseMove ? Qt::NoButton : Qt::LeftButton,
          type == QEvent::MouseButtonRelease ? Qt::NoButton : Qt::LeftButton,
          Qt::NoModifier);
      QApplication::sendEvent(&pin, &event);
    };
    const auto press = initial.topLeft() + QPoint(80, 60);
    send(QEvent::MouseButtonPress, press);
    send(QEvent::MouseMove, press + QPoint(73, 41));
    send(QEvent::MouseMove, press + QPoint(127, 64));
    send(QEvent::MouseButtonRelease, press + QPoint(127, 64));
    const auto moved = initial.translated(127, 64);
    QCOMPARE(Capture::physicalWindowRect(pin.winId()), moved);
    const auto edge = moved.topLeft() + QPoint(298, 80);
    send(QEvent::MouseButtonPress, edge);
    send(QEvent::MouseMove, edge + QPoint(150, 0));
    send(QEvent::MouseButtonRelease, edge + QPoint(150, 0));
    QCOMPARE(Capture::physicalWindowRect(pin.winId()),
             QRect(moved.topLeft(), QSize(450, 240)));
    QVERIFY(pin.placeAtPhysicalGeometry(
        QRect(work.bottomRight() + QPoint(1000, 1000), QSize(300, 160))));
    pin.constrain();
    QVERIFY(work.contains(Capture::physicalWindowRect(pin.winId())));
  }
};
int main(int argc, char **argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  QApplication app(argc, argv);
  app.setStyle("Fusion");
  app.setQuitOnLastWindowClosed(false);
  SelectionTest test;
  return QTest::qExec(&test, argc, argv);
}
#include "selection_test.moc"
