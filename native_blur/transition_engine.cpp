#include "transition_engine.h"

#include "blur_engine.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <dwmapi.h>
#include <array>
#include <sstream>
#include <iomanip>
#include <locale>

namespace WindowTransition {

Engine& Engine::Instance() {
    static Engine instance;
    return instance;
}

void Engine::SetError(const char* message) {
    std::lock_guard<std::mutex> lock(m_errorMutex);
    m_error = message ? message : "unknown_transition_error";
}

const char* Engine::GetLastErrorMessage() {
    std::lock_guard<std::mutex> lock(m_errorMutex);
    m_errorSnapshot = m_error;
    return m_errorSnapshot.c_str();
}

namespace {

int MaximumRectDelta(const RECT& first, const RECT& second) {
    return std::max({
        std::abs(first.left - second.left),
        std::abs(first.top - second.top),
        std::abs(first.right - second.right),
        std::abs(first.bottom - second.bottom)
    });
}

using Clock = std::chrono::steady_clock;
double ElapsedMs(Clock::time_point from) {
    return std::chrono::duration<double, std::milli>(Clock::now() - from).count();
}

struct FrameTiming {
    const char* kind = "animation";
    double elapsedMs = 0, intervalMs = 0, geometryMs = 0, batchMs = 0, visualSyncMs = 0;
    double dwmFlushMs = 0;
    HRESULT dwmResult = S_OK;
    RECT requested{}, actual{};
    bool actualValid = false, success = false, dwmWaited = false;
};

void WriteRect(std::ostringstream& output, const RECT& rect) {
    output << "{\"x\":" << rect.left << ",\"y\":" << rect.top
        << ",\"width\":" << rect.right - rect.left << ",\"height\":" << rect.bottom - rect.top << "}";
}

} // namespace

void Engine::ResetDiagnostics() {
    m_frameCount.store(0);
    m_lastObservedDelta.store(0);
    m_maximumObservedDelta.store(0);
    m_lastGeometryEqual.store(true);
    m_overlayExpected.store(false);
}

void Engine::RecordDiagnostics(HWND hwnd) {
    auto& blurEngine = BlurEngine::Engine::Instance();
    const HWND overlayHwnd = blurEngine.GetOverlayWindow();
    const bool overlayExpected =
        blurEngine.IsInitialized() && blurEngine.GetParentWindow() == hwnd &&
        blurEngine.GetConfig().enabled && !blurEngine.IsShellTransitionPrepared();
    m_overlayExpected.store(overlayExpected);
    m_frameCount.fetch_add(1);
    if (!overlayExpected) {
        m_lastObservedDelta.store(0);
        m_lastGeometryEqual.store(true);
        return;
    }

    RECT parentRect{};
    RECT overlayRect{};
    if (!hwnd || !overlayHwnd || !GetWindowRect(hwnd, &parentRect) ||
        !GetWindowRect(overlayHwnd, &overlayRect)) {
        m_lastObservedDelta.store(-1);
        m_lastGeometryEqual.store(false);
        return;
    }
    const int delta = MaximumRectDelta(parentRect, overlayRect);
    m_lastObservedDelta.store(delta);
    m_lastGeometryEqual.store(delta == 0);
    int maximum = m_maximumObservedDelta.load();
    while (delta > maximum &&
        !m_maximumObservedDelta.compare_exchange_weak(maximum, delta)) {
    }
}

const char* Engine::GetStatusJson(HWND hwnd) {
    thread_local char json[1024]{};
    auto& blurEngine = BlurEngine::Engine::Instance();
    const HWND overlayHwnd = blurEngine.GetOverlayWindow();
    RECT parentRect{};
    RECT overlayRect{};
    const bool parentValid = hwnd && IsWindow(hwnd) && GetWindowRect(hwnd, &parentRect);
    const bool overlayValid =
        overlayHwnd && IsWindow(overlayHwnd) && GetWindowRect(overlayHwnd, &overlayRect);
    const bool overlayVisible = overlayValid && IsWindowVisible(overlayHwnd);
    const bool overlayExpected =
        parentValid && blurEngine.IsInitialized() && blurEngine.GetParentWindow() == hwnd &&
        blurEngine.GetConfig().enabled && !blurEngine.IsShellTransitionPrepared();
    // 动画运行中不能在诊断线程先后读取两个 RECT：两次读取之间原生动画可能
    // 已提交下一帧，形成并不存在的跨帧假偏差。每个动画批次完成后已经在
    // RecordDiagnostics 中原子保存验证结果，运行期只返回这份批次内快照。
    const bool running = m_running.load();
    const int currentDelta = running
        ? m_lastObservedDelta.load()
        : (overlayExpected && overlayValid ? MaximumRectDelta(parentRect, overlayRect) : 0);
    const bool geometryEqual = running
        ? m_lastGeometryEqual.load()
        : (!overlayExpected || (overlayValid && currentDelta == 0));
    std::snprintf(
        json,
        sizeof(json),
        "{\"running\":%s,\"blurTransitionActive\":%s,\"overlayExpected\":%s,"
        "\"parentValid\":%s,\"overlayValid\":%s,\"overlayVisible\":%s,"
        "\"geometryEqual\":%s,\"visualWidth\":%d,\"visualHeight\":%d,"
        "\"frameCount\":%d,\"lastObservedDelta\":%d,\"maximumObservedDelta\":%d,"
        "\"currentDelta\":%d,"
        "\"parentRect\":{\"left\":%ld,\"top\":%ld,\"right\":%ld,\"bottom\":%ld},"
        "\"overlayRect\":{\"left\":%ld,\"top\":%ld,\"right\":%ld,\"bottom\":%ld}}",
        running ? "true" : "false",
        blurEngine.IsWindowTransitioning() ? "true" : "false",
        overlayExpected ? "true" : "false",
        parentValid ? "true" : "false",
        overlayValid ? "true" : "false",
        overlayVisible ? "true" : "false",
        geometryEqual ? "true" : "false",
        blurEngine.GetVisualWidth(),
        blurEngine.GetVisualHeight(),
        m_frameCount.load(),
        m_lastObservedDelta.load(),
        m_maximumObservedDelta.load(),
        currentDelta,
        parentRect.left,
        parentRect.top,
        parentRect.right,
        parentRect.bottom,
        overlayRect.left,
        overlayRect.top,
        overlayRect.right,
        overlayRect.bottom);
    thread_local std::string status;
    status = json;
    status.pop_back();
    status += std::string(",\"shellPrepared\":") + (blurEngine.IsShellTransitionPrepared() ? "true" : "false");
    status += std::string(",\"shellCompleted\":") + (blurEngine.IsShellAnimationCompleted() ? "true" : "false");
    status += ",\"shellError\":" + std::to_string(blurEngine.GetShellError());
    {
        std::ostringstream carrier;
        WriteRect(carrier, blurEngine.GetShellCarrier());
        status += ",\"shellCarrier\":" + carrier.str();
    }
    {
        const HWND shell = blurEngine.GetShellWindow();
        RECT shellRect{};
        const bool valid = shell && GetWindowRect(shell, &shellRect);
        std::ostringstream rect;
        WriteRect(rect, shellRect);
        status += ",\"shellRect\":" + rect.str();
        status += std::string(",\"shellVisible\":") +
            (valid && IsWindowVisible(shell) ? "true" : "false");
    }
    {
        std::lock_guard<std::mutex> lock(m_timingMutex);
        status += ",\"timing\":" + m_timingJson + "}";
    }
    return status.c_str();
}

int Engine::Run(
    HWND hwnd,
    int targetX,
    int targetY,
    int targetWidth,
    int targetHeight,
    int durationMs) {
    if (m_running.exchange(true)) {
        SetError("transition_already_running");
        return -2;
    }
    struct RunningGuard {
        std::atomic<bool>& value;
        ~RunningGuard() { value.store(false); }
    } runningGuard{ m_running };
    ResetDiagnostics();

    // 动画中仅填充固定容量内存；结束后一次序列化，避免逐帧日志/IPC 影响测量。
    std::array<FrameTiming, 256> frames{};
    size_t sampleCount = 0, attemptedFrames = 0;
    const auto traceStartedAt = Clock::now();
    auto previousFrameAt = traceStartedAt;
    const auto startedAtUnixMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    double preparationMs = 0, finalizeMs = 0;
    bool compositorShell = false;
    double compositionWaitMs = 0;
    const char* frameKind = "animation";
    {
        std::lock_guard<std::mutex> lock(m_timingMutex);
        m_timingJson = "{\"collecting\":true}";
    }
    const auto publishTrace = [&] {
        try {
            std::ostringstream output;
            output.imbue(std::locale::classic());
            output << std::fixed << std::setprecision(3)
                << "{\"schemaVersion\":1,\"startedAtUnixMs\":" << startedAtUnixMs
                << ",\"durationRequestedMs\":" << durationMs << ",\"totalMs\":" << ElapsedMs(traceStartedAt)
                << ",\"preparationMs\":" << preparationMs << ",\"finalizeMs\":" << finalizeMs
                << ",\"mode\":\"" << (compositorShell ? "composition-shell" : "geometry") << "\""
                << ",\"compositionWaitMs\":" << compositionWaitMs
                << ",\"presentationFramesMeasured\":false"
                << ",\"droppedFrames\":" << attemptedFrames - sampleCount << ",\"frames\":[";
            for (size_t i = 0; i < sampleCount; ++i) {
                const auto& f = frames[i];
                if (i) output << ',';
                output << "{\"kind\":\"" << f.kind << "\",\"elapsedMs\":" << f.elapsedMs
                    << ",\"intervalMs\":" << f.intervalMs << ",\"geometryMs\":" << f.geometryMs
                    << ",\"batchMs\":" << f.batchMs << ",\"visualSyncMs\":" << f.visualSyncMs
                    << ",\"dwmFlushMs\":" << f.dwmFlushMs << ",\"dwmResult\":" << f.dwmResult
                    << ",\"dwmWaited\":" << (f.dwmWaited ? "true" : "false")
                    << ",\"success\":" << (f.success ? "true" : "false")
                    << ",\"requested\":";
                WriteRect(output, f.requested);
                output << ",\"actual\":";
                if (f.actualValid) WriteRect(output, f.actual); else output << "null";
                output << '}';
            }
            output << "]}";
            std::lock_guard<std::mutex> lock(m_timingMutex);
            m_timingJson = output.str();
        } catch (...) {
            // 诊断分配失败不改变窗口事务结果。
        }
    };
    struct TraceGuard { decltype(publishTrace)& callback; ~TraceGuard() { callback(); } } traceGuard{publishTrace};

    if (!hwnd || !IsWindow(hwnd)) {
        SetError("invalid_transition_window");
        return -1;
    }
    if (targetWidth <= 0 || targetHeight <= 0) {
        SetError("invalid_transition_bounds");
        return -3;
    }

    RECT sourceRect{};
    if (!GetWindowRect(hwnd, &sourceRect)) {
        SetError("read_transition_bounds_failed");
        return -4;
    }
    const RECT targetRect{
        targetX,
        targetY,
        targetX + targetWidth,
        targetY + targetHeight
    };

    auto& blurEngine = BlurEngine::Engine::Instance();
    if (durationMs > 0 && blurEngine.IsShellTransitionPrepared()) {
        compositorShell = true;
        preparationMs = ElapsedMs(traceStartedAt);
        // Renderer 已透明，外壳拥有独立固定承载区域。提前提交唯一一次
        // 真实 HWND 尺寸，让 Chromium 布局/合成与 400ms 外壳动画重叠。
        const auto commitStarted = Clock::now();
        const bool committed = SetWindowPos(hwnd, nullptr, targetX, targetY,
            targetWidth, targetHeight, SWP_NOZORDER | SWP_NOACTIVATE) != FALSE;
        auto& sample = frames[sampleCount++];
        ++attemptedFrames;
        sample.kind = "final";
        sample.elapsedMs = ElapsedMs(traceStartedAt);
        sample.geometryMs = ElapsedMs(commitStarted);
        sample.batchMs = sample.geometryMs;
        sample.requested = targetRect;
        sample.actualValid = GetWindowRect(hwnd, &sample.actual) != FALSE;
        sample.success = committed && sample.actualValid && EqualRect(&targetRect, &sample.actual);
        RecordDiagnostics(hwnd);
        if (!sample.success) {
            SetError("composition_shell_target_failed");
            return -10;
        }
        const auto started = Clock::now();
        const bool animated = blurEngine.AnimateShellTransition(durationMs);
        compositionWaitMs = ElapsedMs(started);
        if (!animated) {
            SetError("composition_shell_animation_failed");
            return -9;
        }
        SetError("");
        return 1;
    }
    if (durationMs > 0) {
        SetError("composition_shell_not_prepared");
        return -11;
    }
    const bool hasBlurRuntime =
        blurEngine.IsInitialized() && blurEngine.GetParentWindow() == hwnd;
    bool blurTransitionStarted = false;
    if (hasBlurRuntime) {
        const int sourceWidth = sourceRect.right - sourceRect.left;
        const int sourceHeight = sourceRect.bottom - sourceRect.top;
        if (!blurEngine.BeginWindowTransition(sourceWidth, sourceHeight)) {
            SetError("prepare_persistent_blur_transition_failed");
            return -5;
        }
        blurTransitionStarted = true;
    }

    const auto setFrame = [&](const RECT& rect) {
        const auto frameStartedAt = Clock::now();
        BlurEngine::WindowTransitionFrameTiming nativeTiming;
        const int width = rect.right - rect.left;
        const int height = rect.bottom - rect.top;
        if (width <= 0 || height <= 0) return false;
        bool success = false;
        if (blurTransitionStarted) {
            success = blurEngine.SetWindowTransitionGeometry(
                hwnd,
                rect.left,
                rect.top,
                width,
                height, &nativeTiming);
        } else {
            success = SetWindowPos(
                hwnd,
                nullptr,
                rect.left,
                rect.top,
                width,
                height,
                SWP_NOZORDER | SWP_NOACTIVATE) != FALSE;
        }
        RecordDiagnostics(hwnd);
        ++attemptedFrames;
        if (sampleCount < frames.size()) {
            auto& sample = frames[sampleCount++];
            sample.kind = frameKind;
            sample.elapsedMs = std::chrono::duration<double, std::milli>(frameStartedAt - traceStartedAt).count();
            sample.intervalMs = sampleCount > 1 ? std::chrono::duration<double, std::milli>(frameStartedAt - previousFrameAt).count() : 0;
            sample.geometryMs = ElapsedMs(frameStartedAt);
            sample.batchMs = blurTransitionStarted ? nativeTiming.batchMs : sample.geometryMs;
            sample.visualSyncMs = nativeTiming.visualSyncMs;
            sample.requested = rect;
            sample.actualValid = GetWindowRect(hwnd, &sample.actual) != FALSE;
            sample.success = success;
        }
        previousFrameAt = frameStartedAt;
        return success;
    };

    const auto flushFrame = [&] {
        const auto started = Clock::now();
        const HRESULT result = DwmFlush();
        if (sampleCount && attemptedFrames == sampleCount) {
            auto& sample = frames[sampleCount - 1];
            sample.dwmFlushMs += ElapsedMs(started);
            sample.dwmWaited = true;
            sample.dwmResult = result;
        }
        return result;
    };

    const auto finishBlurTransition = [&] {
        if (!blurTransitionStarted) return true;
        const bool success = blurEngine.EndWindowTransition(hwnd);
        if (success) blurTransitionStarted = false;
        return success;
    };

    const auto restoreSource = [&] {
        frameKind = "rollback";
        if (blurTransitionStarted) {
            blurEngine.AbortWindowTransition(
                hwnd,
                sourceRect.left,
                sourceRect.top,
                sourceRect.right - sourceRect.left,
                sourceRect.bottom - sourceRect.top);
            blurTransitionStarted = false;
            RecordDiagnostics(hwnd);
        } else {
            setFrame(sourceRect);
        }
        DwmFlush();
    };

    preparationMs = ElapsedMs(traceStartedAt);
    frameKind = "final";
    if (!setFrame(targetRect)) {
        restoreSource();
        SetError("commit_transition_target_failed");
        return -7;
    }
    const auto finalizeStartedAt = Clock::now();
    if (!finishBlurTransition()) {
        restoreSource();
        SetError("finalize_persistent_blur_transition_failed");
        return -8;
    }
    finalizeMs = ElapsedMs(finalizeStartedAt);
    flushFrame();
    SetError("");
    return 1;
}

} // namespace WindowTransition
