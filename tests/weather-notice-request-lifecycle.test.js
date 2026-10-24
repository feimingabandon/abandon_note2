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
  const almanac = { enabled: true }
  const wallpaper = { enabled: false, activeId: null, blurRadius: 8 }
  const runtime = { marker: 'initial' }
  const source = { token: 'weather-settings-document', scope: 'main' }
  let revision = 1
  const listeners = new Set()
  let success, failure
  const snapshot = () => ({
    source,
    revision,
    values: {
      weather: { ...settings, location: settings.location && { ...settings.location } },
      almanac: { ...almanac },
      wallpaper: { ...wallpaper }
    },
    runtime: { ...runtime }
  })
  const broadcast = (values) => {
    Object.assign(settings, values)
    revision += 1
    for (const listener of listeners) listener(snapshot())
  }
  const commitSetting = (id, value, emit = true) => {
    const [domain, key] = id.split('.')
    const target = { weather: settings, almanac, wallpaper }[domain]
    target[key] = value
    revision += 1
    const committed = snapshot()
    if (emit) for (const listener of listeners) listener(committed)
    return committed
  }
  const api = {
    getSettingsSnapshot: vi.fn(async () => snapshot()),
    getWeatherDivisionTree: vi.fn(async () => []),
    listWallpapers: vi.fn(async () => []),
    resolveWeatherLocation: vi.fn(async (candidate) => ({
      ...candidate,
      ...place(candidate.name)
    })),
    onSettingsChanged: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    reportLog: vi.fn(),
    setSettingValue: vi.fn(async (id, value) => commitSetting(id, value))
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
    almanac,
    wallpaper,
    runtime,
    snapshot,
    commitSetting,
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
  vi.useRealTimers()
})

