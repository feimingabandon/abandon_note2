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
#include "dispatcher_queue_lifetime.h"
#include "window_motion_diagnostics.h"

#include <windows.ui.composition.interop.h>
#include <DispatcherQueue.h>
#include <dwmapi.h>
#include <shellscalingapi.h>
#include <imm.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <sstream>

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

void Engine::TraceZOrder(const char* stage, std::uint64_t request,
    long long value, DWORD error) const noexcept {
    if (!m_zTraceEnabled.load()) return;
    const DWORD savedError = ::GetLastError();
    try {
        ZOrderTraceEntry row;
        row.tick = GetTickCount64(); row.stage = stage; row.request = request;
        row.thread = GetCurrentThreadId(); row.value = value; row.error = error;
        const HWND parent = m_parentHwnd.load(), overlay = m_messageHwnd.load();
        row.parent = reinterpret_cast<std::uintptr_t>(parent);
        row.overlay = reinterpret_cast<std::uintptr_t>(overlay);
        row.parentTopmost = parent && IsWindow(parent)
            ? ((GetWindowLongPtrW(parent, GWL_EXSTYLE) & WS_EX_TOPMOST) ? 1 : 0) : -1;
        row.overlayTopmost = overlay && IsWindow(overlay)
            ? ((GetWindowLongPtrW(overlay, GWL_EXSTYLE) & WS_EX_TOPMOST) ? 1 : 0) : -1;
        row.pending = m_zOrderSyncPending.load();
        std::lock_guard<std::mutex> lock(m_zTraceMutex);
        row.sequence = ++m_zTraceSequence;
        m_zTraceEntries[(row.sequence - 1) % m_zTraceEntries.size()] = row;
    } catch (...) { /* Diagnostic collection cannot change native operation results. */ }
    ::SetLastError(savedError);
}

