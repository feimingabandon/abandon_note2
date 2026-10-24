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

function fixture({ compact = false, visible = true, getDocumentGeneration } = {}) {
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
      executeJavaScript: vi.fn(),
      mainFrame: { isDestroyed: () => false, detached: false, executeJavaScript: vi.fn() }
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
    ...(getDocumentGeneration ? { getDocumentGeneration } : {}),
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
    resumePageLeave: vi.fn(async () => {}),
    onNavigationSettled: vi.fn(),
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

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('MainViewNavigation ownership', () => {
  it('releases the page owner and navigation admission before resuming a deferred quit', async () => {
    const f = fixture()
    f.ports.onNavigationSettled.mockImplementation(() => {
      expect(f.nav.isNavigating()).toBe(false)
      expect(f.ports.resumePageLeave).toHaveBeenCalledOnce()
    })
    expect(await f.nav.switchMainView('month')).toBe(true)
    expect(f.ports.onNavigationSettled).toHaveBeenCalledOnce()
  })
  it('resumes prepared settings when navigation is refused or handed back to the background queue', async () => {
    const refused = fixture()
    refused.ports.confirmEditingDrafts.mockResolvedValueOnce(false)
    expect(await refused.nav.switchMainView('month')).toBe(false)
    expect(refused.ports.resumePageLeave).toHaveBeenCalledExactlyOnceWith(
      refused.window,
      refused.ports.confirmEditingDrafts.mock.calls[0][2].owner
    )
    const queued = fixture()
    queued.ports.confirmEditingDrafts.mockImplementationOnce(async () => {
      queued.setBackground(true)
      return true
    })
    expect(await queued.nav.switchMainView('month')).toBe(true)
    expect(queued.ports.loadWindow).not.toHaveBeenCalled()
    expect(queued.ports.resumePageLeave).toHaveBeenCalledExactlyOnceWith(
      queued.window,
      queued.ports.confirmEditingDrafts.mock.calls[0][2].owner
    )
    queued.nav.dispose()
  })
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
    window.webContents.mainFrame.executeJavaScript.mockRejectedValue(
      Error('draft inspection failed')
    )
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
    window.webContents.mainFrame.executeJavaScript.mockImplementation((code) => {
      if (code.includes('__prepareEditingDrafts'))
        return new Promise((resolve) => {
          finishInspection = resolve
        })
      return Promise.resolve({ ready: true })
    })
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
    expect(ports.confirmEditingDrafts).not.toHaveBeenCalled()
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
  it('queues the latest target before settings drain and negotiates once after background settlement', async () => {
    const { nav, ports, setBackground } = fixture()
    const drain = deferred()
    ports.confirmEditingDrafts.mockReturnValue(drain.promise)
    setBackground(true)
    expect(await nav.switchMainView('month')).toBe(true)
    expect(await nav.switchMainView('week')).toBe(true)
    expect(nav.snapshot().queuedTarget).toBe('week')
    expect(ports.confirmEditingDrafts).not.toHaveBeenCalled()
    expect(ports.loadWindow).not.toHaveBeenCalled()
    setBackground(false)
    nav.onBackgroundSettled()
    await new Promise((resolve) => setImmediate(resolve))
    expect(ports.confirmEditingDrafts).toHaveBeenCalledOnce()
    expect(ports.loadWindow).not.toHaveBeenCalled()
    drain.resolve(true)
    await new Promise((resolve) => setImmediate(resolve))
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

describe('MainViewNavigation bounded document readiness', () => {
  it('finishes an admitted ready while browser load is held and permits the next full switch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { nav, ports, window } = fixture()
    const firstLoad = deferred()
    const secondLoad = deferred()
    ports.loadWindow.mockReturnValueOnce(firstLoad.promise).mockReturnValueOnce(secondLoad.promise)
    const first = nav.switchMainView('month')
    await nextTurn()
    expect(nav.snapshot()).toMatchObject({ mode: 'month', switching: true })
    nav.handleRendererReady(window.webContents, 'month')
    expect(await first).toBe(true)
    expect(nav.snapshot()).toMatchObject({ switching: false, pendingReady: null })
    expect(nav.isNavigating()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(ports.resumePageLeave).toHaveBeenCalledOnce()
    expect(repository.write).toHaveBeenCalledExactlyOnceWith('month')
    const second = nav.switchMainView('week')
    await nextTurn()
    expect(ports.loadWindow).toHaveBeenCalledTimes(2)
    nav.handleRendererReady(window.webContents, 'week')
    expect(await second).toBe(true)
    expect(repository.write.mock.calls).toEqual([['month'], ['week']])
    expect(ports.resumePageLeave).toHaveBeenCalledTimes(2)
    expect(nav.isNavigating()).toBe(false)
    firstLoad.resolve()
    secondLoad.resolve()
    await nextTurn()
    nav.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the ready deadline active when browser load finishes first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { nav, ports, window } = fixture({ visible: false })
    nav.initializeActiveView('month')
    ports.loadWindow.mockResolvedValueOnce(undefined)
    let settled = false
    const outcome = nav.loadActiveViewIntoWindow(window).then(
      () => {
        settled = true
        return null
      },
      (error) => {
        settled = true
        return error
      }
    )
    await nextTurn()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await outcome).message).toContain('超时')
    expect(nav.snapshot().pendingReady).toBe(null)
    expect(window.show).not.toHaveBeenCalled()
    expect(repository.write).not.toHaveBeenCalled()
    nav.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['synchronous-throw', 'promise-rejection'])(
    'retains the exact %s load error before ready and permits another operation',
    async (failureMode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { nav, ports, window } = fixture({ visible: false })
      const failure = new Error('browser load failed before document ready')
      if (failureMode === 'synchronous-throw') {
        ports.loadWindow.mockImplementationOnce(() => {
          throw failure
        })
      } else ports.loadWindow.mockRejectedValueOnce(failure)
      const outcome = nav.loadActiveViewIntoWindow(window).catch((error) => error)
      expect(await outcome).toBe(failure)
      expect(nav.snapshot().pendingReady).toBe(null)
      expect(window.show).not.toHaveBeenCalled()
      expect(repository.write).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      const held = deferred()
      ports.loadWindow.mockReturnValueOnce(held.promise)
      const replacement = nav.loadActiveViewIntoWindow(window)
      nav.handleRendererReady(window.webContents, 'list')
      await replacement
      expect(ports.loadWindow).toHaveBeenCalledTimes(2)
      expect(window.show).toHaveBeenCalledOnce()
      held.resolve()
      await nextTurn()
      nav.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['timeout', 'closed', 'renderer-crash', 'contents-destroyed', 'replacement', 'dispose'])(
    '%s settles an owned held load without waiting for its browser promise or accepting late ready',
    async (boundary) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { nav, ports, window, replaceWindow } = fixture({ visible: false })
      const loading = deferred()
      ports.loadWindow.mockReturnValueOnce(loading.promise)
      const outcome = nav.loadActiveViewIntoWindow(window).then(
        () => ({ status: 'fulfilled' }),
        (error) => ({ status: 'rejected', error })
      )
      if (boundary === 'timeout') await vi.advanceTimersByTimeAsync(15_000)
      else if (boundary === 'closed') window.emit('closed')
      else if (boundary === 'renderer-crash')
        window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
      else if (boundary === 'contents-destroyed') window.webContents.emit('destroyed')
      else if (boundary === 'replacement') {
        // The main host releases its current window before replacing its identity.
        nav.releaseWindow(window, new Error('main host replaced its window'))
        replaceWindow({ ...window, id: 2, webContents: { ...window.webContents, id: 2 } })
      } else nav.dispose()
      const result = await outcome
      expect(result.status).toBe('rejected')
      expect(result.error).toBeInstanceOf(Error)
      expect(nav.snapshot().pendingReady).toBe(null)
      expect(vi.getTimerCount()).toBe(0)
      expect(window.listenerCount('closed')).toBe(0)
      expect(window.webContents.listenerCount('destroyed')).toBe(0)
      expect(window.webContents.listenerCount('render-process-gone')).toBe(0)
      nav.handleRendererReady(window.webContents, 'list')
      expect(window.show).not.toHaveBeenCalled()
      expect(window.focus).not.toHaveBeenCalled()
      expect(repository.write).not.toHaveBeenCalled()
      loading.resolve()
      await nextTurn()
      expect(window.show).not.toHaveBeenCalled()
      expect(ports.loadWindow).toHaveBeenCalledOnce()
      nav.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['closed', 'replacement', 'dispose'])(
    'cancels a full switch on %s without starting rollback or persisting the target',
    async (boundary) => {
      const { nav, ports, window, replaceWindow } = fixture()
      const loading = deferred()
      ports.loadWindow.mockReturnValueOnce(loading.promise)
      const pending = nav.switchMainView('month')
      await nextTurn()
      if (boundary === 'closed') window.emit('closed')
      else if (boundary === 'replacement') {
        nav.releaseWindow(window, new Error('main host replacement'))
        replaceWindow({ ...window, id: 2, webContents: { ...window.webContents, id: 2 } })
      } else nav.dispose()
      expect(await pending).toBe(false)
      expect(ports.loadWindow).toHaveBeenCalledOnce()
      expect(repository.write).not.toHaveBeenCalled()
      expect(window.show).not.toHaveBeenCalled()
      expect(window.focus).not.toHaveBeenCalled()
      expect(ports.logger.fatal).not.toHaveBeenCalled()
      expect(nav.isNavigating()).toBe(false)
      expect(ports.resumePageLeave).toHaveBeenCalledOnce()
      loading.resolve()
      await nextTurn()
      nav.dispose()
    }
  )

  it('treats a renderer crash on the still-owned window as failure and restores its source view', async () => {
    const { nav, ports, window } = fixture()
    const targetLoad = deferred()
    const sourceLoad = deferred()
    ports.loadWindow.mockReturnValueOnce(targetLoad.promise).mockReturnValueOnce(sourceLoad.promise)
    const pending = nav.switchMainView('month')
    await nextTurn()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await nextTurn()
    expect(ports.loadWindow).toHaveBeenCalledTimes(2)
    expect(nav.snapshot()).toMatchObject({ mode: 'list', switching: true })
    expect(repository.write).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    nav.handleRendererReady(window.webContents, 'list')
    expect(await pending).toBe(false)
    expect(repository.write).toHaveBeenCalledExactlyOnceWith('list')
    expect(window.show).toHaveBeenCalledOnce()
    expect(ports.logger.error).toHaveBeenCalledWith(
      'view.switch',
      expect.objectContaining({ message: expect.stringContaining('crashed') }),
      { previousMode: 'list', targetMode: 'month' }
    )
    expect(ports.logger.fatal).not.toHaveBeenCalled()
    expect(nav.isNavigating()).toBe(false)
    targetLoad.resolve()
    sourceLoad.resolve()
    await nextTurn()
    nav.dispose()
  })

  it('rejects old same-view document generations through both ready entry points', async () => {
    let generation = 7
    const { nav, ports, window } = fixture({
      visible: false,
      getDocumentGeneration: () => generation
    })
    nav.initializeActiveView('month')
    const loading = deferred()
    ports.loadWindow.mockReturnValueOnce(loading.promise)
    let settled = false
    const pending = nav.loadActiveViewIntoWindow(window).then(() => {
      settled = true
    })
    nav.acknowledgeMainViewRendererReady(window.webContents, 'month', { generation: 7 })
    nav.handleRendererReady(window.webContents, 'month', { generation: 7 })
    nav.handleRendererReady(window.webContents, 'month')
    await nextTurn()
    expect(settled).toBe(false)
    expect(nav.snapshot().pendingReady).not.toBe(null)
    expect(window.show).not.toHaveBeenCalled()
    generation = 8
    nav.handleRendererReady(window.webContents, 'month', { generation })
    await pending
    expect(settled).toBe(true)
    expect(window.show).toHaveBeenCalledOnce()
    loading.resolve()
    await nextTurn()
    nav.dispose()
  })

  it('observes an old successful load failure without revoking a newer same-view waiter', async () => {
    let generation = 1
    const { nav, ports, window } = fixture({ getDocumentGeneration: () => generation })
    nav.initializeActiveView('month')
    const firstLoad = deferred()
    const secondLoad = deferred()
    ports.loadWindow.mockReturnValueOnce(firstLoad.promise).mockReturnValueOnce(secondLoad.promise)
    const first = nav.loadActiveViewIntoWindow(window)
    generation = 2
    nav.handleRendererReady(window.webContents, 'month', { generation })
    await first
    let secondSettled = false
    const second = nav.loadActiveViewIntoWindow(window).then(() => {
      secondSettled = true
    })
    nav.handleRendererReady(window.webContents, 'month', { generation: 2 })
    const failure = new Error('old browser load failed after business ready')
    firstLoad.reject(failure)
    await nextTurn()
    expect(secondSettled).toBe(false)
    expect(nav.snapshot().pendingReady).not.toBe(null)
    expect(ports.logger.error).toHaveBeenCalledWith(
      'view.load-after-ready',
      failure,
      expect.objectContaining({ viewMode: 'month', operationId: expect.anything() })
    )
    generation = 3
    nav.handleRendererReady(window.webContents, 'month', { generation })
    await second
    expect(secondSettled).toBe(true)
    expect(ports.loadWindow).toHaveBeenCalledTimes(2)
    secondLoad.resolve()
    await nextTurn()
    nav.dispose()
  })

  it('rejects the old source ready while a same-view rollback awaits a new document', async () => {
    let generation = 1
    const { nav, ports, window } = fixture({ getDocumentGeneration: () => generation })
    nav.handleRendererReady(window.webContents, 'list', { generation })
    window.show.mockClear()
    window.focus.mockClear()
    const rollbackLoad = deferred()
    ports.loadWindow
      .mockRejectedValueOnce(new Error('target failed before document commit'))
      .mockReturnValueOnce(rollbackLoad.promise)
    let settled = false
    const pending = nav.switchMainView('month').then((result) => {
      settled = true
      return result
    })
    await nextTurn()
    expect(ports.loadWindow).toHaveBeenCalledTimes(2)
    expect(nav.mode).toBe('list')
    nav.handleRendererReady(window.webContents, 'list', { generation: 1 })
    nav.acknowledgeMainViewRendererReady(window.webContents, 'list', { generation: 1 })
    await nextTurn()
    expect(settled).toBe(false)
    expect(window.show).not.toHaveBeenCalled()
    expect(repository.write).not.toHaveBeenCalled()
    generation = 2
    nav.handleRendererReady(window.webContents, 'list', { generation })
    expect(await pending).toBe(false)
    expect(repository.write).toHaveBeenCalledExactlyOnceWith('list')
    expect(window.show).toHaveBeenCalledOnce()
    rollbackLoad.resolve()
    await nextTurn()
    nav.dispose()
  })

  it.each(['show', 'focus'])(
    'fails immediately with the exact synchronous %s error and allows rollback readiness',
    async (method) => {
      const { nav, ports, window } = fixture()
      const targetLoad = deferred()
      const rollbackLoad = deferred()
      ports.loadWindow
        .mockReturnValueOnce(targetLoad.promise)
        .mockReturnValueOnce(rollbackLoad.promise)
      const pending = nav.switchMainView('month')
      await nextTurn()
      const failure = new Error(`${method} failed synchronously`)
      window[method].mockImplementationOnce(() => {
        throw failure
      })
      expect(() => nav.handleRendererReady(window.webContents, 'month')).not.toThrow()
      await nextTurn()
      expect(ports.loadWindow).toHaveBeenCalledTimes(2)
      expect(ports.logger.error).toHaveBeenCalledWith(
        'view.switch',
        failure,
        expect.objectContaining({ previousMode: 'list', targetMode: 'month' })
      )
      expect(ports.logger.error).toHaveBeenCalledWith(
        'view.presentation',
        failure,
        expect.objectContaining({ viewMode: 'month', operationId: expect.anything() })
      )
      nav.handleRendererReady(window.webContents, 'list')
      expect(await pending).toBe(false)
      expect(repository.write).toHaveBeenCalledExactlyOnceWith('list')
      expect(ports.logger.fatal).not.toHaveBeenCalled()
      targetLoad.resolve()
      rollbackLoad.resolve()
      await nextTurn()
      nav.dispose()
    }
  )

  it.each(['hide', 'dispose'])(
    'preserves the distinct visibility and cancellation contracts when display reenters %s',
    async (boundary) => {
      const { nav, ports, window } = fixture()
      const loading = deferred()
      ports.loadWindow.mockReturnValueOnce(loading.promise)
      const pending = nav.switchMainView('month')
      await nextTurn()
      const show = window.show.getMockImplementation()
      window.show.mockImplementationOnce(() => {
        show()
        if (boundary === 'hide') {
          nav.noteWindowHiddenByUser(window)
          window.hide()
        } else nav.dispose()
      })
      expect(() => nav.handleRendererReady(window.webContents, 'month')).not.toThrow()
      expect(await pending).toBe(boundary === 'hide')
      expect(window.focus).not.toHaveBeenCalled()
      if (boundary === 'hide') {
        expect(repository.write).toHaveBeenCalledExactlyOnceWith('month')
        expect(window.isVisible()).toBe(false)
      } else expect(repository.write).not.toHaveBeenCalled()
      expect(ports.loadWindow).toHaveBeenCalledOnce()
      expect(nav.isNavigating()).toBe(false)
      loading.resolve()
      await nextTurn()
      nav.dispose()
    }
  )

  it('does not show or focus repeatedly when ready repeats before navigation has unwound', async () => {
    const { nav, ports, window } = fixture()
    const loading = deferred()
    ports.loadWindow.mockReturnValueOnce(loading.promise)
    const pending = nav.switchMainView('month')
    await nextTurn()
    nav.handleRendererReady(window.webContents, 'month')
    nav.handleRendererReady(window.webContents, 'month')
    nav.handleRendererReady(window.webContents, 'month')
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(await pending).toBe(true)
    nav.handleRendererReady(window.webContents, 'month')
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(repository.write).toHaveBeenCalledExactlyOnceWith('month')
    loading.resolve()
    await nextTurn()
    nav.dispose()
  })

  it('keeps a twice-failed target and rollback hidden, then permits retry of the unavailable active view', async () => {
    const { nav, ports, window } = fixture()
    const targetFailure = new Error('target load failed')
    const rollbackFailure = new Error('rollback load failed')
    ports.loadWindow.mockRejectedValueOnce(targetFailure).mockRejectedValueOnce(rollbackFailure)
    expect(await nav.switchMainView('month')).toBe(false)
    expect(ports.loadWindow).toHaveBeenCalledTimes(2)
    expect(nav.snapshot()).toMatchObject({ mode: 'list', unavailable: true, pendingReady: null })
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(window.isVisible()).toBe(false)
    expect(repository.write).not.toHaveBeenCalled()
    expect(ports.logger.fatal).toHaveBeenCalledExactlyOnceWith(
      'view.switch-restore',
      rollbackFailure,
      { previousMode: 'list' }
    )
    expect(await nav.switchMainView('list')).toBe(true)
    expect(ports.loadWindow).toHaveBeenCalledTimes(3)
    expect(repository.write).toHaveBeenCalledExactlyOnceWith('list')
    expect(window.show).toHaveBeenCalledOnce()
    expect(nav.snapshot()).toMatchObject({
      unavailable: false,
      pendingReady: null,
      switching: false
    })
    nav.dispose()
  })
})
