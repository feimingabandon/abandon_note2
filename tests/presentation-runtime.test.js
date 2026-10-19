import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
import { installRendererRecovery } from '../src/main/windows/renderer-recovery.js'
vi.mock('../src/main/bridge/blur_bridge.js', () => ({ setConfig: vi.fn() }))
import { createPresentationRuntime } from '../src/main/windows/presentation-runtime.js'

function fixture() {
  let bounds = { x: 80, y: 100, width: 400, height: 600 }
  let stable = { ...bounds }
  let destroyed = false
  let visible = true
  let currentWindow
  let onResize = () => {}
  let resizeEcho = false
  let hideGeneration = 0
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    getBounds: () => ({ ...bounds }),
    getContentBounds: () => ({ ...bounds }),
    setBounds: vi.fn((value) => {
      if (destroyed) throw Error('window destroyed')
      bounds = { ...value }
      if (resizeEcho) onResize({ ...bounds })
    }),
    setPosition: vi.fn((x, y) => {
      bounds = { ...bounds, x, y }
    }),
    setMinimumSize: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      isLoadingMainFrame: () => false,
      send: vi.fn(),
      reload: vi.fn()
    })
  })
  currentWindow = window
  const settings = createDefaultSettings()
  const workArea = { x: 0, y: 0, width: 1600, height: 1000 }
  const ports = {
    getMainWindow: () => currentWindow,
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getDisplayMatching: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea })
    },
    getSettings: () => settings,
    isWindowLocked: () => false,
    getUserHideGeneration: () => hideGeneration,
    geometryPersistence: {
      persistStableBounds: vi.fn((value) => {
        stable = { ...value }
        return { ...stable }
      }),
      getStableBounds: () => ({ ...stable }),
      setStableBounds: vi.fn((value) => {
        stable = { ...value }
      })
    },
    resolveActiveViewWindowBounds: () => ({ bounds: { ...stable } }),
    restoreDockWindowToVisiblePosition: vi.fn(),
    resetDockState: vi.fn(),
    endTitlebarWindowDrag: vi.fn(),
    beginDockInteractionSuspension: vi.fn(),
    endDockInteractionSuspension: vi.fn(),
    captureMotionBounds: () => ({ ...bounds, coordinateSpace: 'dip' }),
    setDockPosition: vi.fn(),
    dipBoundsToPhysical: (_window, value) => value,
    resolvedDragPoint: (value) => value,
    readBlurState: () => ({ initialized: false, config: { enabled: false } }),
    synchronizePresentationBlur: vi.fn(),
    getZOrderMode: () => 'normal',
    applyWindowZOrder: vi.fn(),
    reassertBottomWindowZOrder: vi.fn(),
    applyResolvedWindowRuntime: vi.fn(),
    reconcileExpandedDisplayGeometry: vi.fn(),
    persistSettingValues: vi.fn((entries) => {
      for (const { id, value } of entries) settings.window[id.split('.')[1]] = value
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }
  const runtime = createPresentationRuntime(ports)
  onResize = runtime.handleResize
  runtime.initialize(window, bounds)
  return {
    runtime,
    ports,
    window,
    workArea,
    setVisible: (value) => {
      visible = value
    },
    hideByUser: () => {
      hideGeneration++
      visible = false
    },
    echoResize: () => {
      resizeEcho = true
    },
    replaceWindow: (value) => {
      currentWindow = value
    },
    destroy: () => {
      destroyed = true
    }
  }
}
afterEach(() => vi.useRealTimers())
async function commitCompact(runtime) {
  const promise = runtime.enterCompactPresentation({ x: 200, y: 200 })
  runtime.acknowledgePresentationRenderer(runtime.presentationModeSnapshot().operation.id)
  await promise
}

