import { describe, expect, it, vi } from 'vitest'
import {
  PRESENTATION_MODES,
  PresentationModeController
} from '../src/main/windows/presentation-mode-controller.js'

function windowStub() {
  return { isDestroyed: () => false }
}

describe('PresentationModeController', () => {
  it('serializes requests and follows only the latest desired mode', async () => {
    const window = windowStub()
    const calls = []
    let releaseCompact
    const compactGate = new Promise((resolve) => {
      releaseCompact = resolve
    })
    const controller = new PresentationModeController()
    controller.initialize(window)
    const perform = vi.fn(async ({ operation }) => {
      calls.push(`${operation.from}->${operation.to}`)
      if (operation.to === PRESENTATION_MODES.COMPACT) await compactGate
    })
    const recover = vi.fn()

    const first = controller.request(
      window,
      PRESENTATION_MODES.COMPACT,
      { source: 'first' },
      {
        perform,
        recover
      }
    )
    const second = controller.request(
      window,
      PRESENTATION_MODES.EXPANDED,
      { source: 'second' },
      {
        perform,
        recover
      }
    )
    releaseCompact()

    await expect(first).resolves.toMatchObject({ mode: PRESENTATION_MODES.EXPANDED })
    await expect(second).resolves.toMatchObject({ mode: PRESENTATION_MODES.EXPANDED })
    expect(calls).toEqual(['expanded->compact', 'compact->expanded'])
    expect(controller.snapshot()).toEqual({
      committedMode: PRESENTATION_MODES.EXPANDED,
      desiredMode: PRESENTATION_MODES.EXPANDED,
      operation: null
    })
    expect(recover).not.toHaveBeenCalled()
  })

  it('forces the stable state back to expanded when an operation fails', async () => {
    const window = windowStub()
    const recover = vi.fn(async () => {})
    const controller = new PresentationModeController()
    controller.initialize(window)

    await expect(
      controller.request(window, PRESENTATION_MODES.COMPACT, null, {
        perform: async () => {
          throw new Error('renderer failed')
        },
        recover
      })
    ).rejects.toThrow('renderer failed')
    expect(recover).toHaveBeenCalledOnce()
    expect(controller.snapshot()).toMatchObject({
      committedMode: PRESENTATION_MODES.EXPANDED,
      desiredMode: PRESENTATION_MODES.EXPANDED,
      operation: null
    })
  })
})
