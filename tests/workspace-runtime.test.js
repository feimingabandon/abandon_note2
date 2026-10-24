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
function settingsSnapshot(values = createDefaultSettings(), revision = 1) {
  return { source: { token: 'workspace-document', scope: 'week' }, revision, values }
}
let api, documentTarget, scene, wallpaperElements
beforeEach(() => {
  wallpaperElements = []
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
    querySelectorAll: (selector) =>
      selector === '.app-wallpaper, .month-wallpaper' ? wallpaperElements : [],
    querySelector: () => scene
  }
  api = {
    getPresentationModeState: vi.fn(async () => ({ mode: 'expanded', supported: true })),
    onPresentationModeStateChanged: vi.fn(() => vi.fn()),
    onPresentationModeForceExpanded: vi.fn(() => vi.fn()),
    getSettingsSnapshot: vi.fn(async () => settingsSnapshot()),
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
    onWallpaperRetirementRequested: vi.fn(() => vi.fn()),
    onWallpaperRetirementCancelled: vi.fn(() => vi.fn()),
    acknowledgeWallpaperRetirement: vi.fn(async () => ({ accepted: true })),
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

function enterWallpaper(value) {
  const releaseImage = vi.fn()
  const element = {
    querySelector: () => ({ style: { removeProperty: releaseImage } }),
    releaseImage
  }
  wallpaperElements.push(element)
  value.transitionHooks().onBeforeEnter(element)
  return element
}

function requestWallpaperRetirement(id) {
  api.onWallpaperRetirementRequested.mock.calls[0][0]({
    id,
    source: { token: 'workspace-document', scope: 'week' }
  })
}

function finishWallpaperLeave(hooks, element) {
  wallpaperElements = wallpaperElements.filter((current) => current !== element)
  hooks.onAfterLeave(element)
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

  it('releases the early settings subscription and does not apply or announce ready after unmount', async () => {
    const request = deferred()
    api.getSettingsSnapshot.mockReturnValue(request.promise)
    const apply = vi.fn()
    const { app } = mount(() => useWorkspaceRuntime(runtimeOptions({ onSnapshot: apply })))
    await flush()
    app.unmount()
    request.resolve(settingsSnapshot())
    await flush()
    expect(apply).not.toHaveBeenCalled()
    expect(api.onSettingsChanged).toHaveBeenCalledOnce()
    expect(api.onSettingsChanged.mock.results[0].value).toHaveBeenCalledOnce()
    expect(api.rendererReady).not.toHaveBeenCalled()
    expect(api.onPresentationModeStateChanged.mock.results[0].value).toHaveBeenCalledOnce()
  })

  it('subscribes before reading and initializes from a newer accepted broadcast without replaying old fields', async () => {
    const request = deferred()
    api.getSettingsSnapshot.mockReturnValue(request.promise)
    const applied = vi.fn(),
      initialized = vi.fn(),
      changed = vi.fn(),
      applyCss = vi.fn()
    mount(() =>
      useWorkspaceRuntime(
        runtimeOptions({
          onSnapshot: applied,
          onInitialSnapshot: initialized,
          onSettingsChanged: changed,
          applyCss
        })
      )
    )
    await flush()
    expect(api.onSettingsChanged.mock.invocationCallOrder[0]).toBeLessThan(
      api.getPresentationModeState.mock.invocationCallOrder[0]
    )
    expect(api.onSettingsChanged.mock.invocationCallOrder[0]).toBeLessThan(
      api.getSettingsSnapshot.mock.invocationCallOrder[0]
    )
    const values = createDefaultSettings()
    values.css.fontSizeBase = 22
    values.notes.tagColorEnabled = false
    const latest = settingsSnapshot(values, 2)
    const broadcast = api.onSettingsChanged.mock.calls[0][0]
    broadcast(latest)
    request.resolve(settingsSnapshot(createDefaultSettings(), 1))
    await flush()
    expect(applied).toHaveBeenCalledExactlyOnceWith(latest)
    expect(applyCss).toHaveBeenCalledExactlyOnceWith(latest)
    expect(initialized).toHaveBeenCalledExactlyOnceWith(latest)
    expect(changed).toHaveBeenCalledExactlyOnceWith(latest)
    expect(api.rendererReady).toHaveBeenCalledExactlyOnceWith('week')
    broadcast({
      ...settingsSnapshot(createDefaultSettings(), 99),
      source: { token: 'old-document', scope: 'week' }
    })
    broadcast(settingsSnapshot(createDefaultSettings(), 1))
    expect(applied).toHaveBeenCalledOnce()
    expect(applyCss).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledOnce()
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
    api.onSettingsChanged.mock.calls[0][0](settingsSnapshot({}, 2))
    expect(list.locked.value).toBe(true)
    expect(month.locked.value).toBe(createDefaultSettings().window.lockState)
  })
})

describe('view-specific wallpaper policy', () => {
  it('deduplicates list reads and retains the image until its actual leave, including reversal', async () => {
    vi.useFakeTimers()
    const request = deferred()
    api.getWallpaperData.mockReturnValue(request.promise)
    const { value } = mount(() =>
      useWorkspaceWallpaper({
        defaults: createDefaultSettings(),
        cacheLoads: true,
        label: 'list',
        api
      })
    )
    const first = value.sync(wallpaperSnapshot(4))
    const second = value.sync(wallpaperSnapshot(4))
    expect(api.getWallpaperData).toHaveBeenCalledExactlyOnceWith(4, false)
    request.resolve('data:list')
    await Promise.all([first, second])
    const element = enterWallpaper(value)
    await value.sync(wallpaperSnapshot(4, false))
    const oldLeave = value.transitionHooks()
    oldLeave.onBeforeLeave(element)
    expect(value.wallpaperUrl.value).toBe('data:list')
    await vi.advanceTimersByTimeAsync(1000)
    expect(value.wallpaperUrl.value).toBe('data:list')
    await value.sync(wallpaperSnapshot(4))
    value.transitionHooks().onBeforeEnter(element)
    oldLeave.onAfterLeave(element)
    expect(value.wallpaperVisible.value).toBe(true)
    expect(value.wallpaperUrl.value).toBe('data:list')
    expect(api.getWallpaperData).toHaveBeenCalledOnce()
    await value.sync(wallpaperSnapshot(4, false))
    const finalLeave = value.transitionHooks()
    finalLeave.onBeforeLeave(element)
    oldLeave.onAfterLeave(element)
    expect(value.wallpaperUrl.value).toBe('data:list')
    expect(element.releaseImage).not.toHaveBeenCalled()
    finishWallpaperLeave(finalLeave, element)
    await flush()
    expect(value.wallpaperUrl.value).toBe('')
    expect(value.wallpaperRenderKey.value).toBe(null)
  })

  it('keeps calendar fresh reads, discards old-id completion and releases after the same node leaves', async () => {
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
    const element = enterWallpaper(value)
    await value.sync(wallpaperSnapshot(2))
    expect(api.getWallpaperData).toHaveBeenCalledTimes(3)
    await value.sync(wallpaperSnapshot(2, false))
    const leave = value.transitionHooks()
    leave.onBeforeLeave(element)
    expect(value.wallpaperUrl.value).toBe('data:fresh')
    finishWallpaperLeave(leave, element)
    await flush()
    expect(value.wallpaperUrl.value).toBe('')
    expect(value.wallpaperRenderKey.value).toBe(null)
    expect(element.releaseImage).toHaveBeenCalledExactlyOnceWith('background-image')
  })

  it('does not acknowledge temporarily missing startup nodes before observing a hidden snapshot', async () => {
    const request = deferred()
    api.getWallpaperData.mockReturnValue(request.promise)
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'fixture', api })
    )
    const load = value.sync(wallpaperSnapshot(8))
    requestWallpaperRetirement('startup-retirement')
    await flush()
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    await value.sync(wallpaperSnapshot(8, false))
    await flush()
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledExactlyOnceWith({
      id: 'startup-retirement',
      outcome: 'absent'
    })
    request.resolve('data:late-startup')
    await load
    expect(value.wallpaperVisible.value).toBe(false)
    expect(value.wallpaperUrl.value).toBe('')
  })

  it('confirms absence only after the hidden DOM update and never from a request with no snapshot', async () => {
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'fixture', api })
    )
    requestWallpaperRetirement('no-snapshot')
    await flush()
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    const hidden = value.sync(wallpaperSnapshot(null, false))
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    await hidden
    await flush()
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledExactlyOnceWith({
      id: 'no-snapshot',
      outcome: 'absent'
    })
  })

  it('does not substitute missing active data or effective blur for an explicit wallpaper disable', async () => {
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'fixture', api })
    )
    await value.sync(wallpaperSnapshot(null))
    requestWallpaperRetirement('explicit-disable')
    await flush()
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    await value.sync({
      ...wallpaperSnapshot(4),
      runtime: { blur: { effectiveEnabled: true } }
    })
    await flush()
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    await value.sync(wallpaperSnapshot(4, false))
    await flush()
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledExactlyOnceWith({
      id: 'explicit-disable',
      outcome: 'absent'
    })
  })

  it('waits for every actual wallpaper element and acknowledges a duplicated ticket only once', async () => {
    api.getWallpaperData.mockResolvedValue('data:visible')
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'fixture', api })
    )
    await value.sync(wallpaperSnapshot(4))
    const first = enterWallpaper(value)
    const second = enterWallpaper(value)
    requestWallpaperRetirement('all-elements')
    requestWallpaperRetirement('all-elements')
    await value.sync(wallpaperSnapshot(4, false))
    const firstLeave = value.transitionHooks()
    const secondLeave = value.transitionHooks()
    firstLeave.onBeforeLeave(first)
    secondLeave.onBeforeLeave(second)
    finishWallpaperLeave(firstLeave, first)
    await flush()
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    expect(value.wallpaperUrl.value).toBe('data:visible')
    finishWallpaperLeave(secondLeave, second)
    await flush()
    secondLeave.onAfterLeave(second)
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledExactlyOnceWith({
      id: 'all-elements',
      outcome: 'left'
    })
    expect(value.wallpaperUrl.value).toBe('')
  })

  it('lets a later request wait on an already running real leave', async () => {
    api.getWallpaperData.mockResolvedValue('data:visible')
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'fixture', api })
    )
    await value.sync(wallpaperSnapshot(4))
    const element = enterWallpaper(value)
    await value.sync(wallpaperSnapshot(4, false))
    const leave = value.transitionHooks()
    leave.onBeforeLeave(element)
    requestWallpaperRetirement('already-leaving')
    await flush()
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    finishWallpaperLeave(leave, element)
    await flush()
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledExactlyOnceWith({
      id: 'already-leaving',
      outcome: 'left'
    })
  })

  it('isolates an old callback from a new leave and ticket on the same reversed node', async () => {
    api.getWallpaperData.mockResolvedValue('data:visible')
    const { value } = mount(() =>
      useWorkspaceWallpaper({
        defaults: createDefaultSettings(),
        cacheLoads: true,
        label: 'list',
        api
      })
    )
    await value.sync(wallpaperSnapshot(4))
    const element = enterWallpaper(value)
    requestWallpaperRetirement('old-ticket')
    await value.sync(wallpaperSnapshot(4, false))
    const oldLeave = value.transitionHooks()
    oldLeave.onBeforeLeave(element)
    await value.sync(wallpaperSnapshot(4))
    value.transitionHooks().onBeforeEnter(element)
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledExactlyOnceWith({
      id: 'old-ticket',
      outcome: 'cancelled',
      reason: 'wallpaper-shown-or-replaced'
    })
    requestWallpaperRetirement('new-ticket')
    await value.sync(wallpaperSnapshot(4, false))
    const newLeave = value.transitionHooks()
    newLeave.onBeforeLeave(element)
    oldLeave.onAfterLeave(element)
    oldLeave.onLeaveCancelled(element)
    await flush()
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledOnce()
    expect(element.releaseImage).not.toHaveBeenCalled()
    expect(value.wallpaperUrl.value).toBe('data:visible')
    finishWallpaperLeave(newLeave, element)
    await flush()
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenLastCalledWith({
      id: 'new-ticket',
      outcome: 'left'
    })
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledTimes(2)
  })

  it('releases only the departing image when a different wallpaper replaces it', async () => {
    api.getWallpaperData.mockResolvedValueOnce('data:old').mockResolvedValueOnce('data:new')
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'calendar', api })
    )
    await value.sync(wallpaperSnapshot(1))
    const oldElement = enterWallpaper(value)
    requestWallpaperRetirement('replaced-image')
    await value.sync(wallpaperSnapshot(2))
    const oldLeave = value.transitionHooks()
    oldLeave.onBeforeLeave(oldElement)
    const newElement = enterWallpaper(value)
    finishWallpaperLeave(oldLeave, oldElement)
    await flush()
    expect(value.wallpaperUrl.value).toBe('data:new')
    expect(value.wallpaperRenderKey.value).toBe(2)
    expect(oldElement.releaseImage).toHaveBeenCalledOnce()
    expect(newElement.releaseImage).not.toHaveBeenCalled()
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledExactlyOnceWith({
      id: 'replaced-image',
      outcome: 'cancelled',
      reason: 'wallpaper-shown-or-replaced'
    })
  })

  it('releases the current hidden image when a replacement layer finishes before the older layer', async () => {
    api.getWallpaperData.mockResolvedValueOnce('data:old').mockResolvedValueOnce('data:new')
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'calendar', api })
    )
    await value.sync(wallpaperSnapshot(1))
    const oldElement = enterWallpaper(value)
    await value.sync(wallpaperSnapshot(2))
    const oldLeave = value.transitionHooks()
    oldLeave.onBeforeLeave(oldElement)
    const newElement = enterWallpaper(value)
    requestWallpaperRetirement('overlapping-layers')
    await value.sync(wallpaperSnapshot(2, false))
    const newLeave = value.transitionHooks()
    newLeave.onBeforeLeave(newElement)
    finishWallpaperLeave(newLeave, newElement)
    await flush()
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    expect(value.wallpaperUrl.value).toBe('data:new')
    finishWallpaperLeave(oldLeave, oldElement)
    await flush()
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledExactlyOnceWith({
      id: 'overlapping-layers',
      outcome: 'left'
    })
    expect(value.wallpaperUrl.value).toBe('')
    expect(oldElement.releaseImage).toHaveBeenCalledOnce()
    expect(newElement.releaseImage).toHaveBeenCalledOnce()
  })

  it('invalidates a main cancellation without a late acknowledgment but still releases the leaving image', async () => {
    api.getWallpaperData.mockResolvedValue('data:visible')
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'fixture', api })
    )
    await value.sync(wallpaperSnapshot(4))
    const element = enterWallpaper(value)
    requestWallpaperRetirement('main-cancelled')
    await value.sync(wallpaperSnapshot(4, false))
    const leave = value.transitionHooks()
    leave.onBeforeLeave(element)
    api.onWallpaperRetirementCancelled.mock.calls[0][0]({ id: 'unrelated', reason: 'hidden' })
    api.onWallpaperRetirementCancelled.mock.calls[0][0]({ id: 'main-cancelled', reason: 'hidden' })
    finishWallpaperLeave(leave, element)
    await flush()
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    expect(value.wallpaperUrl.value).toBe('')
    expect(element.releaseImage).toHaveBeenCalledOnce()
  })

  it('cancels the captured leave once and does not release an element whose leave was cancelled', async () => {
    api.getWallpaperData.mockResolvedValue('data:visible')
    const { value } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'fixture', api })
    )
    await value.sync(wallpaperSnapshot(4))
    const element = enterWallpaper(value)
    requestWallpaperRetirement('cancelled-leave')
    await value.sync(wallpaperSnapshot(4, false))
    const leave = value.transitionHooks()
    leave.onBeforeLeave(element)
    leave.onLeaveCancelled(element)
    leave.onAfterLeave(element)
    await flush()
    expect(api.acknowledgeWallpaperRetirement).toHaveBeenCalledExactlyOnceWith({
      id: 'cancelled-leave',
      outcome: 'cancelled',
      reason: 'leave-cancelled'
    })
    expect(element.releaseImage).not.toHaveBeenCalled()
    expect(value.wallpaperUrl.value).toBe('data:visible')
  })

  it('unsubscribes and releases images on unmount without acknowledging stale events or callbacks', async () => {
    api.getWallpaperData.mockResolvedValue('data:visible')
    const { value, app } = mount(() =>
      useWorkspaceWallpaper({ defaults: createDefaultSettings(), label: 'fixture', api })
    )
    await value.sync(wallpaperSnapshot(4))
    const element = enterWallpaper(value)
    requestWallpaperRetirement('unmounted')
    await value.sync(wallpaperSnapshot(4, false))
    const leave = value.transitionHooks()
    leave.onBeforeLeave(element)
    app.unmount()
    finishWallpaperLeave(leave, element)
    requestWallpaperRetirement('late-event')
    await flush()
    expect(api.acknowledgeWallpaperRetirement).not.toHaveBeenCalled()
    expect(api.onWallpaperRetirementRequested.mock.results[0].value).toHaveBeenCalledOnce()
    expect(api.onWallpaperRetirementCancelled.mock.results[0].value).toHaveBeenCalledOnce()
    expect(element.releaseImage).toHaveBeenCalledOnce()
    expect(value.wallpaperUrl.value).toBe('')
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

  it.each(['current', 'error', 'available'])(
    'shows a manual %s result when it joins an older silent request',
    async (status) => {
      vi.useFakeTimers()
      const request = deferred()
      api.checkForUpdate.mockReturnValue(request.promise)
      const { value } = mount(() => useUpdateCheck({ policy: 'list', label: 'fixture', api }))
      const silent = value.checkForUpdates({ showResult: false })
      await vi.advanceTimersByTimeAsync(900)
      expect(value.showUpdateDialog.value).toBe(false)
      const manual = value.checkForUpdates()
      expect(value.showUpdateDialog.value).toBe(true)
      expect(value.updateChecking.value).toBe(true)
      request.resolve({ status, currentVersion: '1.3.0' })
      await flush()
      expect(api.checkForUpdate).toHaveBeenCalledOnce()
      expect(value.updateResult.value.status).toBe(status)
      await vi.advanceTimersByTimeAsync(499)
      expect(value.updateChecking.value).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      await Promise.all([silent, manual])
      expect(value.updateChecking.value).toBe(false)
      expect(value.showUpdateDialog.value).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('retains later manual feedback during the minimum wait without repeating the request', async () => {
    vi.useFakeTimers()
    const request = deferred()
    api.checkForUpdate.mockReturnValueOnce(request.promise)
    const { value } = mount(() => useUpdateCheck({ policy: 'list', label: 'fixture', api }))
    const first = value.checkForUpdates()
    await vi.advanceTimersByTimeAsync(100)
    const second = value.checkForUpdates()
    request.resolve({ status: 'current' })
    await flush()
    await vi.advanceTimersByTimeAsync(200)
    value.showUpdateDialog.value = false
    const third = value.checkForUpdates()
    expect(value.showUpdateDialog.value).toBe(true)
    await vi.advanceTimersByTimeAsync(499)
    expect(value.updateChecking.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second, third])
    expect(value.updateChecking.value).toBe(false)
    expect(api.checkForUpdate).toHaveBeenCalledOnce()
    const next = value.checkForUpdates()
    await vi.advanceTimersByTimeAsync(500)
    await next
    expect(api.checkForUpdate).toHaveBeenCalledTimes(2)
  })

  it('retains a manual intent that arrives while a rejected silent check reads app info', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const info = deferred()
    api.checkForUpdate.mockRejectedValue(new Error('transport unavailable'))
    api.getAppInfo.mockReturnValue(info.promise)
    const { value } = mount(() => useUpdateCheck({ policy: 'list', label: 'fixture', api }))
    const silent = value.checkForUpdates({ showResult: false })
    await flush()
    expect(api.getAppInfo).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(800)
    const manual = value.checkForUpdates()
    expect(value.showUpdateDialog.value).toBe(true)
    info.resolve({ version: '1.3.0' })
    await flush()
    expect(value.updateResult.value).toMatchObject({
      status: 'error',
      currentVersion: '1.3.0',
      error: '检查更新失败：transport unavailable'
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(value.updateChecking.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([silent, manual])
    expect(value.updateChecking.value).toBe(false)
    expect(api.checkForUpdate).toHaveBeenCalledOnce()
  })

  it('does not start a fallback request or show feedback for a rejection after unmount', async () => {
    vi.useFakeTimers()
    const request = deferred()
    api.checkForUpdate.mockReturnValue(request.promise)
    const { value, app } = mount(() => useUpdateCheck({ policy: 'list', label: 'fixture', api }))
    const check = value.checkForUpdates({ showResult: false })
    app.unmount()
    request.reject(new Error('late transport rejection'))
    await check
    expect(api.getAppInfo).not.toHaveBeenCalled()
    expect(value.updateResult.value).toBeNull()
    expect(value.showUpdateDialog.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an app-info fallback that finishes after its update owner unmounts', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const info = deferred()
    api.checkForUpdate.mockRejectedValue(new Error('transport unavailable'))
    api.getAppInfo.mockReturnValue(info.promise)
    const { value, app } = mount(() => useUpdateCheck({ policy: 'list', label: 'fixture', api }))
    const check = value.checkForUpdates()
    await flush()
    expect(api.getAppInfo).toHaveBeenCalledOnce()
    app.unmount()
    info.resolve({ version: 'old' })
    await check
    expect(value.updateResult.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases an outstanding minimum wait without changing a new owner', async () => {
    vi.useFakeTimers()
    const old = mount(() => useUpdateCheck({ policy: 'list', label: 'old', api }))
    const first = old.value.checkForUpdates()
    await flush()
    expect(vi.getTimerCount()).toBe(1)
    old.app.unmount()
    const current = mount(() => useUpdateCheck({ policy: 'list', label: 'current', api }))
    const second = current.value.checkForUpdates()
    await first
    expect(current.value.updateChecking.value).toBe(true)
    expect(current.value.showUpdateDialog.value).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    await second
    expect(current.value.updateChecking.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('schedules one silent list check and shares it with the manual request', async () => {
    vi.useFakeTimers()
    const request = deferred()
    api.checkForUpdate.mockReturnValue(request.promise)
    const { value } = mount(() => useUpdateCheck({ policy: 'list', label: 'fixture', api }))
    value.scheduleStartup()
    value.scheduleStartup()
    await vi.advanceTimersByTimeAsync(1199)
    expect(api.checkForUpdate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.checkForUpdate).toHaveBeenCalledOnce()
    expect(value.showUpdateDialog.value).toBe(false)
    const manual = value.checkForUpdates()
    request.resolve({ status: 'current' })
    await vi.advanceTimersByTimeAsync(500)
    await manual
    expect(api.checkForUpdate).toHaveBeenCalledOnce()
    expect(value.showUpdateDialog.value).toBe(true)
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