describe('Presentation runtime ownership', () => {
  it('releases a compact renderer drag on crash and reload while preserving the compact mode pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { runtime, ports, window } = fixture()
    await commitCompact(runtime)
    installRendererRecovery(window, {
      logger: ports.logger,
      dialog: {},
      onRendererReset: () => runtime.endCompactWindowDrag()
    })
    expect(runtime.beginCompactWindowDrag({ x: 200, y: 200 })).toBe(true)
    expect(runtime.updateCompactWindowDrag({ x: 230, y: 240 })).toBe(true)
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(runtime.resourceSnapshot()).toMatchObject({ dragging: false, suspended: true })
    expect(ports.endDockInteractionSuspension).not.toHaveBeenCalled()
    expect(runtime.beginCompactWindowDrag({ x: 230, y: 240 })).toBe(true)
    window.webContents.emit('did-start-navigation', {}, 'file:///index.html', false, true)
    expect(runtime.resourceSnapshot().dragging).toBe(false)
    expect(runtime.beginCompactWindowDrag({ x: 230, y: 240 })).toBe(true)
    runtime.endCompactWindowDrag()
    const expanding = runtime.exitCompactPresentation()
    runtime.acknowledgePresentationRenderer(runtime.presentationModeSnapshot().operation.id)
    await expanding
    expect(ports.endDockInteractionSuspension).toHaveBeenCalledOnce()
    expect(runtime.resourceSnapshot()).toMatchObject({ dragging: false, suspended: false })
  })
  it.each(['ack', 'timeout'])(
    'does not reveal a window hidden during a pending presentation %s',
    async (completion) => {
      vi.useFakeTimers()
      const { runtime, window, ports, hideByUser } = fixture()
      const pending = runtime.enterCompactPresentation({ x: 200, y: 200 }).catch((error) => error)
      hideByUser()
      if (completion === 'ack')
        runtime.acknowledgePresentationRenderer(runtime.presentationModeSnapshot().operation.id)
      else await vi.advanceTimersByTimeAsync(3001)
      await pending
      expect(window.isVisible()).toBe(false)
      expect(window.show).not.toHaveBeenCalled()
      expect(window.focus).not.toHaveBeenCalled()
      expect(ports.synchronizePresentationBlur).not.toHaveBeenCalled()
    }
  )
  it('keeps a concealed view switch hidden when compact expansion recovery times out', async () => {
    vi.useFakeTimers()
    const { runtime, window, setVisible } = fixture()
    await commitCompact(runtime)
    window.show.mockClear()
    window.focus.mockClear()
    setVisible(false)
    const pending = runtime
      .exitCompactPresentation({ source: 'view-switch', showWhenDone: false })
      .catch((error) => error)
    await vi.advanceTimersByTimeAsync(3001)
    expect((await pending).message).toContain('渲染就绪超时')
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })
  it('fits actual compact bounds to the current work area without changing expanded geometry or preferences', async () => {
    vi.useFakeTimers()
    const { runtime, ports, window, workArea, echoResize } = fixture()
    await commitCompact(runtime)
    ports.persistSettingValues.mockClear()
    window.show.mockClear()
    window.focus.mockClear()
    echoResize()
    Object.assign(workArea, { x: -800, y: -600, width: 300, height: 200 })
    expect(runtime.reconcileDisplayGeometry()).toBe(true)
    const fitted = window.getBounds()
    expect(fitted).toEqual({ x: -680, y: -448, width: 180, height: 48 })
    expect(runtime.isCompact()).toBe(true)
    expect(ports.geometryPersistence.getStableBounds()).toEqual({
      x: 80,
      y: 100,
      width: 400,
      height: 600
    })
    runtime.handleResize(fitted) // A later Electron resize echo must also be ignored.
    await vi.advanceTimersByTimeAsync(301)
    expect(ports.persistSettingValues).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    window.setBounds({ ...fitted, width: 220, height: 70 })
    await vi.advanceTimersByTimeAsync(301)
    expect(ports.persistSettingValues).toHaveBeenCalledExactlyOnceWith([
      { id: 'window.compactWidth', value: 220 },
      { id: 'window.compactHeight', value: 70 }
    ])
    const expanding = runtime.exitCompactPresentation()
    runtime.acknowledgePresentationRenderer(runtime.presentationModeSnapshot().operation.id)
    await expanding
    expect(window.getBounds()).toEqual({ x: -800, y: -600, width: 300, height: 200 })
  })
  it('does not show or resync blur for a hidden compact window during topology recovery', async () => {
    const { runtime, ports, window, workArea, setVisible } = fixture()
    await commitCompact(runtime)
    setVisible(false)
    window.show.mockClear()
    window.focus.mockClear()
    ports.synchronizePresentationBlur.mockClear()
    Object.assign(workArea, { x: -500, y: 0, width: 400, height: 300 })
    runtime.reconcileDisplayGeometry()
    expect(window.getBounds().x).toBe(-280)
    expect(window.isVisible()).toBe(false)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(ports.synchronizePresentationBlur).not.toHaveBeenCalled()
  })
  it('preserves a pending user size when automatic fitting must shrink below the ordinary compact minimum', async () => {
    vi.useFakeTimers()
    const { runtime, ports, window, workArea, echoResize } = fixture()
    await commitCompact(runtime)
    echoResize()
    window.setBounds({ x: 200, y: 200, width: 300, height: 80 })
    Object.assign(workArea, { x: -100, y: -30, width: 100, height: 30 })
    runtime.reconcileDisplayGeometry()
    expect(window.getBounds()).toEqual({ x: -100, y: -30, width: 100, height: 30 })
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(100, 30)
    expect(ports.persistSettingValues).toHaveBeenCalledExactlyOnceWith([
      { id: 'window.compactWidth', value: 300 },
      { id: 'window.compactHeight', value: 80 }
    ])
    runtime.handleResize(window.getBounds())
    await vi.advanceTimersByTimeAsync(301)
    expect(ports.persistSettingValues).toHaveBeenCalledOnce()
    Object.assign(workArea, { x: 0, y: 0, width: 1600, height: 1000 })
    runtime.reconcileDisplayGeometry()
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(180, 48)
    window.setBounds({ x: 100, y: 100, width: 350, height: 90 })
    await vi.advanceTimersByTimeAsync(301)
    expect(ports.persistSettingValues).toHaveBeenLastCalledWith([
      { id: 'window.compactWidth', value: 350 },
      { id: 'window.compactHeight', value: 90 }
    ])
    expect(ports.persistSettingValues).toHaveBeenCalledTimes(2)
  })
  it('settles a deferred display request through the existing expanded fallback after ACK timeout', async () => {
    vi.useFakeTimers()
    const { runtime, ports, window } = fixture()
    const entering = runtime.enterCompactPresentation({ x: 200, y: 200 }).catch((error) => error)
    runtime.reconcileDisplayGeometry({ eventName: 'resume' })
    await vi.advanceTimersByTimeAsync(3001)
    expect((await entering).message).toContain('渲染就绪超时')
    expect(runtime.isCompact()).toBe(false)
    expect(window.getBounds()).toEqual({ x: 80, y: 100, width: 400, height: 600 })
    expect(ports.reconcileExpandedDisplayGeometry).toHaveBeenCalledExactlyOnceWith({
      eventName: 'resume'
    })
    expect(runtime.resourceSnapshot().pendingDisplayRecovery).toBe(false)
  })
  it('coalesces events during ACK waits and routes only a settled expanded mode back to Dock', async () => {
    const { runtime, ports, window, workArea } = fixture()
    const entering = runtime.enterCompactPresentation({ x: 200, y: 200 })
    Object.assign(workArea, { x: -800, y: -600, width: 300, height: 200 })
    runtime.reconcileDisplayGeometry({ eventName: 'display-removed', displayId: 1 })
    runtime.reconcileDisplayGeometry({ eventName: 'resume' })
    expect(window.setBounds).not.toHaveBeenCalled()
    runtime.acknowledgePresentationRenderer(runtime.presentationModeSnapshot().operation.id)
    await entering
    await Promise.resolve()
    expect(runtime.isCompact()).toBe(true)
    expect(window.getBounds().x).toBe(-680)
    expect(ports.reconcileExpandedDisplayGeometry).not.toHaveBeenCalled()
    const expanding = runtime.exitCompactPresentation()
    runtime.reconcileDisplayGeometry({ eventName: 'unlock-screen' })
    runtime.reconcileDisplayGeometry({ eventName: 'display-metrics-changed' })
    runtime.acknowledgePresentationRenderer(runtime.presentationModeSnapshot().operation.id)
    await expanding
    await Promise.resolve()
    expect(ports.reconcileExpandedDisplayGeometry).toHaveBeenCalledExactlyOnceWith({
      eventName: 'display-metrics-changed'
    })
    expect(runtime.resourceSnapshot().pendingDisplayRecovery).toBe(false)
  })
  it('drops deferred topology work after shutdown and release instead of touching a replacement', async () => {
    for (const close of ['shutdown', 'release']) {
      const { runtime, window, destroy, replaceWindow, ports } = fixture()
      const entering = runtime.enterCompactPresentation({ x: 200, y: 200 }).catch((error) => error)
      runtime.reconcileDisplayGeometry({ eventName: 'resume' })
      if (close === 'shutdown') runtime.prepareShutdown()
      else {
        destroy()
        runtime.releaseWindow(window)
        replaceWindow({
          ...window,
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, isLoadingMainFrame: () => false, send: vi.fn() }
        })
      }
      await entering
      await Promise.resolve()
      expect(window.setBounds).not.toHaveBeenCalled()
      expect(ports.reconcileExpandedDisplayGeometry).not.toHaveBeenCalled()
      expect(runtime.resourceSnapshot().pendingDisplayRecovery).toBe(false)
    }
  })
  it('rejects a pending commit and every late ACK after shutdown while the window is still alive', async () => {
    const { runtime, window, ports } = fixture()
    const result = runtime.enterCompactPresentation({ x: 200, y: 200 }).catch((error) => error)
    const id = runtime.presentationModeSnapshot().operation.id
    runtime.prepareShutdown()
    expect(runtime.acknowledgePresentationRenderer(id)).toBe(false)
    expect((await result).message).toContain('退出')
    expect(window.setBounds).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(ports.synchronizePresentationBlur).not.toHaveBeenCalled()
    expect(runtime.resourceSnapshot()).toMatchObject({
      pendingRenderer: 0,
      suspended: false,
      resizeTimer: false
    })
  })
  it('commits on its matching renderer ACK and restores the original expanded bounds', async () => {
    const { runtime, ports, window } = fixture()
    const pending = runtime.enterCompactPresentation({ x: 200, y: 200 })
    const state = runtime.presentationModeSnapshot()
    expect(runtime.acknowledgePresentationRenderer(state.operation.id + 1)).toBe(false)
    expect(window.setBounds).not.toHaveBeenCalled()
    state.operation.targetBounds.x = -5000
    expect(runtime.presentationModeSnapshot().operation.targetBounds.x).not.toBe(-5000)
    runtime.acknowledgePresentationRenderer(state.operation.id)
    await pending
    expect(runtime.isCompact()).toBe(true)
    expect(ports.beginDockInteractionSuspension).toHaveBeenCalledOnce()
    const expanded = runtime.exitCompactPresentation()
    runtime.acknowledgePresentationRenderer(runtime.presentationModeSnapshot().operation.id)
    await expanded
    expect(window.getBounds()).toEqual({ x: 80, y: 100, width: 400, height: 600 })
    expect(ports.endDockInteractionSuspension).toHaveBeenCalledOnce()
    expect(runtime.resourceSnapshot()).toMatchObject({
      suspended: false,
      pendingRenderer: 0,
      acknowledged: 0
    })
  })
  it('persists compact dimensions only and flushes the last resize before shutdown', async () => {
    vi.useFakeTimers()
    const { runtime, ports } = fixture()
    await commitCompact(runtime)
    runtime.handleResize({ x: 300, y: 200, width: 260, height: 70 })
    runtime.handleResize({ x: 310, y: 210, width: 280, height: 72 })
    runtime.prepareShutdown()
    expect(ports.persistSettingValues).toHaveBeenCalledExactlyOnceWith([
      { id: 'window.compactWidth', value: 280 },
      { id: 'window.compactHeight', value: 72 }
    ])
    await vi.advanceTimersByTimeAsync(500)
    expect(ports.persistSettingValues).toHaveBeenCalledOnce()
    expect(runtime.resourceSnapshot()).toMatchObject({
      resizeTimer: false,
      pendingSize: false,
      suspended: false
    })
  })
  it('recovers from ACK timeout with no waiter or Dock suspension left', async () => {
    vi.useFakeTimers()
    const { runtime, ports, window } = fixture()
    const result = runtime.enterCompactPresentation({ x: 200, y: 200 }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(3001)
    expect((await result).message).toContain('渲染就绪超时')
    expect(runtime.presentationModeSnapshot()).toMatchObject({ mode: 'expanded', operation: null })
    expect(window.getBounds()).toEqual({ x: 80, y: 100, width: 400, height: 600 })
    expect(ports.endDockInteractionSuspension).toHaveBeenCalledOnce()
    expect(runtime.resourceSnapshot()).toMatchObject({ pendingRenderer: 0, suspended: false })
  })
  it('releases only its current window while a pending ACK settles to failed expanded state', async () => {
    const { runtime, ports, window, destroy } = fixture()
    const result = runtime.enterCompactPresentation({ x: 200, y: 200 }).catch((error) => error)
    expect(runtime.releaseWindow({})).toBe(false)
    destroy()
    expect(runtime.releaseWindow(window)).toBe(true)
    expect((await result).message).toContain('主窗口已关闭')
    expect(runtime.presentationModeSnapshot()).toMatchObject({ mode: 'expanded', operation: null })
    expect(ports.endDockInteractionSuspension).toHaveBeenCalledOnce()
    expect(runtime.resourceSnapshot()).toMatchObject({
      attached: false,
      pendingRenderer: 0,
      resizeTimer: false,
      suspended: false
    })
  })
})
