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
#include <algorithm>
#include <chrono>

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
#define WM_BLUR_SYNC_ZORDER      (WM_USER + 105)

// ---- 效果管线硬编码参数 ----
// 模糊优化: Balanced；边框模式: Hard

// ---- 单例 ----
Engine& Engine::Instance() {
    // 进程级单例故意不析构：若第三方 WinRT 调用永久卡死，超时路径会分离
    // STA 线程。保留 Engine 存储到进程结束可避免分离线程访问已析构的 mutex/atomic。
    static Engine* instance = new Engine();
    return *instance;
}

bool Engine::s_classRegistered = false;

// ============================================================
// 公共 API
// ============================================================

bool Engine::Initialize(HWND parentHwnd) {
    if (m_initialized.load()) return true;
    if (m_threadAbandoned.load()) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        return false;
    }
    m_lastError.store(BlurErrorCode::None);
    if (!parentHwnd || !IsWindow(parentHwnd)) {
        m_lastError.store(BlurErrorCode::InvalidParentWindow);
        return false;
    }

    // 失败的旧线程必须先回收，避免对 joinable std::thread 再赋值导致 terminate。
    if (m_staThread.joinable() && !StopStaThread(2'000)) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(m_initMutex);
        m_initCompleted = false;
        m_initSuccess = false;
    }
    m_parentHwnd = parentHwnd;
    m_running.store(true);
    m_staThread = std::thread(&Engine::StaThreadProc, this, parentHwnd);

    std::unique_lock<std::mutex> lock(m_initMutex);
    const bool completed = m_initCv.wait_for(lock, std::chrono::seconds(5), [this] {
        return m_initCompleted;
    });
    const bool success = completed && m_initSuccess;
    lock.unlock();

    if (!success) {
        const bool timedOut = !completed;
        if (timedOut) m_lastError.store(BlurErrorCode::InitializationTimeout);
        StopStaThread(2'000);
        if (timedOut) m_lastError.store(BlurErrorCode::InitializationTimeout);
        return false;
    }
    return true;
}

void Engine::Destroy() {
    StopStaThread(5'000);
    m_initialized.store(false);
    m_runtimeHealthy.store(false);
    m_running.store(false);
}

void Engine::SetConfig(const BlurConfig& config) {
    BlurConfig normalized = config;
    normalized.radiusDip = (normalized.radiusDip < 0.0f) ? 0.0f :
        (normalized.radiusDip > 40.0f) ? 40.0f : normalized.radiusDip;
    normalized.saturation = (normalized.saturation < 0.0f) ? 0.0f :
        (normalized.saturation > 2.0f) ? 2.0f : normalized.saturation;
    normalized.cornerRadius = (normalized.cornerRadius < 0.0f) ? 0.0f :
        (normalized.cornerRadius > 30.0f) ? 30.0f : normalized.cornerRadius;
    {
        std::lock_guard<std::mutex> lock(m_configMutex);
        m_config = normalized;
    }
    if (HWND hwnd = m_messageHwnd.load()) {
        if (!m_configUpdatePending.exchange(true)) {
            if (!PostMessage(hwnd, WM_BLUR_APPLY_CONFIG, 0, 0)) {
                m_configUpdatePending.store(false);
                m_lastError.store(BlurErrorCode::UnknownFailure);
                m_runtimeHealthy.store(false);
            }
        }
    } else if (m_initialized.load()) {
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
    }
}

void Engine::SetRadius(float radiusDip) {
    BlurConfig cfg = GetConfig();
    cfg.radiusDip = radiusDip;
    SetConfig(cfg);
}

void Engine::SetEnabled(bool enabled) {
    BlurConfig cfg = GetConfig();
    cfg.enabled = enabled;
    SetConfig(cfg);
}

void Engine::SetSaturation(float saturation) {
    BlurConfig cfg = GetConfig();
    cfg.saturation = saturation;
    SetConfig(cfg);
}

void Engine::SetCornerRadius(float radiusDip) {
    BlurConfig cfg = GetConfig();
    cfg.cornerRadius = radiusDip;
    SetConfig(cfg);
}

BlurConfig Engine::GetConfig() const {
    std::lock_guard<std::mutex> lock(m_configMutex);
    return m_config;
}

void Engine::UpdateGeometry() {
    if (HWND hwnd = m_messageHwnd.load()) {
        if (!m_geometryUpdatePending.exchange(true)) {
            if (!PostMessage(hwnd, WM_BLUR_UPDATE_GEOMETRY, 0, 0)) {
                m_geometryUpdatePending.store(false);
                m_lastError.store(BlurErrorCode::UnknownFailure);
                m_runtimeHealthy.store(false);
            }
        }
    } else if (m_initialized.load()) {
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
    }
}

bool Engine::MoveParentAndOverlay(
    HWND parentHwnd,
    int physicalX,
    int physicalY,
    DWORD syncTimeoutMs) {
    const HWND overlayHwnd = m_messageHwnd.load();
    if (parentHwnd != m_parentHwnd ||
        !parentHwnd || !IsWindow(parentHwnd) ||
        !overlayHwnd || !IsWindow(overlayHwnd)) {
        return false;
    }

    RECT parentBefore{};
    if (!GetWindowRect(parentHwnd, &parentBefore)) return false;
    const int width = parentBefore.right - parentBefore.left;
    const int height = parentBefore.bottom - parentBefore.top;
    if (width <= 0 || height <= 0) return false;

    // 将 Electron HWND 和 Overlay HWND 置于同一窗口位置批次。Overlay 虽属于
    // STA 线程，但 Win32 HWND 位置可由其他线程提交；Composition 对象
    // 不在此处访问。第二个操作同时使 Overlay 紧贴父窗口后方。
    HDWP deferred = BeginDeferWindowPos(2);
    if (!deferred) return false;
    deferred = DeferWindowPos(
        deferred,
        parentHwnd,
        nullptr,
        physicalX,
        physicalY,
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    if (!deferred) return false;
    deferred = DeferWindowPos(
        deferred,
        overlayHwnd,
        parentHwnd,
        physicalX,
        physicalY,
        width,
        height,
        SWP_NOACTIVATE);
    if (!deferred || !EndDeferWindowPos(deferred)) return false;

    // 这个同步消息是一个有界 STA barrier。它使更早排队的几何请求
    // 收敛，并由 Overlay 所在 STA 重读父窗口最终物理边界、更新
    // Visual 尺寸。SMTO_BLOCK 避免等待时在 Electron 主线程重入执行。
    DWORD_PTR syncResult = 0;
    if (!SendMessageTimeoutW(
            overlayHwnd,
            WM_BLUR_UPDATE_GEOMETRY,
            1, // 同步请求不清理可能仍在队列中的异步 pending 标记。
            0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            std::max<DWORD>(1, syncTimeoutMs),
            &syncResult) || syncResult != 1) {
        return false;
    }

    RECT parentAfter{};
    RECT overlayAfter{};
    if (!GetWindowRect(parentHwnd, &parentAfter) ||
        !GetWindowRect(overlayHwnd, &overlayAfter) ||
        !EqualRect(&parentAfter, &overlayAfter)) {
        return false;
    }
    // WinEvent/IME 窗口可能在验证瞬间改变层级。几何已经一致时
    // 不因短暂的 Z-order 检查结果中止动画，交给既有去重队列自愈。
    if (!IsZOrderAdjacent()) QueueZOrderSync();
    return true;
}

void Engine::ReSyncZOrder() {
    QueueZOrderSync();
}

void Engine::Show() { if (HWND hwnd = m_messageHwnd.load()) PostMessage(hwnd, WM_BLUR_SHOW, 0, 0); }
void Engine::Hide() { if (HWND hwnd = m_messageHwnd.load()) PostMessage(hwnd, WM_BLUR_HIDE, 0, 0); }
Engine::~Engine() { Destroy(); }

// ============================================================
// STA 线程主循环
// ============================================================

void Engine::StaThreadProc(HWND parentHwnd) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) {
        m_lastError.store(BlurErrorCode::ComInitializationFailed);
        m_running.store(false);
        SignalInitialization(false);
        return;
    }

    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    EnsureDispatcherQueue();
    if (!m_dispatcherQueueController) {
        m_lastError.store(BlurErrorCode::DispatcherQueueFailed);
        CoUninitialize();
        m_running.store(false);
        SignalInitialization(false);
        return;
    }

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
    if (!m_overlayHwnd) {
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        Cleanup();
        m_running.store(false);
        SignalInitialization(false);
        return;
    }

    try {
        CreateCompositor(m_overlayHwnd);
    }
    catch (...) {
        m_compositor = nullptr;
        m_target = nullptr;
    }
    if (!m_compositor || !m_target) {
        m_lastError.store(BlurErrorCode::CompositionTargetFailed);
        Cleanup();
        m_running.store(false);
        SignalInitialization(false);
        return;
    }

    if (!BuildEffectGraph()) {
        m_lastError.store(BlurErrorCode::EffectGraphFailed);
        Cleanup();
        m_running.store(false);
        SignalInitialization(false);
        return;
    }

    if (!InstallWinEventHooks()) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        Cleanup();
        m_running.store(false);
        SignalInitialization(false);
        return;
    }
    m_lastError.store(BlurErrorCode::None);
    m_initialized.store(true);
    m_runtimeHealthy.store(true);
    SignalInitialization(true);

    MSG msg{};
    BOOL messageResult = 0;
    while (m_running.load() && (messageResult = GetMessage(&msg, nullptr, 0, 0)) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    if (messageResult == -1) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
    }

    Cleanup();
    m_initialized.store(false);
    m_runtimeHealthy.store(false);
    m_running.store(false);
}

