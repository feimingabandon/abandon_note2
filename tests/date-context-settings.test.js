import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

const location = { name: '北京', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }
const settings = (weather, almanac = true, place = location) => ({
  values: { weather: { enabled: weather, location: place }, almanac: { enabled: almanac } }
})
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const scopes = []
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
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
  const { useDateContextSettings } =
    await import('../src/renderer/src/composables/useDateContextSettings.js')
  const use = () => {
    const scope = effectScope()
    scopes.push(scope)
    return { model: scope.run(useDateContextSettings), scope }
  }
  return { api, listeners, use, stopSettings, stopForecast }
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
    f.listeners.settings(settings(false, false))
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
    f.listeners.settings(settings(false, false))
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
    f.listeners.settings(settings(false, false))
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
    f.listeners.settings(settings(true, true, nextPlace))
    f.listeners.forecast({ location: nextPlace, days: [], fetchedAt: 123 })
    pending.resolve({ location, days: [] })
    await flush()
    expect(model.forecast.value.location.name).toBe('上海')
    expect(model.forecast.value.fetchedAt).toBe(123)
    expect(model.almanacEnabled.value).toBe(true)
  })
  it('defaults missing almanac settings to enabled without fetching disabled weather', async () => {
    const f = await fixture({ values: { weather: { enabled: false } } })
    const { model } = f.use()
    await flush()
    expect(model.almanacEnabled.value).toBe(true)
    expect(f.api.getWeatherForecast).not.toHaveBeenCalled()
  })
})
