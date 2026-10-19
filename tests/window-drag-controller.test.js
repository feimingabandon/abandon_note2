import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowDragController } from '../src/main/windows/window-drag-controller.js'
import { createWindowDragCoordinates } from '../src/main/windows/window-drag-coordinates.js'
import { installRendererRecovery } from '../src/main/windows/renderer-recovery.js'

function fixture(extras = {}) {
  let locked = false
  let compact = false
  let bounds = { x: 100, y: 100, width: 400, height: 600 }
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getBounds: () => ({ ...bounds }),
    getContentBounds: () => ({ ...bounds }),
    webContents: Object.assign(new EventEmitter(), { reload: vi.fn() })
  })
  const ports = {
    getMainWindow: () => window,
    isWindowLocked: () => locked,
    isCompactPresentationActive: () => compact,
    getPresentationMode: () => 'expanded',
    getZOrderMode: () => 'bottom',
    captureTitlebarZOrderStatus: () => ({ enabled: true, anchored: true }),
    captureMotionBounds: vi.fn(() => ({ ...bounds, coordinateSpace: 'physical' })),
    movePosition: vi.fn((position) => {
      bounds = { ...bounds, ...position }
    }),
    suspendDock: vi.fn(),
    resumeDock: vi.fn(),
    scheduleGeometry: vi.fn(),
    reassertBottomWindowZOrder: vi.fn(),
    dipBoundsToPhysical: vi.fn((_window, rectangle) => ({ ...rectangle })),
    resolvedDragPoint: (point) => point,
    logger: { info: vi.fn(), error: vi.fn() },
    ...extras
  }
  const controller = createWindowDragController(ports)
  return {
    controller,
    ports,
    window,
    lock: (value) => {
      locked = value
    },
    compact: (value) => {
      compact = value
    }
  }
}

afterEach(() => vi.useRealTimers())

