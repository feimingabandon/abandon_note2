#include "CaptureAppearance.h"
#include "DesktopCapture.h"
#include "DesktopTargets.h"
#include "PinHalo.h"
#include "PinWindow.h"
#include <QApplication>
#include <QDir>
#include <QPointer>
#include <QScreen>
#include <QtTest>
#include <dwmapi.h>
#include <windows.h>

namespace {
QVector<HWND> haloWindows(QWidget &pin) {
  QVector<HWND> result;
  EnumWindows(
      [](HWND window, LPARAM data) -> BOOL {
        wchar_t className[128]{};
        GetClassNameW(window, className, 128);
        // Feedback is also non-interactive decoration owned by the pin.
        // Count only the four halo strips, not every decoration window.
        if (QString::fromWCharArray(className) == "Abandon.Capture.PinHalo" &&
            GetPropW(window, Capture::DecorationProperty))
          reinterpret_cast<QVector<HWND> *>(data)->append(window);
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&result));
  const auto owner = reinterpret_cast<HWND>(pin.winId());
  result.removeIf(
      [&](HWND window) { return GetWindow(window, GW_OWNER) != owner; });
  std::sort(result.begin(), result.end(), [](HWND a, HWND b) {
    return reinterpret_cast<quintptr>(
               GetPropW(a, Capture::DecorationProperty)) <
           reinterpret_cast<quintptr>(GetPropW(b, Capture::DecorationProperty));
  });
  return result;
}
QImage sampleImage() {
  QImage image(360, 160, QImage::Format_ARGB32_Premultiplied);
  image.fill(QColor("#fffdf8"));
  QPainter p(&image);
  p.fillRect(24, 30, 80, 100, QColor("#ffd474"));
  p.fillRect(130, 30, 80, 100, QColor("#82bbf5"));
  p.fillRect(236, 30, 100, 100, QColor("#9dd7b7"));
  return image;
}
QRect nativeRect(HWND window) {
  RECT r{};
  GetWindowRect(window, &r);
  return {r.left, r.top, r.right - r.left, r.bottom - r.top};
}
QRect nativeRect(QWidget &widget) {
  return nativeRect(reinterpret_cast<HWND>(widget.winId()));
}
COLORREF screenPixel(POINT point) {
  DwmFlush();
  HDC dc = GetDC(nullptr);
  const auto color = GetPixel(dc, point.x, point.y);
  ReleaseDC(nullptr, dc);
  return color;
}
} // namespace

