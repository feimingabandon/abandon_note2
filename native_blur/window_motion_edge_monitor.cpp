#include "window_motion_edge_monitor.h"
#include "blur_api.h"
#include "reveal_handle_renderer.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cwchar>
#include <deque>
#include <dwmapi.h>
#include <iterator>
#include <memory>
#include <mutex>
#include <objbase.h>
#include <process.h>
#include <shellapi.h>
#include <windowsx.h>

namespace WindowMotionEdgeMonitor {
namespace {

constexpr DWORD kStopTimeoutMs = 2000;
constexpr DWORD kStopRetryTimeoutMs = 50;
constexpr DWORD kWorkerStartTimeoutMs = 2000;
constexpr DWORD kWorkerStartAbortGraceMs = 100;
constexpr int kCursorFailureLimit = 10;
constexpr int kHandleHorizontalWidthDip = 146;
constexpr int kHandleHorizontalHeightDip = 40;
constexpr int kHandleVerticalWidthDip = 50;
constexpr int kHandleVerticalHeightDip = 112;
constexpr int kHandleHoverToleranceDip = 8;
constexpr int kHandleDragThresholdDip = 4;
constexpr int kHandleDragEdgeInsetDip = 8;
constexpr int kHandlePositionPermilleMax = 1000;
constexpr UINT_PTR kHandleLongPressTimerId = 1;
constexpr ULONGLONG kHandleAppearDurationMs = 220;
constexpr ULONGLONG kHandleRetreatDurationMs = 180;
constexpr ULONGLONG kHandleLeaveDelayMs = 300;
constexpr ULONGLONG kHandleLongPressDurationMs = 350;
constexpr ULONGLONG kFullscreenExitStableMs = 250;
constexpr DWORD kMessagePumpTickMs = 16;
constexpr DWORD kHandleVisualTickMs = 33;
constexpr std::size_t kMaxPendingEvents = 2;
constexpr wchar_t kHandleWindowClass[] = L"AbandonNote.WindowMotion.RevealHandle.v1";

enum class HandlePhase : int {
    Hidden = 0,
    Appearing = 1,
    Ready = 2,
    Retreating = 3,
    Dragging = 4,
};

struct PendingEvent {
    EventKind kind = EventKind::None;
    int side = 0;
    int error = 0;
    std::uint64_t generation = 0;
    int positionPermille = -1;
};

struct Runtime {
    std::mutex lifecycleMutex;
    std::mutex eventMutex;
    std::mutex handleStatusMutex;
    std::atomic<State> state{State::Stopped};
    std::atomic<bool> workerAlive{false};
    std::atomic<std::uint64_t> generation{0};
    std::atomic<ULONGLONG> lastPollTick{0};
    std::atomic<int> lastError{0};
    std::atomic<int> cursorFailureCount{0};
    std::atomic<unsigned int> fullscreenBlockCount{0};
    std::atomic<bool> fullscreenActive{false};
    std::atomic<bool> fullscreenExitPending{false};
    std::atomic<HandlePhase> handlePhase{HandlePhase::Hidden};
    std::atomic<HWND> handleWindow{nullptr};
    std::atomic<bool> handleEnteredOnce{false};
    std::atomic<std::uint64_t> handleVisualFrame{0};
    std::atomic<std::uint64_t> handleVisualElapsedMs{0};
    std::atomic<bool> handleRendererReady{false};
    std::atomic<bool> handleRendererPrewarmed{false};
    std::atomic<bool> handleEmbeddedFontReady{false};
    std::atomic<bool> handlePresented{false};
    std::atomic<std::uint64_t> handlePresentCount{0};
    std::atomic<std::uint64_t> handleWindowCreateCount{0};
    std::atomic<bool> persistentHandleActivated{false};
    std::atomic<bool> handleDragging{false};
    std::atomic<int> persistentHandlePositionPermille{-1};
    std::atomic<int> workerStartupResult{static_cast<int>(Result::Ok)};

