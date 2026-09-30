#include "DesktopCapture.h"
#include <QApplication>
#include <QBuffer>
#include <QtTest>
#include <future>
#include <thread>
#include <windows.h>

class ClipboardTest : public QObject {
  Q_OBJECT
private slots:
  void roundTripAndLifetime() {
    QImage image(20, 30, QImage::Format_ARGB32);
    image.fill(QColor(15, 80, 160, 128));
    QString error;
    // System-owned DIB survives destruction of the copying window.
    HWND owner = CreateWindowExW(0, L"STATIC", L"test", WS_POPUP, 0, 0, 100,
                                 100, nullptr, nullptr, nullptr, nullptr);
    QVERIFY(owner);
    ShowWindow(owner, SW_SHOW);
    SetActiveWindow(owner);
    QVERIFY2(Capture::writeClipboardImage(image, &error), qPrintable(error));
    DestroyWindow(owner);
    QVERIFY(OpenClipboard(nullptr));
    auto data = GetClipboardData(CF_DIBV5);
    QVERIFY(data);
    auto header = static_cast<BITMAPV5HEADER *>(GlobalLock(data));
    QVERIFY(header);
    QCOMPARE(header->bV5Width, LONG(20));
    QCOMPARE(header->bV5Height, LONG(-30));
    auto decoded = QImage(reinterpret_cast<uchar *>(header + 1), 20, 30,
                          QImage::Format_ARGB32)
                       .copy();
    GlobalUnlock(data);
    CloseClipboard();
    QCOMPARE(decoded, image);
    QCOMPARE(Capture::readClipboardImage(&error), image);
  }
  void pngOnlyProvider() {
    QImage image(12, 15, QImage::Format_ARGB32);
    image.fill(Qt::green);
    QByteArray encoded;
    QBuffer buffer(&encoded);
    buffer.open(QIODevice::WriteOnly);
    QVERIFY(image.save(&buffer, "PNG"));
    auto owner = CreateWindowExW(0, L"STATIC", L"png", WS_POPUP, 0, 0, 10, 10,
                                 nullptr, nullptr, nullptr, nullptr);
    QVERIFY(owner);
    QVERIFY(OpenClipboard(owner));
    QVERIFY(EmptyClipboard());
    auto memory = GlobalAlloc(GMEM_MOVEABLE, SIZE_T(encoded.size()));
    QVERIFY(memory);
    auto bytes = GlobalLock(memory);
    QVERIFY(bytes);
    memcpy(bytes, encoded.constData(), size_t(encoded.size()));
    GlobalUnlock(memory);
    QVERIFY(SetClipboardData(RegisterClipboardFormatW(L"PNG"), memory));
    CloseClipboard();
    QString error;
    QCOMPARE(Capture::readClipboardImage(&error), image);
    DestroyWindow(owner);
  }
  void occupiedClipboardDoesNotReportSuccess() {
    std::promise<bool> opened;
    std::promise<void> release;
    auto done = release.get_future();
    std::thread holder([&] {
      auto owner = CreateWindowExW(0, L"STATIC", L"holder", 0, 0, 0, 0, 0,
                                   HWND_MESSAGE, nullptr, nullptr, nullptr);
      bool ok = owner && OpenClipboard(owner);
      opened.set_value(ok);
      done.wait();
      if (ok)
        CloseClipboard();
      if (owner)
        DestroyWindow(owner);
    });
    bool held = opened.get_future().get();
    QImage image(10, 10, QImage::Format_RGB32);
    image.fill(Qt::red);
    QString error;
    bool copied = Capture::writeClipboardImage(image, &error);
    release.set_value();
    holder.join();
    QVERIFY(held);
    QVERIFY(!copied);
    QVERIFY(!error.isEmpty());
  }
};
int main(int argc, char **argv) {
  // An isolated window station has its own clipboard. Never overwrite the
  // interactive user's images, files, rich text or clipboard history.
  auto original = GetProcessWindowStation();
  auto station = CreateWindowStationW(nullptr, 0, WINSTA_ALL_ACCESS, nullptr);
  if (!station || !SetProcessWindowStation(station))
    return 2;
  auto desktop = CreateDesktopW(L"capture-test", nullptr, nullptr, 0,
                                GENERIC_ALL, nullptr);
  if (!desktop || !SetThreadDesktop(desktop))
    return 3;
  int result;
  {
    QApplication app(argc, argv);
    ClipboardTest test;
    result = QTest::qExec(&test, argc, argv);
  }
  SetProcessWindowStation(original);
  CloseDesktop(desktop);
  CloseWindowStation(station);
  return result;
}
#include "clipboard_test.moc"