class PinHaloTest : public QObject {
  Q_OBJECT
private slots:
  void contentGeometryAndExport() {
    const auto original = sampleImage();
    Capture::ImageDocument document;
    document.base = original;
    const QRect selection(200, 200, 360, 160);
    PinWindow pin(document, {}, selection, QGuiApplication::primaryScreen());
    pin.show();
    QTRY_COMPARE(haloWindows(pin).size(), 4);
    const auto edges = haloWindows(pin);
    QTRY_VERIFY(IsWindowVisible(edges.first()));
    QCOMPARE(pin.geometry(), selection);
    QCOMPARE(pin.exportImage(), original);
    const auto display = pin.grab().toImage();
    // There must be no blue stroke painted over the first/last image pixels.
    QCOMPARE(display.pixelColor(0, display.height() / 2),
             original.pixelColor(0, 80));
    QCOMPARE(display.pixelColor(display.width() - 1, display.height() / 2),
             original.pixelColor(359, 80));
    for (auto edge : edges) {
      const auto ex = GetWindowLongPtrW(edge, GWL_EXSTYLE);
      QVERIFY(ex & WS_EX_TRANSPARENT);
      QVERIFY(ex & WS_EX_NOACTIVATE);
      QVERIFY(!nativeRect(edge).intersects(nativeRect(pin)));
    }
    qInfo() << "Pin DPR:" << pin.devicePixelRatioF();
  }
  void followsGeometryAndViewState() {
    PinWindow pin(sampleImage());
    pin.setGeometry(200, 200, 360, 160);
    pin.show();
    QTRY_COMPARE(haloWindows(pin).size(), 4);
    auto edges = haloWindows(pin);
    QTRY_VERIFY(IsWindowVisible(edges.first()));
    pin.move(241, 221);
    pin.resize(421, 191);
    QTest::qWait(30);
    const auto content = nativeRect(pin);
    QCOMPARE(nativeRect(edges[0]).y() + nativeRect(edges[0]).height(),
             content.y());
    QCOMPARE(nativeRect(edges[1]).y(), content.y() + content.height());
    QCOMPARE(nativeRect(edges[2]).x() + nativeRect(edges[2]).width(),
             content.x());
    QCOMPARE(nativeRect(edges[3]).x(), content.x() + content.width());
    pin.setWindowOpacity(.45);
    auto state = pin.viewState();
    state.topmost = false;
    pin.restoreView(state);
    QTRY_COMPARE(haloWindows(pin).size(), 4);
    edges = haloWindows(pin);
    for (auto edge : edges) {
      QTRY_VERIFY(IsWindowVisible(edge));
      QVERIFY(!(GetWindowLongPtrW(edge, GWL_EXSTYLE) & WS_EX_TOPMOST));
    }
    pin.resetScale();
    QTRY_COMPARE(haloWindows(pin).size(), 4);
    for (auto edge : haloWindows(pin))
      QTRY_VERIFY(IsWindowVisible(edge));
    QCOMPARE(pin.exportImage(), sampleImage());
  }
  void hideRestoreAndDestroy() {
    auto pin = new PinWindow(sampleImage());
    pin->setGeometry(200, 200, 360, 160);
    pin->show();
    QTRY_COMPARE(haloWindows(*pin).size(), 4);
    const auto edges = haloWindows(*pin);
    QTRY_VERIFY(IsWindowVisible(edges.first()));
    pin->hide();
    for (auto edge : edges)
      QVERIFY(!IsWindowVisible(edge));
    pin->show();
    for (auto edge : edges)
      QTRY_VERIFY(IsWindowVisible(edge));
    pin->showMinimized();
    for (auto edge : edges)
      QTRY_VERIFY(!IsWindowVisible(edge));
    pin->showNormal();
    for (auto edge : edges)
      QTRY_VERIFY(IsWindowVisible(edge));
    pin->close();
    for (auto edge : edges)
      QTRY_VERIFY(!IsWindow(edge));
  }
  void nativeOwnershipHitTestingAndDetection() {
    if (!Capture::interactiveDesktopAvailable())
      QSKIP("Interactive desktop is locked; native hit testing needs an "
            "unlocked session");
    QWidget canvas(nullptr, Qt::Tool | Qt::FramelessWindowHint |
                                Qt::WindowStaysOnTopHint);
    canvas.setGeometry(100, 100, 720, 480);
    canvas.setStyleSheet("background:#f7f8fa");
    canvas.show();
    canvas.raise();
    canvas.activateWindow();
    QVERIFY(QTest::qWaitForWindowActive(&canvas));
    PinWindow pin(sampleImage());
    pin.setGeometry(250, 220, 360, 160);
    pin.show();
    QTRY_COMPARE(haloWindows(pin).size(), 4);
    const auto edges = haloWindows(pin);
    QTRY_VERIFY(IsWindowVisible(edges.first()));
    QTest::qWait(80);
    const auto pinHandle = reinterpret_cast<HWND>(pin.winId());
    for (auto edge : edges) {
      const auto handle = edge;
      QCOMPARE(GetWindow(handle, GW_OWNER), pinHandle);
      const auto ex = GetWindowLongPtrW(handle, GWL_EXSTYLE);
      QVERIFY(ex & WS_EX_TRANSPARENT);
      QVERIFY(ex & WS_EX_NOACTIVATE);
      QVERIFY(ex & WS_EX_LAYERED);
      const auto center = nativeRect(edge).center();
      const POINT point{center.x(), center.y()};
      const auto hit = WindowFromPoint(point);
      if (hit != reinterpret_cast<HWND>(canvas.winId())) {
        DWORD process = 0;
        GetWindowThreadProcessId(hit, &process);
        wchar_t hitClass[128]{};
        GetClassNameW(hit, hitClass, 128);
        const auto canvasHandle = reinterpret_cast<HWND>(canvas.winId());
        qWarning() << "Unexpected halo hit" << process << center
                   << QString::fromWCharArray(hitClass) << "canvas"
                   << nativeRect(canvas) << "pin" << nativeRect(pin)
                   << "visible/enabled" << IsWindowVisible(canvasHandle)
                   << IsWindowEnabled(canvasHandle);
      }
      QCOMPARE(hit, reinterpret_cast<HWND>(canvas.winId()));
    }
    const auto content = nativeRect(pin).center();
    QCOMPARE(WindowFromPoint({content.x(), content.y()}), pinHandle);
    auto targets = Capture::desktopTargets(pin.screen());
    QVERIFY(std::any_of(targets.begin(), targets.end(),
                        [&](auto t) { return t.window == pin.winId(); }));
    for (auto edge : edges)
      QVERIFY(std::none_of(targets.begin(), targets.end(), [&](auto t) {
        return t.window == reinterpret_cast<quintptr>(edge);
      }));
    const POINT sample{nativeRect(pin).left() -
                           qRound(2 * pin.devicePixelRatioF()),
                       nativeRect(pin).center().y()};
    const auto opaque = screenPixel(sample);
    QVERIFY(opaque != CLR_INVALID);
    QVERIFY(GetRValue(opaque) < 247);
    pin.setWindowOpacity(.45);
    QTest::qWait(60);
    const auto translucent = screenPixel(sample);
    QVERIFY(GetRValue(translucent) > GetRValue(opaque));
    pin.resetScale();
    QTest::qWait(60);
    const POINT resetSample{nativeRect(pin).left() -
                                qRound(2 * pin.devicePixelRatioF()),
                            nativeRect(pin).center().y()};
    QCOMPARE(screenPixel(resetSample), opaque);
  }
  void clippedPerimeterAndResourceCleanup() {
    const auto gdiBefore = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    const QRect desktop(GetSystemMetrics(SM_XVIRTUALSCREEN),
                        GetSystemMetrics(SM_YVIRTUALSCREEN),
                        GetSystemMetrics(SM_CXVIRTUALSCREEN),
                        GetSystemMetrics(SM_CYVIRTUALSCREEN));
    for (int iteration = 0; iteration < 8; ++iteration) {
      auto pin = new PinWindow(sampleImage());
      pin->setGeometry(200, 200, 360, 160);
      pin->show();
      QTRY_COMPARE(haloWindows(*pin).size(), 4);
      const auto edges = haloWindows(*pin);
      RECT original{};
      const auto owner = reinterpret_cast<HWND>(pin->winId());
      QVERIFY(GetWindowRect(owner, &original));
      // Use exact native coordinates to cover fractional and negative desktop
      // origins without moving the user's pointer or changing display settings.
      SetWindowPos(owner, nullptr, desktop.x(), desktop.y(), 0, 0,
                   SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
      QTest::qWait(10);
      for (auto edge : haloWindows(*pin))
        if (IsWindowVisible(edge)) {
          QVERIFY(desktop.contains(nativeRect(edge)));
          QVERIFY(!nativeRect(*pin).intersects(nativeRect(edge)));
        }
      delete pin;
      QApplication::processEvents();
      for (auto edge : edges)
        QVERIFY(!IsWindow(edge));
    }
    QVERIFY(GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) <=
            gdiBefore + 2);
  }
  void glowFalloffAndVisualEvidence() {
    PinWindow pin(sampleImage());
    pin.setGeometry(200, 200, 360, 160);
    pin.show();
    QTRY_COMPARE(haloWindows(pin).size(), 4);
    const auto edges = haloWindows(pin);
    QTRY_VERIFY(IsWindowVisible(edges.first()));
    const auto strip = nativeRect(edges[2]);
    const auto glow = Capture::renderPinHaloStrip(
        strip.size(), nativeRect(pin).translated(-strip.topLeft()),
        pin.devicePixelRatioF());
    const auto y = glow.height() / 2;
    const auto innerSample = glow.pixelColor(glow.width() - 2, y);
    const auto outerSample = glow.pixelColor(1, y);
    QVERIFY(innerSample.alpha() > outerSample.alpha());
    QVERIFY(innerSample.blue() > innerSample.red());
    QVERIFY(outerSample.alpha() < 10);
    const auto evidence = qEnvironmentVariable("CAPTURE_HALO_EVIDENCE");
    if (evidence.isEmpty())
      return;
    QDir().mkpath(evidence);
    for (const auto theme : {"light", "dark", "pattern"}) {
      const qreal dpr = pin.devicePixelRatioF();
      QImage preview(QSize(460, 260) * dpr,
                     QImage::Format_ARGB32_Premultiplied);
      preview.fill(QString(theme) == "dark" ? QColor("#263448")
                                            : QColor("#f5f6f8"));
      QPainter p(&preview);
      p.scale(dpr, dpr);
      if (QString(theme) == "pattern")
        for (int x = 0; x < 460; x += 30)
          for (int y = 0; y < 260; y += 30)
            p.fillRect(x, y, 30, 30, QColor::fromHsl((x + y) % 360, 70, 190));
      p.resetTransform();
      const QPoint shift = QPoint(qRound(50 * dpr), qRound(50 * dpr)) -
                           nativeRect(pin).topLeft();
      p.drawImage(nativeRect(pin).translated(shift), pin.grab().toImage());
      for (auto edge : edges) {
        const auto r = nativeRect(edge);
        p.drawImage(
            r.translated(shift),
            Capture::renderPinHaloStrip(
                r.size(), nativeRect(pin).translated(-r.topLeft()), dpr));
      }
      p.end();
      QVERIFY(preview.save(QDir(evidence).filePath(QString(theme) + ".png")));
    }
  }
};
int main(int argc, char **argv) {
  QApplication app(argc, argv);
  app.setStyle("Fusion");
  app.setQuitOnLastWindowClosed(false);
  Capture::applyTheme({});
  PinHaloTest test;
  return QTest::qExec(&test, argc, argv);
}
#include "pin_halo_test.moc"