    HANDLE stopEvent = nullptr;
    HANDLE readyEvent = nullptr;
    HANDLE workerThread = nullptr;
    HWND notifyWindow = nullptr;
    HMONITOR targetMonitor = nullptr;
    int side = 0;
    int pollIntervalMs = 100;
    int revealMode = static_cast<int>(RevealMode::Direct);
    UINT dpi = 96;
    RECT triggerArea{};
    RECT workArea{};
    RECT handleFinalRect{};
    RECT handleOffscreenRect{};
    RECT handleAnimationStartRect{};
    RECT handleAnimationEndRect{};
    ULONGLONG handleAnimationStartedAt = 0;
    ULONGLONG handleAnimationDurationMs = 0;
    ULONGLONG handleReadyAt = 0;
    ULONGLONG handleLeaveStartedAt = 0;
    bool handleButtonDownInside = false;
    ULONGLONG handlePressStartedAt = 0;
    POINT handlePressCursor{};
    RECT handlePressRect{};
    bool handlePressMoved = false;
    std::unique_ptr<RevealHandleRenderer> handleRenderer;
    ULONGLONG handleVisualLastTick = 0;
    bool eventNotificationPosted = false;
    std::deque<PendingEvent> pendingEvents;
};

Runtime g_runtime;
std::mutex g_handleClassMutex;
bool g_handleClassRegistered = false;

struct HandleStatusSnapshot {
    HandlePhase phase = HandlePhase::Hidden;
    bool presented = false;
};

struct MonitorStatusSnapshot {
    State state = State::Stopped;
    bool fullscreenActive = false;
    bool fullscreenExitPending = false;
};

void StoreHandlePhase(Runtime& runtime, HandlePhase phase) {
    std::lock_guard<std::mutex> lock(runtime.handleStatusMutex);
    runtime.handlePhase.store(phase);
}

void StoreHandlePresented(Runtime& runtime, bool presented) {
    std::lock_guard<std::mutex> lock(runtime.handleStatusMutex);
    runtime.handlePresented.store(presented);
}

void StoreHandleStatus(Runtime& runtime, HandlePhase phase, bool presented) {
    std::lock_guard<std::mutex> lock(runtime.handleStatusMutex);
    runtime.handlePhase.store(phase);
    runtime.handlePresented.store(presented);
}

HandleStatusSnapshot ReadHandleStatus(Runtime& runtime) {
    std::lock_guard<std::mutex> lock(runtime.handleStatusMutex);
    return {runtime.handlePhase.load(), runtime.handlePresented.load()};
}

MonitorStatusSnapshot ReadMonitorStatus(Runtime& runtime) {
    // fullscreenActive 是全屏进入/退出转换的最后发布点。双读保证状态查询不会
    // 把转换前的 state 与转换后的标志拼成一个从未真实存在过的快照。
    for (;;) {
        const bool activeBefore = runtime.fullscreenActive.load();
        const bool exitPendingBefore = runtime.fullscreenExitPending.load();
        const State state = runtime.state.load();
        const bool exitPendingAfter = runtime.fullscreenExitPending.load();
        const bool activeAfter = runtime.fullscreenActive.load();
        if (activeBefore == activeAfter && exitPendingBefore == exitPendingAfter) {
            return {state, activeAfter, exitPendingAfter};
        }
    }
}

bool IsValidSide(int side) {
    return side == -2 || side == -1 || side == 1 || side == 2;
}

bool IsValidRevealMode(int mode) {
    return mode == static_cast<int>(RevealMode::Direct) ||
        mode == static_cast<int>(RevealMode::ClickHandle) ||
        mode == static_cast<int>(RevealMode::PersistentHandle);
}

bool UsesRevealHandle(const Runtime& runtime) {
    return runtime.revealMode == static_cast<int>(RevealMode::ClickHandle) ||
        runtime.revealMode == static_cast<int>(RevealMode::PersistentHandle);
}

bool IsInside(const POINT& point, const RECT& area) {
    return point.x >= area.left && point.x < area.right &&
        point.y >= area.top && point.y < area.bottom;
}

bool IsInsideClient(HWND hwnd, LPARAM lParam) {
    RECT client{};
    if (!GetClientRect(hwnd, &client)) return false;
    const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
    return IsInside(point, client);
}

LONG ScaleDip(int dip, UINT dpi) {
    return std::max<LONG>(1, MulDiv(dip, std::max<UINT>(96, dpi), 96));
}

bool CoversMonitor(const RECT& bounds, const RECT& monitor, LONG tolerance) {
    return bounds.left <= monitor.left + tolerance &&
        bounds.top <= monitor.top + tolerance &&
        bounds.right >= monitor.right - tolerance &&
        bounds.bottom >= monitor.bottom - tolerance;
}

bool IsSystemD3DFullscreenOnTargetMonitor(HWND foreground, HMONITOR targetMonitor) {
    QUERY_USER_NOTIFICATION_STATE state = QUNS_NOT_PRESENT;
    if (FAILED(SHQueryUserNotificationState(&state)) ||
        state != QUNS_RUNNING_D3D_FULL_SCREEN) {
        return false;
    }
    return MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST) == targetMonitor;
}

bool IsForegroundFullscreenOnTargetMonitor(const Runtime& runtime) {
    const HWND foreground = GetForegroundWindow();
    if (!foreground || !IsWindow(foreground) || !IsWindowVisible(foreground) ||
        IsIconic(foreground) || !runtime.targetMonitor) {
        return false;
    }

    if (foreground == GetShellWindow()) return false;
    wchar_t className[64]{};
    if (GetClassNameW(foreground, className, static_cast<int>(std::size(className))) > 0 &&
        (wcscmp(className, L"Progman") == 0 || wcscmp(className, L"WorkerW") == 0 ||
            wcscmp(className, L"Shell_TrayWnd") == 0)) {
        return false;
    }

    DWORD foregroundProcess = 0;
    DWORD notifyProcess = 0;
    GetWindowThreadProcessId(foreground, &foregroundProcess);
    GetWindowThreadProcessId(runtime.notifyWindow, &notifyProcess);
    // 本进程的主窗口、毛玻璃层与原生小黑条均不得阻止唤出。
    if (foregroundProcess && notifyProcess && foregroundProcess == notifyProcess) return false;

    DWORD cloaked = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(
            foreground, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0) {
        return false;
    }

    MONITORINFO monitorInfo{};
    monitorInfo.cbSize = sizeof(monitorInfo);
    if (!GetMonitorInfoW(runtime.targetMonitor, &monitorInfo)) return false;
    // 独占 Direct3D 游戏的前台 HWND 不一定可靠报告完整扩展边界。系统通知
    // 状态只作为几何判定的补充，并继续限制在当前贴边会话所在显示器。
    if (IsSystemD3DFullscreenOnTargetMonitor(foreground, runtime.targetMonitor)) return true;

    RECT foregroundBounds{};
    if (FAILED(DwmGetWindowAttribute(
            foreground, DWMWA_EXTENDED_FRAME_BOUNDS,
            &foregroundBounds, sizeof(foregroundBounds))) &&
        !GetWindowRect(foreground, &foregroundBounds)) {
        return false;
    }

    const LONG_PTR style = GetWindowLongPtrW(foreground, GWL_STYLE);
    const bool hasStandardFrame =
        (style & WS_CAPTION) == WS_CAPTION && (style & WS_THICKFRAME) == WS_THICKFRAME;
    if (IsZoomed(foreground) && hasStandardFrame) return false;

    const UINT dpi = std::max<UINT>(96, GetDpiForWindow(foreground));
    const LONG tolerance = std::max<LONG>(2, MulDiv(2, dpi, 96));
    return CoversMonitor(foregroundBounds, monitorInfo.rcMonitor, tolerance);
}

bool HasPendingEvent(Runtime& runtime) {
    std::lock_guard<std::mutex> lock(runtime.eventMutex);
    return !runtime.pendingEvents.empty();
}

void TryNotifyPendingEvent(Runtime& runtime) {
    std::lock_guard<std::mutex> lock(runtime.eventMutex);
    if (runtime.pendingEvents.empty() || runtime.eventNotificationPosted) return;
    if (runtime.notifyWindow && IsWindow(runtime.notifyWindow) &&
        PostMessageW(runtime.notifyWindow, GetMessageId(), 0, 0)) {
        runtime.eventNotificationPosted = true;
    }
}

void QueueEvent(Runtime& runtime, EventKind kind, int error) {
    bool queued = false;
    {
        std::lock_guard<std::mutex> lock(runtime.eventMutex);
        if (runtime.pendingEvents.size() >= kMaxPendingEvents) {
            const auto moved = std::find_if(
                runtime.pendingEvents.begin(), runtime.pendingEvents.end(),
                [](const PendingEvent& event) { return event.kind == EventKind::HandleMoved; });
            if (moved != runtime.pendingEvents.end()) runtime.pendingEvents.erase(moved);
        }
        if (runtime.pendingEvents.size() < kMaxPendingEvents) {
            const bool wasEmpty = runtime.pendingEvents.empty();
            runtime.pendingEvents.push_back(
                {kind, runtime.side, error, runtime.generation.load(), -1});
            if (wasEmpty) runtime.eventNotificationPosted = false;
            queued = true;
        }
    }
    runtime.lastError.store(error);
    runtime.state.store(kind == EventKind::Trigger ? State::TriggerPending : State::Failed);
    if (queued) TryNotifyPendingEvent(runtime);
}

void QueueHandleMovedEvent(Runtime& runtime, int positionPermille) {
    bool queued = false;
    {
        std::lock_guard<std::mutex> lock(runtime.eventMutex);
        const PendingEvent next = {
            EventKind::HandleMoved,
            runtime.side,
            0,
            runtime.generation.load(),
            std::clamp(positionPermille, 0, kHandlePositionPermilleMax)};
        const auto existing = std::find_if(
            runtime.pendingEvents.begin(), runtime.pendingEvents.end(),
            [](const PendingEvent& event) { return event.kind == EventKind::HandleMoved; });
        if (existing != runtime.pendingEvents.end()) {
            *existing = next;
            queued = true;
        } else if (runtime.pendingEvents.size() < kMaxPendingEvents) {
            const bool wasEmpty = runtime.pendingEvents.empty();
            runtime.pendingEvents.push_back(next);
            if (wasEmpty) runtime.eventNotificationPosted = false;
            queued = true;
        }
    }
    if (queued) TryNotifyPendingEvent(runtime);
}

bool UpdatePersistentHandleDrag(Runtime& runtime, const POINT& cursor);
int GetPersistentHandlePositionPermille(const Runtime& runtime);

void ResetHandlePress(Runtime& runtime) {
    const HWND hwnd = runtime.handleWindow.load();
    if (hwnd && IsWindow(hwnd)) KillTimer(hwnd, kHandleLongPressTimerId);
    runtime.handleButtonDownInside = false;
    runtime.handlePressStartedAt = 0;
    runtime.handlePressCursor = {};
    runtime.handlePressRect = {};
    runtime.handlePressMoved = false;
    runtime.handleDragging.store(false);
}

HFONT CreateHandleLabelFont(Runtime& runtime, int sizeDip, int weight) {
    const int labelFontPx = ScaleDip(sizeDip, runtime.dpi);
    return CreateFontW(
        -labelFontPx, 0, 0, 0, weight, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Microsoft YaHei UI");
}

bool PaintHandleText(
    HDC dc, Runtime& runtime, const wchar_t* text, RECT rect,
    int sizeDip, int weight, COLORREF color) {
    HFONT labelFont = CreateHandleLabelFont(runtime, sizeDip, weight);
    HGDIOBJ labelFontToUse = labelFont
        ? static_cast<HGDIOBJ>(labelFont)
        : GetStockObject(DEFAULT_GUI_FONT);
    HGDIOBJ previousFont = SelectObject(dc, labelFontToUse);
    const bool fontSelected = previousFont && previousFont != HGDI_ERROR;
    COLORREF previousColor = CLR_INVALID;
    int drawnHeight = 0;
    bool colorRestored = false;
    if (fontSelected) {
        previousColor = SetTextColor(dc, color);
        if (previousColor != CLR_INVALID) {
            drawnHeight = DrawTextW(dc, text, -1, &rect,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            colorRestored = SetTextColor(dc, previousColor) != CLR_INVALID;
        }
    }
    const bool fontRestored = !fontSelected ||
        (SelectObject(dc, previousFont) != nullptr && GetCurrentObject(dc, OBJ_FONT) == previousFont);
    const bool fontDeleted = !labelFont || DeleteObject(labelFont) != FALSE;
    return fontSelected && previousColor != CLR_INVALID && drawnHeight > 0 && colorRestored &&
        fontRestored && fontDeleted;
}

bool PaintHandleLabel(HDC dc, Runtime& runtime, const RECT& client) {
    if (runtime.side == -1 || runtime.side == 1) {
        const int width = client.right - client.left;
        RECT firstLine{0, ScaleDip(49, runtime.dpi), width, ScaleDip(69, runtime.dpi)};
        RECT secondLine{0, ScaleDip(68, runtime.dpi), width, ScaleDip(88, runtime.dpi)};
        const bool firstLinePainted = PaintHandleText(dc, runtime, L"\x70b9\x51fb", firstLine,
            11, FW_SEMIBOLD, RGB(243, 244, 246));
        const bool secondLinePainted = PaintHandleText(dc, runtime, L"\x5c55\x5f00", secondLine,
            11, FW_SEMIBOLD, RGB(243, 244, 246));
        return firstLinePainted && secondLinePainted;
    } else {
        RECT action{ScaleDip(45, runtime.dpi), 0,
            client.right - ScaleDip(10, runtime.dpi), client.bottom};
        return PaintHandleText(dc, runtime, L"\x70b9\x51fb\x5c55\x5f00", action,
            11, FW_SEMIBOLD, RGB(243, 244, 246));
    }
}

bool PaintHandleFallback(HDC dc, Runtime& runtime, HWND hwnd) {
    if (!dc) return false;
    RECT client{};
    if (!GetClientRect(hwnd, &client) || client.right <= client.left ||
        client.bottom <= client.top) {
        return false;
    }
    HBRUSH background = CreateSolidBrush(RGB(18, 19, 21));
    if (!background) return false;
    const bool backgroundPainted = FillRect(dc, &client, background) != 0;
    const bool backgroundDeleted = DeleteObject(background) != FALSE;

    const int previousBackgroundMode = SetBkMode(dc, TRANSPARENT);
    const bool labelPainted = previousBackgroundMode != 0 &&
        PaintHandleLabel(dc, runtime, client);
    const bool backgroundModeRestored = previousBackgroundMode != 0 &&
        SetBkMode(dc, previousBackgroundMode) != 0;
    const bool flushed = GdiFlush() != FALSE;
    return backgroundPainted && backgroundDeleted && labelPainted &&
        backgroundModeRestored && flushed;
}

bool EnableHandleFallbackSurface(HWND hwnd) {
    SetLastError(ERROR_SUCCESS);
    const LONG_PTR extendedStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if (extendedStyle == 0 && GetLastError() != ERROR_SUCCESS) return false;
    SetLastError(ERROR_SUCCESS);
    const LONG_PTR previousWithoutLayered = SetWindowLongPtrW(
        hwnd, GWL_EXSTYLE, extendedStyle & ~WS_EX_LAYERED);
    if (previousWithoutLayered == 0 && GetLastError() != ERROR_SUCCESS) return false;
    SetLastError(ERROR_SUCCESS);
    const LONG_PTR previousWithLayered = SetWindowLongPtrW(
        hwnd, GWL_EXSTYLE, extendedStyle | WS_EX_LAYERED);
    if (previousWithLayered == 0 && GetLastError() != ERROR_SUCCESS) return false;
    return SetLayeredWindowAttributes(hwnd, 0, 244, LWA_ALPHA) != FALSE;
}

LRESULT CALLBACK HandleWndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    Runtime* runtime = reinterpret_cast<Runtime*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
        runtime = static_cast<Runtime*>(create->lpCreateParams);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(runtime));
    }
    if (!runtime) return DefWindowProcW(hwnd, message, wParam, lParam);

