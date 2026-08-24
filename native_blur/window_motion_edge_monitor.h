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
    HandleMoved = 3,
};

enum class RevealMode : int {
    Direct = 0,
    // 首次触边仅显示原生小黑条，完整点击后才请求唤出主窗口。
    ClickHandle = 1,
    // 主窗口完成隐藏后由主进程显式激活，小黑条持续显示直到被点击或会话结束。
    PersistentHandle = 2,
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
    InvalidRevealMode = -12,
    HandleClassRegistrationFailed = -13, // 小黑条窗口类注册失败
    HandleWindowCreateFailed = -14,      // 小黑条 HWND 创建或初始化失败
    WorkerStartTimedOut = -15,           // 监视线程未在有界时间内完成初始化
    MonitorNotReady = -16,               // 目标代次没有可接收命令的活动监视线程
    InvalidHandlePosition = -17,         // 常显小黑条归一化位置不在 -1 或 0~1000
};

int Arm(
    HWND hwnd,
    int side,
    int thicknessDip,
    int pollIntervalMs,
    std::uint64_t generation);
int ArmEx(
    HWND hwnd,
    int side,
    int thicknessDip,
    int pollIntervalMs,
    std::uint64_t generation,
    int revealMode);
int Disarm(std::uint64_t generation);
int SetPersistentHandlePosition(std::uint64_t generation, int positionPermille);
int ShowPersistentHandle(std::uint64_t generation);
UINT GetMessageId();
const char* GetStatusJson();
const char* ConsumeEventJson();
void Shutdown();

} // namespace WindowMotionEdgeMonitor
