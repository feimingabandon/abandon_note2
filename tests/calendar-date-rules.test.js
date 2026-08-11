import { describe, expect, it } from 'vitest'
import {
  addCalendarDays,
  buildMonthGrid,
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
})
