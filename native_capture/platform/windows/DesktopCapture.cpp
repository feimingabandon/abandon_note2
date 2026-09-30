#include "DesktopCapture.h"
#include "ImageDocument.h"
#include <QBuffer>
#include <QClipboard>
#include <QGuiApplication>
#include <QImageReader>
#include <QtGui/qscreen_platform.h>
#include <cstring>
#include <windows.h>
#include <wtsapi32.h>
namespace Capture {
bool writeClipboardImage(const QImage &source, QString *error) {
  auto image = source.convertToFormat(QImage::Format_ARGB32);
  if (image.isNull() || !validImageSize(image.size())) {
    *error = QStringLiteral("无法复制无效或超大的图片");
    return false;
  }
  const SIZE_T size = sizeof(BITMAPV5HEADER) + SIZE_T(image.sizeInBytes());
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size);
  auto header =
      memory ? static_cast<BITMAPV5HEADER *>(GlobalLock(memory)) : nullptr;
  if (!header) {
    if (memory)
      GlobalFree(memory);
    *error = QStringLiteral("复制图片内存分配失败");
    return false;
  }
  header->bV5Size = sizeof(BITMAPV5HEADER);
  header->bV5Width = image.width();
  header->bV5Height = -image.height();
  header->bV5Planes = 1;
  header->bV5BitCount = 32;
  header->bV5Compression = BI_BITFIELDS;
  header->bV5RedMask = 0x00ff0000;
  header->bV5GreenMask = 0x0000ff00;
  header->bV5BlueMask = 0x000000ff;
  header->bV5AlphaMask = 0xff000000;
  header->bV5CSType = LCS_sRGB;
  std::memcpy(header + 1, image.constBits(), size_t(image.sizeInBytes()));
  GlobalUnlock(memory);
  // A real HWND is required: opening with nullptr then EmptyClipboard would
  // leave no owner, causing SetClipboardData to fail. Data is eagerly published
  // in a system-owned handle, so it survives helper/app exit.
  HWND owner =
      CreateWindowExW(0, L"STATIC", L"Abandon capture clipboard", 0, 0, 0, 0, 0,
                      HWND_MESSAGE, nullptr, nullptr, nullptr);
  bool opened = owner && OpenClipboard(owner);
  bool written =
      opened && EmptyClipboard() && SetClipboardData(CF_DIBV5, memory);
  if (opened)
    CloseClipboard();
  if (owner)
    DestroyWindow(owner);
  if (!written) {
    GlobalFree(memory);
    *error = QStringLiteral("剪贴板暂时不可写，请重试或保存文件");
  }
  return written;
}
bool interactiveDesktopAvailable() {
  LPWSTR buffer = nullptr;
  DWORD bytes = 0;
  if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,
                                   WTS_CURRENT_SESSION, WTSSessionInfoEx,
                                   &buffer, &bytes))
    return false;
  auto info = reinterpret_cast<WTSINFOEXW *>(buffer);
  bool available =
      bytes >= sizeof(WTSINFOEXW) && info->Level == 1 &&
      info->Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_UNLOCK;
  WTSFreeMemory(buffer);
  return available;
}
QImage readClipboardImage(QString *error) {
  if (!OpenClipboard(nullptr)) {
    *error = QStringLiteral("剪贴板暂时被占用，请重试");
    return {};
  }
  // Some browsers publish PNG without a DIB. Decode that exact representation
  // after checking both encoded and decoded bounds, rather than letting Qt pick
  // an unchecked alternate format.
  const UINT pngFormat = RegisterClipboardFormatW(L"PNG");
  if (IsClipboardFormatAvailable(pngFormat)) {
    HANDLE data = GetClipboardData(pngFormat);
    const auto bytes = data ? GlobalSize(data) : 0;
    QByteArray encoded;
    if (bytes && bytes <= 50 * MiB) {
      auto memory = static_cast<const char *>(GlobalLock(data));
      if (memory) {
        encoded = QByteArray(memory, qsizetype(bytes));
        GlobalUnlock(data);
      }
    }
    CloseClipboard();
    QBuffer buffer(&encoded);
    buffer.open(QIODevice::ReadOnly);
    QImageReader reader(&buffer, "PNG");
    if (!encoded.isEmpty() && validImageSize(reader.size())) {
      auto result = reader.read().convertToFormat(QImage::Format_ARGB32);
      if (!result.isNull())
        return result;
    }
    *error = QStringLiteral("剪贴板 PNG 无效或超出图像上限");
    return {};
  }
  bool valid = false;
  QImage decoded;
  UINT format = IsClipboardFormatAvailable(CF_DIBV5) ? CF_DIBV5 : CF_DIB;
  HANDLE data = GetClipboardData(format);
  if (data && GlobalSize(data) >= sizeof(BITMAPINFOHEADER)) {
    auto header = static_cast<BITMAPINFOHEADER *>(GlobalLock(data));
    if (header) {
      auto height = qAbs(qint64(header->biHeight));
      valid = header->biSize >= sizeof(BITMAPINFOHEADER) &&
              header->biWidth > 0 && height > 0 &&
              qint64(header->biWidth) * height <= MaxImageBytes / 4;
      // Decode the common 32-bit representation directly to preserve straight
      // alpha exactly (Qt may round through a premultiplied clipboard surface).
      bool rgb = header->biCompression == BI_RGB;
      bool rgba = false;
      if (header->biSize >= sizeof(BITMAPV5HEADER) &&
          GlobalSize(data) >= sizeof(BITMAPV5HEADER)) {
        auto v5 = reinterpret_cast<BITMAPV5HEADER *>(header);
        rgba = v5->bV5Compression == BI_BITFIELDS &&
               v5->bV5RedMask == 0x00ff0000 && v5->bV5GreenMask == 0x0000ff00 &&
               v5->bV5BlueMask == 0x000000ff && v5->bV5AlphaMask == 0xff000000;
      }
      if (valid && header->biBitCount == 32 && (rgb || rgba) &&
          quint64(header->biSize) + quint64(header->biWidth) * height * 4 <=
              GlobalSize(data)) {
        auto bits = reinterpret_cast<uchar *>(header) + header->biSize;
        QImage view(bits, header->biWidth, int(height),
                    rgba ? QImage::Format_ARGB32 : QImage::Format_RGB32);
        decoded =
            header->biHeight > 0 ? view.mirrored(false, true) : view.copy();
      }
      GlobalUnlock(data);
    }
  }
  CloseClipboard();
  if (!decoded.isNull())
    return decoded;
  if (!valid) {
    *error = QStringLiteral("剪贴板图片无效或解码后超出 128 MiB 上限");
    return {};
  }
  auto image = QGuiApplication::clipboard()->image().convertToFormat(
      QImage::Format_ARGB32);
  if (!validImageSize(image.size())) {
    *error = QStringLiteral("剪贴板图片无法解码");
    return {};
  }
  return image;
}
QImage captureDesktop(QScreen *screen, QString *error) {
  if (!interactiveDesktopAvailable()) {
    *error = QStringLiteral("桌面已锁定或不可访问，请解锁后重新截图");
    return {};
  }
  auto native = screen->nativeInterface<QNativeInterface::QWindowsScreen>();
  MONITORINFO monitor{};
  monitor.cbSize = sizeof(monitor);
  if (!native || !GetMonitorInfoW(native->handle(), &monitor)) {
    *error = QStringLiteral("无法读取显示器配置 %1 (Win32 %2)")
                 .arg(screen->name())
                 .arg(GetLastError());
    return {};
  }
  QSize size(monitor.rcMonitor.right - monitor.rcMonitor.left,
             monitor.rcMonitor.bottom - monitor.rcMonitor.top);
  if (!validImageSize(size)) {
    *error = QStringLiteral("单屏图像超出 128 MiB 上限");
    return {};
  }
  HDC desktop = GetDC(nullptr), memory = CreateCompatibleDC(desktop);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = size.width();
  info.bmiHeader.biHeight = -size.height();
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void *bits = nullptr;
  HBITMAP bitmap =
      CreateDIBSection(desktop, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  HGDIOBJ old = bitmap ? SelectObject(memory, bitmap) : nullptr;
  QImage image;
  if (bitmap && BitBlt(memory, 0, 0, size.width(), size.height(), desktop,
                       monitor.rcMonitor.left, monitor.rcMonitor.top,
                       SRCCOPY | CAPTUREBLT)) {
    image = QImage(size, QImage::Format_RGB32);
    if (!image.isNull())
      std::memcpy(image.bits(), bits, size_t(image.sizeInBytes()));
  } else
    *error = QStringLiteral("无法捕获当前桌面（错误 %1）").arg(GetLastError());
  if (old)
    SelectObject(memory, old);
  if (bitmap)
    DeleteObject(bitmap);
  DeleteDC(memory);
  ReleaseDC(nullptr, desktop);
  return image;
}
} // namespace Capture