describe('weather location request lifetime', () => {
  it.each([
    ['weather.enabled', 'enabled', true, false],
    ['almanac.enabled', 'almanacEnabled', false, true]
  ])(
    'protects an in-flight %s intent and then reconciles the canonical value',
    async (id, field, attempted, canonical) => {
      const f = weatherFixture()
      const writing = deferred()
      f.api.setSettingValue.mockReturnValueOnce(writing.promise)
      const view = await mount('weather/WeatherSettings.vue')
      view.state[field].value = attempted
      const saving =
        id === 'weather.enabled'
          ? view.state.persistEnabled(attempted)
          : view.state.persistAlmanacEnabled(attempted)
      f.runtime.marker = 'new native observation'
      f.broadcast({})
      expect(view.state[field].value).toBe(attempted)
      expect(view.state.settingsSnapshots.latest().runtime.marker).toBe('new native observation')
      expect(view.state.settingsSnapshots.protectedCount).toBe(1)
      // A later unrelated snapshot can overtake the commit reply while its
      // local preview is protected. The accepted base must still win on release.
      const committed = f.commitSetting(id, canonical, false)
      f.broadcast({})
      writing.resolve(committed)
      await saving
      expect(view.state[field].value).toBe(canonical)
      expect(view.state.settingsSnapshots.protectedCount).toBe(0)
      expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(1)
    }
  )

  it.each([false, true])(
    'restores actual enabled=%s only after the failed-write read completes',
    async (actualEnabled) => {
      const f = weatherFixture()
      const writing = deferred()
      const readingActual = deferred()
      const view = await mount('weather/WeatherSettings.vue')
      f.api.setSettingValue.mockReturnValueOnce(writing.promise)
      f.api.getSettingsSnapshot.mockReturnValueOnce(readingActual.promise)
      view.state.enabled.value = true
      const saving = view.state.persistEnabled(true)
      if (actualEnabled) f.commitSetting('weather.enabled', true, false)
      writing.reject(new Error('disk write failed'))
      await flush()
      f.broadcast({})
      expect(view.state.enabled.value).toBe(true)
      expect(view.state.settingsSnapshots.protectedCount).toBe(1)
      readingActual.resolve(f.snapshot())
      await saving
      expect(view.state.enabled.value).toBe(actualEnabled)
      expect(view.state.settingsSnapshots.protectedCount).toBe(0)
      expect(view.state.error.value).toContain('disk write failed')
    }
  )

  it('retains an unconfirmed failed intent across broadcasts and releases it on unmount', async () => {
    const f = weatherFixture()
    const view = await mount('weather/WeatherSettings.vue')
    f.api.setSettingValue.mockRejectedValueOnce(new Error('disk write failed'))
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('actual state unavailable'))
    view.state.almanacEnabled.value = false
    await view.state.persistAlmanacEnabled(false)
    f.broadcast({})
    expect(view.state.almanacEnabled.value).toBe(false)
    expect(view.state.settingsSnapshots.protectedCount).toBe(1)
    expect(view.state.error.value).toContain('disk write failed')
    view.unmount()
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('keeps unrelated snapshots from canceling location and enable writes in flight', async () => {
    const f = weatherFixture()
    const locationWrite = deferred()
    const enabledWrite = deferred()
    f.api.setSettingValue
      .mockReturnValueOnce(locationWrite.promise)
      .mockReturnValueOnce(enabledWrite.promise)
    const view = await mount('weather/WeatherSettings.vue')
    const candidate = place('B正在保存地区')
    const saving = view.state.choose(candidate)
    f.broadcast({})
    expect(view.state.location.value.name).toBe(candidate.name)
    locationWrite.resolve(f.commitSetting('weather.location', candidate, false))
    await flush()
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual([
      'weather.location',
      'weather.enabled'
    ])
    f.broadcast({})
    expect(view.state.enabled.value).toBe(true)
    enabledWrite.resolve(f.commitSetting('weather.enabled', true, false))
    expect(await saving).toBe(true)
    expect(view.state.location.value.name).toBe(candidate.name)
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('does not auto-enable after a higher revision supplies another location during a write', async () => {
    const f = weatherFixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount('weather/WeatherSettings.vue')
    const candidate = place('A本地候选')
    const saving = view.state.choose(candidate)
    const committed = f.commitSetting('weather.location', candidate, false)
    f.broadcast({ location: place('B外部新地区') })
    expect(view.state.location.value.name).toBe(candidate.name)
    writing.resolve(committed)
    expect(await saving).toBe(false)
    expect(view.state.location.value.name).toBe('B外部新地区')
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('restores the actual region after a failed write without enabling weather', async () => {
    const f = weatherFixture()
    const view = await mount('weather/WeatherSettings.vue')
    f.api.setSettingValue.mockRejectedValueOnce(new Error('region write failed'))
    expect(await view.state.choose(place('A保存失败地区'))).toBe(false)
    expect(view.state.location.value.name).toBe('C原地区')
    expect(view.state.enabled.value).toBe(false)
    expect(view.state.error.value).toContain('region write failed')
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(2)
  })

  it('shows reset defaults after an unconfirmed failed weather-settings owner', async () => {
    const f = weatherFixture()
    const view = await mount('weather/WeatherSettings.vue')
    f.api.setSettingValue.mockRejectedValueOnce(new Error('宜忌保存失败'))
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('实际状态读取失败'))
    view.state.almanacEnabled.value = false
    await view.state.persistAlmanacEnabled(false)
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    const reset = f.commitSetting('almanac.enabled', true, false)
    view.state.settingsSnapshots.acceptReset(reset, { checkpoint })
    expect(view.state.almanacEnabled.value).toBe(true)
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
  })

  it('does not consume a reset-revoked location reply or dispatch its second enable write', async () => {
    const f = weatherFixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount('weather/WeatherSettings.vue')
    const saving = view.state.choose(place('A旧候选'))
    const committed = f.commitSetting('weather.location', place('A旧候选'), false)
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    // Keep the original location so the reset does not rely on a different
    // request comparison key to cancel the old second step.
    const reset = f.commitSetting('weather.location', place('C原地区'), false)
    view.state.settingsSnapshots.acceptReset(reset, { checkpoint })
    writing.resolve(committed)
    expect(await saving).toBe(false)
    expect(view.state.location.value.name).toBe('C原地区')
    expect(view.state.enabled.value).toBe(false)
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
  })

  it('ignores a failed toggle reply after reset instead of starting stale actual-state recovery', async () => {
    const f = weatherFixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount('weather/WeatherSettings.vue')
    view.state.enabled.value = true
    const saving = view.state.persistEnabled(true)
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    view.state.settingsSnapshots.acceptReset(f.commitSetting('weather.enabled', false, false), {
      checkpoint
    })
    writing.reject(new Error('reset之前的失败'))
    await saving
    expect(view.state.enabled.value).toBe(false)
    expect(view.state.error.value).toBe('')
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(1)
  })

  it.each(['manual', 'device'])(
    'cancels an unresolved %s location request when reset keeps the same defaults',
    async (kind) => {
      const f = weatherFixture()
      const resolving = deferred()
      if (kind === 'manual') f.api.resolveWeatherLocation.mockReturnValueOnce(resolving.promise)
      else f.fetch.mockReturnValueOnce(resolving.promise)
      const view = await mount('weather/WeatherSettings.vue')
      let saving
      if (kind === 'manual') saving = view.state.choose({ id: 3, name: 'A旧解析' })
      else {
        view.state.useDeviceLocation()
        f.locate()
      }
      const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
      const reset = f.commitSetting('weather.location', place('C原地区'), false)
      view.state.settingsSnapshots.acceptReset(reset, { checkpoint })
      expect(view.state.busy.value).toBe('')
      if (kind === 'manual') {
        resolving.resolve({ ...place('A旧解析'), id: 3 })
        expect(await saving).toBe(false)
      } else {
        expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(true)
        resolving.resolve(reverseResponse())
      }
      await flush()
      expect(view.state.location.value.name).toBe('C原地区')
      expect(view.state.settingsSnapshots.protectedCount).toBe(0)
      expect(f.api.setSettingValue).not.toHaveBeenCalled()
    }
  )

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

describe('wallpaper blur intent lifetime', () => {
  it('suppresses snapshot write-back and reconciles a normalized committed blur value', async () => {
    const f = weatherFixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount('wallpaper/WallpaperSettings.vue')
    vi.useFakeTimers()
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
    view.state.blurRadius.value = 23
    f.broadcast({})
    expect(view.state.blurRadius.value).toBe(23)
    expect(view.state.settingsSnapshots.protectedCount).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('wallpaper.blurRadius', 23)
    const committed = f.commitSetting('wallpaper.blurRadius', 20, false)
    f.broadcast({})
    writing.resolve(committed)
    await flush()
    expect(view.state.blurRadius.value).toBe(20)
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    await vi.advanceTimersByTimeAsync(250)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
  })

  it.each(['timer', 'unmount'])(
    'does not dispatch a reset-revoked blur intent from its %s flush',
    async (phase) => {
      const f = weatherFixture()
      const view = await mount('wallpaper/WallpaperSettings.vue')
      vi.useFakeTimers()
      view.state.blurRadius.value = 23
      const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
      view.state.settingsSnapshots.acceptReset(f.commitSetting('wallpaper.blurRadius', 8, false), {
        checkpoint
      })
      if (phase === 'timer') await vi.advanceTimersByTimeAsync(250)
      view.unmount()
      await flush()
      expect(view.state.blurRadius.value).toBe(8)
      expect(view.state.settingsSnapshots.protectedCount).toBe(0)
      expect(f.api.setSettingValue).not.toHaveBeenCalled()
    }
  )

  it('shows reset blur after an unconfirmed failed wallpaper owner without writing it back', async () => {
    const f = weatherFixture()
    const view = await mount('wallpaper/WallpaperSettings.vue')
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.api.setSettingValue.mockRejectedValueOnce(new Error('blur save failed'))
    view.state.blurRadius.value = 23
    await vi.advanceTimersByTimeAsync(250)
    expect(view.state.settingsSnapshots.protectedCount).toBe(1)
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    view.state.settingsSnapshots.acceptReset(f.commitSetting('wallpaper.blurRadius', 8, false), {
      checkpoint
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(view.state.blurRadius.value).toBe(8)
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
  })

  it('does not consume a late wallpaper blur commit after reset revoked its lease', async () => {
    const f = weatherFixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const view = await mount('wallpaper/WallpaperSettings.vue')
    vi.useFakeTimers()
    view.state.blurRadius.value = 23
    await vi.advanceTimersByTimeAsync(250)
    const committed = f.commitSetting('wallpaper.blurRadius', 23, false)
    const checkpoint = view.state.settingsSnapshots.captureIntentCheckpoint()
    view.state.settingsSnapshots.acceptReset(f.commitSetting('wallpaper.blurRadius', 8, false), {
      checkpoint
    })
    writing.resolve(committed)
    await flush()
    expect(view.state.blurRadius.value).toBe(8)
    expect(view.state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
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
