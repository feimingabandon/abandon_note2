#include "blur_api.h"
#include "dispatcher_queue_lifetime.h"

#include <DispatcherQueue.h>
#include <TlHelp32.h>
#include <DbgHelp.h>
#include <cstdio>
#include <cwchar>
#include <exception>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using QueueAsyncStatus = winrt::Windows::Foundation::AsyncStatus;
using winrt::Windows::Foundation::IAsyncAction;
using winrt::Windows::System::DispatcherQueueController;
using BlurEngine::Detail::DrainDispatcherQueueShutdown;
using BlurEngine::Detail::ShutdownDispatcherQueueOnCurrentThread;
using BlurEngine::Detail::TryFinishDispatcherQueueShutdown;

namespace {

int total = 0, passed = 0, failed = 0;
bool cleanupComplete = true;

// Only the owned test executable installs this handler. Preserve the original
// fault context before process teardown; no recovery, retry or success follows.
LONG WINAPI CaptureOwnedCrash(EXCEPTION_POINTERS* exception) {
    HANDLE process = GetCurrentProcess();
    wchar_t directory[32768]{};
    const DWORD length = GetEnvironmentVariableW(L"ABANDON_TEST_EVIDENCE_DIR", directory, 32768);
    if (length && length < 32700) {
        wcscat_s(directory, L"/native-crash.dmp");
        HANDLE dump = CreateFileW(directory, GENERIC_WRITE, 0, nullptr, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL, nullptr);
        if (dump != INVALID_HANDLE_VALUE) {
            MINIDUMP_EXCEPTION_INFORMATION details{ GetCurrentThreadId(), exception, FALSE };
            MiniDumpWriteDump(process, GetCurrentProcessId(), dump,
                static_cast<MINIDUMP_TYPE>(MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules),
                &details, nullptr, nullptr);
            CloseHandle(dump);
        }
    }
    std::fprintf(stderr, "owned-crash code=0x%08lx address=%p thread=%lu\n",
        exception->ExceptionRecord->ExceptionCode,
        exception->ExceptionRecord->ExceptionAddress, GetCurrentThreadId());
    SymSetOptions(SYMOPT_DEFERRED_LOADS | SYMOPT_FAIL_CRITICAL_ERRORS | SYMOPT_NO_PROMPTS);
    SymInitialize(process, "", TRUE);
    CONTEXT context = *exception->ContextRecord;
    STACKFRAME64 frame{};
    frame.AddrPC = { context.Rip, 0, AddrModeFlat };
    frame.AddrFrame = { context.Rbp, 0, AddrModeFlat };
    frame.AddrStack = { context.Rsp, 0, AddrModeFlat };
    for (unsigned index = 0; index < 32 && frame.AddrPC.Offset; ++index) {
        HMODULE module = nullptr;
        char name[1024]{};
        GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
            GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<const char*>(frame.AddrPC.Offset), &module);
        if (module) GetModuleFileNameA(module, name, sizeof(name));
        else std::snprintf(name, sizeof(name), "<unmapped>");
        std::fprintf(stderr, "frame=%u pc=0x%llx module=%s offset=0x%llx\n", index,
            frame.AddrPC.Offset, name,
            frame.AddrPC.Offset - reinterpret_cast<ULONG64>(module));
        if (!StackWalk64(IMAGE_FILE_MACHINE_AMD64, process, GetCurrentThread(),
            &frame, &context, nullptr, SymFunctionTableAccess64, SymGetModuleBase64, nullptr)) break;
    }
    std::fflush(stderr);
    return EXCEPTION_EXECUTE_HANDLER;
}

struct AssertionFailure : std::runtime_error {
    using std::runtime_error::runtime_error;
};

void Require(bool accepted, const char* description) {
    ++total;
    if (!accepted) {
        ++failed;
        throw AssertionFailure(description);
    }
    ++passed;
}

void Stage(const char* stage) {
    std::cerr << "dispatcher-lifetime pid=" << GetCurrentProcessId()
        << " thread=" << GetCurrentThreadId() << " stage=" << stage << std::endl;
}

struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE handle = nullptr) : value(handle) {}
    bool Close() noexcept {
        if (!value || value == INVALID_HANDLE_VALUE) return true;
        if (!CloseHandle(value)) return false;
        value = nullptr;
        return true;
    }
    ~Handle() { Close(); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};