    switch (message) {
    case WM_ERASEBKGND:
        return 1;
    case WM_PAINT: {
        PAINTSTRUCT paint{};
        HDC paintDc = BeginPaint(hwnd, &paint);
        if (runtime->handleRenderer && runtime->handleRenderer->Paint(
                hwnd, runtime->side, runtime->dpi,
                runtime->handleVisualElapsedMs.load(),
                runtime->revealMode != static_cast<int>(RevealMode::PersistentHandle))) {
            const bool paintEnded = paintDc && EndPaint(hwnd, &paint) != FALSE;
            StoreHandlePresented(*runtime, paintEnded);
            if (paintEnded) runtime->handlePresentCount.fetch_add(1);
            return 0;
        }
        bool fallbackSurfaceReady = true;
        if (runtime->handleRenderer) {
            runtime->handleRenderer.reset();
            runtime->handleRendererReady.store(false);
            runtime->handleRendererPrewarmed.store(false);
            runtime->handleEmbeddedFontReady.store(false);
            fallbackSurfaceReady = EnableHandleFallbackSurface(hwnd);
        }
        const bool fallbackPainted = fallbackSurfaceReady && paintDc &&
            PaintHandleFallback(paintDc, *runtime, hwnd);
        const bool paintEnded = paintDc && EndPaint(hwnd, &paint) != FALSE;
        const bool fallbackPresented = fallbackPainted && paintEnded;
        StoreHandlePresented(*runtime, fallbackPresented);
        if (fallbackPresented) {
            runtime->handlePresentCount.fetch_add(1);
        }
        return 0;
    }
    case WM_MOUSEACTIVATE:
        return MA_NOACTIVATE;
    case WM_NCHITTEST:
        return HTCLIENT;
    case WM_LBUTTONDOWN:
        // 按住时完成动画不算一次点击；必须在 Ready 后发生新的完整按下/释放。
        if (runtime->handlePhase.load() == HandlePhase::Ready && IsInsideClient(hwnd, lParam)) {
            runtime->handleButtonDownInside = true;
            runtime->handlePressStartedAt = GetTickCount64();
            runtime->handlePressMoved = false;
            GetCursorPos(&runtime->handlePressCursor);
            GetWindowRect(hwnd, &runtime->handlePressRect);
            SetCapture(hwnd);
            if (runtime->revealMode == static_cast<int>(RevealMode::PersistentHandle)) {
                SetTimer(hwnd, kHandleLongPressTimerId,
                    static_cast<UINT>(kHandleLongPressDurationMs), nullptr);
            }
        }
        return 0;
    case WM_MOUSEMOVE:
        if (runtime->revealMode == static_cast<int>(RevealMode::PersistentHandle) &&
            runtime->handleButtonDownInside && GetCapture() == hwnd) {
            POINT cursor{};
            if (!GetCursorPos(&cursor)) return 0;
            const LONG threshold = ScaleDip(kHandleDragThresholdDip, runtime->dpi);
            const LONG distance = std::max(
                std::abs(cursor.x - runtime->handlePressCursor.x),
                std::abs(cursor.y - runtime->handlePressCursor.y));
            if (distance >= threshold) runtime->handlePressMoved = true;
            const ULONGLONG heldFor = GetTickCount64() - runtime->handlePressStartedAt;
            if (!runtime->handleDragging.load() && runtime->handlePressMoved &&
                heldFor >= kHandleLongPressDurationMs) {
                runtime->handleDragging.store(true);
                StoreHandlePhase(*runtime, HandlePhase::Dragging);
                KillTimer(hwnd, kHandleLongPressTimerId);
            }
            if (runtime->handleDragging.load() && !UpdatePersistentHandleDrag(*runtime, cursor)) {
                QueueEvent(*runtime, EventKind::Fault, static_cast<int>(GetLastError()));
            }
        }
        return 0;
    case WM_TIMER:
        if (wParam == kHandleLongPressTimerId) {
            KillTimer(hwnd, kHandleLongPressTimerId);
            if (runtime->revealMode == static_cast<int>(RevealMode::PersistentHandle) &&
                runtime->handleButtonDownInside && runtime->handlePressMoved &&
                GetCapture() == hwnd) {
                runtime->handleDragging.store(true);
                StoreHandlePhase(*runtime, HandlePhase::Dragging);
                POINT cursor{};
                if (!GetCursorPos(&cursor) || !UpdatePersistentHandleDrag(*runtime, cursor)) {
                    QueueEvent(*runtime, EventKind::Fault, static_cast<int>(GetLastError()));
                }
            }
            return 0;
        }
        return DefWindowProcW(hwnd, message, wParam, lParam);
    case WM_LBUTTONUP: {
        POINT releaseCursor{};
        GetCursorPos(&releaseCursor);
        const ULONGLONG heldFor = runtime->handlePressStartedAt
            ? GetTickCount64() - runtime->handlePressStartedAt
            : 0;
        const bool wasDragging = runtime->handleDragging.load();
        if (wasDragging && !UpdatePersistentHandleDrag(*runtime, releaseCursor)) {
            QueueEvent(*runtime, EventKind::Fault, static_cast<int>(GetLastError()));
        }
        const bool completeClick =
            runtime->handlePhase.load() == HandlePhase::Ready &&
            runtime->handleButtonDownInside && !runtime->handlePressMoved &&
            heldFor < kHandleLongPressDurationMs && IsInsideClient(hwnd, lParam);
        const int movedPositionPermille = wasDragging
            ? GetPersistentHandlePositionPermille(*runtime)
            : -1;
        if (wasDragging) {
            runtime->persistentHandlePositionPermille.store(movedPositionPermille);
        }
        if (wasDragging) StoreHandlePhase(*runtime, HandlePhase::Ready);
        ResetHandlePress(*runtime);
        if (GetCapture() == hwnd) ReleaseCapture();
        if (wasDragging) {
            QueueHandleMovedEvent(*runtime, movedPositionPermille);
        } else if (completeClick) {
            if (runtime->revealMode == static_cast<int>(RevealMode::PersistentHandle)) {
                // 事件被主进程消费到 Disarm 之间存在极短窗口；先撤销常显意图，
                // 防止 worker 在 pendingEvent 刚被消费时把确认条重新创建出来。
                runtime->persistentHandleActivated.store(false);
            }
            StoreHandleStatus(*runtime, HandlePhase::Hidden, false);
            ShowWindow(hwnd, SW_HIDE);
            QueueEvent(*runtime, EventKind::Trigger, 0);
            // 点击确认后主进程会立即结束本轮贴边会话；这里沿用已验证的关闭
            // 路径，普通退场才把 HWND 停在屏外供下一次触边复用。
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        return 0;
    }
    case WM_CAPTURECHANGED:
        if (runtime->handlePhase.load() == HandlePhase::Dragging) {
            StoreHandlePhase(*runtime, HandlePhase::Ready);
        }
        ResetHandlePress(*runtime);
        return 0;
    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;
    case WM_NCDESTROY:
        // D2D DCRenderTarget 只绑定内存 DC 与尺寸，不绑定某个 HWND。
        // 保留预热表面，避免同一贴边会话再次触边时重建位图与字形缓存。
        if (runtime->handleWindow.load() == hwnd) runtime->handleWindow.store(nullptr);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        return DefWindowProcW(hwnd, message, wParam, lParam);
    default:
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
}

bool EnsureHandleWindowClass() {
    std::lock_guard<std::mutex> lock(g_handleClassMutex);
    if (g_handleClassRegistered) return true;

    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = HandleWndProc;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32649));
    windowClass.lpszClassName = kHandleWindowClass;
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    const ATOM atom = RegisterClassExW(&windowClass);
    if (!atom && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
    g_handleClassRegistered = true;
    return true;
}

void DestroyHandleWindow(Runtime& runtime) {
    HWND hwnd = runtime.handleWindow.exchange(nullptr);
    StoreHandleStatus(runtime, HandlePhase::Hidden, false);
    runtime.handleEnteredOnce.store(false);
    runtime.handleAnimationStartedAt = 0;
    runtime.handleAnimationDurationMs = 0;
    runtime.handleReadyAt = 0;
    runtime.handleLeaveStartedAt = 0;
    ResetHandlePress(runtime);
    runtime.handleVisualLastTick = 0;
    runtime.handleVisualFrame.store(0);
    runtime.handleVisualElapsedMs.store(0);
    runtime.handlePresentCount.store(0);
    if (hwnd && IsWindow(hwnd)) DestroyWindow(hwnd);
}

void ResetParkedHandleState(Runtime& runtime) {
    StoreHandleStatus(runtime, HandlePhase::Hidden, false);
    runtime.handleEnteredOnce.store(false);
    runtime.handleAnimationStartedAt = 0;
    runtime.handleAnimationDurationMs = 0;
    runtime.handleReadyAt = 0;
    runtime.handleLeaveStartedAt = 0;
    ResetHandlePress(runtime);
    runtime.handleVisualLastTick = 0;
}

bool ParkHandleWindow(Runtime& runtime) {
    HWND hwnd = runtime.handleWindow.load();
    if (!hwnd || !IsWindow(hwnd)) return false;
    if (GetCapture() == hwnd) ReleaseCapture();
    const RECT& parked = runtime.handleOffscreenRect;
    if (!SetWindowPos(hwnd, HWND_TOPMOST, parked.left, parked.top, 0, 0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)) {
        return false;
    }
    ResetParkedHandleState(runtime);
    return true;
}

SIZE GetHandlePixelSize(const Runtime& runtime) {
    const bool vertical = runtime.side == -1 || runtime.side == 1;
    return {
        std::min<LONG>(ScaleDip(
            vertical ? kHandleVerticalWidthDip : kHandleHorizontalWidthDip,
            runtime.dpi), runtime.workArea.right - runtime.workArea.left),
        std::min<LONG>(ScaleDip(
            vertical ? kHandleVerticalHeightDip : kHandleHorizontalHeightDip,
            runtime.dpi), runtime.workArea.bottom - runtime.workArea.top)
    };
}

void SetHandleRects(Runtime& runtime, LONG finalX, LONG finalY, const SIZE& handleSize) {
    runtime.handleFinalRect = {
        finalX,
        finalY,
        finalX + handleSize.cx,
        finalY + handleSize.cy};
    runtime.handleOffscreenRect = runtime.handleFinalRect;
    if (runtime.side == -1) OffsetRect(&runtime.handleOffscreenRect, -handleSize.cx, 0);
    else if (runtime.side == 1) OffsetRect(&runtime.handleOffscreenRect, handleSize.cx, 0);
    else if (runtime.side == -2) OffsetRect(&runtime.handleOffscreenRect, 0, -handleSize.cy);
    else OffsetRect(&runtime.handleOffscreenRect, 0, handleSize.cy);
}

void GetHandleDragAxisBounds(
    const Runtime& runtime, const SIZE& handleSize, LONG& minimum, LONG& maximum) {
    const bool vertical = runtime.side == -1 || runtime.side == 1;
    const LONG workStart = vertical ? runtime.workArea.top : runtime.workArea.left;
    const LONG workEnd = vertical ? runtime.workArea.bottom : runtime.workArea.right;
    const LONG handleLength = vertical ? handleSize.cy : handleSize.cx;
    const LONG availableTravel = std::max<LONG>(0, workEnd - workStart - handleLength);
    const LONG inset = std::min<LONG>(ScaleDip(kHandleDragEdgeInsetDip, runtime.dpi),
        availableTravel / 2);
    minimum = workStart + inset;
    maximum = workEnd - handleLength - inset;
}

LONG HandlePositionFromPermille(const Runtime& runtime, const SIZE& handleSize, int permille) {
    LONG minimum = 0;
    LONG maximum = 0;
    GetHandleDragAxisBounds(runtime, handleSize, minimum, maximum);
    const double progress = static_cast<double>(
        std::clamp(permille, 0, kHandlePositionPermilleMax)) / kHandlePositionPermilleMax;
    return minimum + static_cast<LONG>(std::llround((maximum - minimum) * progress));
}

int GetPersistentHandlePositionPermille(const Runtime& runtime) {
    const SIZE handleSize = GetHandlePixelSize(runtime);
    LONG minimum = 0;
    LONG maximum = 0;
    GetHandleDragAxisBounds(runtime, handleSize, minimum, maximum);
    if (maximum <= minimum) return kHandlePositionPermilleMax / 2;
    const bool vertical = runtime.side == -1 || runtime.side == 1;
    const LONG position = vertical ? runtime.handleFinalRect.top : runtime.handleFinalRect.left;
    return std::clamp(static_cast<int>(std::llround(
        static_cast<double>(position - minimum) * kHandlePositionPermilleMax /
        static_cast<double>(maximum - minimum))), 0, kHandlePositionPermilleMax);
}

bool UpdatePersistentHandleDrag(Runtime& runtime, const POINT& cursor) {
    HWND hwnd = runtime.handleWindow.load();
    if (!hwnd || !IsWindow(hwnd)) {
        SetLastError(ERROR_INVALID_WINDOW_HANDLE);
        return false;
    }
    const SIZE handleSize = GetHandlePixelSize(runtime);
    LONG minimum = 0;
    LONG maximum = 0;
    GetHandleDragAxisBounds(runtime, handleSize, minimum, maximum);
    const bool vertical = runtime.side == -1 || runtime.side == 1;
    const LONG grabOffset = vertical
        ? runtime.handlePressCursor.y - runtime.handlePressRect.top
        : runtime.handlePressCursor.x - runtime.handlePressRect.left;
    const LONG axisPosition = std::clamp<LONG>(
        (vertical ? cursor.y : cursor.x) - grabOffset, minimum, maximum);
    const LONG finalX = vertical
        ? (runtime.side == -1 ? runtime.workArea.left : runtime.workArea.right - handleSize.cx)
        : axisPosition;
    const LONG finalY = vertical
        ? axisPosition
        : (runtime.side == -2 ? runtime.workArea.top : runtime.workArea.bottom - handleSize.cy);
    if (!SetWindowPos(hwnd, HWND_TOPMOST, finalX, finalY, 0, 0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)) {
        return false;
    }
    SetHandleRects(runtime, finalX, finalY, handleSize);
    return true;
}

void PositionHandleAtTouch(Runtime& runtime, const POINT& touch) {
    const RECT& work = runtime.workArea;
    const bool vertical = runtime.side == -1 || runtime.side == 1;
    const SIZE handleSize = GetHandlePixelSize(runtime);
    const LONG width = handleSize.cx;
    const LONG height = handleSize.cy;

    LONG finalX = work.left;
    LONG finalY = work.top;
    const int configuredPosition = runtime.persistentHandlePositionPermille.load();
    if (runtime.revealMode == static_cast<int>(RevealMode::PersistentHandle) &&
        configuredPosition >= 0) {
        const LONG axisPosition = HandlePositionFromPermille(
            runtime, handleSize, configuredPosition);
        if (vertical) {
            finalX = runtime.side == -1 ? work.left : work.right - width;
            finalY = axisPosition;
        } else {
            finalX = axisPosition;
            finalY = runtime.side == -2 ? work.top : work.bottom - height;
        }
    } else if (vertical) {
        finalX = runtime.side == -1 ? work.left : work.right - width;
        const LONG reachableTop = std::max(work.top, runtime.triggerArea.top);
        const LONG reachableBottom = std::min(work.bottom, runtime.triggerArea.bottom);
        finalY = reachableBottom - reachableTop >= height
            ? std::clamp<LONG>(touch.y - height / 2, reachableTop, reachableBottom - height)
            : std::clamp<LONG>(touch.y - height / 2, work.top, work.bottom - height);
    } else {
        finalY = runtime.side == -2 ? work.top : work.bottom - height;
        const LONG reachableLeft = std::max(work.left, runtime.triggerArea.left);
        const LONG reachableRight = std::min(work.right, runtime.triggerArea.right);
        finalX = reachableRight - reachableLeft >= width
            ? std::clamp<LONG>(touch.x - width / 2, reachableLeft, reachableRight - width)
            : std::clamp<LONG>(touch.x - width / 2, work.left, work.right - width);
    }

    SetHandleRects(runtime, finalX, finalY, handleSize);
}

POINT GetDefaultHandleAnchor(const Runtime& runtime) {
    return {
        runtime.triggerArea.left + (runtime.triggerArea.right - runtime.triggerArea.left) / 2,
        runtime.triggerArea.top + (runtime.triggerArea.bottom - runtime.triggerArea.top) / 2
    };
}

ULONGLONG ScaledAnimationDuration(
    const RECT& start, const RECT& finish, const RECT& fullStart, const RECT& fullFinish,
    ULONGLONG fullDuration) {
    const LONG distance = std::abs(finish.left - start.left) + std::abs(finish.top - start.top);
    const LONG fullDistance = std::max<LONG>(1,
        std::abs(fullFinish.left - fullStart.left) +
        std::abs(fullFinish.top - fullStart.top));
    return std::max<ULONGLONG>(1,
        static_cast<ULONGLONG>(std::llround(
            static_cast<double>(fullDuration) * distance / fullDistance)));
}

void BeginHandleAnimation(
    Runtime& runtime, HandlePhase phase, const RECT& start, const RECT& finish,
    ULONGLONG fullDuration, ULONGLONG now) {
    runtime.handleAnimationStartRect = start;
    runtime.handleAnimationEndRect = finish;
    runtime.handleAnimationStartedAt = now;
    runtime.handleAnimationDurationMs = ScaledAnimationDuration(
        start, finish, runtime.handleOffscreenRect, runtime.handleFinalRect, fullDuration);
    StoreHandlePhase(runtime, phase);
    runtime.handleButtonDownInside = false;
}

bool PrimeHandleWindow(Runtime& runtime, const POINT& touch) {
    PositionHandleAtTouch(runtime, touch);
    const RECT start = runtime.handleOffscreenRect;
    const int width = start.right - start.left;
    const int height = start.bottom - start.top;
    HWND hwnd = runtime.handleWindow.load();
    if (hwnd && IsWindow(hwnd)) {
        if (!SetWindowPos(hwnd, HWND_TOPMOST, start.left, start.top, 0, 0,
                SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)) {
            return false;
        }
        ResetParkedHandleState(runtime);
        return true;
    }

    runtime.handleWindow.store(nullptr);
    hwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
        kHandleWindowClass, L"Abandon Note \x5c55\x5f00", WS_POPUP,
        start.left, start.top, width, height,
        nullptr, nullptr, GetModuleHandleW(nullptr), &runtime);
    if (!hwnd) return false;

