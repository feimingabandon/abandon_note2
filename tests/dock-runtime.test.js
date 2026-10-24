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
  let visible = true
  let locked = false
  Object.assign(window, {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
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
    createDockPlan: vi.fn((side) => ({
      coordinateSpace: 'dip',
      initial: { ...bounds },
      expectedSize: { width: bounds.width, height: bounds.height },
      visibleX: side === 'right' ? workArea.width - bounds.width : 0,
      visibleY: bounds.y,
      hiddenX: side === 'right' ? workArea.width + 4 : -bounds.width - 4,
      hiddenY: bounds.y,
      workArea: { left: 0, top: 0, right: 1600, bottom: 1000 },
      overshoot: 4
    })),
    armEdgeMonitor: vi.fn((side, generation) => {
      status = { ...status, workerAlive: true, side, generation, state: 'armed' }
      return { success: true }
    }),
    disarmEdgeMonitor: vi.fn((generation) => {
      if (!generation || generation === status.generation) {
        status = { ...status, workerAlive: false, state: 'idle' }
        // The native successful stop joins the worker and clears its event queue.
        event = null
      }
      return true
    }),
    showPersistentHandle: vi.fn(() => ({ success: true })),
    setPersistentHandlePosition: vi.fn(() => ({ success: true }))
  }
  let settings = createDefaultSettings()
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
    isWindowLocked: () => locked,
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
    setVisible: (value) => {
      visible = value
    },
    setLocked: (value) => {
      locked = value
    },
    setSettings: (value) => {
      settings = value
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
  it('retires capture-period events before their deferred hook consumes them', async () => {
    vi.useFakeTimers()
    const { runtime, window, backend, emitNative } = setup()
    runtime.doHide()
    await vi.advanceTimersByTimeAsync(250)
    runtime.beginDockInteractionSuspension('screenshot', { preserveHidden: true })
    const hidden = window.getBounds()
    emitNative({ kind: 'trigger', generation: 1, side: 'left' })
    runtime.endDockInteractionSuspension('screenshot')
    await vi.advanceTimersByTimeAsync(250)
    expect(runtime.hidden).toBe(true)
    expect(window.getBounds()).toEqual(hidden)
    expect(backend.armEdgeMonitor).toHaveBeenCalledTimes(2)
    emitNative({ kind: 'trigger', generation: 1, side: 'left' })
    await vi.advanceTimersByTimeAsync(250)
    expect(runtime.hidden).toBe(false)
  })
  it.each([0, 250])(
    'keeps a hidden window off-screen during capture after %i ms',
    async (elapsed) => {
      vi.useFakeTimers()
      const { runtime, window, backend, emitNative } = setup()
      runtime.doHide()
      await vi.advanceTimersByTimeAsync(elapsed)
      runtime.beginDockInteractionSuspension('screenshot', { preserveHidden: true })
      expect(runtime.hidden).toBe(true)
      expect(runtime.sliding).toBe(false)
      const hidden = window.getBounds()
      expect(hidden.x + hidden.width).toBeLessThanOrEqual(0)
      emitNative({ kind: 'trigger', generation: 1, side: 'left' })
      await vi.advanceTimersByTimeAsync(250)
      expect(window.getBounds()).toEqual(hidden)
      expect(backend.disarmEdgeMonitor).not.toHaveBeenCalled()
      runtime.endDockInteractionSuspension('screenshot')
      expect(backend.disarmEdgeMonitor).toHaveBeenCalledWith(1)
      expect(backend.armEdgeMonitor).toHaveBeenCalledTimes(2)
      expect(backend.showPersistentHandle).toHaveBeenCalledTimes(2)
      expect(window.getBounds()).toEqual(hidden)
      expect(runtime.hidden).toBe(true)
      emitNative({ kind: 'trigger', generation: 1, side: 'left' })
      await vi.advanceTimersByTimeAsync(250)
      expect(runtime.hidden).toBe(false)
      expect(window.getBounds().x).toBe(0)
    }
  )
  it('resumes a consumed capture trigger only after the last suspension and fails open if rearm fails', async () => {
    vi.useFakeTimers()
    const { runtime, window, backend, emitNative } = setup()
    runtime.doHide()
    await vi.advanceTimersByTimeAsync(250)
    runtime.beginDockInteractionSuspension('screenshot', { preserveHidden: true })
    runtime.beginDockInteractionSuspension('nested-capture', { preserveHidden: true })
    emitNative({ kind: 'trigger', generation: 1, side: 'left' })
    await vi.advanceTimersByTimeAsync(1)
    runtime.endDockInteractionSuspension('nested-capture')
    expect(backend.armEdgeMonitor).toHaveBeenCalledTimes(1)
    backend.armEdgeMonitor.mockReturnValueOnce({ success: false, error: 'rearm failed' })
    runtime.endDockInteractionSuspension('screenshot')
    expect(runtime.hidden).toBe(false)
    expect(window.getBounds().x).toBe(0)
    expect(runtime.hasSession()).toBe(false)
  })
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

describe('Dock saved configuration apply results', () => {
  it('preserves legacy config and side returns while explicit apply confirms an unchanged config', () => {
    const { runtime, window, backend } = setup()
    const previousConfig = runtime.getDockRuntimeConfig()
    window.setBounds({ ...window.getBounds(), x: 8 })
    backend.createDockPlan.mockClear()
    expect(runtime.reconcileDockRuntimeConfig(previousConfig)).toEqual(previousConfig)
    expect(backend.createDockPlan).not.toHaveBeenCalled()
    expect(runtime.applyDockRuntimeConfig(previousConfig)).toEqual({ status: 'applied' })
    expect(backend.createDockPlan).toHaveBeenCalledWith('left', 4)
    expect(backend.moveTo).toHaveBeenCalledOnce()
    expect(window.getBounds().x).toBe(0)
    expect(runtime.syncVisibleDockSide()).toBe('left')
  })

  it('retries the same saved config with a new native plan instead of trusting equal config or side', () => {
    const { runtime, window, backend, persistSettingValues } = setup()
    window.setBounds({ ...window.getBounds(), x: 9 })
    backend.createDockPlan.mockClear()
    expect(runtime.retryDockRuntimeConfig()).toEqual({ status: 'applied' })
    expect(backend.createDockPlan).toHaveBeenCalledOnce()
    expect(backend.moveTo).toHaveBeenCalledWith(0, 120, { width: 400, height: 600 })
    expect(window.getBounds().x).toBe(0)
    expect(persistSettingValues).not.toHaveBeenCalled()
    backend.createDockPlan.mockClear()
    backend.moveTo.mockClear()
    expect(runtime.retryDockRuntimeConfig()).toEqual({ status: 'applied' })
    expect(backend.createDockPlan).toHaveBeenCalledOnce()
    expect(backend.moveTo).not.toHaveBeenCalled()
  })

  it('reports a swallowed snap exception and retries using the subsequently saved config', () => {
    const { runtime, window, backend, setSettings, persistSettingValues } = setup()
    const failure = new Error('native snap rejected')
    const previousConfig = runtime.getDockRuntimeConfig()
    backend.createDockPlan.mockImplementationOnce(() => {
      throw failure
    })
    expect(runtime.applyDockRuntimeConfig(previousConfig)).toEqual({
      status: 'failed',
      error: failure,
      retryable: true
    })
    expect(runtime.side).toBe(null)
    const currentSaved = createDefaultSettings()
    currentSaved.dock.enabledEdges = ['right']
    currentSaved.dock.revealHandleMode = 'direct'
    setSettings(currentSaved)
    window.setBounds({ ...window.getBounds(), x: 1192 })
    backend.createDockPlan.mockClear()
    expect(runtime.retryDockRuntimeConfig('after-current-save')).toEqual({ status: 'applied' })
    expect(backend.createDockPlan).toHaveBeenCalledWith('right', 4)
    expect(window.getBounds().x).toBe(1200)
    expect(runtime.getDockRuntimeConfig()).toMatchObject({
      revealHandleMode: 'direct',
      activeEdges: ['right']
    })
    expect(persistSettingValues).not.toHaveBeenCalled()
  })

  it('rejects an old config payload rather than replaying it as a retry', () => {
    const { runtime, backend } = setup()
    backend.createDockPlan.mockClear()
    expect(runtime.retryDockRuntimeConfig(runtime.getDockRuntimeConfig())).toMatchObject({
      status: 'failed',
      error: expect.any(TypeError),
      retryable: false
    })
    expect(backend.createDockPlan).not.toHaveBeenCalled()
  })

  it.each(['hidden', 'compact', 'locked', 'suspended'])(
    'defers a %s retry without showing, moving or arming the window',
    (state) => {
      const { runtime, window, backend, setVisible, setCompact, setLocked } = setup()
      if (state === 'hidden') setVisible(false)
      if (state === 'compact') setCompact(true)
      if (state === 'locked') setLocked(true)
      if (state === 'suspended') runtime.beginDockInteractionSuspension('test-capture')
      backend.createDockPlan.mockClear()
      expect(runtime.retryDockRuntimeConfig()).toMatchObject({
        status: 'deferred',
        retryable: true
      })
      expect(backend.createDockPlan).not.toHaveBeenCalled()
      expect(backend.moveTo).not.toHaveBeenCalled()
      expect(backend.armEdgeMonitor).not.toHaveBeenCalled()
      expect(window.showInactive).not.toHaveBeenCalled()
    }
  )

  it('leaves an active hidden session and a user-hidden window under their original owners', async () => {
    vi.useFakeTimers()
    const { runtime, window, backend, settings, setVisible } = setup()
    runtime.doHide()
    expect(runtime.sliding).toBe(true)
    const generation = runtime.getDockDiagnosticSnapshot().session.generation
    backend.moveTo.mockClear()
    backend.disarmEdgeMonitor.mockClear()
    expect(runtime.retryDockRuntimeConfig()).toMatchObject({ status: 'deferred' })
    expect(runtime.hasSession()).toBe(true)
    expect(runtime.sliding).toBe(true)
    expect(backend.moveTo).not.toHaveBeenCalled()
    expect(backend.disarmEdgeMonitor).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    setVisible(false)
    settings.dock.enabledEdges = ['right']
    backend.moveTo.mockClear()
    expect(runtime.retryDockRuntimeConfig()).toMatchObject({ status: 'deferred' })
    expect(runtime.hidden).toBe(true)
    expect(runtime.getDockDiagnosticSnapshot().session.generation).toBe(generation)
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(backend.moveTo).not.toHaveBeenCalled()
    expect(backend.disarmEdgeMonitor).not.toHaveBeenCalled()
    expect(backend.armEdgeMonitor).toHaveBeenCalledOnce()
  })

  it('keeps changed-config fail-open recovery in apply while respecting the legacy config return', async () => {
    vi.useFakeTimers()
    const { runtime, backend, settings } = setup()
    const previousConfig = runtime.getDockRuntimeConfig()
    runtime.doHide()
    await vi.advanceTimersByTimeAsync(250)
    settings.dock.enabledEdges = ['right']
    expect(runtime.applyDockRuntimeConfig(previousConfig)).toEqual({ status: 'applied' })
    expect(runtime.hasSession()).toBe(false)
    expect(runtime.hidden).toBe(false)
    expect(backend.disarmEdgeMonitor).toHaveBeenCalledWith(1)
    expect(backend.armEdgeMonitor).toHaveBeenCalledOnce()
    expect(runtime.reconcileDockRuntimeConfig(previousConfig)).toEqual(
      runtime.getDockRuntimeConfig()
    )
  })

  it('retries cleanup through the existing owner and never arms over an unfinished generation', async () => {
    vi.useFakeTimers()
    const { runtime, backend } = setup()
    runtime.doHide()
    await vi.advanceTimersByTimeAsync(250)
    backend.disarmEdgeMonitor.mockReturnValueOnce(false)
    runtime.doShow('stop-failed')
    expect(runtime.cleanupStatus).toMatchObject({ generation: 1, attempts: 0 })
    backend.disarmEdgeMonitor.mockClear()
    backend.disarmEdgeMonitor.mockReturnValueOnce(false)
    expect(runtime.retryDockRuntimeConfig()).toMatchObject({ status: 'deferred', retryable: true })
    expect(runtime.cleanupStatus).toMatchObject({ generation: 1, attempts: 1 })
    expect(backend.disarmEdgeMonitor).toHaveBeenCalledOnce()
    expect(backend.disarmEdgeMonitor).toHaveBeenCalledWith(1)
    expect(backend.armEdgeMonitor).toHaveBeenCalledOnce()
    expect(runtime.resourceSnapshot().cleanupTimer).toBe(true)
    expect(runtime.retryDockRuntimeConfig()).toEqual({ status: 'applied' })
    expect(runtime.cleanupStatus).toBe(null)
    expect(backend.disarmEdgeMonitor).toHaveBeenCalledTimes(2)
    expect(backend.armEdgeMonitor).toHaveBeenCalledOnce()
    expect(runtime.resourceSnapshot().cleanupTimer).toBe(false)
  })

  it.each(['away-from-edge', 'disabled-edges'])(
    'confirms a legitimate no-side result for %s without attempting a snap',
    (state) => {
      const { runtime, window, backend, settings } = setup()
      if (state === 'away-from-edge') window.setBounds({ ...window.getBounds(), x: 600 })
      if (state === 'disabled-edges') settings.dock.enabledEdges = []
      backend.createDockPlan.mockClear()
      expect(runtime.retryDockRuntimeConfig()).toEqual({ status: 'applied' })
      expect(runtime.side).toBe(null)
      expect(backend.createDockPlan).not.toHaveBeenCalled()
      expect(backend.moveTo).not.toHaveBeenCalled()
    }
  )

  it('reports a missing backend instead of confirming an artificial no-side result', () => {
    const { runtime, window } = setup()
    runtime.releaseWindow(window)
    expect(runtime.retryDockRuntimeConfig()).toMatchObject({
      status: 'failed',
      error: expect.any(Error),
      retryable: true
    })
  })

  it.each(['unsupported', 'status-read-failed'])(
    'reports native capability %s instead of confirming an artificial no-side result',
    (state) => {
      const { runtime, backend, settings } = setup()
      const message = 'native edge capability unavailable'
      backend.getEdgeMonitorStatus = () => {
        if (state === 'status-read-failed') throw new Error(message)
        return { supported: false, error: message }
      }
      backend.isDockEdgeExposed = () => false
      backend.createDockPlan.mockClear()
      const result = runtime.retryDockRuntimeConfig()
      expect(result).toMatchObject({ status: 'failed', retryable: true })
      expect(result.error.message).toBe(message)
      expect(backend.createDockPlan).not.toHaveBeenCalled()
      settings.dock.enabledEdges = []
      expect(runtime.retryDockRuntimeConfig()).toEqual({ status: 'applied' })
    }
  )

  it.each(['no-display', 'invalid-work-area'])(
    'leaves a %s result unconfirmed even when an earlier valid work area was cached',
    (state) => {
      const { runtime, screen, backend } = setup()
      screen.getDisplayMatching = () =>
        state === 'no-display'
          ? null
          : { workArea: { x: 0, y: 0, width: Number.NaN, height: 1000 } }
      backend.createDockPlan.mockClear()
      expect(runtime.retryDockRuntimeConfig()).toMatchObject({
        status: 'unconfirmed',
        error: expect.any(Error),
        retryable: true
      })
      expect(backend.createDockPlan).not.toHaveBeenCalled()
      expect(backend.moveTo).not.toHaveBeenCalled()
    }
  )

  it.each(['isMinimized', 'isMaximized'])('defers when the window reports %s', (method) => {
    const { runtime, window, backend } = setup()
    window[method] = () => true
    backend.createDockPlan.mockClear()
    expect(runtime.retryDockRuntimeConfig()).toMatchObject({ status: 'deferred', retryable: true })
    expect(backend.createDockPlan).not.toHaveBeenCalled()
    expect(backend.moveTo).not.toHaveBeenCalled()
  })

  it('does not confirm a native move with no observable position and permits a later actual retry', () => {
    const { runtime, window, backend } = setup()
    window.setBounds({ ...window.getBounds(), x: 8 })
    backend.moveTo.mockReturnValueOnce(undefined)
    expect(runtime.retryDockRuntimeConfig()).toMatchObject({
      status: 'unconfirmed',
      error: expect.any(Error),
      retryable: true
    })
    expect(window.getBounds().x).toBe(8)
    expect(runtime.retryDockRuntimeConfig()).toEqual({ status: 'applied' })
    expect(backend.moveTo).toHaveBeenCalledTimes(2)
    expect(window.getBounds().x).toBe(0)
  })

  it('retains the original native move exception in a failed apply result', () => {
    const { runtime, window, backend } = setup()
    window.setBounds({ ...window.getBounds(), x: 8 })
    const failure = new Error('native move rejected')
    backend.moveTo.mockImplementationOnce(() => {
      throw failure
    })
    expect(runtime.applyDockRuntimeConfig(runtime.getDockRuntimeConfig())).toEqual({
      status: 'failed',
      error: failure,
      retryable: true
    })
    expect(runtime.side).toBe(null)
  })

  it('does not treat invalid window geometry as a legitimate no-side result', () => {
    const { runtime, window, backend } = setup()
    window.setBounds({ ...window.getBounds(), x: Number.NaN })
    backend.createDockPlan.mockClear()
    expect(runtime.retryDockRuntimeConfig()).toMatchObject({
      status: 'unconfirmed',
      error: expect.any(Error),
      retryable: true
    })
    expect(backend.createDockPlan).not.toHaveBeenCalled()
    expect(backend.moveTo).not.toHaveBeenCalled()
  })

  it('reports a native position mismatch and an edge-observation exception as failures', () => {
    const { runtime, window, backend } = setup()
    window.setBounds({ ...window.getBounds(), x: 8 })
    backend.moveTo.mockReturnValueOnce({ ...window.getBounds() })
    expect(runtime.retryDockRuntimeConfig()).toMatchObject({ status: 'failed', retryable: true })
    const failure = new Error('edge observation rejected')
    backend.isDockEdgeExposed = () => {
      throw failure
    }
    expect(runtime.retryDockRuntimeConfig()).toEqual({
      status: 'failed',
      error: failure,
      retryable: true
    })
  })

  it('does not restart native work after terminal shutdown', () => {
    const { runtime, backend } = setup()
    runtime.prepareShutdown()
    backend.createDockPlan.mockClear()
    expect(runtime.retryDockRuntimeConfig()).toMatchObject({ status: 'deferred', retryable: false })
    expect(backend.createDockPlan).not.toHaveBeenCalled()
    expect(backend.armEdgeMonitor).not.toHaveBeenCalled()
  })
})
