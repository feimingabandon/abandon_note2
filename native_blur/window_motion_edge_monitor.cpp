#include "window_motion_edge_monitor.h"
#include "blur_api.h"
#include "reveal_handle_renderer.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cwchar>
#include <dwmapi.h>
#include <iterator>
#include <memory>
#include <mutex>
#include <objbase.h>
#include <process.h>
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
constexpr ULONGLONG kHandleAppearDurationMs = 220;
constexpr ULONGLONG kHandleRetreatDurationMs = 180;
constexpr ULONGLONG kHandleLeaveDelayMs = 300;
constexpr DWORD kMessagePumpTickMs = 16;
constexpr DWORD kHandleVisualTickMs = 33;
constexpr wchar_t kHandleWindowClass[] = L"AbandonNote.WindowMotion.RevealHandle.v1";

enum class HandlePhase : int {
    Hidden = 0,
    Appearing = 1,
    Ready = 2,
    Retreating = 3,
};

struct PendingEvent {
    EventKind kind = EventKind::None;
    int side = 0;
    int error = 0;
    std::uint64_t generation = 0;
};

struct Runtime {
    std::mutex lifecycleMutex;
    std::mutex eventMutex;
    std::atomic<State> state{State::Stopped};
    std::atomic<bool> workerAlive{false};
    std::atomic<std::uint64_t> generation{0};
    std::atomic<ULONGLONG> lastPollTick{0};
    std::atomic<int> lastError{0};
    std::atomic<int> cursorFailureCount{0};
    std::atomic<unsigned int> fullscreenBlockCount{0};
    std::atomic<HandlePhase> handlePhase{HandlePhase::Hidden};
    std::atomic<HWND> handleWindow{nullptr};
    std::atomic<bool> handleEnteredOnce{false};
    std::atomic<std::uint64_t> handleVisualFrame{0};
    std::atomic<std::uint64_t> handleVisualElapsedMs{0};
    std::atomic<bool> handleRendererReady{false};
    std::atomic<bool> handleRendererPrewarmed{false};
    std::atomic<bool> handleEmbeddedFontReady{false};
    std::atomic<std::uint64_t> handleWindowCreateCount{0};
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
    std::unique_ptr<RevealHandleRenderer> handleRenderer;
    ULONGLONG handleVisualLastTick = 0;
    bool eventNotificationPosted = false;
    PendingEvent pendingEvent{};
};

Runtime g_runtime;
std::mutex g_handleClassMutex;
bool g_handleClassRegistered = false;

bool IsValidSide(int side) {
    return side == -2 || side == -1 || side == 1 || side == 2;
}

bool IsValidRevealMode(int mode) {
    return mode == static_cast<int>(RevealMode::Direct) ||
        mode == static_cast<int>(RevealMode::ClickHandle);
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
    return runtime.pendingEvent.kind != EventKind::None;
}

void TryNotifyPendingEvent(Runtime& runtime) {
    std::lock_guard<std::mutex> lock(runtime.eventMutex);
    if (runtime.pendingEvent.kind == EventKind::None || runtime.eventNotificationPosted) return;
    if (runtime.notifyWindow && IsWindow(runtime.notifyWindow) &&
        PostMessageW(runtime.notifyWindow, GetMessageId(), 0, 0)) {
        runtime.eventNotificationPosted = true;
    }
}

void QueueEvent(Runtime& runtime, EventKind kind, int error) {
    {
        std::lock_guard<std::mutex> lock(runtime.eventMutex);
        if (runtime.pendingEvent.kind != EventKind::None) return;
        runtime.pendingEvent = {kind, runtime.side, error, runtime.generation.load()};
        runtime.eventNotificationPosted = false;
    }
    runtime.lastError.store(error);
    runtime.state.store(kind == EventKind::Trigger ? State::TriggerPending : State::Failed);
    TryNotifyPendingEvent(runtime);
}

