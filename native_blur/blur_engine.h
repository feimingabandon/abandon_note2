/**
 * blur_engine.h — Windows.UI.Composition 模糊引擎核心
 *
 * 架构：独立 STA 线程 + 独立 blur overlay 窗口
 *
 * 职责：
 *   1. 创建无边框透明 overlay 窗口，置于 Electron 主窗口后方
 *   2. 在 overlay 窗口上构造 Windows.UI.Composition effect graph
 *   3. 默认渲染：可调高斯模糊 + 饱和度 + 与窗口同步的原生底色
 *   4. 与 Electron 主窗口位置/尺寸保持同步（含 DPI 动态切换）
 *
 * 适用：Windows 10 1903 (Build 18362) 及以上
 */

#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <Windows.h>
#include <wrl.h>
#include <d2d1_1.h>
#include <d2d1effects_2.h>

// C++/WinRT headers
#include <winrt/Windows.UI.Composition.h>
#include <winrt/Windows.UI.Composition.Desktop.h>
#include <winrt/Windows.UI.Composition.Effects.h>  // CompositionEffectSourceParameter
#include <winrt/Windows.Foundation.Numerics.h>
#include <winrt/Windows.Foundation.Collections.h>

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <memory>
#include <string>

namespace BlurEngine {

using namespace winrt::Windows::UI::Composition;
using namespace winrt::Windows::UI::Composition::Desktop;

enum class BlurErrorCode : int {
    None = 0,
    UnsupportedSystem = 1,
    InvalidParentWindow = 2,
    ComInitializationFailed = 3,
    DispatcherQueueFailed = 4,
    OverlayWindowFailed = 5,
    CompositionTargetFailed = 6,
    EffectGraphFailed = 7,
    InitializationTimeout = 8,
    UnknownFailure = 9
};

// ============================================================
// 模糊参数结构体
// ============================================================
struct BlurConfig {
    bool    enabled    = true;
    // DLL 独立加载时的安全回退；Electron 正常启动会立即用 shared settings schema 覆盖。
    float   radiusDip  = 15.0f;    // 模糊半径 (0=清晰, 越大越模糊, 0~40)
    float   saturation = 1.8f;     // 饱和度 (0=黑白, 1=正常, 1.8=苹果风格)
    float   cornerRadius = 12.0f;  // 窗口圆角 (0=直角, 12=默认, 0~30)
    int     tintR = 255;
    int     tintG = 255;
    int     tintB = 255;
    float   tintOpacity = 0.3f;
};

// ============================================================
// 模糊引擎类（单例，STA 线程安全）
// ============================================================
class Engine {
public:
    static Engine& Instance();

    // ---- 生命周期 ----
    bool Initialize(HWND parentHwnd);
    void Destroy();

    // ---- 参数调整（线程安全，立即生效） ----
    void SetConfig(const BlurConfig& config);
    // 主应用配置入口：等待 STA 完成 Effect、可见性、几何和 DWM 提交后返回，
    // 防止 Renderer 在 Overlay 尚未切换时提前更换 CSS 回退底色。
    bool ApplyConfigAndWait(const BlurConfig& config, DWORD syncTimeoutMs = 500);
    void SetRadius(float radiusDip);
    void SetSaturation(float saturation);
    void SetCornerRadius(float radiusDip);
    void SetTint(int r, int g, int b);
    void SetTintOpacity(float opacity);
    void SetEnabled(bool enabled);
    BlurConfig GetConfig() const;

    // ---- 位置/尺寸同步 ----
    void UpdateGeometry();
    // 贴边动画专用：同批提交父窗口与 Overlay，并在有界等待后
    // 验证两者物理边界一致。Composition 对象仍只由 STA 线程访问。
    bool MoveParentAndOverlay(HWND parentHwnd, int physicalX, int physicalY,
        DWORD syncTimeoutMs = 50);
    // 只动画现有 Overlay 内的圆角裁剪，不创建窗口、不修改父 HWND 几何。
    bool AnimatePresentation(const RECT& from, const RECT& to, int durationMs);
    void ResetPresentation();

    // ---- Z-order 重同步（父窗口置顶层变化后调用） ----
    void ReSyncZOrder();

    // ---- 可见性 ----
    void Show();
    void Hide();

    bool IsInitialized() const { return m_initialized.load(); }
    bool IsHealthy() const {
        return m_initialized.load() && m_runtimeHealthy.load();
    }
    bool IsZOrderSynchronized() const { return IsZOrderAdjacent(); }
    BlurErrorCode GetLastError() const { return m_lastError.load(); }
    const char* GetLastFailureJson() const;
    void SetLastError(BlurErrorCode error) { m_lastError.store(error); }
    HWND GetParentWindow() const { return m_parentHwnd.load(); }
    HWND GetOverlayWindow() const { return m_messageHwnd.load(); }
    int GetVisualWidth() const { return m_visualWidth.load(); }
    int GetVisualHeight() const { return m_visualHeight.load(); }

private:
    Engine() = default;
    ~Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    // ---- STA 线程 ----
    void StaThreadProc(HWND parentHwnd);
    bool StopStaThread(DWORD timeoutMs);
    void Cleanup();  // STA 线程退出时清理所有资源
    void SignalInitialization(bool success);

