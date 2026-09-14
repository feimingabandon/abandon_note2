import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getMonthCalendarData: vi.fn(),
  getWeekCalendarData: vi.fn(),
  getMissingHolidayDataNotice: vi.fn()
}))

vi.mock('../src/main/calendar/calendar-service.js', () => ({
  getMonthCalendarData: mocks.getMonthCalendarData,
  getWeekCalendarData: mocks.getWeekCalendarData
}))

vi.mock('../src/main/calendar/holiday-data-service.js', () => ({
  dismissMissingHolidayDataNotice: vi.fn(),
  downloadHolidayData: vi.fn(),
  getHolidayDataStatus: vi.fn(),
  getMissingHolidayDataNotice: mocks.getMissingHolidayDataNotice,
  importHolidayDataFile: vi.fn()
}))

vi.mock('../src/shared/calendar/holiday-data-rules.js', () => ({
  holidayDataDownloadUrl: vi.fn()
}))

import { registerCalendarIpcHandlers } from '../src/main/ipc/register-calendar-ipc.js'

function createHarness() {
  const handlers = new Map()
  const webContents = { send: vi.fn() }
  registerCalendarIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: {},
    shell: {},
    getMainWindow: () => ({ isDestroyed: () => false, webContents })
  })
  return { handlers, webContents, event: { sender: webContents } }
}

beforeEach(() => {
  mocks.getMonthCalendarData.mockReset()
  mocks.getWeekCalendarData.mockReset()
  mocks.getMissingHolidayDataNotice.mockReset()
})

describe('calendar IPC', () => {
  it('routes an authorized week request using its anchor date', () => {
    const harness = createHarness()
    const expected = { weekStart: '2026-08-10', weekEnd: '2026-08-16' }
    mocks.getWeekCalendarData.mockReturnValue(expected)

    expect(
      harness.handlers.get('calendar:get-week')(harness.event, { anchorDate: '2026-08-12' })
    ).toBe(expected)
    expect(mocks.getWeekCalendarData).toHaveBeenCalledWith('2026-08-12', {
      includeRecurringPreviews: false
    })
  })

  it('forwards the recurring preview switch to the calendar service', () => {
    const harness = createHarness()

    harness.handlers.get('calendar:get-week')(harness.event, {
      anchorDate: '2026-08-12',
      includeRecurringPreviews: true
    })

    expect(mocks.getWeekCalendarData).toHaveBeenCalledWith('2026-08-12', {
      includeRecurringPreviews: true
    })
  })

  it('rejects week requests from a different renderer', () => {
    const harness = createHarness()

    expect(() =>
      harness.handlers.get('calendar:get-week')({ sender: {} }, { anchorDate: '2026-08-12' })
    ).toThrow(/无权访问日历数据/)
    expect(mocks.getWeekCalendarData).not.toHaveBeenCalled()
  })

  it('silently cancels a stale read-only holiday notice request during view replacement', () => {
    const harness = createHarness()
    const notice = { required: true, year: 2026 }
    mocks.getMissingHolidayDataNotice.mockReturnValue(notice)

    expect(harness.handlers.get('calendar:holiday-data-notice')(harness.event)).toBe(notice)
    expect(harness.handlers.get('calendar:holiday-data-notice')({ sender: {} })).toBeNull()
    expect(mocks.getMissingHolidayDataNotice).toHaveBeenCalledTimes(1)
  })
})