HFONT CreateHandleLabelFont(Runtime& runtime, int sizeDip, int weight) {
    const int labelFontPx = ScaleDip(sizeDip, runtime.dpi);
    return CreateFontW(
        -labelFontPx, 0, 0, 0, weight, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Microsoft YaHei UI");
}

void PaintHandleText(
    HDC dc, Runtime& runtime, const wchar_t* text, RECT rect,
    int sizeDip, int weight, COLORREF color) {
    HFONT labelFont = CreateHandleLabelFont(runtime, sizeDip, weight);
    HGDIOBJ labelFontToUse = labelFont
        ? static_cast<HGDIOBJ>(labelFont)
        : GetStockObject(DEFAULT_GUI_FONT);
    HGDIOBJ previousFont = SelectObject(dc, labelFontToUse);
    SetTextColor(dc, color);
    DrawTextW(dc, text, -1, &rect,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SelectObject(dc, previousFont);
    if (labelFont) DeleteObject(labelFont);
}

void PaintHandleLabel(HDC dc, Runtime& runtime, const RECT& client) {
    if (runtime.side == -1 || runtime.side == 1) {
        const int width = client.right - client.left;
        RECT firstLine{0, ScaleDip(49, runtime.dpi), width, ScaleDip(69, runtime.dpi)};
        RECT secondLine{0, ScaleDip(68, runtime.dpi), width, ScaleDip(88, runtime.dpi)};
        PaintHandleText(dc, runtime, L"\x70b9\x51fb", firstLine,
            11, FW_SEMIBOLD, RGB(243, 244, 246));
        PaintHandleText(dc, runtime, L"\x5c55\x5f00", secondLine,
            11, FW_SEMIBOLD, RGB(243, 244, 246));
    } else {
        RECT action{ScaleDip(45, runtime.dpi), 0,
            client.right - ScaleDip(10, runtime.dpi), client.bottom};
        PaintHandleText(dc, runtime, L"\x70b9\x51fb\x5c55\x5f00", action,
            11, FW_SEMIBOLD, RGB(243, 244, 246));
    }
}

void PaintHandleFallback(HDC dc, Runtime& runtime, HWND hwnd) {
    if (!dc) return;
    RECT client{};
    GetClientRect(hwnd, &client);
    HBRUSH background = CreateSolidBrush(RGB(18, 19, 21));
    if (background) {
        FillRect(dc, &client, background);
        DeleteObject(background);
    }

    SetBkMode(dc, TRANSPARENT);
    PaintHandleLabel(dc, runtime, client);
}

bool EnableHandleFallbackSurface(HWND hwnd) {
    const LONG_PTR extendedStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, extendedStyle & ~WS_EX_LAYERED);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, extendedStyle | WS_EX_LAYERED);
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
                runtime->handleVisualElapsedMs.load())) {
            if (paintDc) EndPaint(hwnd, &paint);
            return 0;
        }
        if (runtime->handleRenderer) {
            runtime->handleRenderer.reset();
            runtime->handleRendererReady.store(false);
            runtime->handleRendererPrewarmed.store(false);
            runtime->handleEmbeddedFontReady.store(false);
            EnableHandleFallbackSurface(hwnd);
        }
        PaintHandleFallback(paintDc, *runtime, hwnd);
        if (paintDc) EndPaint(hwnd, &paint);
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
            SetCapture(hwnd);
        }
        return 0;
    case WM_LBUTTONUP: {
        const bool completeClick =
            runtime->handlePhase.load() == HandlePhase::Ready &&
            runtime->handleButtonDownInside && IsInsideClient(hwnd, lParam);
        runtime->handleButtonDownInside = false;
        if (GetCapture() == hwnd) ReleaseCapture();
        if (completeClick) {
            runtime->handlePhase.store(HandlePhase::Hidden);
            ShowWindow(hwnd, SW_HIDE);
            QueueEvent(*runtime, EventKind::Trigger, 0);
            // 点击确认后主进程会立即结束本轮贴边会话；这里沿用已验证的关闭
            // 路径，普通退场才把 HWND 停在屏外供下一次触边复用。
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        return 0;
    }
    case WM_CAPTURECHANGED:
        runtime->handleButtonDownInside = false;
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
    runtime.handlePhase.store(HandlePhase::Hidden);
    runtime.handleEnteredOnce.store(false);
    runtime.handleAnimationStartedAt = 0;
    runtime.handleAnimationDurationMs = 0;
    runtime.handleReadyAt = 0;
    runtime.handleLeaveStartedAt = 0;
    runtime.handleButtonDownInside = false;
    runtime.handleVisualLastTick = 0;
    runtime.handleVisualFrame.store(0);
    runtime.handleVisualElapsedMs.store(0);
    if (hwnd && IsWindow(hwnd)) DestroyWindow(hwnd);
}

