#pragma once

#include <Windows.h>
#include <cstdint>

// This collector only observes existing work. It never queries another HWND,
// posts a message, waits for a thread or writes a log from the movement path.
namespace WindowMotionDiagnostics {

using Tick = long long;

struct GeometrySample {
    bool enabled = false, success = false, setPositionSucceeded = false, visualSucceeded = false;
    std::uint64_t sequence = 0, generation = 0;
    Tick started = 0, finished = 0;
    double totalMs = -1, setPositionMs = -1, visualMs = -1;
    const char* failureStage = "none";
};

struct MoveSample {
    bool enabled = false, success = false, fallbackAttempted = false, fallbackSucceeded = false;
    std::uint64_t sequence = 0, generation = 0;
    std::uintptr_t window = 0;
    Tick started = 0, barrierStarted = 0, barrierFinished = 0;
    int targetX = 0, targetY = 0;
    const char* path = "direct";
    const char* failureStage = "none";
    double totalMs = -1, endDeferMs = -1, barrierMs = -1, verifyMs = -1;
    double directMoveMs = -1, fallbackMoveMs = -1, snapshotMs = -1;
    bool endDeferSucceeded = false, snapshotRectRead = false, snapshotTargetMatches = false;
    RECT snapshotRect{};
    bool barrierAttempted = false, barrierTransportSucceeded = false;
    bool barrierErrorMayBeStale = false;
    DWORD barrierError = 0, barrierPriorError = 0, barrierTimeoutMs = 0;
    DWORD_PTR barrierResult = 0;
    bool rectsRead = false, rectsMatch = false, targetMatches = false;
    RECT parentAfter{}, overlayAfter{};
    bool serviceAvailableAtReturn = false, serviceArrivedAfterReturn = false;
    GeometrySample service{};
};

bool IsEnabled() noexcept;
void SetLease(int remainingMs) noexcept;
const char* DrainJson();
Tick Clock(bool enabled) noexcept;
double Elapsed(Tick started, bool enabled) noexcept;
MoveSample* CurrentMove() noexcept;
void MatchBarrierService(MoveSample& sample) noexcept;

class MoveScope {
public:
    MoveScope(HWND window, int x, int y) noexcept;
    ~MoveScope();
    MoveSample& Sample() noexcept { return m_sample; }
private:
    MoveSample m_sample{};
    MoveSample* m_previous = nullptr;
};

class GeometryScope {
public:
    explicit GeometryScope(std::uint64_t sequence = 0) noexcept;
    ~GeometryScope();
    GeometrySample& Sample() noexcept { return m_sample; }
private:
    GeometrySample m_sample{};
};

class SnapshotScope {
public:
    explicit SnapshotScope(HWND window) noexcept;
    ~SnapshotScope();
    void SetResult(bool success, const RECT* windowRect = nullptr) noexcept {
        m_success = success;
        if (windowRect) { m_rect = *windowRect; m_rectRead = true; }
    }
private:
    bool m_enabled = false, m_success = false;
    bool m_rectRead = false;
    RECT m_rect{};
    Tick m_started = 0;
    std::uintptr_t m_window = 0;
    std::uint64_t m_sequence = 0, m_generation = 0;
};

} // namespace WindowMotionDiagnostics
