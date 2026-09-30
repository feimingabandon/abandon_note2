#include "PinHalo.h"
#include "DesktopTargets.h"
#include <QEvent>
#include <QPainter>
#include <QScopedValueRollback>
#include <QTimer>
#include <QWidget>
#include <QWindow>
#include <array>
#include <cmath>
#include <cstring>
#include <windows.h>

namespace Capture {
namespace {
constexpr int extent = 14;
constexpr wchar_t haloClass[] = L"Abandon.Capture.PinHalo";
QRect rectOf(RECT r) {
  return {r.left, r.top, r.right - r.left, r.bottom - r.top};
}
struct Edge {
  HWND window = nullptr;
  HDC dc = nullptr;
  HBITMAP bitmap = nullptr;
  HGDIOBJ previousBitmap = nullptr;
  QSize size;
  QRect relativeContent;
  qreal dpr = 0;
  static LRESULT CALLBACK windowProc(HWND handle, UINT message, WPARAM wparam,
                                     LPARAM lparam) {
    if (message == WM_NCCREATE) {
      const auto creation = reinterpret_cast<CREATESTRUCTW *>(lparam);
      SetWindowLongPtrW(handle, GWLP_USERDATA,
                        reinterpret_cast<LONG_PTR>(creation->lpCreateParams));
    } else if (message == WM_NCDESTROY) {
      // The native owner can destroy owned windows during Qt flag changes.
      // Clear the handle before Windows can recycle it for another window.
      if (auto edge = reinterpret_cast<Edge *>(
              GetWindowLongPtrW(handle, GWLP_USERDATA)))
        edge->window = nullptr;
    }
    return DefWindowProcW(handle, message, wparam, lparam);
  }
  ~Edge() {
    if (IsWindow(window))
      DestroyWindow(window);
    clearSurface();
  }
  void clearSurface() {
    if (dc && previousBitmap)
      SelectObject(dc, previousBitmap);
    if (bitmap)
      DeleteObject(bitmap);
    if (dc)
      DeleteDC(dc);
    bitmap = nullptr;
    dc = nullptr;
    previousBitmap = nullptr;
    size = {};
  }
  void hide() {
    if (IsWindow(window))
      ShowWindow(window, SW_HIDE);
  }
  bool ensureWindow(HWND owner, size_t index) {
    static const ATOM registered = [] {
      WNDCLASSW definition{};
      definition.lpfnWndProc = windowProc;
      definition.hInstance = GetModuleHandleW(nullptr);
      definition.lpszClassName = haloClass;
      return RegisterClassW(&definition);
    }();
    if (!registered)
      return false;
    if (!IsWindow(window)) {
      window =
          CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE |
                              WS_EX_TOOLWINDOW,
                          haloClass, L"Abandon 贴图光晕", WS_POPUP, 0, 0, 1, 1,
                          owner, nullptr, GetModuleHandleW(nullptr), this);
      if (!window)
        return false;
      SetPropW(window, DecorationProperty, reinterpret_cast<HANDLE>(index + 1));
    }
    if (GetWindow(window, GW_OWNER) != owner)
      SetWindowLongPtrW(window, GWLP_HWNDPARENT,
                        reinterpret_cast<LONG_PTR>(owner));
    return true;
  }
  bool surface(QRect bounds, QRect content, qreal ratio) {
    const auto relative = content.translated(-bounds.topLeft());
    if (dc && size == bounds.size() && relativeContent == relative &&
        dpr == ratio)
      return true;
    clearSurface();
    const auto image = renderPinHaloStrip(bounds.size(), relative, ratio);
    if (image.isNull())
      return false;
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = image.width();
    info.bmiHeader.biHeight = -image.height();
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    void *pixels = nullptr;
    dc = CreateCompatibleDC(nullptr);
    bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
    if (!dc || !bitmap || !pixels) {
      clearSurface();
      return false;
    }
    previousBitmap = SelectObject(dc, bitmap);
    std::memcpy(pixels, image.constBits(), image.sizeInBytes());
    size = image.size();
    relativeContent = relative;
    dpr = ratio;
    return true;
  }
};
} // namespace

