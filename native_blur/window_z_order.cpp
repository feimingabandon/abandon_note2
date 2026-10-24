#include "window_z_order.h"

#include "blur_engine.h"

#include <atomic>
#include <commctrl.h>
#include <cstdio>
#include <cwchar>
#include <mutex>
#include <string>

namespace WindowZOrder {
namespace {

constexpr UINT_PTR kSubclassId = 0x414E5A4F; // "ANZO"

HWND g_target = nullptr;
HWINEVENTHOOK g_foregroundHook = nullptr;
HWINEVENTHOOK g_reorderHook = nullptr;
DWORD g_ownerThreadId = 0;
bool g_enabled = false;
bool g_applying = false;
bool g_lastApplySucceeded = false;
std::atomic_bool g_syncPending{false};
std::atomic<unsigned long long> g_syncRequestCount{0};
std::atomic<unsigned long long> g_syncPostCount{0};
std::atomic<unsigned long long> g_anchorCheckCount{0};
std::atomic<unsigned long long> g_anchorNoopCount{0};
std::atomic<unsigned long long> g_anchorApplyCount{0};
std::atomic<unsigned long long> g_lastAnchorApplyTickMs{0};

// Store values at the failed API boundary, before ResetState/JS rollback can
// destroy the controller. The storage is fixed-size and never reads titles.
struct WindowEvidence {
    HWND hwnd = nullptr;
    HWND owner = nullptr;
    bool insertionHandle = false;
    bool valid = false;
    bool visible = false;
    bool topmost = false;
    bool classNameTruncated = false;
    DWORD processId = 0;
    DWORD threadId = 0;
    wchar_t className[64]{};
};

struct FailureContext {
    HWND requested = nullptr;
    HWND target = nullptr;
    HWND overlay = nullptr;
    HWND desktop = nullptr;
    HWND insertionAfter = nullptr;
    bool insertionKnown = false;
    bool mainMoveAttempted = false;
    bool mainMoved = false;
    bool overlayMoveAttempted = false;
    bool overlayMoved = false;
};

struct FailureEvidence {
    unsigned long long sequence = 0;
    unsigned long long tickMs = 0;
    const char* operation = "unknown";
    const char* stage = "unknown";
    int resultCode = 0;
    bool win32ErrorCaptured = false;
    DWORD win32Error = 0;
    DWORD currentThreadId = 0;
    DWORD ownerThreadId = 0;
    bool controllerEnabled = false;
    bool applying = false;
    bool mainMoveAttempted = false;
    bool mainMoved = false;
    bool overlayMoveAttempted = false;
    bool overlayMoved = false;
    WindowEvidence requested{};
    WindowEvidence target{};
    WindowEvidence overlay{};
    WindowEvidence desktop{};
    WindowEvidence insertionAfter{};
};

std::mutex g_failureMutex;
unsigned long long g_failureCount = 0;
FailureEvidence g_firstFailure{};
FailureEvidence g_lastFailure{};

WindowEvidence CaptureWindowEvidence(HWND hwnd, bool insertionHandle = false) {
    WindowEvidence value{};
    value.hwnd = hwnd;
    value.insertionHandle = insertionHandle;
    if (insertionHandle && (hwnd == HWND_TOP || hwnd == HWND_BOTTOM ||
        hwnd == HWND_TOPMOST || hwnd == HWND_NOTOPMOST)) return value;
    value.valid = hwnd && IsWindow(hwnd);
    if (!value.valid) return value;
    value.threadId = GetWindowThreadProcessId(hwnd, &value.processId);
    value.owner = GetWindow(hwnd, GW_OWNER);
    value.visible = IsWindowVisible(hwnd) != FALSE;
    value.topmost = (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    const int classLength = GetClassNameW(hwnd, value.className,
        static_cast<int>(_countof(value.className)));
    value.classNameTruncated = classLength >= static_cast<int>(_countof(value.className)) - 1;
    return value;
}

void RecordFailure(
    const char* operation,
    const char* stage,
    ResultCode resultCode,
    const FailureContext& context,
    bool win32ErrorCaptured = false,
    DWORD win32Error = 0) noexcept {
    const DWORD callerLastError = GetLastError();
    try {
        FailureEvidence evidence{};
        evidence.tickMs = GetTickCount64();
        evidence.operation = operation;
        evidence.stage = stage;
        evidence.resultCode = static_cast<int>(resultCode);
        evidence.win32ErrorCaptured = win32ErrorCaptured;
        evidence.win32Error = win32Error;
        evidence.currentThreadId = GetCurrentThreadId();
        evidence.ownerThreadId = g_ownerThreadId;
        evidence.controllerEnabled = g_enabled;
        evidence.applying = g_applying;
        evidence.mainMoveAttempted = context.mainMoveAttempted;
        evidence.mainMoved = context.mainMoved;
        evidence.overlayMoveAttempted = context.overlayMoveAttempted;
        evidence.overlayMoved = context.overlayMoved;
        evidence.requested = CaptureWindowEvidence(context.requested);
        evidence.target = CaptureWindowEvidence(context.target);
        evidence.overlay = CaptureWindowEvidence(context.overlay);
        evidence.desktop = CaptureWindowEvidence(context.desktop);
        evidence.insertionAfter = CaptureWindowEvidence(context.insertionAfter, context.insertionKnown);
        std::lock_guard<std::mutex> lock(g_failureMutex);
        evidence.sequence = ++g_failureCount;
        if (g_firstFailure.sequence == 0) g_firstFailure = evidence;
        g_lastFailure = evidence;
    } catch (...) {
        // Diagnostics must not change native return codes or unwind through FFI.
    }
    SetLastError(callerLastError);
}

const char* BooleanJson(bool value) { return value ? "true" : "false"; }

std::string HandleJson(HWND hwnd) {
    char value[32]{};
    sprintf_s(value, "0x%llx", static_cast<unsigned long long>(reinterpret_cast<UINT_PTR>(hwnd)));
    return value;
}

void AppendClassNameJson(std::string& json, const wchar_t* value) {
    // 63 UTF-16 code units fit within 252 UTF-8 bytes; no user text is read.
    char utf8[256]{};
    const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, utf8,
        static_cast<int>(_countof(utf8)), nullptr, nullptr);
    json += '"';
    for (int index = 0; size > 0 && index < size - 1; ++index) {
        const unsigned char ch = static_cast<unsigned char>(utf8[index]);
        if (ch == '"' || ch == '\\') {
            json += '\\';
            json += static_cast<char>(ch);
        } else if (ch < 0x20) {
            char escaped[7]{};
            sprintf_s(escaped, "\\u%04x", static_cast<unsigned int>(ch));
            json += escaped;
        } else {
            json += static_cast<char>(ch);
        }
    }
    json += '"';
}

void AppendWindowJson(std::string& json, const WindowEvidence& value) {
    const char* kind = value.hwnd ? "window" : "null";
    if (value.insertionHandle) {
        if (value.hwnd == HWND_TOP) kind = "top";
        else if (value.hwnd == HWND_BOTTOM) kind = "bottom";
        else if (value.hwnd == HWND_TOPMOST) kind = "topmost";
        else if (value.hwnd == HWND_NOTOPMOST) kind = "notopmost";
    }
    json += "{\"hwnd\":\"" + HandleJson(value.hwnd) + "\",\"kind\":\"" + kind +
        "\",\"valid\":" + BooleanJson(value.valid) + ",\"className\":";
    AppendClassNameJson(json, value.className);
    json += ",\"classNameTruncated\":" + std::string(BooleanJson(value.classNameTruncated)) +
        ",\"processId\":" + std::to_string(value.processId) +
        ",\"threadId\":" + std::to_string(value.threadId) +
        ",\"visible\":" + BooleanJson(value.visible) +
        ",\"topmost\":" + BooleanJson(value.topmost) +
        ",\"owner\":\"" + HandleJson(value.owner) + "\"}";
}

void AppendFailureJson(std::string& json, const FailureEvidence& value) {
    if (value.sequence == 0) { json += "null"; return; }
    json += "{\"sequence\":" + std::to_string(value.sequence) +
        ",\"tickMs\":" + std::to_string(value.tickMs) +
        ",\"operation\":\"" + value.operation + "\",\"stage\":\"" + value.stage +
        "\",\"resultCode\":" + std::to_string(value.resultCode) +
        ",\"win32Error\":" + (value.win32ErrorCaptured ? std::to_string(value.win32Error) : "null") +
        ",\"win32ErrorSource\":\"" + (value.win32ErrorCaptured ? "GetLastError" : "not-applicable") +
        "\",\"currentThreadId\":" + std::to_string(value.currentThreadId) +
        ",\"ownerThreadId\":" + std::to_string(value.ownerThreadId) +
        ",\"controllerEnabled\":" + BooleanJson(value.controllerEnabled) +
        ",\"applying\":" + BooleanJson(value.applying) +
        ",\"mainMoveAttempted\":" + BooleanJson(value.mainMoveAttempted) +
        ",\"mainMoved\":" + (value.mainMoveAttempted ? BooleanJson(value.mainMoved) : "null") +
        ",\"overlayMoveAttempted\":" + BooleanJson(value.overlayMoveAttempted) +
        ",\"overlayMoved\":" + (value.overlayMoveAttempted ? BooleanJson(value.overlayMoved) : "null") +
        ",\"windows\":{\"requested\":";
    AppendWindowJson(json, value.requested);
    json += ",\"target\":"; AppendWindowJson(json, value.target);
    json += ",\"overlay\":"; AppendWindowJson(json, value.overlay);
    json += ",\"desktop\":"; AppendWindowJson(json, value.desktop);
    json += ",\"insertionAfter\":"; AppendWindowJson(json, value.insertionAfter);
    json += "}}";
}

enum class SyncReason : unsigned int {
    Unknown = 0,
    ForegroundEvent = 1,
    ReorderEvent = 2,
    TaskbarCreated = 3,
    WindowPosChanged = 4,
    SetFocus = 5,
    Activate = 6,
    ShowWindow = 7,
};

std::atomic<unsigned int> g_lastSyncReason{static_cast<unsigned int>(SyncReason::Unknown)};

const char* SyncReasonName(unsigned int reason) {
    switch (static_cast<SyncReason>(reason)) {
    case SyncReason::ForegroundEvent: return "foreground-event";
    case SyncReason::ReorderEvent: return "reorder-event";
    case SyncReason::TaskbarCreated: return "taskbar-created";
    case SyncReason::WindowPosChanged: return "window-pos-changed";
    case SyncReason::SetFocus: return "set-focus";
    case SyncReason::Activate: return "activate";
    case SyncReason::ShowWindow: return "show-window";
    default: return "unknown";
    }
}

UINT SyncMessage() {
    static const UINT message = RegisterWindowMessageW(L"AbandonNote.WindowZOrder.Sync.v1");
    return message;
}

UINT TaskbarCreatedMessage() {
    static const UINT message = RegisterWindowMessageW(L"TaskbarCreated");
    return message;
}

HWND GetOverlayWindow() {
    const HWND overlay = BlurEngine::Engine::Instance().GetOverlayWindow();
    return overlay && IsWindow(overlay) ? overlay : nullptr;
}

bool IsShellDesktopWindow(HWND hwnd) {
    if (!hwnd) return false;
    if (hwnd == GetDesktopWindow() || hwnd == GetShellWindow()) return true;

    wchar_t className[64]{};
    if (GetClassNameW(hwnd, className, static_cast<int>(_countof(className))) <= 0) return false;
    return std::wcscmp(className, L"Progman") == 0 ||
        std::wcscmp(className, L"WorkerW") == 0 ||
        std::wcscmp(className, L"Shell_TrayWnd") == 0 ||
        std::wcscmp(className, L"Shell_SecondaryTrayWnd") == 0;
}

bool IsDesktopSurfaceWindow(HWND hwnd) {
    if (!hwnd || !IsWindowVisible(hwnd)) return false;
    if (hwnd == GetShellWindow()) return true;

    wchar_t className[64]{};
    if (GetClassNameW(hwnd, className, static_cast<int>(_countof(className))) <= 0) return false;
    return std::wcscmp(className, L"Progman") == 0 ||
        std::wcscmp(className, L"WorkerW") == 0;
}

// 将目标插在最高桌面宿主的正上方。hWndInsertAfter 表示位于目标前方
// （也就是 Z 序更高）的窗口，因此使用桌面宿主前一个非目标窗口作为锚点。
// 不能退化为 HWND_BOTTOM：Explorer 的 WorkerW 布局下绝对底部可能位于壁纸后方。
bool FindDesktopInsertionAfter(HWND target, HWND overlay, HWND* insertionAfter, HWND* desktop = nullptr) {
    if (!insertionAfter) return false;

    HWND previous = nullptr;
    HWND candidate = GetTopWindow(nullptr);
    while (candidate) {
        if (candidate != target && candidate != overlay) {
            if (IsDesktopSurfaceWindow(candidate)) {
                *insertionAfter = previous ? previous : HWND_TOP;
                if (desktop) *desktop = candidate;
                return true;
            }
            previous = candidate;
        }
        candidate = GetWindow(candidate, GW_HWNDNEXT);
    }
    return false;
}

struct DesktopRelation {
    int above = 0;
    int below = 0;
    bool targetFound = false;
};

DesktopRelation GetDesktopRelation(HWND target) {
    DesktopRelation relation{};
    HWND candidate = GetTopWindow(nullptr);
    while (candidate) {
        if (candidate == target) {
            relation.targetFound = true;
        } else if (IsDesktopSurfaceWindow(candidate)) {
            if (relation.targetFound) {
                relation.below += 1;
            } else {
                relation.above += 1;
            }
        }
        candidate = GetWindow(candidate, GW_HWNDNEXT);
    }
    return relation;
}

int CountOrdinaryVisibleWindowsBelow(HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) return 0;
    const HWND overlay = GetOverlayWindow();
    int count = 0;
    HWND candidate = GetWindow(hwnd, GW_HWNDNEXT);
    while (candidate) {
        // 与 FindDesktopInsertionAfter 使用相同的应用窗口带边界。桌面宿主
        // 后方的可见窗口不影响便签置底；继续统计它们会导致排层成功却永远
        // 无法通过 anchored 校验，并在每次重同步时无意义地重排窗口。
        if (IsDesktopSurfaceWindow(candidate)) break;
        if (candidate != overlay && IsWindowVisible(candidate) && !IsShellDesktopWindow(candidate)) {
            count += 1;
        }
        candidate = GetWindow(candidate, GW_HWNDNEXT);
    }
    return count;
}

bool IsAbove(HWND upper, HWND lower) {
    if (!upper || !lower || upper == lower) return false;
    HWND candidate = GetWindow(upper, GW_HWNDNEXT);
    while (candidate) {
        if (candidate == lower) return true;
        candidate = GetWindow(candidate, GW_HWNDNEXT);
    }
    return false;
}

bool AnchorWindowAndOverlay(const char* operation = "sync", HWND requested = nullptr) {
    FailureContext context{};
    context.requested = requested ? requested : g_target;
    context.target = g_target;
    context.overlay = GetOverlayWindow();
    if (!g_enabled || !g_target || !IsWindow(g_target)) {
        RecordFailure(operation, !g_enabled ? "controller-not-enabled" : "invalid-target-window",
            ResultCode::ApplyFailed, context);
        return false;
    }
    g_anchorCheckCount.fetch_add(1);

    const HWND overlay = context.overlay;
    const DesktopRelation desktopRelation = GetDesktopRelation(g_target);
    const bool mainAlreadyAnchored = desktopRelation.targetFound &&
        desktopRelation.above == 0 && desktopRelation.below > 0 &&
        CountOrdinaryVisibleWindowsBelow(g_target) == 0;
    const bool overlayAlreadyAdjacent = !overlay || GetWindow(g_target, GW_HWNDNEXT) == overlay;
    if (mainAlreadyAnchored && overlayAlreadyAdjacent) {
        g_anchorNoopCount.fetch_add(1);
        g_lastApplySucceeded = true;
        return true;
    }

    g_anchorApplyCount.fetch_add(1);
    g_lastAnchorApplyTickMs.store(GetTickCount64());
    g_applying = true;
    const UINT flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    HWND insertionAfter = nullptr;
    const bool desktopFound = FindDesktopInsertionAfter(g_target, overlay, &insertionAfter, &context.desktop);
    context.insertionAfter = insertionAfter;
    context.insertionKnown = desktopFound;
    BOOL mainMoved = FALSE;
    if (!desktopFound) {
        // This is a failed predicate, not an API error. Never report a stale
        // thread-local GetLastError value as a Windows error for this stage.
        RecordFailure(operation, "no-desktop-host", ResultCode::ApplyFailed, context);
    } else {
        context.mainMoveAttempted = true;
        SetLastError(ERROR_SUCCESS);
        mainMoved = SetWindowPos(g_target, insertionAfter, 0, 0, 0, 0, flags);
        const DWORD mainError = mainMoved ? ERROR_SUCCESS : GetLastError();
        context.mainMoved = mainMoved != FALSE;
        if (!mainMoved) {
            RecordFailure(operation, "main-set-window-pos", ResultCode::ApplyFailed,
                context, true, mainError);
        }
    }

    BOOL overlayMoved = TRUE;
    if (mainMoved && overlay) {
        // 主窗口先进入普通窗口带底部，再把 Overlay 紧贴到它后方。这样即使
        // 毛玻璃开关关闭，Overlay 生命周期仍不会改变主窗口置底能力。
        context.overlayMoveAttempted = true;
        context.insertionAfter = g_target;
        context.insertionKnown = true;
        SetLastError(ERROR_SUCCESS);
        overlayMoved = SetWindowPos(overlay, g_target, 0, 0, 0, 0, flags);
        const DWORD overlayError = overlayMoved ? ERROR_SUCCESS : GetLastError();
        context.overlayMoved = overlayMoved != FALSE;
        if (!overlayMoved) {
            RecordFailure(operation, "overlay-set-window-pos", ResultCode::ApplyFailed,
                context, true, overlayError);
        }
    }
    g_applying = false;
    g_lastApplySucceeded = mainMoved != FALSE && overlayMoved != FALSE;
    return g_lastApplySucceeded;
}

void QueueSync(SyncReason reason) {
    if (!g_enabled || !g_target || !IsWindow(g_target)) return;
    g_syncRequestCount.fetch_add(1);
    g_lastSyncReason.store(static_cast<unsigned int>(reason));
    bool expected = false;
    if (!g_syncPending.compare_exchange_strong(expected, true)) return;
    const UINT syncMessage = SyncMessage();
    SetLastError(ERROR_SUCCESS);
    const BOOL posted = PostMessageW(g_target, syncMessage, 0, 0);
    const DWORD postError = posted ? ERROR_SUCCESS : GetLastError();
    if (posted) {
        g_syncPostCount.fetch_add(1);
    } else {
        FailureContext context{};
        context.requested = g_target;
        context.target = g_target;
        context.overlay = GetOverlayWindow();
        RecordFailure("queue-sync", "sync-post-message", ResultCode::ApplyFailed,
            context, true, postError);
        g_syncPending.store(false);
    }
}

void UnhookEvents() {
    if (g_foregroundHook) {
        UnhookWinEvent(g_foregroundHook);
        g_foregroundHook = nullptr;
    }
    if (g_reorderHook) {
        UnhookWinEvent(g_reorderHook);
        g_reorderHook = nullptr;
    }
}

LRESULT CALLBACK BottomSubclassProc(
    HWND hwnd,
    UINT message,
    WPARAM wParam,
    LPARAM lParam,
    UINT_PTR subclassId,
    DWORD_PTR referenceData);

void ResetState(bool removeSubclass) {
    const HWND target = g_target;
    g_enabled = false;
    g_syncPending.store(false);
    UnhookEvents();
    if (removeSubclass && target && IsWindow(target)) {
        RemoveWindowSubclass(target, BottomSubclassProc, kSubclassId);
    }
    g_target = nullptr;
    g_ownerThreadId = 0;
    g_applying = false;
    g_lastApplySucceeded = false;
}

void CALLBACK WinEventProc(
    HWINEVENTHOOK,
    DWORD event,
    HWND,
    LONG objectId,
    LONG childId,
    DWORD,
    DWORD) {
    // 控件内部的无障碍树重排不改变顶层 Z 序，不能为它遍历整个桌面。
    if (event == EVENT_OBJECT_REORDER &&
        (objectId != OBJID_WINDOW || childId != CHILDID_SELF)) return;
    // 隐藏/最小化期间保留拦截器，显示时由窗口消息重新锚定。
    if (!g_target || !IsWindowVisible(g_target) || IsIconic(g_target)) return;
    QueueSync(
        event == EVENT_SYSTEM_FOREGROUND
            ? SyncReason::ForegroundEvent
            : event == EVENT_OBJECT_REORDER
                ? SyncReason::ReorderEvent
                : SyncReason::Unknown);
}

LRESULT CALLBACK BottomSubclassProc(
    HWND hwnd,
    UINT message,
    WPARAM wParam,
    LPARAM lParam,
    UINT_PTR,
    DWORD_PTR) {
    if (message == SyncMessage()) {
        g_syncPending.store(false);
        AnchorWindowAndOverlay();
        return 0;
    }

    if (message == TaskbarCreatedMessage()) QueueSync(SyncReason::TaskbarCreated);

    switch (message) {
    case WM_WINDOWPOSCHANGING:
        if (g_enabled && !g_applying && hwnd == g_target) {
            auto* position = reinterpret_cast<WINDOWPOS*>(lParam);
            if (position && (position->flags & SWP_NOZORDER) == 0) {
                HWND insertionAfter = nullptr;
                if (FindDesktopInsertionAfter(g_target, GetOverlayWindow(), &insertionAfter)) {
                    position->hwndInsertAfter = insertionAfter;
                } else {
                    // Explorer 重建桌面宿主的短暂窗口内保持原顺序，不能接受外部提层，
                    // 也不能退回可能落到壁纸后方的绝对 HWND_BOTTOM。
                    position->flags |= SWP_NOZORDER;
                }
            }
        }
        break;
    case WM_WINDOWPOSCHANGED:
        if (!g_applying) QueueSync(SyncReason::WindowPosChanged);
        break;
    case WM_SETFOCUS:
        if (!g_applying) QueueSync(SyncReason::SetFocus);
        break;
    case WM_ACTIVATE:
        if (!g_applying) QueueSync(SyncReason::Activate);
        break;
    case WM_SHOWWINDOW:
        if (wParam != FALSE) QueueSync(SyncReason::ShowWindow);
        break;
    case WM_NCDESTROY: {
        const LRESULT result = DefSubclassProc(hwnd, message, wParam, lParam);
        ResetState(false);
        return result;
    }
    default:
        break;
    }

    return DefSubclassProc(hwnd, message, wParam, lParam);
}

bool InstallEventHooks(HWND requested) {
    constexpr DWORD flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
    FailureContext context{};
    context.requested = requested;
    context.target = g_target;
    context.overlay = GetOverlayWindow();
    SetLastError(ERROR_SUCCESS);
    g_foregroundHook = SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_FOREGROUND,
        nullptr,
        WinEventProc,
        0,
        0,
        flags);
    const DWORD foregroundError = g_foregroundHook ? ERROR_SUCCESS : GetLastError();
    if (!g_foregroundHook) {
        RecordFailure("enable", "foreground-hook-install", ResultCode::WinEventHookFailed,
            context, true, foregroundError);
    }
    SetLastError(ERROR_SUCCESS);
    g_reorderHook = SetWinEventHook(
        EVENT_OBJECT_REORDER,
        EVENT_OBJECT_REORDER,
        nullptr,
        WinEventProc,
        0,
        0,
        flags);
    const DWORD reorderError = g_reorderHook ? ERROR_SUCCESS : GetLastError();
    if (!g_reorderHook) {
        RecordFailure("enable", "reorder-hook-install", ResultCode::WinEventHookFailed,
            context, true, reorderError);
    }
    return g_foregroundHook != nullptr && g_reorderHook != nullptr;
}

}

