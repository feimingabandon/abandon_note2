import { describe, expect, it, vi } from 'vitest'
import { dailyDiagnosticPolicy } from '../src/shared/diagnostic-policy.js'
import { createWindowDragDiagnostics } from '../src/renderer/src/utils/windowDragDiagnostics.js'

function fixture(initialMode = 'deep', overrides = {}) {
  const origin = 1_000_000
  let time = 100
  let nextTimer = 0
  const timers = new Map()
  const policyListeners = new Set()
  const flushListeners = new Set()
  const pageListeners = new Map()
  const deepPolicy = (epoch = 7, captureId = 'capture-1', expiresAt = origin + 10_000) => ({
    ...dailyDiagnosticPolicy(epoch),
    mode: 'deep',
    captureId,
    expiresAt,
    sampleIntervalMs: 5000
  })
  let policy = initialMode === 'deep' ? deepPolicy() : dailyDiagnosticPolicy(6)
  const sink = vi.fn()
  const clock = { timeOrigin: origin, now: vi.fn(() => time) }
  const api = {
    getDiagnosticPolicy: () => policy,
    onDiagnosticPolicy(callback) {
      policyListeners.add(callback)
      callback(policy)
      return () => policyListeners.delete(callback)
    },
    onDiagnosticFlush(callback) {
      flushListeners.add(callback)
      return () => flushListeners.delete(callback)
    },
    registerDiagnosticCapability: vi.fn()
  }
  const diagnostics = createWindowDragDiagnostics({
    api,
    clock,
    policyNow: () => origin + time,
    sink,
    setInterval(callback, interval) {
      const id = ++nextTimer
      timers.set(id, { callback, interval })
      return id
    },
    clearInterval: (id) => timers.delete(id),
    pageTarget: {
      addEventListener: (name, callback) => pageListeners.set(name, callback),
      removeEventListener: (name) => pageListeners.delete(name)
    },
    ...overrides
  })
  return {
    origin,
    api,
    clock,
    sink,
    diagnostics,
    timers,
    policyListeners,
    flushListeners,
    pageListeners,
    deepPolicy,
    at: (value) => {
      time = value
    },
    setPolicy(next) {
      policy = next
      for (const callback of policyListeners) callback(next)
    },
    tick() {
      for (const timer of [...timers.values()]) timer.callback()
    },
    exportFlush() {
      for (const callback of flushListeners) callback()
    },
    records: () => sink.mock.calls.map(([record]) => record)
  }
}

