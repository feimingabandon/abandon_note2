import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { babelParse, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { weatherLocationKey } from '../src/shared/weather-rules.js'

// Execute the production SFC's weather helper in a real Vue component scope.
// The shared weather owner and its settings transport are real; only IPC replies
// and timers are controlled. Unrelated SettingsPanel forms are not instantiated.
const source = parse(
  readFileSync(
    new URL('../src/renderer/src/components/system/SettingsPanel.vue', import.meta.url),
    'utf8'
  )
).descriptor.scriptSetup.content
const statements = babelParse(source, { sourceType: 'module' }).program.body
const helperNames = new Set([
  'weatherRefreshTime',
  'weatherRefreshErrorMessage',
  'useManualWeatherRefresh'
])
const helperSource = statements
  .filter((node) => node.type === 'FunctionDeclaration' && helperNames.has(node.id.name))
  .map((node) => source.slice(node.start, node.end))
  .join('\n')
if (
  !statements.some(
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.declarations.some(
        (declaration) => declaration.init?.callee?.name === 'useManualWeatherRefresh'
      )
  )
)
  throw new Error('SettingsPanel must call the tested weather helper')

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
const apps = new Set()
const locationA = {
  id: 110108,
  name: '海淀区',
  latitude: 39.96,
  longitude: 116.3,
  timezone: 'Asia/Shanghai',
  countryCode: 'CN'
}
const locationB = { ...locationA, id: 310115, name: '浦东新区', latitude: 31.22, longitude: 121.54 }
const forecastFor = (location = locationA, status = 'updated') => ({
  location,
  fetchedAt: Date.parse('2026-10-22T04:30:00Z'),
  days: [{ date: '2026-10-22' }, { date: '2026-10-23' }],
  manualRefresh: { status },
  warning: status === 'stale' ? '网络不可用' : ''
})
function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let index = 0; index < 12; index++) await vue.nextTick()
}

