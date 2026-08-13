import { describe, expect, it } from 'vitest'
import {
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
  addCalendarDays,
  buildMonthGrid,
  buildWeekGrid,
  combineLocalDateAndTime,
  dateOrdinal,
  localDateKey
} from '../src/shared/calendar/calendar-date-rules.js'

describe('month calendar date rules', () => {
  it('always builds Monday-first 7×6 grids', () => {
    const grid = buildMonthGrid(2026, 8)
    expect(grid.days).toHaveLength(42)
    expect(grid.visibleStart).toBe('2026-07-27')
    expect(grid.visibleEnd).toBe('2026-09-06')
    expect(grid.monthStart).toBe('2026-08-01')
    expect(grid.monthEnd).toBe('2026-08-31')
    expect(grid.days[0]).toMatchObject({ weekday: 0, weekIndex: 0, columnIndex: 0 })
    expect(grid.days[41]).toMatchObject({ weekday: 6, weekIndex: 5, columnIndex: 6 })
  })

  it('handles leap years and year boundaries without fixed-millisecond local math', () => {
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addCalendarDays('2024-02-29', 1)).toBe('2024-03-01')
    expect(addCalendarDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(dateOrdinal('2026-01-01') - dateOrdinal('2025-12-31')).toBe(1)
  })

  it('combines an explicit calendar date with local wall-clock time', () => {
    const timestamp = combineLocalDateAndTime('2026-08-07', '14:35')
    const date = new Date(timestamp)
    expect(localDateKey(timestamp)).toBe('2026-08-07')
    expect([date.getHours(), date.getMinutes(), date.getSeconds()]).toEqual([14, 35, 0])
  })

  it('rejects unsupported years and invalid dates', () => {
    expect(() => buildMonthGrid(1899, 12)).toThrow(/年份/)
    expect(() => addCalendarDays('2026-02-30', 1)).toThrow(/日期不存在/)
  })

  it('builds every supported month across 1900–2100 without boundary drift', () => {
    const failures = []
    for (let year = MIN_CALENDAR_YEAR; year <= MAX_CALENDAR_YEAR; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const grid = buildMonthGrid(year, month)
        const expectedDayCount = new Date(Date.UTC(year, month, 0)).getUTCDate()
        const currentDays = grid.days.filter((day) => day.inCurrentMonth)
        const ordinals = grid.days.map((day) => dateOrdinal(day.key))
        const contiguous = ordinals.every(
          (ordinal, index) => index === 0 || ordinal === ordinals[index - 1] + 1
        )
        if (
          grid.days.length !== 42 ||
          currentDays.length !== expectedDayCount ||
          currentDays[0]?.day !== 1 ||
          currentDays.at(-1)?.day !== expectedDayCount ||
          !contiguous
        ) {
          failures.push({ year, month })
        }
      }
    }

    expect(failures).toEqual([])
  })
})

describe('week calendar date rules', () => {
  it('builds a Monday-to-Sunday week around the anchor date', () => {
    const grid = buildWeekGrid('2026-08-12')

    expect(grid).toMatchObject({
      anchorDate: '2026-08-12',
      weekStart: '2026-08-10',
      weekEnd: '2026-08-16',
      visibleStart: '2026-08-10',
      visibleEnd: '2026-08-16'
    })
    expect(grid.days).toHaveLength(7)
    expect(grid.days.map((day) => day.key)).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16'
    ])
    expect(grid.days.map((day) => day.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(grid.days.every((day) => day.weekIndex === 0 && day.inCurrentMonth)).toBe(true)
    expect(grid.days.every((day) => day.isActive)).toBe(true)
  })

  it('keeps all seven cross-month and cross-year dates active', () => {
    const crossMonth = buildWeekGrid('2026-09-01')
    const crossYear = buildWeekGrid('2027-01-01')

    expect([crossMonth.weekStart, crossMonth.weekEnd]).toEqual(['2026-08-31', '2026-09-06'])
    expect(crossMonth.days.every((day) => day.inCurrentMonth && day.isActive)).toBe(true)
    expect([crossYear.weekStart, crossYear.weekEnd]).toEqual(['2026-12-28', '2027-01-03'])
    expect(crossYear.days.map((day) => day.key)).toHaveLength(7)
  })

  it('rejects invalid anchors and anchors outside the supported year range', () => {
    expect(() => buildWeekGrid('2026-02-30')).toThrow(/日期不存在/)
    expect(() => buildWeekGrid('1899-12-31')).toThrow(/周范围/)
    expect(() => buildWeekGrid('2101-01-03')).toThrow(/周范围/)
  })

  it('allows anchors in the complete final week even when it extends beyond 2100', () => {
    const finalWeek = buildWeekGrid('2101-01-02')

    expect([finalWeek.weekStart, finalWeek.weekEnd]).toEqual(['2100-12-27', '2101-01-02'])
    expect(finalWeek.anchorDate).toBe('2101-01-02')
    expect(finalWeek.days.every((day) => day.inCurrentMonth && day.isActive)).toBe(true)
  })

  it('keeps the first intersecting week complete across the lower date boundary', () => {
    const firstWeek = buildWeekGrid('1900-01-01')

    expect([firstWeek.weekStart, firstWeek.weekEnd]).toEqual(['1900-01-01', '1900-01-07'])
    expect(firstWeek.days.every((day) => day.inCurrentMonth && day.isActive)).toBe(true)
  })
})
