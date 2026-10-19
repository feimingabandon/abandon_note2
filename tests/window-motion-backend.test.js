import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowMotionBackend } from '../src/main/window-motion/index.js'

const state = vi.hoisted(() => ({ edgeMonitor: vi.fn() }))
vi.mock('../src/main/window-motion/native-edge-monitor.js', () => ({
  NativeEdgeMonitor: class {
    constructor(window) {
      state.edgeMonitor(window)
    }
  }
}))
vi.mock('../src/main/bridge/blur_bridge.js', () => ({
  getWindowMotionSnapshot: vi.fn(),
  isWindowDockEdgeExposed: vi.fn(),
  moveWindowPhysical: vi.fn()
}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Windows motion backend admission', () => {
  it.each(['darwin', 'linux'])('refuses %s before creating a native monitor', (platform) => {
    vi.stubGlobal('process', { platform })
    expect(() => createWindowMotionBackend({})).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' })
    )
    expect(state.edgeMonitor).not.toHaveBeenCalled()
  })

  it('gives the Windows window to the native monitor', () => {
    vi.stubGlobal('process', { platform: 'win32' })
    const window = { id: 17 }
    const backend = createWindowMotionBackend(window)
    expect(state.edgeMonitor).toHaveBeenCalledExactlyOnceWith(window)
    expect(backend.isMoving()).toBe(false)
  })
})
