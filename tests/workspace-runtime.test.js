import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, h, nextTick } from 'vue'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
import { useWorkspaceRuntime } from '../src/renderer/src/composables/useWorkspaceRuntime.js'
import { useWorkspaceWallpaper } from '../src/renderer/src/composables/useWorkspaceWallpaper.js'
import { useWorkspaceNotices } from '../src/renderer/src/composables/useWorkspaceNotices.js'
import { useUpdateCheck } from '../src/renderer/src/composables/useUpdateCheck.js'

const apps = []
const renderer = createRenderer({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert() {},
  remove() {},
  setText() {},
  setElementText() {},
  patchProp() {},
  parentNode: () => null,
  nextSibling: () => null
})
function mount(setup) {
  let value
  const app = renderer.createApp({
    setup() {
      value = setup()
      return () => h('div')
    }
  })
  app.mount({})
  apps.push(app)
  return { value, app }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let index = 0; index < 8; index += 1) await nextTick()
}
let api, documentTarget, scene
beforeEach(() => {
  const classes = new Set()
  scene = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    }
  }
  documentTarget = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelectorAll: () => [],
    querySelector: () => scene
  }
  api = {
    getPresentationModeState: vi.fn(async () => ({ mode: 'expanded', supported: true })),
    onPresentationModeStateChanged: vi.fn(() => vi.fn()),
    onPresentationModeForceExpanded: vi.fn(() => vi.fn()),
    getSettingsSnapshot: vi.fn(async () => ({ values: createDefaultSettings() })),
    onSettingsChanged: vi.fn(() => vi.fn()),
    onNotesChanged: vi.fn(() => vi.fn()),
    onAppMessage: vi.fn(() => vi.fn()),
    onRemoteNoticesChanged: vi.fn(() => vi.fn()),
    rendererReady: vi.fn(),
    windowHover: vi.fn(),
    listPendingRemoteNotices: vi.fn(async () => []),
    getHolidayDataNotice: vi.fn(async () => ({ required: false })),
    dismissHolidayDataNotice: vi.fn(async () => {}),
    getWallpaperData: vi.fn(),
    checkForUpdate: vi.fn(async () => ({ status: 'current' })),
    getAppInfo: vi.fn(async () => ({ version: '1.3.0' }))
  }
  vi.stubGlobal('document', documentTarget)
  vi.stubGlobal('window', { api, getComputedStyle: () => ({ zIndex: '0' }) })
})
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await flush()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function runtimeOptions(extra = {}) {
  return {
    defaults: createDefaultSettings(),
    getViewMode: () => 'week',
    label: 'fixture',
    api,
    documentTarget,
    applyCss: vi.fn(),
    ...extra
  }
}
function wallpaperSnapshot(id, enabled = true) {
  return {
    values: { wallpaper: { enabled, activeId: id, blurRadius: 5 } },
    runtime: { blur: { effectiveEnabled: false } }
  }
}