int SetBottom(HWND hwnd, bool enabled) {
    if (!enabled) {
        if (!g_enabled) return static_cast<int>(ResultCode::Success);
        if (hwnd && g_target && hwnd != g_target) {
            FailureContext context{};
            context.requested = hwnd;
            context.target = g_target;
            context.overlay = GetOverlayWindow();
            RecordFailure("disable", "target-mismatch", ResultCode::InvalidWindow, context);
            return static_cast<int>(ResultCode::InvalidWindow);
        }
        const HWND target = g_target;
        const HWND overlay = GetOverlayWindow();
        ResetState(true);
        FailureContext context{};
        context.requested = hwnd;
        context.target = target;
        context.overlay = overlay;
        context.insertionAfter = HWND_TOP;
        context.insertionKnown = true;
        const UINT flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
        BOOL mainMoved = FALSE;
        if (target && IsWindow(target)) {
            context.mainMoveAttempted = true;
            SetLastError(ERROR_SUCCESS);
            mainMoved = SetWindowPos(target, HWND_TOP, 0, 0, 0, 0, flags);
            const DWORD mainError = mainMoved ? ERROR_SUCCESS : GetLastError();
            context.mainMoved = mainMoved != FALSE;
            if (!mainMoved) {
                RecordFailure("disable", "main-set-window-pos", ResultCode::ApplyFailed,
                    context, true, mainError);
            }
        } else {
            RecordFailure("disable", "invalid-target-window", ResultCode::ApplyFailed, context);
        }
        BOOL overlayMoved = TRUE;
        if (mainMoved && overlay && IsWindow(overlay)) {
            context.overlayMoveAttempted = true;
            context.insertionAfter = target;
            SetLastError(ERROR_SUCCESS);
            overlayMoved = SetWindowPos(overlay, target, 0, 0, 0, 0, flags);
            const DWORD overlayError = overlayMoved ? ERROR_SUCCESS : GetLastError();
            context.overlayMoved = overlayMoved != FALSE;
            if (!overlayMoved) {
                RecordFailure("disable", "overlay-set-window-pos", ResultCode::ApplyFailed,
                    context, true, overlayError);
            }
        }
        return mainMoved && overlayMoved
            ? static_cast<int>(ResultCode::Success)
            : static_cast<int>(ResultCode::ApplyFailed);
    }

    FailureContext context{};
    context.requested = hwnd;
    context.target = g_target;
    context.overlay = GetOverlayWindow();
    if (!hwnd || !IsWindow(hwnd)) {
        RecordFailure("enable", "invalid-requested-window", ResultCode::InvalidWindow, context);
        return static_cast<int>(ResultCode::InvalidWindow);
    }
    SetLastError(ERROR_SUCCESS);
    const DWORD windowThreadId = GetWindowThreadProcessId(hwnd, nullptr);
    const DWORD threadError = windowThreadId ? ERROR_SUCCESS : GetLastError();
    if (!windowThreadId || windowThreadId != GetCurrentThreadId()) {
        RecordFailure("enable", windowThreadId ? "wrong-window-thread" : "window-thread-query",
            ResultCode::WrongThread, context, !windowThreadId, threadError);
        return static_cast<int>(ResultCode::WrongThread);
    }
    if (g_enabled && g_target == hwnd) {
        return AnchorWindowAndOverlay("enable", hwnd)
            ? static_cast<int>(ResultCode::Success)
            : static_cast<int>(ResultCode::ApplyFailed);
    }
    if (g_enabled) ResetState(true);

    SetLastError(ERROR_SUCCESS);
    const BOOL subclassInstalled = SetWindowSubclass(hwnd, BottomSubclassProc, kSubclassId, 0);
    const DWORD subclassError = subclassInstalled ? ERROR_SUCCESS : GetLastError();
    if (!subclassInstalled) {
        // Some APIs do not populate last-error on every failure. Preserve zero
        // as observed after clearing it; never reinterpret it as access denied.
        context.target = g_target;
        RecordFailure("enable", "subclass-install", ResultCode::SubclassInstallFailed,
            context, true, subclassError);
        return static_cast<int>(ResultCode::SubclassInstallFailed);
    }
    g_target = hwnd;
    g_ownerThreadId = windowThreadId;
    g_enabled = true;
    if (!InstallEventHooks(hwnd)) {
        ResetState(true);
        return static_cast<int>(ResultCode::WinEventHookFailed);
    }
    if (!AnchorWindowAndOverlay("enable", hwnd)) {
        ResetState(true);
        return static_cast<int>(ResultCode::ApplyFailed);
    }
    return static_cast<int>(ResultCode::Success);
}

