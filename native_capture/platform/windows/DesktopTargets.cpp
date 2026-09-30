#include "DesktopTargets.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QPointer>
#include <QtGui/qscreen_platform.h>
#include <atomic>
#include <thread>
// clang-format off: Windows COM declarations must precede UIAutomation.
#include <windows.h>
#include <objbase.h>
#include <oleauto.h>
#include <dwmapi.h>
#include <UIAutomation.h>
#include <wrl/client.h>
// clang-format on
using Microsoft::WRL::ComPtr;
namespace Capture {
static QRect rectOf(RECT r) {
  return {r.left, r.top, r.right - r.left, r.bottom - r.top};
}
QRect nativeScreenRect(QScreen *screen) {
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  auto n = screen->nativeInterface<QNativeInterface::QWindowsScreen>();
  return n && GetMonitorInfoW(n->handle(), &info) ? rectOf(info.rcMonitor)
                                                  : QRect();
}
QRect nativeWorkArea(QScreen *screen) {
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  auto n = screen->nativeInterface<QNativeInterface::QWindowsScreen>();
  return n && GetMonitorInfoW(n->handle(), &info) ? rectOf(info.rcWork)
                                                  : QRect();
}
QRect physicalWindowRect(WId window) {
  RECT rect{};
  return GetWindowRect(reinterpret_cast<HWND>(window), &rect) ? rectOf(rect)
                                                              : QRect();
}
QPoint physicalClientPoint(WId window, QPoint clientPixels) {
  POINT point{clientPixels.x(), clientPixels.y()};
  ClientToScreen(reinterpret_cast<HWND>(window), &point);
  return {point.x, point.y};
}
QVector<DesktopTarget> desktopTargets(QScreen *screen) {
  QVector<DesktopTarget> all;
  EnumWindows(
      [](HWND w, LPARAM data) -> BOOL {
        // Snapshot is taken before overlays become visible. Existing pins and
        // their controls should be detected just like any other window.
        if (!IsWindowVisible(w) || IsIconic(w))
          return TRUE;
        if (GetPropW(w, DecorationProperty))
          return TRUE;
        const auto extendedStyle = GetWindowLongPtrW(w, GWL_EXSTYLE);
        // Layered mouse-pass-through windows (e.g. remote-control overlays)
        // can cover the entire desktop above all actual capture targets.
        // WS_EX_TRANSPARENT alone only changes paint order; layered windows
        // that receive input, tool windows and real fullscreen apps stay valid.
        if ((extendedStyle & (WS_EX_LAYERED | WS_EX_TRANSPARENT)) ==
            (WS_EX_LAYERED | WS_EX_TRANSPARENT))
          return TRUE;
        DWORD cloaked = 0;
        DwmGetWindowAttribute(w, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
        if (cloaked)
          return TRUE;
        RECT r{};
        if (FAILED(DwmGetWindowAttribute(w, DWMWA_EXTENDED_FRAME_BOUNDS, &r,
                                         sizeof(r))))
          GetWindowRect(w, &r);
        if (r.right > r.left && r.bottom > r.top)
          reinterpret_cast<QVector<DesktopTarget> *>(data)->push_back(
              {reinterpret_cast<quintptr>(w), rectOf(r)});
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&all));
  if (screen) {
    const auto screenRect = nativeScreenRect(screen);
    all.removeIf([&](auto t) { return !t.rect.intersects(screenRect); });
  }
  return all;
}
bool placePhysicalWindow(WId window, QRect physical) {
  if (physical.isEmpty())
    return false;
  auto hwnd = reinterpret_cast<HWND>(window);
  if (!SetWindowPos(hwnd, nullptr, physical.x(), physical.y(), physical.width(),
                    physical.height(), SWP_NOACTIVATE | SWP_NOZORDER))
    return false;
  RECT actual{};
  return GetWindowRect(hwnd, &actual) && rectOf(actual) == physical;
}
bool accessibleTarget(QObject *receiver, quintptr window, QPoint physical,
                      std::function<void(QRect)> callback) {
  static std::atomic_bool running = false;
  if (running.exchange(true))
    return false;
  QPointer<QObject> guard(receiver);
  // Read rectangles only. Provider calls never block input; one bounded worker
  // leaves manual selection available even when a provider stops responding.
  std::thread([guard, window, physical, callback = std::move(callback)] {
    QRect result;
    QElapsedTimer budget;
    budget.start();
    const auto init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (SUCCEEDED(init)) {
      ComPtr<IUIAutomation> automation;
      if (SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation8, nullptr,
                                     CLSCTX_INPROC_SERVER,
                                     IID_PPV_ARGS(&automation)))) {
        ComPtr<IUIAutomation2> timed;
        if (SUCCEEDED(automation.As(&timed))) {
          timed->put_ConnectionTimeout(150);
          timed->put_TransactionTimeout(150);
        }
        ComPtr<IUIAutomationElement> element;
        ComPtr<IUIAutomationCondition> condition;
        automation->get_ControlViewCondition(&condition);
        automation->ElementFromHandle(reinterpret_cast<HWND>(window), &element);
        // Check between calls too: individual provider timeouts alone can
        // accumulate over a large control tree. A stuck call remains isolated
        // from the GUI; no additional workers are created while it is busy.
        for (int depth = 0; element && depth < 12 && budget.elapsed() < 400;
             ++depth) {
          RECT r{};
          if (SUCCEEDED(element->get_CurrentBoundingRectangle(&r)))
            result = rectOf(r);
          ComPtr<IUIAutomationElementArray> children;
          if (!condition ||
              FAILED(element->FindAll(TreeScope_Children, condition.Get(),
                                      &children)))
            break;
          int count = 0;
          children->get_Length(&count);
          ComPtr<IUIAutomationElement> found;
          for (int i = 0; i < std::min(count, 128) && budget.elapsed() < 400;
               ++i) {
            ComPtr<IUIAutomationElement> child;
            children->GetElement(i, &child);
            if (child && SUCCEEDED(child->get_CurrentBoundingRectangle(&r)) &&
                rectOf(r).contains(physical)) {
              found = child;
              break;
            }
          }
          if (!found)
            break;
          element = found;
        }
      }
      CoUninitialize();
    }
    running = false;
    QMetaObject::invokeMethod(
        QCoreApplication::instance(),
        [guard, result, callback] {
          if (guard)
            callback(result);
        },
        Qt::QueuedConnection);
  }).detach();
  return true;
}
void movePhysicalCursor(QPoint d) {
  POINT p{};
  if (GetCursorPos(&p))
    SetCursorPos(p.x + d.x(), p.y + d.y());
}
void movePhysicalWindow(WId id, QPoint d) {
  RECT r{};
  auto w = reinterpret_cast<HWND>(id);
  if (GetWindowRect(w, &r))
    SetWindowPos(w, nullptr, r.left + d.x(), r.top + d.y(), 0, 0,
                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}
} // namespace Capture
