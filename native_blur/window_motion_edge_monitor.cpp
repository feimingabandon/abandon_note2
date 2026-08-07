#include "window_motion_edge_monitor.h"
#include "blur_api.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <mutex>
#include <process.h>

namespace WindowMotionEdgeMonitor {
namespace {

constexpr DWORD kStopTimeoutMs = 2000;
constexpr int kCursorFailureLimit = 10;

struct PendingEvent {
    EventKind kind = EventKind::None;
    int side = 0;
    int error = 0;
    std::uint64_t generation = 0;
};

struct Runtime {
    std::mutex lifecycleMutex;
    std::mutex eventMutex;
    std::atomic<State> state{State::Stopped};
    std::atomic<bool> workerAlive{false};
    std::atomic<std::uint64_t> generation{0};
    std::atomic<ULONGLONG> lastPollTick{0};
    std::atomic<int> lastError{0};
    std::atomic<int> cursorFailureCount{0};

    HANDLE stopEvent = nullptr;
    HANDLE workerThread = nullptr;
    HWND notifyWindow = nullptr;
    int side = 0;
    int pollIntervalMs = 100;
    RECT triggerArea{};
    PendingEvent pendingEvent{};
};

Runtime g_runtime;

bool IsValidSide(int side) {
    return side == -2 || side == -1 || side == 1 || side == 2;
}

bool IsInside(const POINT& point, const RECT& area) {
    return point.x >= area.left && point.x < area.right &&
        point.y >= area.top && point.y < area.bottom;
}

bool HasPendingEvent(Runtime& runtime) {
    std::lock_guard<std::mutex> lock(runtime.eventMutex);
    return runtime.pendingEvent.kind != EventKind::None;
}

void StoreEvent(Runtime& runtime, EventKind kind, int error) {
    std::lock_guard<std::mutex> lock(runtime.eventMutex);
    if (runtime.pendingEvent.kind != EventKind::None) return;
    runtime.pendingEvent = {
        kind,
        runtime.side,
        error,
        runtime.generation.load()
    };
}

void PublishEvent(Runtime& runtime, EventKind kind, int error) {
    runtime.lastError.store(error);
    runtime.state.store(kind == EventKind::Trigger ? State::TriggerPending : State::Failed);
    StoreEvent(runtime, kind, error);

    bool notificationPosted = false;
    while (HasPendingEvent(runtime)) {
        if (!notificationPosted && runtime.notifyWindow && IsWindow(runtime.notifyWindow)) {
            notificationPosted = PostMessageW(runtime.notifyWindow, GetMessageId(), 0, 0) != FALSE;
        }

        const DWORD waitResult = WaitForSingleObject(
            runtime.stopEvent,
            static_cast<DWORD>(runtime.pollIntervalMs));
        if (waitResult == WAIT_OBJECT_0 || waitResult == WAIT_FAILED) return;
    }
}

unsigned __stdcall WorkerThreadProc(void* parameter) noexcept {
    auto* runtime = static_cast<Runtime*>(parameter);
    runtime->workerAlive.store(true);
    runtime->lastPollTick.store(GetTickCount64());

    POINT initialCursor{};
    if (!GetCursorPos(&initialCursor)) {
        runtime->workerAlive.store(false);
        PublishEvent(*runtime, EventKind::Fault, static_cast<int>(Result::CursorUnavailable));
        return 0;
    }

    bool previousInside = IsInside(initialCursor, runtime->triggerArea);
    runtime->state.store(previousInside ? State::WaitingOutside : State::Armed);

    while (true) {
        const DWORD waitResult = WaitForSingleObject(
            runtime->stopEvent,
            static_cast<DWORD>(runtime->pollIntervalMs));
        if (waitResult == WAIT_OBJECT_0) {
            runtime->state.store(State::Stopped);
            break;
        }
        if (waitResult != WAIT_TIMEOUT) {
            PublishEvent(*runtime, EventKind::Fault, static_cast<int>(GetLastError()));
            break;
        }

        runtime->lastPollTick.store(GetTickCount64());
        POINT cursor{};
        if (!GetCursorPos(&cursor)) {
            const int failures = runtime->cursorFailureCount.fetch_add(1) + 1;
            runtime->state.store(State::Degraded);
            if (failures >= kCursorFailureLimit) {
                PublishEvent(*runtime, EventKind::Fault, static_cast<int>(Result::CursorUnavailable));
                break;
            }
            continue;
        }

        runtime->cursorFailureCount.store(0);
        const bool inside = IsInside(cursor, runtime->triggerArea);
        const State state = runtime->state.load();

        if (state == State::Degraded) {
            runtime->state.store(inside ? State::WaitingOutside : State::Armed);
            previousInside = inside;
            continue;
        }

        if (state == State::WaitingOutside) {
            if (!inside) runtime->state.store(State::Armed);
            previousInside = inside;
            continue;
        }

        if (state == State::Armed && !previousInside && inside) {
            PublishEvent(*runtime, EventKind::Trigger, 0);
            break;
        }
        previousInside = inside;
    }

    runtime->workerAlive.store(false);
    return 0;
}

int StopLocked(Runtime& runtime, std::uint64_t generation) {
    if (generation != 0 && runtime.generation.load() != generation) return static_cast<int>(Result::Ok);
    if (!runtime.workerThread) {
        runtime.state.store(State::Stopped);
        return static_cast<int>(Result::Ok);
    }

    SetEvent(runtime.stopEvent);
    const DWORD waitResult = WaitForSingleObject(runtime.workerThread, kStopTimeoutMs);
    if (waitResult != WAIT_OBJECT_0) {
        runtime.lastError.store(static_cast<int>(Result::StopTimedOut));
        runtime.state.store(State::Failed);
        return static_cast<int>(Result::StopTimedOut);
    }

    CloseHandle(runtime.workerThread);
    CloseHandle(runtime.stopEvent);
    runtime.workerThread = nullptr;
    runtime.stopEvent = nullptr;
    runtime.notifyWindow = nullptr;
    runtime.workerAlive.store(false);
    runtime.state.store(State::Stopped);
    runtime.cursorFailureCount.store(0);
    runtime.lastError.store(0);
    {
        std::lock_guard<std::mutex> eventLock(runtime.eventMutex);
        runtime.pendingEvent = {};
    }
    return static_cast<int>(Result::Ok);
}

bool BuildTriggerArea(HWND hwnd, int side, int thicknessDip, RECT& output) {
    RECT windowRect{};
    if (!GetWindowRect(hwnd, &windowRect)) return false;

    const HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO monitorInfo{};
    monitorInfo.cbSize = sizeof(monitorInfo);
    if (!monitor || !GetMonitorInfoW(monitor, &monitorInfo)) return false;

    const UINT dpi = std::max<UINT>(96, GetDpiForWindow(hwnd));
    const LONG thickness = std::max<LONG>(1, MulDiv(std::max(1, thicknessDip), dpi, 96));
    const RECT& work = monitorInfo.rcWork;

    if (side == -1 || side == 1) {
        output.left = side < 0 ? work.left : work.right - thickness;
        output.right = side < 0 ? work.left + thickness : work.right;
        output.top = std::max(windowRect.top, work.top);
        output.bottom = std::min(windowRect.bottom, work.bottom);
    } else {
        output.left = std::max(windowRect.left, work.left);
        output.right = std::min(windowRect.right, work.right);
        output.top = side < 0 ? work.top : work.bottom - thickness;
        output.bottom = side < 0 ? work.top + thickness : work.bottom;
    }
    return output.right > output.left && output.bottom > output.top;
}

const char* StateName(State state) {
    switch (state) {
    case State::Stopped: return "stopped";
    case State::WaitingOutside: return "waiting-outside";
    case State::Armed: return "armed";
    case State::TriggerPending: return "trigger-pending";
    case State::Degraded: return "degraded";
    case State::Failed: return "failed";
    default: return "unknown";
    }
}

const char* EventName(EventKind kind) {
    switch (kind) {
    case EventKind::Trigger: return "trigger";
    case EventKind::Fault: return "fault";
    default: return "none";
    }
}

} // namespace

int Arm(
    HWND hwnd,
    int side,
    int thicknessDip,
    int pollIntervalMs,
    std::uint64_t generation) {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycleMutex);
    if (!hwnd || !IsWindow(hwnd)) return static_cast<int>(Result::InvalidWindow);
    if (!IsValidSide(side)) return static_cast<int>(Result::InvalidSide);
    if (generation == 0) return static_cast<int>(Result::InvalidGeneration);
    if (g_runtime.workerThread) return static_cast<int>(Result::AlreadyArmed);
    if (!WindowMotion_IsEdgeExposed(hwnd, side)) return static_cast<int>(Result::EdgeNotExposed);
    if (!GetMessageId()) return static_cast<int>(Result::MessageRegistrationFailed);

