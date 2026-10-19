import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
import { createEditingDraftGuard } from '../src/main/windows/editing-draft-guard.js'
import { installRendererRecovery } from '../src/main/windows/renderer-recovery.js'
const repository = vi.hoisted(() => ({ prepare: vi.fn(), write: vi.fn() }))
vi.mock('../src/main/settings/application-settings.js', () => ({
  getViewSettingsScope: (mode) => (mode === 'list' ? 'main' : mode),
  prepareViewSettingsForSwitch: repository.prepare,
  writeActiveView: repository.write
}))
vi.mock('../src/main/db/db-settings-repository.js', () => ({ setSettingsBatch: vi.fn() }))
vi.mock('../src/main/bridge/blur_bridge.js', () => ({ setConfig: vi.fn() }))
vi.mock('../src/main/logging/window-capture.js', () => ({ setWindowLogContext: vi.fn() }))
import { createMainViewNavigation } from '../src/main/windows/main-view-navigation.js'

function fixture({ compact = false, visible = true } = {}) {
  const events = []
  let bounds = { x: 70, y: 80, width: 400, height: 600 }
  let background = false
  let currentMode = 'list'
  let currentWindow
  const window = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    getBounds: () => ({ ...bounds }),
    setBounds: (value) => {
      bounds = { ...value }
      events.push('bounds')
    },
    isVisible: () => visible,
    isFocused: () => visible,
    hide: () => {
      const wasVisible = visible
      visible = false
      events.push('hide')
      if (wasVisible) window.emit('hide')
    },
    show: vi.fn(() => {
      visible = true
      events.push('show')
    }),
    focus: vi.fn(),
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
      isLoadingMainFrame: () => false,
      executeJavaScript: vi.fn()
    })
  })
  currentWindow = window
  const settings = createDefaultSettings()
  const display = {
    id: 1,
    workArea: { x: 0, y: 0, width: 1600, height: 1000 },
    workAreaSize: { width: 1600, height: 1000 },
    scaleFactor: 1
  }
  let nav
  const ports = {
    getMainWindow: () => currentWindow,
    screen: { getPrimaryDisplay: () => display, getDisplayMatching: () => display },
    getSettings: () => settings,
    resetSettingsForView: (mode) => {
      currentMode = mode
      events.push('scope:' + mode)
    },
    refreshResolvedSettings: vi.fn(),
    loadWindow: vi.fn(async (_window, location) => {
      events.push('load:' + location.rendererFile)
      nav.handleRendererReady(window.webContents, currentMode)
    }),
    geometryPersistence: {
      getStableBounds: () => ({ x: 70, y: 80, width: 400, height: 600 }),
      setStableBounds: vi.fn(),
      cancel: vi.fn(),
      readPendingBounds: () => ({ ...bounds }),
      markSaved: vi.fn()
    },
    dockRuntime: {
      cleanupStatus: null,
      readStableSessionBounds: () => null,
      restoreDockWindowToVisiblePosition: () => events.push('dock-visible'),
      resetDockState: () => events.push('dock-reset'),
      setWorkArea: vi.fn()
    },
    isCompactPresentationActive: () => compact,
    exitCompactPresentation: vi.fn(async () => {
      window.hide()
      compact = false
    }),
    endTitlebarWindowDrag: () => events.push('drag-end'),
    openMainWindow: vi.fn(() => window.show()),
    confirmEditingDrafts: vi.fn(async () => true),
    isShutdownCheckingDrafts: () => false,
    isBackgroundInFlight: () => background,
    readBlurState: () => ({
      caps: { supported: false },
      initialized: false,
      config: { enabled: false }
    }),
    initializeBlurRuntime: vi.fn(),
    runBlurRuntimeOperation: vi.fn(),
    applyResolvedWindowRuntime: vi.fn(),
    restoreBlurForVisibleWindow: vi.fn(),
    reassertBottomWindowZOrder: vi.fn(),
    getDockDiagnosticSnapshot: () => ({}),
    revealPendingNotificationApplication: vi.fn(),
    rebuildTrayMenu: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
    rendererRoot: '/renderers',
    isDev: false
  }
  repository.prepare.mockImplementation(() => {
    events.push('source-sql')
    return { geometryPersisted: true }
  })
  repository.write.mockImplementation((mode) => events.push('active-sql:' + mode))
  nav = createMainViewNavigation(ports)
  return {
    nav,
    ports,
    window,
    events,
    replaceWindow: (replacement) => {
      currentWindow = replacement
    },
    setBackground: (value) => {
      background = value
    }
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('MainViewNavigation ownership', () => {
  it.each([false, true])(
    'preserves visibility %s through the real renderer recovery path without focusing',
    async (visible) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { nav, ports, window } = fixture()
      nav.handleRendererReady(window.webContents, 'list')
      if (!visible) {
        nav.noteWindowHiddenByUser(window)
        window.hide()
      }
      window.show.mockClear()
      window.focus.mockClear()
      window.webContents.reload = vi.fn(() => nav.handleRendererReady(window.webContents, 'list'))
      installRendererRecovery(window, {
        logger: ports.logger,
        dialog: {},
        canRecover: () => !nav.isSwitching(),
        restart: vi.fn()
      })
      window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
      await vi.advanceTimersByTimeAsync(350)
      expect(window.webContents.reload).toHaveBeenCalledOnce()
      expect(window.isVisible()).toBe(visible)
      expect(window.show).not.toHaveBeenCalled()
      expect(window.focus).not.toHaveBeenCalled()
    }
  )
  it('honors a user hide after a crash but before renderer recovery finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { nav, ports, window } = fixture()
    nav.handleRendererReady(window.webContents, 'list')
    window.show.mockClear()
    window.focus.mockClear()
    window.webContents.reload = vi.fn(() => nav.handleRendererReady(window.webContents, 'list'))
    installRendererRecovery(window, { logger: ports.logger, dialog: {}, restart: vi.fn() })
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    nav.noteWindowHiddenByUser(window)
    window.hide()
    await vi.advanceTimersByTimeAsync(350)
    expect(window.isVisible()).toBe(false)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })
  it('shows startup once, then leaves manual reloads and duplicate ready messages in place', () => {
    const { nav, window } = fixture({ visible: false })
    nav.handleRendererReady(window.webContents, 'list')
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    nav.noteWindowHiddenByUser(window)
    window.hide()
    nav.handleRendererReady(window.webContents, 'list')
    expect(window.isVisible()).toBe(false)
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })
  it('restores a visible compact source after the real draft guard rejects its first inspection', async () => {
    const { nav, ports, window } = fixture({ compact: true })
    window.webContents.executeJavaScript.mockRejectedValue(Error('draft inspection failed'))
    ports.confirmEditingDrafts.mockImplementation(
      createEditingDraftGuard({ logger: ports.logger, reveal: async () => ports.openMainWindow() })
    )
    expect(await nav.switchMainView('month')).toBe(false)
    expect(window.isVisible()).toBe(true)
    expect(ports.openMainWindow).toHaveBeenCalledOnce()
    expect(ports.loadWindow).not.toHaveBeenCalled()
    expect(nav.snapshot()).toMatchObject({ mode: 'list', pendingReady: null, queuedTarget: null })
  })
  it('restores only once when normal dirty confirmation reveals the source before cancellation', async () => {
    const { nav, ports, window } = fixture({ compact: true })
    ports.confirmEditingDrafts.mockImplementation(async () => {
      ports.openMainWindow()
      return false
    })
    expect(await nav.switchMainView('month')).toBe(false)
    expect(window.isVisible()).toBe(true)
    expect(ports.openMainWindow).toHaveBeenCalledOnce()
  })
  it('refuses native cleanup before concealing compact, and restores cleanup begun during expansion', async () => {
    const first = fixture({ compact: true })
    first.ports.dockRuntime.cleanupStatus = { generation: 3 }
    expect(await first.nav.switchMainView('month')).toBe(false)
    expect(first.ports.exitCompactPresentation).not.toHaveBeenCalled()
    expect(first.window.isVisible()).toBe(true)
    const second = fixture({ compact: true })
    second.ports.exitCompactPresentation.mockImplementation(async () => {
      second.window.hide()
      second.ports.dockRuntime.cleanupStatus = { generation: 4 }
    })
    expect(await second.nav.switchMainView('month')).toBe(false)
    expect(second.window.isVisible()).toBe(true)
    expect(second.ports.loadWindow).not.toHaveBeenCalled()
  })
  it('keeps an initially hidden compact source hidden after refusal', async () => {
    const { nav, ports, window } = fixture({ compact: true, visible: false })
    ports.confirmEditingDrafts.mockResolvedValue(false)
    expect(await nav.switchMainView('month')).toBe(false)
    expect(window.isVisible()).toBe(false)
    expect(ports.openMainWindow).not.toHaveBeenCalled()
  })
  it('does not undo an explicit user hide while compact expansion has already hidden the window', async () => {
    const { nav, ports, window } = fixture({ compact: true })
    let finishExpansion
    ports.exitCompactPresentation.mockImplementation(() => {
      window.hide()
      return new Promise((resolve) => {
        finishExpansion = resolve
      })
    })
    const pending = nav.switchMainView('month')
    expect(window.isVisible()).toBe(false)
    nav.noteWindowHiddenByUser(window)
    window.hide()
    finishExpansion()
    expect(await pending).toBe(false)
    expect(window.isVisible()).toBe(false)
    expect(ports.openMainWindow).not.toHaveBeenCalled()
    expect(ports.confirmEditingDrafts).not.toHaveBeenCalled()
  })
  it('prevents the real draft guard from revealing after a user hides the already concealed source during inspection', async () => {
    const { nav, ports, window } = fixture({ compact: true })
    let finishInspection
    window.webContents.executeJavaScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInspection = resolve
        })
    )
    ports.confirmEditingDrafts.mockImplementation(
      createEditingDraftGuard({ logger: ports.logger, reveal: async () => ports.openMainWindow() })
    )
    const pending = nav.switchMainView('month')
    await new Promise((resolve) => setImmediate(resolve))
    expect(window.isVisible()).toBe(false)
    nav.noteWindowHiddenByUser(window)
    window.hide() // Already hidden: no second Electron hide event is emitted.
    finishInspection({ dirty: false, blocked: true })
    expect(await pending).toBe(false)
    expect(window.isVisible()).toBe(false)
    expect(ports.openMainWindow).not.toHaveBeenCalled()
  })
  it.each(['shutdown', 'replacement'])(
    'does not restore an old concealed source after %s',
    async (boundary) => {
      const { nav, ports, window, replaceWindow } = fixture({ compact: true })
      let finishExpansion
      ports.exitCompactPresentation.mockImplementation(() => {
        window.hide()
        return new Promise((resolve) => {
          finishExpansion = resolve
        })
      })
      const pending = nav.switchMainView('month')
      if (boundary === 'shutdown') nav.dispose()
      else replaceWindow({ ...window, isDestroyed: () => false })
      finishExpansion()
      expect(await pending).toBe(false)
      expect(ports.openMainWindow).not.toHaveBeenCalled()
      expect(ports.loadWindow).not.toHaveBeenCalled()
    }
  )
  it('owns admission before compact ACK and rejects a second request without showing the loading target', async () => {
    const { nav, ports, window } = fixture({ compact: true })
    let finishExpansion, finishLoad
    ports.exitCompactPresentation.mockImplementation(() => {
      window.hide()
      return new Promise((resolve) => {
        finishExpansion = resolve
      })
    })
    ports.loadWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve
        })
    )
    const first = nav.switchMainView('month')
    expect(await nav.switchMainView('week')).toBe(false)
    expect(ports.exitCompactPresentation).toHaveBeenCalledOnce()
    finishExpansion()
    await new Promise((resolve) => setImmediate(resolve))
    expect(window.isVisible()).toBe(false)
    expect(ports.loadWindow).toHaveBeenCalledOnce()
    nav.handleRendererReady(window.webContents, 'month')
    finishLoad()
    expect(await first).toBe(true)
    expect(nav.mode).toBe('month')
    expect(window.isVisible()).toBe(true)
    expect(ports.openMainWindow).not.toHaveBeenCalled()
  })
  it('transfers the visible source to a deferred background request and restores it if deferred admission is refused', async () => {
    const { nav, ports, window, setBackground } = fixture({ compact: true })
    setBackground(true)
    expect(await nav.switchMainView('month')).toBe(true)
    expect(window.isVisible()).toBe(false)
    ports.confirmEditingDrafts.mockResolvedValueOnce(false)
    setBackground(false)
    nav.onBackgroundSettled()
    await new Promise((resolve) => setImmediate(resolve))
    expect(window.isVisible()).toBe(true)
    expect(nav.mode).toBe('list')
    expect(nav.snapshot().queuedTarget).toBe(null)
    expect(ports.loadWindow).not.toHaveBeenCalled()
  })
  it('drops deferred background navigation after a newer user hide intent', async () => {
    const { nav, ports, window, setBackground } = fixture({ compact: true })
    setBackground(true)
    expect(await nav.switchMainView('month')).toBe(true)
    nav.noteWindowHiddenByUser(window)
    window.hide()
    setBackground(false)
    nav.onBackgroundSettled()
    await new Promise((resolve) => setImmediate(resolve))
    expect(window.isVisible()).toBe(false)
    expect(ports.loadWindow).not.toHaveBeenCalled()
    expect(nav.snapshot().queuedTarget).toBe(null)
  })
  it('settles successful navigation without revealing a window the user hid during its load', async () => {
    const { nav, ports, window } = fixture({ compact: true })
    let finishLoad
    ports.loadWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve
        })
    )
    const pending = nav.switchMainView('month')
    await new Promise((resolve) => setImmediate(resolve))
    nav.noteWindowHiddenByUser(window)
    window.hide()
    nav.handleRendererReady(window.webContents, 'month')
    finishLoad()
    expect(await pending).toBe(true)
    expect(window.isVisible()).toBe(false)
    expect(repository.write).toHaveBeenCalledWith('month')
  })
  it('does not show or persist the restored view after shutdown interrupts recovery load', async () => {
    const { nav, ports, window } = fixture()
    let finishRestore
    ports.loadWindow.mockRejectedValueOnce(Error('target failed')).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestore = resolve
        })
    )
    const pending = nav.switchMainView('month')
    await new Promise((resolve) => setImmediate(resolve))
    expect(ports.loadWindow).toHaveBeenCalledTimes(2)
    nav.dispose()
    finishRestore()
    expect(await pending).toBe(false)
    expect(window.show).not.toHaveBeenCalled()
    expect(ports.logger.fatal).not.toHaveBeenCalled()
    expect(repository.write).not.toHaveBeenCalled()
    expect(nav.snapshot()).toMatchObject({ stopped: true, pendingReady: null, switching: false })
  })
  it('does not write scope or load after shutdown overtakes a slow draft check', async () => {
    const { nav, ports } = fixture()
    let approve
    ports.confirmEditingDrafts.mockReturnValue(
      new Promise((resolve) => {
        approve = resolve
      })
    )
    const pending = nav.switchMainView('month')
    nav.dispose()
    approve(true)
    expect(await pending).toBe(false)
    expect(repository.prepare).not.toHaveBeenCalled()
    expect(repository.write).not.toHaveBeenCalled()
    expect(ports.loadWindow).not.toHaveBeenCalled()
    expect(nav.snapshot()).toMatchObject({
      stopped: true,
      checkingDrafts: false,
      queuedTarget: null
    })
  })
  it('cancels a queued background callback when shutdown begins before the next event loop', async () => {
    const { nav, ports, setBackground } = fixture()
    setBackground(true)
    await nav.switchMainView('month')
    setBackground(false)
    nav.onBackgroundSettled()
    nav.dispose()
    await new Promise((resolve) => setImmediate(resolve))
    expect(ports.confirmEditingDrafts).toHaveBeenCalledOnce()
    expect(ports.loadWindow).not.toHaveBeenCalled()
    expect(repository.write).not.toHaveBeenCalled()
    expect(nav.snapshot()).toMatchObject({ stopped: true, queuedTarget: null, pendingReady: null })
  })
  it('persists source geometry before scope change and loads the target on the same host', async () => {
    const { nav, events, ports, window } = fixture()
    expect(await nav.switchMainView('month')).toBe(true)
    expect(events.indexOf('source-sql')).toBeLessThan(events.indexOf('hide'))
    expect(events.indexOf('hide')).toBeLessThan(events.indexOf('scope:month'))
    expect(events.indexOf('scope:month')).toBeLessThan(events.indexOf('load:month.html'))
    expect(events.indexOf('load:month.html')).toBeLessThan(events.indexOf('active-sql:month'))
    expect(ports.loadWindow).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ rendererFile: 'month.html' })
    )
    expect(nav.snapshot()).toMatchObject({ mode: 'month', switching: false, pendingReady: null })
  })
  it('keeps only the last deferred background target and consumes it after settlement', async () => {
    const { nav, ports, setBackground } = fixture()
    setBackground(true)
    expect(await nav.switchMainView('month')).toBe(true)
    expect(await nav.switchMainView('week')).toBe(true)
    expect(nav.snapshot().queuedTarget).toBe('week')
    expect(ports.loadWindow).not.toHaveBeenCalled()
    setBackground(false)
    nav.onBackgroundSettled()
    await new Promise((resolve) => setImmediate(resolve))
    await Promise.resolve()
    await Promise.resolve()
    expect(ports.loadWindow).toHaveBeenCalledOnce()
    expect(nav.mode).toBe('week')
    expect(nav.snapshot().queuedTarget).toBe(null)
  })
  it('rejects old mode/sender ACKs and lets only the active pending load complete', async () => {
    const { nav, ports, window } = fixture()
    nav.initializeActiveView('month')
    ports.loadWindow.mockResolvedValue(undefined)
    let complete = false
    const pending = nav.loadActiveViewIntoWindow(window).then(() => {
      complete = true
    })
    nav.acknowledgeMainViewRendererReady({}, 'month')
    nav.acknowledgeMainViewRendererReady(window.webContents, 'list')
    await Promise.resolve()
    expect(complete).toBe(false)
    nav.acknowledgeMainViewRendererReady(window.webContents, 'month')
    await pending
    expect(complete).toBe(true)
    expect(nav.snapshot().pendingReady).toBe(null)
  })
  it('cancels on draft or native cleanup before writing target scope', async () => {
    const { nav, ports } = fixture()
    ports.confirmEditingDrafts.mockResolvedValueOnce(false)
    expect(await nav.switchMainView('month')).toBe(false)
    ports.dockRuntime.cleanupStatus = { generation: 3 }
    expect(await nav.switchMainView('month')).toBe(false)
    expect(repository.prepare).not.toHaveBeenCalled()
    expect(ports.loadWindow).not.toHaveBeenCalled()
    expect(nav.mode).toBe('list')
  })
  it('restores the previous scope/renderer after load failure and settles its gate', async () => {
    const { nav, ports, events } = fixture()
    ports.loadWindow.mockRejectedValueOnce(Error('load failed'))
    expect(await nav.switchMainView('month')).toBe(false)
    expect(events).toContain('scope:list')
    expect(events).toContain('load:index.html')
    expect(repository.write).toHaveBeenLastCalledWith('list')
    expect(nav.snapshot()).toMatchObject({
      mode: 'list',
      switching: false,
      checkingDrafts: false,
      pendingReady: null
    })
  })
})
