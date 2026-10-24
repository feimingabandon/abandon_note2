#pragma once

#include <Windows.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.System.h>

namespace BlurEngine::Detail {

using QueueShutdownFailure = void (*)(void* context, const char* stage, HRESULT error) noexcept;

// Returns true only when no queue exists, or its shutdown action completed
// successfully. Pending/failed actions retain both references on their owner STA.
bool TryFinishDispatcherQueueShutdown(
    winrt::Windows::System::DispatcherQueueController& controller,
    winrt::Windows::Foundation::IAsyncAction& shutdown,
    HRESULT& failure) noexcept;

// These functions run on the queue's creating STA. They return only after a
// confirmed shutdown. The caller's existing thread wait bounds public teardown;
// an unconfirmed shutdown keeps this STA, its COM apartment and references alive.
void DrainDispatcherQueueShutdown(
    winrt::Windows::System::DispatcherQueueController& controller,
    winrt::Windows::Foundation::IAsyncAction& shutdown,
    QueueShutdownFailure onFailure = nullptr,
    void* context = nullptr) noexcept;

void ShutdownDispatcherQueueOnCurrentThread(
    winrt::Windows::System::DispatcherQueueController& controller,
    QueueShutdownFailure onFailure = nullptr,
    void* context = nullptr) noexcept;

} // namespace BlurEngine::Detail
