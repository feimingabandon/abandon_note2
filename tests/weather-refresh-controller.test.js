import { describe, expect, it, vi } from 'vitest'
import { createWeatherRefreshController } from '../src/main/services/weather-refresh-controller.js'
import { weatherFreshness, WEATHER_REFRESH_MS } from '../src/shared/weather-freshness.js'

const location = {
  name: '北京',
  latitude: 39.9,
  longitude: 116.4,
  timezone: 'Asia/Shanghai',
  countryCode: 'CN'
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
function harness() {
  let time = Date.parse('2026-09-28T04:00:00Z')
  let visible = true
  let settings = { enabled: true, location }
  let cached = null
  const publish = vi.fn()
  const network = vi.fn(async () => ({
    fetchedAt: time,
    location,
    days: [],
    cache: { stale: false }
  }))
  const service = {
    getForecast: vi.fn(async (_location, options) => {
      if (options.cacheOnly) return cached
      const result = await network()
      if (options.shouldStore()) cached = result
      return result
    })
  }
  const controller = createWeatherRefreshController({
    service,
    getSettings: () => settings,
    canAutoRefresh: () => visible,
    publish,
    now: () => time,
    random: () => 0
  })
  return {
    controller,
    network,
    publish,
    setVisible: (v) => (visible = v),
    advance: (ms) => (time += ms),
    setSettings(v) {
      settings = v
      controller.settingsChanged()
    },
    setCache: (v) => (cached = v),
    now: () => time
  }
}
describe('weather refresh policy', () => {
  it('refreshes at 30 minutes and pauses until a hidden window is restored', async () => {
    const h = harness()
    await h.controller.refresh()
    h.advance(WEATHER_REFRESH_MS - 1)
    await h.controller.refresh()
    expect(h.network).toHaveBeenCalledTimes(1)
    h.setVisible(false)
    h.advance(1)
    await h.controller.refresh()
    expect(h.network).toHaveBeenCalledTimes(1)
    h.setVisible(true)
    await h.controller.refresh()
    expect(h.network).toHaveBeenCalledTimes(2)
  })
  it('shares simultaneous manual and automatic requests including cold cache reads', async () => {
    const h = harness()
    const d = deferred()
    h.network.mockReturnValue(d.promise)
    const first = h.controller.refresh()
    const second = h.controller.refresh({ manual: true })
    expect(first).toBe(second)
    await Promise.resolve()
    expect(h.network).toHaveBeenCalledTimes(1)
    d.resolve({ fetchedAt: h.now(), cache: { stale: false } })
    await first
    await h.controller.refresh({ manual: true })
    expect(h.network).toHaveBeenCalledTimes(1)
  })
  it('discards A → B → A requests using the settings generation, and disabled results', async () => {
    const h = harness()
    const old = deferred()
    h.network.mockReturnValueOnce(old.promise)
    const first = h.controller.refresh()
    await Promise.resolve()
    h.setSettings({ enabled: true, location: { ...location, name: '上海', longitude: 121.4 } })
    h.setSettings({ enabled: true, location })
    old.resolve({ fetchedAt: h.now() })
    expect(await first).toBeNull()
    expect(h.publish).not.toHaveBeenCalled()
    h.advance(WEATHER_REFRESH_MS)
    const pending = deferred()
    h.network.mockReturnValueOnce(pending.promise)
    const next = h.controller.refresh()
    await Promise.resolve()
    h.setSettings({ enabled: false, location })
    pending.resolve({ fetchedAt: h.now() })
    expect(await next).toBeNull()
    expect(h.publish).not.toHaveBeenCalled()
  })
  it('backs off 5, 15, 30, 60 minutes and does not treat stale cache as success', async () => {
    const h = harness()
    h.network.mockResolvedValue({
      fetchedAt: h.now() - 3600_000,
      cache: { stale: true },
      failure: { status: 503 }
    })
    for (const [i, minutes] of [5, 15, 30, 60].entries()) {
      await h.controller.refresh()
      expect(h.network).toHaveBeenCalledTimes(i + 1)
      h.advance(minutes * 60_000 - 1)
      await h.controller.refresh()
      expect(h.network).toHaveBeenCalledTimes(i + 1)
      h.advance(1)
    }
    await h.controller.refresh()
    expect(h.network).toHaveBeenCalledTimes(5)
  })
  it('honors Retry-After across manual requests and recovery', async () => {
    const h = harness()
    h.network.mockRejectedValueOnce(
      Object.assign(new Error('limited'), { status: 429, retryAt: h.now() + 3600_000 })
    )
    await expect(h.controller.refresh()).rejects.toThrow('limited')
    h.advance(600_000)
    await expect(h.controller.refresh({ manual: true })).rejects.toThrow('limited')
    await h.controller.refresh()
    expect(h.network).toHaveBeenCalledTimes(1)
    h.advance(3000_000)
    await h.controller.refresh()
    expect(h.network).toHaveBeenCalledTimes(2)
  })
  it('stops parameter errors until settings change and permits manual recovery after backoff minimum', async () => {
    const h = harness()
    h.network.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 400 }))
    await expect(h.controller.refresh()).rejects.toThrow()
    h.advance(3600_000)
    await h.controller.refresh()
    expect(h.network).toHaveBeenCalledTimes(1)
    h.setSettings({ enabled: true, location: { ...location, name: '海淀' } })
    await h.controller.refresh()
    expect(h.network).toHaveBeenCalledTimes(2)
  })
  it('revalidates a cache when the system clock moves backwards', async () => {
    const h = harness()
    await h.controller.refresh()
    h.advance(-3600_000)
    await h.controller.refresh()
    expect(h.network).toHaveBeenCalledTimes(2)
  })
  it('separates current and daily expiry, timezone midnight and data time', () => {
    const now = Date.parse('2026-09-28T04:00:00Z')
    const f = {
      fetchedAt: now,
      timezone: 'Asia/Shanghai',
      current: { time: '2026-09-28T12:00', dataAt: now }
    }
    expect(weatherFreshness(f, now).currentVisible).toBe(true)
    expect(weatherFreshness(f, now + 2 * 3600_000).currentStale).toBe(true)
    expect(weatherFreshness(f, now + 6 * 3600_000).currentVisible).toBe(false)
    expect(weatherFreshness(f, now + 24 * 3600_000).dailyVisible).toBe(false)
    expect(
      weatherFreshness({ ...f, current: { ...f.current, time: '2026-09-27T12:00' } }, now)
        .currentVisible
    ).toBe(false)
  })
})
