/**
 * blur_api.cpp — C API 实现
 */

#include "blur_api.h"
#include "blur_engine.h"
#include <VersionHelpers.h>

int Blur_IsSupported(void) {
    if (!IsWindows10OrGreater()) return 0;
    return 1;
}

int Blur_Init(void* hwnd) {
    if (!hwnd || !Blur_IsSupported()) return 0;
    return BlurEngine::Engine::Instance().Initialize(static_cast<HWND>(hwnd)) ? 1 : 0;
}

void Blur_Destroy(void) {
    BlurEngine::Engine::Instance().Destroy();
}

void Blur_SetRadius(float radiusDip) {
    BlurEngine::Engine::Instance().SetRadius(radiusDip);
}

void Blur_SetTint(int r, int g, int b) {
    auto clamp = [](int v) -> uint8_t { return v < 0 ? 0 : (v > 255 ? 255 : (uint8_t)v); };
    BlurEngine::Engine::Instance().SetTint(clamp(r), clamp(g), clamp(b));
}

void Blur_SetEnabled(int enabled) {
    BlurEngine::Engine::Instance().SetEnabled(enabled != 0);
}

void Blur_SetSaturation(float saturation) {
    BlurEngine::Engine::Instance().SetSaturation(saturation);
}

void Blur_SetOpacity(float opacity) {
    BlurEngine::Engine::Instance().SetOpacity(opacity);
}

void Blur_SetCornerRadius(float radiusDip) {
    BlurEngine::Engine::Instance().SetCornerRadius(radiusDip);
}

void Blur_UpdateGeometry(int x, int y, int width, int height) {
    BlurEngine::Engine::Instance().UpdateGeometry(x, y, width, height);
}

void Blur_ReSyncOrder(void) {
    BlurEngine::Engine::Instance().ReSyncZOrder();
}

int Blur_IsInitialized(void) {
    return BlurEngine::Engine::Instance().IsInitialized() ? 1 : 0;
}