describe('workspace lifecycle ownership', () => {
  it('acknowledges calendar ready only after initialization and child content are both ready', async () => {
    const initialization = deferred()
    const apply = vi.fn()
    const { value } = mount(() =>
      useWorkspaceRuntime(
        runtimeOptions({
          waitForContent: true,
          beforeReady: () => initialization.promise,
          onSnapshot: apply
        })
      )
    )
    await flush()
    expect(apply).toHaveBeenCalledOnce()
    expect(api.rendererReady).not.toHaveBeenCalled()
    initialization.resolve()
    await flush()
    expect(api.rendererReady).not.toHaveBeenCalled()
    value.markContentReady()
    await flush()
    expect(api.rendererReady).toHaveBeenCalledExactlyOnceWith('week')
    value.markContentReady()
    await flush()
    expect(api.rendererReady).toHaveBeenCalledOnce()
  })

  it('does not install subscriptions or announce ready when settings completes after unmount', async () => {
    const request = deferred()
    api.getSettingsSnapshot.mockReturnValue(request.promise)
    const apply = vi.fn()
    const { app } = mount(() => useWorkspaceRuntime(runtimeOptions({ onSnapshot: apply })))
    await flush()
    app.unmount()
    request.resolve({ values: createDefaultSettings() })
    await flush()
    expect(apply).not.toHaveBeenCalled()
    expect(api.onSettingsChanged).not.toHaveBeenCalled()
    expect(api.rendererReady).not.toHaveBeenCalled()
    expect(api.onPresentationModeStateChanged.mock.results[0].value).toHaveBeenCalledOnce()
  })

  it('releases each subscription, document listener and retained blur ticket once', async () => {
    const { value, app } = mount(() =>
      useWorkspaceRuntime(runtimeOptions({ hoverPhase: 'setup', onNotesChanged: vi.fn() }))
    )
    await flush()
    value.retainBlur('settings')
    value.retainBlur('settings')
    value.retainBlur('editor')
    value.releaseBlur('settings')
    expect(scene.classList.contains('is-ui-background-blurred')).toBe(true)
    app.unmount()
    value.releaseBlur('editor')
    expect(scene.classList.contains('is-ui-background-blurred')).toBe(false)
    for (const method of [
      'onSettingsChanged',
      'onNotesChanged',
      'onAppMessage',
      'onRemoteNoticesChanged'
    ])
      expect(api[method].mock.results[0].value).toHaveBeenCalledOnce()
    expect(documentTarget.addEventListener.mock.calls.map(([name]) => name)).toEqual([
      'mouseenter',
      'mouseleave'
    ])
    expect(documentTarget.removeEventListener.mock.calls.map(([name]) => name)).toEqual([
      'mouseenter',
      'mouseleave'
    ])
  })

  it('preserves list window fields on missing payload while month/week use their explicit defaults', async () => {
    const { value: list } = mount(() => useWorkspaceRuntime(runtimeOptions()))
    const { value: month } = mount(() =>
      useWorkspaceRuntime(runtimeOptions({ windowFallback: true }))
    )
    await flush()
    list.locked.value = true
    month.locked.value = true
    list.applySnapshot({ values: {} })
    month.applySnapshot({ values: {} })
    expect(list.locked.value).toBe(true)
    expect(month.locked.value).toBe(createDefaultSettings().window.lockState)
  })
})

describe('view-specific wallpaper policy', () => {
  it('deduplicates list pending/cache reads and keeps its image through a reversed exit', async () => {
    vi.useFakeTimers()
    const request = deferred()
    api.getWallpaperData.mockReturnValue(request.promise)
    const { value } = mount(() =>
      useWorkspaceWallpaper({
        defaults: createDefaultSettings(),
        cacheLoads: true,
        releaseDelayMs: 220,
        label: 'list',
        api
      })
    )
    const first = value.sync(wallpaperSnapshot(4))
    const second = value.sync(wallpaperSnapshot(4))
    expect(api.getWallpaperData).toHaveBeenCalledExactlyOnceWith(4, false)
    request.resolve('data:list')
    await Promise.all([first, second])
    await value.sync(wallpaperSnapshot(4, false))
    expect(value.wallpaperUrl.value).toBe('data:list')
    await vi.advanceTimersByTimeAsync(100)
    await value.sync(wallpaperSnapshot(4))
    await vi.advanceTimersByTimeAsync(200)
    expect(value.wallpaperVisible.value).toBe(true)
    expect(value.wallpaperUrl.value).toBe('data:list')
    expect(api.getWallpaperData).toHaveBeenCalledOnce()
    await value.sync(wallpaperSnapshot(4, false))
    await vi.advanceTimersByTimeAsync(220)
    expect(value.wallpaperUrl.value).toBe('')
    expect(value.wallpaperRenderKey.value).toBe(null)
  })

  it('keeps calendar fresh-read/immediate-release behavior and discards old-id completion', async () => {
    const old = deferred(),
      current = deferred()
    api.getWallpaperData
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise)
      .mockResolvedValue('data:fresh')
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'calendar', api })
    )
    const first = value.sync(wallpaperSnapshot(1))
    const second = value.sync(wallpaperSnapshot(2))
    current.resolve('data:current')
    await second
    old.resolve('data:old')
    await first
    expect(value.wallpaperUrl.value).toBe('data:current')
    await value.sync(wallpaperSnapshot(2))
    expect(api.getWallpaperData).toHaveBeenCalledTimes(3)
    await value.sync(wallpaperSnapshot(2, false))
    expect(value.wallpaperUrl.value).toBe('')
    expect(value.wallpaperRenderKey.value).toBe(null)
  })

  it('does not commit an in-flight wallpaper after its root unmounts', async () => {
    const request = deferred()
    api.getWallpaperData.mockReturnValue(request.promise)
    const { value, app } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'fixture', api })
    )
    const load = value.sync(wallpaperSnapshot(8))
    app.unmount()
    request.resolve('data:late')
    await load
    expect(value.wallpaperVisible.value).toBe(false)
    expect(value.wallpaperUrl.value).toBe('')
  })
})

