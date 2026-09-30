#pragma once
#include <QObject>
#include <QRect>
#include <QScreen>
#include <functional>
namespace Capture {
// Non-interactive display chrome must not become an automatic capture target.
inline constexpr wchar_t DecorationProperty[] = L"Abandon.Capture.Decoration";
struct DesktopTarget {
  quintptr window;
  QRect rect;
};
QRect nativeScreenRect(QScreen *screen);
QRect nativeWorkArea(QScreen *screen);
QRect physicalWindowRect(WId window);
QPoint physicalClientPoint(WId window, QPoint clientPixels);
QVector<DesktopTarget> desktopTargets(QScreen *screen = nullptr);
// Apply native desktop pixels without a second Qt screen/DPI conversion.
bool placePhysicalWindow(WId window, QRect physical);
// False means the worker is busy; the caller may retry its latest position.
bool accessibleTarget(QObject *receiver, quintptr window, QPoint physical,
                      std::function<void(QRect)> callback);
void movePhysicalCursor(QPoint delta);
void movePhysicalWindow(WId window, QPoint delta);
} // namespace Capture