void Engine::SignalInitialization(bool success) {
    {
        std::lock_guard<std::mutex> lock(m_initMutex);
        m_initSuccess = success;
        m_initCompleted = true;
    }
    m_initCv.notify_all();
}

void Engine::Cleanup() {
    m_messageHwnd.store(nullptr);
    m_configUpdatePending.store(false);
    m_geometryUpdatePending.store(false);
    m_zOrderSyncPending.store(false);
    if (m_foregroundHook) {
        UnhookWinEvent(m_foregroundHook);
        m_foregroundHook = nullptr;
    }
    if (m_reorderHook) {
        UnhookWinEvent(m_reorderHook);
        m_reorderHook = nullptr;
    }
    try {
        if (m_blurVisual && m_target) m_target.Root(nullptr);
    }
    catch (...) {
        // 清理路径绝不能让 WinRT 异常越过 STA 线程入口。
    }
    m_blurVisual = nullptr;
    m_clipGeometry = nullptr;
    m_clip = nullptr;
    m_effectBrush = nullptr;
    m_target = nullptr;
    m_compositor = nullptr;
    if (m_overlayHwnd) { DestroyWindow(m_overlayHwnd); m_overlayHwnd = nullptr; }
    if (m_dispatcherQueueController) {
        m_dispatcherQueueController = nullptr;
    }
    CoUninitialize();
}

