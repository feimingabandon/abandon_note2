#include <cstdio>
#include <string>
#include <vector>
#include <windows.h>
struct Target {
  DWORD pid;
  HWND window = nullptr;
};
static BOOL CALLBACK find(HWND window, LPARAM value) {
  auto target = reinterpret_cast<Target *>(value);
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  wchar_t title[80]{};
  GetWindowTextW(window, title, 80);
  if (pid == target->pid && IsWindowVisible(window) &&
      std::wstring(title) == L"Abandon 截图") {
    target->window = window;
    return FALSE;
  }
  return TRUE;
}
int wmain(int argc, wchar_t **argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (argc < 3)
    return 2;
  Target target{DWORD(std::stoul(argv[1]))};
  EnumWindows(find, reinterpret_cast<LPARAM>(&target));
  if (!target.window)
    return 3;
  SetForegroundWindow(target.window);
  Sleep(100);
  DWORD foregroundPid = 0;
  GetWindowThreadProcessId(GetForegroundWindow(), &foregroundPid);
  if (foregroundPid != target.pid) {
    // A programmatic test invocation is not a real global hotkey. Establish the
    // same input prerequisite as a user's click on this verified test-owned
    // overlay.
    RECT bounds{};
    GetWindowRect(target.window, &bounds);
    SetCursorPos(bounds.left + 20, bounds.top + 120);
    INPUT clicks[2]{};
    clicks[0].type = clicks[1].type = INPUT_MOUSE;
    clicks[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    clicks[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(2, clicks, sizeof(INPUT));
    Sleep(100);
    GetWindowThreadProcessId(GetForegroundWindow(), &foregroundPid);
  }
  if (foregroundPid != target.pid) {
    DWORD foregroundThread =
        GetWindowThreadProcessId(GetForegroundWindow(), nullptr);
    DWORD ownThread = GetCurrentThreadId();
    bool attached = AttachThreadInput(ownThread, foregroundThread, TRUE);
    SetForegroundWindow(target.window);
    if (attached)
      AttachThreadInput(ownThread, foregroundThread, FALSE);
    Sleep(100);
    GetWindowThreadProcessId(GetForegroundWindow(), &foregroundPid);
  }
  if (foregroundPid != target.pid) {
    std::fprintf(stderr,
                 "Native test foreground unavailable: expected PID %lu, actual "
                 "PID %lu\n",
                 target.pid, foregroundPid);
    return 4;
  }
  const std::wstring command(argv[2]);
  WORD key = command == L"Enter"   ? VK_RETURN
             : command == L"AltF4" ? VK_F4
                                   : WORD(argv[2][0]);
  WORD modifier = command == L"AltF4" ? VK_MENU : argc > 3 ? VK_CONTROL : 0;
  std::vector<INPUT> events;
  auto add = [&](WORD code, DWORD flags) {
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = code;
    input.ki.dwFlags = flags;
    events.push_back(input);
  };
  if (modifier)
    add(modifier, 0);
  add(key, 0);
  add(key, KEYEVENTF_KEYUP);
  if (modifier)
    add(modifier, KEYEVENTF_KEYUP);
  return SendInput(UINT(events.size()), events.data(), sizeof(INPUT)) ==
                 events.size()
             ? 0
             : 5;
}
