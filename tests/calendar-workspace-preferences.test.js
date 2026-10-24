import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useCalendarWorkspacePreferences } from '../src/renderer/src/composables/useCalendarWorkspacePreferences.js'
import { getSettingsSnapshotStore } from '../src/renderer/src/utils/settingsSnapshots.js'
import { acquireDateContextSettings } from '../src/renderer/src/composables/useDateContextSettings.js'

const cleanups = []
const location = { name: '测试地区', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function settings({ enabled = true, preview = false } = {}, revision = 1) {
  return {
    source: { token: 'calendar-preferences-document', scope: 'month' },
    revision,
    values: {
      weather: { enabled, location: enabled ? location : null },
      calendar: { recurringPreviewEnabled: preview }
    }
  }
}
function fixture() {
  const stored = { enabled: true, preview: false }
  const listeners = new Set()
  const forecastListeners = new Set()
  let revision = 1
  const snapshot = () => settings(stored, revision)
  const broadcast = (values, { emit = true } = {}) => {
    Object.assign(stored, values)
    revision += 1
    const committed = snapshot()
    if (emit) for (const listener of listeners) listener(committed)
    return committed
  }
  const api = {
    getWeatherForecast: vi.fn(async () => ({ location, days: [] })),
    getSettingsSnapshot: vi.fn(async () => snapshot()),
    onSettingsChanged: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    onWeatherForecastUpdated: vi.fn((listener) => {
      forecastListeners.add(listener)
      return () => forecastListeners.delete(listener)
    }),
    setSettingValue: vi.fn(async (_id, value) => broadcast({ preview: value }))
  }
  const refreshCalendar = vi.fn(async () => ({ status: 'success' }))
  const notify = vi.fn()
  const clock = ref(Date.now() - 60000)
  const snapshots = getSettingsSnapshotStore(api)
  snapshots.acceptCommitted(snapshot())
  const model = useCalendarWorkspacePreferences({ api, clock, refreshCalendar, notify })
  model.applyInitialSettings(snapshot())
  // Match MonthWorkspace's ownership: it delivers accepted store snapshots to
  // the provider, rather than the provider creating a second subscription.
  const stop = snapshots.subscribe((value) => model.applySettings(value), { replay: false })
  cleanups.push(() => {
    stop()
    model.dispose()
  })
  const forecast = (value) =>
    [...forecastListeners].map((listener) => listener(value)).some(Boolean)
  return { api, model, refreshCalendar, notify, clock, snapshots, snapshot, broadcast, forecast }
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
})

