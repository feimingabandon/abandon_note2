#pragma once

#include <Windows.h>
#include <cstdint>

namespace WindowMotionEdgeMonitor {

enum class State : int {
    Stopped = 0,
    WaitingOutside = 1,
    Armed = 2,
    TriggerPending = 3,
    Degraded = 4,
    Failed = 5,
};

enum class EventKind : int {
    None = 0,
    Trigger = 1,
    Fault = 2,
};

enum class Result : int {
    Ok = 1,
    InvalidWindow = -1,
    InvalidSide = -2,
    EdgeNotExposed = -3,
    InvalidTriggerArea = -4,
    CursorUnavailable = -5,
    StopEventCreateFailed = -6,
    ThreadCreateFailed = -7,
    AlreadyArmed = -8,
    StopTimedOut = -9,
    MessageRegistrationFailed = -10,
    InvalidGeneration = -11,
};

int Arm(
    HWND hwnd,
    int side,
    int thicknessDip,
    int pollIntervalMs,
    std::uint64_t generation);
int Disarm(std::uint64_t generation);
UINT GetMessageId();
const char* GetStatusJson();
const char* ConsumeEventJson();
void Shutdown();

} // namespace WindowMotionEdgeMonitor
