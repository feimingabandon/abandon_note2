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
#include <dwmapi.h>
#include <shellscalingapi.h>
#include <algorithm>
#include <chrono>
#include <cstdint>

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
#define WM_BLUR_BEGIN_TRANSITION (WM_USER + 106)
#define WM_BLUR_END_TRANSITION   (WM_USER + 107)
#define WM_BLUR_TRANSITION_VISUAL (WM_USER + 108)
#define WM_BLUR_SHELL_PREPARE      (WM_USER + 109)
#define WM_BLUR_SHELL_START        (WM_USER + 110)
#define WM_BLUR_SHELL_FINISH       (WM_USER + 111)
#define WM_BLUR_SHELL_CANCEL       (WM_USER + 112)
#define WM_BLUR_SHELL_WARM         (WM_USER + 113)

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

void Engine::RecordNativeFailure(const char* stage, long long nativeCode) {
    // stage 仅来自固定 ASCII 常量，不含用户数据。必须在其他 Win32 调用之前捕获错误码。
    try {
        std::lock_guard<std::mutex> lock(m_failureMutex);
        m_failureJson = std::string("{\"stage\":\"") + stage +
            "\",\"nativeCode\":" + std::to_string(nativeCode) +
            ",\"threadId\":" + std::to_string(GetCurrentThreadId()) +
            ",\"parentVisible\":" + (IsWindowVisible(m_parentHwnd.load()) ? "true" : "false") + "}";
    } catch (...) { /* 诊断分配失败不能穿透 FFI/窗口过程。 */ }
}

const char* Engine::GetLastFailureJson() const {
    thread_local std::string snapshot;
    std::lock_guard<std::mutex> lock(m_failureMutex);
    snapshot = m_failureJson;
    return snapshot.c_str();
}

namespace {

BlurConfig NormalizeBlurConfig(const BlurConfig& config) {
    BlurConfig normalized = config;
    normalized.radiusDip = std::clamp(normalized.radiusDip, 0.0f, 40.0f);
    normalized.saturation = std::clamp(normalized.saturation, 0.0f, 2.0f);
    normalized.cornerRadius = std::clamp(normalized.cornerRadius, 0.0f, 30.0f);
    normalized.tintR = std::clamp(normalized.tintR, 0, 255);
    normalized.tintG = std::clamp(normalized.tintG, 0, 255);
    normalized.tintB = std::clamp(normalized.tintB, 0, 255);
    normalized.tintOpacity = std::clamp(normalized.tintOpacity, 0.0f, 1.0f);
    return normalized;
}

} // namespace

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
    m_parentHwnd.store(parentHwnd);
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
    const BlurConfig normalized = NormalizeBlurConfig(config);
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

