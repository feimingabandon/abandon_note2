#include "window_motion_diagnostics.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <iomanip>
#include <locale>
#include <mutex>
#include <sstream>
#include <string>

namespace WindowMotionDiagnostics {
namespace {
constexpr std::size_t kSlowSamples = 6;
constexpr std::size_t kRecentSamples = 128;
constexpr int kMaximumLeaseMs = 30 * 60 * 1000;
std::atomic<ULONGLONG> leaseUntil{ 0 };
std::atomic<std::uint64_t> generation{ 0 }, sequence{ 0 };
std::atomic<std::uint64_t> droppedMoves{ 0 }, droppedGeometry{ 0 }, droppedSnapshots{ 0 }, associationContention{ 0 };
thread_local MoveSample* activeMove = nullptr;
thread_local std::uint64_t lastMoveSequence = 0;
thread_local std::uintptr_t lastMoveWindow = 0;

class LastErrorGuard {
public:
    LastErrorGuard() noexcept : m_saved(::GetLastError()) {}
    ~LastErrorGuard() { ::SetLastError(m_saved); }
private:
    DWORD m_saved;
};

double Milliseconds(Tick ticks) noexcept {
    LastErrorGuard preserveError;
    static const double frequency = [] {
        LARGE_INTEGER value{};
        QueryPerformanceFrequency(&value);
        return static_cast<double>(value.QuadPart);
    }();
    return frequency > 0 ? static_cast<double>(ticks) * 1000.0 / frequency : 0;
}

struct Metric {
    std::uint64_t count = 0, failures = 0;
    double totalMs = 0, maximumMs = 0;
    std::array<std::uint64_t, 8> buckets{};
    void Add(double duration, bool success = true) noexcept {
        if (duration < 0) return;
        ++count;
        if (!success) ++failures;
        totalMs += duration;
        maximumMs = std::max(maximumMs, duration);
        constexpr double bounds[]{ 1, 4, 8, 16, 33, 50, 100 };
        std::size_t bucket = 0;
        while (bucket < 7 && duration > bounds[bucket]) ++bucket;
        ++buckets[bucket];
    }
};

struct Batch {
    std::uint64_t firstGeneration = 0, lastGeneration = 0;
    std::uint64_t direct = 0, paired = 0, fallback = 0, fallbackFailures = 0;
    std::uint64_t barrierTransportFailures = 0, confirmedTimeouts = 0, serviceFailures = 0, staleBarrierErrors = 0;
    std::uint64_t serviceAvailableAtReturn = 0, serviceUnavailableAtReturn = 0;
    std::uint64_t lateServiceCount = 0;
    Metric move, endDefer, barrier, verify, directMove, fallbackMove;
    Metric geometry, setPosition, visual, snapshot;
    std::array<MoveSample, kSlowSamples> slow{};
    std::array<GeometrySample, kSlowSamples> lateServices{};
    std::size_t slowCount = 0;
    std::size_t lateServiceSamples = 0;
};
std::mutex collectorMutex;
Batch batch{};
std::array<GeometrySample, kRecentSamples> recentGeometry{};
std::array<MoveSample, kRecentSamples> recentMoves{};
std::size_t geometryCursor = 0, moveCursor = 0;

void AddGeneration(std::uint64_t value) noexcept {
    if (!batch.firstGeneration || value < batch.firstGeneration) batch.firstGeneration = value;
    batch.lastGeneration = std::max(batch.lastGeneration, value);
}

void RetainLateService(const GeometrySample& sample) noexcept {
    ++batch.lateServiceCount;
    if (batch.lateServiceSamples < kSlowSamples) batch.lateServices[batch.lateServiceSamples++] = sample;
}

void CommitMove(MoveSample sample) {
    if (!sample.enabled) return;
    sample.totalMs = Elapsed(sample.started, true);
    std::unique_lock<std::mutex> lock(collectorMutex, std::try_to_lock);
    if (!lock.owns_lock()) {
        droppedMoves.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    AddGeneration(sample.generation);
    batch.move.Add(sample.totalMs, sample.success);
    batch.endDefer.Add(sample.endDeferMs, sample.endDeferSucceeded);
    batch.barrier.Add(sample.barrierMs, sample.barrierTransportSucceeded && sample.barrierResult == 1);
    batch.verify.Add(sample.verifyMs, sample.rectsRead && sample.rectsMatch);
    batch.directMove.Add(sample.directMoveMs, sample.success);
    batch.fallbackMove.Add(sample.fallbackMoveMs, sample.fallbackSucceeded);
    if (sample.path[0] == 'p') ++batch.paired; else ++batch.direct;
    if (sample.fallbackAttempted) {
        ++batch.fallback;
        if (!sample.fallbackSucceeded) ++batch.fallbackFailures;
    }
    if (sample.barrierAttempted) {
        if (!sample.barrierTransportSucceeded) {
            ++batch.barrierTransportFailures;
            if (sample.barrierErrorMayBeStale) ++batch.staleBarrierErrors;
            if (sample.barrierError == ERROR_TIMEOUT && !sample.barrierErrorMayBeStale) ++batch.confirmedTimeouts;
        } else if (sample.barrierResult != 1) ++batch.serviceFailures;
        if (sample.serviceAvailableAtReturn) ++batch.serviceAvailableAtReturn;
        else ++batch.serviceUnavailableAtReturn;
    }
    recentMoves[moveCursor++ % kRecentSamples] = sample;
    if (batch.slowCount < kSlowSamples) batch.slow[batch.slowCount++] = sample;
    else {
        auto least = std::min_element(batch.slow.begin(), batch.slow.end(),
            [](const MoveSample& a, const MoveSample& b) { return a.totalMs < b.totalMs; });
        if (sample.totalMs > least->totalMs) *least = sample;
    }
}

void CommitGeometry(GeometrySample sample) {
    if (!sample.enabled) return;
    sample.finished = Clock(true);
    sample.totalMs = Milliseconds(sample.finished - sample.started);
    std::unique_lock<std::mutex> lock(collectorMutex, std::try_to_lock);
    if (!lock.owns_lock()) {
        droppedGeometry.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    AddGeneration(sample.generation);
    batch.geometry.Add(sample.totalMs, sample.success);
    batch.setPosition.Add(sample.setPositionMs, sample.setPositionSucceeded);
    batch.visual.Add(sample.visualMs, sample.visualSucceeded);
    if (!sample.sequence) return;
    recentGeometry[geometryCursor++ % kRecentSamples] = sample;
    // A timed-out sender may have returned before STA finished. Keep that fact
    // explicit; never reinterpret a later service as available at move return.
    bool late = false;
    const auto attach = [&](MoveSample& move) {
        if (move.sequence == sample.sequence && move.generation == sample.generation &&
            !move.serviceAvailableAtReturn) {
            move.service = sample;
            move.serviceArrivedAfterReturn = true;
            late = true;
        }
    };
    for (auto& move : recentMoves) attach(move);
    for (std::size_t i = 0; i < batch.slowCount; ++i) attach(batch.slow[i]);
    if (late) RetainLateService(sample);
}

void WriteMetric(std::ostream& out, const char* name, const Metric& metric, bool comma) {
    if (comma) out << ',';
    out << '"' << name << "\":{\"count\":" << metric.count
        << ",\"failures\":" << metric.failures << ",\"totalMs\":" << metric.totalMs
        << ",\"maxMs\":" << metric.maximumMs << ",\"buckets\":[";
    for (std::size_t i = 0; i < metric.buckets.size(); ++i) {
        if (i) out << ',';
        out << metric.buckets[i];
    }
    out << "]}";
}

void WriteOptional(std::ostream& out, double value) {
    if (value >= 0) out << value; else out << "null";
}
void WriteRect(std::ostream& out, const RECT& rect) {
    out << '[' << rect.left << ',' << rect.top << ',' << rect.right << ',' << rect.bottom << ']';
}
void WriteMove(std::ostream& out, const MoveSample& move) {
    out << "{\"sequence\":" << move.sequence << ",\"generation\":" << move.generation
        << ",\"path\":\"" << move.path << "\",\"success\":" << (move.success ? "true" : "false")
        << ",\"failureStage\":\"" << move.failureStage << "\",\"target\":[" << move.targetX << ',' << move.targetY
        << "],\"totalMs\":" << move.totalMs << ",\"endDeferMs\":";
    WriteOptional(out, move.endDeferMs);
    out << ",\"barrierMs\":"; WriteOptional(out, move.barrierMs);
    out << ",\"verifyMs\":"; WriteOptional(out, move.verifyMs);
    out << ",\"directMoveMs\":"; WriteOptional(out, move.directMoveMs);
    out << ",\"snapshotMs\":"; WriteOptional(out, move.snapshotMs);
    out << ",\"snapshotEvidence\":{\"rectRead\":" << (move.snapshotRectRead ? "true" : "false")
        << ",\"targetMatches\":" << (move.snapshotTargetMatches ? "true" : "false");
    if (move.snapshotRectRead) { out << ",\"rect\":"; WriteRect(out, move.snapshotRect); }
    out << '}';
    out << ",\"fallback\":{\"attempted\":" << (move.fallbackAttempted ? "true" : "false")
        << ",\"succeeded\":" << (move.fallbackSucceeded ? "true" : "false") << ",\"moveMs\":";
    WriteOptional(out, move.fallbackMoveMs);
    out << "},\"barrier\":{\"attempted\":" << (move.barrierAttempted ? "true" : "false")
        << ",\"transportSucceeded\":" << (move.barrierTransportSucceeded ? "true" : "false")
        << ",\"result\":" << move.barrierResult << ",\"lastError\":" << move.barrierError
        << ",\"priorLastError\":" << move.barrierPriorError
        << ",\"errorMayBeStale\":" << (move.barrierErrorMayBeStale ? "true" : "false")
        << ",\"timeoutLimitMs\":" << move.barrierTimeoutMs
        << ",\"confirmedTimeout\":" << (move.barrierAttempted && !move.barrierTransportSucceeded && move.barrierError == ERROR_TIMEOUT && !move.barrierErrorMayBeStale ? "true" : "false")
        << "},\"service\":{\"availableAtReturn\":" << (move.serviceAvailableAtReturn ? "true" : "false")
        << ",\"arrivedAfterReturn\":" << (move.serviceArrivedAfterReturn ? "true" : "false");
    if (move.serviceAvailableAtReturn || move.serviceArrivedAfterReturn) {
        out << ",\"success\":" << (move.service.success ? "true" : "false")
            << ",\"failureStage\":\"" << move.service.failureStage << "\",\"totalMs\":" << move.service.totalMs
            << ",\"setPositionMs\":"; WriteOptional(out, move.service.setPositionMs);
        out << ",\"visualMs\":"; WriteOptional(out, move.service.visualMs);
    }
    out << ",\"nonServiceWaitMs\":";
    // Subtraction is meaningful only when the matching service is entirely
    // contained in a successful barrier. This residual is not pure queue time.
    if (move.barrierTransportSucceeded && move.serviceAvailableAtReturn &&
        move.service.started >= move.barrierStarted && move.service.finished <= move.barrierFinished &&
        move.barrierMs >= move.service.totalMs) out << move.barrierMs - move.service.totalMs;
    else out << "null";
    out << "},\"hwndEvidence\":{\"rectsRead\":" << (move.rectsRead ? "true" : "false")
        << ",\"rectsMatch\":" << (move.rectsMatch ? "true" : "false")
        << ",\"targetMatches\":" << (move.targetMatches ? "true" : "false");
    if (move.rectsRead) {
        out << ",\"parent\":"; WriteRect(out, move.parentAfter);
        out << ",\"overlay\":"; WriteRect(out, move.overlayAfter);
    }
    out << "}}";
}
} // namespace

bool IsEnabled() noexcept {
    auto deadline = leaseUntil.load(std::memory_order_relaxed);
    if (!deadline) return false;
    LastErrorGuard preserveError;
    if (GetTickCount64() < deadline) return true;
    leaseUntil.compare_exchange_strong(deadline, 0, std::memory_order_relaxed);
    return false;
}
void SetLease(int remainingMs) noexcept {
    LastErrorGuard preserveError;
    if (remainingMs <= 0) {
        leaseUntil.store(0, std::memory_order_relaxed);
        return; // Disable collection without discarding its undrained tail.
    }
    if (!IsEnabled()) generation.fetch_add(1, std::memory_order_relaxed);
    const auto bounded = std::min(remainingMs, kMaximumLeaseMs);
    leaseUntil.store(GetTickCount64() + static_cast<ULONGLONG>(bounded), std::memory_order_relaxed);
}
Tick Clock(bool enabled) noexcept {
    if (!enabled) return 0;
    LastErrorGuard preserveError;
    LARGE_INTEGER tick{};
    QueryPerformanceCounter(&tick);
    return tick.QuadPart;
}
double Elapsed(Tick started, bool enabled) noexcept {
    if (!enabled || !started) return -1;
    LastErrorGuard preserveError;
    return Milliseconds(Clock(true) - started);
}
MoveSample* CurrentMove() noexcept { return activeMove; }
void MatchBarrierService(MoveSample& sample) noexcept {
    if (!sample.enabled || !sample.barrierAttempted) return;
    LastErrorGuard preserveError;
    try {
        std::unique_lock<std::mutex> lock(collectorMutex, std::try_to_lock);
        if (!lock.owns_lock()) {
            associationContention.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        for (const auto& service : recentGeometry) {
            if (service.enabled && service.sequence == sample.sequence && service.generation == sample.generation) {
                sample.service = service;
                if (sample.barrierFinished > 0 && service.finished > 0) {
                    sample.serviceAvailableAtReturn = service.finished <= sample.barrierFinished;
                    if (!sample.serviceAvailableAtReturn && !sample.serviceArrivedAfterReturn) {
                        sample.serviceArrivedAfterReturn = true;
                        RetainLateService(service);
                    }
                }
                return;
            }
        }
    } catch (...) {
        associationContention.fetch_add(1, std::memory_order_relaxed);
    }
}
MoveScope::MoveScope(HWND window, int x, int y) noexcept {
    LastErrorGuard preserveError;
    m_previous = activeMove;
    m_sample.enabled = IsEnabled();
    if (m_sample.enabled) {
        m_sample.generation = generation.load(std::memory_order_relaxed);
        m_sample.sequence = sequence.fetch_add(1, std::memory_order_relaxed) + 1;
        m_sample.window = reinterpret_cast<std::uintptr_t>(window);
        m_sample.targetX = x; m_sample.targetY = y;
        m_sample.started = Clock(true);
    }
    activeMove = &m_sample;
}
MoveScope::~MoveScope() {
    LastErrorGuard preserveError;
    try {
        if (m_sample.enabled) CommitMove(m_sample);
    } catch (...) {
        droppedMoves.fetch_add(1, std::memory_order_relaxed);
    }
    lastMoveSequence = m_sample.enabled ? m_sample.sequence : 0;
    lastMoveWindow = m_sample.enabled ? m_sample.window : 0;
    activeMove = m_previous;
}
GeometryScope::GeometryScope(std::uint64_t value) noexcept {
    LastErrorGuard preserveError;
    m_sample.enabled = IsEnabled();
    if (!m_sample.enabled) return;
    m_sample.sequence = value;
    m_sample.generation = generation.load(std::memory_order_relaxed);
    m_sample.started = Clock(true);
}
GeometryScope::~GeometryScope() {
    LastErrorGuard preserveError;
    try {
        if (m_sample.enabled) CommitGeometry(m_sample);
    } catch (...) {
        droppedGeometry.fetch_add(1, std::memory_order_relaxed);
    }
}
SnapshotScope::SnapshotScope(HWND window) noexcept {
    LastErrorGuard preserveError;
    m_enabled = IsEnabled();
    if (!m_enabled) return;
    m_started = Clock(true);
    m_generation = generation.load(std::memory_order_relaxed);
    m_window = reinterpret_cast<std::uintptr_t>(window);
    m_sequence = m_window == lastMoveWindow ? lastMoveSequence : 0;
}
SnapshotScope::~SnapshotScope() {
    if (!m_enabled) return;
    LastErrorGuard preserveError;
    try {
        const auto duration = Elapsed(m_started, true);
        std::unique_lock<std::mutex> lock(collectorMutex, std::try_to_lock);
        if (!lock.owns_lock()) {
            droppedSnapshots.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        AddGeneration(m_generation);
        batch.snapshot.Add(duration, m_success);
        if (!m_sequence) return;
        const auto attach = [&](MoveSample& move) {
            if (move.sequence == m_sequence && move.window == m_window &&
                move.generation == m_generation && move.snapshotMs < 0) {
                move.snapshotMs = duration;
                move.snapshotRectRead = m_rectRead;
                move.snapshotRect = m_rect;
                move.snapshotTargetMatches = m_rectRead && m_rect.left == move.targetX && m_rect.top == move.targetY;
            }
        };
        for (auto& move : recentMoves) attach(move);
        for (std::size_t i = 0; i < batch.slowCount; ++i) attach(batch.slow[i]);
    } catch (...) {
        droppedSnapshots.fetch_add(1, std::memory_order_relaxed);
    }
}
const char* DrainJson() {
    LastErrorGuard preserveError;
    thread_local std::string json;
    Batch drained{};
    std::uint64_t moveDrops = 0, geometryDrops = 0, snapshotDrops = 0, associationMisses = 0;
    {
        std::lock_guard<std::mutex> lock(collectorMutex);
        drained = batch;
        batch = {};
        moveDrops = droppedMoves.exchange(0, std::memory_order_relaxed);
        geometryDrops = droppedGeometry.exchange(0, std::memory_order_relaxed);
        snapshotDrops = droppedSnapshots.exchange(0, std::memory_order_relaxed);
        associationMisses = associationContention.exchange(0, std::memory_order_relaxed);
    }
    std::sort(drained.slow.begin(), drained.slow.begin() + drained.slowCount,
        [](const MoveSample& a, const MoveSample& b) { return a.totalMs > b.totalMs; });
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::fixed << std::setprecision(3);
    out << "{\"schemaVersion\":1,\"enabled\":" << (IsEnabled() ? "true" : "false")
        << ",\"observations\":" << drained.move.count + drained.geometry.count + drained.snapshot.count +
            moveDrops + geometryDrops + snapshotDrops + associationMisses
        << ",\"generationFirst\":" << drained.firstGeneration << ",\"generationLast\":" << drained.lastGeneration
        << ",\"sampleSelection\":\"slowest-6-moves\",\"serviceAssociationCapacity\":128"
        << ",\"evidence\":\"hwnd-api-state-not-dwm-presentation\",\"bucketUpperBoundsMs\":[1,4,8,16,33,50,100,null]"
        << ",\"coverage\":{\"droppedMoves\":" << moveDrops << ",\"droppedGeometry\":" << geometryDrops
        << ",\"droppedSnapshots\":" << snapshotDrops << ",\"associationContention\":" << associationMisses
        << ",\"lateServices\":" << drained.lateServiceCount
        << ",\"serviceScope\":\"SyncGeometryFromParent\",\"nonServiceWaitMeaning\":\"barrier-minus-contained-service-not-pure-queue\"}"
        << ",\"paths\":{\"direct\":" << drained.direct << ",\"paired\":" << drained.paired
        << ",\"fallback\":" << drained.fallback << ",\"fallbackFailures\":" << drained.fallbackFailures
        << "},\"barrierResults\":{\"transportFailures\":" << drained.barrierTransportFailures
        << ",\"confirmedTimeouts\":" << drained.confirmedTimeouts << ",\"serviceFailures\":" << drained.serviceFailures
        << ",\"errorMayBeStale\":" << drained.staleBarrierErrors
        << ",\"serviceAvailableAtReturn\":" << drained.serviceAvailableAtReturn
        << ",\"serviceUnavailableAtReturn\":" << drained.serviceUnavailableAtReturn << "},\"stages\":{";
    WriteMetric(out, "move", drained.move, false);
    WriteMetric(out, "endDefer", drained.endDefer, true);
    WriteMetric(out, "barrier", drained.barrier, true);
    WriteMetric(out, "verify", drained.verify, true);
    WriteMetric(out, "directMove", drained.directMove, true);
    WriteMetric(out, "fallbackMove", drained.fallbackMove, true);
    WriteMetric(out, "staGeometry", drained.geometry, true);
    WriteMetric(out, "staSetPosition", drained.setPosition, true);
    WriteMetric(out, "staVisual", drained.visual, true);
    WriteMetric(out, "snapshot", drained.snapshot, true);
    out << "},\"slowSamples\":[";
    for (std::size_t i = 0; i < drained.slowCount; ++i) {
        if (i) out << ',';
        WriteMove(out, drained.slow[i]);
    }
    out << "],\"lateServiceSamples\":[";
    for (std::size_t i = 0; i < drained.lateServiceSamples; ++i) {
        if (i) out << ',';
        const auto& sample = drained.lateServices[i];
        out << "{\"sequence\":" << sample.sequence << ",\"generation\":" << sample.generation
            << ",\"success\":" << (sample.success ? "true" : "false")
            << ",\"totalMs\":" << sample.totalMs << ",\"failureStage\":\"" << sample.failureStage << "\"}";
    }
    out << "]}";
    json = out.str();
    // Every collection is already fixed-size; keep a hard C API bound too.
    if (json.size() > 48 * 1024) {
        json = "{\"schemaVersion\":1,\"observations\":1,\"coverage\":{\"serializationLimitReached\":true}}";
    }
    return json.c_str();
}
} // namespace WindowMotionDiagnostics
