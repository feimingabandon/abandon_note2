import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addCalendarDays,
  localMidnightTimestamp
} from '../src/shared/calendar/calendar-date-rules.js'

const mocks = vi.hoisted(() => ({
  queryCalendarNotes: vi.fn(),
  buildCalendarDayMetadata: vi.fn(),
  buildRecurringNotePreviews: vi.fn()
}))

vi.mock('../src/main/db/db-notes.js', () => ({
  queryCalendarNotes: mocks.queryCalendarNotes
}))

vi.mock('../src/main/calendar/calendar-metadata.js', () => ({
  buildCalendarDayMetadata: mocks.buildCalendarDayMetadata
}))

vi.mock('../src/main/calendar/recurring-note-preview.js', () => ({
  buildRecurringNotePreviews: mocks.buildRecurringNotePreviews
}))

let getMonthCalendarData
let getWeekCalendarData

function metadataRange(start, end) {
  const result = new Map()
  for (let key = start; key <= end; key = addCalendarDays(key, 1)) {
    result.set(key, { displayLabel: `meta:${key}` })
  }
  return result
}

function candidate(id, dateKey, durationDays = 1) {
  return {
    id,
    effective_at: localMidnightTimestamp(dateKey),
    duration_days: durationDays
  }
}

beforeAll(async () => {
  ;({ getMonthCalendarData, getWeekCalendarData } =
    await import('../src/main/calendar/calendar-service.js'))
})

beforeEach(() => {
  mocks.queryCalendarNotes.mockReset()
  mocks.buildCalendarDayMetadata.mockReset()
  mocks.buildCalendarDayMetadata.mockImplementation(metadataRange)
  mocks.buildRecurringNotePreviews.mockReset()
  mocks.buildRecurringNotePreviews.mockReturnValue({
    items: [],
    truncated: false,
    skippedTemplateIds: []
  })
})

describe('calendar service ranges', () => {
  it('fills metadata for all seven week dates and keeps only intersecting notes', () => {
    mocks.queryCalendarNotes.mockReturnValue([
      candidate(1, '2026-08-09', 2),
      candidate(2, '2026-08-16'),
      candidate(3, '2026-08-08', 2),
      candidate(4, '2026-08-17')
    ])

    const result = getWeekCalendarData('2026-08-12')

    expect(mocks.buildCalendarDayMetadata).toHaveBeenCalledWith('2026-08-10', '2026-08-16')
    expect(mocks.queryCalendarNotes).toHaveBeenCalledWith({
      filter: expect.any(Function),
      candidateFrom: localMidnightTimestamp(addCalendarDays('2026-08-10', -364)),
      visibleStart: localMidnightTimestamp('2026-08-10'),
      visibleEndExclusive: localMidnightTimestamp('2026-08-17')
    })
    expect(result.notes.map((note) => note.id)).toEqual([1, 2])
    expect(result.days).toHaveLength(7)
    expect(result.days.every((day) => day.metadata.displayLabel === `meta:${day.key}`)).toBe(true)
  })

  it('loads metadata and notes for the complete 42-cell month grid', () => {
    mocks.queryCalendarNotes.mockReturnValue([
      candidate(10, '2026-07-27'),
      candidate(11, '2026-09-06'),
      candidate(12, '2026-07-26'),
      candidate(13, '2026-09-07')
    ])

    const result = getMonthCalendarData(2026, 8)

    expect(mocks.buildCalendarDayMetadata).toHaveBeenCalledWith('2026-07-27', '2026-09-06')
    expect(mocks.queryCalendarNotes).toHaveBeenCalledWith({
      filter: expect.any(Function),
      candidateFrom: localMidnightTimestamp(addCalendarDays('2026-07-27', -364)),
      visibleStart: localMidnightTimestamp('2026-07-27'),
      visibleEndExclusive: localMidnightTimestamp('2026-09-07')
    })
    expect(result.notes.map((note) => note.id)).toEqual([10, 11])
    expect(result.days.every((day) => day.isActive)).toBe(true)
    expect(result.days.find((day) => day.key === '2026-08-01').metadata).toEqual({
      displayLabel: 'meta:2026-08-01'
    })
    expect(result.days.find((day) => day.key === '2026-07-31').metadata).toEqual({
      displayLabel: 'meta:2026-07-31'
    })
  })

  it('queries only the visible five rows including cross-month dates', () => {
    mocks.queryCalendarNotes.mockReturnValue([
      candidate(20, '2026-08-31'),
      candidate(21, '2026-10-04'),
      candidate(22, '2026-10-05')
    ])
    const result = getMonthCalendarData(2026, 9)
    expect(result.days).toHaveLength(35)
    expect(mocks.buildCalendarDayMetadata).toHaveBeenCalledWith('2026-08-31', '2026-10-04')
    expect(mocks.queryCalendarNotes).toHaveBeenCalledWith({
      filter: expect.any(Function),
      candidateFrom: localMidnightTimestamp(addCalendarDays('2026-08-31', -364)),
      visibleStart: localMidnightTimestamp('2026-08-31'),
      visibleEndExclusive: localMidnightTimestamp('2026-10-05')
    })
    expect(result.notes.map((note) => note.id)).toEqual([20, 21])
  })

  it('keeps every date usable in the final week beyond the lunar metadata range', () => {
    mocks.queryCalendarNotes.mockReturnValue([])

    const result = getWeekCalendarData('2101-01-02')

    expect(mocks.buildCalendarDayMetadata).toHaveBeenCalledWith('2100-12-27', '2100-12-31')
    expect(result.days.map((day) => day.key)).toEqual([
      '2100-12-27',
      '2100-12-28',
      '2100-12-29',
      '2100-12-30',
      '2100-12-31',
      '2101-01-01',
      '2101-01-02'
    ])
    expect(result.days.every((day) => day.inCurrentMonth && day.isActive)).toBe(true)
    expect(result.days.find((day) => day.key === '2101-01-01').metadata).toEqual({
      lunar: null,
      solarTerm: null,
      festival: null,
      festivalType: null,
      festivals: [],
      hasPublicHolidayFestival: false,
      displayLabel: null,
      detailLabel: '',
      holiday: null
    })
  })

  it('adds future recurring previews only when the caller enables them', () => {
    mocks.queryCalendarNotes.mockReturnValue([])
    const preview = candidate('recurrence-preview:2:1', '2026-08-12')
    mocks.buildRecurringNotePreviews.mockReturnValue({
      items: [preview],
      truncated: false,
      skippedTemplateIds: []
    })

    const disabled = getWeekCalendarData('2026-08-12')
    const enabled = getWeekCalendarData('2026-08-12', {
      includeRecurringPreviews: true,
      now: localMidnightTimestamp('2026-08-10')
    })

    expect(disabled.recurringPreviews).toEqual([])
    expect(mocks.buildRecurringNotePreviews).toHaveBeenCalledTimes(1)
    expect(mocks.buildRecurringNotePreviews).toHaveBeenCalledWith({
      rangeStart: '2026-08-10',
      rangeEnd: '2026-08-16',
      now: localMidnightTimestamp('2026-08-10')
    })
    expect(enabled.recurringPreviews).toEqual([preview])
  })
})
