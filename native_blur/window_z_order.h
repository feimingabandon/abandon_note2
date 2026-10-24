#pragma once

#include <windows.h>

namespace WindowZOrder {

enum class ResultCode : int {
    Success = 1,
    InvalidWindow = -1,
    WrongThread = -2,
    SubclassInstallFailed = -3,
    WinEventHookFailed = -4,
    ApplyFailed = -5,
    NotEnabled = -6
};

int SetBottom(HWND hwnd, bool enabled);
int Reassert(HWND hwnd);
const char* GetStatusJson(HWND hwnd);
// Bounded process-lifetime evidence: successful operations and ResetState never
// clear the first failure or the most recent failure. No window titles are read.
const char* GetLastFailureJson() noexcept;
void Shutdown();

}
