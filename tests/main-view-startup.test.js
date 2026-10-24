import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '../src/shared/settings-schema.js'

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

const owners = new Set()
afterEach(() => {
  for (const owner of owners) owner.dispose()
  owners.clear()
  vi.useRealTimers()
  vi.clearAllMocks()
})

function deferred() {
  let fulfill, fail
  const state = { settled: false }
  const promise = new Promise((resolve, reject) => {
    fulfill = resolve
    fail = reject
  })
  return {
    promise,
    get settled() {
      return state.settled
    },
    resolve(value) {
      state.settled = true
      fulfill(value)
    },
    reject(error) {
      state.settled = true
      fail(error)
    }
  }
}

function fakeWindow(id = 1, { invalidContentsAfterDestroy = false } = {}) {
  let visible = false
  let destroyed = false
  let crashed = false
  let bounds = { x: 50, y: 50, width: 400, height: 600 }
  const window = new EventEmitter()
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    isCrashed: () => crashed,
    send: vi.fn(),
    isLoadingMainFrame: () => true
  })
  Object.assign(window, {
    id,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isFocused: () => visible,
    getBounds: () => ({ ...bounds }),
    setBounds: vi.fn((value) => {
      bounds = { ...value }
    }),
    show: vi.fn(() => {
      visible = true
      window.emit('show')
    }),
    focus: vi.fn(),
    hide: vi.fn(() => {
      const wasVisible = visible
      visible = false
      if (wasVisible) window.emit('hide')
    }),
    destroy: () => {
      destroyed = true
      visible = false
      contents.emit('destroyed')
      window.emit('closed')
    },
    crash: () => {
      crashed = true
      window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    },
    webContents: contents
  })
  if (invalidContentsAfterDestroy)
    Object.defineProperty(window, 'webContents', {
      configurable: true,
      get: () => {
        if (destroyed) throw new Error('Object has been destroyed')
        return contents
      }
    })
  return window
}