describe('notices and update policy', () => {
  it('retains notice acknowledgment and first-use reset semantics without interrupting active requests', async () => {
    const showMessage = vi.fn()
    api.listPendingRemoteNotices.mockResolvedValue([{ id: 1 }, { id: 2 }])
    const { value } = mount(() =>
      useWorkspaceNotices({ showMessage, openSettings: vi.fn(), label: 'fixture', api })
    )
    value.applyInitialSnapshot({ values: { onboarding: { noticeVersion: 0 } } })
    expect(value.showFirstUseNotice.value).toBe(true)
    value.onFirstUseCompleted({ route: 'support' })
    expect(showMessage.mock.calls[0][1]).toContain('感谢你的支持')
    await value.loadPendingRemoteNotices({ show: true })
    value.onRemoteNoticeAcknowledged(1)
    expect(value.showRemoteNoticeDialog.value).toBe(true)
    value.onRemoteNoticeAcknowledged(2)
    expect(value.showRemoteNoticeDialog.value).toBe(false)
    value.revealFirstUseNoticeFromSnapshot({ values: { onboarding: { noticeVersion: 0 } } })
    expect(value.showFirstUseNotice.value).toBe(true)
  })

  it('cancels holiday delayed-settings ownership and ignores notice loads after unmount', async () => {
    vi.useFakeTimers()
    const remote = deferred()
    const openSettings = vi.fn()
    api.getHolidayDataNotice.mockResolvedValue({ required: true, year: 2027 })
    api.listPendingRemoteNotices.mockReturnValue(remote.promise)
    const { value, app } = mount(() =>
      useWorkspaceNotices({ showMessage: vi.fn(), openSettings, label: 'fixture', api })
    )
    await value.loadHolidayDataNotice()
    await value.dismissHolidayDataNotice({ openSettingsAfter: true })
    expect(api.dismissHolidayDataNotice).toHaveBeenCalledExactlyOnceWith(2027)
    const request = value.loadPendingRemoteNotices({ show: true })
    app.unmount()
    remote.resolve([{ id: 'late' }])
    await request
    await vi.advanceTimersByTimeAsync(220)
    expect(openSettings).not.toHaveBeenCalled()
    expect(value.pendingRemoteNotices.value).toEqual([])
  })

  it('keeps list manual minimum duration and only shows an available silent result', async () => {
    vi.useFakeTimers()
    const { value } = mount(() => useUpdateCheck({ policy: 'list', label: 'fixture', api }))
    const manual = value.checkForUpdates()
    await flush()
    expect(value.updateChecking.value).toBe(true)
    await vi.advanceTimersByTimeAsync(499)
    expect(value.updateChecking.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await manual
    expect(value.updateChecking.value).toBe(false)
    value.showUpdateDialog.value = false
    await value.checkForUpdates({ showResult: false })
    expect(value.showUpdateDialog.value).toBe(false)
    api.checkForUpdate.mockResolvedValue({ status: 'available' })
    await value.checkForUpdates({ showResult: false })
    expect(value.showUpdateDialog.value).toBe(true)
  })

  it('keeps calendar manual checks immediate and never installs a startup update check', async () => {
    vi.useFakeTimers()
    const { value } = mount(() => useUpdateCheck({ policy: 'calendar', label: 'fixture', api }))
    value.scheduleStartup()
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.checkForUpdate).not.toHaveBeenCalled()
    await value.checkForUpdates()
    expect(value.showUpdateDialog.value).toBe(true)
    expect(value.updateChecking.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases startup/minimum timers and suppresses a late update modal after unmount', async () => {
    vi.useFakeTimers()
    const request = deferred()
    api.checkForUpdate.mockReturnValue(request.promise)
    const { value, app } = mount(() => useUpdateCheck({ policy: 'list', label: 'fixture', api }))
    value.scheduleStartup()
    const check = value.checkForUpdates({ showResult: false })
    app.unmount()
    request.resolve({ status: 'available' })
    await check
    await vi.advanceTimersByTimeAsync(1500)
    expect(value.showUpdateDialog.value).toBe(false)
    expect(api.checkForUpdate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
