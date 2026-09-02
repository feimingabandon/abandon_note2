#include "transition_engine.h"

#include "blur_engine.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <dwmapi.h>

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
        blurEngine.GetConfig().enabled;
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
        blurEngine.GetConfig().enabled;
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
    return json;
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
                height);
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
        return success;
    };

    const auto finishBlurTransition = [&] {
        if (!blurTransitionStarted) return true;
        const bool success = blurEngine.EndWindowTransition(hwnd);
        if (success) blurTransitionStarted = false;
        return success;
    };

    const auto restoreSource = [&] {
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

    if (durationMs > 0) {
        const int clampedDurationMs = std::clamp(durationMs, 120, 1200);
        const auto startedAt = std::chrono::steady_clock::now();
        while (true) {
            const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - startedAt).count();
            const double progress = std::clamp(
                static_cast<double>(elapsed) / static_cast<double>(clampedDurationMs),
                0.0,
                1.0);
            const double eased = 1.0 - std::pow(1.0 - progress, 3.0);
            const auto interpolate = [eased](LONG start, LONG end) {
                return static_cast<LONG>(std::lround(start + (end - start) * eased));
            };
            const RECT frame{
                interpolate(sourceRect.left, targetRect.left),
                interpolate(sourceRect.top, targetRect.top),
                interpolate(sourceRect.right, targetRect.right),
                interpolate(sourceRect.bottom, targetRect.bottom)
            };
            if (!setFrame(frame)) {
                const int geometryError = static_cast<int>(
                    blurEngine.GetLastWindowTransitionGeometryError());
                restoreSource();
                char message[96]{};
                std::snprintf(
                    message,
                    sizeof(message),
                    "move_synchronized_window_transition_failed_stage_%d",
                    geometryError);
                SetError(message);
                return -6;
            }
            if (progress >= 1.0) break;

            // 让每一批 Electron/Overlay 几何在桌面合成器帧边界收敛，避免
            // DComp 裁剪动画与另一套 SetWindowPos 定时器各自运行。
            if (FAILED(DwmFlush())) Sleep(8);
        }
    }

    if (!setFrame(targetRect)) {
        restoreSource();
        SetError("commit_transition_target_failed");
        return -7;
    }
    if (!finishBlurTransition()) {
        restoreSource();
        SetError("finalize_persistent_blur_transition_failed");
        return -8;
    }
    DwmFlush();
    SetError("");
    return 1;
}

} // namespace WindowTransition