int Reassert(HWND hwnd) {
    FailureContext context{};
    context.requested = hwnd;
    context.target = g_target;
    context.overlay = GetOverlayWindow();
    if (!g_enabled || !g_target) {
        RecordFailure("reassert", "controller-not-enabled", ResultCode::NotEnabled, context);
        return static_cast<int>(ResultCode::NotEnabled);
    }
    if (!hwnd || hwnd != g_target || !IsWindow(hwnd)) {
        RecordFailure("reassert", hwnd && hwnd != g_target ? "target-mismatch" : "invalid-requested-window",
            ResultCode::InvalidWindow, context);
        return static_cast<int>(ResultCode::InvalidWindow);
    }
    return AnchorWindowAndOverlay("reassert", hwnd)
        ? static_cast<int>(ResultCode::Success)
        : static_cast<int>(ResultCode::ApplyFailed);
}

const char* GetStatusJson(HWND hwnd) {
    thread_local char json[1024]{};
    const bool targetValid = g_target && IsWindow(g_target);
    const bool requestedMatches = hwnd && targetValid && hwnd == g_target;
    const HWND overlay = GetOverlayWindow();
    const int ordinaryBelow = requestedMatches ? CountOrdinaryVisibleWindowsBelow(g_target) : 0;
    const bool overlayBehind = requestedMatches && overlay ? IsAbove(g_target, overlay) : false;
    const DesktopRelation desktopRelation = requestedMatches
        ? GetDesktopRelation(g_target)
        : DesktopRelation{};
    const bool desktopBehind = requestedMatches && desktopRelation.targetFound &&
        desktopRelation.above == 0 && desktopRelation.below > 0;
    const bool anchored = g_enabled && requestedMatches && ordinaryBelow == 0 && desktopBehind;
    const unsigned int lastSyncReason = g_lastSyncReason.load();
    sprintf_s(
        json,
        "{\"enabled\":%s,\"targetValid\":%s,\"requestedMatches\":%s,"
        "\"anchored\":%s,\"ordinaryWindowsBelow\":%d,\"desktopBehind\":%s,"
        "\"desktopWindowsAbove\":%d,\"desktopWindowsBelow\":%d,\"overlayValid\":%s,"
        "\"overlayBehind\":%s,\"lastApplySucceeded\":%s,\"ownerThreadId\":%lu,"
        "\"syncPending\":%s,\"syncRequestCount\":%llu,\"syncPostCount\":%llu,"
        "\"anchorCheckCount\":%llu,\"anchorNoopCount\":%llu,\"anchorApplyCount\":%llu,"
        "\"lastSyncReason\":\"%s\",\"lastAnchorApplyTickMs\":%llu}",
        g_enabled ? "true" : "false",
        targetValid ? "true" : "false",
        requestedMatches ? "true" : "false",
        anchored ? "true" : "false",
        ordinaryBelow,
        desktopBehind ? "true" : "false",
        desktopRelation.above,
        desktopRelation.below,
        overlay ? "true" : "false",
        overlayBehind ? "true" : "false",
        g_lastApplySucceeded ? "true" : "false",
        static_cast<unsigned long>(g_ownerThreadId),
        g_syncPending.load() ? "true" : "false",
        g_syncRequestCount.load(),
        g_syncPostCount.load(),
        g_anchorCheckCount.load(),
        g_anchorNoopCount.load(),
        g_anchorApplyCount.load(),
        SyncReasonName(lastSyncReason),
        g_lastAnchorApplyTickMs.load());
    return json;
}

const char* GetLastFailureJson() noexcept {
    try {
        FailureEvidence first{};
        FailureEvidence last{};
        unsigned long long count = 0;
        {
            std::lock_guard<std::mutex> lock(g_failureMutex);
            first = g_firstFailure;
            last = g_lastFailure;
            count = g_failureCount;
        }
        thread_local std::string json;
        json.clear();
        json.reserve(8192);
        json = "{\"schemaVersion\":1,\"failureCount\":" + std::to_string(count) +
            ",\"firstFailure\":";
        AppendFailureJson(json, first);
        json += ",\"lastFailure\":";
        AppendFailureJson(json, last);
        json += '}';
        if (json.size() > 8192) {
            return "{\"schemaVersion\":1,\"diagnosticError\":\"snapshot-exceeds-bound\"}";
        }
        return json.c_str();
    } catch (...) {
        // Keep the C ABI safe even when diagnostic allocation/serialization fails.
        return "{\"schemaVersion\":1,\"diagnosticError\":\"serialization-failed\"}";
    }
}

void Shutdown() {
    if (g_enabled) ResetState(true);
}

}
