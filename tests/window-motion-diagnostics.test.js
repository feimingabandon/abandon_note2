import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWindowMotionMetrics,
  estimateMotionDelivery
} from '../src/shared/window-motion-metrics.js'
import { sanitizeDiagnosticValue } from '../src/shared/diagnostic-sanitize.js'
import { encodeLogRecord } from '../src/main/logging/log-store.mjs'

vi.mock('../src/main/logging/logger.js', () => ({ writeLog: vi.fn() }))
import {
  createWindowMotionRecorder,
  createNativeMotionDiagnostics,
  flushWindowMotionDiagnostics
} from '../src/main/logging/window-motion-diagnostics.js'

function fixture(mode = 'daily') {
  let time = 1000
  let policy = { mode, captureId: 'capture-a', policyEpoch: 1, expiresAt: 1000000 }
  const listeners = new Set()
  const state = {
    get: () => policy,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
  const emit = vi.fn()
  return {
    state,
    emit,
    now: () => time,
    advance: (amount) => {
      time += amount
    },
    change: (next) => {
      policy = { ...policy, ...next }
      for (const fn of listeners) fn(policy)
    },
    listenerCount: () => listeners.size
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('window movement evidence', () => {
  it('drains an ongoing operation for export with its cutoff identity and releases it on finish', () => {
    vi.useFakeTimers()
    const f = fixture('deep')
    const recorder = createWindowMotionRecorder({
      scope: 'performance.window-drag-main',
      state: f.state,
      emit: f.emit,
      now: f.now,
      wallNow: f.now
    })
    recorder.add('move', 17)
    flushWindowMotionDiagnostics('export', 'export-request-a')
    expect(f.emit).toHaveBeenCalledOnce()
    expect(f.emit.mock.calls[0][0]).toMatchObject({
      exportRequestId: 'export-request-a',
      metadata: { reason: 'export', stages: { move: { count: 1 } } }
    })
    recorder.add('move', 20)
    recorder.finish()
    flushWindowMotionDiagnostics('export', 'export-request-b')
    expect(f.emit).toHaveBeenCalledTimes(2)
    expect(f.listenerCount()).toBe(0)
  })
  it('tags a native tail generated after the export cutoff with the export request identity', () => {
    vi.useFakeTimers()
    const f = fixture('deep')
    const native = createNativeMotionDiagnostics({
      state: f.state,
      now: f.now,
      emit: f.emit,
      setLease: vi.fn(),
      drain: () => JSON.stringify({ observations: 2 })
    })
    native.flush('export', 'export-native-a')
    expect(f.emit.mock.calls[0][0]).toMatchObject({
      exportRequestId: 'export-native-a',
      metadata: { reason: 'export', observations: 2 }
    })
    native.dispose()
  })
  it('bounds stage cardinality and slow samples without retaining private values', () => {
    const metrics = createWindowMotionMetrics({ maxStages: 2, maxSamples: 3 })
    for (let seq = 1; seq <= 1000; seq++) {
      metrics.add('move', seq / 10)
      metrics.count('updates')
      metrics.sample(seq / 10, { seq, content: 'private', invalid: NaN })
    }
    metrics.add('snapshot', 12)
    metrics.add('third-stage', 3)
    const result = metrics.drain()
    expect(result.stages.move).toMatchObject({ count: 1000, maxMs: 100 })
    expect(result.stages.move.bins.reduce((a, b) => a + b)).toBe(1000)
    expect(result.slowSamples.map((sample) => sample.seq)).toEqual([1000, 999, 998])
    expect(result.omitted).toBe(1)
    expect(JSON.stringify(result)).not.toMatch(/content|private|invalid/)
    expect(metrics.drain().stages).toEqual({})
  })
  it('uses calibrated one-way bounds and reports missing or invalid clocks explicitly', () => {
    expect(
      estimateMotionDelivery({ sentAt: 1000, clockOffsetLowMs: 20, clockOffsetHighMs: 30 }, 1100)
    ).toEqual({ status: 'estimated', lowerMs: 70, upperMs: 80, uncertaintyMs: 10 })
    expect(
      estimateMotionDelivery(
        { sentAt: 1000, clockOffsetLowMs: null, clockOffsetHighMs: null },
        1100
      ).status
    ).toBe('clock-unavailable')
    expect(
      estimateMotionDelivery({ sentAt: 2000, clockOffsetLowMs: 20, clockOffsetHighMs: 30 }, 1100)
        .status
    ).toBe('clock-invalid')
  })
  it('daily mode has no motion clock probe, timer, native lease or log drain', () => {
    vi.useFakeTimers()
    const f = fixture()
    const clock = vi.fn(f.now)
    const recorder = createWindowMotionRecorder({
      scope: 'performance.motion',
      state: f.state,
      now: clock,
      emit: f.emit,
      wallNow: f.now
    })
    expect(recorder.stamp()).toBe(null)
    recorder.add('move', 100)
    recorder.finish()
    expect(clock).not.toHaveBeenCalled()
    expect(f.emit).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    const setLease = vi.fn(),
      drain = vi.fn()
    const native = createNativeMotionDiagnostics({
      setLease,
      drain,
      state: f.state,
      now: f.now,
      emit: f.emit
    })
    expect(setLease).toHaveBeenCalledWith(0)
    native.flush()
    expect(drain).not.toHaveBeenCalled()
    native.dispose()
    expect(f.listenerCount()).toBe(0)
  })
  it('batches deep observations and preserves final capture identity on stop and expiry', () => {
    vi.useFakeTimers()
    const f = fixture('deep')
    const recorder = createWindowMotionRecorder({
      scope: 'performance.motion',
      state: f.state,
      now: f.now,
      emit: f.emit,
      wallNow: f.now
    })
    for (let seq = 0; seq < 1000; seq++) recorder.add('move', 20)
    expect(f.emit).not.toHaveBeenCalled()
    f.change({ mode: 'daily' })
    expect(f.emit).toHaveBeenCalledOnce()
    expect(f.emit.mock.calls[0][0]).toMatchObject({
      kind: 'metric',
      collectionPolicy: { mode: 'deep', captureId: 'capture-a' },
      metadata: { reason: 'mode-stop', stages: { move: { count: 1000 } } }
    })
    expect(vi.getTimerCount()).toBe(0)
    f.change({ mode: 'deep', captureId: 'capture-b', expiresAt: 1005 })
    recorder.add('move', 30)
    f.advance(10)
    expect(recorder.stamp()).toBe(null)
    expect(f.emit.mock.calls[1][0].metadata.captureId).toBe('capture-b')
    recorder.finish()
    expect(f.listenerCount()).toBe(0)
  })
  it('native batches are source gated, retain the tail, and cannot replace business errors', () => {
    vi.useFakeTimers()
    const f = fixture('deep')
    const setLease = vi.fn()
    const drain = vi.fn(() =>
      JSON.stringify({
        schemaVersion: 1,
        observations: 4,
        stages: { barrier: { count: 2, maxMs: 80 } }
      })
    )
    const native = createNativeMotionDiagnostics({
      setLease,
      drain,
      state: f.state,
      now: f.now,
      emit: f.emit
    })
    expect(setLease).toHaveBeenCalledWith(999000)
    expect(drain).not.toHaveBeenCalled()
    f.change({ mode: 'daily' })
    expect(setLease).toHaveBeenLastCalledWith(0)
    expect(f.emit.mock.calls[0][0]).toMatchObject({
      scope: 'performance.window-motion-native',
      collectionPolicy: { mode: 'deep' },
      metadata: { observations: 4, reason: 'mode-stop' }
    })
    native.flush()
    expect(drain).toHaveBeenCalledOnce()
    f.change({ mode: 'deep', captureId: 'capture-b' })
    drain.mockImplementation(() => {
      throw Error('diagnostic read failed')
    })
    expect(() => native.flush()).not.toThrow()
    expect(() => native.flush()).not.toThrow()
    expect(f.emit.mock.calls.filter(([record]) => record.level === 'warn')).toHaveLength(1)
    native.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps worst samples and all stage buckets through real sanitizer and Worker encoding budgets', () => {
    const metrics = createWindowMotionMetrics()
    for (let stage = 0; stage < 16; stage++) {
      metrics.add(`stage-${stage}`, 100)
      metrics.count(`count-${stage}`, 3)
    }
    for (let seq = 0; seq < 100; seq++)
      metrics.sample(seq, { seq, waitMs: seq - 1, actualPositionErrorPx: 0 })
    const metadata = sanitizeDiagnosticValue(
      { schemaVersion: 1, ...metrics.drain() },
      { maxBytes: 64 * 1024, maxDepth: 9, maxArray: 128, maxNodes: 4096 }
    )
    const encoded = encodeLogRecord({
      level: 'info',
      kind: 'metric',
      scope: 'performance.window-drag-main',
      metadata
    })
    const record = JSON.parse(encoded)
    expect(Object.keys(record.metadata.stages)).toHaveLength(16)
    expect(record.metadata.slowSamples).toHaveLength(6)
    expect(record.metadata.slowSamples[0]).toMatchObject({ seq: 99, waitMs: 98 })
    expect(record.metadata.stages['stage-15'].bins).toHaveLength(8)
    expect(Buffer.byteLength(encoded)).toBeLessThan(64 * 1024)
  })
  it.each(['get', 'subscribe', 'timer', 'clock'])(
    'keeps a failing %s observer outside movement results and cleanup',
    (failure) => {
      vi.useFakeTimers()
      const f = fixture('deep')
      const fail = () => {
        throw new Error('diagnostic-only failure')
      }
      if (failure === 'get' || failure === 'subscribe') f.state[failure] = fail
      let recorder
      expect(() => {
        recorder = createWindowMotionRecorder({
          scope: 'performance.motion',
          state: f.state,
          emit: f.emit,
          wallNow: f.now,
          now: failure === 'clock' ? fail : f.now,
          ...(failure === 'timer' ? { setTimer: fail } : {})
        })
      }).not.toThrow()
      const move = () => {
        recorder.stamp()
        recorder.add('move', 10)
        recorder.count('updates')
        recorder.sample(10, { seq: 1 })
        recorder.flush('business-complete')
        return 'original-result'
      }
      expect(move()).toBe('original-result')
      const original = new Error('original-business-error')
      let caught
      try {
        try {
          throw original
        } finally {
          recorder.finish()
        }
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(original)
      expect(f.emit.mock.calls.filter(([record]) => record.kind === 'metric')).toHaveLength(0)
      expect(f.emit.mock.calls.filter(([record]) => record.level === 'warn')).toHaveLength(1)
      expect(f.listenerCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('stops collecting when runtime state or numerical sample getters become unavailable', () => {
    vi.useFakeTimers()
    const f = fixture('deep')
    const recorder = createWindowMotionRecorder({
      scope: 'performance.motion',
      state: f.state,
      emit: f.emit,
      now: f.now,
      wallNow: f.now
    })
    const sample = {
      get waitMs() {
        throw new Error('sample getter failed')
      }
    }
    expect(() => recorder.sample(12, sample)).not.toThrow()
    expect(recorder.stamp()).toBe(null)
    expect(vi.getTimerCount()).toBe(0)
    recorder.finish()
    const another = createWindowMotionRecorder({
      scope: 'performance.motion',
      state: f.state,
      emit: f.emit,
      now: f.now,
      wallNow: f.now
    })
    f.state.get = () => {
      throw new Error('state disappeared')
    }
    expect(another.stamp()).toBe(null)
    expect(() => another.finish()).not.toThrow()
    expect(f.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('releases recorder resources even when emit and cleanup callbacks throw', () => {
    vi.useFakeTimers()
    const f = fixture('deep')
    const subscribe = f.state.subscribe
    f.state.subscribe = (listener) => {
      const unsubscribe = subscribe(listener)
      return () => {
        unsubscribe()
        throw new Error('release failed')
      }
    }
    const recorder = createWindowMotionRecorder({
      scope: 'performance.motion',
      state: f.state,
      now: f.now,
      wallNow: f.now,
      emit: () => {
        throw new Error('sink unavailable')
      },
      clearTimer: (timer) => {
        clearInterval(timer)
        throw new Error('timer release failed')
      }
    })
    recorder.add('move', 10)
    expect(() => recorder.finish()).not.toThrow()
    expect(() => recorder.finish()).not.toThrow()
    expect(f.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retains the native tail and clears its mode when disabling the lease throws', () => {
    vi.useFakeTimers()
    const f = fixture('deep')
    const setLease = vi.fn((duration) => {
      if (!duration) throw new Error('DLL already unavailable')
    })
    const drain = vi.fn(() => JSON.stringify({ observations: 1 }))
    const native = createNativeMotionDiagnostics({
      setLease,
      drain,
      state: f.state,
      now: f.now,
      emit: f.emit
    })
    expect(() => f.change({ mode: 'daily' })).not.toThrow()
    expect(f.emit.mock.calls[0][0]).toMatchObject({
      collectionPolicy: { mode: 'deep', captureId: 'capture-a' },
      metadata: { reason: 'mode-stop' }
    })
    expect(vi.getTimerCount()).toBe(0)
    native.flush()
    expect(drain).toHaveBeenCalledOnce()
    f.change({ mode: 'deep', captureId: 'capture-b' })
    expect(vi.getTimerCount()).toBe(1)
    expect(() => native.dispose()).not.toThrow()
    expect(f.emit.mock.calls[1][0].metadata.captureId).toBe('capture-b')
    expect(f.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['get', 'subscribe', 'timer', 'clock'])(
    'keeps native %s setup failures outside the native capability gate',
    (failure) => {
      vi.useFakeTimers()
      const f = fixture('deep')
      const fail = () => {
        throw new Error('diagnostic setup failed')
      }
      if (failure === 'get' || failure === 'subscribe') f.state[failure] = fail
      const setLease = vi.fn()
      let native
      expect(() => {
        native = createNativeMotionDiagnostics({
          setLease,
          drain: () => JSON.stringify({ observations: 0 }),
          state: f.state,
          emit: f.emit,
          now: failure === 'clock' ? fail : f.now,
          ...(failure === 'timer' ? { setTimer: fail } : {})
        })
      }).not.toThrow()
      expect(setLease).toHaveBeenLastCalledWith(0)
      expect(() => native.dispose()).not.toThrow()
      expect(f.listenerCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('flushes the native tail and stops its timer when state fails during sampling', () => {
    vi.useFakeTimers()
    const f = fixture('deep')
    const native = createNativeMotionDiagnostics({
      setLease: vi.fn(),
      drain: () => JSON.stringify({ observations: 1 }),
      state: f.state,
      emit: f.emit,
      now: f.now
    })
    f.state.get = () => {
      throw new Error('state unavailable during sample')
    }
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
    expect(f.emit.mock.calls[0][0].metadata.reason).toBe('state-unavailable')
    expect(vi.getTimerCount()).toBe(0)
    native.dispose()
    expect(f.listenerCount()).toBe(0)
  })
})
