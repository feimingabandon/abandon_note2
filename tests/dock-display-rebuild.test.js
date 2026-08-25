import { describe, expect, it, vi } from 'vitest'
import {
  resolveFullscreenRebuildHandlePosition,
  stopEdgeMonitorForFullscreenRebuild
} from '../src/main/window-motion/dock-display-rebuild.js'

function createScenario(disarmEdgeMonitor) {
  const backend = { disarmEdgeMonitor }
  const beginNativeEdgeCleanup = vi.fn()
  const emergencyRestoreDock = vi.fn()
  return { backend, beginNativeEdgeCleanup, emergencyRestoreDock }
}

describe('fullscreen dock display rebuild', () => {
  it('adopts the current native committed drag before the old event queue is disarmed', () => {
    const session = {
      generation: 41,
      side: 'top',
      revealHandleMode: 'persistent',
      handlePositionPermille: 250
    }

    expect(
      resolveFullscreenRebuildHandlePosition(session, {
        generation: 41,
        side: 'top',
        mode: 'persistent',
        handlePositionPermille: 734
      })
    ).toBe(734)
  })

  it('does not let another generation, side or reveal mode contaminate the session', () => {
    const persistent = {
      generation: 41,
      side: 'top',
      revealHandleMode: 'persistent',
      handlePositionPermille: 250
    }
    const currentStatus = {
      generation: 41,
      side: 'top',
      mode: 'persistent',
      handlePositionPermille: 734
    }

    expect(
      resolveFullscreenRebuildHandlePosition(
        { ...persistent, revealHandleMode: 'direct' },
        currentStatus
      )
    ).toBeNull()
    expect(
      resolveFullscreenRebuildHandlePosition(
        { ...persistent, revealHandleMode: 'on-touch' },
        currentStatus
      )
    ).toBeNull()
    expect(
      resolveFullscreenRebuildHandlePosition(persistent, {
        ...currentStatus,
        generation: 40
      })
    ).toBe(250)
    expect(
      resolveFullscreenRebuildHandlePosition(persistent, {
        ...currentStatus,
        side: 'left'
      })
    ).toBe(250)
    expect(
      resolveFullscreenRebuildHandlePosition(persistent, {
        ...currentStatus,
        mode: 'on-touch'
      })
    ).toBe(250)
    expect(
      resolveFullscreenRebuildHandlePosition(persistent, {
        ...currentStatus,
        handlePositionPermille: 1001
      })
    ).toBe(250)
  })

  it('accepts both drag endpoints and keeps center unconfigured when no valid position exists', () => {
    const session = {
      generation: 41,
      side: 'left',
      revealHandleMode: 'persistent',
      handlePositionPermille: null
    }
    const status = {
      generation: 41,
      side: 'left',
      mode: 'persistent'
    }

    expect(
      resolveFullscreenRebuildHandlePosition(session, {
        ...status,
        handlePositionPermille: 0
      })
    ).toBe(0)
    expect(
      resolveFullscreenRebuildHandlePosition(session, {
        ...status,
        handlePositionPermille: 1000
      })
    ).toBe(1000)
    expect(
      resolveFullscreenRebuildHandlePosition(session, {
        ...status,
        handlePositionPermille: -1
      })
    ).toBeNull()
  })

  it('continues rebuilding only after the old native monitor stops', () => {
    const scenario = createScenario(vi.fn(() => true))
    expect(
      stopEdgeMonitorForFullscreenRebuild({
        ...scenario,
        generation: 41
      })
    ).toBe(true)
    expect(scenario.beginNativeEdgeCleanup).not.toHaveBeenCalled()
    expect(scenario.emergencyRestoreDock).not.toHaveBeenCalled()
  })

  it('restores safely when disarming the old monitor throws', () => {
    const failure = new Error('native disarm failed')
    const scenario = createScenario(
      vi.fn(() => {
        throw failure
      })
    )

    expect(() =>
      stopEdgeMonitorForFullscreenRebuild({
        ...scenario,
        generation: 42
      })
    ).not.toThrow()
    expect(scenario.beginNativeEdgeCleanup).toHaveBeenCalledWith(
      42,
      scenario.backend,
      'fullscreen-display-rebuild-stop-failed'
    )
    expect(scenario.emergencyRestoreDock).toHaveBeenCalledWith(
      'fullscreen-display-rebuild-stop-failed',
      failure,
      { skipNativeDisarm: true }
    )
  })

  it('uses the same recoverable cleanup path when native disarm times out', () => {
    const scenario = createScenario(vi.fn(() => false))
    expect(
      stopEdgeMonitorForFullscreenRebuild({
        ...scenario,
        generation: 43
      })
    ).toBe(false)
    expect(scenario.beginNativeEdgeCleanup).toHaveBeenCalledWith(
      43,
      scenario.backend,
      'fullscreen-display-rebuild-stop-timeout'
    )
    expect(scenario.emergencyRestoreDock).toHaveBeenCalledWith(
      'fullscreen-display-rebuild-stop-timeout',
      expect.objectContaining({ message: '全屏分辨率变化后停止旧边缘监视器超时' }),
      { skipNativeDisarm: true }
    )
  })
})
