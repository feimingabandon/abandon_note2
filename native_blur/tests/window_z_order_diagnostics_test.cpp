#include "window_z_order.h"
#include "blur_engine.h"

#include <commctrl.h>
#include <algorithm>
#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

// Compile the real controller into this test translation unit. Only this target
// redirects Win32 calls; the product DLL has no fixture or fault-injection API.
// The fixture never opens a window or changes the user's desktop Z order.
namespace Fixture {
const HWND kTarget = reinterpret_cast<HWND>(0x101);
const HWND kOverlay = reinterpret_cast<HWND>(0x102);
const HWND kOrdinary = reinterpret_cast<HWND>(0x103);
const HWND kDesktop = reinterpret_cast<HWND>(0x104);
const HWND kRootDesktop = reinterpret_cast<HWND>(0x105);
const HWND kWorkerDesktop = reinterpret_cast<HWND>(0x106);
constexpr DWORD kThread = 500;
constexpr DWORD kProcess = 700;
constexpr DWORD kStaleError = 0x6a6a;

std::vector<HWND> order;
bool desktopPresent = true;
bool overlayPresent = false;
bool desktopVisible = true;
DWORD mainMoveError = ERROR_SUCCESS;
bool mainMoveFails = false;
DWORD overlayMoveError = ERROR_SUCCESS;
DWORD subclassError = ERROR_SUCCESS;
DWORD foregroundHookError = ERROR_SUCCESS;
DWORD reorderHookError = ERROR_SUCCESS;
DWORD ownerThread = kThread;
int mainMoveCalls = 0;
int overlayMoveCalls = 0;
unsigned long long tick = 100;

void Reset() {
    order = {kTarget, kOverlay, kOrdinary, kDesktop};
    desktopPresent = true;
    overlayPresent = false;
    desktopVisible = true;
    mainMoveError = overlayMoveError = subclassError = ERROR_SUCCESS;
    mainMoveFails = false;
    foregroundHookError = reorderHookError = ERROR_SUCCESS;
    ownerThread = kThread;
    mainMoveCalls = overlayMoveCalls = 0;
    ::SetLastError(kStaleError);
}

BOOL IsWindow(HWND hwnd) {
    ::SetLastError(kStaleError);
    return hwnd == kTarget || hwnd == kOrdinary || hwnd == kRootDesktop || hwnd == kWorkerDesktop ||
        (hwnd == kOverlay && overlayPresent) || (hwnd == kDesktop && desktopPresent);
}
BOOL IsWindowVisible(HWND hwnd) {
    return Fixture::IsWindow(hwnd) && (hwnd != kDesktop || desktopVisible);
}
BOOL IsIconic(HWND) { return FALSE; }
HWND GetDesktopWindow() { return kRootDesktop; }
HWND GetShellWindow() { return desktopPresent ? kDesktop : nullptr; }
DWORD GetCurrentThreadId() { return kThread; }
DWORD GetWindowThreadProcessId(HWND hwnd, LPDWORD process) {
    ::SetLastError(kStaleError);
    if (process) *process = Fixture::IsWindow(hwnd) ? kProcess : 0;
    return Fixture::IsWindow(hwnd) ? (hwnd == kTarget ? ownerThread : kThread + 1) : 0;
}
int GetClassNameW(HWND hwnd, LPWSTR name, int size) {
    ::SetLastError(kStaleError);
    if (!Fixture::IsWindow(hwnd) || size <= 0) return 0;
    const wchar_t* value = hwnd == kDesktop ? L"Progman" : hwnd == kWorkerDesktop ? L"WorkerW" :
        hwnd == kOverlay ? L"BlurOverlay" : L"FixtureWindow";
    wcsncpy_s(name, static_cast<std::size_t>(size), value, _TRUNCATE);
    return static_cast<int>(std::wcslen(name));
}
LONG_PTR GetWindowLongPtrW(HWND, int) {
    ::SetLastError(kStaleError);
    return 0;
}
HWND GetTopWindow(HWND) {
    return order.empty() ? nullptr : order.front();
}
HWND GetWindow(HWND hwnd, UINT command) {
    ::SetLastError(kStaleError);
    if (command == GW_OWNER) return nullptr;
    if (command != GW_HWNDNEXT) return nullptr;
    const auto at = std::find(order.begin(), order.end(), hwnd);
    return at != order.end() && std::next(at) != order.end() ? *std::next(at) : nullptr;
}
BOOL SetWindowPos(HWND hwnd, HWND after, int, int, int, int, UINT) {
    const DWORD error = hwnd == kOverlay ? overlayMoveError : mainMoveError;
    if (hwnd == kOverlay) ++overlayMoveCalls;
    else ++mainMoveCalls;
    if (error || (hwnd == kTarget && mainMoveFails)) {
        ::SetLastError(error);
        return FALSE;
    }
    order.erase(std::remove(order.begin(), order.end(), hwnd), order.end());
    if (after == HWND_TOP || after == HWND_TOPMOST || after == HWND_NOTOPMOST) {
        order.insert(order.begin(), hwnd);
    } else {
        const auto at = std::find(order.begin(), order.end(), after);
        order.insert(at == order.end() ? order.end() : std::next(at), hwnd);
    }
    // Successful APIs need not reset LastError. Diagnostics must not report
    // this stale value as a current Windows failure.
    ::SetLastError(kStaleError);
    return TRUE;
}
BOOL SetWindowSubclass(HWND, SUBCLASSPROC, UINT_PTR, DWORD_PTR) {
    ::SetLastError(subclassError ? subclassError : kStaleError);
    return subclassError == ERROR_SUCCESS;
}
BOOL RemoveWindowSubclass(HWND, SUBCLASSPROC, UINT_PTR) {
    // Cleanup deliberately clobbers LastError so failures must be saved first.
    ::SetLastError(kStaleError);
    return TRUE;
}
HWINEVENTHOOK SetWinEventHook(DWORD event, DWORD, HMODULE, WINEVENTPROC,
    DWORD, DWORD, DWORD) {
    const DWORD error = event == EVENT_SYSTEM_FOREGROUND
        ? foregroundHookError : reorderHookError;
    ::SetLastError(error ? error : kStaleError);
    return error ? nullptr : reinterpret_cast<HWINEVENTHOOK>(static_cast<ULONG_PTR>(event + 1));
}
BOOL UnhookWinEvent(HWINEVENTHOOK) {
    ::SetLastError(kStaleError);
    return TRUE;
}
BOOL PostMessageW(HWND, UINT, WPARAM, LPARAM) { return TRUE; }
UINT RegisterWindowMessageW(LPCWSTR name) {
    return std::wcscmp(name, L"TaskbarCreated") == 0 ? 0xc001 : 0xc002;
}
LRESULT DefSubclassProc(HWND, UINT, WPARAM, LPARAM) { return 0; }
ULONGLONG GetTickCount64() { return ++tick; }
} // namespace Fixture