    runtime.handleWindow.store(hwnd);
    runtime.handleReadyAt = 0;
    runtime.handleLeaveStartedAt = 0;
    runtime.handleEnteredOnce.store(false);
    runtime.handleVisualLastTick = 0;
    if ((!runtime.handleRenderer && !EnableHandleFallbackSurface(hwnd)) ||
        !SetWindowPos(hwnd, HWND_TOPMOST, start.left, start.top, width, height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW)) {
        DestroyWindow(hwnd);
        return false;
    }
    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    if (!IsWindowVisible(hwnd)) {
        DestroyWindow(hwnd);
        return false;
    }
    UpdateWindow(hwnd);
    // UpdateWindow 只保证 WM_PAINT 已处理，不保证新的 layered HWND 已进入一次
    // 桌面合成。布防阶段只在这里等待一次 DWM，后续每帧移动不再阻塞。
    DwmFlush();
    runtime.handleWindowCreateCount.fetch_add(1);
    ResetParkedHandleState(runtime);
    return true;
}

bool PresentHandleWindow(Runtime& runtime, HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) return false;
    StoreHandlePresented(runtime, false);
    bool presented = false;
    if (runtime.handleRenderer) {
        presented = runtime.handleRenderer->Paint(
            hwnd, runtime.side, runtime.dpi, runtime.handleVisualElapsedMs.load(), false);
        if (!presented) {
            runtime.handleRenderer.reset();
            runtime.handleRendererReady.store(false);
            runtime.handleRendererPrewarmed.store(false);
            runtime.handleEmbeddedFontReady.store(false);
        }
    }
    if (!presented) {
        if (!EnableHandleFallbackSurface(hwnd)) return false;
        HDC windowDc = GetDC(hwnd);
        if (!windowDc) return false;
        const bool painted = PaintHandleFallback(windowDc, runtime, hwnd);
        const bool released = ReleaseDC(hwnd, windowDc) != 0;
        presented = painted && released;
    }
    if (!presented) return false;
    // 直接呈现后清掉可能残留的无效区域，避免常显模式随后收到一次无意义的
    // WM_PAINT；静态模式只在状态切换时提交，不恢复周期重绘。
    ValidateRect(hwnd, nullptr);
    StoreHandlePresented(runtime, true);
    runtime.handlePresentCount.fetch_add(1);
    DwmFlush();
    return true;
}

