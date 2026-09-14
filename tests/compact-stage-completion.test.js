import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollCompactStageEndpoint } from '../src/renderer/src/components/system/compact-stage-completion.js'

afterEach(() => vi.useRealTimers())

describe('compact renderer stage completion fallback', () => {
  it('rechecks a delayed endpoint instead of abandoning the acknowledgement', async () => {
    vi.useFakeTimers()
    let checks = 0
    const onReady = vi.fn()

    pollCompactStageEndpoint({
      initialDelayMs: 260,
      isCurrent: () => true,
      isAtEndpoint: () => ++checks >= 3,
      onReady,
      now: () => Date.now()
    })

    await vi.advanceTimersByTimeAsync(359)
    expect(onReady).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(checks).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops retrying when the transition changes or the caller cancels', async () => {
    vi.useFakeTimers()
    let current = true
    const onReady = vi.fn()
    const stop = pollCompactStageEndpoint({
      initialDelayMs: 100,
      isCurrent: () => current,
      isAtEndpoint: () => false,
      onReady,
      now: () => Date.now()
    })

    await vi.advanceTimersByTimeAsync(100)
    current = false
    await vi.advanceTimersByTimeAsync(50)
    expect(onReady).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a genuinely stuck stage for the main-process timeout to reject', async () => {
    vi.useFakeTimers()
    const onReady = vi.fn()

    pollCompactStageEndpoint({
      initialDelayMs: 260,
      isCurrent: () => true,
      isAtEndpoint: () => false,
      onReady,
      maxWaitMs: 500,
      now: () => Date.now()
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(onReady).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
