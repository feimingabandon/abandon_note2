import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, isReadonly } from 'vue'

const location = { name: '北京', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }
const source = { token: 'date-context-document', scope: 'main' }
const settings = (weather, almanac = true, place = location, revision = 1) => ({
  source,
  revision,
  values: { weather: { enabled: weather, location: place }, almanac: { enabled: almanac } }
})
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const scopes = []
const leases = []
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
  leases.splice(0).forEach((lease) => lease.dispose())
  vi.unstubAllGlobals()
})
async function fixture(initial = settings(false)) {
  vi.resetModules()
  const listeners = {}
  const stopSettings = vi.fn()
  const stopForecast = vi.fn()
  const api = {
    getSettingsSnapshot: vi.fn(() => Promise.resolve(initial)),
    getWeatherForecast: vi.fn(() => Promise.resolve({ location, days: [] })),
    onSettingsChanged: vi.fn((fn) => {
      listeners.settings = fn
      return stopSettings
    }),
    onWeatherForecastUpdated: vi.fn((fn) => {
      listeners.forecast = fn
      return stopForecast
    })
  }
  vi.stubGlobal('window', { api })
  const { useDateContextSettings, acquireDateContextSettings } =
    await import('../src/renderer/src/composables/useDateContextSettings.js')
  const use = () => {
    const scope = effectScope()
    scopes.push(scope)
    return { model: scope.run(useDateContextSettings), scope }
  }
  const acquire = (bridge = api) => {
    const lease = acquireDateContextSettings(bridge)
    leases.push(lease)
    return lease
  }
  return { api, listeners, use, acquire, stopSettings, stopForecast }
}
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('shared date context settings', () => {
  it('shares subscriptions across summaries and releases them only after the last consumer', async () => {
    const f = await fixture()
    const first = f.use(),
      second = f.use()
    await flush()
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(1)
    expect(f.api.onSettingsChanged).toHaveBeenCalledTimes(1)
    f.listeners.settings(settings(false, false, location, 2))
    expect(first.model.almanacEnabled.value).toBe(false)
    expect(second.model.almanacEnabled.value).toBe(false)
    first.scope.stop()
    expect(f.stopSettings).not.toHaveBeenCalled()
    second.scope.stop()
    expect(f.stopSettings).toHaveBeenCalledTimes(1)
    expect(f.stopForecast).toHaveBeenCalledTimes(1)
  })
  it('does not let a late startup snapshot undo newer display switches', async () => {
    const pending = deferred()
    const f = await fixture()
    f.api.getSettingsSnapshot.mockReturnValue(pending.promise)
    const { model } = f.use()
    f.listeners.settings(settings(false, false, location, 2))
    pending.resolve(settings(true, true))
    await flush()
    expect(model.weatherEnabled.value).toBe(false)
    expect(model.almanacEnabled.value).toBe(false)
    expect(f.api.getWeatherForecast).not.toHaveBeenCalled()
  })
  it('clears disabled weather immediately and rejects an in-flight result and later broadcasts', async () => {
    const pending = deferred()
    const f = await fixture(settings(true))
    f.api.getWeatherForecast.mockReturnValue(pending.promise)
    const { model } = f.use()
    await flush()
    f.listeners.settings(settings(false, false, location, 2))
    pending.resolve({ location, days: [{ date: '2026-10-15' }] })
    f.listeners.forecast({ location, days: [] })
    await flush()
    expect(model.forecast.value).toBeNull()
    expect(model.weatherEnabled.value).toBe(false)
    expect(model.almanacEnabled.value).toBe(false)
  })
  it('keeps the newest location broadcast when an older request arrives later', async () => {
    const pending = deferred()
    const f = await fixture(settings(true))
    f.api.getWeatherForecast.mockReturnValue(pending.promise)
    const { model } = f.use()
    await flush()
    const nextPlace = { ...location, name: '上海', latitude: 31.2, longitude: 121.5 }
    f.listeners.settings(settings(true, true, nextPlace, 2))
    f.listeners.forecast({ location: nextPlace, days: [], fetchedAt: 123 })
    pending.resolve({ location, days: [] })
    await flush()
    expect(model.forecast.value.location.name).toBe('上海')
    expect(model.forecast.value.fetchedAt).toBe(123)
    expect(model.almanacEnabled.value).toBe(true)
  })
  it('defaults missing almanac settings to enabled without fetching disabled weather', async () => {
    const f = await fixture({ source, revision: 1, values: { weather: { enabled: false } } })
    const { model } = f.use()
    await flush()
    expect(model.almanacEnabled.value).toBe(true)
    expect(f.api.getWeatherForecast).not.toHaveBeenCalled()
  })
  it('keeps accepted display settings when an older revision or another document broadcasts', async () => {
    const f = await fixture(settings(false, false, location, 10))
    const { model } = f.use()
    await flush()
    f.listeners.settings(settings(true, true, location, 9))
    f.listeners.settings({
      ...settings(true, true, location, 99),
      source: { token: 'replacement-document', scope: 'main' }
    })
    expect(model.weatherEnabled.value).toBe(false)
    expect(model.almanacEnabled.value).toBe(false)
    expect(f.api.getWeatherForecast).not.toHaveBeenCalled()
  })

  it('shares explicit and scoped leases, readonly state and one initialization read', async () => {
    const f = await fixture(settings(true)),
      scoped = f.use(),
      explicit = f.acquire()
    await explicit.settingsReady
    await flush()
    expect(explicit.forecast).toBe(scoped.model.forecast)
    expect(explicit.loading).toBe(scoped.model.loading)
    for (const state of [
      explicit.forecast,
      explicit.weatherEnabled,
      explicit.almanacEnabled,
      explicit.loading,
      explicit.error
    ])
      expect(isReadonly(state)).toBe(true)
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(1)
    expect(f.api.onSettingsChanged).toHaveBeenCalledTimes(1)
    expect(f.api.onWeatherForecastUpdated).toHaveBeenCalledTimes(1)
    expect(f.api.getWeatherForecast).toHaveBeenCalledTimes(1)
    scoped.scope.stop()
    expect(f.stopForecast).not.toHaveBeenCalled()
    explicit.dispose()
    explicit.dispose()
    expect(f.stopForecast).toHaveBeenCalledTimes(1)
    expect(f.stopSettings).toHaveBeenCalledTimes(1)
    expect(explicit.forecast.value).toBeNull()
  })

  it('isolates two API documents without consulting the ambient window bridge', async () => {
    const f = await fixture(settings(true))
    const otherLocation = { ...location, name: '上海', latitude: 31.2, longitude: 121.5 }
    const otherApi = {
      getSettingsSnapshot: vi.fn(async () => ({
        ...settings(true, false, otherLocation),
        source: { token: 'second-api', scope: 'week' }
      })),
      getWeatherForecast: vi.fn(async () => ({ location: otherLocation, days: [] })),
      onSettingsChanged: vi.fn(() => vi.fn()),
      onWeatherForecastUpdated: vi.fn(() => vi.fn())
    }
    const first = f.acquire(),
      second = f.acquire(otherApi)
    await Promise.all([first.settingsReady, second.settingsReady])
    await flush()
    expect(first.forecast.value.location.name).toBe('北京')
    expect(second.forecast.value.location.name).toBe('上海')
    expect(first.almanacEnabled.value).toBe(true)
    expect(second.almanacEnabled.value).toBe(false)
    first.dispose()
    expect(second.forecast.value.location.name).toBe('上海')
  })

  it('invalidates the first A across A-B-A including its late catch and finally', async () => {
    const f = await fixture(settings(true)),
      firstA = deferred(),
      middleB = deferred(),
      finalA = deferred()
    f.api.getWeatherForecast
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(middleB.promise)
      .mockReturnValueOnce(finalA.promise)
    const model = f.acquire()
    await model.settingsReady
    const contextA = model.captureWeatherContext()
    const placeB = { ...location, name: '上海', latitude: 31.2, longitude: 121.5 }
    f.listeners.settings(settings(true, true, placeB, 2))
    expect(model.forecast.value).toBeNull()
    f.listeners.settings(settings(true, true, location, 3))
    const currentA = model.captureWeatherContext()
    expect(currentA.key).toBe(contextA.key)
    expect(currentA.generation).not.toBe(contextA.generation)
    expect(model.isWeatherContextCurrent(contextA)).toBe(false)
    firstA.resolve({ location, days: [{ date: 'old-A' }] })
    middleB.reject(new Error('old B failed'))
    await flush()
    expect(model.forecast.value).toBeNull()
    expect(model.loading.value).toBe(true)
    expect(model.error.value).toBe('')
    finalA.resolve({ location, days: [{ date: 'current-A' }], warning: '当前警告' })
    await flush()
    expect(model.forecast.value.days[0].date).toBe('current-A')
    expect(model.error.value).toBe('当前警告')
    expect(model.loading.value).toBe(false)
  })

  it('keeps a valid broadcast over late request failure without changing the settings context', async () => {
    const f = await fixture(settings(true)),
      model = f.acquire()
    await model.settingsReady
    await flush()
    const context = model.captureWeatherContext(),
      slow = deferred()
    f.api.getWeatherForecast.mockReturnValueOnce(slow.promise)
    const pending = model.loadForecast()
    f.listeners.forecast({ location, days: [], fetchedAt: 123, warning: '广播警告' })
    slow.reject(new Error('late request failed'))
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(model.forecast.value.fetchedAt).toBe(123)
    expect(model.loading.value).toBe(false)
    expect(model.error.value).toBe('广播警告')
    expect(model.isWeatherContextCurrent(context)).toBe(true)
    f.listeners.settings(settings(true, false, location, 2))
    expect(model.isWeatherContextCurrent(context)).toBe(true)
    expect(f.api.getWeatherForecast).toHaveBeenCalledTimes(2)
  })

  it.each([
    null,
    { location: { name: '没有坐标' }, days: [] },
    { location: { ...location, latitude: 31.2 }, days: [] }
  ])('rejects invalid or mismatched current results and broadcasts %#', async (result) => {
    const f = await fixture(settings(true)),
      model = f.acquire()
    await model.settingsReady
    await flush()
    const accepted = model.forecast.value
    f.listeners.forecast(result)
    expect(model.forecast.value).toBe(accepted)
    f.api.getWeatherForecast.mockResolvedValueOnce(result)
    expect((await model.loadForecast()).status).toBe('error')
    expect(model.forecast.value).toBeNull()
    expect(model.error.value).toContain('未完成')
    expect(model.loading.value).toBe(false)
  })

  it('requires a nonempty valid region before a request or broadcast can be accepted', async () => {
    const f = await fixture(settings(true, true, { name: '缺坐标' })),
      model = f.acquire()
    await model.settingsReady
    expect(model.captureWeatherContext()).toBeNull()
    expect(await model.loadForecast()).toEqual({ status: 'cancelled' })
    f.listeners.forecast({ location: { name: '缺坐标' }, days: [] })
    expect(model.forecast.value).toBeNull()
    expect(f.api.getWeatherForecast).not.toHaveBeenCalled()
    f.listeners.settings(settings(true, true, location, 2))
    await flush()
    expect(model.forecast.value.location).toEqual(location)
  })

  it('never revives a disposed lease when another consumer acquires the same API', async () => {
    const f = await fixture(settings(true)),
      oldResult = deferred(),
      newResult = deferred()
    f.api.getWeatherForecast
      .mockReturnValueOnce(oldResult.promise)
      .mockReturnValueOnce(newResult.promise)
    const old = f.acquire()
    await old.settingsReady
    const oldContext = old.captureWeatherContext(),
      oldListener = f.listeners.forecast
    old.dispose()
    const fresh = f.acquire()
    const freshContext = fresh.captureWeatherContext()
    expect(old.isWeatherContextCurrent(oldContext)).toBe(false)
    expect(fresh.isWeatherContextCurrent(oldContext)).toBe(false)
    expect(old.captureWeatherContext()).toBeNull()
    expect(await old.loadForecast()).toEqual({ status: 'cancelled' })
    oldListener({ location, days: [], warning: 'old subscriber' })
    oldResult.reject(new Error('old owner failure'))
    await flush()
    expect(old.forecast.value).toBeNull()
    expect(old.weatherEnabled.value).toBe(false)
    expect(fresh.loading.value).toBe(true)
    expect(fresh.error.value).toBe('')
    expect(fresh.isWeatherContextCurrent(freshContext)).toBe(true)
    newResult.resolve({ location, days: [], fetchedAt: 789 })
    await flush()
    expect(fresh.forecast.value.fetchedAt).toBe(789)
  })

  it('cancels a released request lease without letting its late finally stop a newer live request', async () => {
    const f = await fixture(settings(true)),
      first = f.acquire(),
      second = f.acquire()
    await first.settingsReady
    await flush()
    const oldResult = deferred(),
      newResult = deferred()
    f.api.getWeatherForecast
      .mockReturnValueOnce(oldResult.promise)
      .mockReturnValueOnce(newResult.promise)
    const old = first.loadForecast(),
      context = first.captureWeatherContext()
    first.dispose()
    const current = second.loadForecast()
    oldResult.reject(new Error('released lease'))
    expect(await old).toEqual({ status: 'cancelled' })
    expect(first.isWeatherContextCurrent(context)).toBe(false)
    expect(second.loading.value).toBe(true)
    expect(second.error.value).toBe('')
    newResult.resolve({ location, days: [] })
    expect((await current).status).toBe('success')
    expect(second.loading.value).toBe(false)
  })
})