namespace FixtureBlurEngine {
class Engine {
public:
    static Engine& Instance() { static Engine engine; return engine; }
    HWND GetOverlayWindow() const {
        return Fixture::overlayPresent ? Fixture::kOverlay : nullptr;
    }
};
} // namespace FixtureBlurEngine

#define BlurEngine FixtureBlurEngine
#define IsWindow Fixture::IsWindow
#define IsWindowVisible Fixture::IsWindowVisible
#define IsIconic Fixture::IsIconic
#define GetDesktopWindow Fixture::GetDesktopWindow
#define GetShellWindow Fixture::GetShellWindow
#define GetCurrentThreadId Fixture::GetCurrentThreadId
#define GetWindowThreadProcessId Fixture::GetWindowThreadProcessId
#define GetClassNameW Fixture::GetClassNameW
#define GetWindowLongPtrW Fixture::GetWindowLongPtrW
#define GetTopWindow Fixture::GetTopWindow
#define GetWindow Fixture::GetWindow
#define SetWindowPos Fixture::SetWindowPos
#define SetWindowSubclass Fixture::SetWindowSubclass
#define RemoveWindowSubclass Fixture::RemoveWindowSubclass
#define SetWinEventHook Fixture::SetWinEventHook
#define UnhookWinEvent Fixture::UnhookWinEvent
#define PostMessageW Fixture::PostMessageW
#define RegisterWindowMessageW Fixture::RegisterWindowMessageW
#define DefSubclassProc Fixture::DefSubclassProc
#define GetTickCount64 Fixture::GetTickCount64
#include "../window_z_order.cpp"
#undef BlurEngine
#undef IsWindow
#undef IsWindowVisible
#undef IsIconic
#undef GetDesktopWindow
#undef GetShellWindow
#undef GetCurrentThreadId
#undef GetWindowThreadProcessId
#undef GetClassNameW
#undef GetWindowLongPtrW
#undef GetTopWindow
#undef GetWindow
#undef SetWindowPos
#undef SetWindowSubclass
#undef RemoveWindowSubclass
#undef SetWinEventHook
#undef UnhookWinEvent
#undef PostMessageW
#undef RegisterWindowMessageW
#undef DefSubclassProc
#undef GetTickCount64