bool RevealPrimedHandle(Runtime& runtime, const POINT& touch) {
    if (!PrimeHandleWindow(runtime, touch)) return false;
    HWND hwnd = runtime.handleWindow.load();
    if (!hwnd || !IsWindow(hwnd)) {
        return false;
    }
    if (runtime.revealMode == static_cast<int>(RevealMode::PersistentHandle)) {
        // 常显入口不再依靠绿色圆环的 33ms 重绘维持画面，因此每次从屏外恢复时
        // 必须同步确认一次真正的像素提交。IsWindowVisible 只代表 HWND 样式可见，
        // 不能证明 layered window 已经通过 UpdateLayeredWindow 呈现了内容。
        if (!PresentHandleWindow(runtime, hwnd)) return false;
    } else {
        // 触边确认保留原有绘制语义；其绿色圆环会继续提供后续重绘。
        if (!RedrawWindow(hwnd, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW)) return false;
        DwmFlush();
    }
    // 先把同一个 HWND、鼠标对应的屏外坐标和当前画面提交给 DWM，
    // 再从下一次消息循环开始滑出，避免重定位与首个位移被合并成一次可见跳变。
    const RECT start = runtime.handleOffscreenRect;
    const ULONGLONG now = GetTickCount64();
    runtime.handleVisualLastTick = now;
    runtime.handleVisualFrame.fetch_add(1);
    BeginHandleAnimation(runtime, HandlePhase::Appearing, start, runtime.handleFinalRect,
        kHandleAppearDurationMs, now);
    return true;
}

bool IsCursorNearHandle(const Runtime& runtime, const POINT& cursor);
void ReverseHandleRetreat(Runtime& runtime, ULONGLONG now);

void UpdateHandleAnimation(Runtime& runtime, ULONGLONG now) {
    const HandlePhase phase = runtime.handlePhase.load();
    if (phase != HandlePhase::Appearing && phase != HandlePhase::Retreating) return;
    HWND hwnd = runtime.handleWindow.load();
    if (!hwnd || !IsWindow(hwnd)) {
        QueueEvent(runtime, EventKind::Fault,
            static_cast<int>(Result::HandleWindowCreateFailed));
        return;
    }

    if (phase == HandlePhase::Retreating) {
        // 退场仅 180ms，不能依赖 50ms 主轮询判断重入；动画节拍内直接采样，
        // 避免光标在两次轮询之间重新进入时 HWND 已先滑完并销毁。
        POINT cursor{};
        if (GetCursorPos(&cursor) &&
            (IsInside(cursor, runtime.triggerArea) || IsCursorNearHandle(runtime, cursor))) {
            ReverseHandleRetreat(runtime, now);
            return;
        }
    }

    const double raw = static_cast<double>(now - runtime.handleAnimationStartedAt) /
        static_cast<double>(std::max<ULONGLONG>(1, runtime.handleAnimationDurationMs));
    const double progress = std::clamp(raw, 0.0, 1.0);
    // 短距离原生窗口如果使用 ease-out cubic，首个 16ms 就会跨过约四分之一
    // 路程，看起来像瞬间出现。双向统一为 ease-in-out quad，保证首尾都有
    // 可见的渐进位移，反向动画也保持一致的运动感受。
    const double eased = progress < 0.5
        ? 2.0 * progress * progress
        : 1.0 - std::pow(-2.0 * progress + 2.0, 2.0) / 2.0;
    const RECT start = runtime.handleAnimationStartRect;
    const RECT finish = runtime.handleAnimationEndRect;
    const int x = static_cast<int>(std::lround(start.left + (finish.left - start.left) * eased));
    const int y = static_cast<int>(std::lround(start.top + (finish.top - start.top) * eased));
    if (!SetWindowPos(hwnd, HWND_TOPMOST, x, y, 0, 0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)) {
        QueueEvent(runtime, EventKind::Fault, static_cast<int>(GetLastError()));
        return;
    }

    if (progress >= 1.0) {
        if (phase == HandlePhase::Appearing) {
            if (runtime.revealMode == static_cast<int>(RevealMode::PersistentHandle)) {
                // layered surface 在屏外预热成功并不等于移动到最终屏幕位置后仍已
                // 合成。常显模式没有周期重绘，在终点再做一次一次性提交；失败时
                // 走故障恢复，不能留下一个“HWND 可见但像素透明”的假健康状态。
                if (!PresentHandleWindow(runtime, hwnd)) {
                    QueueEvent(runtime, EventKind::Fault,
                        static_cast<int>(Result::HandleWindowCreateFailed));
                    return;
                }
                StoreHandleStatus(runtime, HandlePhase::Ready, true);
            } else {
                // 触边确认模式沿用 WM_PAINT 的真实提交结果；绘制或 EndPaint 失败时
                // presented 必须保持 false，交由健康检查执行故障开放恢复。
                StoreHandlePhase(runtime, HandlePhase::Ready);
            }
            runtime.handleReadyAt = now;
            runtime.handleLeaveStartedAt = 0;
            runtime.handleButtonDownInside = false;
        } else {
            if (!ParkHandleWindow(runtime)) {
                QueueEvent(runtime, EventKind::Fault,
                    static_cast<int>(Result::HandleWindowCreateFailed));
            } else {
                runtime.state.store(State::Armed);
            }
        }
    }
}

void UpdateHandleVisual(Runtime& runtime, ULONGLONG now) {
    const HandlePhase phase = runtime.handlePhase.load();
    // 常显模式是静态入口，不绘制也不调度绿色旋转圆环。
    if (runtime.revealMode == static_cast<int>(RevealMode::PersistentHandle)) return;
    // 绿环只在小黑条至少部分可见时累计时间并重画；完全停放到屏外后暂停。
    // 下一次出现继续使用累计的可见时间，不补算隐藏期间，也不回到圆圈顶部。
    if (phase == HandlePhase::Hidden) return;
    const DWORD interval = kHandleVisualTickMs;
    if (!runtime.handleVisualLastTick) {
        runtime.handleVisualLastTick = now;
        return;
    }
    const ULONGLONG elapsed = now - runtime.handleVisualLastTick;
    if (elapsed < interval) return;
    HWND hwnd = runtime.handleWindow.load();
    if (!hwnd || !IsWindow(hwnd)) return;
    runtime.handleVisualLastTick = now;
    runtime.handleVisualElapsedMs.fetch_add(elapsed);
    runtime.handleVisualFrame.fetch_add(1);
    InvalidateRect(hwnd, nullptr, FALSE);
}

bool IsCursorNearHandle(const Runtime& runtime, const POINT& cursor) {
    HWND hwnd = runtime.handleWindow.load();
    RECT rect{};
    if (!hwnd || !IsWindow(hwnd) || !GetWindowRect(hwnd, &rect)) return false;
    const LONG tolerance = ScaleDip(kHandleHoverToleranceDip, runtime.dpi);
    InflateRect(&rect, tolerance, tolerance);
    return IsInside(cursor, rect);
}

void BeginHandleRetreat(Runtime& runtime, ULONGLONG now) {
    HWND hwnd = runtime.handleWindow.load();
    RECT current{};
    if (!hwnd || !IsWindow(hwnd) || !GetWindowRect(hwnd, &current)) {
        DestroyHandleWindow(runtime);
        runtime.state.store(State::Armed);
        return;
    }
    if (GetCapture() == hwnd) ReleaseCapture();
    BeginHandleAnimation(runtime, HandlePhase::Retreating, current,
        runtime.handleOffscreenRect, kHandleRetreatDurationMs, now);
}

void ReverseHandleRetreat(Runtime& runtime, ULONGLONG now) {
    HWND hwnd = runtime.handleWindow.load();
    RECT current{};
    if (!hwnd || !IsWindow(hwnd) || !GetWindowRect(hwnd, &current)) return;
    runtime.handleLeaveStartedAt = 0;
    BeginHandleAnimation(runtime, HandlePhase::Appearing, current,
        runtime.handleFinalRect, kHandleAppearDurationMs, now);
}

void ManageVisibleHandle(Runtime& runtime, const POINT& cursor, bool cursorInTrigger, ULONGLONG now) {
    const HandlePhase phase = runtime.handlePhase.load();
    const bool nearHandle = IsCursorNearHandle(runtime, cursor);
    const bool interacting = nearHandle || cursorInTrigger;
    if (nearHandle) {
        runtime.handleEnteredOnce.store(true);
    }
    if (phase == HandlePhase::Retreating) {
        if (interacting) ReverseHandleRetreat(runtime, now);
        return;
    }
    if (phase == HandlePhase::Appearing) return;
    if (phase != HandlePhase::Ready) return;

    if (interacting) {
        runtime.handleLeaveStartedAt = 0;
        return;
    }

    // 小黑条已按触边点锚定，光标不需要再跨越空白区域去“找”它。
    // 因此完全离开边线和小黑条后只保留统一的 300ms 防抖，
    // 不叠加首次显示保护期，避免退场感觉迟钝。
    if (!runtime.handleLeaveStartedAt) runtime.handleLeaveStartedAt = now;
    if (now - runtime.handleLeaveStartedAt < kHandleLeaveDelayMs) return;
    BeginHandleRetreat(runtime, now);
}

bool BuildGeometry(HWND hwnd, int side, int thicknessDip, Runtime& runtime) {
    RECT windowRect{};
    if (!GetWindowRect(hwnd, &windowRect)) return false;

    const HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO monitorInfo{};
    monitorInfo.cbSize = sizeof(monitorInfo);
    if (!monitor || !GetMonitorInfoW(monitor, &monitorInfo)) return false;

    runtime.targetMonitor = monitor;
    runtime.dpi = std::max<UINT>(96, GetDpiForWindow(hwnd));
    runtime.workArea = monitorInfo.rcWork;
    const LONG thickness = ScaleDip(std::max(1, thicknessDip), runtime.dpi);
    const RECT& work = runtime.workArea;

    if (side == -1 || side == 1) {
        runtime.triggerArea.left = side < 0 ? work.left : work.right - thickness;
        runtime.triggerArea.right = side < 0 ? work.left + thickness : work.right;
        runtime.triggerArea.top = std::max(windowRect.top, work.top);
        runtime.triggerArea.bottom = std::min(windowRect.bottom, work.bottom);
    } else {
        runtime.triggerArea.left = std::max(windowRect.left, work.left);
        runtime.triggerArea.right = std::min(windowRect.right, work.right);
        runtime.triggerArea.top = side < 0 ? work.top : work.bottom - thickness;
        runtime.triggerArea.bottom = side < 0 ? work.top + thickness : work.bottom;
    }
    if (runtime.triggerArea.right <= runtime.triggerArea.left ||
        runtime.triggerArea.bottom <= runtime.triggerArea.top) return false;

    runtime.handleFinalRect = {};
    runtime.handleOffscreenRect = {};
    runtime.handleAnimationStartRect = {};
    runtime.handleAnimationEndRect = {};
    return true;
}