// The product helper also serves a queue created before any composition/window
// exists. All test queue references are released before this owner uninitializes
// COM; an unconfirmed drain deliberately remains under the outer runner bound.
void WithQueue(const std::function<void(DispatcherQueueController&, IAsyncAction&)>& exercise) {
    std::exception_ptr problem;
    std::thread worker([&] {
        DispatcherQueueController controller{ nullptr };
        IAsyncAction shutdown{ nullptr };
        const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        try {
            Require(SUCCEEDED(initialized), "test owner STA COM initialization failed");
            DispatcherQueueOptions options{
                sizeof(DispatcherQueueOptions), DQTYPE_THREAD_CURRENT, DQTAT_COM_STA };
            const HRESULT created = CreateDispatcherQueueController(options,
                reinterpret_cast<ABI::Windows::System::IDispatcherQueueController**>(
                    winrt::put_abi(controller)));
            Require(SUCCEEDED(created) && controller, "test current-thread queue creation failed");
            exercise(controller, shutdown);
        } catch (...) {
            problem = std::current_exception();
            cleanupComplete = false;
        }
        if (shutdown) DrainDispatcherQueueShutdown(controller, shutdown);
        else ShutdownDispatcherQueueOnCurrentThread(controller);
        if (SUCCEEDED(initialized)) CoUninitialize();
    });
    worker.join();
    if (problem) std::rethrow_exception(problem);
}

// Only the observation step receives this action. It never enters the actual
// queue's drain, so a negative ownership check cannot require killing a thread.
struct FailedAction : winrt::implements<FailedAction,
    IAsyncAction, winrt::Windows::Foundation::IAsyncInfo> {
    QueueAsyncStatus status;
    bool failResults;
    winrt::Windows::Foundation::AsyncActionCompletedHandler handler{ nullptr };
    FailedAction(QueueAsyncStatus value, bool throws) : status(value), failResults(throws) {}
    uint32_t Id() const noexcept { return 1; }
    QueueAsyncStatus Status() const noexcept { return status; }
    winrt::hresult ErrorCode() const noexcept { return E_ACCESSDENIED; }
    void Cancel() const noexcept {}
    void Close() const noexcept {}
    void Completed(const winrt::Windows::Foundation::AsyncActionCompletedHandler& value) {
        handler = value;
    }
    winrt::Windows::Foundation::AsyncActionCompletedHandler Completed() const { return handler; }
    void GetResults() const { if (failResults) winrt::throw_hresult(E_ACCESSDENIED); }
};

struct PendingTimer {
    winrt::Windows::Foundation::Deferral deferral{ nullptr };
    bool completed = false;
    HRESULT failure = S_OK;
};
thread_local PendingTimer* pendingTimer = nullptr;

void CALLBACK CompletePending(HWND, UINT, UINT_PTR timer, DWORD) noexcept {
    KillTimer(nullptr, timer);
    if (!pendingTimer) return;
    try {
        pendingTimer->deferral.Complete();
        pendingTimer->completed = true;
    } catch (...) {
        pendingTimer->failure = winrt::to_hresult();
    }
}

