#include "window_motion_diagnostics.h"

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

namespace Diagnostic = WindowMotionDiagnostics;
namespace {
constexpr DWORD kErrorSentinel = 0x1234abcd;
int assertions = 0, passed = 0, failed = 0;

void Require(bool condition, const char* message) {
    ++assertions;
    if (!condition) {
        ++failed;
        throw std::runtime_error(message);
    }
    ++passed;
}
void RequireLastError(const char* message) {
    const auto actual = ::GetLastError();
    Require(actual == kErrorSentinel, message);
}
std::uint64_t Number(const std::string& json, const char* key) {
    const auto token = std::string("\"") + key + "\":";
    const auto at = json.find(token);
    Require(at != std::string::npos, "expected JSON numerical key");
    return std::strtoull(json.c_str() + at + token.size(), nullptr, 10);
}
std::string Drain() {
    ::SetLastError(kErrorSentinel);
    const char* raw = Diagnostic::DrainJson();
    RequireLastError("drain changed LastError");
    Require(raw != nullptr, "drain must return JSON");
    return raw;
}
void Reset() {
    Diagnostic::SetLease(0);
    Diagnostic::DrainJson();
}
void TestDailyAndLastError() {
    Reset();
    ::SetLastError(kErrorSentinel);
    Diagnostic::SetLease(0);
    RequireLastError("closing lease changed LastError");
    Require(!Diagnostic::IsEnabled(), "daily lease must be disabled");
    RequireLastError("daily enabled check changed LastError");
    Require(Diagnostic::Clock(false) == 0, "disabled clock must not measure");
    RequireLastError("disabled clock changed LastError");
    Require(Diagnostic::Elapsed(1, false) < 0, "disabled elapsed must be unknown");
    RequireLastError("disabled elapsed changed LastError");
    {
        Diagnostic::MoveScope move(nullptr, 1, 2);
        RequireLastError("daily move constructor changed LastError");
        Require(!move.Sample().enabled, "daily move must not collect");
        Diagnostic::GeometryScope geometry(move.Sample().sequence);
        RequireLastError("daily geometry constructor changed LastError");
        Require(!geometry.Sample().enabled, "daily geometry must not collect");
        Diagnostic::SnapshotScope snapshot(nullptr);
        RequireLastError("daily snapshot constructor changed LastError");
        snapshot.SetResult(true);
    }
    RequireLastError("daily destructors changed LastError");
    Require(Number(Drain(), "observations") == 0, "daily scopes produced observations");

    ::SetLastError(kErrorSentinel);
    Diagnostic::SetLease(5000);
    RequireLastError("opening lease changed LastError");
    Require(Diagnostic::IsEnabled(), "deep lease must be enabled");
    RequireLastError("deep enabled check changed LastError");
    const auto tick = Diagnostic::Clock(true);
    RequireLastError("deep clock changed LastError");
    Require(tick > 0, "deep clock must return QPC");
    Require(Diagnostic::Elapsed(tick, true) >= 0, "deep elapsed must be measured");
    RequireLastError("deep elapsed changed LastError");
    {
        Diagnostic::MoveScope move(nullptr, 1, 2);
        RequireLastError("deep move constructor changed LastError");
        move.Sample().success = true;
        {
            Diagnostic::GeometryScope geometry;
            RequireLastError("deep geometry constructor changed LastError");
            geometry.Sample().success = true;
        }
        RequireLastError("deep geometry destructor changed LastError");
    }
    RequireLastError("deep move destructor changed LastError");
    {
        Diagnostic::SnapshotScope snapshot(nullptr);
        RequireLastError("deep snapshot constructor changed LastError");
        snapshot.SetResult(true);
    }
    RequireLastError("deep snapshot destructor changed LastError");
    Require(Number(Drain(), "observations") == 3, "deep scopes missing observations");
}

void TestServiceAtReturn(bool late) {
    Reset();
    Diagnostic::SetLease(5000);
    ::SetLastError(kErrorSentinel);
    {
        Diagnostic::MoveScope move(nullptr, 10, 20);
        auto& sample = move.Sample();
        sample.path = "paired";
        sample.success = true;
        sample.barrierAttempted = true;
        sample.barrierTransportSucceeded = true;
        sample.barrierResult = 1;
        sample.barrierStarted = sample.started;
        {
            Diagnostic::GeometryScope service(sample.sequence);
            service.Sample().success = true;
        }
        // Synthetic boundary: use the recorded service completion itself so
        // this classification does not depend on QPC advancing between calls.
        if (late) {
            Diagnostic::MatchBarrierService(sample);
            RequireLastError("unknown-boundary association changed LastError");
            Require(sample.service.finished > 0, "service completion must be recorded");
            sample.barrierFinished = sample.service.finished - 1;
        } else sample.barrierFinished = Diagnostic::Clock(true);
        sample.barrierMs = Diagnostic::Elapsed(sample.barrierStarted, true);
        Diagnostic::MatchBarrierService(sample);
        RequireLastError("service association changed LastError");
        Require(sample.service.sequence == sample.sequence, "service sequence mismatch");
        Require(sample.service.generation == sample.generation, "service generation mismatch");
        Require(sample.serviceAvailableAtReturn == !late, "incorrect service availability at return");
        Require(sample.serviceArrivedAfterReturn == late, "incorrect late-service classification");
        if (late) {
            Require(sample.service.finished > sample.barrierFinished, "late fixture must finish after return boundary");
            Diagnostic::MatchBarrierService(sample);
            RequireLastError("repeated service association changed LastError");
        }
    }
    RequireLastError("service fixture destructors changed LastError");
    Diagnostic::SetLease(0);
    RequireLastError("closing lease after service changed LastError");
    const auto json = Drain();
    Require(Number(json, "observations") == 2, "closing lease discarded undrained tail");
    Require(Number(json, "serviceAvailableAtReturn") == (late ? 0 : 1), "aggregate availability mismatch");
    Require(Number(json, "serviceUnavailableAtReturn") == (late ? 1 : 0), "aggregate missing-service mismatch");
    Require(Number(json, "lateServices") == (late ? 1 : 0), "late association missing or double counted");
    if (late) Require(json.find("\"nonServiceWaitMs\":null") != std::string::npos, "late service must not be subtracted");
    Require(Number(Drain(), "observations") == 0, "drain must clear the completed batch");
}

void TestLeaseExpiryAndRenewal() {
    Reset();
    Diagnostic::SetLease(1);
    Sleep(10);
    ::SetLastError(kErrorSentinel);
    Require(!Diagnostic::IsEnabled(), "lease must expire independently of main process");
    RequireLastError("lease expiry changed LastError");
    {
        Diagnostic::MoveScope move(nullptr, 0, 0);
        Require(!move.Sample().enabled, "expired lease must not start a move observation");
        move.Sample().success = true;
    }
    Require(Number(Drain(), "observations") == 0, "expired move produced an observation");

    Diagnostic::SetLease(5000);
    {
        Diagnostic::MoveScope move(nullptr, 0, 0);
        move.Sample().success = true;
    }
    Diagnostic::SetLease(10000);
    {
        Diagnostic::MoveScope move(nullptr, 0, 0);
        move.Sample().success = true;
    }
    const auto json = Drain();
    Require(Number(json, "observations") == 2, "renewal discarded current capture observations");
    Require(Number(json, "generationFirst") == Number(json, "generationLast"), "renewal changed capture generation");
}

void TestBoundedDrain() {
    Reset();
    Diagnostic::SetLease(10000);
    for (int i = 0; i < 800; ++i) {
        Diagnostic::MoveScope move(nullptr, i, i);
        move.Sample().success = true;
    }
    const auto json = Drain();
    Require(json.size() <= 48 * 1024, "native drain exceeded JSON budget");
    Require(Number(json, "observations") == 800, "bounded samples lost aggregate counts");
    Require(Number(json, "direct") == 800, "direct-path counts mismatch");
    const auto start = json.find("\"slowSamples\":[");
    const auto end = json.find("],\"lateServiceSamples\":[", start);
    Require(start != std::string::npos && end != std::string::npos, "slow sample array missing");
    std::size_t samples = 0, cursor = start;
    while ((cursor = json.find("\"sequence\":", cursor)) != std::string::npos && cursor < end) {
        ++samples;
        ++cursor;
    }
    Require(samples == 6, "native slow samples must stay bounded to six");
    Require(Number(Drain(), "observations") == 0, "bounded drain must clear its batch");
}
} // namespace

void PrintResult() {
    std::cout << "{\"completed\":true,\"assertions\":{\"total\":" << assertions
        << ",\"passed\":" << passed << ",\"failed\":" << failed << ",\"skipped\":0}}\n";
}

int main() {
    try {
        TestDailyAndLastError();
        TestServiceAtReturn(false);
        TestServiceAtReturn(true);
        TestLeaseExpiryAndRenewal();
        TestBoundedDrain();
        Diagnostic::SetLease(0);
        PrintResult();
        return 0;
    } catch (const std::exception& error) {
        if (!failed) { ++assertions; ++failed; }
        std::cerr << "window_motion_diagnostics_test failed: " << error.what() << '\n';
        PrintResult();
        return 1;
    }
}