const char* Engine::GetZOrderDiagnosticJson() const {
    thread_local std::string snapshot;
    try {
        std::array<ZOrderTraceEntry, 256> rows;
        std::uint64_t total;
        { std::lock_guard<std::mutex> lock(m_zTraceMutex); rows = m_zTraceEntries; total = m_zTraceSequence; }
        std::ostringstream text;
        text << "{\"enabled\":" << (m_zTraceEnabled.load() ? "true" : "false")
            << ",\"desktopReorderEnabled\":" << (m_acceptDesktopReorder.load() ? "true" : "false")
            << ",\"overlayImeDisabled\":" << (m_disableOverlayIme.load() ? "true" : "false")
            << ",\"disableOverlayImeReturned\":" << m_disableOverlayImeReturned.load()
            << ",\"generation\":" << m_zTraceGeneration.load()
            << ",\"parent\":" << reinterpret_cast<std::uintptr_t>(m_parentHwnd.load())
            << ",\"overlay\":" << reinterpret_cast<std::uintptr_t>(m_messageHwnd.load())
            << ",\"pending\":" << (m_zOrderSyncPending.load() ? "true" : "false")
            << ",\"requests\":" << m_zTraceRequests.load() << ",\"posts\":" << m_zTracePosts.load()
            << ",\"dispatches\":" << m_zTraceDispatches.load() << ",\"syncStarts\":" << m_zTraceSyncStarts.load()
            << ",\"syncEnds\":" << m_zTraceSyncEnds.load()
            << ",\"winEventStarts\":" << m_zTraceWinEventStarts.load() << ",\"winEventEnds\":" << m_zTraceWinEventEnds.load()
            << ",\"staPhase\":\"" << m_zTraceStaPhase.load() << "\",\"predicate\":\"" << m_zTracePredicate.load()
            << "\",\"total\":" << total << ",\"dropped\":" << (total > rows.size() ? total - rows.size() : 0)
            << ",\"nonAtomic\":true,\"events\":[";
        const auto first = total > rows.size() ? total - rows.size() + 1 : 1;
        for (std::uint64_t sequence = first; sequence <= total; ++sequence) {
            const auto& row = rows[(sequence - 1) % rows.size()];
            if (sequence != first) text << ',';
            text << "{\"seq\":" << row.sequence << ",\"tick\":" << row.tick << ",\"stage\":\"" << row.stage
                << "\",\"request\":" << row.request << ",\"thread\":" << row.thread << ",\"value\":" << row.value
                << ",\"error\":" << row.error << ",\"parent\":" << row.parent << ",\"overlay\":" << row.overlay
                << ",\"parentTopmost\":" << row.parentTopmost << ",\"overlayTopmost\":" << row.overlayTopmost
                << ",\"pending\":" << (row.pending ? "true" : "false") << '}';
        }
        text << "]}"; snapshot = text.str();
    } catch (...) { snapshot = "{\"error\":\"diagnostic-read-failed\"}"; }
    return snapshot.c_str();
}

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
    std::string failure;
    ShutdownDiagnostic shutdown;
    {
        std::lock_guard<std::mutex> lock(m_failureMutex);
        failure = m_failureJson;
    }
    {
        std::lock_guard<std::mutex> lock(m_shutdownMutex);
        shutdown = m_shutdown;
    }
    // The existing failure object keeps all of its original fields. Shutdown
    // is an independent owner snapshot, not a replacement for the last failure.
    std::ostringstream text;
    text << failure.substr(0, failure.size() - 1);
    if (failure.size() > 2) text << ',';
    text << "\"shutdown\":{\"generation\":" << shutdown.generation
        << ",\"status\":\"" << shutdown.status << "\",\"threadExitConfirmed\":"
        << (shutdown.threadExitConfirmed ? "true" : "false") << ",\"waitResult\":";
    if (shutdown.hasWaitResult) text << shutdown.waitResult;
    else text << "null";
    text << ",\"nativeCode\":" << shutdown.nativeCode
        << ",\"abandoned\":" << (shutdown.abandoned ? "true" : "false")
        << ",\"modulePinned\":" << (shutdown.modulePinned ? "true" : "false")
        << ",\"pinNativeCode\":" << shutdown.pinNativeCode << "}}";
    snapshot = text.str();
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
    wchar_t traceSetting[2]{};
    m_zTraceEnabled.store(GetEnvironmentVariableW(L"ABANDON_NATIVE_Z_ORDER_TRACE", traceSetting, 2) == 1 && traceSetting[0] == L'1');
    wchar_t integrationSetting[2]{}, desktopReorderSetting[2]{};
    // Only owned integration runs with tracing may restore the old filter for causal A/B checks.
    const bool disableDesktopReorder = m_zTraceEnabled.load() &&
        GetEnvironmentVariableW(L"ABANDON_INTEGRATION_TEST", integrationSetting, 2) == 1 && integrationSetting[0] == L'1' &&
        GetEnvironmentVariableW(L"ABANDON_NATIVE_DESKTOP_REORDER_TEST", desktopReorderSetting, 2) == 1 && desktopReorderSetting[0] == L'0';
    m_acceptDesktopReorder.store(!disableDesktopReorder);
    wchar_t overlayImeSetting[2]{};
    const bool enableOverlayImeForControl = m_zTraceEnabled.load() &&
        GetEnvironmentVariableW(L"ABANDON_INTEGRATION_TEST", integrationSetting, 2) == 1 && integrationSetting[0] == L'1' &&
        GetEnvironmentVariableW(L"ABANDON_NATIVE_OVERLAY_IME_TEST", overlayImeSetting, 2) == 1 && overlayImeSetting[0] == L'0';
    m_disableOverlayIme.store(!enableOverlayImeForControl);
    m_disableOverlayImeReturned.store(-1);
    m_zTraceGeneration.fetch_add(1);
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
    {
        std::lock_guard<std::mutex> lock(m_shutdownMutex);
        m_staThread = std::thread(&Engine::StaThreadProc, this, parentHwnd);
        const auto generation = m_shutdown.generation + 1;
        m_shutdown = ShutdownDiagnostic{};
        m_shutdown.generation = generation;
        m_shutdown.status = "not-requested";
    }

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
    if (!m_initialized.load()) {
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

bool Engine::SyncGeometryAndWait(DWORD syncTimeoutMs) {
    { std::lock_guard<std::mutex> lock(m_failureMutex); m_failureJson = "{}"; }
    if (!m_initialized.load()) {
        RecordNativeFailure("sync-geometry-not-ready", 0);
        m_lastError.store(BlurErrorCode::UnknownFailure);
        return false;
    }
    const HWND overlayHwnd = m_messageHwnd.load();
    if (!overlayHwnd || !IsWindow(overlayHwnd)) {
        RecordNativeFailure("sync-geometry-invalid-overlay", 0);
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
        return false;
    }

    DWORD_PTR syncResult = 0;
    ::SetLastError(ERROR_SUCCESS);
    if (!SendMessageTimeoutW(
            overlayHwnd,
            WM_BLUR_UPDATE_GEOMETRY,
            2,
            0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            std::max<DWORD>(1, syncTimeoutMs),
            &syncResult)) {
        RecordNativeFailure("sync-geometry-send-timeout-or-failure", ::GetLastError());
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }
    return syncResult == 1;
}

bool Engine::MoveParentAndOverlay(
    HWND parentHwnd,
    int physicalX,
    int physicalY,
    DWORD syncTimeoutMs) {
    auto* diagnostic = WindowMotionDiagnostics::CurrentMove();
    const bool measuring = diagnostic && diagnostic->enabled;
    const auto fail = [&](const char* stage) {
        if (diagnostic) diagnostic->failureStage = stage;
        return false;
    };
    const HWND overlayHwnd = m_messageHwnd.load();
    if (parentHwnd != m_parentHwnd.load() ||
        !parentHwnd || !IsWindow(parentHwnd) ||
        !overlayHwnd || !IsWindow(overlayHwnd)) {
        return fail("paired-invalid-window");
    }

    RECT parentBefore{};
    if (!GetWindowRect(parentHwnd, &parentBefore)) return fail("paired-read-before");
    const int width = parentBefore.right - parentBefore.left;
    const int height = parentBefore.bottom - parentBefore.top;
    if (width <= 0 || height <= 0) return fail("paired-invalid-size");

    // 将 Electron HWND 和 Overlay HWND 置于同一窗口位置批次。Overlay 虽属于
    // STA 线程，但 Win32 HWND 位置可由其他线程提交；Composition 对象
    // 不在此处访问。第二个操作同时使 Overlay 紧贴父窗口后方。
    HDWP deferred = BeginDeferWindowPos(2);
    if (!deferred) return fail("begin-defer");
    deferred = DeferWindowPos(
        deferred,
        parentHwnd,
        nullptr,
        physicalX,
        physicalY,
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    if (!deferred) return fail("defer-parent");
    deferred = DeferWindowPos(
        deferred,
        overlayHwnd,
        parentHwnd,
        physicalX,
        physicalY,
        width,
        height,
        SWP_NOACTIVATE);
    if (!deferred) return fail("defer-overlay");
    const auto deferStarted = WindowMotionDiagnostics::Clock(measuring);
    const BOOL positionsCommitted = EndDeferWindowPos(deferred);
    if (diagnostic) {
        diagnostic->endDeferMs = WindowMotionDiagnostics::Elapsed(deferStarted, measuring);
        diagnostic->endDeferSucceeded = positionsCommitted != FALSE;
    }
    if (!positionsCommitted) return fail("end-defer");

    // 这个同步消息是一个有界 STA barrier。它使更早排队的几何请求
    // 收敛，并由 Overlay 所在 STA 重读父窗口最终物理边界、更新
    // Visual 尺寸。SMTO_BLOCK 避免等待时在 Electron 主线程重入执行。
    DWORD_PTR syncResult = 0;
    const auto barrierStarted = WindowMotionDiagnostics::Clock(measuring);
    // Do not clear the sender's last error for diagnostics: SendMessageTimeout
    // may leave it unchanged on failure. Expose that ambiguity in the sample.
    const DWORD barrierPriorError = measuring ? ::GetLastError() : ERROR_SUCCESS;
    const auto barrierReturned = SendMessageTimeoutW(
            overlayHwnd,
            WM_BLUR_UPDATE_GEOMETRY,
            1, // 同步请求不清理可能仍在队列中的异步 pending 标记。
            // An integer association id survives sender timeout; never pass a
            // pointer to sender stack storage to this cross-thread message.
            measuring ? static_cast<LPARAM>(diagnostic->sequence) : 0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            std::max<DWORD>(1, syncTimeoutMs),
            &syncResult);
    const DWORD barrierError = measuring && !barrierReturned ? ::GetLastError() : ERROR_SUCCESS;
    if (diagnostic) {
        diagnostic->barrierStarted = barrierStarted;
        diagnostic->barrierFinished = WindowMotionDiagnostics::Clock(measuring);
        diagnostic->barrierMs = WindowMotionDiagnostics::Elapsed(barrierStarted, measuring);
        diagnostic->barrierAttempted = true;
        diagnostic->barrierTransportSucceeded = barrierReturned != 0;
        diagnostic->barrierError = barrierError;
        diagnostic->barrierPriorError = barrierPriorError;
        diagnostic->barrierErrorMayBeStale = !barrierReturned && barrierError == barrierPriorError;
        diagnostic->barrierTimeoutMs = std::max<DWORD>(1, syncTimeoutMs);
        diagnostic->barrierResult = syncResult;
        WindowMotionDiagnostics::MatchBarrierService(*diagnostic);
    }
    if (!barrierReturned) return fail("barrier-timeout-or-transport-failure");
    if (syncResult != 1) return fail("barrier-service-failure");

    const auto verifyStarted = WindowMotionDiagnostics::Clock(measuring);
    RECT parentAfter{};
    RECT overlayAfter{};
    const bool rectsRead = GetWindowRect(parentHwnd, &parentAfter) &&
        GetWindowRect(overlayHwnd, &overlayAfter);
    const bool rectsMatch = rectsRead && EqualRect(&parentAfter, &overlayAfter);
    if (diagnostic) {
        diagnostic->rectsRead = rectsRead;
        diagnostic->rectsMatch = rectsMatch;
        diagnostic->targetMatches = rectsRead && parentAfter.left == physicalX && parentAfter.top == physicalY;
        diagnostic->parentAfter = parentAfter;
        diagnostic->overlayAfter = overlayAfter;
    }
    if (!rectsMatch) {
        if (diagnostic) diagnostic->verifyMs = WindowMotionDiagnostics::Elapsed(verifyStarted, measuring);
        return fail(rectsRead ? "paired-rect-mismatch" : "paired-read-after");
    }
    // WinEvent/IME 窗口可能在验证瞬间改变层级。几何已经一致时
    // 不因短暂的 Z-order 检查结果中止动画，交给既有去重队列自愈。
    if (!IsZOrderAdjacent()) QueueZOrderSync();
    if (diagnostic) diagnostic->verifyMs = WindowMotionDiagnostics::Elapsed(verifyStarted, measuring);
    return true;
}

void Engine::ReSyncZOrder() {
    QueueZOrderSync("ffi-resync");
}

void Engine::Show() { if (HWND hwnd = m_messageHwnd.load()) PostMessage(hwnd, WM_BLUR_SHOW, 0, 0); }
void Engine::Hide() { if (HWND hwnd = m_messageHwnd.load()) PostMessage(hwnd, WM_BLUR_HIDE, 0, 0); }
Engine::~Engine() { Destroy(); }

// ============================================================
// STA 线程主循环
// ============================================================

void Engine::StaThreadProc(HWND parentHwnd) {
    // This thread only paints the transparent background. It must never take text input.
    // Disable its default IME before COM/DispatcherQueue can create any window.
    if (m_disableOverlayIme.load()) {
        m_disableOverlayImeReturned.store(ImmDisableIME(GetCurrentThreadId()));
        TraceZOrder("overlay-disable-ime-return", 0, m_disableOverlayImeReturned.load());
    }
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
        m_running.store(false);
        SignalInitialization(false);
        Cleanup();
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
        m_running.store(false);
        SignalInitialization(false);
        Cleanup();
        return;
    }

    if (!BuildEffectGraph()) {
        m_lastError.store(BlurErrorCode::EffectGraphFailed);
        m_running.store(false);
        SignalInitialization(false);
        Cleanup();
        return;
    }

    if (!InstallWinEventHooks()) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_running.store(false);
        SignalInitialization(false);
        Cleanup();
        return;
    }
    m_lastError.store(BlurErrorCode::None);
    m_initialized.store(true);
    m_runtimeHealthy.store(true);
    SignalInitialization(true);

    MSG msg{};
    BOOL messageResult = 0;
    while (m_running.load()) {
        m_zTraceStaPhase.store("get-message");
        TraceZOrder("pump-get-message-enter");
        messageResult = GetMessage(&msg, nullptr, 0, 0);
        TraceZOrder("pump-get-message-return", 0, msg.message);
        if (messageResult <= 0) break;
        m_zTraceStaPhase.store("dispatch-message");
        TranslateMessage(&msg);
        DispatchMessage(&msg);
        TraceZOrder("pump-dispatch-return", 0, msg.message);
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
    // Public state is retired before the owner begins asynchronous queue drain.
    // A slow/failed drain must never continue advertising a usable engine.
    m_initialized.store(false);
    m_runtimeHealthy.store(false);
    m_running.store(false);
    m_messageHwnd.store(nullptr);
    m_configUpdatePending.store(false);
    m_geometryUpdatePending.store(false);
    m_zOrderSyncPending.store(false);
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
    m_compositor = nullptr;
    if (m_overlayHwnd) { DestroyWindow(m_overlayHwnd); m_overlayHwnd = nullptr; }
    // C++/WinRT also owns module-cached agile activation factories. Release
    // them while this apartment/queue still exists, so a later STA cannot
    // reuse a factory retained across the last apartment's CoUninitialize.
    winrt::clear_factory_cache();
    Detail::ShutdownDispatcherQueueOnCurrentThread(m_dispatcherQueueController,
        [](void* context, const char* stage, HRESULT error) noexcept {
            auto* self = static_cast<Engine*>(context);
            self->RecordNativeFailure(stage, error);
            // Preserve a more specific initialization failure as the root cause.
            if (self->m_lastError.load() == BlurErrorCode::None)
                self->m_lastError.store(BlurErrorCode::UnknownFailure);
        }, this);
    // The helper returns only after actual shutdown. On an unconfirmed result,
    // this STA retains its apartment/controller and the caller's old timeout
    // isolates it without TerminateThread or an early COM teardown.
    CoUninitialize();
}

bool Engine::StopStaThread(DWORD timeoutMs) {
    m_running.store(false);
    if (HWND hwnd = m_messageHwnd.load()) PostMessage(hwnd, WM_BLUR_DESTROY, 0, 0);
    // A detached owner remains unconfirmed; repeated Destroy cannot replace
    // its real wait/pin result with an apparent empty-owner success.
    if (!m_staThread.joinable()) return !m_threadAbandoned.load();

    const DWORD waitResult = WaitForSingleObject(
        static_cast<HANDLE>(m_staThread.native_handle()),
        timeoutMs);
    const DWORD nativeCode = waitResult == WAIT_FAILED ? ::GetLastError() : ERROR_SUCCESS;
    if (waitResult == WAIT_OBJECT_0) {
        try {
            m_staThread.join();
        } catch (...) {
            std::lock_guard<std::mutex> lock(m_shutdownMutex);
            m_shutdown.status = "failed";
            m_shutdown.hasWaitResult = true;
            m_shutdown.waitResult = waitResult;
            m_shutdown.nativeCode = nativeCode;
            throw;
        }
        std::lock_guard<std::mutex> lock(m_shutdownMutex);
        m_shutdown.status = "completed";
        m_shutdown.threadExitConfirmed = true;
        m_shutdown.hasWaitResult = true;
        m_shutdown.waitResult = waitResult;
        m_shutdown.nativeCode = nativeCode;
        return true;
    }

    // 不能让损坏或卡死的 WinRT/DComp 调用无限阻塞 Electron 主进程。
    // TerminateThread 会破坏 COM/堆状态，因此保留 Engine 与 DLL 到进程结束并分离线程。
    HMODULE pinnedModule = nullptr;
    const BOOL modulePinned = GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&Engine::Instance),
        &pinnedModule);
    const DWORD pinNativeCode = modulePinned ? ERROR_SUCCESS : ::GetLastError();
    m_threadAbandoned.store(true);
    m_runtimeHealthy.store(false);
    {
        std::lock_guard<std::mutex> lock(m_shutdownMutex);
        m_shutdown.status = waitResult == WAIT_TIMEOUT ? "timed-out" : "failed";
        m_shutdown.threadExitConfirmed = false;
        m_shutdown.hasWaitResult = true;
        m_shutdown.waitResult = waitResult;
        m_shutdown.nativeCode = nativeCode;
        m_shutdown.abandoned = true;
        m_shutdown.modulePinned = modulePinned != FALSE;
        m_shutdown.pinNativeCode = pinNativeCode;
    }
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
    if (m_clipGeometry) {
        m_clipGeometry.Offset({ 0.0f, 0.0f });
        m_clipGeometry.Size(visualSize);
    }
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

    auto visSize = m_rootVisual.Size();
    m_clipGeometry.Offset({ 0.0f, 0.0f });
    m_clipGeometry.Size(visSize);

}

