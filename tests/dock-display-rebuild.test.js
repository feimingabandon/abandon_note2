import { describe, expect, it, vi } from 'vitest'
import { stopEdgeMonitorForFullscreenRebuild } from '../src/main/window-motion/dock-display-rebuild.js'

function createScenario(disarmEdgeMonitor) {
  const backend = { disarmEdgeMonitor }
  const beginNativeEdgeCleanup = vi.fn()
  const emergencyRestoreDock = vi.fn()
  return { backend, beginNativeEdgeCleanup, emergencyRestoreDock }
}

describe('fullscreen dock display rebuild', () => {
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
