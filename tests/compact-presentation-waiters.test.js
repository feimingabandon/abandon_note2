import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompactPresentationWaiters } from '../src/main/windows/compact-presentation-waiters.js'

afterEach(() => vi.useRealTimers())
describe('compact presentation acknowledgements', () => {
  it('retains a valid acknowledgement received before waiting begins', async () => {
    vi.useFakeTimers()
    const gate = new CompactPresentationWaiters()
    gate.acknowledge(1, 'content-exit')
    await gate.wait(1, 'content-exit')
    expect(vi.getTimerCount()).toBe(0)
    gate.clear(1)
    expect(gate.completed.size).toBe(0)
  })

  it('does not let another generation satisfy a pending stage', async () => {
    vi.useFakeTimers()
    const gate = new CompactPresentationWaiters(100)
    const assertion = expect(gate.wait(2, 'content-exit')).rejects.toThrow('content-exit')
    gate.acknowledge(1, 'content-exit')
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    gate.clear(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears timeout handles after completion and transaction cleanup', async () => {
    vi.useFakeTimers()
    const gate = new CompactPresentationWaiters()
    const first = gate.wait(3, 'shell-transform')
    gate.acknowledge(3, 'shell-transform')
    await first
    const next = gate.wait(3, 'shell-settle')
    gate.clear(3)
    await next
    expect(vi.getTimerCount()).toBe(0)
    expect(gate.completed.size).toBe(0)
    expect(gate.acknowledge(3, 'unknown')).toBe(false)
  })
})
