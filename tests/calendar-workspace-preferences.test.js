import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useCalendarWorkspacePreferences } from '../src/renderer/src/composables/useCalendarWorkspacePreferences.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function settings({ enabled = true, preview = false } = {}) {
  return {
    values: {
      weather: { enabled, location: enabled ? { name: '测试地区' } : null },
      calendar: { recurringPreviewEnabled: preview }
    }
  }
}
function fixture() {
  const api = { getWeatherForecast: vi.fn(), setSettingValue: vi.fn(async () => {}) }
  const refreshCalendar = vi.fn(async () => ({ status: 'success' }))
  const notify = vi.fn()
  const clock = ref(Date.now() - 60000)
  const model = useCalendarWorkspacePreferences({ api, clock, refreshCalendar, notify })
  model.applyInitialSettings(settings())
  return { api, model, refreshCalendar, notify, clock }
}
afterEach(() => vi.restoreAllMocks())

describe('calendar weather preferences lifetime', () => {
  it('rejects old forecast and finally while a newer request remains pending', async () => {
    const { api, model } = fixture()
    const old = deferred(),
      fresh = deferred()
    api.getWeatherForecast.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const first = model.loadWeather(),
      second = model.loadWeather()
    old.resolve({ location: { name: '旧地区' }, days: [] })
    expect((await first).status).toBe('cancelled')
    expect(model.weatherLoading.value).toBe(true)
    expect(model.weatherForecast.value).toBeNull()
    fresh.resolve({ location: { name: '新地区' }, warning: '测试警告', days: [] })
    expect((await second).status).toBe('success')
    expect(model.weatherForecast.value.location.name).toBe('新地区')
    expect(model.weatherLoading.value).toBe(false)
    expect(model.weatherError.value).toBe('测试警告')
  })
  it('preserves a broadcast over a late failed request without a stale notification', async () => {
    const { api, model, notify } = fixture()
    const slow = deferred()
    api.getWeatherForecast.mockReturnValueOnce(slow.promise)
    const request = model.loadWeather()
    model.acceptForecast({ location: { name: '广播地区' }, days: [] })
    slow.reject(new Error('旧失败'))
    expect((await request).status).toBe('cancelled')
    expect(model.weatherForecast.value.location.name).toBe('广播地区')
    expect(model.weatherLoading.value).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })
  it('turns weather off immediately and rejects pending and later broadcasts', async () => {
    const { api, model } = fixture()
    const slow = deferred()
    api.getWeatherForecast.mockReturnValueOnce(slow.promise)
    const request = model.loadWeather()
    model.applySettings(settings({ enabled: false }))
    expect(model.weatherLoading.value).toBe(false)
    expect(model.acceptForecast({ days: [] })).toBe(false)
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
    const { model, clock } = fixture()
    const now = Date.parse('2026-10-09T02:01:30Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    clock.value = now - 30000
    model.acceptForecast({
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
    const { api, model, notify } = fixture()
    const slow = deferred()
    api.getWeatherForecast.mockReturnValueOnce(slow.promise)
    const request = model.loadWeather()
    model.dispose()
    model.applySettings(settings({ preview: true }))
    slow.reject(new Error('卸载后的失败'))
    expect((await request).status).toBe('cancelled')
    expect(model.acceptForecast({ days: [] })).toBe(false)
    expect(model.recurringPreviewEnabled.value).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('calendar recurring preview persistence', () => {
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
    const { api, model, refreshCalendar } = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const slow = deferred()
    api.setSettingValue.mockReturnValueOnce(slow.promise)
    const save = model.updateRecurringPreviewEnabled(true)
    expect((await model.updateRecurringPreviewEnabled(false)).status).toBe('cancelled')
    model.applySettings(settings({ enabled: false, preview: false }))
    model.applySettings(settings({ enabled: false, preview: true }))
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
