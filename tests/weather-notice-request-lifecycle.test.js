import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { babelParse, compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Run the actual SFC setup, Vue lifecycle and template event handlers. Child
// controls are slot hosts; only native location, network and IPC are isolated.
const apps = new Set()
const child = {
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    return () =>
      vue.h('section', attrs, [...(slots.default?.() || []), ...(slots.footer?.() || [])])
  }
}
async function evaluateModule(code, url) {
  const imports = babelParse(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = []
  const declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    dependencies.push(
      name === 'vue'
        ? vue
        : name.endsWith('.vue')
          ? { default: child }
          : await import(new URL(name, url).href)
    )
    for (const specifier of node.specifiers) {
      const imported =
        specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name
      declarations.push(
        `const ${specifier.local.name}=dependencies[${index}][${JSON.stringify(imported)}];`
      )
    }
  }
  for (const node of [...imports].reverse()) code = code.slice(0, node.start) + code.slice(node.end)
  code = code
    .replace('export default', 'return')
    .replace('export function render', 'return function render')
  return new Function('dependencies', declarations.join('\n') + code)(dependencies)
}
async function componentAt(path) {
  const url = new URL('../src/renderer/src/components/' + path, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const script = compileScript(descriptor, { id: path })
  const component = await evaluateModule(script.content, url)
  const template = compileTemplate({
    source: descriptor.template.content,
    filename: url.pathname,
    id: path,
    compilerOptions: { bindingMetadata: script.bindings }
  })
  if (template.errors.length) throw new Error(template.errors.join('\n'))
  component.render = await evaluateModule(template.code, url)
  return component
}
function hostNode(type) {
  return { type, children: [], props: {}, parent: null }
}
const renderer = vue.createRenderer({
  createElement: hostNode,
  createText: (text) => ({ ...hostNode('#text'), text }),
  createComment: (text) => ({ ...hostNode('#comment'), text }),
  insert(node, parent, anchor = null) {
    if (node.parent) {
      const previous = node.parent.children.indexOf(node)
      if (previous >= 0) node.parent.children.splice(previous, 1)
    }
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    node.parent = parent
  },
  remove(node) {
    const index = node.parent?.children.indexOf(node) ?? -1
    if (index >= 0) node.parent.children.splice(index, 1)
    node.parent = null
  },
  setText: (node, text) => (node.text = text),
  setElementText: (node, text) => (node.text = text),
  patchProp: (node, key, _, value) => (node.props[key] = value),
  parentNode: (node) => node.parent,
  nextSibling(node) {
    return node.parent?.children[node.parent.children.indexOf(node) + 1] || null
  }
})
async function flush() {
  for (let index = 0; index < 16; index++) await vue.nextTick()
}
async function mount(path, initialProps = {}) {
  const component = await componentAt(path)
  let state
  const wrapped = {
    ...component,
    setup(props, context) {
      state = component.setup(props, context)
      return state
    }
  }
  const props = vue.shallowReactive(initialProps)
  const root = hostNode('root')
  const app = renderer.createApp({ render: () => vue.h(wrapped, props) })
  apps.add(app)
  app.mount(root)
  await flush()
  return {
    state,
    props,
    root,
    unmount() {
      if (apps.delete(app)) app.unmount()
    }
  }
}
function findNode(node, predicate) {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function place(name, latitude = 31.2, longitude = 121.5) {
  return { name, latitude, longitude, countryCode: 'CN', admin1: '测试省', admin2: '测试市' }
}
function reverseResponse(name = 'A旧定位') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      city: '测试市',
      locality: name,
      principalSubdivision: '测试省',
      countryCode: 'CN',
      latitude: 39.9,
      longitude: 116.4
    })
  }
}
function weatherFixture({ enabled = false, location = place('C原地区') } = {}) {
  const settings = { enabled, location }
  const listeners = new Set()
  let success, failure
  const snapshot = () => ({
    values: {
      weather: { ...settings, location: settings.location && { ...settings.location } },
      almanac: { enabled: true }
    }
  })
  const broadcast = (values) => {
    Object.assign(settings, values)
    for (const listener of listeners) listener(snapshot())
  }
  const api = {
    getSettingsSnapshot: vi.fn(async () => snapshot()),
    getWeatherDivisionTree: vi.fn(async () => []),
    resolveWeatherLocation: vi.fn(async (candidate) => ({
      ...candidate,
      ...place(candidate.name)
    })),
    onSettingsChanged: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    reportLog: vi.fn(),
    setSettingValue: vi.fn(async (id, value) => {
      broadcast({ [id.split('.')[1]]: value })
    })
  }
  const fetch = vi.fn(async () => reverseResponse())
  vi.stubGlobal('window', { api })
  vi.stubGlobal('navigator', {
    geolocation: {
      getCurrentPosition: vi.fn((receivedSuccess, receivedFailure) => {
        success = receivedSuccess
        failure = receivedFailure
      })
    }
  })
  vi.stubGlobal('fetch', fetch)
  return {
    api,
    fetch,
    settings,
    broadcast,
    locate: () => success({ coords: { latitude: 39.9, longitude: 116.4, accuracy: 5 } }),
    fail: (code = 2) => failure({ code })
  }
}

