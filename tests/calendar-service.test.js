import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addCalendarDays,
  localMidnightTimestamp
} from '../src/shared/calendar/calendar-date-rules.js'

const mocks = vi.hoisted(() => ({
  queryCalendarNotes: vi.fn(),
  buildCalendarDayMetadata: vi.fn()
}))

vi.mock('../src/main/db/db-notes.js', () => ({
  queryCalendarNotes: mocks.queryCalendarNotes
}))

vi.mock('../src/main/calendar/calendar-metadata.js', () => ({
  buildCalendarDayMetadata: mocks.buildCalendarDayMetadata
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
      candidateFrom: localMidnightTimestamp(addCalendarDays('2026-08-10', -364)),
      visibleEndExclusive: localMidnightTimestamp('2026-08-17')
    })
    expect(result.notes.map((note) => note.id)).toEqual([1, 2])
    expect(result.days).toHaveLength(7)
    expect(result.days.every((day) => day.metadata.displayLabel === `meta:${day.key}`)).toBe(true)
  })

  it('preserves month data behavior while using the shared range query', () => {
    mocks.queryCalendarNotes.mockReturnValue([])

    const result = getMonthCalendarData(2026, 8)

    expect(mocks.buildCalendarDayMetadata).toHaveBeenCalledWith('2026-08-01', '2026-08-31')
    expect(mocks.queryCalendarNotes).toHaveBeenCalledWith({
      candidateFrom: localMidnightTimestamp(addCalendarDays('2026-08-01', -364)),
      visibleEndExclusive: localMidnightTimestamp('2026-09-01')
    })
    expect(result.days.find((day) => day.key === '2026-08-01').metadata).toEqual({
      displayLabel: 'meta:2026-08-01'
    })
    expect(result.days.find((day) => day.key === '2026-07-31').metadata).toEqual({})
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
})