describe('WindowDragController ownership', () => {
  it('releases a crashed renderer drag exactly once and admits another ordinary drag', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { controller, ports, window } = fixture()
    installRendererRecovery(window, {
      logger: ports.logger,
      dialog: {},
      restart: vi.fn(),
      onRendererReset: (reason) => controller.end({ reason })
    })
    expect(controller.begin({ x: 120, y: 120 })).toBe(true)
    controller.update({ x: 140, y: 160 })
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(controller.snapshot()).toMatchObject({ active: false, suspended: false })
    expect(ports.resumeDock).toHaveBeenCalledOnce()
    expect(ports.scheduleGeometry).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(350)
    expect(window.webContents.reload).toHaveBeenCalledOnce()
    window.webContents.emit('did-start-navigation', {}, 'file:///index.html', false, true)
    expect(ports.resumeDock).toHaveBeenCalledOnce()
    expect(controller.begin({ x: 140, y: 160 })).toBe(true)
    expect(controller.update({ x: 160, y: 180 })).toBe(true)
    controller.end()
    expect(ports.suspendDock).toHaveBeenCalledTimes(2)
    expect(ports.resumeDock).toHaveBeenCalledTimes(2)
  })
  it('cleans a manual main-frame reload even when automatic recovery is disabled', () => {
    const { controller, ports, window } = fixture()
    installRendererRecovery(window, {
      logger: ports.logger,
      dialog: {},
      canRecover: () => false,
      onRendererReset: (reason) => controller.end({ reason })
    })
    controller.begin({ x: 120, y: 120 })
    window.webContents.emit('did-start-navigation', {}, 'file:///iframe.html', false, false)
    window.webContents.emit('did-start-navigation', {}, 'file:///index.html#x', true, true)
    expect(controller.isActive()).toBe(true)
    window.webContents.emit('did-start-navigation', {}, 'file:///index.html', false, true)
    expect(controller.snapshot()).toMatchObject({ active: false, suspended: false })
    expect(ports.resumeDock).toHaveBeenCalledOnce()
    expect(controller.begin({ x: 120, y: 120 })).toBe(true)
    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' })
    expect(controller.isActive()).toBe(false)
    expect(ports.resumeDock).toHaveBeenCalledTimes(2)
  })
  it('correlates calibrated delivery, conversion and actual movement without per-update logs', () => {
    let time = 100
    const policy = {
      mode: 'deep',
      captureId: 'capture-a',
      policyEpoch: 1,
      expiresAt: Date.now() + 600000
    }
    const emit = vi.fn()
    const f = fixture({
      motionDiagnosticState: { get: () => policy, subscribe: () => () => {} },
      emitMotionDiagnostics: emit,
      monotonic: () => time,
      epochNow: () => 10000 + time
    })
    const begin = f.controller.begin(
      { x: 120, y: 120 },
      { dragId: 'drag-a', motionClock: { version: 1, sentAt: 10000 } }
    )
    expect(begin).toMatchObject({ started: true, diagnosticClock: { mainReceivedAt: 10100 } })
    f.ports.movePosition.mockImplementation((position) => {
      time += 20
      return position
    })
    expect(
      f.controller.update(
        { x: 150, y: 160 },
        {
          version: 1,
          dragId: 'drag-a',
          captureId: 'capture-a',
          seq: 1,
          sentAt: 10050,
          clockOffsetLowMs: 10,
          clockOffsetHighMs: 20
        }
      )
    ).toBe(true)
    expect(emit).not.toHaveBeenCalled()
    f.controller.end({ reason: 'pointerup' })
    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0][0].metadata).toMatchObject({
      dragId: 'drag-a',
      counters: { receivedUpdates: 1 },
      stages: {
        deliveryLowerBound: { maxMs: 30 },
        deliveryUpperBound: { maxMs: 40 },
        moveAndValidation: { maxMs: 20 }
      },
      slowSamples: [{ seq: 1, positionErrorPx: 0 }]
    })
  })
  it('keeps successful moves and Dock release when diagnostic clocks or sinks fail', () => {
    const f = fixture({
      motionDiagnosticState: {
        get: () => ({ mode: 'deep', captureId: 'capture-a', expiresAt: Date.now() + 600000 }),
        subscribe: () => () => {}
      },
      monotonic: () => {
        throw Error('clock failed')
      },
      epochNow: () => {
        throw Error('epoch failed')
      },
      emitMotionDiagnostics: () => {
        throw Error('sink failed')
      }
    })
    expect(
      f.controller.begin({ x: 120, y: 120 }, { motionClock: { version: 1, sentAt: 100 } })
    ).toBe(true)
    expect(f.controller.update({ x: 150, y: 160 })).toBe(true)
    expect(f.controller.end()).toBe(true)
    expect(f.ports.resumeDock).toHaveBeenCalledOnce()
    expect(f.ports.logger.error).not.toHaveBeenCalled()
  })
  it('rejects locked/compact/capture-failed starts before acquiring Dock suspension', () => {
    const { controller, ports, lock, compact } = fixture()
    lock(true)
    expect(controller.begin({ x: 120, y: 120 })).toBe(false)
    lock(false)
    compact(true)
    expect(controller.begin({ x: 120, y: 120 })).toBe(false)
    compact(false)
    ports.captureMotionBounds.mockImplementation(() => {
      throw Error('native capture')
    })
    expect(controller.begin({ x: 120, y: 120 })).toBe(false)
    expect(ports.suspendDock).not.toHaveBeenCalled()
    expect(controller.isActive()).toBe(false)
  })
  it('moves with the frozen origin and size, then releases exactly once before saving geometry', () => {
    const { controller, ports } = fixture()
    expect(controller.begin({ x: 120, y: 120 }, { dragId: 'drag-a' })).toBe(true)
    expect(controller.begin({ x: 120, y: 120 })).toBe(false)
    expect(controller.update({ x: 150, y: 160 })).toBe(true)
    expect(ports.dipBoundsToPhysical).toHaveBeenCalledWith(expect.any(Object), {
      x: 130,
      y: 140,
      width: 400,
      height: 600
    })
    expect(ports.movePosition).toHaveBeenCalledWith(
      expect.objectContaining({ x: 130, y: 140 }),
      expect.objectContaining({
        expectedSize: { width: 400, height: 600 },
        expectedElectronContentSize: { width: 400, height: 600 }
      })
    )
    expect(controller.update({ x: 150, y: 160 })).toBe(false)
    expect(controller.end({ reason: 'pointerup' })).toBe(true)
    expect(controller.end()).toBe(false)
    expect(controller.snapshot()).toMatchObject({ active: false, suspended: false })
    expect(ports.resumeDock).toHaveBeenCalledOnce()
    expect(ports.scheduleGeometry).toHaveBeenCalledOnce()
    expect(ports.resumeDock.mock.invocationCallOrder[0]).toBeLessThan(
      ports.scheduleGeometry.mock.invocationCallOrder[0]
    )
    expect(ports.reassertBottomWindowZOrder).toHaveBeenCalledOnce()
  })
  it('logs one movement failure per ticket and leaves cancellation able to release suspension', () => {
    const { controller, ports } = fixture()
    controller.begin({ x: 120, y: 120 })
    ports.movePosition.mockImplementation(() => {
      throw Error('native move')
    })
    expect(controller.update({ x: 150, y: 160 })).toBe(false)
    expect(controller.update({ x: 160, y: 170 })).toBe(false)
    expect(ports.logger.error).toHaveBeenCalledOnce()
    controller.end({ reason: 'cancelled' })
    expect(ports.resumeDock).toHaveBeenCalledOnce()
    expect(ports.scheduleGeometry).not.toHaveBeenCalled()
  })
  it('only releases a ticket for its actual host window', () => {
    const { controller, ports, window } = fixture()
    controller.begin({ x: 120, y: 120 })
    expect(controller.releaseWindow({})).toBe(false)
    expect(controller.isActive()).toBe(true)
    expect(controller.releaseWindow(window)).toBe(true)
    expect(controller.releaseWindow(window)).toBe(false)
    expect(ports.resumeDock).toHaveBeenCalledOnce()
  })
  it('uses one screen rectangle conversion and a cursor fallback for invalid input', () => {
    const screen = {
      dipToScreenRect: vi.fn((_window, bounds) => bounds),
      getCursorScreenPoint: vi.fn(() => ({ x: 20, y: 30 }))
    }
    const coords = createWindowDragCoordinates(screen)
    expect(coords.resolvedDragPoint({ x: 12.5, y: 14.3 })).toEqual({ x: 13, y: 14 })
    expect(coords.resolvedDragPoint({ x: NaN })).toEqual({ x: 20, y: 30 })
    const bounds = { x: 5, y: 5, width: 100, height: 50 }
    const window = {}
    expect(coords.dipBoundsToPhysical(window, bounds)).toEqual(bounds)
    expect(screen.dipToScreenRect).toHaveBeenCalledOnce()
    expect(screen.dipToScreenRect).toHaveBeenCalledWith(window, bounds)
  })
})
