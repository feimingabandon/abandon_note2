/**
 * blur_engine.h — Windows.UI.Composition 模糊引擎核心
 *
 * 架构：独立 STA 线程 + 独立 blur overlay 窗口
 *
 * 职责：
 *   1. 创建无边框透明 overlay 窗口，置于 Electron 主窗口后方
 *   2. 在 overlay 窗口上构造 Windows.UI.Composition effect graph
 *   3. 默认渲染：可调高斯模糊 + 饱和度；玻璃底色/通透度由 Electron CSS 叠加
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
    void SetRadius(float radiusDip);
    void SetSaturation(float saturation);
    void SetCornerRadius(float radiusDip);
    void SetEnabled(bool enabled);
    BlurConfig GetConfig() const;

    // ---- 位置/尺寸同步 ----
    void UpdateGeometry();

    // ---- Z-order 重同步（父窗口置顶层变化后调用） ----
    void ReSyncZOrder();

    // ---- 可见性 ----
    void Show();
    void Hide();

    bool IsInitialized() const { return m_initialized.load(); }
    BlurErrorCode GetLastError() const { return m_lastError.load(); }
    void SetLastError(BlurErrorCode error) { m_lastError.store(error); }

private:
    Engine() = default;
    ~Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    // ---- STA 线程 ----
    void StaThreadProc(HWND parentHwnd);
    void StopStaThread();
    void Cleanup();  // STA 线程退出时清理所有资源
    void SignalInitialization(bool success);

    // ---- 窗口过程 ----
    static LRESULT CALLBACK OverlayWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);

    // ---- Effect Graph 构建 ----
    bool BuildEffectGraph();
    void UpdateEffectParameters();
    void UpdateVisualSize();  // 根据当前窗口 DPI 更新 SpriteVisual 尺寸
    void ApplyClip();         // 应用/更新圆角裁剪

    // ---- DPI 动态切换 ----
    void HandleDpiChanged(WPARAM wParam, LPARAM lParam);
    void SyncGeometryFromParent();
    void SyncZOrder();
    void InstallForegroundHook();
    static void CALLBACK ForegroundWinEventProc(
        HWINEVENTHOOK hook, DWORD event, HWND hwnd, LONG objectId, LONG childId,
        DWORD eventThread, DWORD eventTime);

    // ---- WinRT 初始化 ----
    void EnsureDispatcherQueue();
    void CreateCompositor(HWND hwnd);
    void CreateOverlayWindow(HWND parentHwnd);

    // ---- 线程数据 ----
    std::thread m_staThread;
    std::atomic<bool> m_running{ false };
    std::atomic<bool> m_initialized{ false };
    std::atomic<BlurErrorCode> m_lastError{ BlurErrorCode::None };
    std::atomic<HWND> m_messageHwnd{ nullptr };
    std::atomic<bool> m_configUpdatePending{ false };
    std::atomic<bool> m_geometryUpdatePending{ false };

    std::mutex m_initMutex;
    std::condition_variable m_initCv;
    bool m_initCompleted = false;
    bool m_initSuccess = false;

    // ---- 窗口句柄 ----
    HWND m_overlayHwnd = nullptr;
    HWND m_parentHwnd = nullptr;

    HWINEVENTHOOK m_foregroundHook = nullptr;

    // ---- WinRT 对象（仅在 STA 线程访问） ----
    winrt::Windows::System::DispatcherQueueController m_dispatcherQueueController{ nullptr };
    Compositor m_compositor{ nullptr };
    DesktopWindowTarget m_target{ nullptr };
    SpriteVisual m_blurVisual{ nullptr };
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