function fixture(windowOptions = {}) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(1_000_000)
  const window = fakeWindow(1, windowOptions)
  let currentWindow = window
  let generation = 0
  let quitting = false
  const loads = []
  const display = {
    id: 1,
    scaleFactor: 1,
    workArea: { x: 0, y: 0, width: 1600, height: 1000 },
    workAreaSize: { width: 1600, height: 1000 }
  }
  const ports = {
    getMainWindow: () => currentWindow,
    getDocumentGeneration: () => generation,
    loadWindow: vi.fn((target, location) => {
      const load = deferred()
      loads.push(Object.assign(load, { target, location }))
      return load.promise
    }),
    screen: { getPrimaryDisplay: () => display, getDisplayMatching: () => display },
    getSettings: () => createDefaultSettings(),
    resetSettingsForView: vi.fn(),
    refreshResolvedSettings: vi.fn(),
    geometryPersistence: {
      getStableBounds: () => ({ x: 50, y: 50, width: 400, height: 600 }),
      setStableBounds: vi.fn(),
      cancel: vi.fn(),
      readPendingBounds: () => null,
      markSaved: vi.fn()
    },
    dockRuntime: {
      cleanupStatus: null,
      readStableSessionBounds: () => null,
      restoreDockWindowToVisiblePosition: vi.fn(),
      resetDockState: vi.fn(),
      setWorkArea: vi.fn()
    },
    isCompactPresentationActive: () => false,
    exitCompactPresentation: vi.fn(async () => {}),
    endTitlebarWindowDrag: vi.fn(),
    openMainWindow: vi.fn(),
    confirmEditingDrafts: vi.fn(async () => true),
    resumePageLeave: vi.fn(async () => {}),
    onNavigationSettled: vi.fn(),
    isShutdownCheckingDrafts: () => false,
    isQuitting: () => quitting,
    isBackgroundInFlight: () => false,
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
    rendererRoot: 'C:/test-renderer',
    isDev: false
  }
  repository.prepare.mockReturnValue({ geometryPersisted: false })
  const nav = createMainViewNavigation(ports)
  owners.add(nav)
  return {
    nav,
    window,
    ports,
    loads,
    issueDocument: () => ++generation,
    ready: (
      viewMode = nav.mode,
      documentGeneration = generation,
      sender = currentWindow.webContents
    ) => nav.handleRendererReady(sender, viewMode, { generation: documentGeneration }),
    quit: () => {
      quitting = true
      nav.dispose()
    },
    replaceWindow: (replacement) => {
      nav.releaseWindow(currentWindow)
      currentWindow = replacement
    }
  }
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('first main view readiness ownership', () => {
  it.each(['pending', 'ready'])(
    'detaches from captured contents when an externally destroyed %s window rejects its getter',
    async (state) => {
      const f = fixture({ invalidContentsAfterDestroy: true })
      const contents = f.window.webContents
      const startup = f.nav.startInitialView(f.window)
      let opening
      if (state === 'ready') {
        f.issueDocument()
        expect(f.ready()).toBe(true)
        expect(await startup).toBe(true)
      } else opening = f.nav.requestInitialOpen(f.window)
      expect(() => f.window.destroy()).not.toThrow()
      expect(() => f.window.webContents).toThrow('Object has been destroyed')
      expect(await startup).toBe(state === 'ready')
      if (opening) expect(await opening).toBe(false)
      expect(f.window.eventNames()).toEqual([])
      expect(contents.eventNames()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      expect(f.nav.snapshot().pendingReady).toBe(null)
      expect(f.nav.isReadyDocument(f.window)).toBe(false)
      expect(() => f.nav.handleRendererReady(contents, 'list', { generation: 1 })).not.toThrow()
      f.loads[0].resolve()
      await settle()
      expect(f.window.show).toHaveBeenCalledTimes(state === 'ready' ? 1 : 0)
    }
  )
  it('keeps one exact 15000ms deadline after browser load finishes without business ready', async () => {
    const f = fixture()
    const pending = f.nav.startInitialView(f.window)
    const initial = f.nav.snapshot().initialization
    expect(initial).toMatchObject({ state: 'pending', deadline: 1_015_000, phase: 'ready' })
    expect(f.nav.canSkipInitialDrafts(f.window)).toBe(true)
    expect(f.nav.isNavigating()).toBe(false)
    f.loads[0].resolve()
    await settle()
    vi.advanceTimersByTime(14999)
    await settle()
    expect(f.nav.snapshot().initialization.state).toBe('pending')
    expect(f.window.show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(await pending).toBe(false)
    expect(f.nav.snapshot()).toMatchObject({
      unavailable: true,
      pendingReady: null,
      initialization: {
        id: initial.id,
        state: 'failed',
        phase: 'ready',
        error: { code: 'MAIN_VIEW_READY_TIMEOUT' }
      }
    })
    expect(f.nav.hasAcceptedReady(f.window)).toBe(false)
    expect(f.window.show).not.toHaveBeenCalled()
    expect(f.ports.logger.error).toHaveBeenCalledWith(
      'startup.renderer-initialization',
      expect.objectContaining({ code: 'MAIN_VIEW_READY_TIMEOUT' }),
      expect.objectContaining({ id: initial.id, state: 'failed', viewMode: 'list' })
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts ready at 14999ms, clears its deadline and leaves the browser tail independently owned', async () => {
    const f = fixture()
    const pending = f.nav.startInitialView(f.window)
    vi.advanceTimersByTime(14999)
    f.issueDocument()
    expect(f.ready()).toBe(true)
    expect(await pending).toBe(true)
    expect(f.loads[0].settled).toBe(false)
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
    expect(f.nav.snapshot()).toMatchObject({
      unavailable: false,
      initialization: { state: 'succeeded', shown: true }
    })
    vi.advanceTimersByTime(15000)
    expect(f.nav.snapshot().initialization.state).toBe('succeeded')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects ready at the deadline even when wall time advances before the timer is delivered', async () => {
    const f = fixture()
    const pending = f.nav.startInitialView(f.window)
    const generation = f.issueDocument()
    vi.setSystemTime(1_015_000)
    expect(f.ready()).toBe(false)
    expect(await pending).toBe(false)
    expect(f.nav.snapshot().initialization.error.code).toBe('MAIN_VIEW_READY_TIMEOUT')
    expect(f.nav.snapshot().unavailable).toBe(true)
    expect(f.ready('list', generation)).toBe(false)
    expect(f.window.show).not.toHaveBeenCalled()
    expect(f.window.focus).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts a fresh retry for the same open that discovers the previous deadline has passed', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const oldGeneration = f.issueDocument()
    const oldId = f.nav.snapshot().initialization.id
    vi.setSystemTime(1_015_000)
    const opening = f.nav.requestInitialOpen(f.window)
    const retry = f.nav.snapshot().initialization
    expect(retry.id).toBeGreaterThan(oldId)
    expect(retry).toMatchObject({ state: 'pending', deadline: 1_030_000 })
    expect(await startup).toBe(false)
    expect(f.loads).toHaveLength(2)
    expect(f.ready('list', oldGeneration)).toBe(false)
    expect(f.window.show).not.toHaveBeenCalled()
    f.issueDocument()
    expect(f.ready()).toBe(true)
    expect(await opening).toBe(true)
    expect(f.nav.snapshot()).toMatchObject({
      unavailable: false,
      initialization: { id: retry.id, state: 'succeeded' }
    })
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['load-first', 'ready-first'])(
    'uses business readiness for %s without requiring nonessential load completion',
    async (order) => {
      const f = fixture()
      const pending = f.nav.startInitialView(f.window)
      if (order === 'load-first') {
        f.loads[0].resolve()
        await settle()
        expect(f.nav.snapshot().initialization.state).toBe('pending')
        expect(f.window.show).not.toHaveBeenCalled()
      }
      f.issueDocument()
      expect(f.ready()).toBe(true)
      expect(await pending).toBe(true)
      expect(f.loads[0].settled).toBe(order === 'load-first')
      expect(f.nav.isReadyDocument(f.window)).toBe(true)
      expect(f.nav.canSkipInitialDrafts(f.window)).toBe(false)
      expect(f.window.show).toHaveBeenCalledOnce()
      expect(f.window.focus).toHaveBeenCalledOnce()
      expect(f.ready()).toBe(false)
      expect(f.window.show).toHaveBeenCalledOnce()
      expect(f.ports.revealPendingNotificationApplication).toHaveBeenCalledOnce()
    }
  )

  it('reports a pre-ready load rejection separately and lets a later explicit open retry use a new operation', async () => {
    const f = fixture()
    const pending = f.nav.startInitialView(f.window)
    const oldId = f.nav.snapshot().initialization.id
    f.loads[0].reject(new Error('initial document could not load'))
    expect(await pending).toBe(false)
    expect(f.nav.snapshot().initialization).toMatchObject({
      state: 'failed',
      phase: 'load',
      error: { code: 'MAIN_VIEW_LOAD_FAILED' }
    })
    const retry = f.nav.requestInitialOpen(f.window)
    expect(f.nav.snapshot().initialization.id).toBeGreaterThan(oldId)
    f.issueDocument()
    expect(f.ready()).toBe(true)
    expect(await retry).toBe(true)
    expect(f.loads).toHaveLength(2)
    expect(f.nav.snapshot().unavailable).toBe(false)
  })

  it('keeps only the latest initial open result true while showing and focusing once', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const first = f.nav.requestInitialOpen(f.window)
    const second = f.nav.requestInitialOpen(f.window)
    const latest = f.nav.requestInitialOpen(f.window)
    expect(f.loads).toHaveLength(1)
    expect(f.window.show).not.toHaveBeenCalled()
    f.issueDocument()
    f.ready()
    expect(await startup).toBe(true)
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(await latest).toBe(true)
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
    expect(f.ports.openMainWindow).not.toHaveBeenCalled()
    expect(f.nav.requestInitialOpen(f.window)).toBeNull()
  })

  it('accepts hidden ready as business success while revoking show and the draft-skipping exemption', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const opening = f.nav.requestInitialOpen(f.window)
    expect(f.nav.noteWindowHiddenByUser(f.window)).toBe(true)
    f.window.hide()
    f.issueDocument()
    expect(f.ready()).toBe(true)
    expect(await startup).toBe(true)
    expect(await opening).toBe(false)
    expect(f.nav.hasAcceptedReady(f.window)).toBe(true)
    expect(f.nav.isReadyDocument(f.window)).toBe(true)
    expect(f.nav.canSkipInitialDrafts(f.window)).toBe(false)
    expect(f.nav.snapshot()).toMatchObject({
      unavailable: false,
      initialization: { state: 'succeeded', shown: false }
    })
    expect(f.window.show).not.toHaveBeenCalled()
    expect(f.window.focus).not.toHaveBeenCalled()
  })

  it('does not report an initial open shown when its accepted document expires before the consumer resumes', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const opening = f.nav.requestInitialOpen(f.window)
    f.issueDocument()
    expect(f.ready()).toBe(true)
    f.window.webContents.emit('did-navigate', {}, 'file:///replacement.html')
    f.issueDocument()
    expect(await startup).toBe(true)
    expect(await opening).toBe(false)
    expect(f.nav.hasAcceptedReady(f.window)).toBe(true)
    expect(f.nav.isReadyDocument(f.window)).toBe(false)
    expect(f.nav.canSkipInitialDrafts(f.window)).toBe(false)
  })

  it('revokes ready presentation on a synchronous document commit before a newer source is issued', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const show = f.window.show.getMockImplementation()
    f.window.show.mockImplementationOnce(() => {
      show()
      f.window.webContents.emit('did-navigate', {}, 'file:///replacement.html')
    })
    const generation = f.issueDocument()
    expect(f.ready('list', generation)).toBe(false)
    expect(await startup).toBe(false)
    expect(f.nav.snapshot()).toMatchObject({
      unavailable: true,
      initialization: { state: 'cancelled' }
    })
    expect(f.window.isVisible()).toBe(false)
    expect(f.window.focus).not.toHaveBeenCalled()
    expect(f.nav.hasAcceptedReady(f.window)).toBe(false)
    expect(f.nav.isReadyDocument(f.window)).toBe(false)
    expect(f.ready('list', generation)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not promote ready state if the selection write crosses the original deadline', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    f.issueDocument()
    const selection = f.nav.switchMainView('month')
    expect(await startup).toBe(false)
    const deadline = f.nav.snapshot().initialization.deadline
    repository.write.mockImplementationOnce(() => {
      vi.setSystemTime(deadline)
    })
    f.issueDocument()
    expect(f.ready('month')).toBe(false)
    expect(await selection).toBe(false)
    expect(repository.write).toHaveBeenCalledExactlyOnceWith('month')
    expect(f.nav.snapshot().initialization).toMatchObject({
      state: 'failed',
      error: { code: 'MAIN_VIEW_READY_TIMEOUT' }
    })
    expect(f.nav.hasAcceptedReady(f.window)).toBe(false)
    expect(f.nav.isReadyDocument(f.window)).toBe(false)
    expect(f.window.isVisible()).toBe(false)
    expect(f.nav.canSkipInitialDrafts(f.window)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects the previous generation during retry and only accepts a freshly issued current document', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const oldGeneration = f.issueDocument()
    const oldId = f.nav.snapshot().initialization.id
    vi.advanceTimersByTime(15000)
    expect(await startup).toBe(false)
    expect(f.ready('list', oldGeneration)).toBe(false)
    const retry = f.nav.requestInitialOpen(f.window)
    const retryId = f.nav.snapshot().initialization.id
    expect(retryId).toBeGreaterThan(oldId)
    expect(f.ready('list', oldGeneration)).toBe(false)
    expect(f.nav.snapshot().initialization).toMatchObject({ id: retryId, state: 'pending' })
    const nextGeneration = f.issueDocument()
    expect(f.ready('list', oldGeneration)).toBe(false)
    expect(f.ready('list', nextGeneration)).toBe(true)
    expect(await retry).toBe(true)
    expect(f.nav.snapshot().initialization).toMatchObject({
      id: retryId,
      state: 'succeeded',
      documentGeneration: nextGeneration
    })
    expect(f.window.show).toHaveBeenCalledOnce()
  })

  it('observes a late old successful load rejection without revoking a newer current-document load', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const oldId = f.nav.snapshot().initialization.id
    f.issueDocument()
    f.ready()
    expect(await startup).toBe(true)
    f.window.hide()
    f.window.webContents.emit('did-navigate', {}, 'file:///test-renderer/index.html')
    const reload = f.nav.loadActiveViewIntoWindow(f.window)
    const oldFailure = new Error('old successful browser tail failed')
    f.loads[0].reject(oldFailure)
    await settle()
    expect(f.nav.snapshot().pendingReady).toEqual({ windowId: f.window.id, viewMode: 'list' })
    expect(f.nav.snapshot().initialization).toMatchObject({ id: oldId, state: 'succeeded' })
    expect(f.ports.logger.error).toHaveBeenCalledWith('view.load-after-ready', oldFailure, {
      operationId: oldId,
      viewMode: 'list'
    })
    f.issueDocument()
    expect(f.ready()).toBe(true)
    await reload
    expect(f.nav.isReadyDocument(f.window)).toBe(true)
    expect(f.window.show).toHaveBeenCalledOnce()
  })

  it('ignores an old timed-out load rejection after a newer retry has already succeeded', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    f.issueDocument()
    vi.advanceTimersByTime(15000)
    expect(await startup).toBe(false)
    const retry = f.nav.requestInitialOpen(f.window)
    f.issueDocument()
    f.ready()
    expect(await retry).toBe(true)
    const accepted = f.nav.snapshot().initialization
    f.loads[0].reject(new Error('late timed-out browser failure'))
    await settle()
    expect(f.nav.snapshot().initialization).toEqual(accepted)
    expect(f.nav.snapshot().unavailable).toBe(false)
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
  })

  it('switches a never-ready startup directly to another view without entering page leave or navigation admission', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const oldGeneration = f.issueDocument()
    const oldId = f.nav.snapshot().initialization.id
    const switching = f.nav.switchMainView('month')
    expect(await startup).toBe(false)
    expect(f.nav.isNavigating()).toBe(false)
    expect(f.nav.isCheckingDrafts()).toBe(false)
    expect(f.ports.confirmEditingDrafts).not.toHaveBeenCalled()
    expect(f.ports.resumePageLeave).not.toHaveBeenCalled()
    expect(repository.prepare).toHaveBeenCalledExactlyOnceWith({
      sourceViewMode: 'list',
      targetViewMode: 'month',
      pendingGeometry: null
    })
    expect(repository.write).not.toHaveBeenCalled()
    expect(f.nav.snapshot().initialization).toMatchObject({ state: 'pending', viewMode: 'month' })
    expect(f.nav.snapshot().initialization.id).toBeGreaterThan(oldId)
    expect(f.loads.map((load) => load.location.rendererFile)).toEqual(['index.html', 'month.html'])
    expect(f.ready('list', oldGeneration)).toBe(false)
    expect(f.ready('month', oldGeneration)).toBe(false)
    f.issueDocument()
    expect(f.ready('month')).toBe(true)
    expect(await switching).toBe(true)
    expect(repository.write).toHaveBeenCalledExactlyOnceWith('month')
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.nav.isNavigating()).toBe(false)
    expect(f.ports.confirmEditingDrafts).not.toHaveBeenCalled()
    f.loads[0].reject(new Error('superseded startup load'))
    await settle()
    expect(f.nav.snapshot().initialization.state).toBe('succeeded')
  })

  it('persists a failed startup target exactly once after a later explicit open successfully retries it', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    f.issueDocument()
    const selectingMonth = f.nav.switchMainView('month')
    expect(await startup).toBe(false)
    f.loads[1].reject(new Error('selected month failed before ready'))
    expect(await selectingMonth).toBe(false)
    expect(f.nav.snapshot()).toMatchObject({
      mode: 'month',
      unavailable: true,
      initialization: { viewMode: 'month', state: 'failed' }
    })
    expect(repository.write).not.toHaveBeenCalled()
    const retry = f.nav.requestInitialOpen(f.window)
    expect(f.loads.map((load) => load.location.rendererFile)).toEqual([
      'index.html',
      'month.html',
      'month.html'
    ])
    f.issueDocument()
    expect(f.ready('month')).toBe(true)
    expect(await retry).toBe(true)
    expect(repository.write).toHaveBeenCalledExactlyOnceWith('month')
    expect(f.nav.snapshot()).toMatchObject({
      mode: 'month',
      unavailable: false,
      initialization: { viewMode: 'month', state: 'succeeded' }
    })
    expect(f.ports.confirmEditingDrafts).not.toHaveBeenCalled()
    expect(f.nav.isNavigating()).toBe(false)
  })

  it('settles a pending initial open immediately on quit disposal and releases every owned listener and timer', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const opening = f.nav.requestInitialOpen(f.window)
    f.issueDocument()
    expect(f.nav.isNavigating()).toBe(false)
    expect(f.nav.canSkipInitialDrafts(f.window)).toBe(true)
    expect(f.window.listenerCount('closed')).toBeGreaterThan(0)
    expect(f.window.webContents.listenerCount('did-navigate')).toBe(1)
    f.quit()
    expect(await startup).toBe(false)
    expect(await opening).toBe(false)
    expect(f.nav.snapshot()).toMatchObject({
      stopped: true,
      pendingReady: null,
      initialization: { state: 'cancelled', error: { code: 'MAIN_VIEW_LOAD_CANCELLED' } }
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(f.window.eventNames()).toEqual([])
    expect(f.window.webContents.eventNames()).toEqual([])
    expect(f.ready()).toBe(false)
    f.loads[0].resolve()
    await settle()
    expect(f.window.show).not.toHaveBeenCalled()
    expect(f.window.focus).not.toHaveBeenCalled()
  })

  it('invalidates a document only on committed navigation and preserves ever-ready through reload', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    f.issueDocument()
    f.ready()
    expect(await startup).toBe(true)
    f.window.hide()
    f.window.webContents.emit('did-start-navigation', {}, 'file:///blocked.html', false, true)
    expect(f.nav.isReadyDocument(f.window)).toBe(true)
    expect(f.nav.hasAcceptedReady(f.window)).toBe(true)
    expect(f.nav.canSkipInitialDrafts(f.window)).toBe(false)
    f.window.webContents.emit('did-navigate', {}, 'file:///test-renderer/index.html')
    expect(f.nav.isReadyDocument(f.window)).toBe(false)
    expect(f.nav.hasAcceptedReady(f.window)).toBe(true)
    expect(f.nav.isAwaitingFirstReady(f.window)).toBe(false)
    expect(f.nav.canSkipInitialDrafts(f.window)).toBe(false)
    expect(f.nav.requestInitialOpen(f.window)).toBeNull()
    f.issueDocument()
    expect(f.ready()).toBe(true)
    expect(f.nav.isReadyDocument(f.window)).toBe(true)
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
  })

  it('records a first renderer crash as failed without ever admitting a ready page', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    f.issueDocument()
    f.window.crash()
    expect(await startup).toBe(false)
    expect(f.nav.snapshot()).toMatchObject({
      unavailable: true,
      pendingReady: null,
      initialization: { state: 'failed', error: { code: 'MAIN_VIEW_RENDERER_CRASHED' } }
    })
    expect(f.nav.hasAcceptedReady(f.window)).toBe(false)
    expect(f.nav.isReadyDocument(f.window)).toBe(false)
    expect(f.nav.canSkipInitialDrafts(f.window)).toBe(true)
    expect(f.ready()).toBe(false)
    expect(f.window.show).not.toHaveBeenCalled()
    expect(f.window.focus).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hides a failed presentation and retains E1 protection for the page already exposed', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    f.ports.restoreBlurForVisibleWindow.mockImplementationOnce(() => {
      throw new Error('material restore failed')
    })
    f.issueDocument()
    expect(f.ready()).toBe(false)
    expect(await startup).toBe(false)
    expect(f.nav.snapshot().initialization).toMatchObject({
      state: 'failed',
      phase: 'presentation',
      error: { code: 'MAIN_VIEW_PRESENTATION_FAILED' }
    })
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.isVisible()).toBe(false)
    expect(f.window.focus).not.toHaveBeenCalled()
    expect(f.nav.hasAcceptedReady(f.window)).toBe(false)
    expect(f.nav.canSkipInitialDrafts(f.window)).toBe(false)
    const retry = f.nav.requestInitialOpen(f.window)
    await settle()
    expect(f.ports.confirmEditingDrafts).toHaveBeenCalledOnce()
    expect(f.loads).toHaveLength(2)
    f.issueDocument()
    expect(f.ready()).toBe(true)
    expect(await retry).toBe(true)
    expect(f.nav.hasAcceptedReady(f.window)).toBe(true)
  })

  it('releases a failed startup even when its diagnostic observer throws', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    f.ports.logger.error.mockImplementationOnce(() => {
      throw new Error('observer unavailable')
    })
    vi.advanceTimersByTime(15000)
    expect(await startup).toBe(false)
    expect(f.nav.snapshot()).toMatchObject({
      pendingReady: null,
      initialization: { state: 'failed', error: { code: 'MAIN_VIEW_READY_TIMEOUT' } }
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(f.window.webContents.listenerCount('destroyed')).toBe(0)
  })

  it('releases an old startup before a replacement window begins and ignores its late callbacks', async () => {
    const f = fixture()
    const startup = f.nav.startInitialView(f.window)
    const oldGeneration = f.issueDocument()
    const replacement = fakeWindow(2)
    f.replaceWindow(replacement)
    expect(await startup).toBe(false)
    expect(f.window.eventNames()).toEqual([])
    expect(f.window.webContents.eventNames()).toEqual([])
    const next = f.nav.startInitialView(replacement)
    expect(f.ready('list', oldGeneration, f.window.webContents)).toBe(false)
    f.loads[0].reject(new Error('old window load rejected'))
    await settle()
    expect(f.nav.snapshot().initialization).toMatchObject({ windowId: 2, state: 'pending' })
    f.issueDocument()
    expect(f.ready()).toBe(true)
    expect(await next).toBe(true)
    expect(f.window.show).not.toHaveBeenCalled()
    expect(replacement.show).toHaveBeenCalledOnce()
  })
})
