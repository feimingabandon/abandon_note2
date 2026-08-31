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
void Shutdown();

}
