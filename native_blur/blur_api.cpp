/**
 * blur_api.cpp — C API 实现
 */

#include "blur_api.h"
#include "blur_engine.h"
#include <algorithm>
#include <cstdio>
#include <winternl.h>

int Blur_IsSupported(void) {
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    const auto ntdll = GetModuleHandleW(L"ntdll.dll");
    const auto rtlGetVersion = ntdll
        ? reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"))
        : nullptr;
    if (!rtlGetVersion) {
        BlurEngine::Engine::Instance().SetLastError(BlurEngine::BlurErrorCode::UnsupportedSystem);
        return 0;
    }

    RTL_OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    if (rtlGetVersion(&version) != 0) {
        BlurEngine::Engine::Instance().SetLastError(BlurEngine::BlurErrorCode::UnsupportedSystem);
        return 0;
    }
    const bool supported = version.dwMajorVersion > 10 ||
        (version.dwMajorVersion == 10 && version.dwBuildNumber >= 18362);
    BlurEngine::Engine::Instance().SetLastError(
        supported ? BlurEngine::BlurErrorCode::None : BlurEngine::BlurErrorCode::UnsupportedSystem);
    return supported ? 1 : 0;
}

int Blur_Init(void* hwnd) {
    if (!hwnd) {
        BlurEngine::Engine::Instance().SetLastError(BlurEngine::BlurErrorCode::InvalidParentWindow);
        return 0;
    }
    if (!Blur_IsSupported()) return 0;
    return BlurEngine::Engine::Instance().Initialize(static_cast<HWND>(hwnd)) ? 1 : 0;
}

void Blur_ApplyConfig(int enabled, float radiusDip, float saturation, float cornerRadiusDip) {
    BlurEngine::BlurConfig config;
    config.enabled = enabled != 0;
    config.radiusDip = radiusDip;
    config.saturation = saturation;
    config.cornerRadius = cornerRadiusDip;
    BlurEngine::Engine::Instance().SetConfig(config);
}

void Blur_Destroy(void) {
    BlurEngine::Engine::Instance().Destroy();
}

void Blur_SetRadius(float radiusDip) {
    BlurEngine::Engine::Instance().SetRadius(radiusDip);
}

void Blur_SetTint(int r, int g, int b) {
    UNREFERENCED_PARAMETER(r);
    UNREFERENCED_PARAMETER(g);
    UNREFERENCED_PARAMETER(b);
}

void Blur_SetEnabled(int enabled) {
    BlurEngine::Engine::Instance().SetEnabled(enabled != 0);
}

void Blur_SetSaturation(float saturation) {
    BlurEngine::Engine::Instance().SetSaturation(saturation);
}

void Blur_SetOpacity(float opacity) {
    UNREFERENCED_PARAMETER(opacity);
}

void Blur_SetCornerRadius(float radiusDip) {
    BlurEngine::Engine::Instance().SetCornerRadius(radiusDip);
}

void Blur_UpdateGeometry(void) {
    BlurEngine::Engine::Instance().UpdateGeometry();
}

void Blur_ReSyncOrder(void) {
    BlurEngine::Engine::Instance().ReSyncZOrder();
}

int Blur_IsInitialized(void) {
    return BlurEngine::Engine::Instance().IsInitialized() ? 1 : 0;
}

int Blur_IsHealthy(void) {
    return BlurEngine::Engine::Instance().IsHealthy() ? 1 : 0;
}

int Blur_GetLastErrorCode(void) {
    return static_cast<int>(BlurEngine::Engine::Instance().GetLastError());
}

const char* Blur_GetLastErrorMessage(void) {
    using BlurEngine::BlurErrorCode;
    switch (BlurEngine::Engine::Instance().GetLastError()) {
    case BlurErrorCode::None: return "none";
    case BlurErrorCode::UnsupportedSystem: return "unsupported_system";
    case BlurErrorCode::InvalidParentWindow: return "invalid_parent_window";
    case BlurErrorCode::ComInitializationFailed: return "com_initialization_failed";
    case BlurErrorCode::DispatcherQueueFailed: return "dispatcher_queue_failed";
    case BlurErrorCode::OverlayWindowFailed: return "overlay_window_failed";
    case BlurErrorCode::CompositionTargetFailed: return "composition_target_failed";
    case BlurErrorCode::EffectGraphFailed: return "effect_graph_failed";
    case BlurErrorCode::InitializationTimeout: return "initialization_timeout";
    default: return "unknown_failure";
    }
}