namespace {
int assertions = 0, passed = 0, failed = 0;

void Require(bool condition, const char* message) {
    ++assertions;
    if (!condition) { ++failed; throw std::runtime_error(message); }
    ++passed;
}
std::string Token(const char* key) { return std::string("\"") + key + "\":"; }
std::size_t ValueAt(const std::string& json, const char* key) {
    const auto at = json.find(Token(key));
    Require(at != std::string::npos, "expected diagnostic JSON field");
    return at + Token(key).size();
}
unsigned long long Number(const std::string& json, const char* key) {
    return std::strtoull(json.c_str() + ValueAt(json, key), nullptr, 10);
}
bool HasValue(const std::string& json, const char* key, const char* value) {
    return json.compare(ValueAt(json, key), std::char_traits<char>::length(value), value) == 0;
}
std::string Object(const std::string& json, const char* key) {
    const auto start = ValueAt(json, key);
    Require(json[start] == '{', "expected diagnostic JSON object");
    bool quoted = false, escaped = false;
    int depth = 0;
    for (auto at = start; at < json.size(); ++at) {
        const auto ch = json[at];
        if (quoted) {
            if (escaped) escaped = false;
            else if (ch == '\\') escaped = true;
            else if (ch == '"') quoted = false;
        } else if (ch == '"') quoted = true;
        else if (ch == '{') ++depth;
        else if (ch == '}' && --depth == 0) return json.substr(start, at - start + 1);
    }
    throw std::runtime_error("unterminated diagnostic object");
}
std::string Read() {
    const char* json = WindowZOrder::GetLastFailureJson();
    Require(json != nullptr, "failure diagnostics must be readable");
    return json;
}
void ExpectFailure(const std::string& failure, const char* operation,
    const char* stage, int result, DWORD error = ERROR_SUCCESS) {
    const auto operationValue = std::string("\"") + operation + "\"";
    const auto stageValue = std::string("\"") + stage + "\"";
    Require(HasValue(failure, "operation", operationValue.c_str()), "incorrect failure operation");
    Require(HasValue(failure, "stage", stageValue.c_str()), "incorrect failure stage");
    Require(std::strtol(failure.c_str() + ValueAt(failure, "resultCode"), nullptr, 10) == result,
        "incorrect result code");
    if (error) {
        Require(Number(failure, "win32Error") == error, "Win32 error lost to diagnostic or cleanup calls");
        Require(HasValue(failure, "win32ErrorSource", "\"GetLastError\""), "missing error source");
    } else {
        Require(HasValue(failure, "win32Error", "null"), "non-API failure reported a stale Win32 error");
        Require(HasValue(failure, "win32ErrorSource", "\"not-applicable\""), "incorrect logical failure error source");
    }
}

void TestDiagnosticHistory() {
    Fixture::Reset();
    auto history = Read();
    Require(Number(history, "schemaVersion") == 1, "unexpected diagnostic schema");
    Require(Number(history, "failureCount") == 0, "fresh controller has failure history");
    Require(HasValue(history, "firstFailure", "null"), "fresh controller has a first failure");
    Require(HasValue(history, "lastFailure", "null"), "fresh controller has a last failure");
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == 1, "baseline enable failed");
    Require(WindowZOrder::SetBottom(Fixture::kTarget, false) == 1, "baseline disable failed");
    Require(Number(Read(), "failureCount") == 0, "successful APIs reported stale LastError");