void ClearPreparedRuntime(Runtime& runtime) {
    runtime.notifyWindow = nullptr;
    runtime.targetMonitor = nullptr;
    runtime.side = 0;
    runtime.revealMode = static_cast<int>(RevealMode::Direct);
    runtime.dpi = 96;
    runtime.triggerArea = {};
    runtime.workArea = {};
    runtime.handleFinalRect = {};
    runtime.handleOffscreenRect = {};
    runtime.handleAnimationStartRect = {};
    runtime.handleAnimationEndRect = {};
    runtime.persistentHandlePositionPermille.store(-1);
    runtime.handleDragging.store(false);
    runtime.state.store(State::Stopped);
}

DWORD NextWorkerWaitTimeout(Runtime& runtime, ULONGLONG now) {
    if (HasPendingEvent(runtime)) {
        return static_cast<DWORD>(runtime.pollIntervalMs);
    }
    const ULONGLONG lastPoll = runtime.lastPollTick.load();
    const ULONGLONG elapsed = lastPoll > 0 && now >= lastPoll ? now - lastPoll : 0;
    const DWORD untilPoll = elapsed >= static_cast<ULONGLONG>(runtime.pollIntervalMs)
        ? 0
        : static_cast<DWORD>(runtime.pollIntervalMs - elapsed);
    const HandlePhase phase = runtime.handlePhase.load();
    if (phase == HandlePhase::Appearing || phase == HandlePhase::Retreating) {
        return std::min<DWORD>(kMessagePumpTickMs, untilPoll);
    }
    if (runtime.revealMode != static_cast<int>(RevealMode::PersistentHandle) &&
        (phase == HandlePhase::Ready || phase == HandlePhase::Dragging)) {
        return std::min<DWORD>(kHandleVisualTickMs, untilPoll);
    }
    return untilPoll;
}

unsigned __stdcall WorkerThreadProc(void* parameter) noexcept {
    auto* runtime = static_cast<Runtime*>(parameter);
    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const bool comInitialized = SUCCEEDED(comResult);
    // direct 模式永远不会创建小黑条，不能让其唤出能力依赖 WIC/Direct2D/字体初始化。
    // 两种确认条模式的渲染器仍在发布 ready 之前完成初始化；失败会安全降级到 GDI。
    if (UsesRevealHandle(*runtime)) {
        try {
            runtime->handleRenderer = std::make_unique<RevealHandleRenderer>();
            if (!runtime->handleRenderer->Initialize()) {
                runtime->handleRenderer.reset();
            } else {
                const SIZE handleSize = GetHandlePixelSize(*runtime);
                if (!runtime->handleRenderer->Prewarm(
                        static_cast<UINT>(handleSize.cx),
                        static_cast<UINT>(handleSize.cy),
                        runtime->side,
                        runtime->dpi,
                        runtime->revealMode != static_cast<int>(RevealMode::PersistentHandle))) {
                    runtime->handleRenderer.reset();
                }
            }
        } catch (...) {
            runtime->handleRenderer.reset();
        }
    }
    // 如果 ArmEx 已因初始化超时请求停止，则不得在超时之后发布 ready 或进入轮询。
    if (runtime->stopEvent && WaitForSingleObject(runtime->stopEvent, 0) == WAIT_OBJECT_0) {
        runtime->handleRenderer.reset();
        runtime->handleRendererReady.store(false);
        runtime->handleRendererPrewarmed.store(false);
        runtime->handleEmbeddedFontReady.store(false);
        if (comInitialized) CoUninitialize();
        runtime->workerAlive.store(false);
        return 0;
    }
    runtime->handleRendererReady.store(runtime->handleRenderer != nullptr);
    runtime->handleRendererPrewarmed.store(runtime->handleRenderer != nullptr);
    runtime->handleEmbeddedFontReady.store(
        runtime->handleRenderer && runtime->handleRenderer->UsesEmbeddedFont());
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    runtime->lastPollTick.store(GetTickCount64());

    // 强制创建本线程消息队列，之后小黑条 HWND 的全部输入、绘制和销毁都在本线程完成。
    MSG message{};
    PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

    // 小黑条 HWND 与 layered surface 也必须在发布 ready 前完成一次屏外创建和
    // DWM 提交。否则第一次触边时现建现移，合成器可能只呈现接近终点的帧。
    if (UsesRevealHandle(*runtime) &&
        !PrimeHandleWindow(*runtime, GetDefaultHandleAnchor(*runtime))) {
        runtime->workerStartupResult.store(static_cast<int>(Result::HandleWindowCreateFailed));
        runtime->lastError.store(static_cast<int>(Result::HandleWindowCreateFailed));
        runtime->state.store(State::Failed);
        DestroyHandleWindow(*runtime);
        runtime->handleRenderer.reset();
        runtime->handleRendererReady.store(false);
        runtime->handleRendererPrewarmed.store(false);
        runtime->handleEmbeddedFontReady.store(false);
        if (runtime->readyEvent) SetEvent(runtime->readyEvent);
        if (comInitialized) CoUninitialize();
        runtime->workerAlive.store(false);
        return 0;
    }

    // ArmEx 已同步采样启动时的光标，并据此冻结初始状态。这里不得再次采样覆盖：
    // 调用方可能在看到 workerAlive 后立即触边，二次采样会把这次真实的
    // outside -> inside 误判成“启动时已经在边缘”，从而永久等待下一次离边。
    const State initialState = runtime->state.load();
    bool previousInside = initialState == State::WaitingOutside;
    bool fullscreenActive = false;
    ULONGLONG fullscreenExitCandidateAt = 0;
    POINT cursor{};
    // workerAlive 只在消息队列与冻结状态均初始化完成后发布。
    runtime->workerAlive.store(true);
    if (runtime->readyEvent) SetEvent(runtime->readyEvent);

    bool running = true;
    while (running) {
        const DWORD waitTimeout = NextWorkerWaitTimeout(*runtime, GetTickCount64());
        const DWORD waitResult = MsgWaitForMultipleObjects(
            1, &runtime->stopEvent, FALSE, waitTimeout, QS_ALLINPUT);
        if (waitResult == WAIT_OBJECT_0) break;
        if (waitResult == WAIT_FAILED) {
            QueueEvent(*runtime, EventKind::Fault, static_cast<int>(GetLastError()));
            break;
        }

        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) {
                running = false;
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        if (!running) break;

        const ULONGLONG now = GetTickCount64();
        UpdateHandleAnimation(*runtime, now);
        UpdateHandleVisual(*runtime, now);
        TryNotifyPendingEvent(*runtime);
        if (HasPendingEvent(*runtime)) continue;
        const ULONGLONG lastPoll = runtime->lastPollTick.load();
        if (now - lastPoll < static_cast<ULONGLONG>(runtime->pollIntervalMs)) continue;
        runtime->lastPollTick.store(now);

        if (!GetCursorPos(&cursor)) {
            const int failures = runtime->cursorFailureCount.fetch_add(1) + 1;
            runtime->state.store(State::Degraded);
            if (failures >= kCursorFailureLimit) {
                DestroyHandleWindow(*runtime);
                QueueEvent(*runtime, EventKind::Fault,
                    static_cast<int>(Result::CursorUnavailable));
            }
            continue;
        }
        runtime->cursorFailureCount.store(0);
        const bool inside = IsInside(cursor, runtime->triggerArea);
        if (UsesRevealHandle(*runtime)) {
            const bool fullscreen = IsForegroundFullscreenOnTargetMonitor(*runtime);
            if (fullscreen) {
                fullscreenExitCandidateAt = 0;
                runtime->fullscreenExitPending.store(false);
                if (!fullscreenActive) {
                    runtime->fullscreenBlockCount.fetch_add(1);
                    // 全屏保护只把同一个小黑条停回屏外；本轮贴边会话仍然
                    // 存活，不能因此丢失 HWND、渲染资源或已累计的绿环角度。
                    if (!ParkHandleWindow(*runtime)) {
                        QueueEvent(*runtime, EventKind::Fault,
                            static_cast<int>(Result::HandleWindowCreateFailed));
                        previousInside = inside;
                        continue;
                    }
                }
                fullscreenActive = true;
                runtime->state.store(State::WaitingOutside);
                runtime->fullscreenActive.store(true);
                previousInside = inside;
                continue;
            }
            if (fullscreenActive) {
                if (fullscreenExitCandidateAt == 0) {
                    fullscreenExitCandidateAt = now;
                    runtime->fullscreenExitPending.store(true);
                }
                if (now - fullscreenExitCandidateAt < kFullscreenExitStableMs) {
                    previousInside = inside;
                    continue;
                }
                fullscreenActive = false;
                fullscreenExitCandidateAt = 0;
                if (runtime->revealMode == static_cast<int>(RevealMode::PersistentHandle) &&
                    runtime->persistentHandleActivated.load()) {
                    if (!RevealPrimedHandle(*runtime, GetDefaultHandleAnchor(*runtime))) {
                        QueueEvent(*runtime, EventKind::Fault,
                            static_cast<int>(Result::HandleWindowCreateFailed));
                    } else {
                        runtime->state.store(State::Armed);
                    }
                } else {
                    // 普通确认条退出全屏不补发旧意图；仍在边缘时必须先离开再进入。
                    if (!PrimeHandleWindow(*runtime, cursor)) {
                        QueueEvent(*runtime, EventKind::Fault,
                            static_cast<int>(Result::HandleWindowCreateFailed));
                    } else {
                        runtime->state.store(inside ? State::WaitingOutside : State::Armed);
                    }
                }
                // fullscreenActive=false 是退出恢复完成的对外发布点；必须等 HWND
                // 停放/恢复和监视状态全部写完，避免状态查询拼到上一阶段的 state。
                runtime->fullscreenExitPending.store(false);
                runtime->fullscreenActive.store(false);
                previousInside = inside;
                continue;
            }
        }

        if (runtime->revealMode == static_cast<int>(RevealMode::PersistentHandle) &&
            runtime->persistentHandleActivated.load() &&
            runtime->handlePhase.load() == HandlePhase::Hidden) {
            if (!RevealPrimedHandle(*runtime, GetDefaultHandleAnchor(*runtime))) {
                QueueEvent(*runtime, EventKind::Fault,
                    static_cast<int>(Result::HandleWindowCreateFailed));
            } else {
                runtime->state.store(State::Armed);
            }
            previousInside = inside;
            continue;
        }

        if (runtime->handlePhase.load() != HandlePhase::Hidden) {
            if (runtime->revealMode == static_cast<int>(RevealMode::ClickHandle)) {
                ManageVisibleHandle(*runtime, cursor, inside, now);
            }
            previousInside = inside;
            continue;
        }

        const State state = runtime->state.load();
        if (state == State::Degraded) {
            runtime->state.store(inside ? State::WaitingOutside : State::Armed);
            previousInside = inside;
            continue;
        }
        if (state == State::WaitingOutside) {
            if (!inside) runtime->state.store(State::Armed);
            previousInside = inside;
            continue;
        }
        if (state == State::Armed && !previousInside && inside) {
            if (runtime->revealMode == static_cast<int>(RevealMode::Direct)) {
                if (IsForegroundFullscreenOnTargetMonitor(*runtime)) {
                    runtime->fullscreenBlockCount.fetch_add(1);
                    runtime->state.store(State::WaitingOutside);
                } else {
                    QueueEvent(*runtime, EventKind::Trigger, 0);
                }
            } else if (runtime->revealMode == static_cast<int>(RevealMode::ClickHandle) &&
                !RevealPrimedHandle(*runtime, cursor)) {
                QueueEvent(*runtime, EventKind::Fault,
                    static_cast<int>(Result::HandleWindowCreateFailed));
            }
        }
        previousInside = inside;
    }

    DestroyHandleWindow(*runtime);
    runtime->handleRenderer.reset();
    runtime->handleRendererReady.store(false);
    runtime->handleRendererPrewarmed.store(false);
    runtime->handleEmbeddedFontReady.store(false);
    if (comInitialized) CoUninitialize();
    if (!HasPendingEvent(*runtime)) runtime->state.store(State::Stopped);
    runtime->workerAlive.store(false);
    return 0;
}