void HelperCases() {
    Stage("helper-empty");
    DispatcherQueueController empty{ nullptr };
    IAsyncAction absent{ nullptr };
    HRESULT failure = S_OK;
    Require(TryFinishDispatcherQueueShutdown(empty, absent, failure), "empty owner must be closed");
    ShutdownDispatcherQueueOnCurrentThread(empty);
    ShutdownDispatcherQueueOnCurrentThread(empty);
    Require(!empty && !absent, "repeated empty cleanup must remain empty");

    for (int round = 0; round < 3; ++round) {
        Stage("helper-partial-init");
        WithQueue([](auto& controller, auto&) {
            bool ran = false;
            auto queue = controller.DispatcherQueue();
            Require(queue.TryEnqueue([&] { ran = true; }), "owned queue must accept pre-shutdown work");
            ShutdownDispatcherQueueOnCurrentThread(controller);
            Require(ran, "queue shutdown must service accepted work");
            Require(!controller, "successful queue shutdown must release its controller");
            ShutdownDispatcherQueueOnCurrentThread(controller);
            Require(!controller, "second queue cleanup must not recreate resources");
            queue = nullptr;
        });
    }

    Stage("helper-error-ownership");
    WithQueue([](auto& controller, auto& shutdown) {
        for (const bool failResults : {false, true}) {
            const auto owner = winrt::get_abi(controller);
            shutdown = winrt::make<FailedAction>(
                failResults ? QueueAsyncStatus::Completed : QueueAsyncStatus::Error, failResults);
            const auto action = winrt::get_abi(shutdown);
            HRESULT error = S_OK;
            const bool closed = TryFinishDispatcherQueueShutdown(controller, shutdown, error);
            const bool retained = winrt::get_abi(controller) == owner &&
                winrt::get_abi(shutdown) == action;
            // This is a synthetic action, not the queue's real shutdown. Drop it
            // before asserting so failure cleanup still uses the actual owner.
            shutdown = nullptr;
            Require(!closed, "failed shutdown/GetResults must never report closed");
            Require(retained, "unconfirmed shutdown must retain controller and action");
            Require(error == E_ACCESSDENIED, "shutdown failure must retain the original HRESULT");
        }
    });

    Stage("helper-pending-wm-quit");
    WithQueue([](auto& controller, auto& shutdown) {
        auto queue = controller.DispatcherQueue();
        PendingTimer timer;
        bool started = false;
        const auto token = queue.ShutdownStarting([&](auto const&, auto const& arguments) {
            timer.deferral = arguments.GetDeferral();
            started = true;
        });
        UINT_PTR timerId = 0;
        try {
            shutdown = controller.ShutdownQueueAsync();
            const ULONGLONG deadline = GetTickCount64() + 2'000;
            MSG message{};
            while (!started && GetTickCount64() < deadline) {
                if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
                    if (message.message != WM_QUIT) {
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                } else Sleep(1);
            }
            Require(started && timer.deferral, "real queue shutdown-starting deferral did not arrive");
            const auto owner = winrt::get_abi(controller);
            const auto action = winrt::get_abi(shutdown);
            HRESULT error = S_OK;
            Require(!TryFinishDispatcherQueueShutdown(controller, shutdown, error),
                "held real shutdown deferral must remain pending");
            Require(SUCCEEDED(error) && winrt::get_abi(controller) == owner &&
                winrt::get_abi(shutdown) == action, "pending shutdown must retain its owner references");
            pendingTimer = &timer;
            timerId = SetTimer(nullptr, 0, 15, CompletePending);
            Require(timerId != 0, "owned completion timer could not be created");
            PostQuitMessage(47);
            DrainDispatcherQueueShutdown(controller, shutdown);
            Require(timer.completed && SUCCEEDED(timer.failure),
                "shutdown pump must service the owned completion after WM_QUIT");
            Require(!controller && !shutdown, "only confirmed shutdown may release both references");
        } catch (...) {
            if (timerId) KillTimer(nullptr, timerId);
            pendingTimer = nullptr;
            queue.ShutdownStarting(token);
            if (timer.deferral && !timer.completed) timer.deferral.Complete();
            if (shutdown) DrainDispatcherQueueShutdown(controller, shutdown);
            throw;
        }
        if (timerId) KillTimer(nullptr, timerId);
        pendingTimer = nullptr;
        queue.ShutdownStarting(token);
        timer.deferral = nullptr;
        queue = nullptr;
    });
}

struct Resources {
    long long handles = -1, threads = -1, user = -1, gdi = -1;
};

Resources Snapshot() {
    Resources result;
    DWORD handles = 0;
    if (GetProcessHandleCount(GetCurrentProcess(), &handles)) result.handles = handles;
    result.user = GetGuiResources(GetCurrentProcess(), GR_USEROBJECTS);
    result.gdi = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0));
    if (snapshot.value != INVALID_HANDLE_VALUE) {
        result.threads = 0;
        THREADENTRY32 thread{ sizeof(THREADENTRY32) };
        if (Thread32First(snapshot.value, &thread)) do {
            if (thread.th32OwnerProcessID == GetCurrentProcessId()) ++result.threads;
        } while (Thread32Next(snapshot.value, &thread));
    }
    return result;
}

