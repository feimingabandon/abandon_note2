import { describe, expect, it, vi } from 'vitest'
import {
  CompactWindowController,
  COMPACT_WINDOW_MODES
} from '../src/main/windows/compact-window-controller.js'

function createWindow() {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    }
  }
}

describe('CompactWindowController', () => {
  it('owns only committed mode, desired mode, and one presentation transaction', async () => {
    const window = createWindow()
    const changed = vi.fn()
    const controller = new CompactWindowController({ onStateChanged: changed })
    controller.initializeForWindow(window)
    const perform = vi.fn(async ({ generation }) => {
      controller.publishTransition(window, generation)
      return { status: 'completed' }
    })

    const result = await controller.request(window, COMPACT_WINDOW_MODES.COMPACT, perform)

    expect(result).toMatchObject({ changed: true, mode: 'compact' })
    expect(controller.snapshot()).toMatchObject({
      phase: 'compact',
      committedMode: 'compact',
      desiredMode: 'compact',
      transition: null
    })
    expect(controller.transitionSnapshot()).toBeNull()
    expect(changed).toHaveBeenCalled()
  })

  it('coalesces duplicate requests into the active transaction', async () => {
    const window = createWindow()
    const controller = new CompactWindowController()
    controller.initializeForWindow(window)
    let release
    const perform = vi.fn(() => new Promise((resolve) => (release = resolve)))

    const first = controller.request(window, 'compact', perform)
    const second = controller.request(window, 'compact', perform)
    expect(second).toBe(first)
    await Promise.resolve()
    expect(perform).toHaveBeenCalledTimes(1)
    release({ status: 'completed' })
    await expect(first).resolves.toMatchObject({ changed: true, mode: 'compact' })
  })

  it('finishes the current transaction and then applies only the latest opposite intent', async () => {
    const window = createWindow()
    const controller = new CompactWindowController()
    controller.initializeForWindow(window)
    const releases = []
    const perform = vi.fn(
      ({ from, to }) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ from, to }))
        })
    )

    const first = controller.request(window, 'compact', perform)
    await Promise.resolve()
    const second = controller.request(window, 'expanded', perform)
    expect(second).toBe(first)
    releases.shift()()
    await vi.waitFor(() => expect(perform).toHaveBeenCalledTimes(2))
    expect(perform.mock.calls[1][0]).toMatchObject({ from: 'compact', to: 'expanded' })
    releases.shift()()
    await expect(first).resolves.toMatchObject({ changed: true, mode: 'expanded' })
  })

  it('rejects an invalid transition and keeps the last committed mode', async () => {
    const window = createWindow()
    const failure = new Error('presentation failed')
    const onError = vi.fn()
    const controller = new CompactWindowController({ onError })
    controller.initializeForWindow(window)

    await expect(controller.request(window, 'compact', () => Promise.reject(failure))).rejects.toBe(
      failure
    )
    expect(controller.committedMode).toBe('expanded')
    expect(controller.desiredMode).toBe('expanded')
    expect(controller.transitionSnapshot()).toBeNull()
    expect(onError).toHaveBeenCalledWith(failure, expect.any(Object))
  })

  it('never allows an active window transaction to be detached', async () => {
    const window = createWindow()
    const controller = new CompactWindowController()
    controller.initializeForWindow(window)
    let release
    const pending = controller.request(
      window,
      'compact',
      () => new Promise((resolve) => (release = resolve))
    )
    await Promise.resolve()

    expect(() => controller.cancelForWindowReplacement(window)).toThrow('事务尚未结束')
    release({ status: 'completed' })
    await pending
    expect(controller.cancelForWindowReplacement(window)?.status).toBe('window-replaced')
  })
})