int StopLocked(Runtime& runtime, std::uint64_t generation) {
    if (generation != 0 && runtime.generation.load() != generation) {
        return static_cast<int>(Result::Ok);
    }
    if (!runtime.workerThread) {
        if (runtime.stopEvent) CloseHandle(runtime.stopEvent);
        if (runtime.readyEvent) CloseHandle(runtime.readyEvent);
        runtime.stopEvent = nullptr;
        runtime.readyEvent = nullptr;
        runtime.state.store(State::Stopped);
        return static_cast<int>(Result::Ok);
    }

    const bool retryingFailedCleanup = runtime.state.load() == State::Failed;
    SetEvent(runtime.stopEvent);
    const DWORD waitResult = WaitForSingleObject(
        runtime.workerThread,
        retryingFailedCleanup ? kStopRetryTimeoutMs : kStopTimeoutMs);
    if (waitResult != WAIT_OBJECT_0) {
        runtime.lastError.store(static_cast<int>(Result::StopTimedOut));
        runtime.state.store(State::Failed);
        return static_cast<int>(Result::StopTimedOut);
    }

    CloseHandle(runtime.workerThread);
    CloseHandle(runtime.stopEvent);
    if (runtime.readyEvent) CloseHandle(runtime.readyEvent);
    runtime.workerThread = nullptr;
    runtime.stopEvent = nullptr;
    runtime.readyEvent = nullptr;
    runtime.notifyWindow = nullptr;
    runtime.targetMonitor = nullptr;
    runtime.workerAlive.store(false);
    runtime.handleWindow.store(nullptr);
    StoreHandleStatus(runtime, HandlePhase::Hidden, false);
    runtime.handleEnteredOnce.store(false);
    runtime.handleVisualFrame.store(0);
    runtime.handleVisualElapsedMs.store(0);
    runtime.handleVisualLastTick = 0;
    runtime.handlePresentCount.store(0);
    runtime.state.store(State::Stopped);
    runtime.cursorFailureCount.store(0);
    runtime.fullscreenBlockCount.store(0);
    runtime.fullscreenActive.store(false);
    runtime.fullscreenExitPending.store(false);
    runtime.persistentHandleActivated.store(false);
    runtime.handleDragging.store(false);
    runtime.persistentHandlePositionPermille.store(-1);
    runtime.lastError.store(0);
    runtime.eventNotificationPosted = false;
    {
        std::lock_guard<std::mutex> eventLock(runtime.eventMutex);
        runtime.pendingEvents.clear();
    }
    return static_cast<int>(Result::Ok);
}

const char* StateName(State state) {
    switch (state) {
    case State::Stopped: return "stopped";
    case State::WaitingOutside: return "waiting-outside";
    case State::Armed: return "armed";
    case State::TriggerPending: return "trigger-pending";
    case State::Degraded: return "degraded";
    case State::Failed: return "failed";
    default: return "unknown";
    }
}

const char* EventName(EventKind kind) {
    switch (kind) {
    case EventKind::Trigger: return "trigger";
    case EventKind::Fault: return "fault";
    case EventKind::HandleMoved: return "handle-moved";
    default: return "none";
    }
}

const char* HandlePhaseName(HandlePhase phase) {
    switch (phase) {
    case HandlePhase::Appearing: return "appearing";
    case HandlePhase::Ready: return "ready";
    case HandlePhase::Retreating: return "retreating";
    case HandlePhase::Dragging: return "dragging";
    default: return "hidden";
    }
}

} // namespace

int Arm(
    HWND hwnd,
    int side,
    int thicknessDip,
    int pollIntervalMs,
    std::uint64_t generation) {
    return ArmEx(hwnd, side, thicknessDip, pollIntervalMs, generation,
        static_cast<int>(RevealMode::Direct));
}

int ArmEx(
    HWND hwnd,
    int side,
    int thicknessDip,
    int pollIntervalMs,
    std::uint64_t generation,
    int revealMode) {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycleMutex);
    if (!hwnd || !IsWindow(hwnd)) return static_cast<int>(Result::InvalidWindow);
    if (!IsValidSide(side)) return static_cast<int>(Result::InvalidSide);
    if (!IsValidRevealMode(revealMode)) return static_cast<int>(Result::InvalidRevealMode);
    if (generation == 0) return static_cast<int>(Result::InvalidGeneration);
    if (g_runtime.workerThread) return static_cast<int>(Result::AlreadyArmed);
    if (!WindowMotion_IsEdgeExposed(hwnd, side)) return static_cast<int>(Result::EdgeNotExposed);
    if (!GetMessageId()) return static_cast<int>(Result::MessageRegistrationFailed);
    if (revealMode != static_cast<int>(RevealMode::Direct) && !EnsureHandleWindowClass()) {
        return static_cast<int>(Result::HandleClassRegistrationFailed);
    }

    Runtime& runtime = g_runtime;
    runtime.notifyWindow = hwnd;
    runtime.side = side;
    runtime.pollIntervalMs = std::clamp(pollIntervalMs, 25, 1000);
    runtime.revealMode = revealMode;
    if (!BuildGeometry(hwnd, side, thicknessDip, runtime)) {
        ClearPreparedRuntime(runtime);
        return static_cast<int>(Result::InvalidTriggerArea);
    }

    POINT cursor{};
    if (!GetCursorPos(&cursor)) {
        ClearPreparedRuntime(runtime);
        return static_cast<int>(Result::CursorUnavailable);
    }
    HANDLE stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!stopEvent) {
        ClearPreparedRuntime(runtime);
        return static_cast<int>(Result::StopEventCreateFailed);
    }
    HANDLE readyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!readyEvent) {
        CloseHandle(stopEvent);
        ClearPreparedRuntime(runtime);
        return static_cast<int>(Result::StopEventCreateFailed);
    }

    runtime.stopEvent = stopEvent;
    runtime.readyEvent = readyEvent;
    runtime.generation.store(generation);
    runtime.lastPollTick.store(GetTickCount64());
    runtime.lastError.store(0);
    runtime.cursorFailureCount.store(0);
    runtime.fullscreenBlockCount.store(0);
    runtime.fullscreenActive.store(false);
    runtime.fullscreenExitPending.store(false);
    StoreHandleStatus(runtime, HandlePhase::Hidden, false);
    runtime.handleDragging.store(false);
    runtime.persistentHandlePositionPermille.store(-1);
    runtime.handleWindow.store(nullptr);
    runtime.handleEnteredOnce.store(false);
    runtime.handleAnimationStartedAt = 0;
    runtime.handleAnimationDurationMs = 0;
    runtime.handleReadyAt = 0;
    runtime.handleLeaveStartedAt = 0;
    ResetHandlePress(runtime);
    runtime.handleVisualElapsedMs.store(0);
    runtime.handleVisualLastTick = 0;
    runtime.handleVisualFrame.store(0);
    runtime.handleRendererReady.store(false);
    runtime.handleRendererPrewarmed.store(false);
    runtime.handleEmbeddedFontReady.store(false);
    runtime.handlePresentCount.store(0);
    runtime.handleWindowCreateCount.store(0);
    runtime.persistentHandleActivated.store(false);
    runtime.workerStartupResult.store(static_cast<int>(Result::Ok));
    runtime.eventNotificationPosted = false;
    runtime.state.store(IsInside(cursor, runtime.triggerArea) ? State::WaitingOutside : State::Armed);
    {
        std::lock_guard<std::mutex> eventLock(runtime.eventMutex);
        runtime.pendingEvents.clear();
    }

    runtime.workerThread = reinterpret_cast<HANDLE>(
        _beginthreadex(nullptr, 0, WorkerThreadProc, &runtime, 0, nullptr));
    if (!runtime.workerThread) {
        CloseHandle(runtime.stopEvent);
        CloseHandle(runtime.readyEvent);
        runtime.stopEvent = nullptr;
        runtime.readyEvent = nullptr;
        ClearPreparedRuntime(runtime);
        return static_cast<int>(Result::ThreadCreateFailed);
    }

    // 创建线程不等于监视器已经可用。只有渲染器（若需要）、消息队列和冻结的
    // 初始状态全部就绪后才允许调用方把主窗口移出屏幕。
    const DWORD readyWait = WaitForSingleObject(runtime.readyEvent, kWorkerStartTimeoutMs);
    if (readyWait != WAIT_OBJECT_0) {
        runtime.lastError.store(static_cast<int>(Result::WorkerStartTimedOut));
        runtime.state.store(State::Failed);
        SetEvent(runtime.stopEvent);

        // 给刚完成初始化的线程一次短暂、自愿退出机会；若仍未退出，保留所有句柄，
        // 由调用方的 cleanup-pending 流程继续有界重试，绝不强杀 UI/COM 线程。
        if (WaitForSingleObject(runtime.workerThread, kWorkerStartAbortGraceMs) == WAIT_OBJECT_0) {
            CloseHandle(runtime.workerThread);
            CloseHandle(runtime.stopEvent);
            CloseHandle(runtime.readyEvent);
            runtime.workerThread = nullptr;
            runtime.stopEvent = nullptr;
            runtime.readyEvent = nullptr;
            runtime.workerAlive.store(false);
            runtime.handleWindow.store(nullptr);
            StoreHandleStatus(runtime, HandlePhase::Hidden, false);
        }
        return static_cast<int>(Result::WorkerStartTimedOut);
    }

    const int startupResult = runtime.workerStartupResult.load();
    if (startupResult != static_cast<int>(Result::Ok)) {
        const DWORD exitWait = WaitForSingleObject(runtime.workerThread, kWorkerStartAbortGraceMs);
        if (exitWait != WAIT_OBJECT_0) {
            runtime.lastError.store(static_cast<int>(Result::WorkerStartTimedOut));
            runtime.state.store(State::Failed);
            SetEvent(runtime.stopEvent);
            return static_cast<int>(Result::WorkerStartTimedOut);
        }
        CloseHandle(runtime.workerThread);
        CloseHandle(runtime.stopEvent);
        CloseHandle(runtime.readyEvent);
        runtime.workerThread = nullptr;
        runtime.stopEvent = nullptr;
        runtime.readyEvent = nullptr;
        runtime.workerAlive.store(false);
        ClearPreparedRuntime(runtime);
        return startupResult;
    }

    CloseHandle(runtime.readyEvent);
    runtime.readyEvent = nullptr;
    return static_cast<int>(Result::Ok);
}