std::vector<HWND> OwnedOverlays() {
    std::vector<HWND> windows;
    EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
        DWORD process = 0;
        GetWindowThreadProcessId(window, &process);
        if (process != GetCurrentProcessId()) return TRUE;
        wchar_t name[64]{};
        if (GetClassNameW(window, name, 64) && std::wcscmp(name, L"BlurOverlayWindow") == 0)
            reinterpret_cast<std::vector<HWND>*>(parameter)->push_back(window);
        return TRUE;
    }, reinterpret_cast<LPARAM>(&windows));
    return windows;
}

struct Cycle {
    int round;
    bool initSuccess = false, overlaySeen = false, staExited = false;
    bool overlayReleased = false, parentIntact = false;
    DWORD ownerThread = 0;
    Resources before, after;
    std::string afterInit = "null", afterDestroy = "null", afterRepeatedDestroy = "null";
};
std::vector<Cycle> cycles;
std::string initialDiagnostic = "null", invalidInitDiagnostic = "null",
    rejectedGeometryDiagnostic = "null", uncreatedDestroyDiagnostic = "null";

std::string ReadNativeDiagnostic() {
    const char* json = Blur_GetLastFailureJson();
    return json ? json : "null";
}

void ProductCycles() {
    Stage("product-uncreated-owner");
    initialDiagnostic = ReadNativeDiagnostic();
    Require(Blur_Init(nullptr) == 0, "invalid parent must not initialize an engine");
    invalidInitDiagnostic = ReadNativeDiagnostic();
    Require(Blur_SyncGeometryAndWait(1) == 0,
        "uncreated owner must reject geometry without creating a thread");
    rejectedGeometryDiagnostic = ReadNativeDiagnostic();
    Blur_Destroy();
    uncreatedDestroyDiagnostic = ReadNativeDiagnostic();
    Require(Blur_IsInitialized() == 0 && Blur_IsHealthy() == 0,
        "uncreated engine cleanup must not advertise a usable owner");
    Stage("product-parent-create");
    constexpr wchar_t parentClass[] = L"Abandon.DispatcherLifetime.Parent";
    const HINSTANCE module = GetModuleHandleW(nullptr);
    WNDCLASSEXW type{};
    type.cbSize = sizeof(type);
    type.lpfnWndProc = DefWindowProcW;
    type.hInstance = module;
    type.lpszClassName = parentClass;
    Require(RegisterClassExW(&type) != 0, "owned hidden parent registration failed");
    HWND parent = CreateWindowExW(0, parentClass, L"Owned queue lifecycle fixture",
        WS_OVERLAPPEDWINDOW, 200, 200, 320, 220, nullptr, nullptr, module, nullptr);
    try {
        Require(parent != nullptr && !IsWindowVisible(parent), "owned parent must start hidden");
        Require(OwnedOverlays().empty(), "fixture must start without any owned blur overlay");
        // Three complete rounds and one subsequent successful initialization.
        // Each retained thread HANDLE proves real STA exit independently of the
        // void Blur_Destroy export or a reused thread ID.
        for (int round = 1; round <= 4; ++round) {
            Stage("product-init");
            cycles.push_back(Cycle{ round });
            auto& cycle = cycles.back();
            cycle.before = Snapshot();
            cycle.initSuccess = Blur_Init(parent) == 1;
            cycle.afterInit = ReadNativeDiagnostic();
            Require(cycle.initSuccess, "real product initialization failed");
            Require(Blur_IsInitialized() == 1 && Blur_IsHealthy() == 1,
                "real product must publish a healthy initialized engine");
            const auto overlays = OwnedOverlays();
            cycle.overlaySeen = overlays.size() == 1;
            Require(cycle.overlaySeen, "product must own exactly one fixture overlay");
            DWORD ownerProcess = 0;
            cycle.ownerThread = GetWindowThreadProcessId(overlays.front(), &ownerProcess);
            Require(ownerProcess == GetCurrentProcessId() && cycle.ownerThread != GetCurrentThreadId(),
                "overlay must belong to this process and its separate STA");
            Handle sta(OpenThread(SYNCHRONIZE | THREAD_QUERY_LIMITED_INFORMATION, FALSE,
                cycle.ownerThread));
            Require(sta.value != nullptr, "could not retain the exact owned STA thread handle");
            Stage("product-destroy");
            Blur_Destroy();
            cycle.afterDestroy = ReadNativeDiagnostic();
            cycle.staExited = WaitForSingleObject(sta.value, 0) == WAIT_OBJECT_0;
            cycle.overlayReleased = OwnedOverlays().empty();
            cycle.parentIntact = IsWindow(parent) && !IsWindowVisible(parent);
            Require(sta.Close(), "owned STA observation handle could not be closed");
            cycle.after = Snapshot();
            Require(cycle.staExited, "Destroy returned without confirmed real STA exit");
            Require(cycle.overlayReleased, "Destroy left an owned overlay HWND");
            Require(cycle.parentIntact, "native cleanup changed the owned hidden parent");
            Require(Blur_IsInitialized() == 0 && Blur_IsHealthy() == 0,
                "destroyed product must not publish initialized/healthy state");
            Blur_Destroy();
            cycle.afterRepeatedDestroy = ReadNativeDiagnostic();
            Require(OwnedOverlays().empty(), "repeated Destroy must not create an overlay");
        }
        Require(DestroyWindow(parent) != FALSE, "owned parent could not be destroyed");
        parent = nullptr;
        Require(UnregisterClassW(parentClass, module) != FALSE, "owned parent class remained in use");
    } catch (...) {
        cleanupComplete = false;
        // Clean only this process's initialized engine and its exact fixture HWND.
        // A timeout remains a failure even if a later cleanup call returns.
        Blur_Destroy();
        if (parent && IsWindow(parent)) DestroyWindow(parent);
        UnregisterClassW(parentClass, module);
        throw;
    }
}

