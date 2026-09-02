#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <Windows.h>
#include <atomic>
#include <mutex>
#include <string>

namespace WindowTransition {

class Engine {
public:
    static Engine& Instance();

    int Run(
        HWND hwnd,
        int targetX,
        int targetY,
        int targetWidth,
        int targetHeight,
        int durationMs);
    bool IsRunning() const { return m_running.load(); }
    const char* GetLastErrorMessage();
    const char* GetStatusJson(HWND hwnd);

private:
    Engine() = default;
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    void SetError(const char* message);
    void ResetDiagnostics();
    void RecordDiagnostics(HWND hwnd);
    std::atomic<bool> m_running{ false };
    std::atomic<int> m_frameCount{ 0 };
    std::atomic<int> m_lastObservedDelta{ 0 };
    std::atomic<int> m_maximumObservedDelta{ 0 };
    std::atomic<bool> m_lastGeometryEqual{ true };
    std::atomic<bool> m_overlayExpected{ false };
    std::mutex m_errorMutex;
    std::string m_error;
    std::string m_errorSnapshot;
};

} // namespace WindowTransition