QImage renderPinHaloStrip(QSize pixels, QRect physicalContent, qreal dpr) {
  QImage image(pixels, QImage::Format_ARGB32_Premultiplied);
  if (image.isNull() || dpr <= 0)
    return {};
  image.fill(Qt::transparent);
  QPainter p(&image);
  p.scale(dpr, dpr);
  p.setRenderHint(QPainter::Antialiasing);
  p.setBrush(Qt::NoBrush);
  const QRectF content(physicalContent.x() / dpr, physicalContent.y() / dpr,
                       physicalContent.width() / dpr,
                       physicalContent.height() / dpr);
  // This blue is display chrome against the desktop, never image ink or an
  // active selection. Native pixel surfaces avoid the second rounding done
  // by Qt's layered QWidget backing store at fractional DPI.
  for (int distance = extent; distance >= 1; --distance) {
    const int alpha = qRound(62 * std::exp(-.5 * std::pow(distance / 4.5, 2)));
    p.setPen(QPen(QColor(72, 142, 224, alpha), 1.25));
    p.drawRoundedRect(
        content.adjusted(-distance, -distance, distance, distance), distance,
        distance);
  }
  p.setPen(QPen(QColor(80, 139, 208, 105), 1));
  p.drawRoundedRect(content.adjusted(-.5, -.5, .5, .5), .5, .5);
  return image;
}
struct PinHalo::State {
  std::array<Edge, 4> edges;
};
PinHalo::PinHalo(QWidget *owner)
    : QObject(owner), owner(owner), state(std::make_unique<State>()) {
  owner->installEventFilter(this);
  sync();
}
PinHalo::~PinHalo() { owner->removeEventFilter(this); }
void PinHalo::hide() {
  for (auto &edge : state->edges)
    edge.hide();
}
qint64 PinHalo::memoryCost() const {
  qint64 bytes = 0;
  for (auto &edge : state->edges)
    bytes += qint64(edge.size.width()) * edge.size.height() * 4;
  return bytes;
}
void PinHalo::sync() {
  if (syncing)
    return;
  QScopedValueRollback<bool> guard(syncing, true);
  if (!owner->isVisible() || owner->isMinimized()) {
    hide();
    return;
  }
  if (observedWindow != owner->windowHandle()) {
    disconnect(opacityConnection);
    disconnect(screenConnection);
    observedWindow = owner->windowHandle();
    if (observedWindow) {
      opacityConnection = connect(observedWindow, &QWindow::opacityChanged,
                                  this, [this] { sync(); });
      screenConnection = connect(observedWindow, &QWindow::screenChanged, this,
                                 [this] { sync(); });
    }
  }
  const auto handle = reinterpret_cast<HWND>(owner->winId());
  RECT physical{};
  if (!GetWindowRect(handle, &physical)) {
    hide();
    return;
  }
  const auto content = rectOf(physical);
  const qreal dpr = owner->devicePixelRatioF();
  const int pixels = qRound(extent * dpr);
  const std::array<QRect, 4> bounds{
      QRect(content.x() - pixels, content.y() - pixels,
            content.width() + 2 * pixels, pixels),
      QRect(content.x() - pixels, content.y() + content.height(),
            content.width() + 2 * pixels, pixels),
      QRect(content.x() - pixels, content.y(), pixels, content.height()),
      QRect(content.x() + content.width(), content.y(), pixels,
            content.height())};
  // Cache only the visible perimeter, even for pins zoomed beyond the screen.
  const QRect desktop(GetSystemMetrics(SM_XVIRTUALSCREEN),
                      GetSystemMetrics(SM_YVIRTUALSCREEN),
                      GetSystemMetrics(SM_CXVIRTUALSCREEN),
                      GetSystemMetrics(SM_CYVIRTUALSCREEN));
  for (size_t i = 0; i < state->edges.size(); ++i) {
    auto &edge = state->edges[i];
    const auto visible = bounds[i].intersected(desktop);
    if (visible.isEmpty() || !edge.ensureWindow(handle, i) ||
        !edge.surface(visible, content, dpr)) {
      edge.hide();
      continue;
    }
    const bool topmost =
        owner->windowFlags().testFlag(Qt::WindowStaysOnTopHint);
    if (bool(GetWindowLongPtrW(edge.window, GWL_EXSTYLE) & WS_EX_TOPMOST) !=
        topmost)
      SetWindowPos(edge.window, topmost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0,
                   0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    POINT destination{visible.x(), visible.y()}, source{};
    SIZE size{visible.width(), visible.height()};
    BLENDFUNCTION blend{AC_SRC_OVER, 0,
                        BYTE(qRound(owner->windowOpacity() * 255)),
                        AC_SRC_ALPHA};
    if (UpdateLayeredWindow(edge.window, nullptr, &destination, &size, edge.dc,
                            &source, 0, &blend, ULW_ALPHA)) {
      if (!IsWindowVisible(edge.window))
        ShowWindow(edge.window, SW_SHOWNOACTIVATE);
    } else
      edge.hide();
  }
}
bool PinHalo::eventFilter(QObject *object, QEvent *event) {
  if (object != owner)
    return false;
  switch (event->type()) {
  case QEvent::Hide:
  case QEvent::Close:
    hide();
    break;
  case QEvent::Show:
  case QEvent::WinIdChange:
    QTimer::singleShot(0, this, [this] { sync(); });
    break;
  case QEvent::Move:
  case QEvent::Resize:
  case QEvent::WindowStateChange:
  case QEvent::DevicePixelRatioChange:
    sync();
    break;
  default:
    break;
  }
  return false;
}
} // namespace Capture
