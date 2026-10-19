import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowGeometryPersistence } from '../src/main/windows/window-geometry-persistence.js'

const visible = { x: 30, y: 40, width: 400, height: 800 }
function fixture() {
  vi.useFakeTimers()
  let windowBounds = { ...visible }
  let dockBounds = null
  let dockSuppressed = false
  let allowed = true
  let destroyed = false
  const persistValues = vi.fn()
  const persistStoredBounds = vi.fn()
  const onError = vi.fn()
  const window = { isDestroyed: () => destroyed, getBounds: () => ({ ...windowBounds }) }
  const owner = createWindowGeometryPersistence({
    getWindow: () => window,
    canSchedule: () => allowed,
    isDockSuppressed: () => dockSuppressed,
    readDockBounds: () => dockBounds,
    persistValues,
    persistStoredBounds,
    onError
  })
  return {
    owner,
    persistValues,
    persistStoredBounds,
    onError,
    move: (bounds) => {
      windowBounds = bounds
    },
    dock: (bounds) => {
      dockBounds = bounds
    },
    suppressDock: () => {
      dockSuppressed = true
    },
    disallow: () => {
      allowed = false
    },
    destroy: () => {
      destroyed = true
    }
  }
}
const values = (bounds) => [bounds.x, bounds.y, bounds.width, bounds.height]
afterEach(() => vi.useRealTimers())

describe('ordinary geometry persistence owner', () => {
  it('debounces to the latest visible bounds and commits exactly once', () => {
    const f = fixture()
    f.owner.schedule()
    vi.advanceTimersByTime(400)
    f.move({ ...visible, x: 50 })
    f.owner.schedule()
    vi.advanceTimersByTime(499)
    expect(f.persistValues).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(f.persistValues).toHaveBeenCalledTimes(1)
    expect(f.persistValues.mock.calls[0][0].map((e) => e.value)).toEqual([50, 40, 400, 800])
    expect(f.owner.isDirty()).toBe(false)
  })
  it('uses frozen dock bounds rather than an off-screen animation frame on flush', () => {
    const f = fixture()
    f.owner.schedule()
    f.dock(visible)
    f.move({ ...visible, x: 2000 })
    expect(f.owner.flush()).toBe(true)
    expect(f.persistStoredBounds.mock.calls[0][0].map((e) => e.value)).toEqual(values(visible))
    vi.advanceTimersByTime(500)
    expect(f.persistValues).not.toHaveBeenCalled()
  })
  it('reset cancellation leaves no delayed write and suppression ignores programmatic resize', () => {
    const f = fixture()
    f.owner.schedule()
    f.owner.cancel()
    f.owner.markSaved()
    f.owner.suppressUntil(Date.now() + 750)
    f.move({ ...visible, width: 700 })
    f.owner.schedule()
    vi.advanceTimersByTime(750)
    expect(f.persistValues).not.toHaveBeenCalled()
    expect(f.owner.flush()).toBe(false)
    f.owner.schedule()
    vi.advanceTimersByTime(500)
    expect(f.persistValues).toHaveBeenCalledTimes(1)
  })
  it('does not schedule compact/navigation state or write after a destroyed window', () => {
    const f = fixture()
    f.disallow()
    f.owner.schedule()
    expect(f.owner.isDirty()).toBe(false)
    const live = fixture()
    live.owner.schedule()
    live.destroy()
    vi.advanceTimersByTime(500)
    expect(live.persistValues).not.toHaveBeenCalled()
    expect(live.owner.readPendingBounds()).toBeNull()
  })
  it('retains dirty geometry when a timer is suppressed or a write fails', () => {
    const suppressed = fixture()
    suppressed.owner.schedule()
    suppressed.suppressDock()
    vi.advanceTimersByTime(500)
    expect(suppressed.owner.isDirty()).toBe(true)
    expect(suppressed.persistValues).not.toHaveBeenCalled()
    const failed = fixture()
    failed.persistValues.mockImplementationOnce(() => {
      throw new Error('disk failure')
    })
    failed.owner.schedule()
    vi.advanceTimersByTime(500)
    expect(failed.onError).toHaveBeenCalledTimes(1)
    expect(failed.owner.isDirty()).toBe(true)
    failed.owner.schedule()
    vi.advanceTimersByTime(500)
    expect(failed.owner.isDirty()).toBe(false)
  })
  it('updates normalized stable bounds only after the repository commit succeeds', () => {
    const f = fixture()
    f.owner.setStableBounds(visible)
    f.owner.markDirty()
    f.persistStoredBounds.mockImplementationOnce(() => {
      throw new Error('SQL failed')
    })
    expect(() => f.owner.persistStableBounds({ ...visible, x: 55.6 })).toThrow('SQL failed')
    expect(f.owner.getStableBounds()).toEqual(visible)
    expect(f.owner.isDirty()).toBe(true)
    expect(f.owner.persistStableBounds({ ...visible, x: 55.6 }).x).toBe(56)
    expect(f.owner.isDirty()).toBe(false)
    const snapshot = f.owner.getStableBounds()
    snapshot.x = 999
    expect(f.owner.getStableBounds().x).toBe(56)
  })
  it('keeps pending data for retry after failed shutdown flush', () => {
    const f = fixture()
    f.owner.schedule()
    f.persistStoredBounds.mockImplementationOnce(() => {
      throw new Error('write failed')
    })
    expect(() => f.owner.flush()).toThrow('write failed')
    expect(f.owner.readPendingBounds()).toEqual(visible)
    expect(f.owner.flush()).toBe(true)
    expect(f.owner.flush()).toBe(false)
  })
})