async function fixture({ enabled = true, location = locationA } = {}) {
  const listeners = new Set()
  const forecastListeners = new Set()
  let revision = 1
  let weather = { enabled, location }
  const snapshot = () => ({
    source: { token: 'manual-weather-document', scope: 'main' },
    revision,
    values: { weather: structuredClone(weather), almanac: { enabled: true } }
  })
  const api = {
    getSettingsSnapshot: vi.fn(async () => snapshot()),
    onSettingsChanged: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    onWeatherForecastUpdated: vi.fn((listener) => {
      forecastListeners.add(listener)
      return () => forecastListeners.delete(listener)
    }),
    getWeatherForecast: vi.fn(async () => forecastFor(weather.location)),
    refreshWeatherForecast: vi.fn()
  }
  vi.stubGlobal('window', { api })
  const { useDateContextSettings } =
    await import('../src/renderer/src/composables/useDateContextSettings.js')
  const useManualWeatherRefresh = new Function(
    'ref',
    'onBeforeUnmount',
    'useDateContextSettings',
    'weatherLocationKey',
    helperSource + '\nreturn useManualWeatherRefresh'
  )(vue.ref, vue.onBeforeUnmount, useDateContextSettings, weatherLocationKey)
  const mount = async () => {
    const notify = vi.fn()
    let state
    const app = renderer.createApp({
      setup() {
        state = useManualWeatherRefresh(notify)
        return () => vue.h('div')
      }
    })
    apps.add(app)
    app.mount({})
    await flush()
    return {
      state,
      notify,
      unmount() {
        if (apps.delete(app)) app.unmount()
      }
    }
  }
  const view = await mount()
  return {
    api,
    ...view,
    mount,
    setWeather(next) {
      weather = next
      revision++
      for (const listener of listeners) listener(snapshot())
    },
    publishForecast(value) {
      for (const listener of forecastListeners) listener(value)
    }
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
})
afterEach(async () => {
  for (const app of apps) app.unmount()
  apps.clear()
  await flush()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('manual weather feedback uses the actual shared context', () => {
  it.each([
    ['updated', 'success', /天气已更新：海淀区，共 2 天预报/],
    ['current', 'success', /复用最近 5 分钟内获取的天气：海淀区，获取于/],
    ['stale', 'warning', /天气更新失败，继续使用 .* 的缓存：网络不可用/]
  ])('preserves %s feedback and the 520ms action duration', async (status, level, message) => {
    const f = await fixture()
    const response = deferred()
    f.api.refreshWeatherForecast.mockReturnValueOnce(response.promise)
    const pending = f.state.refreshWeatherManually()
    await f.state.refreshWeatherManually()
    expect(f.api.refreshWeatherForecast).toHaveBeenCalledOnce()
    // A valid shared broadcast supersedes data reads, not the manual intent.
    f.publishForecast(forecastFor())
    response.resolve(forecastFor(locationA, status))
    await flush()
    expect(f.notify).toHaveBeenCalledOnce()
    expect(f.notify.mock.calls[0][0]).toBe(level)
    expect(f.notify.mock.calls[0][1]).toMatch(message)
    expect(f.state.weatherRefreshing.value).toBe(true)
    await vi.advanceTimersByTimeAsync(519)
    expect(f.state.weatherRefreshing.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(f.state.weatherRefreshing.value).toBe(false)
  })

  it('preserves the normal remote error message and permits a later action', async () => {
    const f = await fixture()
    f.api.refreshWeatherForecast.mockRejectedValueOnce(
      new Error("Error invoking remote method 'weather:refresh-forecast': Error: 服务不可用")
    )
    const failed = f.state.refreshWeatherManually()
    await flush()
    expect(f.notify).toHaveBeenCalledExactlyOnceWith('error', '服务不可用', 4000)
    await vi.advanceTimersByTimeAsync(520)
    await failed
    f.api.refreshWeatherForecast.mockResolvedValueOnce(forecastFor())
    const next = f.state.refreshWeatherManually()
    await flush()
    await vi.advanceTimersByTimeAsync(520)
    await next
    expect(f.api.refreshWeatherForecast).toHaveBeenCalledTimes(2)
    expect(f.notify.mock.calls[1][0]).toBe('success')
  })

  it.each([null, forecastFor(locationB)])(
    'reports a current but invalid reply as incomplete',
    async (reply) => {
      const f = await fixture()
      f.api.refreshWeatherForecast.mockResolvedValueOnce(reply)
      const pending = f.state.refreshWeatherManually()
      await flush()
      expect(f.notify).toHaveBeenCalledExactlyOnceWith(
        'warning',
        '天气更新尚未完成，请稍后重试',
        4000
      )
      await vi.advanceTimersByTimeAsync(520)
      await pending
      expect(f.state.weatherRefreshing.value).toBe(false)
    }
  )

  it.each([
    { enabled: false, location: locationA },
    { enabled: true, location: { name: '缺少坐标' } }
  ])('does not request without a valid enabled region', async (initial) => {
    const f = await fixture(initial)
    await f.state.refreshWeatherManually()
    expect(f.api.refreshWeatherForecast).not.toHaveBeenCalled()
    expect(f.notify).toHaveBeenCalledExactlyOnceWith(
      'warning',
      '请先开启天气显示并选择有效地区，再更新天气'
    )
    expect(f.state.weatherRefreshing.value).toBe(false)
  })

  it.each([
    ['disabled', false],
    ['disabled', true],
    ['A-B', false],
    ['A-B-A', false],
    ['A-B-A', true],
    ['unmounted', true]
  ])('suppresses invalidated %s feedback (rejected=%s)', async (change, rejected) => {
    const f = await fixture()
    const response = deferred()
    f.api.refreshWeatherForecast.mockReturnValueOnce(response.promise)
    const pending = f.state.refreshWeatherManually()
    if (change === 'unmounted') f.unmount()
    else if (change === 'disabled') f.setWeather({ enabled: false, location: locationA })
    else {
      f.setWeather({ enabled: true, location: locationB })
      if (change === 'A-B-A') f.setWeather({ enabled: true, location: locationA })
    }
    if (rejected) response.reject(new Error('旧请求失败'))
    else response.resolve(forecastFor())
    await flush()
    expect(f.notify).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(520)
    await pending
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.state.weatherRefreshing.value).toBe(change === 'unmounted')
  })

  it('does not write the disposed spinner after its delayed finally, or end the replacement action', async () => {
    const f = await fixture()
    f.api.refreshWeatherForecast.mockResolvedValueOnce(forecastFor())
    const old = f.state.refreshWeatherManually()
    await flush()
    expect(f.notify).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(200)
    f.unmount()
    const replacement = await f.mount()
    const response = deferred()
    f.api.refreshWeatherForecast.mockReturnValueOnce(response.promise)
    const fresh = replacement.state.refreshWeatherManually()
    await vi.advanceTimersByTimeAsync(320)
    await old
    expect(f.state.weatherRefreshing.value).toBe(true)
    expect(replacement.state.weatherRefreshing.value).toBe(true)
    response.resolve(forecastFor())
    await flush()
    expect(replacement.notify).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(200)
    await fresh
    expect(replacement.state.weatherRefreshing.value).toBe(false)
  })
})