describe('calendar weather preferences lifetime', () => {
  it('rejects old forecast and finally while a newer request remains pending', async () => {
    const { api, model } = fixture()
    const old = deferred(),
      fresh = deferred()
    api.getWeatherForecast.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const first = model.loadWeather(),
      second = model.loadWeather()
    old.resolve({ location, marker: 'old request', days: [] })
    expect((await first).status).toBe('cancelled')
    expect(model.weatherLoading.value).toBe(true)
    expect(model.weatherForecast.value).toBeNull()
    fresh.resolve({ location, marker: 'new request', warning: '测试警告', days: [] })
    expect((await second).status).toBe('success')
    expect(model.weatherForecast.value.marker).toBe('new request')
    expect(model.weatherLoading.value).toBe(false)
    expect(model.weatherError.value).toBe('测试警告')
  })
  it('preserves a broadcast over a late failed request without a stale notification', async () => {
    const { api, model, notify, forecast } = fixture()
    const slow = deferred()
    api.getWeatherForecast.mockReturnValueOnce(slow.promise)
    const request = model.loadWeather()
    forecast({ location, marker: 'accepted broadcast', days: [] })
    slow.reject(new Error('旧失败'))
    expect((await request).status).toBe('cancelled')
    expect(model.weatherForecast.value.marker).toBe('accepted broadcast')
    expect(model.weatherLoading.value).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })
  it('turns weather off immediately and rejects pending and later broadcasts', async () => {
    const { api, model, broadcast, forecast } = fixture()
    const slow = deferred()
    api.getWeatherForecast.mockReturnValueOnce(slow.promise)
    const request = model.loadWeather()
    broadcast({ enabled: false })
    expect(model.weatherLoading.value).toBe(false)
    expect(forecast({ location, days: [] })).toBe(false)
    slow.resolve({ days: [] })
    expect((await request).status).toBe('cancelled')
    expect(model.weatherForecast.value).toBeNull()
    expect(model.weatherError.value).toBe('')
  })
  it('reports a foreground failure but keeps a quiet failure out of messages', async () => {
    const { api, model, notify } = fixture()
    api.getWeatherForecast.mockRejectedValue(new Error('离线'))
    await model.loadWeather({ quiet: true })
    expect(model.weatherError.value).toBe('离线')
    expect(notify).not.toHaveBeenCalled()
    await model.loadWeather()
    expect(notify).toHaveBeenCalledExactlyOnceWith('warning', '离线')
    expect(model.weatherLoading.value).toBe(false)
  })
  it('evaluates a fresh receipt immediately before the next shared minute tick', () => {
    const { model, clock, forecast } = fixture()
    const now = Date.parse('2026-10-09T02:01:30Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    clock.value = now - 30000
    forecast({
      location,
      fetchedAt: now,
      timezone: 'Asia/Shanghai',
      days: [{ date: '2026-10-09', weatherCode: 0, temperatureMin: 10, temperatureMax: 20 }]
    })
    expect(model.weatherState.value.dailyVisible).toBe(true)
    expect(model.weatherState.value.stale).toBe(false)
    expect(model.weatherByDate.value.has('2026-10-09')).toBe(true)
    clock.value = now + 25 * 3600000
    expect(model.weatherByDate.value.size).toBe(0)
  })
  it('ignores weather, settings and notifications after disposal', async () => {
    const { api, model, notify, forecast } = fixture()
    const slow = deferred()
    api.getWeatherForecast.mockReturnValueOnce(slow.promise)
    const request = model.loadWeather()
    model.dispose()
    model.applySettings(settings({ preview: true }))
    slow.reject(new Error('卸载后的失败'))
    expect((await request).status).toBe('cancelled')
    expect(forecast({ location, days: [] })).toBe(false)
    expect(model.recurringPreviewEnabled.value).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })
  it('shares the calendar lease with other date consumers and skips unrelated-setting refetches', async () => {
    const { api, model, forecast, broadcast } = fixture()
    const detail = acquireDateContextSettings(api)
    cleanups.push(detail.dispose)
    await detail.settingsReady
    expect(model.weatherForecast).toBe(detail.forecast)
    expect(api.onWeatherForecastUpdated).toHaveBeenCalledTimes(1)
    expect(api.onSettingsChanged).toHaveBeenCalledTimes(1)
    expect(api.getSettingsSnapshot).not.toHaveBeenCalled()
    broadcast({ preview: true })
    expect(api.getWeatherForecast).toHaveBeenCalledTimes(1)
    forecast({ location, warning: '共享警告', days: [] })
    expect(model.weatherError.value).toBe('共享警告')
    expect(detail.error.value).toBe('共享警告')
    model.dispose()
    expect(detail.forecast.value.location).toEqual(location)
    expect(forecast({ location, days: [], fetchedAt: 111 })).toBe(true)
    expect(detail.forecast.value.fetchedAt).toBe(111)
  })
})

describe('calendar recurring preview persistence', () => {
  it('settles a saved preference without canonical values while keeping weather and the chosen preview', async () => {
    const f = fixture()
    f.api.setSettingValue.mockResolvedValueOnce({
      kind: 'settings-saved',
      source: f.snapshot().source,
      persistence: { status: 'saved', commitId: 'preview-save' },
      snapshot: null,
      application: { status: 'failed' },
      snapshotError: { message: 'readback unavailable' }
    })
    expect((await f.model.updateRecurringPreviewEnabled(true)).status).toBe('success')
    expect(f.model.recurringPreviewEnabled.value).toBe(true)
    expect(f.model.weatherEnabled.value).toBe(true)
    expect(f.snapshots.protectedCount).toBe(0)
    expect(f.snapshots.status().awaitingCanonical).toBe(true)
    f.model.applyInitialSettings(null)
    expect(f.model.applySettings(null)).toEqual({ previewChanged: false })
    expect(f.model.weatherEnabled.value).toBe(true)
    expect(f.model.recurringPreviewEnabled.value).toBe(true)
    expect(f.api.setSettingValue).toHaveBeenCalledOnce()
    expect(f.api.getSettingsSnapshot).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
  })

  it('does not save during initialization/broadcast and saves one shared key per accepted action', async () => {
    const { api, model, refreshCalendar } = fixture()
    model.applySettings(settings({ enabled: false, preview: true }))
    expect(api.setSettingValue).not.toHaveBeenCalled()
    expect(model.requestOptions()).toEqual({ includeRecurringPreviews: true })
    expect((await model.updateRecurringPreviewEnabled(true)).status).toBe('unchanged')
    expect((await model.updateRecurringPreviewEnabled(false)).status).toBe('success')
    expect(api.setSettingValue).toHaveBeenCalledExactlyOnceWith(
      'calendar.recurringPreviewEnabled',
      false
    )
    expect(model.requestOptions()).toEqual({ includeRecurringPreviews: false })
    expect(refreshCalendar).toHaveBeenCalledTimes(1)
    expect(model.recurringPreviewSaving.value).toBe(false)
  })
  it('rolls back a rejected save and refreshes with the prior preview choice', async () => {
    const { api, model, refreshCalendar, notify } = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.setSettingValue.mockRejectedValueOnce(new Error('保存拒绝'))
    refreshCalendar.mockImplementationOnce(async () => {
      expect(model.requestOptions()).toEqual({ includeRecurringPreviews: false })
    })
    expect((await model.updateRecurringPreviewEnabled(true)).status).toBe('error')
    expect(model.recurringPreviewEnabled.value).toBe(false)
    expect(model.recurringPreviewSaving.value).toBe(false)
    expect(notify).toHaveBeenCalledExactlyOnceWith('error', '保存拒绝')
  })
  it('keeps a successful persisted choice when the following refresh throws', async () => {
    const { model, refreshCalendar, notify } = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    refreshCalendar.mockRejectedValueOnce(new Error('同步失败'))
    expect((await model.updateRecurringPreviewEnabled(true)).status).toBe('success')
    expect(model.recurringPreviewEnabled.value).toBe(true)
    expect(notify).toHaveBeenCalledExactlyOnceWith('error', '同步失败')
  })
  it('preserves newer settings intent over a failed save and gates repeated local actions', async () => {
    const { api, model, refreshCalendar, broadcast } = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const slow = deferred()
    api.setSettingValue.mockReturnValueOnce(slow.promise)
    const save = model.updateRecurringPreviewEnabled(true)
    expect((await model.updateRecurringPreviewEnabled(false)).status).toBe('cancelled')
    broadcast({ enabled: false, preview: false })
    broadcast({ enabled: false, preview: true })
    slow.reject(new Error('旧保存失败'))
    await save
    expect(api.setSettingValue).toHaveBeenCalledTimes(1)
    expect(model.recurringPreviewEnabled.value).toBe(true)
    expect(refreshCalendar).toHaveBeenCalledTimes(1)
  })
  it('does not refresh or notify when a pending save fails after unmount', async () => {
    const { api, model, refreshCalendar, notify } = fixture()
    const slow = deferred()
    api.setSettingValue.mockReturnValueOnce(slow.promise)
    const save = model.updateRecurringPreviewEnabled(true)
    model.dispose()
    slow.reject(new Error('晚失败'))
    expect((await save).status).toBe('cancelled')
    expect(model.recurringPreviewSaving.value).toBe(false)
    expect(refreshCalendar).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('protects the optimistic choice from unrelated snapshots and releases to the accepted actual value', async () => {
    const f = fixture()
    const slow = deferred()
    f.api.setSettingValue.mockReturnValueOnce(slow.promise)
    const save = f.model.updateRecurringPreviewEnabled(true)
    f.broadcast({ enabled: false })
    expect(f.model.recurringPreviewEnabled.value).toBe(true)
    expect(f.model.requestOptions()).toEqual({ includeRecurringPreviews: true })
    expect(f.snapshots.protectedCount).toBe(1)
    const committed = f.broadcast({ preview: false }, { emit: false })
    f.broadcast({})
    slow.resolve(committed)
    expect((await save).status).toBe('success')
    expect(f.model.recurringPreviewEnabled.value).toBe(false)
    expect(f.snapshots.protectedCount).toBe(0)
    expect(f.api.getSettingsSnapshot).not.toHaveBeenCalled()
    expect(f.refreshCalendar).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'restores failed-save actual=%s only after fresh readback',
    async (actual) => {
      const f = fixture()
      const writing = deferred(),
        reading = deferred()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      f.api.setSettingValue.mockReturnValueOnce(writing.promise)
      f.api.getSettingsSnapshot.mockReturnValueOnce(reading.promise)
      const save = f.model.updateRecurringPreviewEnabled(true)
      f.broadcast({ enabled: false, preview: actual })
      writing.reject(new Error('写入结果未确认'))
      await Promise.resolve()
      await Promise.resolve()
      f.broadcast({})
      expect(f.model.recurringPreviewEnabled.value).toBe(true)
      expect(f.snapshots.protectedCount).toBe(1)
      expect(f.model.recurringPreviewSaving.value).toBe(true)
      reading.resolve(f.snapshot())
      expect((await save).status).toBe('error')
      expect(f.model.recurringPreviewEnabled.value).toBe(actual)
      expect(f.snapshots.protectedCount).toBe(0)
      expect(f.model.recurringPreviewSaving.value).toBe(false)
      expect(f.refreshCalendar).toHaveBeenCalledTimes(1)
      expect(f.notify).toHaveBeenCalledExactlyOnceWith('error', '写入结果未确认')
    }
  )

  it('keeps a failed choice protected when actual-state readback fails and clears it on disposal', async () => {
    const f = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.api.setSettingValue.mockRejectedValueOnce(new Error('保存失败'))
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('读取失败'))
    expect((await f.model.updateRecurringPreviewEnabled(true)).status).toBe('error')
    f.broadcast({ enabled: false, preview: false })
    expect(f.model.recurringPreviewEnabled.value).toBe(true)
    expect(f.snapshots.protectedCount).toBe(1)
    f.model.dispose()
    expect(f.snapshots.protectedCount).toBe(0)
  })

  it.each(['resolve', 'reject'])(
    'does not refresh after actual-state readback %s following disposal',
    async (result) => {
      const f = fixture()
      const reading = deferred()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      f.api.setSettingValue.mockRejectedValueOnce(new Error('保存失败'))
      f.api.getSettingsSnapshot.mockReturnValueOnce(reading.promise)
      const save = f.model.updateRecurringPreviewEnabled(true)
      await Promise.resolve()
      await Promise.resolve()
      f.model.dispose()
      if (result === 'resolve') reading.resolve(f.snapshot())
      else reading.reject(new Error('晚读取失败'))
      expect((await save).status).toBe('cancelled')
      expect(f.refreshCalendar).not.toHaveBeenCalled()
      expect(f.snapshots.protectedCount).toBe(0)
    }
  )

  it('shows reset defaults after a failed preview owner and does not restore its stale choice', async () => {
    const f = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.api.setSettingValue.mockRejectedValueOnce(new Error('保存失败'))
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('读取失败'))
    await f.model.updateRecurringPreviewEnabled(true)
    const checkpoint = f.snapshots.captureIntentCheckpoint()
    f.snapshots.acceptReset(f.broadcast({ preview: false }, { emit: false }), { checkpoint })
    expect(f.model.recurringPreviewEnabled.value).toBe(false)
    expect(f.snapshots.protectedCount).toBe(0)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
  })

  it('does not consume an old successful preview reply after reset revoked its lease', async () => {
    const f = fixture()
    const writing = deferred()
    f.api.setSettingValue.mockReturnValueOnce(writing.promise)
    const save = f.model.updateRecurringPreviewEnabled(true)
    const committed = f.broadcast({ preview: true }, { emit: false })
    const checkpoint = f.snapshots.captureIntentCheckpoint()
    f.snapshots.acceptReset(f.broadcast({ preview: false }, { emit: false }), { checkpoint })
    writing.resolve(committed)
    expect((await save).status).toBe('cancelled')
    expect(f.model.recurringPreviewEnabled.value).toBe(false)
    expect(f.snapshots.protectedCount).toBe(0)
    expect(f.refreshCalendar).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'])(
    'does not refresh stale failed-preview recovery after reset and readback %s',
    async (result) => {
      const f = fixture()
      const reading = deferred()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      f.api.setSettingValue.mockRejectedValueOnce(new Error('保存失败'))
      f.api.getSettingsSnapshot.mockReturnValueOnce(reading.promise)
      const save = f.model.updateRecurringPreviewEnabled(true)
      await Promise.resolve()
      await Promise.resolve()
      const checkpoint = f.snapshots.captureIntentCheckpoint()
      f.snapshots.acceptReset(f.broadcast({ preview: false }, { emit: false }), { checkpoint })
      if (result === 'resolve') reading.resolve(f.snapshot())
      else reading.reject(new Error('晚读取失败'))
      expect((await save).status).toBe('cancelled')
      expect(f.model.recurringPreviewEnabled.value).toBe(false)
      expect(f.snapshots.protectedCount).toBe(0)
      expect(f.refreshCalendar).not.toHaveBeenCalled()
    }
  )
})

describe('calendar quick-create duration preference', () => {
  it('reads the shared choice without changing calendar data, writes or detailed preferences', () => {
    const { api, model, refreshCalendar } = fixture()
    expect(model.quickCreateUntilCompleted.value).toBe(false)
    model.applyInitialSettings({
      values: { notes: { quickCreateUntilCompleted: true } }
    })
    expect(model.quickCreateUntilCompleted.value).toBe(true)
    expect(
      model.applySettings({
        values: { notes: { quickCreateUntilCompleted: false } }
      }).previewChanged
    ).toBe(false)
    expect(model.quickCreateUntilCompleted.value).toBe(false)
    expect(refreshCalendar).not.toHaveBeenCalled()
    expect(api.setSettingValue).not.toHaveBeenCalled()

    model.dispose()
    model.applyInitialSettings({ values: { notes: { quickCreateUntilCompleted: true } } })
    model.applySettings({ values: { notes: { quickCreateUntilCompleted: true } } })
    expect(model.quickCreateUntilCompleted.value).toBe(false)
  })
})
