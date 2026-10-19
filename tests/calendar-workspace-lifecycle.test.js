import { afterEach, describe, expect, it, vi } from 'vitest'
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
async function workspaceComponent() {
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
    else if (name.endsWith('/useMessage.js'))
      dependency = { useMessage: () => ({ showMessage: vi.fn() }) }
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
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
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
function mount(component, ready) {
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
    { onReady: ready }
  )
  app.mount({})
  apps.push(app)
  return {
    app,
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
function apiFixture() {
  const stops = []
  const listen = vi.fn(() => {
    const stop = vi.fn()
    stops.push(stop)
    return stop
  })
  const api = {
    getSettingsSnapshot: vi.fn(async () => ({
      values: {
        weather: { enabled: false },
        calendar: { recurringPreviewEnabled: false },
        ui: { dayPanelSize: 30 }
      }
    })),
    getMonthCalendarData: vi.fn(async () => calendar(2)),
    getWeekCalendarData: vi.fn(async () => calendar(2)),
    onNotesChanged: listen,
    onTemplatesChanged: listen,
    onHolidayDataChanged: listen,
    onSettingsChanged: listen,
    onWeatherForecastUpdated: listen
  }
  vi.stubGlobal('window', { api })
  return { api, listen, stops }
}
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await flush()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('calendar same-document lifecycle', () => {
  it('emits local calendar ready while weather is pending and ignores the weather result after unmount', async () => {
    const { api } = apiFixture()
    const slow = deferred(),
      ready = vi.fn()
    api.getSettingsSnapshot.mockResolvedValueOnce({
      values: { weather: { enabled: true }, calendar: {}, ui: {} }
    })
    api.getWeatherForecast = vi.fn(() => slow.promise)
    const mounted = mount(await workspaceComponent(), ready)
    await flush()
    expect(ready).toHaveBeenCalledTimes(1)
    expect(api.getWeatherForecast).toHaveBeenCalledTimes(1)
    mounted.app.unmount()
    slow.resolve({ location: { name: '迟到天气' }, days: [] })
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

  it('does not register late subscriptions or begin a query after settings resolve on a disposed instance', async () => {
    const { api, listen } = apiFixture()
    const slow = deferred(),
      ready = vi.fn()
    api.getSettingsSnapshot.mockImplementationOnce(() => slow.promise)
    const old = mount(await workspaceComponent(), ready)
    await flush()
    old.app.unmount()
    slow.resolve({ values: { weather: { enabled: false }, calendar: {}, ui: {} } })
    await flush()
    expect(listen).not.toHaveBeenCalled()
    expect(api.getMonthCalendarData).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })
})
