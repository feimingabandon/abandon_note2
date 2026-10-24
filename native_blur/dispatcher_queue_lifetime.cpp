#include "dispatcher_queue_lifetime.h"

namespace BlurEngine::Detail {
namespace {

constexpr DWORD kShutdownPollMs = 25;
constexpr unsigned kMessagesPerBatch = 64;

void PumpShutdownMessages(bool failed, QueueShutdownFailure onFailure, void* context) noexcept {
    // Completion is also checked after a finite idle wait: an async action need
    // not post a Win32 message when its status changes. A terminal failure has
    // no completion to poll, but its apartment must remain alive and pumping.
    const DWORD result = MsgWaitForMultipleObjectsEx(
        0, nullptr, failed ? INFINITE : kShutdownPollMs,
        QS_ALLINPUT, MWMO_INPUTAVAILABLE | MWMO_ALERTABLE);
    if (result == WAIT_FAILED) {
        const DWORD error = GetLastError();
        if (onFailure) onFailure(context, "dispatcher-queue-pump-failed",
            error ? HRESULT_FROM_WIN32(error) : E_FAIL);
        // A failed wait must not turn retained cleanup into a hot loop.
        SleepEx(kShutdownPollMs, TRUE);
    }

    MSG message{};
    for (unsigned count = 0; count < kMessagesPerBatch &&
         PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++count) {
        // WM_QUIT ends the product loop, not DispatcherQueue shutdown. Consume
        // it once; reposting it would starve shutdown work or spin indefinitely.
        if (message.message == WM_QUIT) continue;
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}

} // namespace

bool TryFinishDispatcherQueueShutdown(
    winrt::Windows::System::DispatcherQueueController& controller,
    winrt::Windows::Foundation::IAsyncAction& shutdown,
    HRESULT& failure) noexcept {
    if (!controller && !shutdown) return true;
    if (!controller || !shutdown) {
        failure = E_UNEXPECTED;
        return false;
    }
    try {
        const auto status = shutdown.Status();
        if (status == winrt::Windows::Foundation::AsyncStatus::Started) return false;
        if (status != winrt::Windows::Foundation::AsyncStatus::Completed) {
            failure = shutdown.ErrorCode();
            if (SUCCEEDED(failure)) failure = status ==
                winrt::Windows::Foundation::AsyncStatus::Canceled ? E_ABORT : E_FAIL;
            return false;
        }
        shutdown.GetResults();
        shutdown = nullptr;
        controller = nullptr;
        return true;
    } catch (...) {
        failure = winrt::to_hresult();
        return false;
    }
}

void DrainDispatcherQueueShutdown(
    winrt::Windows::System::DispatcherQueueController& controller,
    winrt::Windows::Foundation::IAsyncAction& shutdown,
    QueueShutdownFailure onFailure,
    void* context) noexcept {
    HRESULT failure = S_OK;
    bool failed = false;
    for (;;) {
        if (!failed) {
            if (TryFinishDispatcherQueueShutdown(controller, shutdown, failure)) return;
            if (FAILED(failure)) {
                failed = true;
                if (onFailure) onFailure(context, "dispatcher-queue-shutdown-failed", failure);
            }
        }
        // Never unwind this owner while shutdown is unconfirmed. StopStaThread
        // already pins the DLL and detaches after its unchanged 2s/5s wait.
        PumpShutdownMessages(failed, onFailure, context);
    }
}

void ShutdownDispatcherQueueOnCurrentThread(
    winrt::Windows::System::DispatcherQueueController& controller,
    QueueShutdownFailure onFailure,
    void* context) noexcept {
    if (!controller) return;
    winrt::Windows::Foundation::IAsyncAction shutdown{ nullptr };
    try {
        shutdown = controller.ShutdownQueueAsync();
    } catch (...) {
        if (onFailure) onFailure(context, "dispatcher-queue-shutdown-start-failed", winrt::to_hresult());
        // A synchronous failure does not prove that this queue is closed. Keep
        // the creating STA and controller, using the existing caller timeout.
        for (;;) PumpShutdownMessages(true, onFailure, context);
    }
    DrainDispatcherQueueShutdown(controller, shutdown, onFailure, context);
}

} // namespace BlurEngine::Detail
