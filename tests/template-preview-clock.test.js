import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTemplatePreviewClock } from '../src/renderer/src/composables/useTemplatePreviewClock.js'

let scope
let target
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-14T10:00:00'))
  scope = effectScope()
  target = new EventTarget()
  vi.stubGlobal('window', target)
})
afterEach(() => {
  scope.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function createClock({ candidateOffset = 30_000, endOffset = null, relativeStart = false } = {}) {
  const active = ref(true)
  const now = ref(Date.now())
  const previewAt = ref(Date.now() + candidateOffset)
  const endAt = ref(endOffset === null ? null : Date.now() + endOffset)
  const refresh = vi.fn()
  const clock = scope.run(() =>
    useTemplatePreviewClock({
      active: () => active.value,
      now,
      previewAt,
      endAt,
      relativeStart: () => relativeStart,
      refresh
    })
  )
  return { active, now, previewAt, endAt, refresh, clock }
}
describe('template preview boundary clock', () => {
  it.each([true, false])(
    'refreshes the save-day anchor at midnight only for a relative start (%s)',
    (relativeStart) => {
      vi.setSystemTime(new Date('2026-10-14T23:59:59'))
      const state = createClock({ candidateOffset: 3 * 86400000, relativeStart })
      vi.advanceTimersByTime(1000)
      expect(state.refresh).toHaveBeenCalledTimes(relativeStart ? 2 : 1)
      vi.advanceTimersByTime(10_000)
      expect(state.refresh).toHaveBeenCalledTimes(relativeStart ? 2 : 1)
    }
  )
  it('keeps time current without repeated preview requests before a boundary', () => {
    const state = createClock()
    expect(state.refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(29_000)
    expect(state.now.value).toBe(Date.now())
    expect(state.refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(state.refresh).toHaveBeenCalledTimes(2)
    state.previewAt.value = null
    vi.advanceTimersByTime(5000)
    state.previewAt.value = Date.now() - 5000
    vi.advanceTimersByTime(5000)
    expect(state.refresh).toHaveBeenCalledTimes(2)
    state.previewAt.value = Date.now() + 2000
    vi.advanceTimersByTime(2000)
    expect(state.refresh).toHaveBeenCalledTimes(3)
  })
  it('invalidates at the end boundary and submit-time sync catches a suspended clock', () => {
    const state = createClock({ candidateOffset: 60_000, endOffset: 10_000 })
    vi.setSystemTime(Date.now() + 11_000)
    state.clock.sync()
    expect(state.refresh).toHaveBeenCalledTimes(2)
    state.previewAt.value = null
    vi.advanceTimersByTime(10_000)
    expect(state.refresh).toHaveBeenCalledTimes(2)
  })
  it('refreshes on reopen/focus and removes timers and listeners on disposal', () => {
    const state = createClock()
    state.active.value = false
    expect(vi.getTimerCount()).toBe(0)
    target.dispatchEvent(new Event('focus'))
    expect(state.refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    state.active.value = true
    expect(state.refresh).toHaveBeenCalledTimes(2)
    expect(state.now.value).toBe(Date.now())
    target.dispatchEvent(new Event('focus'))
    expect(state.refresh).toHaveBeenCalledTimes(3)
    scope.stop()
    expect(vi.getTimerCount()).toBe(0)
    target.dispatchEvent(new Event('focus'))
    expect(state.refresh).toHaveBeenCalledTimes(3)
  })
})
