import { describe, expect, it, vi } from 'vitest'
import { CompactPresentationCompletion } from '../src/main/windows/compact-presentation-completion.js'

describe('CompactPresentationCompletion', () => {
  it('acknowledges exactly one matching generation', async () => {
    const completion = new CompactPresentationCompletion()
    const pending = completion.wait(7, 100)
    expect(completion.acknowledge(6)).toBe(false)
    expect(completion.acknowledge(7)).toBe(true)
    expect(completion.acknowledge(7)).toBe(false)
    await expect(pending).resolves.toEqual({ status: 'completed', generation: 7 })
  })

  it('settles as timeout without leaving a pending entry', async () => {
    vi.useFakeTimers()
    const completion = new CompactPresentationCompletion()
    const pending = completion.wait(9, 80)
    await vi.advanceTimersByTimeAsync(80)
    await expect(pending).resolves.toEqual({ status: 'timeout', generation: 9 })
    expect(completion.acknowledge(9)).toBe(false)
    vi.useRealTimers()
  })
})