void Engine::HandleDpiChanged(WPARAM wParam, LPARAM lParam) {
    UNREFERENCED_PARAMETER(wParam);
    UNREFERENCED_PARAMETER(lParam);
    if (!SyncGeometryFromParent() && m_overlayHwnd) {
        ShowWindow(m_overlayHwnd, SW_HIDE);
    }
}

bool Engine::SyncGeometryFromParent(std::uint64_t diagnosticSequence) {
    WindowMotionDiagnostics::GeometryScope diagnostic(diagnosticSequence);
    auto& sample = diagnostic.Sample();
    if (!m_overlayHwnd || !IsWindow(m_overlayHwnd)) {
        sample.failureStage = "invalid-overlay";
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
        return false;
    }
    const HWND parentHwnd = m_parentHwnd.load();
    if (!parentHwnd || !IsWindow(parentHwnd)) {
        sample.failureStage = "invalid-parent";
        m_lastError.store(BlurErrorCode::InvalidParentWindow);
        m_runtimeHealthy.store(false);
        return false;
    }
    RECT rect{};
    if (!GetWindowRect(parentHwnd, &rect)) {
        sample.failureStage = "read-parent";
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }

    const auto setPositionStarted = WindowMotionDiagnostics::Clock(sample.enabled);
    const BOOL positioned = SetWindowPos(m_overlayHwnd, parentHwnd,
        rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
        SWP_NOACTIVATE);
    sample.setPositionMs = WindowMotionDiagnostics::Elapsed(setPositionStarted, sample.enabled);
    sample.setPositionSucceeded = positioned != FALSE;
    if (!positioned) {
        sample.failureStage = "set-overlay-position";
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return false;
    }
    const auto visualStarted = WindowMotionDiagnostics::Clock(sample.enabled);
    try {
        UpdateVisualSize();
    }
    catch (...) {
        sample.visualMs = WindowMotionDiagnostics::Elapsed(visualStarted, sample.enabled);
        sample.failureStage = "update-visual-size";
        m_lastError.store(BlurErrorCode::EffectGraphFailed);
        m_runtimeHealthy.store(false);
        return false;
    }
    sample.visualMs = WindowMotionDiagnostics::Elapsed(visualStarted, sample.enabled);
    sample.visualSucceeded = true;
    if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
    sample.success = true;
    return true;
}