    RECT triggerArea{};
    if (!BuildTriggerArea(hwnd, side, thicknessDip, triggerArea)) {
        return static_cast<int>(Result::InvalidTriggerArea);
    }

    POINT cursor{};
    if (!GetCursorPos(&cursor)) return static_cast<int>(Result::CursorUnavailable);

    HANDLE stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!stopEvent) return static_cast<int>(Result::StopEventCreateFailed);

    g_runtime.stopEvent = stopEvent;
    g_runtime.notifyWindow = hwnd;
    g_runtime.side = side;
    g_runtime.pollIntervalMs = std::clamp(pollIntervalMs, 25, 1000);
    g_runtime.triggerArea = triggerArea;
    g_runtime.generation.store(generation);
    g_runtime.lastPollTick.store(GetTickCount64());
    g_runtime.lastError.store(0);
    g_runtime.cursorFailureCount.store(0);
    g_runtime.state.store(IsInside(cursor, triggerArea) ? State::WaitingOutside : State::Armed);
    {
        std::lock_guard<std::mutex> eventLock(g_runtime.eventMutex);
        g_runtime.pendingEvent = {};
    }

    g_runtime.workerThread = reinterpret_cast<HANDLE>(
        _beginthreadex(nullptr, 0, WorkerThreadProc, &g_runtime, 0, nullptr));
    if (!g_runtime.workerThread) {
        CloseHandle(g_runtime.stopEvent);
        g_runtime.stopEvent = nullptr;
        g_runtime.notifyWindow = nullptr;
        g_runtime.state.store(State::Stopped);
        return static_cast<int>(Result::ThreadCreateFailed);
    }
    return static_cast<int>(Result::Ok);
}

