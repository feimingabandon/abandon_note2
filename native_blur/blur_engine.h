/**
 * blur_engine.h — Windows.UI.Composition 模糊引擎核心
 *
 * 架构：独立 STA 线程 + 独立 blur overlay 窗口
 *
 * 职责：
 *   1. 创建无边框透明 overlay 窗口，置于 Electron 主窗口后方
 *   2. 在 overlay 窗口上构造 Windows.UI.Composition effect graph
 *   3. 默认渲染：高斯模糊(30 DIP) + 用户可选颜色叠加（白色=无色）
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

#include <atomic>
#include <mutex>
#include <thread>

namespace BlurEngine {

using namespace winrt::Windows::UI::Composition;
using namespace winrt::Windows::UI::Composition::Desktop;

// ============================================================
// 模糊参数结构体（简化版：仅模糊半径 + 颜色）
// ============================================================
struct BlurConfig {
    bool    enabled    = true;
    float   radiusDip  = 30.0f;    // 模糊半径/通透度 (0=清晰, 越大越模糊, 0~100)
    uint8_t tintR      = 255;      // 叠加颜色 R (默认白色=无色叠加)
    uint8_t tintG      = 255;      // 叠加颜色 G
    uint8_t tintB      = 255;      // 叠加颜色 B
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
    void SetTint(uint8_t r, uint8_t g, uint8_t b);
    void SetSaturation(float saturation);
    void SetCornerRadius(float radiusDip);
    void SetEnabled(bool enabled);
    BlurConfig GetConfig() const;

    // ---- 位置/尺寸同步 ----
    void UpdateGeometry(int x, int y, int width, int height);

    // ---- Z-order 重同步（父窗口置顶层变化后调用） ----
    void ReSyncZOrder();

    // ---- 可见性 ----
    void Show();
    void Hide();

    bool IsInitialized() const { return m_initialized.load(); }

private:
    Engine() = default;
    ~Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    // ---- STA 线程 ----
    void StaThreadProc(HWND parentHwnd);
    void StopStaThread();
    void Cleanup();  // STA 线程退出时清理所有资源

    // ---- 窗口过程 ----
    static LRESULT CALLBACK OverlayWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);

    // ---- Effect Graph 构建 ----
    void BuildEffectGraph();
    void UpdateEffectParameters();
    void UpdateVisualSize();  // 根据当前窗口 DPI 更新 SpriteVisual 尺寸
    void ApplyClip();         // 应用/更新圆角裁剪

    // ---- DPI 动态切换 ----
    void HandleDpiChanged(WPARAM wParam, LPARAM lParam);

    // ---- WinRT 初始化 ----
    void EnsureDispatcherQueue();
    void CreateCompositor(HWND hwnd);
    void CreateOverlayWindow(HWND parentHwnd);

    // ---- 线程数据 ----
    std::thread m_staThread;
    std::atomic<bool> m_running{ false };
    std::atomic<bool> m_initialized{ false };

    // ---- 窗口句柄 ----
    HWND m_overlayHwnd = nullptr;
    HWND m_parentHwnd = nullptr;

    // ---- 缓存的几何信息（UpdateGeometry 传入，STA 线程读取） ----
    int m_cachedX = 0;
    int m_cachedY = 0;
    int m_cachedW = 0;
    int m_cachedH = 0;

    // ---- WinRT 对象（仅在 STA 线程访问） ----
    winrt::Windows::System::DispatcherQueueController m_dispatcherQueueController{ nullptr };
    Compositor m_compositor{ nullptr };
    DesktopWindowTarget m_target{ nullptr };
    SpriteVisual m_blurVisual{ nullptr };
    CompositionEffectBrush m_effectBrush{ nullptr };
    CompositionRoundedRectangleGeometry m_clipGeometry{ nullptr };  // 圆角裁剪几何体

    // ---- 参数（线程安全） ----
    mutable std::mutex m_configMutex;
    BlurConfig m_config;

    // ---- 窗口类注册 ----
    static constexpr const wchar_t* OVERLAY_CLASS = L"BlurOverlayWindow";
    static bool s_classRegistered;
};

} // namespace BlurEngine
