import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { buildWeekGrid } from '../src/shared/calendar/calendar-date-rules.js'
import { useCalendarWorkspaceModel } from '../src/renderer/src/composables/useCalendarWorkspaceModel.js'
function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
function monthData(year, month, id = 1) {
  return {
    year,
    month,
    days: [{ key: `${year}-${String(month).padStart(2, '0')}-01` }],
    notes: [{ id }],
    recurringPreviews: []
  }
}
function weekData(anchor, id = 2) {
  const grid = buildWeekGrid(anchor)
  return { ...grid, anchorDate: anchor, days: grid.days, notes: [{ id }], recurringPreviews: [] }
}
function fixture(mode = 'month') {
  const api = {
    getMonthCalendarData: vi.fn(async (year, month) => monthData(year, month)),
    getWeekCalendarData: vi.fn(async (anchor) => weekData(anchor)),
    getWeatherForecast: vi.fn(),
    setSettingValue: vi.fn(async () => {})
  }
  let model
  const presentation = {
    requestOptions: () => ({ includeRecurringPreviews: true }),
    focusDate: vi.fn(async () => {}),
    refreshPeriod: vi.fn(async (data, { sequence }) => {
      if (!model.isCurrent(sequence)) return { status: 'cancelled' }
      model.replaceData(data)
      return { status: 'success' }
    }),
    replacePeriod: vi.fn(async (data, options) => {
      if (!model.isCurrent(options.sequence)) return false
      model.commitPeriod(data, options)
      return true
    })
  }
  model = useCalendarWorkspaceModel({
    api,
    getViewMode: () => mode,
    todayKey: ref('2026-10-09'),
    presentation
  })
  return { api, model, presentation }
}
describe('calendar period model monthly policies', () => {
  it('normalizes month overflow, clamps selected day and retains preview query options', async () => {
    const { model, api } = fixture()
    model.selectDate('2026-01-31')
    expect(await model.navigateMonth(2026, 2)).toBe(true)
    expect(model.selectedKey.value).toBe('2026-02-28')
    expect(api.getMonthCalendarData).toHaveBeenLastCalledWith(2026, 2, {
      includeRecurringPreviews: true
    })
    expect(await model.navigateMonth(2026, 13)).toBe(true)
    expect(model.viewYear.value).toBe(2027)
    expect(model.viewMonth.value).toBe(1)
    const count = api.getMonthCalendarData.mock.calls.length
    expect(await model.navigateMonth(1899, 12)).toBe(false)
    expect(api.getMonthCalendarData).toHaveBeenCalledTimes(count)
  })
  it('rejects a new monthly target during an active transition instead of queuing it', async () => {
    const { model, api } = fixture()
    const slow = deferred()
    api.getMonthCalendarData.mockImplementationOnce(() => slow.promise)
    const first = model.navigateMonth(2027, 2)
    expect(await model.navigateMonth(2027, 3)).toBe(false)
    expect(api.getMonthCalendarData).toHaveBeenCalledTimes(1)
    slow.resolve(monthData(2027, 2))
    expect(await first).toBe(true)
    expect(model.viewMonth.value).toBe(2)
    expect(model.transitioning.value).toBe(false)
  })
  it('keeps old data after a query error and does not clear newer loading from old finally', async () => {
    const { model, api } = fixture()
    await model.loadMonth(2026, 10)
    const previous = model.calendarData.value
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.getMonthCalendarData.mockRejectedValueOnce(new Error('month failed'))
    expect((await model.loadMonth(2026, 11)).status).toBe('error')
    expect(model.calendarData.value).toBe(previous)
    expect(model.loadError.value).toBe('month failed')
    const first = deferred(),
      second = deferred()
    api.getMonthCalendarData
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const old = model.loadMonth(2026, 12),
      fresh = model.loadMonth(2027, 1)
    first.resolve(monthData(2026, 12))
    expect((await old).status).toBe('cancelled')
    expect(model.loading.value).toBe(true)
    second.resolve(monthData(2027, 1))
    await fresh
    expect(model.loading.value).toBe(false)
    vi.restoreAllMocks()
  })
  it('cancels a monthly result and period transition after model disposal', async () => {
    const { model, api, presentation } = fixture()
    const slow = deferred()
    api.getMonthCalendarData.mockImplementationOnce(() => slow.promise)
    const loading = model.navigateMonth(2027, 2)
    model.dispose()
    slow.resolve(monthData(2027, 2, 999))
    expect(await loading).toBe(false)
    expect(model.calendarData.value.notes).toEqual([])
    expect(presentation.replacePeriod).not.toHaveBeenCalled()
  })
})

describe('calendar period model weekly policies', () => {
  it('keeps only the latest pending week target while a query is in flight', async () => {
    const { model, api } = fixture('week')
    await model.loadWeek('2026-10-09')
    const slow = deferred()
    api.getWeekCalendarData.mockImplementationOnce(() => slow.promise)
    const first = model.navigateWeek('2026-10-16')
    await model.navigateWeek('2026-10-23')
    await model.navigateWeek('2026-10-30')
    slow.resolve(weekData('2026-10-16'))
    await first
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(api.getWeekCalendarData.mock.calls.map(([anchor]) => anchor)).toEqual([
      '2026-10-09',
      '2026-10-16',
      '2026-10-30'
    ])
    expect(model.selectedKey.value).toBe('2026-10-30')
    expect(model.transitioning.value).toBe(false)
  })
  it('focuses an already visible week without querying and resumes a queued target', async () => {
    const { model, api, presentation } = fixture('week')
    await model.loadWeek('2026-10-09')
    const slow = deferred()
    presentation.focusDate.mockImplementationOnce(() => slow.promise)
    const focus = model.navigateWeek('2026-10-10', { focusIfCurrent: true })
    await model.navigateWeek('2026-10-17')
    expect(api.getWeekCalendarData).toHaveBeenCalledTimes(1)
    slow.resolve()
    await focus
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(presentation.focusDate).toHaveBeenCalledWith('2026-10-10')
    expect(model.selectedKey.value).toBe('2026-10-17')
    expect(api.getWeekCalendarData).toHaveBeenCalledTimes(2)
  })
  it('accumulates next-week intent through a manual refresh without changing monthly rejection semantics', async () => {
    const { model, api } = fixture('week')
    await model.loadWeek('2026-10-09')
    const slow = deferred()
    api.getWeekCalendarData.mockImplementationOnce(() => slow.promise)
    const refreshing = model.refresh({ manual: true })
    model.goNext()
    model.goNext()
    slow.resolve(weekData('2026-10-09'))
    await refreshing
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(model.selectedKey.value).toBe('2026-10-23')
    expect(model.refreshing.value).toBe(false)
    expect(api.getWeekCalendarData.mock.calls.at(-1)[0]).toBe('2026-10-23')
  })
  it('does not resume pending navigation after disposal', async () => {
    const { model, api } = fixture('week')
    await model.loadWeek('2026-10-09')
    const slow = deferred()
    api.getWeekCalendarData.mockImplementationOnce(() => slow.promise)
    const first = model.navigateWeek('2026-10-16')
    await model.navigateWeek('2026-10-23')
    model.dispose()
    slow.resolve(weekData('2026-10-16', 999))
    expect(await first).toBe(false)
    expect(api.getWeekCalendarData).toHaveBeenCalledTimes(2)
    expect(model.calendarData.value.notes).toEqual([{ id: 2 }])
  })
})