bool Engine::ApplyConfigAndWait(const BlurConfig& config, DWORD syncTimeoutMs) {
    { std::lock_guard<std::mutex> lock(m_failureMutex); m_failureJson = "{}"; }
    if (!m_initialized.load() || m_windowTransitioning.load()) {
        RecordNativeFailure("apply-config-not-ready", 0);
        m_lastError.store(BlurErrorCode::UnknownFailure);
        return false;
    }
    const HWND overlayHwnd = m_messageHwnd.load();
    if (!overlayHwnd || !IsWindow(overlayHwnd)) {
        RecordNativeFailure("apply-config-invalid-overlay", 0);
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
        return false;
    }

    const BlurConfig normalized = NormalizeBlurConfig(config);
    {
        std::lock_guard<std::mutex> lock(m_configMutex);
        m_config = normalized;
    }

    DWORD_PTR syncResult = 0;
    ::SetLastError(ERROR_SUCCESS);
    if (!SendMessageTimeoutW(
            overlayHwnd,
            WM_BLUR_APPLY_CONFIG,
            1,
            0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            std::max<DWORD>(1, syncTimeoutMs),
            &syncResult)) {
        RecordNativeFailure("apply-config-send-timeout-or-failure", ::GetLastError());
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }
    return syncResult == 1;
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

void Engine::SetTint(int r, int g, int b) {
    BlurConfig cfg = GetConfig();
    cfg.tintR = r;
    cfg.tintG = g;
    cfg.tintB = b;
    SetConfig(cfg);
}

void Engine::SetTintOpacity(float opacity) {
    BlurConfig cfg = GetConfig();
    cfg.tintOpacity = opacity;
    SetConfig(cfg);
}

BlurConfig Engine::GetConfig() const {
    std::lock_guard<std::mutex> lock(m_configMutex);
    return m_config;
}

void Engine::UpdateGeometry() {
    if (m_windowTransitioning.load()) return;
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
    if (parentHwnd != m_parentHwnd.load() ||
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

bool Engine::BeginWindowTransition(int initialWidth, int initialHeight, DWORD syncTimeoutMs) {
    const HWND overlayHwnd = m_messageHwnd.load();
    if (!m_initialized.load() || !overlayHwnd || !IsWindow(overlayHwnd) ||
        initialWidth <= 0 || initialHeight <= 0) {
        return false;
    }
    m_windowTransitioning.store(true);
    DWORD_PTR syncResult = 0;
    if (!SendMessageTimeoutW(
            overlayHwnd,
            WM_BLUR_BEGIN_TRANSITION,
            static_cast<WPARAM>(initialWidth),
            static_cast<LPARAM>(initialHeight),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            std::max<DWORD>(1, syncTimeoutMs),
            &syncResult) || syncResult != 1) {
        m_windowTransitioning.store(false);
        return false;
    }
    return true;
}

RECT Engine::GetShellCarrier() const {
    std::lock_guard<std::mutex> lock(m_shellMutex);
    return m_shellCarrier;
}

bool Engine::WarmShellResources(HWND parentHwnd) {
    if (!IsHealthy() || parentHwnd != m_parentHwnd.load() || m_shellPrepared.load()) return false;
    DWORD_PTR result = 0;
    // 只创建隐藏 HWND 和 Visual，绝不更改实际窗口、毛玻璃配置或事务状态。
    return SendMessageTimeoutW(m_messageHwnd.load(), WM_BLUR_SHELL_WARM,
        reinterpret_cast<WPARAM>(parentHwnd), 0, SMTO_ABORTIFHUNG | SMTO_BLOCK,
        1000, &result) && result == 1;
}

bool Engine::PrepareShellTransition(HWND parentHwnd, const RECT& target) {
    if (!IsHealthy() || parentHwnd != m_parentHwnd.load() ||
        target.right <= target.left || target.bottom <= target.top ||
        m_shellPrepared.exchange(true)) return false;
    RECT source{};
    if (!GetWindowRect(parentHwnd, &source)) {
        m_shellPrepared.store(false);
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(m_shellMutex);
        m_shellSource = source;
        m_shellTarget = target;
        UnionRect(&m_shellCarrier, &source, &target);
        m_shellCompletion = std::make_shared<ShellCompletion>();
        m_shellPrepareCompletion = std::make_shared<ShellCompletion>();
        m_shellReleaseCompletion = std::make_shared<ShellCompletion>();
    }
    m_shellCompleted.store(false);
    m_shellError.store(0);
    m_windowTransitioning.store(true);
    DWORD_PTR result = 0;
    // 请求数据由 Engine 持有；超时后 STA 不会读取已销毁的栈指针。
    bool ready = SendMessageTimeoutW(m_messageHwnd.load(), WM_BLUR_SHELL_PREPARE,
        0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, &result) && result == 1;
    if (ready) {
        std::shared_ptr<ShellCompletion> completion;
        { std::lock_guard<std::mutex> lock(m_shellMutex); completion = m_shellPrepareCompletion; }
        std::unique_lock<std::mutex> lock(completion->mutex);
        ready = completion->changed.wait_for(lock, std::chrono::milliseconds(1000),
            [&] { return completion->completed || completion->cancelled; }) &&
            completion->completed && !completion->cancelled;
    }
    if (!ready) {
        if (!m_shellError.load()) m_shellError.store(HRESULT_FROM_WIN32(ERROR_TIMEOUT));
        FinishShellTransition();
    }
    return ready;
}

bool Engine::AnimateShellTransition(int durationMs) {
    if (!m_shellPrepared.load()) return false;
    std::shared_ptr<ShellCompletion> completion;
    { std::lock_guard<std::mutex> lock(m_shellMutex); completion = m_shellCompletion; }
    if (!completion) return false;
    DWORD_PTR result = 0;
    if (!SendMessageTimeoutW(m_messageHwnd.load(), WM_BLUR_SHELL_START,
        std::clamp(durationMs, 120, 1200), 0,
        SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, &result) || result != 1) {
        if (!m_shellError.load()) m_shellError.store(HRESULT_FROM_WIN32(ERROR_TIMEOUT));
        return false;
    }
    std::unique_lock<std::mutex> lock(completion->mutex);
    const bool signalled = completion->changed.wait_for(lock,
        std::chrono::milliseconds(std::clamp(durationMs, 120, 1200) + 1500),
        [&] { return completion->completed || completion->cancelled; });
    const bool success = signalled && completion->completed && !completion->cancelled;
    if (!success && !m_shellError.load()) m_shellError.store(HRESULT_FROM_WIN32(ERROR_TIMEOUT));
    m_shellCompleted.store(success);
    return success;
}

bool Engine::FinishShellTransition() {
    if (!m_shellPrepared.load()) return true;
    std::shared_ptr<ShellCompletion> completion;
    { std::lock_guard<std::mutex> lock(m_shellMutex); completion = m_shellReleaseCompletion; }
    if (!completion) return false;
    DWORD_PTR result = 0;
    const bool success = SendMessageTimeoutW(m_messageHwnd.load(), WM_BLUR_SHELL_FINISH,
        0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, &result) && result == 1;
    if (!success) {
        // 最终清理仍可在 STA 恢复后执行，禁止留下永久占有窗口的状态。
        PostMessageW(m_messageHwnd.load(), WM_BLUR_SHELL_CANCEL, 0, 0);
    }
    if (!success) return false;
    // STA 必须继续分发 Composition 的提交完成事件；只在调用线程有界等待。
    std::unique_lock<std::mutex> lock(completion->mutex);
    const bool signalled = completion->changed.wait_for(lock, std::chrono::milliseconds(1000),
        [&] { return completion->completed || completion->cancelled; });
    const bool released = signalled && completion->completed && !completion->cancelled;
    if (!released) {
        if (!m_shellError.load()) m_shellError.store(HRESULT_FROM_WIN32(ERROR_TIMEOUT));
        PostMessageW(m_messageHwnd.load(), WM_BLUR_SHELL_CANCEL, 0, 0);
    }
    return released;
}

bool Engine::EnsureShellVisuals() {
    if (m_shellRoot) return true;
    // 临时外壳用独立的原生承载窗口。不能在可见状态把同一个承载窗口
    // 从大画布改为胶囊坐标，否则 Win10 会合成“新局部坐标 + 旧 HWND 原点”。
    static constexpr const wchar_t* shellClass = L"AbandonTransitionShell";
    WNDCLASSW wc{};
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandle(nullptr);
    wc.lpszClassName = shellClass;
    if (!RegisterClassW(&wc) && ::GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
    HWND shell = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_NOREDIRECTIONBITMAP,
        shellClass, L"AbandonTransitionShell", WS_POPUP,
        0, 0, 1, 1, nullptr, nullptr, GetModuleHandle(nullptr), nullptr);
    if (!shell) return false;
    m_shellHwnd.store(shell);
    try {
        namespace abi = ABI::Windows::UI::Composition::Desktop;
        auto interop = m_compositor.as<abi::ICompositorDesktopInterop>();
        winrt::check_hresult(interop->CreateDesktopWindowTarget(shell, false,
            reinterpret_cast<abi::IDesktopWindowTarget**>(winrt::put_abi(m_shellCompositionTarget))));
        m_shellRoot = m_compositor.CreateContainerVisual();
        m_shellRoot.IsVisible(false);
        m_shellBlur = m_compositor.CreateSpriteVisual();
        m_shellBlur.Brush(m_effectBrush);
        m_shellTint = m_compositor.CreateSpriteVisual();
        m_shellTint.Brush(m_tintBrush);
        m_shellClipGeometry = m_compositor.CreateRoundedRectangleGeometry();
        m_shellRoot.Clip(m_compositor.CreateGeometricClip(m_shellClipGeometry));
        m_shellRoot.Children().InsertAtBottom(m_shellBlur);
        m_shellRoot.Children().InsertAtTop(m_shellTint);
        m_shellCompositionTarget.Root(m_shellRoot);
        return true;
    } catch (...) {
        m_shellRoot = nullptr;
        m_shellBlur = nullptr;
        m_shellTint = nullptr;
        m_shellClipGeometry = nullptr;
        m_shellCompositionTarget = nullptr;
        m_shellHwnd.store(nullptr);
        DestroyWindow(shell);
        return false;
    }
}

bool Engine::PrepareShellOnSta() {
    if (!m_rootVisual || !m_clipGeometry || !m_overlayHwnd || !EnsureShellVisuals()) return false;
    RECT source, carrier;
    { std::lock_guard<std::mutex> lock(m_shellMutex); source = m_shellSource; carrier = m_shellCarrier; }
    const auto cfg = GetConfig();
    const winrt::Windows::Foundation::Numerics::float2 size{
        float(carrier.right - carrier.left), float(carrier.bottom - carrier.top) };
    m_shellRoot.Size(size);
    // 预热之后可能重建了材质图；使用本次事务的最新画刷。
    m_shellBlur.Brush(m_effectBrush);
    m_shellTint.Brush(m_tintBrush);
    m_shellBlur.Size(size);
    m_shellTint.Size(size);
    m_shellClipGeometry.Offset({ float(source.left - carrier.left), float(source.top - carrier.top) });
    m_shellClipGeometry.Size({ float(source.right - source.left), float(source.bottom - source.top) });
    m_shellClipGeometry.CornerRadius({ cfg.cornerRadius, cfg.cornerRadius });
    m_shellBlur.IsVisible(cfg.enabled);
    m_shellTint.Opacity(cfg.tintOpacity);
    const HWND shell = m_shellHwnd.load();
    const HWND parent = m_parentHwnd.load();
    const bool topmost = (GetWindowLongPtrW(parent, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    if (!SetWindowPos(shell, topmost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) return false;
    if (!SetWindowPos(shell, parent, carrier.left, carrier.top,
        carrier.right - carrier.left, carrier.bottom - carrier.top,
        SWP_NOACTIVATE | SWP_SHOWWINDOW)) return false;
    // HWND 可见但 Visual 仍透明。先确认新承载表面和起点裁剪已提交，
    // 再允许调用方隐藏真实窗口并启动动画，避免首次创建与播放争抢同一帧。
    std::shared_ptr<ShellCompletion> completion;
    { std::lock_guard<std::mutex> lock(m_shellMutex); completion = m_shellPrepareCompletion; }
    m_shellPrepareBatch = m_compositor.GetCommitBatch(CompositionBatchTypes::Animation);
    m_shellPrepareBatchToken = m_shellPrepareBatch.Completed([this, completion, glassEnabled = cfg.enabled](auto&&, auto&&) {
        try {
            m_shellPrepareBatch.Completed(m_shellPrepareBatchToken);
            m_shellPrepareBatch = nullptr;
            // Prepare 从 worker 调用，Electron 消息泵仍可运行。在首次真实窗口
            // 隐藏前等待可见外壳的 DWM 提交，避免 Win10 上先露出桌面的空档。
            if (glassEnabled) {
                const HRESULT presented = DwmFlush();
                if (FAILED(presented)) {
                    m_shellError.store(presented);
                    CancelShellOnSta();
                    return;
                }
            }
            std::lock_guard<std::mutex> lock(completion->mutex);
            completion->completed = true;
            completion->changed.notify_all();
        } catch (...) { CancelShellOnSta(); }
    });
    // 内容已经退出；在同一个 Compositor 提交内用起点外壳接替普通材质。
    // 必须先完成这一交接，调用者才能把真实窗口变透明、搬到目标位置。
    // 关闭毛玻璃时底色来自 Renderer，无法与原生 Visual 同批撤下；保留原来
    // 的 Start 接管时机，避免准备期间两层半透明底色叠加。
    if (cfg.enabled) {
        m_rootVisual.IsVisible(false);
        m_shellRoot.IsVisible(true);
    }
    return true;
}

bool Engine::StartShellOnSta(int durationMs) {
    if (!m_shellPrepared.load() || !m_shellClipGeometry || m_shellBatch) return false;
    RECT source, target, carrier;
    std::shared_ptr<ShellCompletion> completion;
    {
        std::lock_guard<std::mutex> lock(m_shellMutex);
        source = m_shellSource; target = m_shellTarget; carrier = m_shellCarrier;
        completion = m_shellCompletion;
    }
    const auto easing = m_compositor.CreateCubicBezierEasingFunction({ 0.2f, 0.0f }, { 0.2f, 1.0f });
    // 普通底色直到原窗口退出后才显示，避免准备阶段两层半透明底色叠加。
    if (!SetWindowPos(m_shellHwnd.load(), m_parentHwnd.load(), 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)) return false;
    // 真实 HWND 已经到达目标。普通材质在不可见时提前准备目标坐标和尺寸，
    // 让其提交与整段外壳动画重叠；结束时不能再把旧 Overlay 搬到新位置。
    m_rootVisual.IsVisible(false);
    m_shellRoot.IsVisible(true);
    if (GetConfig().enabled) {
        if (!SyncAndShow()) return false;
    } else if (!SyncGeometryFromParent()) {
        return false;
    }
    const auto animate = [&](const wchar_t* property,
        winrt::Windows::Foundation::Numerics::float2 from,
        winrt::Windows::Foundation::Numerics::float2 to) {
        auto animation = m_compositor.CreateVector2KeyFrameAnimation();
        animation.Duration(std::chrono::milliseconds(durationMs));
        animation.StopBehavior(AnimationStopBehavior::SetToFinalValue);
        animation.InsertKeyFrame(0.0f, from);
        animation.InsertKeyFrame(1.0f, to, easing);
        m_shellClipGeometry.StartAnimation(property, animation);
    };
    m_shellBatch = m_compositor.CreateScopedBatch(CompositionBatchTypes::Animation);
    m_shellBatchToken = m_shellBatch.Completed([completion](auto&&, auto&&) {
        std::lock_guard<std::mutex> lock(completion->mutex);
        completion->completed = true;
        completion->changed.notify_all();
    });
    animate(L"Offset", { float(source.left - carrier.left), float(source.top - carrier.top) },
        { float(target.left - carrier.left), float(target.top - carrier.top) });
    animate(L"Size", { float(source.right - source.left), float(source.bottom - source.top) },
        { float(target.right - target.left), float(target.bottom - target.top) });
    m_shellBatch.End();
    return true;
}

bool Engine::FinishShellOnSta() {
    if (m_shellReleaseBatch) return true;
    const auto cfg = GetConfig();
    std::shared_ptr<ShellCompletion> completion;
    { std::lock_guard<std::mutex> lock(m_shellMutex); completion = m_shellReleaseCompletion; }
    if (!completion) return false;
    if (m_blurVisual) m_blurVisual.IsVisible(cfg.enabled);
    // 成功路径只换可见性：目标 Overlay 在 Start 阶段已经就绪。
    // 失败回滚可能把父窗口改回起点，此时保持外壳、重新同步恢复几何。
    RECT parentRect{}, overlayRect{};
    const bool destinationReady = GetWindowRect(m_parentHwnd.load(), &parentRect) &&
        GetWindowRect(m_overlayHwnd, &overlayRect) && EqualRect(&parentRect, &overlayRect) &&
        m_visualWidth.load() == parentRect.right - parentRect.left &&
        m_visualHeight.load() == parentRect.bottom - parentRect.top;
    if (!destinationReady) {
        if (!(cfg.enabled ? SyncAndShow() : SyncGeometryFromParent())) {
            CancelShellOnSta();
            return false;
        }
    }
    if (!cfg.enabled) ShowWindow(m_overlayHwnd, SW_HIDE);
    m_shellReleaseBatch = m_compositor.GetCommitBatch(CompositionBatchTypes::Animation);
    m_shellReleaseBatchToken = m_shellReleaseBatch.Completed([this, completion](auto&&, auto&&) {
        try {
            // 提交完成后再隐藏 HWND；不能先撤下承载窗口，留下材质空帧。
            if (const HWND shell = m_shellHwnd.load()) ShowWindow(shell, SW_HIDE);
            if (m_shellBatch) {
                m_shellBatch.Completed(m_shellBatchToken);
                m_shellBatch = nullptr;
            }
            if (m_shellClipGeometry) {
                m_shellClipGeometry.StopAnimation(L"Offset");
                m_shellClipGeometry.StopAnimation(L"Size");
            }
            m_shellReleaseBatch.Completed(m_shellReleaseBatchToken);
            m_shellReleaseBatch = nullptr;
            m_shellPrepared.store(false);
            m_windowTransitioning.store(false);
            std::lock_guard<std::mutex> lock(completion->mutex);
            completion->completed = true;
            completion->changed.notify_all();
        } catch (...) {
            CancelShellOnSta();
        }
    });
    m_rootVisual.IsVisible(true);
    if (m_shellRoot) m_shellRoot.IsVisible(false);
    // CommitBatch 在本次合成提交结束时自动关闭，不人为 sleep，也不逐帧 DwmFlush。
    return true;
}

void Engine::CancelShellOnSta() {
    // 失败/销毁不依赖异步提交回调，必须释放两个阶段的等待器及临时窗口。
    if (const HWND shell = m_shellHwnd.load()) ShowWindow(shell, SW_HIDE);
    try {
        if (m_shellPrepareBatch) m_shellPrepareBatch.Completed(m_shellPrepareBatchToken);
        if (m_shellReleaseBatch) m_shellReleaseBatch.Completed(m_shellReleaseBatchToken);
        if (m_shellBatch) m_shellBatch.Completed(m_shellBatchToken);
        m_shellReleaseBatch = nullptr;
        m_shellPrepareBatch = nullptr;
        m_shellBatch = nullptr;
        if (m_shellRoot) m_shellRoot.IsVisible(false);
        if (m_rootVisual) m_rootVisual.IsVisible(true);
        if (m_shellClipGeometry) {
            m_shellClipGeometry.StopAnimation(L"Offset");
            m_shellClipGeometry.StopAnimation(L"Size");
        }
    } catch (...) { /* 清理不能越过 WndProc/线程入口。 */ }
    m_shellPrepared.store(false);
    m_windowTransitioning.store(false);
    std::lock_guard<std::mutex> lock(m_shellMutex);
    for (const auto& completion : { m_shellCompletion, m_shellPrepareCompletion, m_shellReleaseCompletion }) {
        if (!completion) continue;
        std::lock_guard<std::mutex> doneLock(completion->mutex);
        completion->cancelled = true;
        completion->changed.notify_all();
    }
}

bool Engine::SetWindowTransitionGeometry(
    HWND parentHwnd,
    int physicalX,
    int physicalY,
    int width,
    int height,
    WindowTransitionFrameTiming* timing) {
    const auto batchStartedAt = std::chrono::steady_clock::now();
    const HWND overlayHwnd = m_messageHwnd.load();
    if (!m_windowTransitioning.load() || !overlayHwnd || !IsWindow(overlayHwnd) ||
        parentHwnd != m_parentHwnd.load() || !parentHwnd || !IsWindow(parentHwnd) ||
        width <= 0 || height <= 0) {
        m_lastWindowTransitionGeometryError.store(WindowTransitionGeometryError::InvalidState);
        return false;
    }
    m_lastWindowTransitionGeometryError.store(WindowTransitionGeometryError::None);
    const auto config = GetConfig();
    const bool showOverlay = config.enabled;
    HDWP deferred = BeginDeferWindowPos(showOverlay ? 2 : 1);
    if (!deferred) {
        m_lastWindowTransitionGeometryError.store(WindowTransitionGeometryError::BeginBatchFailed);
        return false;
    }
    deferred = DeferWindowPos(
        deferred,
        parentHwnd,
        nullptr,
        physicalX,
        physicalY,
        width,
        height,
        SWP_NOZORDER | SWP_NOACTIVATE);
    if (!deferred) {
        m_lastWindowTransitionGeometryError.store(WindowTransitionGeometryError::ParentBatchFailed);
        return false;
    }
    if (showOverlay) {
        deferred = DeferWindowPos(
            deferred,
            overlayHwnd,
            parentHwnd,
            physicalX,
            physicalY,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW);
        if (!deferred) {
            m_lastWindowTransitionGeometryError.store(WindowTransitionGeometryError::OverlayBatchFailed);
            return false;
        }
    }
    const bool batchCommitted = EndDeferWindowPos(deferred) != FALSE;
    if (timing) timing->batchMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - batchStartedAt).count();
    if (!batchCommitted) {
        m_lastWindowTransitionGeometryError.store(WindowTransitionGeometryError::CommitBatchFailed);
        return false;
    }
    if (!showOverlay) {
        ShowWindow(overlayHwnd, SW_HIDE);
    }

    if (showOverlay) {
        DWORD_PTR syncResult = 0;
        const auto visualStartedAt = std::chrono::steady_clock::now();
        const bool visualSynced = SendMessageTimeoutW(
                overlayHwnd,
                WM_BLUR_TRANSITION_VISUAL,
                static_cast<WPARAM>(width),
                static_cast<LPARAM>(height),
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                100,
                &syncResult) && syncResult == 1;
        if (timing) timing->visualSyncMs = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - visualStartedAt).count();
        if (!visualSynced) {
            m_lastWindowTransitionGeometryError.store(WindowTransitionGeometryError::VisualSyncFailed);
            return false;
        }
    }

    RECT parentAfter{};
    if (!GetWindowRect(parentHwnd, &parentAfter) ||
        parentAfter.left != physicalX || parentAfter.top != physicalY ||
        parentAfter.right - parentAfter.left != width ||
        parentAfter.bottom - parentAfter.top != height) {
        m_lastWindowTransitionGeometryError.store(WindowTransitionGeometryError::ParentBoundsMismatch);
        return false;
    }
    if (!showOverlay) return true;
    RECT overlayAfter{};
    const bool overlayMatches =
        GetWindowRect(overlayHwnd, &overlayAfter) && EqualRect(&parentAfter, &overlayAfter);
    if (!overlayMatches) {
        m_lastWindowTransitionGeometryError.store(WindowTransitionGeometryError::OverlayBoundsMismatch);
    }
    return overlayMatches;
}

bool Engine::EndWindowTransition(HWND parentHwnd, DWORD syncTimeoutMs) {
    const HWND overlayHwnd = m_messageHwnd.load();
    if (!m_initialized.load() || !overlayHwnd || !IsWindow(overlayHwnd) ||
        !parentHwnd || !IsWindow(parentHwnd)) {
        m_windowTransitioning.store(false);
        return false;
    }
    DWORD_PTR syncResult = 0;
    const bool success = SendMessageTimeoutW(
        overlayHwnd,
        WM_BLUR_END_TRANSITION,
        0,
        reinterpret_cast<LPARAM>(parentHwnd),
        SMTO_ABORTIFHUNG | SMTO_BLOCK,
        std::max<DWORD>(1, syncTimeoutMs),
        &syncResult) && syncResult == 1;
    if (!success) m_windowTransitioning.store(false);
    return success;
}

bool Engine::AbortWindowTransition(
    HWND parentHwnd,
    int physicalX,
    int physicalY,
    int width,
    int height,
    DWORD syncTimeoutMs) {
    // EndWindowTransition 的消息可能已经失败并清除了标志。回滚必须重新进入
    // 受控状态，确保恢复几何仍通过同一个 parent/overlay 批次提交。
    m_windowTransitioning.store(true);
    const bool geometryRestored = SetWindowTransitionGeometry(
        parentHwnd,
        physicalX,
        physicalY,
        width,
        height);
    const bool finalized = EndWindowTransition(parentHwnd, syncTimeoutMs);
    // SendMessageTimeout 失败、无效 HWND 等所有分支都必须解除标志。
    m_windowTransitioning.store(false);
    if (!finalized) UpdateGeometry();
    return geometryRestored && finalized;
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
    CancelShellOnSta();
    m_messageHwnd.store(nullptr);
    m_configUpdatePending.store(false);
    m_geometryUpdatePending.store(false);
    m_zOrderSyncPending.store(false);
    m_windowTransitioning.store(false);
    m_visualWidth.store(0);
    m_visualHeight.store(0);
    m_parentHwnd.store(nullptr);
    if (m_foregroundHook) {
        UnhookWinEvent(m_foregroundHook);
        m_foregroundHook = nullptr;
    }
    if (m_reorderHook) {
        UnhookWinEvent(m_reorderHook);
        m_reorderHook = nullptr;
    }
    try {
        if (m_rootVisual && m_target) m_target.Root(nullptr);
        if (m_shellCompositionTarget) m_shellCompositionTarget.Root(nullptr);
    }
    catch (...) {
        // 清理路径绝不能让 WinRT 异常越过 STA 线程入口。
    }
    m_blurVisual = nullptr;
    m_tintVisual = nullptr;
    m_tintBrush = nullptr;
    m_rootVisual = nullptr;
    m_clipGeometry = nullptr;
    m_clip = nullptr;
    m_effectBrush = nullptr;
    m_target = nullptr;
    m_shellRoot = nullptr;
    m_shellBlur = nullptr;
    m_shellTint = nullptr;
    m_shellClipGeometry = nullptr;
    m_shellCompositionTarget = nullptr;
    if (const HWND shell = m_shellHwnd.exchange(nullptr)) DestroyWindow(shell);
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

        // ---- 同一个 DComp 根容器统一合成模糊与窗口底色 ----
        m_rootVisual = m_compositor.CreateContainerVisual();
        m_blurVisual = m_compositor.CreateSpriteVisual();
        m_blurVisual.Brush(m_effectBrush);
        m_tintBrush = m_compositor.CreateColorBrush(winrt::Windows::UI::Color{
            255,
            static_cast<uint8_t>(cfg.tintR),
            static_cast<uint8_t>(cfg.tintG),
            static_cast<uint8_t>(cfg.tintB)
        });
        m_tintVisual = m_compositor.CreateSpriteVisual();
        m_tintVisual.Brush(m_tintBrush);
        m_tintVisual.Opacity(cfg.tintOpacity);
        m_rootVisual.Children().InsertAtBottom(m_blurVisual);
        m_rootVisual.Children().InsertAtTop(m_tintVisual);
        m_target.Root(m_rootVisual);

        m_effectBrush.Properties().InsertScalar(L"Blur.BlurAmount", cfg.radiusDip);
        m_effectBrush.Properties().InsertScalar(L"Saturation.Saturation", cfg.saturation);
        // 不能把 Visual opacity 当作玻璃通透度，否则会重新混入未模糊的原始背景。
        m_blurVisual.Opacity(1.0f);
        UpdateVisualSize();
        ApplyClip();
        return true;
    }
    catch (...) {
        m_tintVisual = nullptr;
        m_tintBrush = nullptr;
        m_rootVisual = nullptr;
        m_blurVisual = nullptr;
        m_effectBrush = nullptr;
        return false;
    }
}

// ============================================================
// 参数更新：直接写 Composition 属性，不重建 Effect Graph
// ============================================================

bool Engine::UpdateEffectParameters() {
    if (!m_compositor || !m_rootVisual || !m_blurVisual || !m_tintVisual ||
        !m_tintBrush || !m_effectBrush) {
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
        m_blurVisual.IsVisible(cfg.enabled);
        m_tintBrush.Color(winrt::Windows::UI::Color{
            255,
            static_cast<uint8_t>(cfg.tintR),
            static_cast<uint8_t>(cfg.tintG),
            static_cast<uint8_t>(cfg.tintB)
        });
        m_tintVisual.Opacity(cfg.tintOpacity);
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
    if (!m_rootVisual || !m_blurVisual || !m_tintVisual || !m_overlayHwnd) return;
    RECT r;
    GetClientRect(m_overlayHwnd, &r);
    int pw = r.right - r.left, ph = r.bottom - r.top;
    if (pw <= 0 || ph <= 0) return;
    UpdateVisualSize(pw, ph);
}

void Engine::UpdateVisualSize(int width, int height) {
    if (!m_rootVisual || !m_blurVisual || !m_tintVisual || width <= 0 || height <= 0) return;
    // DesktopWindowTarget 的 Visual 与 Overlay 客户区使用同一像素空间。
    // Overlay HWND 已与 Electron HWND 等大，Visual 必须覆盖完整客户区；
    // 再除以 DPI 会在 125% 下只覆盖 80%。
    const winrt::Windows::Foundation::Numerics::float2 visualSize{
        static_cast<float>(width),
        static_cast<float>(height)
    };
    m_rootVisual.Size(visualSize);
    m_blurVisual.Size(visualSize);
    m_tintVisual.Size(visualSize);
    if (m_clipGeometry) m_clipGeometry.Size(visualSize);
    m_visualWidth.store(width);
    m_visualHeight.store(height);
}

void Engine::ApplyClip() {
    if (!m_compositor || !m_rootVisual || !m_blurVisual) return;

    BlurConfig cfg;
    { std::lock_guard<std::mutex> lock(m_configMutex); cfg = m_config; }

    // 创建或更新圆角裁剪几何体
    if (!m_clipGeometry) {
        m_clipGeometry = m_compositor.CreateRoundedRectangleGeometry();
    }
    if (!m_clip) {
        m_clip = m_compositor.CreateGeometricClip(m_clipGeometry);
        m_rootVisual.Clip(m_clip);
    }

    m_clipGeometry.CornerRadius({ cfg.cornerRadius, cfg.cornerRadius });

    // 同步几何体尺寸与视觉尺寸一致
    auto visSize = m_rootVisual.Size();
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
    const HWND parentHwnd = m_parentHwnd.load();
    if (!parentHwnd || !IsWindow(parentHwnd)) {
        m_lastError.store(BlurErrorCode::InvalidParentWindow);
        m_runtimeHealthy.store(false);
        return false;
    }
    RECT rect{};
    if (!GetWindowRect(parentHwnd, &rect)) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }

    if (!SetWindowPos(m_overlayHwnd, parentHwnd,
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
    const HWND parentHwnd = m_parentHwnd.load();
    if (!parentHwnd || !IsWindow(parentHwnd)) {
        m_lastError.store(BlurErrorCode::InvalidParentWindow);
        m_runtimeHealthy.store(false);
        return false;
    }

    // Effect Graph 可以在 Electron show:false 时提前初始化，但背景层绝不能
    // 脱离父窗口独立出现。首次 show、托盘恢复和视图切换都会再次提交配置。
    if (!IsWindowVisible(parentHwnd)) {
        ShowWindow(m_overlayHwnd, SW_HIDE);
        if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
        return true;
    }

    RECT rect{};
    if (!GetWindowRect(parentHwnd, &rect)) {
        RecordNativeFailure("show-read-parent-rect", ::GetLastError());
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }

    const bool parentTopmost =
        (GetWindowLongPtrW(parentHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    const bool overlayTopmost =
        (GetWindowLongPtrW(m_overlayHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;

    // 首次启动时 Overlay 仍隐藏，先进入与父窗口相同的 Z-order band。最终一次
    // 提交再同时设置几何、紧贴父窗口后方并显示，避免 SetWindowPos 与
    // ShowWindow 之间被安装器、WPS/Excel 等前台窗口插入。运行期重配也沿用
    // 这条路径；同 band 时不会产生额外层级切换。
    if (parentTopmost != overlayTopmost) {
        if (!SetWindowPos(m_overlayHwnd, parentTopmost ? HWND_TOPMOST : HWND_NOTOPMOST,
            0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) {
            RecordNativeFailure("show-match-zorder-band", ::GetLastError());
            m_lastError.store(BlurErrorCode::UnknownFailure);
            m_runtimeHealthy.store(false);
            return false;
        }
    }

    if (!SetWindowPos(m_overlayHwnd, parentHwnd,
        rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
        SWP_NOACTIVATE | SWP_SHOWWINDOW)) {
        RecordNativeFailure("show-position-overlay", ::GetLastError());
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
    const HWND parentHwnd = m_parentHwnd.load();
    if (!parentHwnd || !IsWindow(parentHwnd)) {
        m_lastError.store(BlurErrorCode::InvalidParentWindow);
        m_runtimeHealthy.store(false);
        return false;
    }

    // 父窗口隐藏时维持“背景层也隐藏”的强不变量。Z-order 修复请求可以来自
    // 异步 WinEvent/焦点事件，不能让迟到的请求重新留下孤立 Overlay。
    if (!IsWindowVisible(parentHwnd)) {
        ShowWindow(m_overlayHwnd, SW_HIDE);
        if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
        return true;
    }

    const bool parentTopmost =
        (GetWindowLongPtrW(parentHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
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
    if (!SetWindowPos(m_overlayHwnd, parentHwnd,
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
    const HWND parentHwnd = m_parentHwnd.load();
    if (!overlayHwnd || !IsWindow(overlayHwnd) ||
        !parentHwnd || !IsWindow(parentHwnd)) {
        return false;
    }

    const bool parentTopmost =
        (GetWindowLongPtrW(parentHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    const bool overlayTopmost =
        (GetWindowLongPtrW(overlayHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;

    if (parentTopmost != overlayTopmost) return false;

    RECT parentRect{};
    if (!GetWindowRect(parentHwnd, &parentRect)) return false;

    // Electron 后方可能存在不可见的 IME/辅助 HWND，不能要求 GW_HWNDNEXT
    // 立即等于 Overlay。只有可见且与主窗口相交的窗口夹在中间时，才会覆盖
    // BlurOverlay 并造成“桌面模糊、其他程序清晰透出”。
    HWND candidate = GetWindow(parentHwnd, GW_HWNDNEXT);
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
    if (m_windowTransitioning.load()) return;
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
    if (engine.m_windowTransitioning.load()) return;
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
        if (self->m_windowTransitioning.load()) return 1;
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
        if (self->m_windowTransitioning.load()) return 0;
        {
            auto cfg = self->GetConfig();
            if (cfg.enabled) {
                if (!self->SyncAndShow()) {
                    ShowWindow(hwnd, SW_HIDE);
                    return 0;
                }
            } else {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
        // 冷启动父窗口尚不可见，或已经隐藏了禁用的 Overlay 时，没有可见帧
        // 需要等待。Win10 在此等待可能耗尽首次配置的 500ms 同步期限。
        if (self->GetConfig().enabled && IsWindowVisible(hwnd) &&
            IsWindowVisible(self->m_parentHwnd.load())) {
            const HRESULT presented = DwmFlush();
            if (FAILED(presented)) {
                self->RecordNativeFailure("apply-config-dwm-flush", presented);
                self->m_lastError.store(BlurErrorCode::UnknownFailure);
                self->m_runtimeHealthy.store(false);
                ShowWindow(hwnd, SW_HIDE);
                return 0;
            }
        }
        return 1;

    case WM_BLUR_SHOW:
        if (self->m_windowTransitioning.load()) return 0;
        if (self->GetConfig().enabled) {
            if (!self->SyncAndShow()) {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
        return 0;

    case WM_BLUR_HIDE:
        if (self->m_windowTransitioning.load()) return 0;
        ShowWindow(hwnd, SW_HIDE);
        return 0;

    case WM_BLUR_SYNC_ZORDER:
        self->m_zOrderSyncPending.store(false);
        if (self->m_windowTransitioning.load()) return 0;
        self->SyncZOrder();
        return 0;

    case WM_BLUR_SHELL_PREPARE:
    case WM_BLUR_SHELL_START:
    case WM_BLUR_SHELL_FINISH:
        try {
            if (msg == WM_BLUR_SHELL_PREPARE) return self->PrepareShellOnSta() ? 1 : 0;
            if (msg == WM_BLUR_SHELL_START) return self->StartShellOnSta(static_cast<int>(wParam)) ? 1 : 0;
            return self->FinishShellOnSta() ? 1 : 0;
        } catch (const winrt::hresult_error& error) {
            self->m_shellError.store(error.code());
            self->CancelShellOnSta();
            return 0;
        } catch (...) {
            // Composition/驱动异常不允许越过 Win32 WndProc。
            self->m_shellError.store(E_FAIL);
            self->CancelShellOnSta();
            return 0;
        }

    case WM_BLUR_SHELL_WARM:
        if (reinterpret_cast<HWND>(wParam) != self->m_parentHwnd.load() ||
            self->m_shellPrepared.load()) return 0;
        try { return self->EnsureShellVisuals() ? 1 : 0; }
        catch (...) { return 0; }

    case WM_BLUR_SHELL_CANCEL:
        self->CancelShellOnSta();
        return 1;

    case WM_BLUR_BEGIN_TRANSITION: {
        const int initialWidth = static_cast<int>(wParam);
        const int initialHeight = static_cast<int>(lParam);
        if (initialWidth <= 0 || initialHeight <= 0 || !self->m_rootVisual) return 0;
        try {
            self->UpdateVisualSize(initialWidth, initialHeight);
            return 1;
        }
        catch (...) {
            self->m_lastError.store(BlurErrorCode::EffectGraphFailed);
            self->m_runtimeHealthy.store(false);
            return 0;
        }
    }

    case WM_BLUR_TRANSITION_VISUAL: {
        const int width = static_cast<int>(wParam);
        const int height = static_cast<int>(lParam);
        if (width <= 0 || height <= 0 || !self->m_rootVisual) return 0;
        try {
            self->UpdateVisualSize(width, height);
            return 1;
        }
        catch (...) {
            self->m_lastError.store(BlurErrorCode::EffectGraphFailed);
            self->m_runtimeHealthy.store(false);
            return 0;
        }
    }

    case WM_BLUR_END_TRANSITION: {
        const HWND parentHwnd = reinterpret_cast<HWND>(lParam);
        if (!parentHwnd || !IsWindow(parentHwnd)) return 0;
        self->m_parentHwnd.store(parentHwnd);
        self->m_windowTransitioning.store(false);
        const auto config = self->GetConfig();
        if (!config.enabled) {
            ShowWindow(hwnd, SW_HIDE);
            return 1;
        }
        return self->SyncAndShow() ? 1 : 0;
    }

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