int Disarm(std::uint64_t generation) {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycleMutex);
    return StopLocked(g_runtime, generation);
}

UINT GetMessageId() {
    static const UINT messageId = RegisterWindowMessageW(
        L"AbandonNote.WindowMotion.EdgeEvent.v1");
    return messageId;
}

const char* GetStatusJson() {
    thread_local char json[768]{};
    PendingEvent event{};
    {
        std::lock_guard<std::mutex> lock(g_runtime.eventMutex);
        event = g_runtime.pendingEvent;
    }
    const ULONGLONG now = GetTickCount64();
    const ULONGLONG lastPoll = g_runtime.lastPollTick.load();
    const ULONGLONG pollAge = lastPoll > 0 && now >= lastPoll ? now - lastPoll : 0;
    const RECT area = g_runtime.triggerArea;
    sprintf_s(
        json,
        "{\"state\":\"%s\",\"workerAlive\":%s,\"generation\":%llu,\"side\":%d,"
        "\"lastError\":%d,\"cursorFailureCount\":%d,\"lastPollAgeMs\":%llu,"
        "\"pollIntervalMs\":%d,\"triggerArea\":{\"left\":%ld,\"top\":%ld,"
        "\"right\":%ld,\"bottom\":%ld},\"pendingEvent\":\"%s\"}",
        StateName(g_runtime.state.load()),
        g_runtime.workerAlive.load() ? "true" : "false",
        static_cast<unsigned long long>(g_runtime.generation.load()),
        g_runtime.side,
        g_runtime.lastError.load(),
        g_runtime.cursorFailureCount.load(),
        static_cast<unsigned long long>(pollAge),
        g_runtime.pollIntervalMs,
        area.left,
        area.top,
        area.right,
        area.bottom,
        EventName(event.kind));
    return json;
}

const char* ConsumeEventJson() {
    thread_local char json[256]{};
    PendingEvent event{};
    {
        std::lock_guard<std::mutex> lock(g_runtime.eventMutex);
        event = g_runtime.pendingEvent;
        g_runtime.pendingEvent = {};
    }
    sprintf_s(
        json,
        "{\"kind\":\"%s\",\"generation\":%llu,\"side\":%d,\"error\":%d}",
        EventName(event.kind),
        static_cast<unsigned long long>(event.generation),
        event.side,
        event.error);
    return json;
}

void Shutdown() {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycleMutex);
    StopLocked(g_runtime, 0);
}

} // namespace WindowMotionEdgeMonitor
