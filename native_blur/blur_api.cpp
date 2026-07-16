/**
 * blur_api.cpp — C API 实现
 */

#include "blur_api.h"
#include "blur_engine.h"
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