int Disarm(std::uint64_t generation) {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycleMutex);
    return StopLocked(g_runtime, generation);
}

int SetPersistentHandlePosition(std::uint64_t generation, int positionPermille) {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycleMutex);
    if (generation == 0 || g_runtime.generation.load() != generation) {
        return static_cast<int>(Result::InvalidGeneration);
    }
    if (g_runtime.revealMode != static_cast<int>(RevealMode::PersistentHandle)) {
        return static_cast<int>(Result::InvalidRevealMode);
    }
    if (positionPermille < -1 || positionPermille > kHandlePositionPermilleMax) {
        return static_cast<int>(Result::InvalidHandlePosition);
    }
    if (!g_runtime.workerThread || !g_runtime.workerAlive.load() ||
        g_runtime.state.load() == State::Failed) {
        return static_cast<int>(Result::MonitorNotReady);
    }
    // 这里只发布归一化位置；实际 HWND 定位继续由所属 worker 线程在显示时完成。
    g_runtime.persistentHandlePositionPermille.store(positionPermille);
    return static_cast<int>(Result::Ok);
}

int ShowPersistentHandle(std::uint64_t generation) {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycleMutex);
    if (generation == 0 || g_runtime.generation.load() != generation) {
        return static_cast<int>(Result::InvalidGeneration);
    }
    if (g_runtime.revealMode != static_cast<int>(RevealMode::PersistentHandle)) {
        return static_cast<int>(Result::InvalidRevealMode);
    }
    if (!g_runtime.workerThread || !g_runtime.workerAlive.load() ||
        g_runtime.state.load() == State::Failed) {
        return static_cast<int>(Result::MonitorNotReady);
    }
    // 只发布原子意图；HWND 的定位、显示和动画仍全部由所属 worker 线程执行。
    g_runtime.persistentHandleActivated.store(true);
    return static_cast<int>(Result::Ok);
}

UINT GetMessageId() {
    static const UINT messageId = RegisterWindowMessageW(L"AbandonNote.WindowMotion.EdgeEvent.v1");
    return messageId;
}

const char* GetStatusJson() {
    thread_local char json[1920]{};
    PendingEvent event{};
    std::size_t pendingEventCount = 0;
    {
        std::lock_guard<std::mutex> lock(g_runtime.eventMutex);
        pendingEventCount = g_runtime.pendingEvents.size();
        if (!g_runtime.pendingEvents.empty()) event = g_runtime.pendingEvents.front();
    }
    const ULONGLONG now = GetTickCount64();
    const ULONGLONG lastPoll = g_runtime.lastPollTick.load();
    const ULONGLONG pollAge = lastPoll > 0 && now >= lastPoll ? now - lastPoll : 0;
    const RECT trigger = g_runtime.triggerArea;
    RECT handle{};
    const HWND handleWindow = g_runtime.handleWindow.load();
    const bool handleWindowAlive = handleWindow && IsWindow(handleWindow);
    if (handleWindowAlive) GetWindowRect(handleWindow, &handle);
    const HandleStatusSnapshot handleStatus = ReadHandleStatus(g_runtime);
    const HandlePhase handlePhase = handleStatus.phase;
    const MonitorStatusSnapshot monitorStatus = ReadMonitorStatus(g_runtime);
    sprintf_s(
        json,
        "{\"state\":\"%s\",\"workerAlive\":%s,\"generation\":%llu,\"side\":%d,"
        "\"lastError\":%d,\"cursorFailureCount\":%d,\"fullscreenBlockCount\":%u,"
        "\"fullscreenActive\":%s,\"fullscreenExitPending\":%s,"
        "\"persistentHandleActivated\":%s,\"handleDragging\":%s,"
        "\"handlePositionPermille\":%d,"
        "\"lastPollAgeMs\":%llu,\"pollIntervalMs\":%d,"
        "\"triggerArea\":{\"left\":%ld,\"top\":%ld,\"right\":%ld,\"bottom\":%ld},"
        "\"pendingEvent\":\"%s\",\"pendingEventCount\":%zu,"
        "\"mode\":\"%s\",\"handleState\":\"%s\","
        "\"handleVisible\":%s,\"handleWindowAlive\":%s,\"handleEnteredOnce\":%s,"
        "\"handleDpi\":%u,\"handleRenderer\":\"%s\",\"handlePrewarmed\":%s,"
        "\"handleEmbeddedFont\":%s,\"handlePresented\":%s,"
        "\"handlePresentCount\":%llu,"
        "\"handleVisualFrame\":%llu,\"handleVisualElapsedMs\":%llu,"
        "\"handleWindowCreateCount\":%llu,"
        "\"handleRect\":{\"left\":%ld,\"top\":%ld,"
        "\"right\":%ld,\"bottom\":%ld}}",
        StateName(monitorStatus.state),
        g_runtime.workerAlive.load() ? "true" : "false",
        static_cast<unsigned long long>(g_runtime.generation.load()),
        g_runtime.side,
        g_runtime.lastError.load(),
        g_runtime.cursorFailureCount.load(),
        g_runtime.fullscreenBlockCount.load(),
        monitorStatus.fullscreenActive ? "true" : "false",
        monitorStatus.fullscreenExitPending ? "true" : "false",
        g_runtime.persistentHandleActivated.load() ? "true" : "false",
        g_runtime.handleDragging.load() ? "true" : "false",
        g_runtime.persistentHandlePositionPermille.load(),
        static_cast<unsigned long long>(pollAge),
        g_runtime.pollIntervalMs,
        trigger.left, trigger.top, trigger.right, trigger.bottom,
        EventName(event.kind),
        pendingEventCount,
        g_runtime.revealMode == static_cast<int>(RevealMode::PersistentHandle)
            ? "persistent"
            : g_runtime.revealMode == static_cast<int>(RevealMode::ClickHandle)
                ? "on-touch" : "direct",
        HandlePhaseName(handlePhase),
        handleWindowAlive && handlePhase != HandlePhase::Hidden ? "true" : "false",
        handleWindowAlive ? "true" : "false",
        g_runtime.handleEnteredOnce.load() ? "true" : "false",
        g_runtime.dpi,
        g_runtime.revealMode == static_cast<int>(RevealMode::Direct)
            ? "disabled"
            : g_runtime.handleRendererReady.load() ? "direct2d" : "gdi-fallback",
        g_runtime.handleRendererPrewarmed.load() ? "true" : "false",
        g_runtime.handleEmbeddedFontReady.load() ? "true" : "false",
        handleStatus.presented ? "true" : "false",
        static_cast<unsigned long long>(g_runtime.handlePresentCount.load()),
        static_cast<unsigned long long>(g_runtime.handleVisualFrame.load()),
        static_cast<unsigned long long>(g_runtime.handleVisualElapsedMs.load()),
        static_cast<unsigned long long>(g_runtime.handleWindowCreateCount.load()),
        handle.left, handle.top, handle.right, handle.bottom);
    return json;
}

const char* ConsumeEventJson() {
    thread_local char json[256]{};
    PendingEvent event{};
    bool hasMore = false;
    {
        std::lock_guard<std::mutex> lock(g_runtime.eventMutex);
        if (!g_runtime.pendingEvents.empty()) {
            event = g_runtime.pendingEvents.front();
            g_runtime.pendingEvents.pop_front();
        }
        g_runtime.eventNotificationPosted = false;
        hasMore = !g_runtime.pendingEvents.empty();
    }
    if (hasMore) TryNotifyPendingEvent(g_runtime);
    sprintf_s(json,
        "{\"kind\":\"%s\",\"generation\":%llu,\"side\":%d,"
        "\"error\":%d,\"positionPermille\":%d}",
        EventName(event.kind),
        static_cast<unsigned long long>(event.generation), event.side, event.error,
        event.positionPermille);
    return json;
}

void Shutdown() {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycleMutex);
    StopLocked(g_runtime, 0);
}

} // namespace WindowMotionEdgeMonitor