bool Engine::StopStaThread(DWORD timeoutMs) {
    m_running.store(false);
    if (HWND hwnd = m_messageHwnd.load()) PostMessage(hwnd, WM_BLUR_DESTROY, 0, 0);
    if (!m_staThread.joinable()) return true;

    const DWORD waitResult = WaitForSingleObject(
        static_cast<HANDLE>(m_staThread.native_handle()),
        timeoutMs);
    if (waitResult == WAIT_OBJECT_0) {
        m_staThread.join();
        return true;
    }

    // 不能让损坏或卡死的 WinRT/DComp 调用无限阻塞 Electron 主进程。
    // TerminateThread 会破坏 COM/堆状态，因此保留 Engine 与 DLL 到进程结束并分离线程。
    HMODULE pinnedModule = nullptr;
    GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&Engine::Instance),
        &pinnedModule);
    m_threadAbandoned.store(true);
    m_runtimeHealthy.store(false);
    m_staThread.detach();
    return false;
}

// ============================================================
// Overlay 窗口创建
// ============================================================

void Engine::CreateOverlayWindow(HWND parentHwnd) {
    RECT parentRect;
    if (!GetWindowRect(parentHwnd, &parentRect)) parentRect = { 0, 0, 800, 600 };
    int w = parentRect.right - parentRect.left;
    int h = parentRect.bottom - parentRect.top;

    m_overlayHwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_NOREDIRECTIONBITMAP,
        OVERLAY_CLASS, L"BlurOverlay", WS_POPUP,
        parentRect.left, parentRect.top, w, h,
        nullptr, nullptr, GetModuleHandle(nullptr), this);

    if (m_overlayHwnd) {
        m_messageHwnd.store(m_overlayHwnd);
        SyncZOrder();
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
// Effect Graph 构建（backdrop → 高斯模糊 → 饱和度）
// ============================================================

bool Engine::BuildEffectGraph() {
    if (!m_compositor || !m_target) return false;

    BlurConfig cfg;
    { std::lock_guard<std::mutex> lock(m_configMutex); cfg = m_config; }

    try {
        // ---- 节点1: backdrop 输入源 ----
        winrt::Windows::UI::Composition::CompositionEffectSourceParameter backdropParam(L"backdrop");
        auto backdropAbi = reinterpret_cast<ABI::Windows::Graphics::Effects::IGraphicsEffectSource*>(
            winrt::get_abi(backdropParam));

        // ---- 节点2: 高斯模糊 ----
        ComPtr<GaussianBlurEffect> blurWrl = Make<GaussianBlurEffect>();
        winrt::hstring blurName(L"Blur");
        blurWrl->put_Name(reinterpret_cast<HSTRING>(winrt::get_abi(blurName)));
        blurWrl->put_BlurAmount(cfg.radiusDip);
        blurWrl->put_BorderMode(EffectBorderMode_Hard);
        blurWrl->put_Optimization(EffectOptimization_Balanced);
        blurWrl->put_Source(backdropAbi);
        ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffectSource> blurSrc;
        blurWrl.As(&blurSrc);

        // ---- 节点3: 饱和度 —— 模糊后加浓颜色 ----
        ComPtr<SaturationEffect> satWrl = Make<SaturationEffect>();
        winrt::hstring saturationName(L"Saturation");
        satWrl->put_Name(reinterpret_cast<HSTRING>(winrt::get_abi(saturationName)));
        satWrl->put_Saturation(cfg.saturation);
        satWrl->put_Source(blurSrc.Get());

        // ---- WRL → C++/WinRT 桥接 ----
        winrt::Windows::Graphics::Effects::IGraphicsEffect rootEffect{ nullptr };
        winrt::check_hresult(satWrl.CopyTo(
            winrt::guid_of<winrt::Windows::Graphics::Effects::IGraphicsEffect>(),
            winrt::put_abi(rootEffect)));

        // 只创建一次 EffectFactory；后续调节直接更新 CompositionPropertySet，避免重建 GPU 管线。
        auto effectFactory = m_compositor.CreateEffectFactory(
            rootEffect, { L"Blur.BlurAmount", L"Saturation.Saturation" });
        m_effectBrush = effectFactory.CreateBrush();

        auto backdropBrush = m_compositor.CreateBackdropBrush();
        m_effectBrush.SetSourceParameter(L"backdrop", backdropBrush);

        // ---- 单层 SpriteVisual ----
        m_blurVisual = m_compositor.CreateSpriteVisual();
        m_blurVisual.Brush(m_effectBrush);
        m_target.Root(m_blurVisual);

        m_effectBrush.Properties().InsertScalar(L"Blur.BlurAmount", cfg.radiusDip);
        m_effectBrush.Properties().InsertScalar(L"Saturation.Saturation", cfg.saturation);
        // 不能把 Visual opacity 当作玻璃通透度，否则会重新混入未模糊的原始背景。
        m_blurVisual.Opacity(1.0f);
        UpdateVisualSize();
        ApplyClip();
        return true;
    }
    catch (...) {
        m_blurVisual = nullptr;
        m_effectBrush = nullptr;
        return false;
    }
}

// ============================================================
// 参数更新：直接写 Composition 属性，不重建 Effect Graph
// ============================================================

bool Engine::UpdateEffectParameters() {
    if (!m_compositor || !m_blurVisual || !m_effectBrush) {
        m_lastError.store(BlurErrorCode::EffectGraphFailed);
        m_runtimeHealthy.store(false);
        return false;
    }

    BlurConfig cfg;
    { std::lock_guard<std::mutex> lock(m_configMutex); cfg = m_config; }

    try {
        m_effectBrush.Properties().InsertScalar(L"Blur.BlurAmount", cfg.radiusDip);
        m_effectBrush.Properties().InsertScalar(L"Saturation.Saturation", cfg.saturation);
        m_blurVisual.Opacity(1.0f);
        ApplyClip();
        m_lastError.store(BlurErrorCode::None);
        m_runtimeHealthy.store(true);
        return true;
    }
    catch (...) {
        m_lastError.store(BlurErrorCode::EffectGraphFailed);
        m_runtimeHealthy.store(false);
        return false;
    }
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
    // DesktopWindowTarget 的 Visual 与 Overlay 客户区使用同一像素空间。
    // Overlay HWND 已与 Electron HWND 等大，Visual 必须覆盖完整客户区；
    // 再除以 DPI 会在 125% 下只覆盖 80%。
    const winrt::Windows::Foundation::Numerics::float2 visualSize{
        static_cast<float>(pw),
        static_cast<float>(ph)
    };
    m_blurVisual.Size(visualSize);
    if (m_clipGeometry) m_clipGeometry.Size(visualSize);
}

void Engine::ApplyClip() {
    if (!m_compositor || !m_blurVisual) return;

    BlurConfig cfg;
    { std::lock_guard<std::mutex> lock(m_configMutex); cfg = m_config; }

    // 创建或更新圆角裁剪几何体
    if (!m_clipGeometry) {
        m_clipGeometry = m_compositor.CreateRoundedRectangleGeometry();
    }
    if (!m_clip) {
        m_clip = m_compositor.CreateGeometricClip(m_clipGeometry);
        m_blurVisual.Clip(m_clip);
    }

    m_clipGeometry.CornerRadius({ cfg.cornerRadius, cfg.cornerRadius });

    // 同步几何体尺寸与视觉尺寸一致
    auto visSize = m_blurVisual.Size();
    m_clipGeometry.Size(visSize);

}

void Engine::HandleDpiChanged(WPARAM wParam, LPARAM lParam) {
    UNREFERENCED_PARAMETER(wParam);
    UNREFERENCED_PARAMETER(lParam);
    if (!SyncGeometryFromParent() && m_overlayHwnd) {
        ShowWindow(m_overlayHwnd, SW_HIDE);
    }
}

bool Engine::SyncGeometryFromParent() {
    if (!m_overlayHwnd || !IsWindow(m_overlayHwnd)) {
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
        return false;
    }
    if (!m_parentHwnd || !IsWindow(m_parentHwnd)) {
        m_lastError.store(BlurErrorCode::InvalidParentWindow);
        m_runtimeHealthy.store(false);
        return false;
    }
    RECT rect{};
    if (!GetWindowRect(m_parentHwnd, &rect)) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }

    if (!SetWindowPos(m_overlayHwnd, m_parentHwnd,
        rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
        SWP_NOACTIVATE)) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }
    try {
        UpdateVisualSize();
    }
    catch (...) {
        m_lastError.store(BlurErrorCode::EffectGraphFailed);
        m_runtimeHealthy.store(false);
        return false;
    }
    if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
    return true;
}