afterEach(() => {
  for (const app of apps) app.unmount()
  apps.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('weather location request lifetime', () => {
  it('saves one manual choice and enables weather once, including its own broadcasts', async () => {
    const f = weatherFixture()
    const resolving = deferred()
    f.api.resolveWeatherLocation.mockReturnValueOnce(resolving.promise)
    const view = await mount('weather/WeatherSettings.vue')
    const candidate = { id: 3, name: 'B手选地区' }
    const first = view.state.choose(candidate)
    expect(view.state.choose(candidate)).toBe(first)
    resolving.resolve({ ...place(candidate.name), id: 3 })
    expect(await first).toBe(true)
    await flush()
    expect(f.api.resolveWeatherLocation).toHaveBeenCalledTimes(1)
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual([
      'weather.location',
      'weather.enabled'
    ])
    expect(f.settings.location.name).toBe(candidate.name)
    expect(f.settings.enabled).toBe(true)
    expect(view.state.busy.value).toBe('')
  })

  it.each(['success', 'failure'])('ignores a native %s callback after unmount', async (result) => {
    const f = weatherFixture()
    const view = await mount('weather/WeatherSettings.vue')
    view.state.useDeviceLocation()
    view.unmount()
    if (result === 'success') f.locate()
    else f.fail()
    await flush()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
  })

  it('keeps the new mounted choice when the old reverse lookup finishes after unmount', async () => {
    const f = weatherFixture()
    const reverse = deferred()
    f.fetch.mockReturnValueOnce(reverse.promise)
    const old = await mount('weather/WeatherSettings.vue')
    old.state.useDeviceLocation()
    f.locate()
    const signal = f.fetch.mock.calls[0][1].signal
    old.unmount()
    expect(signal.aborted).toBe(true)
    const current = await mount('weather/WeatherSettings.vue')
    expect(await current.state.choose(place('B手选新地区'))).toBe(true)
    // The transport deliberately ignores abort; result guards must still protect persistence.
    reverse.resolve(reverseResponse())
    await flush()
    expect(f.settings.location.name).toBe('B手选新地区')
    expect(
      f.api.setSettingValue.mock.calls.filter(([id]) => id === 'weather.location')
    ).toHaveLength(1)
    expect(
      f.api.setSettingValue.mock.calls.filter(([id]) => id === 'weather.enabled')
    ).toHaveLength(1)
  })

  it.each(['resolve', 'reject'])(
    'does not save network fallback or coordinates after reverse %s on a closed view',
    async (result) => {
      const f = weatherFixture()
      const reverse = deferred()
      f.fetch.mockReturnValueOnce(reverse.promise)
      const view = await mount('weather/WeatherSettings.vue')
      view.state.useDeviceLocation()
      if (result === 'resolve') f.fail()
      else f.locate()
      view.unmount()
      if (result === 'resolve') reverse.resolve(reverseResponse())
      else reverse.reject(new Error('reverse lookup unavailable'))
      await flush()
      expect(f.api.setSettingValue).not.toHaveBeenCalled()
    }
  )

  it('cancels an unresolved manual region when another settings snapshot supplies a newer choice', async () => {
    const f = weatherFixture()
    const resolving = deferred()
    f.api.resolveWeatherLocation.mockReturnValueOnce(resolving.promise)
    const view = await mount('weather/WeatherSettings.vue')
    const first = view.state.choose({ id: 1, name: 'A旧地区' })
    f.broadcast({ location: place('B外部新地区') })
    resolving.resolve({ ...place('A旧地区'), id: 1 })
    expect(await first).toBe(false)
    expect(f.settings.location.name).toBe('B外部新地区')
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
    expect(view.state.busy.value).toBe('')
  })

  it('does not persist a manually resolved region after unmount', async () => {
    const f = weatherFixture()
    const resolving = deferred()
    f.api.resolveWeatherLocation.mockReturnValueOnce(resolving.promise)
    const view = await mount('weather/WeatherSettings.vue')
    const first = view.state.choose({ id: 1, name: 'A旧地区' })
    view.unmount()
    resolving.resolve({ ...place('A旧地区'), id: 1 })
    expect(await first).toBe(false)
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
  })

  it('does not re-enable weather when a dispatched location write settles after unmount', async () => {
    const f = weatherFixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount('weather/WeatherSettings.vue')
    const first = view.state.choose(place('A已发起写入'))
    view.unmount()
    writing.resolve()
    expect(await first).toBe(false)
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
  })

  it('does not save an old lookup after weather was disabled in a newer snapshot', async () => {
    const f = weatherFixture({ enabled: true })
    const reverse = deferred()
    f.fetch.mockReturnValueOnce(reverse.promise)
    const view = await mount('weather/WeatherSettings.vue')
    view.state.useDeviceLocation()
    f.locate()
    f.broadcast({ enabled: false })
    reverse.resolve(reverseResponse())
    await flush()
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
    expect(f.settings.enabled).toBe(false)
  })

  it('keeps an explicit choice ahead of automatic legacy-location enrichment', async () => {
    const f = weatherFixture({ location: { ...place('旧城市'), admin2: '' } })
    const reverse = deferred()
    f.fetch.mockReturnValueOnce(reverse.promise)
    const view = await mount('weather/WeatherSettings.vue')
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(await view.state.choose(place('B手选新地区'))).toBe(true)
    reverse.resolve(reverseResponse('A旧城市区'))
    await flush()
    expect(f.settings.location.name).toBe('B手选新地区')
    expect(
      f.api.setSettingValue.mock.calls.filter(([id]) => id === 'weather.location')
    ).toHaveLength(1)
  })

  it('still saves network fallback and coordinate-only results while the request is current', async () => {
    const f = weatherFixture()
    const view = await mount('weather/WeatherSettings.vue')
    view.state.useDeviceLocation()
    f.fail()
    await flush()
    expect(f.settings.location.name).toBe('测试市')
    expect(view.state.busy.value).toBe('')
    f.fetch.mockRejectedValueOnce(new Error('地名服务不可用'))
    view.state.useDeviceLocation()
    f.locate()
    await flush()
    expect(f.settings.location.name).toBe('设备位置')
    expect(view.state.error.value).toContain('已保存坐标')
    expect(view.state.busy.value).toBe('')
  })
})

describe('remote notice acknowledgement identity', () => {
  async function fixture() {
    const response = deferred()
    const acknowledgeRemoteNotice = vi.fn(() => response.promise)
    vi.stubGlobal('window', { api: { acknowledgeRemoteNotice } })
    const acknowledged = [],
      closed = []
    let view
    view = await mount('system/RemoteNoticeDialog.vue', {
      notices: [
        { id: 1, title: 'A' },
        { id: 2, title: 'B' }
      ],
      onAcknowledged(id) {
        acknowledged.push(id)
        view.props.notices = view.props.notices.filter((notice) => notice.id !== id)
      },
      onClose: () => closed.push(true)
    })
    return { ...view, response, acknowledgeRemoteNotice, acknowledged, closed }
  }

  it('acknowledges the submitted notice when the actual next-page button is clicked while waiting', async () => {
    const f = await fixture()
    const saving = f.state.acknowledge()
    void f.state.acknowledge()
    const next = findNode(f.root, (node) => node.props['aria-label'] === '下一条通知')
    expect(next.props.disabled).toBe(false)
    next.props.onClick()
    await flush()
    expect(f.state.current.value.id).toBe(2)
    f.response.resolve(true)
    await saving
    await flush()
    expect(f.acknowledgeRemoteNotice).toHaveBeenCalledExactlyOnceWith(1)
    expect(f.acknowledged).toEqual([1])
    expect(f.props.notices.map((notice) => notice.id)).toEqual([2])
    expect(f.state.current.value.id).toBe(2)
    expect(f.closed).toEqual([])
  })

  it.each([true, false])(
    'does not close a replacement notice after a %s response',
    async (changed) => {
      const f = await fixture()
      const saving = f.state.acknowledge()
      f.props.notices = [{ id: 3, title: 'C新通知' }]
      await flush()
      f.response.resolve(changed)
      await saving
      await flush()
      expect(f.acknowledged).toEqual(changed ? [1] : [])
      expect(f.state.current.value.id).toBe(3)
      expect(f.closed).toEqual([])
      expect(f.state.acknowledging.value).toBe(false)
    }
  )

  it('handles an emptied pending list without dereferencing a missing current notice', async () => {
    const f = await fixture()
    const saving = f.state.acknowledge()
    f.props.notices = []
    await flush()
    f.response.resolve(true)
    await expect(saving).resolves.toBeUndefined()
    expect(f.acknowledged).toEqual([1])
  })

  it('preserves unchanged-notice close behavior and ignores responses after unmount', async () => {
    const unchanged = await fixture()
    const first = unchanged.state.acknowledge()
    unchanged.response.resolve(false)
    await first
    expect(unchanged.closed).toEqual([true])
    unchanged.unmount()
    const removed = await fixture()
    const second = removed.state.acknowledge()
    removed.unmount()
    removed.response.resolve(true)
    await second
    expect(removed.acknowledged).toEqual([])
    expect(removed.closed).toEqual([])
  })
})