bool Engine::VerifyGeometrySynchronized() const {
    const HWND parentHwnd = m_parentHwnd.load();
    const HWND overlayHwnd = m_messageHwnd.load();
    if (!parentHwnd || !overlayHwnd || !IsWindow(parentHwnd) || !IsWindow(overlayHwnd)) {
        return false;
    }
    RECT parentRect{};
    RECT overlayRect{};
    RECT overlayClient{};
    if (!GetWindowRect(parentHwnd, &parentRect) ||
        !GetWindowRect(overlayHwnd, &overlayRect) ||
        !GetClientRect(overlayHwnd, &overlayClient)) {
        return false;
    }
    const int clientWidth = overlayClient.right - overlayClient.left;
    const int clientHeight = overlayClient.bottom - overlayClient.top;
    return EqualRect(&parentRect, &overlayRect) &&
        clientWidth > 0 && clientHeight > 0 &&
        m_visualWidth.load() == clientWidth &&
        m_visualHeight.load() == clientHeight;
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
    m_zTraceSyncStarts.fetch_add(1);
    TraceZOrder("sync-enter");
    const auto finish = [&](bool result) {
        m_zTraceSyncEnds.fetch_add(1);
        TraceZOrder("sync-return", 0, result);
        return result;
    };
    if (!m_overlayHwnd || !IsWindow(m_overlayHwnd)) {
        m_lastError.store(BlurErrorCode::OverlayWindowFailed);
        m_runtimeHealthy.store(false);
        return finish(false);
    }
    const HWND parentHwnd = m_parentHwnd.load();
    if (!parentHwnd || !IsWindow(parentHwnd)) {
        m_lastError.store(BlurErrorCode::InvalidParentWindow);
        m_runtimeHealthy.store(false);
        return finish(false);
    }

    // 父窗口隐藏时维持“背景层也隐藏”的强不变量。Z-order 修复请求可以来自
    // 异步 WinEvent/焦点事件，不能让迟到的请求重新留下孤立 Overlay。
    if (!IsWindowVisible(parentHwnd)) {
        ShowWindow(m_overlayHwnd, SW_HIDE);
        if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
        return finish(true);
    }

    const bool parentTopmost =
        (GetWindowLongPtrW(parentHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    const bool overlayTopmost =
        (GetWindowLongPtrW(m_overlayHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;

    // Electron focus、WinEvent Hook 和健康检查都可能请求同步。有效层级已经
    // 正确时直接返回，避免重复 SetWindowPos 让 DWM 在中间状态提交一帧。
    if (IsZOrderAdjacent()) {
        if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
        return finish(true);
    }

    // 只在置顶分组真正变化时切换 band。否则 DWM 可能在两次
    // SetWindowPos 之间提交一帧，造成 Overlay 瞬间盖住 Electron。
    if (parentTopmost != overlayTopmost) {
        TraceZOrder("sync-band-set-enter", reinterpret_cast<std::uintptr_t>(m_overlayHwnd), parentTopmost, overlayTopmost);
        const BOOL changed = SetWindowPos(m_overlayHwnd, parentTopmost ? HWND_TOPMOST : HWND_NOTOPMOST,
            0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        const DWORD changeError = changed ? 0 : ::GetLastError();
        TraceZOrder("sync-band-set-return", 0, changed, changeError);
        if (!changed) {
            m_lastError.store(BlurErrorCode::UnknownFailure);
            m_runtimeHealthy.store(false);
            return finish(false);
        }
    }
    // 焦点切换的常规路径只提交一次：紧贴在 Electron 正后方。
    TraceZOrder("sync-adjacency-set-enter");
    const BOOL positioned = SetWindowPos(m_overlayHwnd, parentHwnd,
        0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    const DWORD positionError = positioned ? 0 : ::GetLastError();
    TraceZOrder("sync-adjacency-set-return", 0, positioned, positionError);
    if (!positioned) {
        m_lastError.store(BlurErrorCode::UnknownFailure);
        m_runtimeHealthy.store(false);
        return finish(false);
    }
    if (m_runtimeHealthy.load()) m_lastError.store(BlurErrorCode::None);
    return finish(true);
}

bool Engine::IsZOrderAdjacent() const {
    const bool tracing = m_zTraceEnabled.load();
    const auto finish = [&](bool result, const char* reason) {
        if (tracing) m_zTracePredicate.store(reason);
        return result;
    };
    const HWND overlayHwnd = m_messageHwnd.load();
    const HWND parentHwnd = m_parentHwnd.load();
    if (!overlayHwnd || !IsWindow(overlayHwnd) ||
        !parentHwnd || !IsWindow(parentHwnd)) {
        return finish(false, "invalid-window");
    }

    const bool parentTopmost =
        (GetWindowLongPtrW(parentHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    const bool overlayTopmost =
        (GetWindowLongPtrW(overlayHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;

    if (parentTopmost != overlayTopmost) return finish(false, "band-mismatch");

    RECT parentRect{};
    if (!GetWindowRect(parentHwnd, &parentRect)) return finish(false, "parent-rect-failed");

    // Electron 后方可能存在不可见的 IME/辅助 HWND，不能要求 GW_HWNDNEXT
    // 立即等于 Overlay。只有可见且与主窗口相交的窗口夹在中间时，才会覆盖
    // BlurOverlay 并造成“桌面模糊、其他程序清晰透出”。
    HWND candidate = GetWindow(parentHwnd, GW_HWNDNEXT);
    std::uint64_t visited = 0;
    while (candidate) {
        ++visited;
        if (tracing && (visited & (visited - 1)) == 0)
            TraceZOrder("predicate-scan-progress", reinterpret_cast<std::uintptr_t>(candidate), visited);
        if (candidate == overlayHwnd) return finish(true, "overlay-reached");

        if (IsWindowVisible(candidate)) {
            RECT candidateRect{};
            RECT intersection{};
            if (GetWindowRect(candidate, &candidateRect) &&
                IntersectRect(&intersection, &parentRect, &candidateRect)) {
                return finish(false, "intersecting-window");
            }
        }
        candidate = GetWindow(candidate, GW_HWNDNEXT);
    }
    return finish(false, "overlay-not-reached");
}

void Engine::QueueZOrderSync(const char* source) {
    const auto request = m_zTraceRequests.fetch_add(1) + 1;
    TraceZOrder(source, request);
    if (HWND hwnd = m_messageHwnd.load()) {
        if (m_zOrderSyncPending.exchange(true)) { TraceZOrder("queue-deduplicated", request); return; }
        TraceZOrder("queue-post-enter", request);
        const BOOL posted = PostMessage(hwnd, WM_BLUR_SYNC_ZORDER, m_zTraceEnabled.load() ? request : 0, 0);
        const DWORD postError = posted ? 0 : ::GetLastError();
        if (!posted) {
            m_zOrderSyncPending.store(false);
            m_lastError.store(BlurErrorCode::UnknownFailure);
            m_runtimeHealthy.store(false);
        } else m_zTracePosts.fetch_add(1);
        TraceZOrder("queue-post-return", request, posted, postError);
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
    engine.m_zTraceWinEventStarts.fetch_add(1);
    engine.TraceZOrder("win-event-enter", 0, event);
    engine.TraceZOrder("win-event-arguments", reinterpret_cast<std::uintptr_t>(hwnd), objectId, static_cast<DWORD>(childId));
    const auto finish = [&] { engine.m_zTraceWinEventEnds.fetch_add(1); engine.TraceZOrder("win-event-return", 0, event); };
    if (event != EVENT_SYSTEM_FOREGROUND && event != EVENT_OBJECT_REORDER) { finish(); return; }
    // SetWindowPos reports top-level desktop Z-order through the desktop CLIENT object.
    // Other CLIENT reorder events describe control trees and remain irrelevant.
    const bool desktopReorder = engine.m_acceptDesktopReorder.load() &&
        hwnd == GetDesktopWindow() && objectId == OBJID_CLIENT && childId == CHILDID_SELF;
    if (event == EVENT_OBJECT_REORDER &&
        ((objectId != OBJID_WINDOW && !desktopReorder) || childId != CHILDID_SELF)) {
        engine.TraceZOrder("win-event-reorder-filtered");
        finish(); return;
    }

    HWND overlay = engine.m_messageHwnd.load();
    if (!overlay || !IsWindowVisible(overlay)) { engine.TraceZOrder("win-event-overlay-hidden"); finish(); return; }

    // Win10 可能在第三方窗口切换层级后把它插到 Electron 与 Overlay 之间。
    // 只有两者不再相邻时才去重投递修复，避免自己的 SetWindowPos 形成反馈循环。
    if (!engine.IsZOrderAdjacent()) engine.QueueZOrderSync("win-event-resync");
    finish();
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
    case WM_WINDOWPOSCHANGING:
    case WM_WINDOWPOSCHANGED:
        if (lParam) {
            const auto* position = reinterpret_cast<const WINDOWPOS*>(lParam);
            self->TraceZOrder(msg == WM_WINDOWPOSCHANGING ? "overlay-position-changing" : "overlay-position-changed",
                reinterpret_cast<std::uintptr_t>(position->hwnd), reinterpret_cast<long long>(position->hwndInsertAfter), position->flags);
        }
        return DefWindowProc(hwnd, msg, wParam, lParam);

    case WM_BLUR_UPDATE_GEOMETRY:
        // wParam=1 是 WindowMotion_MoveWindow 的同步几何请求。它可能
        // 越过已 Post 但尚未取出的异步消息，因此不能提前清除
        // pending；真正的队列消息取出时再清除。
        if (wParam == 0) self->m_geometryUpdatePending.store(false);
        // 在 HWND 所属的 DPI-aware STA 线程直接读取物理坐标，避免 JS DIP 换算和跨线程数据竞争。
        if (!self->SyncGeometryFromParent(wParam == 1 ? static_cast<std::uint64_t>(lParam) : 0)) {
            ShowWindow(hwnd, SW_HIDE);
            return 0;
        }
        if (wParam == 2) {
            if (self->GetConfig().enabled && IsWindowVisible(hwnd) &&
                IsWindowVisible(self->m_parentHwnd.load())) {
                const HRESULT presented = DwmFlush();
                if (FAILED(presented)) {
                    self->RecordNativeFailure("sync-geometry-dwm-flush", presented);
                    self->m_lastError.store(BlurErrorCode::UnknownFailure);
                    self->m_runtimeHealthy.store(false);
                    ShowWindow(hwnd, SW_HIDE);
                    return 0;
                }
            }
            if (!self->VerifyGeometrySynchronized()) {
                self->RecordNativeFailure("sync-geometry-verification", 0);
                self->m_lastError.store(BlurErrorCode::UnknownFailure);
                self->m_runtimeHealthy.store(false);
                ShowWindow(hwnd, SW_HIDE);
                return 0;
            }
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
        self->m_zTraceDispatches.fetch_add(1);
        self->TraceZOrder("sync-dispatch-enter", wParam);
        self->m_zOrderSyncPending.store(false);
        self->SyncZOrder();
        self->TraceZOrder("sync-dispatch-return", wParam);
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