    // ---- 窗口过程 ----
    static LRESULT CALLBACK OverlayWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);

    // ---- Effect Graph 构建 ----
    bool BuildEffectGraph();
    bool UpdateEffectParameters();
    void UpdateVisualSize();  // 使用 Overlay 完整客户区更新 SpriteVisual 尺寸
    void UpdateVisualSize(int width, int height);
    void ApplyClip();         // 应用/更新圆角裁剪
    bool AnimatePresentationOnSta();
    void ResetPresentationOnSta();

    // ---- DPI 动态切换 ----
    void HandleDpiChanged(WPARAM wParam, LPARAM lParam);
    bool SyncGeometryFromParent();
    bool SyncAndShow();
    void RecordNativeFailure(const char* stage, long long nativeCode);
    mutable std::mutex m_failureMutex;
    std::string m_failureJson = "{}";
    bool SyncZOrder();
    bool IsZOrderAdjacent() const;
    void QueueZOrderSync();
    bool InstallWinEventHooks();
    static void CALLBACK WinEventProc(
        HWINEVENTHOOK hook, DWORD event, HWND hwnd, LONG objectId, LONG childId,
        DWORD eventThread, DWORD eventTime);

    // ---- WinRT 初始化 ----
    void EnsureDispatcherQueue();
    void CreateCompositor(HWND hwnd);
    void CreateOverlayWindow(HWND parentHwnd);

    // ---- 线程数据 ----
    std::thread m_staThread;
    std::atomic<bool> m_running{ false };
    std::atomic<bool> m_threadAbandoned{ false };
    std::atomic<bool> m_initialized{ false };
    std::atomic<bool> m_runtimeHealthy{ false };
    std::atomic<BlurErrorCode> m_lastError{ BlurErrorCode::None };
    std::atomic<HWND> m_messageHwnd{ nullptr };
    std::atomic<bool> m_configUpdatePending{ false };
    std::atomic<bool> m_geometryUpdatePending{ false };
    std::atomic<bool> m_zOrderSyncPending{ false };
    struct PresentationCompletion {
        std::mutex mutex;
        std::condition_variable changed;
        bool completed = false;
        bool cancelled = false;
    };
    std::atomic<bool> m_presentationAnimating{ false };
    std::mutex m_presentationMutex;
    RECT m_presentationFrom{}, m_presentationTo{};
    int m_presentationDurationMs = 0;
    std::shared_ptr<PresentationCompletion> m_presentationCompletion;
    CompositionScopedBatch m_presentationBatch{ nullptr };
    winrt::event_token m_presentationBatchToken{};
    RECT m_currentPresentationRect{};
    bool m_presentationUsesFullCarrier = true;
    // 只读诊断快照。Composition 对象仍只在 STA 线程访问；集成测试通过
    // 原子尺寸确认重新启用毛玻璃后 Visual 已覆盖当前窗口客户区。
    std::atomic<int> m_visualWidth{ 0 };
    std::atomic<int> m_visualHeight{ 0 };

    std::mutex m_initMutex;
    std::condition_variable m_initCv;
    bool m_initCompleted = false;
    bool m_initSuccess = false;

    // ---- 窗口句柄 ----
    HWND m_overlayHwnd = nullptr;
    std::atomic<HWND> m_parentHwnd{ nullptr };

    HWINEVENTHOOK m_foregroundHook = nullptr;
    HWINEVENTHOOK m_reorderHook = nullptr;

    // ---- WinRT 对象（仅在 STA 线程访问） ----
    winrt::Windows::System::DispatcherQueueController m_dispatcherQueueController{ nullptr };
    Compositor m_compositor{ nullptr };
    DesktopWindowTarget m_target{ nullptr };
    ContainerVisual m_rootVisual{ nullptr };
    SpriteVisual m_blurVisual{ nullptr };
    SpriteVisual m_tintVisual{ nullptr };
    CompositionColorBrush m_tintBrush{ nullptr };
    CompositionEffectBrush m_effectBrush{ nullptr };
    CompositionRoundedRectangleGeometry m_clipGeometry{ nullptr };  // 圆角裁剪几何体
    CompositionGeometricClip m_clip{ nullptr };

    // ---- 参数（线程安全） ----
    mutable std::mutex m_configMutex;
    BlurConfig m_config;

    // ---- 窗口类注册 ----
    static constexpr const wchar_t* OVERLAY_CLASS = L"BlurOverlayWindow";
    static bool s_classRegistered;
};

} // namespace BlurEngine