describe('window drag diagnostic evidence', () => {
  it('does not measure, allocate timers or emit detailed packets in daily mode', () => {
    const f = fixture('daily')
    expect(f.diagnostics.begin('daily-drag')).toBeUndefined()
    for (let i = 0; i < 1000; i++) {
      f.diagnostics.recordPointer({ timeStamp: 90 })
      f.diagnostics.scheduleFrame()
      expect(f.diagnostics.createUpdatePacket()).toBeUndefined()
    }
    f.diagnostics.end()
    expect(f.clock.now).not.toHaveBeenCalled()
    expect(f.timers.size).toBe(0)
    expect(f.sink).not.toHaveBeenCalled()
    f.diagnostics.dispose()
  })

  it('calibrates cross-process clock bounds without treating an object as a successful begin', () => {
    const f = fixture()
    expect(f.diagnostics.begin('clock-drag')).toEqual({ version: 1, sentAt: f.origin + 100 })
    expect(f.diagnostics.acceptBegin({ started: false }, 'clock-drag')).toBe(false)
    f.at(140)
    expect(
      f.diagnostics.acceptBegin(
        {
          started: true,
          diagnosticClock: {
            version: 1,
            mainReceivedAt: f.origin + 120,
            mainSentAt: f.origin + 130
          }
        },
        'clock-drag'
      )
    ).toBe(true)
    f.at(170)
    expect(f.diagnostics.createUpdatePacket()).toEqual({
      version: 1,
      dragId: 'clock-drag',
      captureId: 'capture-1',
      policyEpoch: 7,
      seq: 1,
      sentAt: f.origin + 170,
      clockOffsetLowMs: -10,
      clockOffsetHighMs: 20
    })
    f.diagnostics.end()
    expect(f.records()[0].metadata.beginRoundTrip.meanMs).toBe(40)
    expect(f.records()[0].metadata.clockStatus).toBe('calibrated')
  })

  it('supports legacy bool responses and reports missing or impossible clock evidence as unknown', () => {
    const f = fixture()
    f.diagnostics.begin('legacy')
    f.at(130)
    expect(f.diagnostics.acceptBegin(true, 'legacy')).toBe(true)
    expect(f.diagnostics.createUpdatePacket().clockOffsetLowMs).toBeNull()
    f.diagnostics.end()
    expect(f.records()[0].metadata.clockStatus).toBe('missing-main-handshake')

    f.diagnostics.begin('invalid')
    f.at(150)
    expect(
      f.diagnostics.acceptBegin(
        {
          started: true,
          diagnosticClock: {
            version: 1,
            mainReceivedAt: f.origin + 140,
            mainSentAt: f.origin + 200
          }
        },
        'invalid'
      )
    ).toBe(true)
    expect(f.diagnostics.createUpdatePacket().clockOffsetHighMs).toBeNull()
    f.diagnostics.end()
    expect(f.records()[1].metadata.clockStatus).toBe('invalid-handshake')
    expect(f.diagnostics.acceptBegin({ started: false }, 'invalid')).toBe(false)
  })

  it('separates input dispatch delay, RAF wait and pointer age while counting intentional coalescing', () => {
    const f = fixture()
    f.diagnostics.begin('timed')
    f.at(110)
    f.diagnostics.recordPointer({ timeStamp: 106 })
    f.diagnostics.scheduleFrame()
    f.at(117)
    f.diagnostics.recordPointer({ timeStamp: 115 })
    f.at(124)
    f.diagnostics.recordPointer({ timeStamp: 121 })
    f.at(130)
    const first = f.diagnostics.createUpdatePacket()
    f.at(150)
    const final = f.diagnostics.createUpdatePacket({ source: 'final' })
    f.diagnostics.end('pointerup')
    expect([first.seq, final.seq]).toEqual([1, 2])
    const record = f.records()[0]
    expect(record.scope).toBe('performance.window-drag-renderer')
    expect(record.metadata).toMatchObject({
      pointerMoves: 3,
      updates: 2,
      finalUpdates: 1,
      coalescedPointers: 2,
      dispatchAge: { count: 3, totalMs: 9, maxMs: 4 },
      scheduleWait: { count: 1, meanMs: 20 },
      latestPointerAge: { count: 2, maxMs: 29 },
      updateIntervals: { count: 1, meanMs: 20 },
      updateIntervalIsNotPresentationFps: true
    })
    expect(record.metadata.slowestSamples.find((sample) => sample.seq === 1)).toMatchObject({
      dispatchAgeMs: 3,
      scheduleWaitMs: 20,
      latestPointerAgeMs: 9,
      dispatchToSendMs: 6,
      coalescedPointers: 2
    })
    expect(f.sink).toHaveBeenCalledTimes(1)
  })

  it('keeps only bounded slow examples under a long high-frequency drag', () => {
    const f = fixture()
    f.diagnostics.begin('bounded')
    for (let i = 0; i < 2000; i++) {
      f.at(110 + i * 2)
      f.diagnostics.recordPointer({ timeStamp: 109 + i * 2 })
      f.diagnostics.scheduleFrame()
      f.at(111 + i * 2)
      f.diagnostics.createUpdatePacket()
    }
    expect(f.sink).not.toHaveBeenCalled()
    f.diagnostics.end()
    const record = f.records()[0]
    expect(record.metadata.pointerMoves).toBe(2000)
    expect(record.metadata.updates).toBe(2000)
    expect(record.metadata.slowestSamples).toHaveLength(8)
    expect(JSON.stringify(record).length).toBeLessThan(16 * 1024)
  })

  it('starts a mid-drag capture without inventing calibration and preserves the stopped tail batch', () => {
    const f = fixture('daily')
    f.diagnostics.begin('mid-drag')
    f.setPolicy(f.deepPolicy(8, 'capture-mid'))
    f.at(130)
    f.diagnostics.recordPointer({ timeStamp: 125 })
    const packet = f.diagnostics.createUpdatePacket()
    expect(packet).toMatchObject({
      captureId: 'capture-mid',
      policyEpoch: 8,
      clockOffsetLowMs: null
    })
    f.setPolicy(dailyDiagnosticPolicy(9))
    expect(f.records()).toHaveLength(1)
    expect(f.records()[0]).toMatchObject({
      kind: 'metric',
      metadata: {
        collectedMode: 'deep',
        captureId: 'capture-mid',
        sourcePolicyEpoch: 8,
        flushReason: 'policy-change',
        clockStatus: 'missing-begin-handshake'
      }
    })
    expect(f.records()[0]).not.toHaveProperty('detail')
    expect(f.timers.size).toBe(0)
    expect(f.diagnostics.createUpdatePacket()).toBeUndefined()
    f.diagnostics.end()
    expect(f.records()).toHaveLength(1)
  })

  it('flushes every five seconds and on export/end without duplicating an already empty batch', () => {
    const f = fixture()
    f.diagnostics.begin('flush-drag')
    expect([...f.timers.values()][0].interval).toBe(5000)
    f.diagnostics.recordPointer({ timeStamp: 90 })
    f.diagnostics.createUpdatePacket()
    f.at(5100)
    f.tick()
    expect(f.records()[0].metadata.flushReason).toBe('interval')
    f.at(5200)
    f.diagnostics.recordPointer({ timeStamp: 5190 })
    expect(f.diagnostics.createUpdatePacket().seq).toBe(2)
    f.exportFlush()
    expect(f.records()[1].metadata.flushReason).toBe('export')
    f.diagnostics.end()
    expect(f.records()).toHaveLength(2)
    expect(f.timers.size).toBe(0)
  })

  it('stops immediately after expiry and flushes the existing tail under its original capture', () => {
    const f = fixture()
    f.diagnostics.begin('expires')
    f.diagnostics.recordPointer({ timeStamp: 90 })
    f.diagnostics.createUpdatePacket()
    f.at(10_001)
    f.diagnostics.recordPointer({ timeStamp: 10_000 })
    expect(f.diagnostics.createUpdatePacket()).toBeUndefined()
    expect(f.records()[0].metadata).toMatchObject({
      flushReason: 'policy-expired',
      captureId: 'capture-1',
      sourcePolicyEpoch: 7,
      pointerMoves: 1
    })
    expect(f.timers.size).toBe(0)
  })

  it('reports invalid timestamps as missing evidence and releases observers on pagehide', () => {
    const f = fixture()
    f.diagnostics.begin('unload')
    f.diagnostics.recordPointer({ timeStamp: f.origin + 100 })
    f.diagnostics.scheduleFrame()
    f.diagnostics.cancelFrame()
    f.diagnostics.createUpdatePacket({ source: 'final' })
    f.pageListeners.get('pagehide')()
    const record = f.records()[0]
    expect(record.metadata).toMatchObject({
      flushReason: 'dispose',
      invalidEventTimestamps: 1,
      cancelledFrames: 1,
      dispatchAge: { count: 0, meanMs: null },
      latestPointerAge: { count: 0, meanMs: null }
    })
    expect(f.policyListeners.size).toBe(0)
    expect(f.flushListeners.size).toBe(0)
    expect(f.pageListeners.size).toBe(0)
    expect(f.timers.size).toBe(0)
    f.diagnostics.dispose()
    expect(f.records()).toHaveLength(1)
  })

  it('does not let an old begin response or delayed cleanup attach to a newer drag', () => {
    const f = fixture()
    f.diagnostics.begin('old')
    f.diagnostics.begin('new')
    f.at(140)
    expect(
      f.diagnostics.acceptBegin(
        {
          started: true,
          diagnosticClock: {
            version: 1,
            mainReceivedAt: f.origin + 120,
            mainSentAt: f.origin + 130
          }
        },
        'old'
      )
    ).toBe(true)
    expect(f.diagnostics.createUpdatePacket({ source: 'final', dragId: 'old' })).toBeUndefined()
    f.diagnostics.end('old-cleanup', 'old')
    expect(f.diagnostics.createUpdatePacket()).toMatchObject({
      dragId: 'new',
      seq: 1,
      clockOffsetLowMs: null
    })
    f.diagnostics.end('new-end', 'new')
  })

  it('keeps movement observations usable when the optional sink throws', () => {
    const f = fixture()
    f.sink.mockImplementation(() => {
      throw new Error('diagnostic sink unavailable')
    })
    f.diagnostics.begin('sink-failed')
    f.diagnostics.recordPointer({ timeStamp: 90 })
    expect(f.diagnostics.createUpdatePacket().seq).toBe(1)
    expect(() => f.diagnostics.end()).not.toThrow()
    expect(f.timers.size).toBe(0)
  })

  it('does not let a throwing clock escape any public observation API or change an accepted begin', () => {
    const f = fixture()
    f.diagnostics.begin('clock-unavailable')
    f.clock.now.mockImplementation(() => {
      throw new Error('clock unavailable')
    })
    for (const work of [
      () => f.diagnostics.recordPointer({ timeStamp: 90 }),
      () => f.diagnostics.scheduleFrame(),
      () => f.diagnostics.cancelFrame(),
      () => f.diagnostics.createUpdatePacket(),
      () => f.diagnostics.flush(),
      () => f.diagnostics.end(),
      () => f.diagnostics.begin('second'),
      () => f.diagnostics.dispose()
    ])
      expect(work).not.toThrow()
    expect(f.diagnostics.acceptBegin({ started: true }, 'second')).toBe(true)
    expect(f.diagnostics.acceptBegin({ started: false }, 'second')).toBe(false)
    expect(f.diagnostics.acceptBegin(true, 'second')).toBe(true)
  })

  it('preserves the accepted business result when clock calibration itself throws', () => {
    const f = fixture()
    f.diagnostics.begin('calibration-unavailable')
    f.clock.now.mockImplementation(() => {
      throw new Error('calibration clock unavailable')
    })
    expect(f.diagnostics.acceptBegin({ started: true }, 'calibration-unavailable')).toBe(true)
    f.clock.now.mockImplementation(() => 140)
    expect(f.diagnostics.createUpdatePacket().clockOffsetLowMs).toBeNull()
    f.diagnostics.end()
    expect(f.records()[0].metadata).toMatchObject({
      clockStatus: 'observation-unavailable',
      observationFailures: 1
    })
  })

  it('isolates nowEpoch failures and can submit an existing tail with unknown timing', () => {
    let broken = false
    const f = fixture('deep', {
      nowEpoch: () => {
        if (broken) throw new Error('epoch clock unavailable')
        return 1_000_100
      }
    })
    f.diagnostics.begin('epoch-unavailable')
    f.diagnostics.recordPointer({ timeStamp: 90 })
    broken = true
    expect(f.diagnostics.acceptBegin({ started: true }, 'epoch-unavailable')).toBe(true)
    expect(f.diagnostics.createUpdatePacket()).toBeUndefined()
    expect(() => f.diagnostics.end()).not.toThrow()
    expect(f.records()[0].metadata.intervalEnd).toBeNull()
    expect(f.records()[0].metadata.observationFailures).toBeGreaterThan(0)
    expect(f.timers.size).toBe(0)
  })

  it('tries a failed interval setup once per capture and retains transaction-end aggregation', () => {
    const setInterval = vi.fn(() => {
      throw new Error('timer setup unavailable')
    })
    const f = fixture('deep', { setInterval })
    expect(() => f.diagnostics.begin('timer-unavailable')).not.toThrow()
    for (let i = 0; i < 20; i++) {
      f.diagnostics.recordPointer({ timeStamp: 90 })
      expect(f.diagnostics.createUpdatePacket().seq).toBe(i + 1)
    }
    expect(setInterval).toHaveBeenCalledTimes(1)
    f.diagnostics.end()
    expect(f.records()[0].metadata).toMatchObject({ updates: 20, observationFailures: 1 })
  })

  it('invalidates an uncleared timer so its callbacks cannot collect a later drag', () => {
    const oldCallbacks = []
    const f = fixture('deep', {
      setInterval: (callback) => {
        oldCallbacks.push(callback)
        return oldCallbacks.length
      },
      clearInterval: () => {
        throw new Error('timer cleanup unavailable')
      }
    })
    f.diagnostics.begin('old-timer')
    f.diagnostics.recordPointer({ timeStamp: 90 })
    f.diagnostics.createUpdatePacket()
    expect(() => f.diagnostics.end()).not.toThrow()
    f.diagnostics.begin('new-timer')
    f.diagnostics.recordPointer({ timeStamp: 90 })
    expect(f.diagnostics.createUpdatePacket().dragId).toBe('new-timer')
    oldCallbacks[0]()
    expect(f.records()).toHaveLength(1)
    expect(() => f.diagnostics.dispose()).not.toThrow()
    for (const callback of oldCallbacks) expect(callback).not.toThrow()
    expect(f.records()).toHaveLength(2)
  })

  it('attempts every independent cleanup even when one unsubscribe and the page handler fail', () => {
    const unsubscribePolicy = vi.fn(() => {
      throw new Error('policy cleanup unavailable')
    })
    const unsubscribeFlush = vi.fn()
    const removeEventListener = vi.fn(() => {
      throw new Error('page cleanup unavailable')
    })
    const diagnostics = createWindowDragDiagnostics({
      api: {
        getDiagnosticPolicy: () => dailyDiagnosticPolicy(),
        onDiagnosticPolicy: () => unsubscribePolicy,
        onDiagnosticFlush: () => unsubscribeFlush
      },
      pageTarget: { addEventListener: vi.fn(), removeEventListener }
    })
    expect(() => diagnostics.dispose()).not.toThrow()
    expect(unsubscribePolicy).toHaveBeenCalledTimes(1)
    expect(unsubscribeFlush).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    diagnostics.dispose()
    expect(unsubscribePolicy).toHaveBeenCalledTimes(1)
    expect(diagnostics.begin('disposed')).toBeUndefined()
  })

  it('isolates broken policy getters and subscription setup from remaining lifecycle registration', () => {
    const onDiagnosticFlush = vi.fn(() => vi.fn())
    const addEventListener = vi.fn()
    let diagnostics
    expect(() => {
      diagnostics = createWindowDragDiagnostics({
        api: {
          getDiagnosticPolicy: () => {
            throw new Error('policy read unavailable')
          },
          onDiagnosticPolicy: () => {
            throw new Error('policy subscription unavailable')
          },
          onDiagnosticFlush
        },
        pageTarget: { addEventListener, removeEventListener: vi.fn() }
      })
    }).not.toThrow()
    expect(onDiagnosticFlush).toHaveBeenCalledTimes(1)
    expect(addEventListener).toHaveBeenCalledTimes(1)
    expect(diagnostics.begin('policy-unavailable')).toBeUndefined()
    expect(diagnostics.acceptBegin(true, 'policy-unavailable')).toBe(true)
    expect(() => diagnostics.dispose()).not.toThrow()
  })

  it('keeps public and subscribed callbacks safe when the policy expiry clock throws', () => {
    const f = fixture('deep', {
      policyNow: () => {
        throw new Error('policy clock unavailable')
      }
    })
    expect(f.diagnostics.begin('policy-clock-unavailable')).toBeUndefined()
    expect(f.diagnostics.createUpdatePacket()).toBeUndefined()
    expect(() => f.setPolicy(f.deepPolicy(8, 'next-capture'))).not.toThrow()
    expect(() => f.exportFlush()).not.toThrow()
    expect(() => f.tick()).not.toThrow()
    expect(f.diagnostics.acceptBegin({ started: true }, 'policy-clock-unavailable')).toBe(true)
    expect(() => f.diagnostics.dispose()).not.toThrow()
  })
})
