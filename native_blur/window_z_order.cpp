#include "window_z_order.h"

#include "blur_engine.h"

#include <atomic>
#include <commctrl.h>
#include <cstdio>
#include <cwchar>

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
bool FindDesktopInsertionAfter(HWND target, HWND overlay, HWND* insertionAfter) {
    if (!insertionAfter) return false;

    HWND previous = nullptr;
    HWND candidate = GetTopWindow(nullptr);
    while (candidate) {
        if (candidate != target && candidate != overlay) {
            if (IsDesktopSurfaceWindow(candidate)) {
                *insertionAfter = previous ? previous : HWND_TOP;
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

bool AnchorWindowAndOverlay() {
    if (!g_enabled || !g_target || !IsWindow(g_target)) return false;

    const HWND overlay = GetOverlayWindow();
    const DesktopRelation desktopRelation = GetDesktopRelation(g_target);
    const bool mainAlreadyAnchored = desktopRelation.targetFound &&
        desktopRelation.above == 0 && desktopRelation.below > 0 &&
        CountOrdinaryVisibleWindowsBelow(g_target) == 0;
    const bool overlayAlreadyAdjacent = !overlay || GetWindow(g_target, GW_HWNDNEXT) == overlay;
    if (mainAlreadyAnchored && overlayAlreadyAdjacent) {
        g_lastApplySucceeded = true;
        return true;
    }

    g_applying = true;
    const UINT flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    HWND insertionAfter = nullptr;
    const bool desktopFound = FindDesktopInsertionAfter(g_target, overlay, &insertionAfter);
    const BOOL mainMoved = desktopFound
        ? SetWindowPos(g_target, insertionAfter, 0, 0, 0, 0, flags)
        : FALSE;

    BOOL overlayMoved = TRUE;
    if (mainMoved && overlay) {
        // 主窗口先进入普通窗口带底部，再把 Overlay 紧贴到它后方。这样即使
        // 毛玻璃开关关闭，Overlay 生命周期仍不会改变主窗口置底能力。
        overlayMoved = SetWindowPos(overlay, g_target, 0, 0, 0, 0, flags);
    }
    g_applying = false;
    g_lastApplySucceeded = mainMoved != FALSE && overlayMoved != FALSE;
    return g_lastApplySucceeded;
}

void QueueSync() {
    if (!g_enabled || !g_target || !IsWindow(g_target)) return;
    bool expected = false;
    if (!g_syncPending.compare_exchange_strong(expected, true)) return;
    if (!PostMessageW(g_target, SyncMessage(), 0, 0)) g_syncPending.store(false);
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
    DWORD,
    HWND,
    LONG,
    LONG,
    DWORD,
    DWORD) {
    QueueSync();
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

    if (message == TaskbarCreatedMessage()) QueueSync();

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
    case WM_SETFOCUS:
    case WM_ACTIVATE:
        if (!g_applying) QueueSync();
        break;
    case WM_SHOWWINDOW:
        if (wParam != FALSE) QueueSync();
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

bool InstallEventHooks() {
    constexpr DWORD flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
    g_foregroundHook = SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_FOREGROUND,
        nullptr,
        WinEventProc,
        0,
        0,
        flags);
    g_reorderHook = SetWinEventHook(
        EVENT_OBJECT_REORDER,
        EVENT_OBJECT_REORDER,
        nullptr,
        WinEventProc,
        0,
        0,
        flags);
    return g_foregroundHook != nullptr && g_reorderHook != nullptr;
}

}

int SetBottom(HWND hwnd, bool enabled) {
    if (!enabled) {
        if (!g_enabled) return static_cast<int>(ResultCode::Success);
        if (hwnd && g_target && hwnd != g_target) return static_cast<int>(ResultCode::InvalidWindow);
        const HWND target = g_target;
        const HWND overlay = GetOverlayWindow();
        ResetState(true);
        const UINT flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
        const BOOL mainMoved = target && IsWindow(target)
            ? SetWindowPos(target, HWND_TOP, 0, 0, 0, 0, flags)
            : FALSE;
        const BOOL overlayMoved = mainMoved && overlay && IsWindow(overlay)
            ? SetWindowPos(overlay, target, 0, 0, 0, 0, flags)
            : TRUE;
        return mainMoved && overlayMoved
            ? static_cast<int>(ResultCode::Success)
            : static_cast<int>(ResultCode::ApplyFailed);
    }

    if (!hwnd || !IsWindow(hwnd)) return static_cast<int>(ResultCode::InvalidWindow);
    const DWORD windowThreadId = GetWindowThreadProcessId(hwnd, nullptr);
    if (!windowThreadId || windowThreadId != GetCurrentThreadId()) {
        return static_cast<int>(ResultCode::WrongThread);
    }
    if (g_enabled && g_target == hwnd) {
        return AnchorWindowAndOverlay()
            ? static_cast<int>(ResultCode::Success)
            : static_cast<int>(ResultCode::ApplyFailed);
    }
    if (g_enabled) ResetState(true);

    if (!SetWindowSubclass(hwnd, BottomSubclassProc, kSubclassId, 0)) {
        return static_cast<int>(ResultCode::SubclassInstallFailed);
    }
    g_target = hwnd;
    g_ownerThreadId = windowThreadId;
    g_enabled = true;
    if (!InstallEventHooks()) {
        ResetState(true);
        return static_cast<int>(ResultCode::WinEventHookFailed);
    }
    if (!AnchorWindowAndOverlay()) {
        ResetState(true);
        return static_cast<int>(ResultCode::ApplyFailed);
    }
    return static_cast<int>(ResultCode::Success);
}

int Reassert(HWND hwnd) {
    if (!g_enabled || !g_target) return static_cast<int>(ResultCode::NotEnabled);
    if (!hwnd || hwnd != g_target || !IsWindow(hwnd)) {
        return static_cast<int>(ResultCode::InvalidWindow);
    }
    return AnchorWindowAndOverlay()
        ? static_cast<int>(ResultCode::Success)
        : static_cast<int>(ResultCode::ApplyFailed);
}

const char* GetStatusJson(HWND hwnd) {
    thread_local char json[768]{};
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
    sprintf_s(
        json,
        "{\"enabled\":%s,\"targetValid\":%s,\"requestedMatches\":%s,"
        "\"anchored\":%s,\"ordinaryWindowsBelow\":%d,\"desktopBehind\":%s,"
        "\"desktopWindowsAbove\":%d,\"desktopWindowsBelow\":%d,\"overlayValid\":%s,"
        "\"overlayBehind\":%s,\"lastApplySucceeded\":%s,\"ownerThreadId\":%lu}",
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
        static_cast<unsigned long>(g_ownerThreadId));
    return json;
}

void Shutdown() {
    if (g_enabled) ResetState(true);
}

}
