import { describe, expect, it } from 'vitest'
import {
  calculateNextRun,
  daysInMonth,
  isLeapYear,
  normalizeRecurrenceRule
} from '../src/main/services/recurrence-rules.js'

function localTs(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function parts(timestamp) {
  const date = new Date(timestamp)
  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes()
  ]
}

describe('Gregorian calendar boundaries', () => {
  it.each([
    [1900, false],
    [2000, true],
    [2024, true],
    [2025, false],
    [2100, false],
    [2400, true]
  ])('classifies %i correctly', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected)
  })

  it('returns the correct February length', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2025, 2)).toBe(28)
    expect(daysInMonth(1900, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
  })
})

describe('rule validation', () => {
  it('normalizes and deduplicates weekly values', () => {
    expect(
      normalizeRecurrenceRule({
        frequency: 'weekly',
        days_of_week: [5, 1, 5, 3],
        time_of_day: '08:00'
      }).days_of_week
    ).toEqual([1, 3, 5])
  })

  it.each([
    [{ frequency: 'every_other_day', interval: 2, time_of_day: '08:00' }],
    [{ frequency: 'daily', interval: 0, time_of_day: '08:00' }],
    [{ frequency: 'weekly', days_of_week: [], time_of_day: '08:00' }],
    [{ frequency: 'monthly', days_of_month: [32], time_of_day: '08:00' }],
    [{ frequency: 'yearly', dates_of_year: [{ month: 13, day: 1 }], time_of_day: '08:00' }],
    [{ frequency: 'daily', interval: 1, time_of_day: '8:00' }],
    [{ frequency: 'daily', interval: 1, time_of_day: '08:00:30' }]
  ])('rejects invalid rule %#', (rule) => {
    expect(() => normalizeRecurrenceRule(rule)).toThrow()
  })
})

describe('next run calculation', () => {
  it('uses today when a new daily template is created before its time', () => {
    const now = localTs(2025, 7, 20, 8, 0)
    const next = calculateNextRun(
      { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      now,
      now
    )
    expect(parts(next)).toEqual([2025, 7, 20, 9, 0])
  })

  it('does not backfill today when a template is created after its time', () => {
    const now = localTs(2025, 7, 20, 10, 0)
    const next = calculateNextRun(
      { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      now,
      now
    )
    expect(parts(next)).toEqual([2025, 7, 21, 9, 0])
  })

  it('keeps a multi-day interval anchored to the activation date', () => {
    const anchor = localTs(2025, 7, 20, 8, 0)
    const first = calculateNextRun(
      { frequency: 'daily', interval: 3, time_of_day: '09:00' },
      anchor,
      anchor
    )
    const second = calculateNextRun(
      { frequency: 'daily', interval: 3, time_of_day: '09:00' },
      first,
      anchor
    )
    expect(parts(first)).toEqual([2025, 7, 20, 9, 0])
    expect(parts(second)).toEqual([2025, 7, 23, 9, 0])
  })

  it('selects the next configured weekday', () => {
    const mondayAfterRun = localTs(2025, 7, 21, 10, 0)
    const next = calculateNextRun(
      { frequency: 'weekly', days_of_week: [1, 3, 5], time_of_day: '09:00' },
      mondayAfterRun
    )
    expect(parts(next)).toEqual([2025, 7, 23, 9, 0])
  })

  it('clamps monthly dates to the final day and deduplicates the node', () => {
    const before = localTs(2025, 2, 27, 10, 0)
    const rule = {
      frequency: 'monthly',
      days_of_month: [28, 29, 30, 31],
      time_of_day: '09:00'
    }
    const february = calculateNextRun(rule, before)
    const march = calculateNextRun(rule, february)
    expect(parts(february)).toEqual([2025, 2, 28, 9, 0])
    expect(parts(march)).toEqual([2025, 3, 28, 9, 0])
  })

  it('uses February 29 in leap years', () => {
    const next = calculateNextRun(
      { frequency: 'monthly', days_of_month: [31], time_of_day: '09:00' },
      localTs(2024, 2, 1)
    )
    expect(parts(next)).toEqual([2024, 2, 29, 9, 0])
  })

  it('clamps a yearly February 29 rule in common years', () => {
    const rule = {
      frequency: 'yearly',
      dates_of_year: [{ month: 2, day: 29 }],
      time_of_day: '09:00'
    }
    expect(parts(calculateNextRun(rule, localTs(2025, 1, 1)))).toEqual([2025, 2, 28, 9, 0])
    expect(parts(calculateNextRun(rule, localTs(2024, 1, 1)))).toEqual([2024, 2, 29, 9, 0])
  })

  it('always produces a valid future date across 1900-2100', () => {
    const rule = { frequency: 'monthly', days_of_month: [31], time_of_day: '09:00' }
    for (let year = 1900; year <= 2100; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const after = localTs(year, month, 1)
        const next = calculateNextRun(rule, after)
        const date = new Date(next)
        expect(next).toBeGreaterThan(after)
        expect(date.getMonth() + 1).toBe(month)
        expect(date.getDate()).toBe(daysInMonth(year, month))
      }
    }
  })
})
