import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  babelParse as parseJavaScript,
  compileScript,
  parse as parseComponent
} from '@vue/compiler-sfc'
import * as vue from 'vue'

// Execute the actual setup function with a minimal host renderer. Child UI,
// clocks and focus are isolated; lifecycle, queries, subscriptions and ready are real.
const workspaceUrl = new URL(
  '../src/renderer/src/components/month/MonthWorkspace.vue',
  import.meta.url
)
async function workspaceComponent(showMessage = vi.fn()) {
  const { descriptor } = parseComponent(readFileSync(workspaceUrl, 'utf8'))
  let code = compileScript(descriptor, { id: 'calendar-lifecycle' }).content
  const imports = parseJavaScript(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = []
  const declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    let dependency
    if (name === 'vue') dependency = vue
    else if (name.endsWith('.vue')) dependency = { default: {} }
    else if (name.endsWith('/useQueuedModal.js'))
      dependency = {
        useQueuedModal: (source) => ({
          visible: vue.computed(() => Boolean(source.value)),
          finishLeave() {}
        })
      }
    else if (name.endsWith('/useSharedMinuteClock.js'))
      dependency = { useSharedMinuteClock: () => vue.ref(Date.now()) }
    else if (name.endsWith('/useTodayKey.js'))
      dependency = { useTodayKey: () => vue.ref('2026-10-09') }
    else if (name.endsWith('/useWeatherRecovery.js')) dependency = { useWeatherRecovery() {} }
    else if (name.endsWith('/useMessage.js')) dependency = { useMessage: () => ({ showMessage }) }
    else if (name.endsWith('/modalFocus.js'))
      dependency = {
        captureFocusedElement: () => null,
        focusModal() {},
        restoreFocusedElement() {},
        trapModalTab() {}
      }
    else dependency = await import(new URL(name, workspaceUrl).href)
    dependencies.push(dependency)
    for (const specifier of node.specifiers) {
      const imported =
        specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name
      declarations.push(
        `const ${specifier.local.name} = dependencies[${index}][${JSON.stringify(imported)}];`
      )
    }
  }
  for (const node of [...imports].reverse()) code = code.slice(0, node.start) + code.slice(node.end)
  code = code.replace('export default', 'return')
  return new Function('dependencies', declarations.join('\n') + code)(dependencies)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
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
const apps = []
function mount(component, ready, viewMode = 'month') {
  let state
  const app = renderer.createApp(
    {
      ...component,
      setup(props, context) {
        state = component.setup(props, context)
        return state
      },
      render: () => vue.h('div')
    },
    { onReady: ready, viewMode }
  )
  app.mount({})
  apps.push(app)
  return {
    app,
    unmount() {
      const index = apps.indexOf(app)
      if (index !== -1) apps.splice(index, 1)
      app.unmount()
    },
    get state() {
      return state
    }
  }
}
async function flush() {
  for (let index = 0; index < 15; index++) await vue.nextTick()
}
function calendar(id) {
  return {
    year: 2026,
    month: 10,
    days: [{ key: '2026-10-09' }],
    notes: [{ id }],
    recurringPreviews: []
  }
}
function settingsSnapshot(values, revision = 1) {
  return { source: { token: 'calendar-document', scope: 'month' }, revision, values }
}
const location = { name: '北京', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }
function apiFixture() {
  const stops = []
  const listen = vi.fn(() => {
    const stop = vi.fn()
    stops.push(stop)
    return stop
  })
  const api = {
    getSettingsSnapshot: vi.fn(async () =>
      settingsSnapshot({
        weather: { enabled: false },
        calendar: { recurringPreviewEnabled: false },
        ui: { dayPanelSize: 30 }
      })
    ),
    getMonthCalendarData: vi.fn(async () => calendar(2)),
    getWeekCalendarData: vi.fn(async () => calendar(2)),
    startProgress: vi.fn(),
    completeNote: vi.fn(),
    reopenNote: vi.fn(),
    onNotesChanged: vi.fn((callback) => listen(callback)),
    onTemplatesChanged: vi.fn((callback) => listen(callback)),
    onHolidayDataChanged: vi.fn((callback) => listen(callback)),
    onSettingsChanged: vi.fn((callback) => listen(callback)),
    onWeatherForecastUpdated: vi.fn((callback) => listen(callback))
  }
  vi.stubGlobal('window', { api })
  return { api, listen, stops }
}
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await flush()
  if (vi.isFakeTimers()) {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('calendar status actions use the real shared owner', () => {
  beforeEach(() => vi.useFakeTimers())

  const note = (id, status = 'in_progress') => ({
    id,
    status,
    content: `便签 ${id}`,
    effective_at: Date.parse('2026-10-09T04:00:00Z'),
    duration_kind: 'single_day',
    duration_days: 1
  })
  const dataFor = (notes, month = 10) => ({ ...calendar(2), month, notes })

  it.each(['month', 'week'])(
    'keeps %s early-start confirmation cancelable and preserves the old date until refresh',
    async (viewMode) => {
      const { api } = apiFixture()
      const future = note(10, 'initialized')
      const updated = { ...future, status: 'in_progress', effective_at: Date.now() }
      api.getMonthCalendarData.mockResolvedValue(dataFor([future]))
      api.getWeekCalendarData.mockResolvedValue(dataFor([future]))
      api.startProgress.mockResolvedValueOnce(updated)
      const mounted = mount(await workspaceComponent(), vi.fn(), viewMode)
      await flush()
      mounted.state.onCardStatusAction(future)
      expect(mounted.state.earlyStartConfirmVisible.value).toBe(true)
      expect(api.startProgress).not.toHaveBeenCalled()
      mounted.state.cancelEarlyStart()
      expect(mounted.state.earlyStartNote.value).toBeNull()
      expect(api.startProgress).not.toHaveBeenCalled()
      mounted.state.onCardStatusAction(future)
      mounted.state.confirmEarlyStart()
      await flush()
      expect(api.startProgress).toHaveBeenCalledExactlyOnceWith(future.id)
      expect(mounted.state.statusTransitions.get(future.id)?.phase).toBe('playing')
      await vi.advanceTimersByTimeAsync(124)
      expect(mounted.state.calendarData.value.notes[0].status).toBe('initialized')
      await vi.advanceTimersByTimeAsync(1)
      expect(mounted.state.calendarData.value.notes[0]).toMatchObject({
        status: 'in_progress',
        effective_at: future.effective_at
      })
    }
  )

  it('shows an unconfirmed failure, releases its lock and allows a successful retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { api } = apiFixture()
    const original = note(11)
    const updated = { ...original, status: 'completed' }
    api.getMonthCalendarData.mockResolvedValue(dataFor([original]))
    api.completeNote.mockRejectedValueOnce(new Error('SQL拒绝')).mockResolvedValueOnce(updated)
    const notify = vi.fn()
    const mounted = mount(await workspaceComponent(notify), vi.fn())
    await flush()
    mounted.state.onCardStatusAction(original)
    await flush()
    expect(notify).toHaveBeenCalledExactlyOnceWith('error', '便签状态修改未确认：SQL拒绝')
    expect(mounted.state.statusTransitions.get(original.id)?.phase).toBe('error')
    mounted.state.onCardStatusAction(original)
    expect(api.completeNote).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(320)
    expect(mounted.state.statusTransitions.has(original.id)).toBe(false)
    api.getMonthCalendarData.mockResolvedValue(dataFor([updated]))
    mounted.state.onCardStatusAction(original)
    await flush()
    expect(api.completeNote).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(920)
    expect(mounted.state.calendarData.value.notes[0].status).toBe('completed')
    expect(api.getMonthCalendarData).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120)
    await flush()
    expect(api.getMonthCalendarData).toHaveBeenCalledTimes(2)
    expect(mounted.state.statusTransitions.size).toBe(0)
  })

  it.each(['success', 'failure'])('ignores a late status %s after unmount', async (outcome) => {
    const { api } = apiFixture()
    const original = note(12)
    api.getMonthCalendarData.mockResolvedValue(dataFor([original]))
    const response = deferred()
    api.completeNote.mockReturnValueOnce(response.promise)
    const notify = vi.fn()
    const mounted = mount(await workspaceComponent(notify), vi.fn())
    await flush()
    const patch = vi.spyOn(mounted.state.calendarModel, 'patchNote')
    const pending = mounted.state.executeCardStatusAction(original)
    mounted.unmount()
    if (outcome === 'success') response.resolve({ ...original, status: 'completed' })
    else response.reject(new Error('迟到失败'))
    expect((await pending).status).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(1200)
    expect(patch).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(mounted.state.statusTransitions.size).toBe(0)
    expect(api.getMonthCalendarData).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('merges two completed actions and broadcasts into one refresh after the period animation', async () => {
    const { api } = apiFixture()
    const first = note(13),
      second = note(14)
    const secondResponse = deferred()
    const completed = [first, second].map((value) => ({ ...value, status: 'completed' }))
    api.getMonthCalendarData.mockResolvedValueOnce(dataFor([first, second]))
    api.getMonthCalendarData.mockResolvedValue(dataFor(completed, 11))
    api.completeNote.mockResolvedValueOnce(completed[0]).mockReturnValueOnce(secondResponse.promise)
    const mounted = mount(await workspaceComponent(), vi.fn())
    await flush()
    mounted.state.onCardStatusAction(first)
    mounted.state.onCardStatusAction(second)
    await flush()
    api.onNotesChanged.mock.calls[0][0]({ reason: 'first-status' })
    api.onNotesChanged.mock.calls[0][0]({ reason: 'second-status' })
    await vi.advanceTimersByTimeAsync(100)
    secondResponse.resolve(completed[1])
    await flush()
    await vi.advanceTimersByTimeAsync(800)
    const period = deferred()
    const animation = { finished: period.promise, cancel: vi.fn() }
    mounted.state.calendarSurfaceRef.value = {
      animate: vi.fn(() => animation),
      querySelectorAll: () => []
    }
    mounted.state.goNext()
    await flush()
    expect(mounted.state.transitioning.value).toBe(true)
    expect(api.getMonthCalendarData).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(280)
    expect(mounted.state.statusTransitions.size).toBe(0)
    expect(api.getMonthCalendarData).toHaveBeenCalledTimes(2)
    period.resolve()
    await flush()
    expect(mounted.state.transitioning.value).toBe(false)
    await vi.advanceTimersByTimeAsync(40)
    await flush()
    expect(api.getMonthCalendarData).toHaveBeenCalledTimes(3)
    expect(api.completeNote).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(api.getMonthCalendarData).toHaveBeenCalledTimes(3)
  })

  it('reports committed display failure and reconciles without replaying the SQL command', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { api } = apiFixture()
    const original = note(15)
    const updated = { ...original, status: 'completed' }
    api.getMonthCalendarData.mockResolvedValueOnce(dataFor([original]))
    api.getMonthCalendarData.mockResolvedValue(dataFor([updated]))
    api.completeNote.mockResolvedValueOnce(updated)
    const notify = vi.fn()
    const mounted = mount(await workspaceComponent(notify), vi.fn())
    await flush()
    vi.spyOn(mounted.state.calendarModel, 'patchNote').mockImplementationOnce(() => {
      throw new Error('视图不可用')
    })
    mounted.state.onCardStatusAction(original)
    await flush()
    await vi.advanceTimersByTimeAsync(1040)
    await flush()
    expect(api.completeNote).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      'warning',
      '便签状态已保存，但显示更新失败，请稍后核对。'
    )
    expect(api.getMonthCalendarData).toHaveBeenCalledTimes(2)
    expect(mounted.state.calendarData.value.notes[0].status).toBe('completed')
    expect(mounted.state.statusTransitions.size).toBe(0)
  })
})

