import { describe, expect, it, vi } from 'vitest'
import {
  DockNativeStatusObserver,
  createDockNativeStatusSignature
} from '../src/main/logging/dock-native-status-observer.js'

function createFixture(initial = {}) {
  let status = {
    supported: true,
    state: 'armed',
    workerAlive: true,
    generation: 7,
    side: 'left',
    lastPollAgeMs: 10,
    handleState: 'hidden',
    handleVisible: false,
    handlePresented: false,
    handleVisualFrame: 0,
    handleRect: { left: 0, top: 400, right: 8, bottom: 480 },
    ...initial
  }
  const logger = { info: vi.fn(), warn: vi.fn() }
  const observer = new DockNativeStatusObserver({
    getStatus: () => status,
    getContext: () => ({ display: { id: 1, scalePercent: 125 } }),
    logger,
    intervalMs: 250
  })
  return {
    observer,
    logger,
    setStatus(next) {
      status = { ...status, ...next }
    }
  }
}

describe('dock native status observer', () => {
  it('ignores poll age and drawing counters but records meaningful state changes', () => {
    vi.useFakeTimers()
    try {
      const fixture = createFixture()
      fixture.observer.start(7)
      expect(fixture.logger.info).toHaveBeenCalledTimes(1)

      fixture.setStatus({ lastPollAgeMs: 90, handleVisualFrame: 12 })
      vi.advanceTimersByTime(250)
      expect(fixture.logger.info).toHaveBeenCalledTimes(1)

      fixture.setStatus({ handleState: 'appearing', handleVisible: true })
      vi.advanceTimersByTime(250)
      expect(fixture.logger.info).toHaveBeenCalledTimes(2)
      expect(fixture.logger.info.mock.calls.at(-1)[2]).toMatchObject({
        observerGeneration: 7,
        generationMatches: true,
        status: { handleState: 'appearing', handleVisible: true },
        context: { display: { scalePercent: 125 } }
      })

      fixture.observer.stop('show-after-disarm', { capture: false })
      vi.advanceTimersByTime(500)
      expect(fixture.logger.info).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records handle geometry changes and a forced final snapshot', () => {
    vi.useFakeTimers()
    try {
      const fixture = createFixture()
      fixture.observer.start(7)
      fixture.setStatus({ handleRect: { left: 0, top: 500, right: 8, bottom: 580 } })
      vi.advanceTimersByTime(250)
      expect(fixture.logger.info).toHaveBeenCalledTimes(2)

      fixture.setStatus({ state: 'stopped', workerAlive: false, generation: 0 })
      fixture.observer.stop('show-after-disarm')
      expect(fixture.logger.info).toHaveBeenCalledTimes(3)
      expect(fixture.logger.info.mock.calls.at(-1)[2]).toMatchObject({
        source: 'show-after-disarm',
        generationMatches: false,
        status: { state: 'stopped', workerAlive: false, generation: 0 }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('deduplicates repeated read failures and reports recovery with the next state', () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    let fail = true
    const observer = new DockNativeStatusObserver({
      getStatus: () => {
        if (fail) throw new Error('native status unavailable')
        return { state: 'armed', workerAlive: true, generation: 3 }
      },
      logger
    })

    observer.generation = 3
    observer.capture('poll')
    observer.capture('poll')
    expect(logger.warn).toHaveBeenCalledTimes(1)

    fail = false
    observer.capture('poll')
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0][2].recoveredReadFailures).toBe(2)
  })

  it('keeps rapidly changing timing counters out of the signature', () => {
    const base = {
      state: 'ready',
      generation: 2,
      lastPollAgeMs: 10,
      handlePresentCount: 2,
      handleVisualFrame: 8
    }
    expect(
      createDockNativeStatusSignature({
        ...base,
        lastPollAgeMs: 240,
        handlePresentCount: 20,
        handleVisualFrame: 40
      })
    ).toBe(createDockNativeStatusSignature(base))
  })
})
