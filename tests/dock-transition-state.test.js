import { describe, expect, it } from 'vitest'
import { DockTransitionState } from '../src/main/window-motion/dock-transition-state.js'

describe('DockTransitionState', () => {
  it('queues a show request received during the hide animation and consumes it once', () => {
    const state = new DockTransitionState()

    expect(state.requestShow({ hidden: true, sliding: true })).toBe('queued')
    expect(state.consumeQueuedShow()).toBe(true)
    expect(state.consumeQueuedShow()).toBe(false)
  })

  it('starts showing immediately only after the hide animation has completed', () => {
    const state = new DockTransitionState()

    expect(state.requestShow({ hidden: false, sliding: false })).toBe('ignore')
    expect(state.requestShow({ hidden: true, sliding: false })).toBe('start')
  })

  it('restores temporary always-on-top even when external sliding state was already cleared', () => {
    const state = new DockTransitionState()
    state.beginTemporaryAlwaysOnTop()

    expect(state.reset()).toEqual({ restoreAlwaysOnTop: true })
    expect(state.reset()).toEqual({ restoreAlwaysOnTop: false })
  })

  it('does not restore again after a normal show animation completes', () => {
    const state = new DockTransitionState()
    state.beginTemporaryAlwaysOnTop()
    state.finishTemporaryAlwaysOnTop()

    expect(state.reset()).toEqual({ restoreAlwaysOnTop: false })
  })
})
