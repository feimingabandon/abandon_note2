/**
 * blur_engine.cpp — Windows.UI.Composition 模糊引擎实现
 *
 * 关键技术决策：
 *   1. 独立 overlay 窗口策略：避免与 Chromium DComp 树 Z-order 冲突
 *   2. STA 线程架构：WinRT Compositor 必须在 STA 线程创建
 *   3. 窗口消息队列：跨线程安全执行 WinRT 操作
 *   4. WRL 效果类 + C++/WinRT Compositor 桥接
 */

#include "blur_engine.h"
#include "blur_effects.h"

#include <windows.ui.composition.interop.h>
#include <DispatcherQueue.h>
#include <shellscalingapi.h>

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

using namespace Microsoft::UI::Composition::Effects;
using namespace Microsoft::WRL;

namespace BlurEngine {

// ---- 自定义窗口消息 ----
#define WM_BLUR_UPDATE_GEOMETRY  (WM_USER + 100)
#define WM_BLUR_APPLY_CONFIG     (WM_USER + 101)
#define WM_BLUR_SHOW             (WM_USER + 102)
#define WM_BLUR_HIDE             (WM_USER + 103)
#define WM_BLUR_DESTROY          (WM_USER + 104)

// ---- 效果管线硬编码参数 ----
// 混合模式: Luminosity（保留底层明暗，仅替换色相）
// 模糊优化: Balanced
// 边框模式: Hard

// ---- 单例 ----
Engine& Engine::Instance() {
    static Engine instance;
    return instance;
}

bool Engine::s_classRegistered = false;

// ============================================================
// 公共 API
// ============================================================

bool Engine::Initialize(HWND parentHwnd) {
    if (m_initialized.load()) return true;
    m_parentHwnd = parentHwnd;
    m_running.store(true);
    m_staThread = std::thread(&Engine::StaThreadProc, this, parentHwnd);
    for (int i = 0; i < 50 && !m_initialized.load(); ++i) Sleep(100);
    return m_initialized.load();
}

void Engine::Destroy() {
    if (!m_running.load()) return;
    StopStaThread();
    m_initialized.store(false);
    m_running.store(false);
}

void Engine::SetConfig(const BlurConfig& config) {
    {
        std::lock_guard<std::mutex> lock(m_configMutex);
        m_config = config;
    }
    if (m_overlayHwnd) PostMessage(m_overlayHwnd, WM_BLUR_APPLY_CONFIG, 0, 0);
}

void Engine::SetRadius(float radiusDip) {
    BlurConfig cfg = GetConfig();
    cfg.radiusDip = (radiusDip < 0) ? 0 : (radiusDip > 100) ? 100 : radiusDip;
    SetConfig(cfg);
}

void Engine::SetTint(uint8_t r, uint8_t g, uint8_t b) {
    BlurConfig cfg = GetConfig();
    cfg.tintR = r; cfg.tintG = g; cfg.tintB = b;
    SetConfig(cfg);
}

void Engine::SetEnabled(bool enabled) {
    BlurConfig cfg = GetConfig();
    cfg.enabled = enabled;
    SetConfig(cfg);
    if (m_overlayHwnd) PostMessage(m_overlayHwnd, enabled ? WM_BLUR_SHOW : WM_BLUR_HIDE, 0, 0);
}

void Engine::SetSaturation(float saturation) {
    BlurConfig cfg = GetConfig();
    cfg.saturation = (saturation < 0) ? 0 : (saturation > 2) ? 2 : saturation;
    SetConfig(cfg);
}

void Engine::SetCornerRadius(float radiusDip) {
    BlurConfig cfg = GetConfig();
    cfg.cornerRadius = (radiusDip < 0) ? 0 : (radiusDip > 30) ? 30 : radiusDip;
    SetConfig(cfg);
}

BlurConfig Engine::GetConfig() const {
    std::lock_guard<std::mutex> lock(m_configMutex);
    return m_config;
}

void Engine::UpdateGeometry(int x, int y, int width, int height) {
    // 缓存到成员变量，STA 线程读取
    m_cachedX = x; m_cachedY = y; m_cachedW = width; m_cachedH = height;
    if (m_overlayHwnd) PostMessage(m_overlayHwnd, WM_BLUR_UPDATE_GEOMETRY, 0, 0);
}

void Engine::ReSyncZOrder() {
    if (!m_overlayHwnd || !m_parentHwnd) return;
    SetWindowPos(m_overlayHwnd, m_parentHwnd,
        0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

void Engine::Show() { if (m_overlayHwnd) PostMessage(m_overlayHwnd, WM_BLUR_SHOW, 0, 0); }
void Engine::Hide() { if (m_overlayHwnd) PostMessage(m_overlayHwnd, WM_BLUR_HIDE, 0, 0); }
Engine::~Engine() { Destroy(); }

// ============================================================
// STA 线程主循环
// ============================================================

void Engine::StaThreadProc(HWND parentHwnd) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) return;

    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    EnsureDispatcherQueue();
    if (!m_dispatcherQueueController) { CoUninitialize(); return; }

    if (!s_classRegistered) {
        WNDCLASSEXW wc = {};
        wc.cbSize = sizeof(WNDCLASSEXW);
        wc.lpfnWndProc = OverlayWndProc;
        wc.hInstance = GetModuleHandle(nullptr);
        wc.lpszClassName = OVERLAY_CLASS;
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.hCursor = nullptr;
        wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
        s_classRegistered = RegisterClassExW(&wc) != 0;
    }

    CreateOverlayWindow(parentHwnd);
    if (!m_overlayHwnd) { Cleanup(); return; }

    CreateCompositor(m_overlayHwnd);
    if (!m_compositor || !m_target) { Cleanup(); return; }

    BuildEffectGraph();
    m_initialized.store(true);

    MSG msg;
    while (m_running.load() && GetMessage(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    Cleanup();
}

void Engine::Cleanup() {
    if (m_blurVisual && m_target) m_target.Root(nullptr);
    m_blurVisual = nullptr;
    m_clipGeometry = nullptr;
    m_effectBrush = nullptr;
    m_target = nullptr;
    m_compositor = nullptr;
    if (m_overlayHwnd) { DestroyWindow(m_overlayHwnd); m_overlayHwnd = nullptr; }
    if (m_dispatcherQueueController) {
        m_dispatcherQueueController = nullptr;
    }
    CoUninitialize();
}

void Engine::StopStaThread() {
    m_running.store(false);
    if (m_overlayHwnd) PostMessage(m_overlayHwnd, WM_BLUR_DESTROY, 0, 0);
    if (m_staThread.joinable()) m_staThread.join();
}

// ============================================================
// Overlay 窗口创建
// ============================================================

void Engine::CreateOverlayWindow(HWND parentHwnd) {
    RECT parentRect;
    if (!GetWindowRect(parentHwnd, &parentRect)) parentRect = { 0, 0, 800, 600 };
    int w = parentRect.right - parentRect.left;
    int h = parentRect.bottom - parentRect.top;

    m_cachedX = parentRect.left; m_cachedY = parentRect.top;
    m_cachedW = w; m_cachedH = h;

    m_overlayHwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_NOREDIRECTIONBITMAP,
        OVERLAY_CLASS, L"BlurOverlay", WS_POPUP,
        m_cachedX, m_cachedY, m_cachedW, m_cachedH,
        nullptr, nullptr, GetModuleHandle(nullptr), this);

    if (m_overlayHwnd) {
        SetWindowPos(m_overlayHwnd, parentHwnd,
            0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        ShowWindow(m_overlayHwnd, SW_HIDE);
    }
}

// ============================================================
// DispatcherQueue / Compositor
// ============================================================

void Engine::EnsureDispatcherQueue() {
    DispatcherQueueOptions opts{ sizeof(DispatcherQueueOptions), DQTYPE_THREAD_CURRENT, DQTAT_COM_STA };
    winrt::Windows::System::DispatcherQueueController ctrl{ nullptr };
    HRESULT hr = CreateDispatcherQueueController(opts,
        reinterpret_cast<ABI::Windows::System::IDispatcherQueueController**>(winrt::put_abi(ctrl)));
    if (SUCCEEDED(hr)) m_dispatcherQueueController = ctrl;
}

void Engine::CreateCompositor(HWND hwnd) {
    m_compositor = Compositor();
    namespace abi = ABI::Windows::UI::Composition::Desktop;
    auto interop = m_compositor.as<abi::ICompositorDesktopInterop>();
    DesktopWindowTarget target{ nullptr };
    HRESULT hr = interop->CreateDesktopWindowTarget(hwnd, false,
        reinterpret_cast<abi::IDesktopWindowTarget**>(winrt::put_abi(target)));
    if (SUCCEEDED(hr)) m_target = target;
}

// ============================================================
// Effect Graph 构建（4 节点：backdrop → 高斯模糊 → 颜色 → 混合）
// ============================================================

void Engine::BuildEffectGraph() {
    if (!m_compositor || !m_target) return;

    BlurConfig cfg;
    { std::lock_guard<std::mutex> lock(m_configMutex); cfg = m_config; }

    try {
        // ---- 节点1: backdrop 输入源 ----
        winrt::Windows::UI::Composition::CompositionEffectSourceParameter backdropParam(L"backdrop");
        auto backdropAbi = reinterpret_cast<ABI::Windows::Graphics::Effects::IGraphicsEffectSource*>(
            winrt::get_abi(backdropParam));

        // ---- 节点2: 高斯模糊 ----
        ComPtr<IGaussianBlurEffect> blurWrl = Make<GaussianBlurEffect>();
        blurWrl->put_BlurAmount(cfg.radiusDip);
        blurWrl->put_BorderMode(EffectBorderMode_Hard);
        blurWrl->put_Optimization(EffectOptimization_Balanced);
        blurWrl->put_Source(backdropAbi);
        ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffectSource> blurSrc;
        blurWrl.As(&blurSrc);

        // ---- 节点3: 饱和度 —— 模糊后加浓颜色 ----
        ComPtr<SaturationEffect> satWrl = Make<SaturationEffect>();
        satWrl->put_Saturation(cfg.saturation);
        satWrl->put_Source(blurSrc.Get());
        ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffectSource> satSrc;
        satWrl.As(&satSrc);

        // ---- 节点4: 纯色源 ----
        ComPtr<ColorSourceEffect> colorWrl = Make<ColorSourceEffect>();
        ABI::Windows::UI::Color tintColor{ 255, cfg.tintR, cfg.tintG, cfg.tintB };
        colorWrl->put_Color(tintColor);
        ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffectSource> colorSrc;
        colorWrl.As(&colorSrc);

        // ---- 节点5: MULTIPLY 混合 —— 白色=无形变，着色=有色玻璃 ----
        ComPtr<BlendEffect> blendWrl = Make<BlendEffect>();
        blendWrl->put_Mode(BlendEffectMode_Multiply);
        blendWrl->put_Background(satSrc.Get());
        blendWrl->put_Foreground(colorSrc.Get());

        // ---- WRL → C++/WinRT 桥接 ----
        winrt::Windows::Graphics::Effects::IGraphicsEffect rootEffect{ nullptr };
        winrt::check_hresult(blendWrl.CopyTo(
            winrt::guid_of<winrt::Windows::Graphics::Effects::IGraphicsEffect>(),
            winrt::put_abi(rootEffect)));

        // ---- EffectFactory + Brush ----
        auto effectFactory = m_compositor.CreateEffectFactory(rootEffect);
        m_effectBrush = effectFactory.CreateBrush();

        auto backdropBrush = m_compositor.CreateBackdropBrush();
        m_effectBrush.SetSourceParameter(L"backdrop", backdropBrush);

        // ---- 单层 SpriteVisual ----
        m_blurVisual = m_compositor.CreateSpriteVisual();
        m_blurVisual.Brush(m_effectBrush);
        m_target.Root(m_blurVisual);

        UpdateVisualSize();
        ApplyClip();
    }
    catch (...) {
        m_blurVisual = nullptr;
        m_effectBrush = nullptr;
    }
}

// ============================================================
// 参数更新：全量重建（简化版，用户调节频率低）
// ============================================================

void Engine::UpdateEffectParameters() {
    if (!m_compositor || !m_blurVisual) return;

    BlurConfig cfg;
    { std::lock_guard<std::mutex> lock(m_configMutex); cfg = m_config; }

    try {
        // 重建 Effect Graph（同上单管线）
        winrt::Windows::UI::Composition::CompositionEffectSourceParameter backdropParam(L"backdrop");
        auto backdropAbi = reinterpret_cast<ABI::Windows::Graphics::Effects::IGraphicsEffectSource*>(
            winrt::get_abi(backdropParam));

        ComPtr<IGaussianBlurEffect> blurWrl = Make<GaussianBlurEffect>();
        blurWrl->put_BlurAmount(cfg.radiusDip);
        blurWrl->put_BorderMode(EffectBorderMode_Hard);
        blurWrl->put_Optimization(EffectOptimization_Balanced);
        blurWrl->put_Source(backdropAbi);
        ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffectSource> blurSrc;
        blurWrl.As(&blurSrc);

        ComPtr<SaturationEffect> satWrl = Make<SaturationEffect>();
        satWrl->put_Saturation(cfg.saturation);
        satWrl->put_Source(blurSrc.Get());
        ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffectSource> satSrc;
        satWrl.As(&satSrc);

        ComPtr<ColorSourceEffect> colorWrl = Make<ColorSourceEffect>();
        ABI::Windows::UI::Color tintColor{ 255, cfg.tintR, cfg.tintG, cfg.tintB };
        colorWrl->put_Color(tintColor);
        ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffectSource> colorSrc;
        colorWrl.As(&colorSrc);

        ComPtr<BlendEffect> blendWrl = Make<BlendEffect>();
        blendWrl->put_Mode(BlendEffectMode_Multiply);
        blendWrl->put_Background(satSrc.Get());
        blendWrl->put_Foreground(colorSrc.Get());

        winrt::Windows::Graphics::Effects::IGraphicsEffect rootEffect{ nullptr };
        winrt::check_hresult(blendWrl.CopyTo(
            winrt::guid_of<winrt::Windows::Graphics::Effects::IGraphicsEffect>(),
            winrt::put_abi(rootEffect)));

        auto effectFactory = m_compositor.CreateEffectFactory(rootEffect);
        auto newBrush = effectFactory.CreateBrush();
        auto backdropBrush = m_compositor.CreateBackdropBrush();
        newBrush.SetSourceParameter(L"backdrop", backdropBrush);
        m_effectBrush = newBrush;
        m_blurVisual.Brush(m_effectBrush);
        ApplyClip();
    }
    catch (...) { }
}

// ============================================================
// DPI / 尺寸
// ============================================================

void Engine::UpdateVisualSize() {
    if (!m_blurVisual || !m_overlayHwnd) return;
    RECT r;
    GetClientRect(m_overlayHwnd, &r);
    int pw = r.right - r.left, ph = r.bottom - r.top;
    if (pw <= 0 || ph <= 0) return;
    float scale = static_cast<float>(GetDpiForWindow(m_overlayHwnd)) / 96.0f;
    m_blurVisual.Size({ static_cast<float>(pw) / scale, static_cast<float>(ph) / scale });
    if (m_clipGeometry) m_clipGeometry.Size({ static_cast<float>(pw) / scale, static_cast<float>(ph) / scale });
}

void Engine::ApplyClip() {
    if (!m_compositor || !m_blurVisual) return;

    BlurConfig cfg;
    { std::lock_guard<std::mutex> lock(m_configMutex); cfg = m_config; }

    // 创建或更新圆角裁剪几何体
    if (!m_clipGeometry) {
        m_clipGeometry = m_compositor.CreateRoundedRectangleGeometry();
    }

    m_clipGeometry.CornerRadius({ cfg.cornerRadius, cfg.cornerRadius });

    // 同步几何体尺寸与视觉尺寸一致
    auto visSize = m_blurVisual.Size();
    m_clipGeometry.Size(visSize);

    // 应用裁剪
    auto clip = m_compositor.CreateGeometricClip(m_clipGeometry);
    m_blurVisual.Clip(clip);
}

void Engine::HandleDpiChanged(WPARAM wParam, LPARAM lParam) {
    if (!m_overlayHwnd) return;
    RECT* suggested = reinterpret_cast<RECT*>(lParam);
    if (suggested) {
        SetWindowPos(m_overlayHwnd, nullptr,
            suggested->left, suggested->top,
            suggested->right - suggested->left,
            suggested->bottom - suggested->top,
            SWP_NOZORDER | SWP_NOACTIVATE);
    }
    UpdateVisualSize();
    if (m_parentHwnd && IsWindow(m_parentHwnd)) {
        SetWindowPos(m_overlayHwnd, m_parentHwnd,
            0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

// ============================================================
// Overlay 窗口过程
// ============================================================

LRESULT CALLBACK Engine::OverlayWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    Engine* self = nullptr;
    if (msg == WM_CREATE) {
        auto* cs = reinterpret_cast<CREATESTRUCT*>(lParam);
        self = static_cast<Engine*>(cs->lpCreateParams);
        SetWindowLongPtr(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        return 0;
    }
    self = reinterpret_cast<Engine*>(GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (!self) return DefWindowProc(hwnd, msg, wParam, lParam);

    switch (msg) {
    case WM_BLUR_UPDATE_GEOMETRY:
        // 使用缓存坐标（来自 UpdateGeometry 调用）
        SetWindowPos(hwnd, self->m_parentHwnd,
            self->m_cachedX, self->m_cachedY, self->m_cachedW, self->m_cachedH,
            SWP_NOACTIVATE | SWP_NOZORDER);
        self->UpdateVisualSize();
        return 0;

    case WM_DPICHANGED:
        self->HandleDpiChanged(wParam, lParam);
        return 0;

    case WM_BLUR_APPLY_CONFIG:
        self->UpdateEffectParameters();
        {
            auto cfg = self->GetConfig();
            ShowWindow(hwnd, cfg.enabled ? SW_SHOWNOACTIVATE : SW_HIDE);
        }
        return 0;

    case WM_BLUR_SHOW:
        if (self->GetConfig().enabled) {
            if (self->m_parentHwnd)
                SetWindowPos(hwnd, self->m_parentHwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        return 0;

    case WM_BLUR_HIDE:
        ShowWindow(hwnd, SW_HIDE);
        return 0;

    case WM_BLUR_DESTROY:
        self->m_running.store(false);
        PostQuitMessage(0);
        return 0;

    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

} // namespace BlurEngine