void ResetParkedHandleState(Runtime& runtime) {
    runtime.handlePhase.store(HandlePhase::Hidden);
    runtime.handleEnteredOnce.store(false);
    runtime.handleAnimationStartedAt = 0;
    runtime.handleAnimationDurationMs = 0;
    runtime.handleReadyAt = 0;
    runtime.handleLeaveStartedAt = 0;
    runtime.handleButtonDownInside = false;
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

void PositionHandleAtTouch(Runtime& runtime, const POINT& touch) {
    const RECT& work = runtime.workArea;
    const bool vertical = runtime.side == -1 || runtime.side == 1;
    const SIZE handleSize = GetHandlePixelSize(runtime);
    const LONG width = handleSize.cx;
    const LONG height = handleSize.cy;

    LONG finalX = work.left;
    LONG finalY = work.top;
    if (vertical) {
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

    runtime.handleFinalRect = {finalX, finalY, finalX + width, finalY + height};
    runtime.handleOffscreenRect = runtime.handleFinalRect;
    if (runtime.side == -1) OffsetRect(&runtime.handleOffscreenRect, -width, 0);
    else if (runtime.side == 1) OffsetRect(&runtime.handleOffscreenRect, width, 0);
    else if (runtime.side == -2) OffsetRect(&runtime.handleOffscreenRect, 0, -height);
    else OffsetRect(&runtime.handleOffscreenRect, 0, height);
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
    runtime.handlePhase.store(phase);
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

bool RevealPrimedHandle(Runtime& runtime, const POINT& touch) {
    if (!PrimeHandleWindow(runtime, touch)) return false;
    HWND hwnd = runtime.handleWindow.load();
    if (!hwnd || !IsWindow(hwnd) ||
        !RedrawWindow(hwnd, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW)) {
        return false;
    }
    // 先把同一个 HWND、鼠标对应的屏外坐标和暂停时的绿环画面提交给 DWM，
    // 再从下一次消息循环开始滑出，避免重定位与首个位移被合并成一次可见跳变。
    DwmFlush();
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
            runtime.handlePhase.store(HandlePhase::Ready);
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
    if (phase == HandlePhase::Ready) {
        return std::min<DWORD>(kHandleVisualTickMs, untilPoll);
    }
    return untilPoll;
}

unsigned __stdcall WorkerThreadProc(void* parameter) noexcept {
    auto* runtime = static_cast<Runtime*>(parameter);
    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const bool comInitialized = SUCCEEDED(comResult);
    // direct 模式永远不会创建小黑条，不能让其唤出能力依赖 WIC/Direct2D/字体初始化。
    // 点击模式的渲染器仍在发布 ready 之前完成初始化；初始化失败会安全降级到 GDI。
    if (runtime->revealMode == static_cast<int>(RevealMode::ClickHandle)) {
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
                        runtime->dpi)) {
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
    if (runtime->revealMode == static_cast<int>(RevealMode::ClickHandle) &&
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
        if (runtime->revealMode == static_cast<int>(RevealMode::ClickHandle)) {
            const bool fullscreen = IsForegroundFullscreenOnTargetMonitor(*runtime);
            if (fullscreen) {
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
                previousInside = inside;
                continue;
            }
            if (fullscreenActive) {
                // 退出全屏不补发旧意图；仍在边缘时必须先离开再重新进入。
                fullscreenActive = false;
                if (!PrimeHandleWindow(*runtime, cursor)) {
                    QueueEvent(*runtime, EventKind::Fault,
                        static_cast<int>(Result::HandleWindowCreateFailed));
                    previousInside = inside;
                    continue;
                }
                runtime->state.store(inside ? State::WaitingOutside : State::Armed);
                previousInside = inside;
                continue;
            }
        }

        if (runtime->handlePhase.load() != HandlePhase::Hidden) {
            ManageVisibleHandle(*runtime, cursor, inside, now);
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
            } else if (!RevealPrimedHandle(*runtime, cursor)) {
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
    runtime.handlePhase.store(HandlePhase::Hidden);
    runtime.handleEnteredOnce.store(false);
    runtime.handleVisualFrame.store(0);
    runtime.handleVisualElapsedMs.store(0);
    runtime.handleVisualLastTick = 0;
    runtime.state.store(State::Stopped);
    runtime.cursorFailureCount.store(0);
    runtime.fullscreenBlockCount.store(0);
    runtime.lastError.store(0);
    runtime.eventNotificationPosted = false;
    {
        std::lock_guard<std::mutex> eventLock(runtime.eventMutex);
        runtime.pendingEvent = {};
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
    default: return "none";
    }
}

const char* HandlePhaseName(HandlePhase phase) {
    switch (phase) {
    case HandlePhase::Appearing: return "appearing";
    case HandlePhase::Ready: return "ready";
    case HandlePhase::Retreating: return "retreating";
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
    if (revealMode == static_cast<int>(RevealMode::ClickHandle) && !EnsureHandleWindowClass()) {
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
    runtime.handlePhase.store(HandlePhase::Hidden);
    runtime.handleWindow.store(nullptr);
    runtime.handleEnteredOnce.store(false);
    runtime.handleAnimationStartedAt = 0;
    runtime.handleAnimationDurationMs = 0;
    runtime.handleReadyAt = 0;
    runtime.handleLeaveStartedAt = 0;
    runtime.handleButtonDownInside = false;
    runtime.handleVisualElapsedMs.store(0);
    runtime.handleVisualLastTick = 0;
    runtime.handleVisualFrame.store(0);
    runtime.handleRendererReady.store(false);
    runtime.handleRendererPrewarmed.store(false);
    runtime.handleEmbeddedFontReady.store(false);
    runtime.handleWindowCreateCount.store(0);
    runtime.workerStartupResult.store(static_cast<int>(Result::Ok));
    runtime.eventNotificationPosted = false;
    runtime.state.store(IsInside(cursor, runtime.triggerArea) ? State::WaitingOutside : State::Armed);
    {
        std::lock_guard<std::mutex> eventLock(runtime.eventMutex);
        runtime.pendingEvent = {};
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
            runtime.handlePhase.store(HandlePhase::Hidden);
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

UINT GetMessageId() {
    static const UINT messageId = RegisterWindowMessageW(L"AbandonNote.WindowMotion.EdgeEvent.v1");
    return messageId;
}

const char* GetStatusJson() {
    thread_local char json[1536]{};
    PendingEvent event{};
    {
        std::lock_guard<std::mutex> lock(g_runtime.eventMutex);
        event = g_runtime.pendingEvent;
    }
    const ULONGLONG now = GetTickCount64();
    const ULONGLONG lastPoll = g_runtime.lastPollTick.load();
    const ULONGLONG pollAge = lastPoll > 0 && now >= lastPoll ? now - lastPoll : 0;
    const RECT trigger = g_runtime.triggerArea;
    RECT handle{};
    const HWND handleWindow = g_runtime.handleWindow.load();
    const bool handleWindowAlive = handleWindow && IsWindow(handleWindow);
    if (handleWindowAlive) GetWindowRect(handleWindow, &handle);
    const HandlePhase handlePhase = g_runtime.handlePhase.load();
    sprintf_s(
        json,
        "{\"state\":\"%s\",\"workerAlive\":%s,\"generation\":%llu,\"side\":%d,"
        "\"lastError\":%d,\"cursorFailureCount\":%d,\"fullscreenBlockCount\":%u,"
        "\"lastPollAgeMs\":%llu,\"pollIntervalMs\":%d,"
        "\"triggerArea\":{\"left\":%ld,\"top\":%ld,\"right\":%ld,\"bottom\":%ld},"
        "\"pendingEvent\":\"%s\",\"mode\":\"%s\",\"handleState\":\"%s\","
        "\"handleVisible\":%s,\"handleWindowAlive\":%s,\"handleEnteredOnce\":%s,"
        "\"handleDpi\":%u,\"handleRenderer\":\"%s\",\"handlePrewarmed\":%s,"
        "\"handleEmbeddedFont\":%s,"
        "\"handleVisualFrame\":%llu,\"handleVisualElapsedMs\":%llu,"
        "\"handleWindowCreateCount\":%llu,"
        "\"handleRect\":{\"left\":%ld,\"top\":%ld,"
        "\"right\":%ld,\"bottom\":%ld}}",
        StateName(g_runtime.state.load()),
        g_runtime.workerAlive.load() ? "true" : "false",
        static_cast<unsigned long long>(g_runtime.generation.load()),
        g_runtime.side,
        g_runtime.lastError.load(),
        g_runtime.cursorFailureCount.load(),
        g_runtime.fullscreenBlockCount.load(),
        static_cast<unsigned long long>(pollAge),
        g_runtime.pollIntervalMs,
        trigger.left, trigger.top, trigger.right, trigger.bottom,
        EventName(event.kind),
        g_runtime.revealMode == static_cast<int>(RevealMode::ClickHandle)
            ? "click-handle" : "direct",
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
        static_cast<unsigned long long>(g_runtime.handleVisualFrame.load()),
        static_cast<unsigned long long>(g_runtime.handleVisualElapsedMs.load()),
        static_cast<unsigned long long>(g_runtime.handleWindowCreateCount.load()),
        handle.left, handle.top, handle.right, handle.bottom);
    return json;
}

const char* ConsumeEventJson() {
    thread_local char json[256]{};
    PendingEvent event{};
    {
        std::lock_guard<std::mutex> lock(g_runtime.eventMutex);
        event = g_runtime.pendingEvent;
        g_runtime.pendingEvent = {};
        g_runtime.eventNotificationPosted = false;
    }
    sprintf_s(json,
        "{\"kind\":\"%s\",\"generation\":%llu,\"side\":%d,\"error\":%d}",
        EventName(event.kind),
        static_cast<unsigned long long>(event.generation), event.side, event.error);
    return json;
}

void Shutdown() {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycleMutex);
    StopLocked(g_runtime, 0);
}

} // namespace WindowMotionEdgeMonitor
