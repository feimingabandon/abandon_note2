import { describe, expect, it, vi } from 'vitest'
import {
  CompactWindowController,
  PRESENTATION_STAGES,
  TRANSITION_STATUSES
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
  it('tracks one native transaction without writing BrowserWindow bounds', async () => {
    const window = createWindow()
    const onPhaseChanged = vi.fn()
    const controller = new CompactWindowController({ onPhaseChanged })
    controller.initializeForWindow(window, 'expanded')
    const executor = vi.fn(async () => ({ success: true }))
    const from = { x: 0, y: 0, width: 480, height: 720 }
    const target = { x: 60, y: 0, width: 360, height: 76 }

    const pending = controller.run(
      window,
      { from, target, duration: 440, phase: 'collapsing' },
      executor
    )

    expect(controller.phase).toBe('collapsing')
    expect(controller.transitionSnapshot()).toMatchObject({
      from,
      target,
      duration: 440,
      stage: PRESENTATION_STAGES.CONTENT_EXIT
    })
    const result = await pending
    expect(result.status).toBe(TRANSITION_STATUSES.COMPLETED)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(controller.transitionSnapshot()).toBeNull()
    expect(controller.complete(result, 'compact')).toBe(true)
    expect(controller.phase).toBe('compact')
    expect(onPhaseChanged).toHaveBeenCalled()
  })

  it('advances presentation stages without changing window identity or geometry ownership', async () => {
    const window = createWindow()
    const controller = new CompactWindowController()
    controller.initializeForWindow(window, 'expanded')
    let release
    const pending = controller.run(
      window,
      {
        from: { x: 0, y: 0, width: 480, height: 720 },
        target: { x: 60, y: 0, width: 360, height: 76 },
        duration: 440,
        phase: 'collapsing'
      },
      () => new Promise((resolve) => (release = resolve))
    )
    await Promise.resolve()
    const generation = controller.transitionSnapshot().generation

    expect(
      controller.setTransitionStage(window, generation, PRESENTATION_STAGES.CONTENT_ENTER)
    ).toBe(false)
    expect(
      controller.setTransitionStage(window, generation, PRESENTATION_STAGES.SHELL_TRANSFORM)
    ).toBe(true)
    expect(controller.transitionSnapshot().stage).toBe(PRESENTATION_STAGES.SHELL_TRANSFORM)
    expect(
      controller.setTransitionStage(window, generation, PRESENTATION_STAGES.CONTENT_EXIT)
    ).toBe(false)
    expect(
      controller.setTransitionStage(window, generation, PRESENTATION_STAGES.SHELL_TRANSFORM)
    ).toBe(true)
    expect(
      controller.setTransitionStage(window, generation, PRESENTATION_STAGES.CONTENT_ENTER)
    ).toBe(true)
    expect(
      controller.setTransitionStage(window, generation, PRESENTATION_STAGES.SHELL_TRANSFORM)
    ).toBe(false)
    expect(controller.transitionSnapshot().stage).toBe(PRESENTATION_STAGES.CONTENT_ENTER)
    expect(controller.setTransitionStage(window, generation + 1, 'content-exit')).toBe(false)

    release({ success: true })
    await pending
  })

  it('coalesces duplicate requests into the active native transaction', async () => {
    const window = createWindow()
    const controller = new CompactWindowController()
    controller.initializeForWindow(window, 'expanded')
    let resolveNative
    const executor = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveNative = resolve
        })
    )
    const metadata = {
      from: { x: 0, y: 0, width: 480, height: 720 },
      target: { x: 60, y: 0, width: 360, height: 76 },
      duration: 440,
      phase: 'collapsing'
    }

    const first = controller.run(window, metadata, executor)
    const second = controller.run(window, metadata, executor)
    expect(second).toBe(first)
    expect(executor).toHaveBeenCalledTimes(0)
    await Promise.resolve()
    expect(executor).toHaveBeenCalledTimes(1)
    resolveNative({ success: true })
    await expect(first).resolves.toMatchObject({ status: TRANSITION_STATUSES.COMPLETED })
  })

  it('reports native failure without mutating window geometry', async () => {
    const window = createWindow()
    const onError = vi.fn()
    const controller = new CompactWindowController({ onError })
    controller.initializeForWindow(window, 'compact')
    const failure = new Error('native transition failed')

    const result = await controller.run(
      window,
      {
        from: { x: 10, y: 10, width: 360, height: 76 },
        target: { x: 0, y: 0, width: 480, height: 720 },
        duration: 440,
        phase: 'expanding'
      },
      () => Promise.reject(failure)
    )

    expect(result.status).toBe(TRANSITION_STATUSES.FAILED)
    expect(result.error).toBe(failure)
    expect(onError).toHaveBeenCalledWith(failure, expect.any(Object))
    expect(controller.setPhase(window, 'compact')).toBe(true)
  })

  it('refuses to replace a window while native composition still owns its HWND', async () => {
    const oldWindow = createWindow()
    const nextWindow = createWindow()
    const controller = new CompactWindowController()
    controller.initializeForWindow(oldWindow, 'expanded')
    let resolveNative
    const pending = controller.run(
      oldWindow,
      {
        from: { x: 0, y: 0, width: 480, height: 720 },
        target: { x: 60, y: 0, width: 360, height: 76 },
        duration: 440,
        phase: 'collapsing'
      },
      () =>
        new Promise((resolve) => {
          resolveNative = resolve
        })
    )
    await Promise.resolve()

    expect(() => controller.initializeForWindow(nextWindow, 'compact')).toThrow(
      '原生窗口过渡尚未结束'
    )
    expect(() => controller.cancelForWindowReplacement(oldWindow)).toThrow('原生窗口过渡尚未结束')
    resolveNative({ success: true })
    await pending
    expect(controller.cancelForWindowReplacement(oldWindow)?.status).toBe(
      TRANSITION_STATUSES.WINDOW_REPLACED
    )
    expect(controller.initializeForWindow(nextWindow, 'compact').phase).toBe('compact')
  })
})
