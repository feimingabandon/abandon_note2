import { describe, expect, it, vi } from 'vitest'
import { NativeEdgeMonitor } from '../src/main/window-motion/native-edge-monitor.js'

describe('NativeEdgeMonitor', () => {
  it('tracks one active generation and disarms it idempotently', () => {
    const arm = vi.fn(() => ({ success: true, code: 1, error: null }))
    const disarm = vi.fn(() => true)
    const monitor = new NativeEdgeMonitor(
      {},
      {
        arm,
        disarm,
        getStatus: () => ({ state: 'armed' }),
        consumeEvent: () => null,
        getMessageId: () => 0xc123
      }
    )

    const options = { pollIntervalMs: 50, revealHandleEnabled: true }
    expect(monitor.arm('top', 8, options)).toMatchObject({ success: true })
    expect(arm).toHaveBeenCalledWith({}, 'top', 8, options)
    expect(monitor.arm('top', 9)).toMatchObject({ success: false, code: -8 })
    expect(arm).toHaveBeenCalledOnce()
    expect(monitor.disarm()).toBe(true)
    expect(disarm).toHaveBeenCalledWith(8)
    expect(monitor.activeGeneration).toBe(0)
  })

  it('does not remember a generation when native arm fails', () => {
    const monitor = new NativeEdgeMonitor(
      {},
      {
        arm: () => ({ success: false, code: -3, error: '边缘未暴露' }),
        disarm: () => true,
        getStatus: () => ({ state: 'stopped' }),
        consumeEvent: () => null,
        getMessageId: () => 0xc123
      }
    )

    expect(monitor.arm('top', 3)).toMatchObject({ success: false, code: -3 })
    expect(monitor.activeGeneration).toBe(0)
  })

  it('retains a timed-out startup generation until native cleanup succeeds', () => {
    const disarm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const monitor = new NativeEdgeMonitor(
      {},
      {
        arm: () => ({
          success: false,
          cleanupRequired: true,
          code: -15,
          error: '初始化超时'
        }),
        disarm,
        getStatus: () => ({ state: 'failed' }),
        consumeEvent: () => null,
        getMessageId: () => 0xc123
      }
    )

    expect(monitor.arm('left', 12)).toMatchObject({ success: false, cleanupRequired: true })
    expect(monitor.activeGeneration).toBe(12)
    expect(monitor.disarm()).toBe(false)
    expect(monitor.activeGeneration).toBe(12)
    expect(monitor.disarm()).toBe(true)
    expect(monitor.activeGeneration).toBe(0)
  })
})
