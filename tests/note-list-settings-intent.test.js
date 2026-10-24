import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
import { getSettingsSnapshotStore } from '../src/renderer/src/utils/settingsSnapshots.js'

// Run the actual NoteList setup, filter watchers and query models. Only DOM
// animation, child controls, date/weather providers and native IPC are isolated.
const componentUrl = new URL('../src/renderer/src/components/list/NoteList.vue', import.meta.url)
const apps = new Set()
const renderer = vue.createRenderer({
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

async function componentAt(motion, { realWeather = false } = {}) {
  const { descriptor } = parse(readFileSync(componentUrl, 'utf8'))
  let code = compileScript(descriptor, { id: 'note-list-settings-intent' }).content
  const imports = babelParse(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = []
  const declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    let dependency
    if (name === 'vue') dependency = vue
    else if (name.endsWith('.vue') || name === 'vuedraggable') dependency = { default: {} }
    else if (name.endsWith('/useQueuedModal.js'))
      dependency = {
        useModalRequest: () => ({ requested: vue.ref(false), visible: vue.ref(false) })
      }
    else if (name.endsWith('/useSharedMinuteClock.js'))
      dependency = { useSharedMinuteClock: () => vue.ref(Date.now()) }
    else if (name.endsWith('/useTodayKey.js'))
      dependency = { useTodayKey: () => vue.ref('2026-10-20') }
    else if (name.endsWith('/useWeatherRecovery.js')) dependency = { useWeatherRecovery() {} }
    else if (name.endsWith('/useDateContextSettings.js') && !realWeather)
      dependency = {
        useDateContextSettings: () => ({
          weatherEnabled: vue.ref(false),
          almanacEnabled: vue.ref(false),
          forecast: vue.ref(null),
          settingsReady: getSettingsSnapshotStore(window.api).read()
        })
      }
    else if (name.endsWith('/useMessage.js'))
      dependency = { useMessage: () => ({ showMessage: vi.fn() }) }
    else if (name.endsWith('/useNotePresenceMotion.js'))
      dependency = { useNotePresenceMotion: () => motion }
    else dependency = await import(new URL(name, componentUrl).href)
    dependencies.push(dependency)
    for (const specifier of node.specifiers) {
      const imported =
        specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name
      declarations.push(
        `const ${specifier.local.name}=dependencies[${index}][${JSON.stringify(imported)}];`
      )
    }
  }
  for (const node of [...imports].reverse()) code = code.slice(0, node.start) + code.slice(node.end)
  return new Function(
    'dependencies',
    declarations.join('\n') + code.replace('export default', 'return')
  )(dependencies)
}

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let index = 0; index < 20; index++) await vue.nextTick()
}
function fixture({ weather = false } = {}) {
  const values = createDefaultSettings()
  values.listFilter = { listMode: 'timeline', tagIds: [], statusFilter: [] }
  values.weather.enabled = weather
  const location = { name: '北京', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }
  values.weather.location = location
  let revision = 1
  const listeners = new Set()
  const forecastListeners = new Set()
  const snapshot = () => ({
    source: { token: 'note-list-settings-document', scope: 'main' },
    revision,
    values: structuredClone(values)
  })
  const broadcast = () => {
    revision += 1
    const result = snapshot()
    for (const listener of listeners) listener(result)
    return result
  }
  const commitFilter = (value, { emit = true } = {}) => {
    values.listFilter = structuredClone(value)
    revision += 1
    const result = snapshot()
    if (emit) for (const listener of listeners) listener(result)
    return result
  }
  const api = {
    getWeatherForecast: vi.fn(async () => ({ location, days: [] })),
    onWeatherForecastUpdated: vi.fn((listener) => {
      forecastListeners.add(listener)
      return () => forecastListeners.delete(listener)
    }),
    getSettingsSnapshot: vi.fn(async () => snapshot()),
    onSettingsChanged: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    setSettingValue: vi.fn(async (_id, value) => commitFilter(value)),
    queryPinnedNotes: vi.fn(async () => []),
    queryRecentNotes: vi.fn(async () => []),
    queryEarlierNotes: vi.fn(async () => ({ notes: [], total: 0 })),
    queryCustomPinned: vi.fn(async () => []),
    queryCustomNormal: vi.fn(async () => ({ notes: [], total: 0 })),
    queryTagGroups: vi.fn(async () => []),
    countActiveNotes: vi.fn(async () => 0),
    reorderCustomSortOrder: vi.fn(async () => false),
    startProgress: vi.fn(),
    completeNote: vi.fn(),
    reopenNote: vi.fn()
  }
  const motion = {
    captureVisibleCardLayout: vi.fn(() => new Map()),
    animateRetainedCards: vi.fn(),
    animateAuxiliaryIn: vi.fn(),
    cancelCurrentPresenceExits: vi.fn(),
    animateCurrentCardsOut: vi.fn(async () => {}),
    disposePresenceMotion: vi.fn()
  }
  vi.stubGlobal('window', { api, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  return { api, motion, snapshot, broadcast, commitFilter, values, location, forecastListeners }
}
async function mount(f, options) {
  const component = await componentAt(f.motion, options)
  let state
  const app = renderer.createApp({
    ...component,
    setup(props, context) {
      state = component.setup(props, context)
      return state
    },
    render: () => vue.h('div')
  })
  apps.add(app)
  app.mount({})
  await flush()
  return {
    state,
    unmount() {
      if (apps.delete(app)) app.unmount()
    }
  }
}

afterEach(async () => {
  for (const app of apps) app.unmount()
  apps.clear()
  await flush()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('NoteList status consumer', () => {
  it('keeps early-start confirmation local and reports a failure before allowing another action', async () => {
    const f = fixture()
    const view = await mount(f)
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const note = { id: 71, status: 'initialized', effective_at: Date.now() + 86400000 }
    view.state.onCardStatusAction(note)
    view.state.cancelEarlyStart()
    expect(f.api.startProgress).not.toHaveBeenCalled()
    f.api.startProgress.mockRejectedValueOnce(new Error('状态写入未确认'))
    view.state.onCardStatusAction(note)
    view.state.confirmEarlyStart()
    await flush()
    expect(f.api.startProgress).toHaveBeenCalledExactlyOnceWith(71)
    expect(view.state.statusTransitionFor(71).phase).toBe('error')
    expect(view.state.showMessage).toHaveBeenCalledWith('error', '状态写入未确认')
    await vi.advanceTimersByTimeAsync(320)
    expect(view.state.statusTransitionFor(71)).toBeNull()
    f.api.startProgress.mockResolvedValueOnce({
      ...note,
      status: 'in_progress',
      effective_at: Date.now()
    })
    const patch = vi.spyOn(view.state.timelineModel, 'patchNote')
    await view.state.executeCardStatusAction(note)
    await vi.advanceTimersByTimeAsync(125)
    expect(patch.mock.lastCall[0].effective_at).toBe(note.effective_at)
    await vi.advanceTimersByTimeAsync(955)
    expect(f.api.startProgress).toHaveBeenCalledTimes(2)
    expect(view.state.statusTransitions.size).toBe(0)
  })

  it.each([false, true])(
    'does not recreate status effects after unmount (rejected=%s)',
    async (reject) => {
      const f = fixture(),
        response = deferred()
      const view = await mount(f)
      vi.useFakeTimers()
      const note = { id: 72, status: 'in_progress', effective_at: Date.now() }
      f.api.completeNote.mockReturnValueOnce(response.promise)
      const patch = vi.spyOn(view.state.timelineModel, 'patchNote')
      const task = view.state.executeCardStatusAction(note)
      view.unmount()
      if (reject) response.reject(new Error('late old response'))
      else response.resolve({ ...note, status: 'completed' })
      await task
      await vi.advanceTimersByTimeAsync(2000)
      expect(patch).not.toHaveBeenCalled()
      expect(view.state.showMessage).not.toHaveBeenCalled()
      expect(view.state.statusTransitions.size).toBe(0)
      expect(f.api.completeNote).toHaveBeenCalledOnce()
    }
  )
})

describe('NoteList sort presentation reset', () => {
  it('gives a real new filter its own intent while an older custom query is still waiting after reset', async () => {
    const f = fixture(),
      querying = deferred()
    const view = await mount(f)
    f.api.queryCustomNormal.mockReturnValueOnce(querying.promise)
    const switching = view.state.selectSortMode('custom')
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    await flush()
    expect(view.state.sortMode.value).toBe('custom')
    const reset = f.commitFilter(
      { listMode: 'timeline', tagIds: [], statusFilter: [] },
      { emit: false }
    )
    view.state.settingsSnapshots.acceptReset(reset, { checkpoint })
    await flush()
    try {
      view.state.statusFilter.value = ['completed']
      await flush()
      expect(f.api.setSettingValue).toHaveBeenLastCalledWith('listFilter', {
        listMode: 'timeline',
        tagIds: [],
        statusFilter: ['completed']
      })
      expect(f.api.setSettingValue).toHaveBeenCalledTimes(2)
      expect(view.state.settingsSnapshots.latest().values.listFilter.statusFilter).toEqual([
        'completed'
      ])
    } finally {
      querying.resolve({ notes: [], total: 0 })
      await switching
      await flush()
    }
    expect(view.state.sortMode.value).toBe('timeline')
    expect(view.state.statusFilter.value).toEqual(['completed'])
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(2)
  })

  it('does not turn an older presentation continuation into a newer setting intent before reset returns', async () => {
    const f = fixture(),
      exiting = deferred(),
      writing = deferred()
    f.motion.animateCurrentCardsOut.mockReturnValueOnce(exiting.promise)
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount(f)
    const switching = view.state.selectSortMode('custom')
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    // The old departure can finish while the main reset is still running. Its
    // subsequent write remains part of the original click, even if acknowledged.
    exiting.resolve()
    await switching
    await flush()
    expect(view.state.sortMode.value).toBe('custom')
    const committed = f.commitFilter(
      { listMode: 'custom', tagIds: [], statusFilter: [] },
      { emit: false }
    )
    const reset = f.commitFilter(
      { listMode: 'timeline', tagIds: [], statusFilter: [] },
      { emit: false }
    )
    view.state.settingsSnapshots.acceptReset(reset, { checkpoint })
    try {
      await flush()
      expect(view.state.sortMode.value).toBe('timeline')
      expect(view.state.settingsSnapshots.latest().values.listFilter.listMode).toBe('timeline')
    } finally {
      writing.resolve(committed)
      await flush()
    }
    expect(view.state.sortMode.value).toBe('timeline')
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
  })

  it('cancels an older departure even when reset returns the same displayed default', async () => {
    const f = fixture(),
      exiting = deferred()
    f.motion.animateCurrentCardsOut.mockReturnValueOnce(exiting.promise)
    const view = await mount(f)
    const switching = view.state.selectSortMode('custom')
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    const reset = f.commitFilter(
      { listMode: 'timeline', tagIds: [], statusFilter: [] },
      { emit: false }
    )
    expect(view.state.settingsSnapshots.acceptReset(reset, { checkpoint })).toBe(true)
    expect(f.motion.cancelCurrentPresenceExits).toHaveBeenCalled()
    exiting.resolve()
    await switching
    await flush()
    expect(view.state.sortMode.value).toBe('timeline')
    expect(f.api.queryCustomNormal).not.toHaveBeenCalled()
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it.each(['broadcast', 'failed-reset'])(
    'preserves the pending user mode after %s',
    async (kind) => {
      const f = fixture(),
        exiting = deferred()
      f.motion.animateCurrentCardsOut.mockReturnValueOnce(exiting.promise)
      const view = await mount(f)
      const switching = view.state.selectSortMode('custom')
      if (kind === 'broadcast') f.broadcast()
      else expect(view.state.settingsSnapshots.settleReset(null).settled).toBe(false)
      exiting.resolve()
      await switching
      await flush()
      expect(view.state.sortMode.value).toBe('custom')
      expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('listFilter', {
        listMode: 'custom',
        tagIds: [],
        statusFilter: []
      })
    }
  )

  it('keeps a queued selection made after the reset checkpoint and never restarts the older mode', async () => {
    const f = fixture(),
      exiting = deferred()
    f.motion.animateCurrentCardsOut.mockReturnValueOnce(exiting.promise)
    const view = await mount(f)
    const switching = view.state.selectSortMode('custom')
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    await view.state.selectSortMode('tag-group')
    const reset = f.commitFilter(
      { listMode: 'timeline', tagIds: [], statusFilter: [] },
      { emit: false }
    )
    view.state.settingsSnapshots.acceptReset(reset, { checkpoint })
    exiting.resolve()
    await switching
    await flush()
    expect(view.state.sortMode.value).toBe('tag-group')
    expect(f.api.queryCustomNormal).not.toHaveBeenCalled()
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('listFilter', {
      listMode: 'tag-group',
      tagIds: [],
      statusFilter: []
    })
  })

  it('revokes a queued selection covered by the checkpoint', async () => {
    const f = fixture(),
      exiting = deferred()
    f.motion.animateCurrentCardsOut.mockReturnValueOnce(exiting.promise)
    const view = await mount(f)
    const switching = view.state.selectSortMode('custom')
    await view.state.selectSortMode('tag-group')
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    const reset = f.commitFilter(
      { listMode: 'timeline', tagIds: [], statusFilter: [] },
      { emit: false }
    )
    view.state.settingsSnapshots.acceptReset(reset, { checkpoint })
    exiting.resolve()
    await switching
    await flush()
    expect(view.state.sortMode.value).toBe('timeline')
    expect(f.api.queryTagGroups).not.toHaveBeenCalled()
    expect(f.api.queryCustomNormal).not.toHaveBeenCalled()
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
  })
})

describe('NoteList shared weather source', () => {
  it('shares the date forecast, clears a switched region and ignores late results without reloading notes', async () => {
    const f = fixture({ weather: true }),
      pending = deferred()
    const first = await mount(f, { realWeather: true })
    const second = await mount(f, { realWeather: true })
    expect(f.api.getWeatherForecast).toHaveBeenCalledTimes(1)
    expect(f.api.onWeatherForecastUpdated).toHaveBeenCalledTimes(1)
    expect(first.state.weatherForecast.value.location.name).toBe('北京')
    expect(second.state.weatherForecast.value).toBe(first.state.weatherForecast.value)
    const noteReads = f.api.queryRecentNotes.mock.calls.length
    const nextPlace = { ...f.location, name: '上海', latitude: 31.2, longitude: 121.5 }
    f.api.getWeatherForecast.mockReturnValueOnce(pending.promise)
    f.values.weather.location = nextPlace
    f.broadcast()
    expect(first.state.weatherForecast.value).toBeNull()
    expect(second.state.weatherForecast.value).toBeNull()
    for (const listener of f.forecastListeners) listener({ location: f.location, days: [] })
    expect(first.state.weatherForecast.value).toBeNull()
    const current = { location: nextPlace, fetchedAt: Date.now(), days: [] }
    for (const listener of f.forecastListeners) listener(current)
    pending.resolve({ location: f.location, days: [] })
    await flush()
    expect(first.state.weatherForecast.value.location.name).toBe('上海')
    expect(second.state.weatherForecast.value).toBe(first.state.weatherForecast.value)
    expect(f.api.queryRecentNotes).toHaveBeenCalledTimes(noteReads)
    first.unmount()
    expect(f.forecastListeners.size).toBe(1)
    f.values.weather.enabled = false
    f.broadcast()
    expect(second.state.weatherForecast.value).toBeNull()
    expect(second.state.weatherDisplayEnabled.value).toBe(false)
    second.unmount()
    expect(f.forecastListeners.size).toBe(0)
  })
})

describe('NoteList filter snapshot intent', () => {
  it('settles saved A beneath failed B without repeating SQL or losing A on unmount', async () => {
    const f = fixture(),
      writing = deferred()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.api.setSettingValue
      .mockReturnValueOnce(writing.promise)
      .mockRejectedValueOnce(new Error('B filter failed'))
    const view = await mount(f)
    view.state.tagFilterIds.value = [1]
    await flush()
    view.state.tagFilterIds.value = [2]
    await flush()
    writing.resolve({
      kind: 'settings-saved',
      source: f.snapshot().source,
      persistence: { status: 'saved', commitId: 'filter-A' },
      snapshot: null,
      application: { status: 'failed' },
      snapshotError: { message: 'readback unavailable' }
    })
    await flush()
    expect(view.state.tagFilterIds.value).toEqual([2])
    expect(view.state.settingsSnapshots.protectedCount).toBe(1)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(2)
    const store = view.state.settingsSnapshots
    view.unmount()
    expect(store.latest().values.listFilter.tagIds).toEqual([1])
    expect(store.status().awaitingCanonical).toBe(true)
    expect(store.protectedCount).toBe(0)
  })

  it('protects changed refs before the asynchronous watcher or an unrelated broadcast can run', async () => {
    const f = fixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount(f)
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
    view.state.tagFilterIds.value = [4]
    expect(view.state.settingsSnapshots.protectedCount).toBe(1)
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
    f.broadcast()
    expect(view.state.tagFilterIds.value).toEqual([4])
    await flush()
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('listFilter', {
      listMode: 'timeline',
      tagIds: [4],
      statusFilter: []
    })
    expect(f.api.queryRecentNotes.mock.lastCall[0].tagIds).toEqual([4])
    writing.resolve(f.commitFilter(f.api.setSettingValue.mock.calls[0][1], { emit: false }))
    await flush()
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('serializes the shared key, coalesces undispatched choices and keeps the latest lease', async () => {
    const f = fixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount(f)
    view.state.tagFilterIds.value = [1]
    await flush()
    view.state.tagFilterIds.value = [2]
    await flush()
    view.state.tagFilterIds.value = [3]
    await flush()
    f.broadcast()
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
    expect(view.state.tagFilterIds.value).toEqual([3])
    expect(view.state.settingsSnapshots.protectedCount).toBe(1)
    writing.resolve(f.commitFilter(f.api.setSettingValue.mock.calls[0][1], { emit: false }))
    await flush()
    expect(f.api.setSettingValue.mock.calls.map(([, value]) => value.tagIds)).toEqual([[1], [3]])
    expect(view.state.tagFilterIds.value).toEqual([3])
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('does not let an older failed write release or restore over the newer choice', async () => {
    const f = fixture()
    const old = deferred(),
      fresh = deferred()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.api.setSettingValue.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const view = await mount(f)
    view.state.tagFilterIds.value = [1]
    await flush()
    view.state.tagFilterIds.value = [2]
    await flush()
    old.reject(new Error('old filter write failed'))
    await flush()
    f.broadcast()
    expect(view.state.tagFilterIds.value).toEqual([2])
    expect(view.state.settingsSnapshots.protectedCount).toBe(1)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(2)
    fresh.resolve(f.commitFilter(f.api.setSettingValue.mock.calls[1][1], { emit: false }))
    await flush()
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('retains a failed local choice until a new choice replaces it or the list unmounts', async () => {
    const f = fixture()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.api.setSettingValue.mockRejectedValueOnce(new Error('filter save rejected'))
    const view = await mount(f)
    view.state.statusFilter.value = ['completed']
    await flush()
    f.broadcast()
    expect(view.state.statusFilter.value).toEqual(['completed'])
    expect(view.state.settingsSnapshots.protectedCount).toBe(1)
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(1)
    view.state.statusFilter.value = ['in_progress']
    await flush()
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    view.unmount()
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('converges to canonical accepted filters without writing their programmatic assignment back', async () => {
    const f = fixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount(f)
    view.state.tagFilterIds.value = [9]
    await flush()
    const committed = f.commitFilter(
      { listMode: 'timeline', tagIds: [7], statusFilter: [] },
      { emit: false }
    )
    f.broadcast()
    expect(view.state.tagFilterIds.value).toEqual([9])
    writing.resolve(committed)
    await flush()
    expect(view.state.tagFilterIds.value).toEqual([7])
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
    expect(f.api.queryRecentNotes).toHaveBeenCalledTimes(3)
    expect(f.api.queryRecentNotes.mock.lastCall[0].tagIds).toEqual([7])
  })

  it('cancels undispatched writes and late snapshot queries when unmounted', async () => {
    const f = fixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount(f)
    view.state.tagFilterIds.value = [1]
    await flush()
    view.state.tagFilterIds.value = [2]
    await flush()
    const queries = f.api.queryRecentNotes.mock.calls.length
    view.unmount()
    writing.resolve(f.commitFilter(f.api.setSettingValue.mock.calls[0][1], { emit: false }))
    await flush()
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
    expect(f.api.queryRecentNotes).toHaveBeenCalledTimes(queries)
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('preserves current filters and query data when an older filtered query completes late', async () => {
    const f = fixture()
    const view = await mount(f)
    const old = deferred(),
      fresh = deferred()
    f.api.queryRecentNotes.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    view.state.tagFilterIds.value = [1]
    await flush()
    view.state.tagFilterIds.value = [2]
    await flush()
    fresh.resolve([{ id: 2, status: 'in_progress', effective_at: Date.now(), tags: [] }])
    await flush()
    old.resolve([{ id: 999, status: 'in_progress', effective_at: Date.now(), tags: [] }])
    await flush()
    expect(view.state.tagFilterIds.value).toEqual([2])
    expect(view.state.noteList.value.map((note) => note.id)).toEqual([2])
  })

  it('keeps the existing mode exit barrier and protects the accepted mode through its write', async () => {
    const f = fixture()
    const exiting = deferred(),
      writing = deferred()
    f.motion.animateCurrentCardsOut.mockReturnValueOnce(exiting.promise)
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount(f)
    const switching = view.state.selectSortMode('custom')
    expect(view.state.sortMode.value).toBe('timeline')
    expect(f.api.queryCustomNormal).not.toHaveBeenCalled()
    exiting.resolve()
    await switching
    await flush()
    f.broadcast()
    expect(view.state.sortMode.value).toBe('custom')
    expect(f.api.queryCustomNormal).toHaveBeenCalledTimes(1)
    expect(view.state.settingsSnapshots.protectedCount).toBe(1)
    writing.resolve(f.commitFilter(f.api.setSettingValue.mock.calls[0][1], { emit: false }))
    await flush()
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('shows reset defaults after a failed filter owner without writing the restore back', async () => {
    const f = fixture()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.api.setSettingValue.mockRejectedValueOnce(new Error('filter save rejected'))
    const view = await mount(f)
    view.state.statusFilter.value = ['completed']
    await flush()
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    const reset = f.commitFilter(
      { listMode: 'timeline', tagIds: [], statusFilter: [] },
      { emit: false }
    )
    expect(view.state.settingsSnapshots.acceptReset(reset, { checkpoint })).toBe(true)
    await flush()
    expect(view.state.statusFilter.value).toEqual([])
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch an older queued filter after reset revoked its lease', async () => {
    const f = fixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount(f)
    view.state.tagFilterIds.value = [1]
    await flush()
    view.state.tagFilterIds.value = [2]
    await flush()
    const committed = f.commitFilter(f.api.setSettingValue.mock.calls[0][1], { emit: false })
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    const reset = f.commitFilter(
      { listMode: 'timeline', tagIds: [], statusFilter: [] },
      { emit: false }
    )
    view.state.settingsSnapshots.acceptReset(reset, { checkpoint })
    await flush()
    writing.resolve(committed)
    await flush()
    expect(view.state.tagFilterIds.value).toEqual([])
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
  })
})
