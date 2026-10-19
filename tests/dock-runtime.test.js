import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
vi.mock('../src/main/bridge/blur_bridge.js', () => ({
  updateGeometry: vi.fn(),
  reSyncZOrder: vi.fn()
}))
import { createDockRuntime } from '../src/main/window-motion/dock-runtime.js'

function fixture() {
  let bounds = { x: 0, y: 120, width: 400, height: 600 }
  const workArea = { x: 0, y: 0, width: 1600, height: 1000 }
  const display = { id: 1, workArea, bounds: workArea, scaleFactor: 1 }
  const window = new EventEmitter()
  const hooks = new Map()
  let destroyed = false
  let compact = false
  Object.assign(window, {
    isDestroyed: () => destroyed,
    isVisible: () => true,
    isMinimized: () => false,
    isMaximized: () => false,
    isFocused: () => false,
    getOpacity: () => 1,
    getBounds: () => ({ ...bounds }),
    getContentBounds: () => ({ ...bounds }),
    setBounds: vi.fn((value) => {
      bounds = { ...value }
    }),
    setPosition: vi.fn((x, y) => {
      bounds = { ...bounds, x, y }
    }),
    setAlwaysOnTop: vi.fn(),
    showInactive: vi.fn(),
    hookWindowMessage: vi.fn((id, callback) => hooks.set(id, callback)),
    unhookWindowMessage: vi.fn((id) => hooks.delete(id)),
    webContents: { isDestroyed: () => false, getZoomFactor: () => 1 }
  })
  const screen = new EventEmitter()
  Object.assign(screen, {
    getDisplayMatching: () => display,
    getDisplayNearestPoint: () => display,
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    getCursorScreenPoint: () => ({ x: 1400, y: 800 })
  })
  const powerMonitor = new EventEmitter()
  let status = { supported: true, workerAlive: false, generation: 0, side: null, state: 'idle' }
  let event = null
  const backend = {
    capture: vi.fn(() => ({ ...bounds, coordinateSpace: 'dip' })),
    isMoving: () => false,
    moveTo: vi.fn((x, y) => {
      bounds = { ...bounds, x, y }
      return { ...bounds }
    }),
    isDockEdgeExposed: () => true,
    getEdgeMonitorMessageId: () => 777,
    getEdgeMonitorStatus: () => ({ ...status }),
    consumeEdgeMonitorEvent: () => {
      const value = event
      event = null
      return value
    },
    createDockPlan: () => ({
      coordinateSpace: 'dip',
      initial: { ...bounds },
      expectedSize: { width: bounds.width, height: bounds.height },
      visibleX: 0,
      visibleY: bounds.y,
      hiddenX: -bounds.width - 4,
      hiddenY: bounds.y,
      workArea: { left: 0, top: 0, right: 1600, bottom: 1000 },
      overshoot: 4
    }),
    armEdgeMonitor: vi.fn((side, generation) => {
      status = { ...status, workerAlive: true, side, generation, state: 'armed' }
      return { success: true }
    }),
    disarmEdgeMonitor: vi.fn((generation) => {
      if (!generation || generation === status.generation)
        status = { ...status, workerAlive: false, state: 'idle' }
      return true
    }),
    showPersistentHandle: vi.fn(() => ({ success: true })),
    setPersistentHandlePosition: vi.fn(() => ({ success: true }))
  }
  const settings = createDefaultSettings()
  settings.dock.enabledEdges = ['left']
  settings.dock.revealHandleMode = 'persistent'
  const geometry = {
    getStableBounds: () => ({ x: 0, y: 120, width: 400, height: 600 }),
    setStableBounds: vi.fn(),
    getSuppressionDeadline: () => 0,
    markDirty: vi.fn(),
    markSaved: vi.fn()
  }
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(() => unsubscribe)
  const applyZOrder = vi.fn()
  const persistSettingValues = vi.fn()
  const reconcilePresentationDisplayGeometry = vi.fn()
  const runtime = createDockRuntime({
    getMainWindow: () => window,
    screen,
    powerMonitor,
    getViewMode: () => 'list',
    getActiveWindowProfile: () => ({ supportedDockEdges: ['left', 'right'] }),
    getSettings: () => settings,
    isWindowLocked: () => false,
    isQuitting: () => false,
    isCompactPresentationActive: () => compact,
    reconcilePresentationDisplayGeometry,
    geometryPersistence: geometry,
    persistSettingValues,
    readBlurState: () => ({
      config: { enabled: false },
      initialized: false,
      failed: false,
      diagnostic: {}
    }),
    getZOrderMode: () => 'normal',
    runBlurRuntimeOperation: vi.fn(),
    applyWindowZOrder: applyZOrder,
    reassertBottomWindowZOrder: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    createMotionBackend: () => backend,
    subscribeDiagnosticPolicy: subscribe
  })
  runtime.attachWindow(window)
  runtime.syncVisibleDockSide({ snap: true })
  return {
    runtime,
    window,
    settings,
    backend,
    screen,
    powerMonitor,
    hooks,
    unsubscribe,
    geometry,
    persistSettingValues,
    reconcilePresentationDisplayGeometry,
    setCompact: (value) => {
      compact = value
    },
    emitNative: (value) => {
      event = value
      hooks.get(777)()
    },
    destroy: () => {
      destroyed = true
    },
    applyZOrder
  }
}
const live = []
function setup() {
  const result = fixture()
  live.push(result.runtime)
  return result
}
afterEach(() => {
  for (const runtime of live.splice(0)) runtime.dispose()
  vi.useRealTimers()
})