const char* WindowMotion_GetSnapshotJson(void* hwndValue) {
    thread_local char json[768]{};
    const HWND hwnd = static_cast<HWND>(hwndValue);
    RECT windowRect{}, clientRect{};
    MONITORINFO monitorInfo{};
    monitorInfo.cbSize = sizeof(monitorInfo);

    const bool windowValid = hwnd && IsWindow(hwnd) &&
        GetWindowRect(hwnd, &windowRect) && GetClientRect(hwnd, &clientRect);
    const HMONITOR monitor = windowValid
        ? MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        : nullptr;
    const bool monitorValid = monitor && GetMonitorInfoW(monitor, &monitorInfo);

    sprintf_s(
        json,
        "{\"window\":{\"valid\":%s,\"left\":%ld,\"top\":%ld,\"right\":%ld,\"bottom\":%ld,"
        "\"width\":%ld,\"height\":%ld,\"clientWidth\":%ld,\"clientHeight\":%ld,\"dpi\":%u},"
        "\"monitor\":{\"valid\":%s,\"left\":%ld,\"top\":%ld,\"right\":%ld,\"bottom\":%ld,"
        "\"workLeft\":%ld,\"workTop\":%ld,\"workRight\":%ld,\"workBottom\":%ld}}",
        windowValid ? "true" : "false",
        windowRect.left, windowRect.top, windowRect.right, windowRect.bottom,
        windowRect.right - windowRect.left, windowRect.bottom - windowRect.top,
        clientRect.right - clientRect.left, clientRect.bottom - clientRect.top,
        windowValid ? GetDpiForWindow(hwnd) : 0,
        monitorValid ? "true" : "false",
        monitorInfo.rcMonitor.left, monitorInfo.rcMonitor.top,
        monitorInfo.rcMonitor.right, monitorInfo.rcMonitor.bottom,
        monitorInfo.rcWork.left, monitorInfo.rcWork.top,
        monitorInfo.rcWork.right, monitorInfo.rcWork.bottom);
    return json;
}

namespace {
struct EdgeExposureContext {
    HMONITOR currentMonitor = nullptr;
    RECT currentBounds{};
    RECT windowBounds{};
    int side = 0;
    bool blocked = false;
};

BOOL CALLBACK DetectAdjacentMonitor(
    HMONITOR monitor,
    HDC,
    LPRECT,
    LPARAM contextValue) {
    auto* context = reinterpret_cast<EdgeExposureContext*>(contextValue);
    if (!context || context->blocked || monitor == context->currentMonitor) return TRUE;

    MONITORINFO info{};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) return TRUE;

    const bool touchesEdge = context->side < 0
        ? info.rcMonitor.right == context->currentBounds.left
        : info.rcMonitor.left == context->currentBounds.right;
    if (!touchesEdge) return TRUE;

    const LONG overlapTop = std::max(context->windowBounds.top, info.rcMonitor.top);
    const LONG overlapBottom = std::min(context->windowBounds.bottom, info.rcMonitor.bottom);
    if (overlapBottom > overlapTop) context->blocked = true;
    return context->blocked ? FALSE : TRUE;
}
}

int WindowMotion_IsEdgeExposed(void* hwndValue, int side) {
    const HWND hwnd = static_cast<HWND>(hwndValue);
    if (!hwnd || !IsWindow(hwnd) || (side != -1 && side != 1)) return 0;

    RECT windowBounds{};
    if (!GetWindowRect(hwnd, &windowBounds)) return 0;

    const HMONITOR currentMonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO currentInfo{};
    currentInfo.cbSize = sizeof(currentInfo);
    if (!currentMonitor || !GetMonitorInfoW(currentMonitor, &currentInfo)) return 0;

    // 任务栏占据左/右边时，工作区边缘并不是桌面的真实外边缘。
    if (side < 0 && currentInfo.rcWork.left != currentInfo.rcMonitor.left) return 0;
    if (side > 0 && currentInfo.rcWork.right != currentInfo.rcMonitor.right) return 0;

    EdgeExposureContext context{
        currentMonitor,
        currentInfo.rcMonitor,
        windowBounds,
        side,
        false
    };
    if (!EnumDisplayMonitors(
            nullptr,
            nullptr,
            DetectAdjacentMonitor,
            reinterpret_cast<LPARAM>(&context)) &&
        !context.blocked) {
        return 0;
    }
    return context.blocked ? 0 : 1;
}

int WindowMotion_MoveWindow(void* hwndValue, int physicalX, int physicalY) {
    const HWND hwnd = static_cast<HWND>(hwndValue);
    if (!hwnd || !IsWindow(hwnd)) return 0;

    const BOOL moved = SetWindowPos(
        hwnd,
        nullptr,
        physicalX,
        physicalY,
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    if (!moved) return 0;

    auto& engine = BlurEngine::Engine::Instance();
    if (engine.GetParentWindow() == hwnd) {
        engine.UpdateGeometry();
    }
    return 1;
}