void WriteResources(const Resources& resources) {
    std::cout << "{\"handles\":" << resources.handles << ",\"threads\":" << resources.threads
        << ",\"user\":" << resources.user << ",\"gdi\":" << resources.gdi << '}';
}

void Report(bool completed) {
    std::cout << std::boolalpha << "{\"completed\":" << completed
        << ",\"assertions\":{\"total\":" << total << ",\"passed\":" << passed
        << ",\"failed\":" << failed << ",\"skipped\":0},\"cleanupComplete\":"
        << cleanupComplete << ",\"cycles\":[";
    bool first = true;
    for (const auto& cycle : cycles) {
        if (!first) std::cout << ',';
        first = false;
        std::cout << "{\"round\":" << cycle.round << ",\"initSuccess\":" << cycle.initSuccess
            << ",\"overlaySeen\":" << cycle.overlaySeen << ",\"ownerThreadId\":" << cycle.ownerThread
            << ",\"staExited\":" << cycle.staExited << ",\"overlayReleased\":" << cycle.overlayReleased
            << ",\"parentIntact\":" << cycle.parentIntact << ",\"before\":";
        WriteResources(cycle.before);
        std::cout << ",\"after\":";
        WriteResources(cycle.after);
        std::cout << ",\"shutdownSnapshots\":{\"afterInit\":" << cycle.afterInit
            << ",\"afterDestroy\":" << cycle.afterDestroy
            << ",\"afterRepeatedDestroy\":" << cycle.afterRepeatedDestroy << "}}";
    }
    std::cout << "],\"shutdownSnapshots\":{\"initial\":" << initialDiagnostic
        << ",\"afterInvalidInit\":" << invalidInitDiagnostic
        << ",\"afterRejectedGeometry\":" << rejectedGeometryDiagnostic
        << ",\"afterUncreatedDestroy\":" << uncreatedDestroyDiagnostic << "}}" << std::endl;
}

} // namespace

int main() {
    SetUnhandledExceptionFilter(CaptureOwnedCrash);
    bool completed = false;
    try {
        HelperCases();
        ProductCycles();
        completed = true;
    } catch (const AssertionFailure& error) {
        std::cerr << error.what() << std::endl;
    } catch (const winrt::hresult_error& error) {
        ++total;
        ++failed;
        std::cerr << "native HRESULT=" << error.code().value << std::endl;
    } catch (const std::exception& error) {
        ++total;
        ++failed;
        std::cerr << error.what() << std::endl;
    } catch (...) {
        ++total;
        ++failed;
        std::cerr << "unknown native test failure" << std::endl;
    }
    if (!completed) cleanupComplete = false;
    Report(completed);
    return completed && cleanupComplete && failed == 0 ? 0 : 1;
}