describe('calendar same-document lifecycle', () => {
  it('emits local calendar ready while weather is pending and ignores the weather result after unmount', async () => {
    const { api } = apiFixture()
    const slow = deferred(),
      ready = vi.fn()
    api.getSettingsSnapshot.mockResolvedValueOnce(
      settingsSnapshot({ weather: { enabled: true, location }, calendar: {}, ui: {} })
    )
    api.getWeatherForecast = vi.fn(() => slow.promise)
    const mounted = mount(await workspaceComponent(), ready)
    await flush()
    expect(ready).toHaveBeenCalledTimes(1)
    expect(api.getWeatherForecast).toHaveBeenCalledTimes(1)
    mounted.app.unmount()
    slow.resolve({ location, marker: 'legitimate late result', days: [] })
    await flush()
    expect(mounted.state.weatherForecast.value).toBeNull()
    expect(ready).toHaveBeenCalledTimes(1)
  })
  it('rejects old calendar result and ready after unmount/remount while a query is pending', async () => {
    const { api, stops } = apiFixture()
    const slow = deferred(),
      ready = vi.fn()
    api.getMonthCalendarData.mockImplementationOnce(() => slow.promise)
    const component = await workspaceComponent()
    const old = mount(component, ready)
    await flush()
    old.app.unmount()
    const fresh = mount(component, ready)
    await flush()
    expect(ready).toHaveBeenCalledTimes(1)
    slow.resolve(calendar(999))
    await flush()
    expect(ready).toHaveBeenCalledTimes(1)
    expect(old.state.calendarData.value.notes).toEqual([])
    expect(fresh.state.calendarData.value.notes).toEqual([{ id: 2 }])
    expect(stops.slice(0, 5).every((stop) => stop.mock.calls.length === 1)).toBe(true)
  })

  it('releases the early settings subscription without beginning a query after disposal', async () => {
    const { api, listen, stops } = apiFixture()
    const slow = deferred(),
      ready = vi.fn()
    api.getSettingsSnapshot.mockImplementationOnce(() => slow.promise)
    const old = mount(await workspaceComponent(), ready)
    await flush()
    old.app.unmount()
    slow.resolve(settingsSnapshot({ weather: { enabled: false }, calendar: {}, ui: {} }))
    await flush()
    expect(listen).toHaveBeenCalledTimes(2)
    expect(api.onSettingsChanged).toHaveBeenCalledOnce()
    expect(api.onWeatherForecastUpdated).toHaveBeenCalledOnce()
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true)
    expect(api.getMonthCalendarData).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })

  it('keeps preferences from a broadcast that arrives before the initial read returns', async () => {
    const { api } = apiFixture()
    const slow = deferred(),
      ready = vi.fn()
    api.getSettingsSnapshot.mockReturnValueOnce(slow.promise)
    const mounted = mount(await workspaceComponent(), ready)
    await flush()
    expect(api.onSettingsChanged.mock.invocationCallOrder[0]).toBeLessThan(
      api.getSettingsSnapshot.mock.invocationCallOrder[0]
    )
    api.onSettingsChanged.mock.calls[0][0](
      settingsSnapshot(
        {
          weather: { enabled: false },
          calendar: { recurringPreviewEnabled: true },
          notes: { quickCreateUntilCompleted: true },
          ui: { dayPanelSize: 44 }
        },
        2
      )
    )
    slow.resolve(
      settingsSnapshot(
        {
          weather: { enabled: false },
          calendar: { recurringPreviewEnabled: false },
          notes: { quickCreateUntilCompleted: false },
          ui: { dayPanelSize: 30 }
        },
        1
      )
    )
    await flush()
    expect(mounted.state.recurringPreviewEnabled.value).toBe(true)
    expect(mounted.state.quickCreateUntilCompleted.value).toBe(true)
    expect(mounted.state.dayPanelSize.value).toBe(44)
    expect(ready).toHaveBeenCalledOnce()
  })

  it('shares actual month/week weather while keeping both local ready signals independent of the network', async () => {
    const { api } = apiFixture()
    api.getSettingsSnapshot.mockResolvedValueOnce(
      settingsSnapshot({ weather: { enabled: true, location }, calendar: {}, ui: {} })
    )
    const slow = deferred()
    api.getWeatherForecast = vi.fn(() => slow.promise)
    const component = await workspaceComponent(),
      monthReady = vi.fn(),
      weekReady = vi.fn()
    const month = mount(component, monthReady, 'month'),
      week = mount(component, weekReady, 'week')
    await flush()
    expect(monthReady).toHaveBeenCalledOnce()
    expect(weekReady).toHaveBeenCalledOnce()
    expect(api.getSettingsSnapshot).toHaveBeenCalledOnce()
    expect(api.getWeatherForecast).toHaveBeenCalledOnce()
    expect(api.onWeatherForecastUpdated).toHaveBeenCalledOnce()
    expect(api.onSettingsChanged).toHaveBeenCalledOnce()
    expect(api.getMonthCalendarData).toHaveBeenCalledOnce()
    expect(api.getWeekCalendarData).toHaveBeenCalledOnce()
    expect(month.state.weatherForecast).toBe(week.state.weatherForecast)
    const broadcast = api.onWeatherForecastUpdated.mock.calls[0][0]
    const stopForecast = api.onWeatherForecastUpdated.mock.results[0].value
    broadcast({ location, days: [], fetchedAt: 123 })
    expect(month.state.weatherForecast.value.fetchedAt).toBe(123)
    expect(week.state.weatherForecast.value.fetchedAt).toBe(123)
    month.app.unmount()
    expect(stopForecast).not.toHaveBeenCalled()
    broadcast({ location, days: [], fetchedAt: 456 })
    expect(week.state.weatherForecast.value.fetchedAt).toBe(456)
    week.app.unmount()
    expect(stopForecast).toHaveBeenCalledOnce()
    slow.resolve({ location, days: [], fetchedAt: 1 })
    await flush()
    expect(week.state.weatherForecast.value).toBeNull()
    expect(monthReady).toHaveBeenCalledOnce()
    expect(weekReady).toHaveBeenCalledOnce()
  })
})