    Fixture::Reset();
    Fixture::desktopPresent = false;
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == -5, "no-desktop fixture must fail");
    history = Read();
    const auto first = Object(history, "firstFailure");
    ExpectFailure(first, "enable", "no-desktop-host", -5);
    Require(Object(history, "lastFailure") == first, "first and last failure differ on first failure");
    Require(Fixture::mainMoveCalls == 0, "no-desktop failure attempted SetWindowPos");
    Require(HasValue(first, "controllerEnabled", "true"), "snapshot was captured after reset");
    Require(HasValue(Object(Object(first, "windows"), "target"), "valid", "true"),
        "failure snapshot lost target before controller reset");
    Require(HasValue(WindowZOrder::GetStatusJson(Fixture::kTarget), "enabled", "false"),
        "failed initialization did not reset controller");
    Require(Object(Read(), "firstFailure") == first, "GetStatus or reset erased first failure");

    Fixture::Reset();
    Fixture::mainMoveError = ERROR_ACCESS_DENIED;
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == -5, "main SetWindowPos fixture must fail");
    history = Read();
    auto last = Object(history, "lastFailure");
    ExpectFailure(last, "enable", "main-set-window-pos", -5, ERROR_ACCESS_DENIED);
    Require(HasValue(last, "mainMoveAttempted", "true"), "missing main attempt marker");
    Require(HasValue(last, "mainMoved", "false"), "main failure must report false");
    Require(HasValue(last, "overlayMoveAttempted", "false"), "main failure attempted overlay move");
    Require(HasValue(last, "overlayMoved", "null"), "unattempted overlay has a fabricated result");
    Require(Object(history, "firstFailure") == first, "later failure overwrote first failure");

    Fixture::Reset();
    Fixture::overlayPresent = true;
    Fixture::overlayMoveError = ERROR_INVALID_WINDOW_HANDLE;
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == -5, "overlay SetWindowPos fixture must fail");
    history = Read();
    last = Object(history, "lastFailure");
    ExpectFailure(last, "enable", "overlay-set-window-pos", -5, ERROR_INVALID_WINDOW_HANDLE);
    Require(HasValue(last, "mainMoveAttempted", "true"), "overlay failure lost main attempt");
    Require(HasValue(last, "mainMoved", "true"), "overlay failure lost successful main move");
    Require(HasValue(last, "overlayMoveAttempted", "true"), "overlay failure lost attempt");
    Require(HasValue(last, "overlayMoved", "false"), "overlay failure must report false");
    Require(Fixture::mainMoveCalls == 1 && Fixture::overlayMoveCalls == 1,
        "overlay fixture did not execute the expected real controller path");
    Require(Object(history, "firstFailure") == first, "overlay failure overwrote first failure");

    // A later rollback/disable failure must have its own last failure without
    // replacing the initiating failure, even though disable resets state first.
    Fixture::Reset();
    Fixture::overlayPresent = true;
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == 1, "enable before rollback failed");
    Fixture::mainMoveError = ERROR_GEN_FAILURE;
    Require(WindowZOrder::SetBottom(Fixture::kTarget, false) == -5, "disable fixture must fail");
    history = Read();
    last = Object(history, "lastFailure");
    ExpectFailure(last, "disable", "main-set-window-pos", -5, ERROR_GEN_FAILURE);
    Require(HasValue(Object(Object(last, "windows"), "target"), "valid", "true"),
        "disable reset erased failed target snapshot");
    Require(Object(history, "firstFailure") == first, "rollback failure overwrote first failure");
    Require(Number(history, "failureCount") == 4, "diagnostic failure count is incorrect");

    Fixture::Reset();
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == 1, "enable after failures failed");
    Require(WindowZOrder::Reassert(Fixture::kTarget) == 1, "successful reassert failed");
    Require(WindowZOrder::SetBottom(Fixture::kTarget, false) == 1, "disable after failures failed");
    Require(Read() == history, "success cleared or mutated historical failures");
    WindowZOrder::Shutdown();
    Require(Read() == history, "shutdown erased historical failures");

    // BOOL failure with unchanged LastError is a real API failure with an
    // observed code of zero, distinct from a predicate with no Win32 error.
    Fixture::Reset();
    Fixture::mainMoveFails = true;
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == -5, "zero-error API fixture must fail");
    last = Object(Read(), "lastFailure");
    Require(HasValue(last, "win32Error", "0"), "API failure without error must preserve observed zero");
    Require(HasValue(last, "win32ErrorSource", "\"GetLastError\""), "observed zero lost API provenance");

    Fixture::Reset();
    Fixture::subclassError = ERROR_ACCESS_DENIED;
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == -3, "subclass fixture must fail");
    ExpectFailure(Object(Read(), "lastFailure"), "enable", "subclass-install", -3, ERROR_ACCESS_DENIED);

    Fixture::Reset();
    Fixture::foregroundHookError = ERROR_INVALID_HOOK_FILTER;
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == -4, "foreground hook fixture must fail");
    ExpectFailure(Object(Read(), "lastFailure"), "enable", "foreground-hook-install", -4,
        ERROR_INVALID_HOOK_FILTER);

    Fixture::Reset();
    Fixture::reorderHookError = ERROR_INVALID_HOOK_HANDLE;
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == -4, "reorder hook fixture must fail");
    ExpectFailure(Object(Read(), "lastFailure"), "enable", "reorder-hook-install", -4,
        ERROR_INVALID_HOOK_HANDLE);
    Require(Object(Read(), "firstFailure") == first, "setup failures overwrote initiating failure");
}
void TestDesktopBoundary() {
    for (const bool overlay : {false, true}) {
        // This is a fresh controller, including after disable/re-enable. Windows
        // behind the highest visible desktop cannot be moved by anchoring above it.
        for (int activation = 0; activation < 2; ++activation) {
            WindowZOrder::Shutdown();
            Fixture::Reset();
            Fixture::overlayPresent = overlay;
            Fixture::order = {Fixture::kTarget, Fixture::kOverlay, Fixture::kWorkerDesktop,
                Fixture::kOrdinary, Fixture::kDesktop};
            Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == 1,
                "desktop-background layout must enable bottom mode");
            auto status = std::string(WindowZOrder::GetStatusJson(Fixture::kTarget));
            Require(HasValue(status, "anchored", "true"),
                "window behind highest desktop was incorrectly treated as an application blocker");
            Require(Number(status, "ordinaryWindowsBelow") == 0,
                "application-band count continued behind a visible desktop");
            Require(Number(status, "desktopWindowsBelow") == 2,
                "desktop diagnostic lost additional desktop hosts");
            const int moves = Fixture::mainMoveCalls;
            for (int retry = 0; retry < 4; ++retry) {
                Require(WindowZOrder::Reassert(Fixture::kTarget) == 1, "reassert must succeed");
                Require(HasValue(WindowZOrder::GetStatusJson(Fixture::kTarget), "anchored", "true"),
                    "reassert lost desktop boundary");
            }
            Require(Fixture::mainMoveCalls == moves,
                "already-anchored layout caused unnecessary window moves");

            // A real application window between the note and desktop still
            // invalidates the order and must be repaired, rather than ignored.
            Fixture::order = {Fixture::kTarget, Fixture::kOverlay, Fixture::kOrdinary,
                Fixture::kWorkerDesktop, Fixture::kDesktop};
            status = WindowZOrder::GetStatusJson(Fixture::kTarget);
            Require(Number(status, "ordinaryWindowsBelow") == 1, "application blocker was lost");
            Require(HasValue(status, "anchored", "false"), "application blocker was accepted");
            Require(WindowZOrder::Reassert(Fixture::kTarget) == 1, "blocker repair failed");
            Require(HasValue(WindowZOrder::GetStatusJson(Fixture::kTarget), "anchored", "true"),
                "blocker repair did not restore bottom order");
            Require(WindowZOrder::SetBottom(Fixture::kTarget, false) == 1, "disable failed");
        }
    }

    Fixture::Reset();
    Require(WindowZOrder::SetBottom(Fixture::kTarget, true) == 1, "hidden desktop setup failed");
    Fixture::desktopVisible = false;
    Fixture::order = {Fixture::kTarget, Fixture::kDesktop, Fixture::kOrdinary, Fixture::kWorkerDesktop};
    auto status = std::string(WindowZOrder::GetStatusJson(Fixture::kTarget));
    Require(Number(status, "ordinaryWindowsBelow") == 1, "hidden desktop incorrectly ended the band");
    Require(HasValue(status, "anchored", "false"), "hidden desktop concealed an application blocker");
    Require(WindowZOrder::Reassert(Fixture::kTarget) == 1, "visible WorkerW recovery failed");
    Require(HasValue(WindowZOrder::GetStatusJson(Fixture::kTarget), "anchored", "true"),
        "visible WorkerW recovery did not restore order");
    WindowZOrder::Shutdown();
}
} // namespace

void PrintResult() {
    std::cout << "{\"completed\":true,\"assertions\":{\"total\":" << assertions
        << ",\"passed\":" << passed << ",\"failed\":" << failed << ",\"skipped\":0}}\n";
}
int main() {
    try {
        TestDiagnosticHistory();
        TestDesktopBoundary();
        PrintResult();
        return 0;
    } catch (const std::exception& error) {
        if (!failed) { ++assertions; ++failed; }
        std::cerr << "window_z_order_diagnostics_test failed: " << error.what() << '\n';
        PrintResult();
        return 1;
    }
}