describe('Dock session ownership', () => {
  it('delegates compact and busy presentation recovery from registered display and power events', async () => {
    vi.useFakeTimers()
    const {
      runtime,
      window,
      screen,
      powerMonitor,
      geometry,
      persistSettingValues,
      reconcilePresentationDisplayGeometry,
      setCompact
    } = setup()
    runtime.attachDockDisplayListeners()
    runtime.attachDockPowerListeners()
    setCompact(true)
    window.setBounds({ x: 100, y: 100, width: 180, height: 48 })
    window.setBounds.mockClear()
    powerMonitor.emit('resume')
    powerMonitor.emit('unlock-screen')
    screen.emit('display-metrics-changed', {}, { id: 1 }, ['scaleFactor'])
    await vi.advanceTimersByTimeAsync(251)
    expect(window.getBounds()).toEqual({ x: 100, y: 100, width: 180, height: 48 })
    expect(reconcilePresentationDisplayGeometry).toHaveBeenCalledTimes(3)
    expect(window.setBounds).not.toHaveBeenCalled()
    expect(window.setPosition).not.toHaveBeenCalled()
    expect(geometry.setStableBounds).not.toHaveBeenCalled()
    expect(persistSettingValues).not.toHaveBeenCalled()
    runtime.prepareShutdown()
    runtime.handleDockDisplayTopologyChange()
    expect(reconcilePresentationDisplayGeometry).toHaveBeenCalledTimes(3)
  })
  it('retains expanded topology recovery and ignores an unavailable window', () => {
    const { runtime, window, destroy, reconcilePresentationDisplayGeometry } = setup()
    window.setBounds({ x: -900, y: -900, width: 250, height: 250 })
    runtime.handleDockDisplayTopologyChange()
    expect(window.getBounds()).toEqual({ x: 0, y: 120, width: 400, height: 600 })
    expect(reconcilePresentationDisplayGeometry).not.toHaveBeenCalled()
    destroy()
    runtime.handleDockDisplayTopologyChange()
    expect(reconcilePresentationDisplayGeometry).not.toHaveBeenCalled()
  })
  it('queues show during hide and restores the native session without activating a persistent handle', async () => {
    vi.useFakeTimers()
    const { runtime, backend, applyZOrder } = setup()
    runtime.doHide()
    expect(runtime.hidden).toBe(true)
    runtime.doShow('while-hiding')
    await vi.advanceTimersByTimeAsync(500)
    expect(runtime.hidden).toBe(false)
    expect(runtime.sliding).toBe(false)
    expect(runtime.hasSession()).toBe(false)
    expect(backend.showPersistentHandle).not.toHaveBeenCalled()
    expect(backend.disarmEdgeMonitor).toHaveBeenCalledWith(1)
    expect(backend.capture().x).toBe(0)
    expect(applyZOrder).toHaveBeenCalled()
  })
  it('owns nested suspension and cancels delayed hides before the callback can run', async () => {
    vi.useFakeTimers()
    const { runtime, backend } = setup()
    runtime.handleHover(false)
    expect(runtime.resourceSnapshot().hideTimer).toBe(true)
    runtime.beginDockInteractionSuspension('capture')
    runtime.beginDockInteractionSuspension('drag')
    await vi.advanceTimersByTimeAsync(250)
    expect(backend.armEdgeMonitor).not.toHaveBeenCalled()
    expect(runtime.suspendCount).toBe(2)
    runtime.endDockInteractionSuspension('capture')
    runtime.doHide()
    expect(backend.armEdgeMonitor).not.toHaveBeenCalled()
    runtime.endDockInteractionSuspension('drag')
    runtime.doHide()
    expect(backend.armEdgeMonitor).toHaveBeenCalledOnce()
  })
  it('rejects a stale native trigger and keeps a handle position session-local', async () => {
    vi.useFakeTimers()
    const { runtime, backend, emitNative } = setup()
    runtime.doHide()
    await vi.advanceTimersByTimeAsync(250)
    emitNative({ kind: 'trigger', generation: 99, side: 'left' })
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.hidden).toBe(true)
    expect(backend.disarmEdgeMonitor).toHaveBeenCalledWith(99)
    emitNative({ kind: 'handle-moved', generation: 1, side: 'left', positionPermille: 720 })
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.getDockDiagnosticSnapshot().session.handlePositionPermille).toBe(720)
    runtime.doShow('test')
    await vi.advanceTimersByTimeAsync(250)
    runtime.syncVisibleDockSide()
    runtime.doHide()
    expect(runtime.getDockDiagnosticSnapshot().session.handlePositionPermille).toBe(null)
    expect(backend.armEdgeMonitor).toHaveBeenLastCalledWith('left', 2, expect.any(Object))
  })
  it('keeps failed disarm cleanup owned and blocks new hides until recovery completes', async () => {
    vi.useFakeTimers()
    const { runtime, backend } = setup()
    runtime.doHide()
    await vi.advanceTimersByTimeAsync(250)
    backend.disarmEdgeMonitor.mockReturnValueOnce(false)
    runtime.doShow('stop-failed')
    expect(runtime.cleanupStatus).toMatchObject({ generation: 1 })
    expect(runtime.hidden).toBe(false)
    runtime.syncVisibleDockSide()
    runtime.doHide()
    expect(backend.armEdgeMonitor).toHaveBeenCalledOnce()
    runtime.runDockHealthCheck()
    expect(runtime.cleanupStatus).toBe(null)
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.side).toBe('left')
  })
  it('installs listeners once and releases hook, policy and all timers on terminal shutdown', async () => {
    vi.useFakeTimers()
    const { runtime, window, screen, powerMonitor, unsubscribe, backend } = setup()
    runtime.attachWindow(window)
    runtime.attachDockDisplayListeners()
    runtime.attachDockDisplayListeners()
    runtime.attachDockPowerListeners()
    runtime.attachDockPowerListeners()
    expect(window.hookWindowMessage).toHaveBeenCalledOnce()
    expect(screen.listenerCount('display-removed')).toBe(1)
    expect(powerMonitor.listenerCount('resume')).toBe(1)
    runtime.handleHover(false)
    screen.emit('display-metrics-changed', {}, { id: 1 }, ['scaleFactor'])
    runtime.prepareShutdown()
    runtime.dispose()
    runtime.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(screen.listenerCount('display-removed')).toBe(0)
    expect(powerMonitor.listenerCount('resume')).toBe(0)
    expect(window.unhookWindowMessage).toHaveBeenCalledOnce()
    expect(runtime.resourceSnapshot()).toMatchObject({
      disposed: true,
      slideTimer: false,
      hideTimer: false,
      geometryTimer: false,
      cleanupTimer: false,
      observer: false
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(backend.armEdgeMonitor).not.toHaveBeenCalled()
  })
})