bool Engine::SyncAndShow() {
    if (!m_overlayHwnd || !IsWindow(m_overlayHwnd)) {
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
        return false;
    }
    if (!m_parentHwnd || !IsWindow(m_parentHwnd)) {
        m_lastError.store(BlurErrorCode::InvalidParentWindow);
        m_runtimeHealthy.store(false);
        return false;
    }

    // Effect Graph 可以在 Electron show:false 时提前初始化，但背景层绝不能
    // 脱离父窗口独立出现。首次 show、托盘恢复和视图切换都会再次提交配置。
    if (!IsWindowVisible(m_parentHwnd)) {
        ShowWindow(m_overlayHwnd, SW_HIDE);
        if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
        return true;
    }

    RECT rect{};
    if (!GetWindowRect(m_parentHwnd, &rect)) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }

    const bool parentTopmost =
        (GetWindowLongPtrW(m_parentHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    const bool overlayTopmost =
        (GetWindowLongPtrW(m_overlayHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;

    // 首次启动时 Overlay 仍隐藏，先进入与父窗口相同的 Z-order band。最终一次
    // 提交再同时设置几何、紧贴父窗口后方并显示，避免 SetWindowPos 与
    // ShowWindow 之间被安装器、WPS/Excel 等前台窗口插入。运行期重配也沿用
    // 这条路径；同 band 时不会产生额外层级切换。
    if (parentTopmost != overlayTopmost) {
        if (!SetWindowPos(m_overlayHwnd, parentTopmost ? HWND_TOPMOST : HWND_NOTOPMOST,
            0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) {
            m_lastError.store(BlurErrorCode::UnknownFailure);
            m_runtimeHealthy.store(false);
            return false;
        }
    }

    if (!SetWindowPos(m_overlayHwnd, m_parentHwnd,
        rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
        SWP_NOACTIVATE | SWP_SHOWWINDOW)) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }
    try {
        UpdateVisualSize();
    }
    catch (...) {
        ShowWindow(m_overlayHwnd, SW_HIDE);
        m_lastError.store(BlurErrorCode::EffectGraphFailed);
        m_runtimeHealthy.store(false);
        return false;
    }
    if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
    return true;
}

bool Engine::SyncZOrder() {
    if (!m_overlayHwnd || !IsWindow(m_overlayHwnd)) {
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
        return false;
    }
    if (!m_parentHwnd || !IsWindow(m_parentHwnd)) {
        m_lastError.store(BlurErrorCode::InvalidParentWindow);
        m_runtimeHealthy.store(false);
        return false;
    }

    // 父窗口隐藏时维持“背景层也隐藏”的强不变量。Z-order 修复请求可以来自
    // 异步 WinEvent/焦点事件，不能让迟到的请求重新留下孤立 Overlay。
    if (!IsWindowVisible(m_parentHwnd)) {
        ShowWindow(m_overlayHwnd, SW_HIDE);
        if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
        return true;
    }

    const bool parentTopmost =
        (GetWindowLongPtrW(m_parentHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    const bool overlayTopmost =
        (GetWindowLongPtrW(m_overlayHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;

    // Electron focus、WinEvent Hook 和健康检查都可能请求同步。有效层级已经
    // 正确时直接返回，避免重复 SetWindowPos 让 DWM 在中间状态提交一帧。
    if (IsZOrderAdjacent()) {
        if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
        return true;
    }

    // 只在置顶分组真正变化时切换 band。否则 DWM 可能在两次
    // SetWindowPos 之间提交一帧，造成 Overlay 瞬间盖住 Electron。
    if (parentTopmost != overlayTopmost) {
        if (!SetWindowPos(m_overlayHwnd, parentTopmost ? HWND_TOPMOST : HWND_NOTOPMOST,
            0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) {
            m_lastError.store(BlurErrorCode::UnknownFailure);
            m_runtimeHealthy.store(false);
            return false;
        }
    }
    // 焦点切换的常规路径只提交一次：紧贴在 Electron 正后方。
    if (!SetWindowPos(m_overlayHwnd, m_parentHwnd,
        0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }
    if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
    return true;
}

bool Engine::IsZOrderAdjacent() const {
    const HWND overlayHwnd = m_messageHwnd.load();
    if (!overlayHwnd || !IsWindow(overlayHwnd) ||
        !m_parentHwnd || !IsWindow(m_parentHwnd)) {
        return false;
    }

    const bool parentTopmost =
        (GetWindowLongPtrW(m_parentHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    const bool overlayTopmost =
        (GetWindowLongPtrW(overlayHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;

    if (parentTopmost != overlayTopmost) return false;

    RECT parentRect{};
    if (!GetWindowRect(m_parentHwnd, &parentRect)) return false;

    // Electron 后方可能存在不可见的 IME/辅助 HWND，不能要求 GW_HWNDNEXT
    // 立即等于 Overlay。只有可见且与主窗口相交的窗口夹在中间时，才会覆盖
    // BlurOverlay 并造成“桌面模糊、其他程序清晰透出”。
    HWND candidate = GetWindow(m_parentHwnd, GW_HWNDNEXT);
    while (candidate) {
        if (candidate == overlayHwnd) return true;

        if (IsWindowVisible(candidate)) {
            RECT candidateRect{};
            RECT intersection{};
            if (GetWindowRect(candidate, &candidateRect) &&
                IntersectRect(&intersection, &parentRect, &candidateRect)) {
                return false;
            }
        }
        candidate = GetWindow(candidate, GW_HWNDNEXT);
    }
    return false;
}

void Engine::QueueZOrderSync() {
    if (HWND hwnd = m_messageHwnd.load()) {
        if (m_zOrderSyncPending.exchange(true)) return;
        if (!PostMessage(hwnd, WM_BLUR_SYNC_ZORDER, 0, 0)) {
            m_zOrderSyncPending.store(false);
            m_lastError.store(BlurErrorCode::UnknownFailure);
            m_runtimeHealthy.store(false);
        }
    } else if (m_initialized.load()) {
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
    }
}

bool Engine::InstallWinEventHooks() {
    if (!m_foregroundHook) {
        m_foregroundHook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
            nullptr, WinEventProc, 0, 0,
            WINEVENT_OUTOFCONTEXT);
    }
    if (!m_reorderHook) {
        m_reorderHook = SetWinEventHook(
            EVENT_OBJECT_REORDER, EVENT_OBJECT_REORDER,
            nullptr, WinEventProc, 0, 0,
            WINEVENT_OUTOFCONTEXT);
    }
    return m_foregroundHook != nullptr && m_reorderHook != nullptr;
}

void CALLBACK Engine::WinEventProc(
    HWINEVENTHOOK hook, DWORD event, HWND hwnd, LONG objectId, LONG childId,
    DWORD eventThread, DWORD eventTime) {
    UNREFERENCED_PARAMETER(hook);
    UNREFERENCED_PARAMETER(hwnd);
    UNREFERENCED_PARAMETER(eventThread);
    UNREFERENCED_PARAMETER(eventTime);

    auto& engine = Engine::Instance();
    if (event != EVENT_SYSTEM_FOREGROUND && event != EVENT_OBJECT_REORDER) return;
    if (event == EVENT_OBJECT_REORDER &&
        (objectId != OBJID_WINDOW || childId != CHILDID_SELF)) {
        return;
    }

    HWND overlay = engine.m_messageHwnd.load();
    if (!overlay || !IsWindowVisible(overlay)) return;

    // Win10 可能在第三方窗口切换层级后把它插到 Electron 与 Overlay 之间。
    // 只有两者不再相邻时才去重投递修复，避免自己的 SetWindowPos 形成反馈循环。
    if (!engine.IsZOrderAdjacent()) engine.QueueZOrderSync();
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
        // wParam=1 是 WindowMotion_MoveWindow 的同步几何请求。它可能
        // 越过已 Post 但尚未取出的异步消息，因此不能提前清除
        // pending；真正的队列消息取出时再清除。
        if (wParam == 0) self->m_geometryUpdatePending.store(false);
        // 在 HWND 所属的 DPI-aware STA 线程直接读取物理坐标，避免 JS DIP 换算和跨线程数据竞争。
        if (!self->SyncGeometryFromParent()) {
            ShowWindow(hwnd, SW_HIDE);
            return 0;
        }
        return 1;

    case WM_DPICHANGED:
        self->HandleDpiChanged(wParam, lParam);
        return 0;

    case WM_BLUR_APPLY_CONFIG:
        self->m_configUpdatePending.store(false);
        if (!self->UpdateEffectParameters()) {
            ShowWindow(hwnd, SW_HIDE);
            return 0;
        }
        {
            auto cfg = self->GetConfig();
            if (cfg.enabled) {
                if (!self->SyncAndShow()) {
                    ShowWindow(hwnd, SW_HIDE);
                }
            } else {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
        return 0;

    case WM_BLUR_SHOW:
        if (self->GetConfig().enabled) {
            if (!self->SyncAndShow()) {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
        return 0;

    case WM_BLUR_HIDE:
        ShowWindow(hwnd, SW_HIDE);
        return 0;

    case WM_BLUR_SYNC_ZORDER:
        self->m_zOrderSyncPending.store(false);
        self->SyncZOrder();
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
