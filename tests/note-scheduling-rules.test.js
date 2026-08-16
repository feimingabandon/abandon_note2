import { describe, expect, it } from 'vitest'
import {
  assertMinimumScheduleLeadTime,
  createSafeScheduleShortcutTimestamp,
  DEFAULT_NEW_NOTE_SCHEDULE_TIME,
  defaultMonthNoteEffectiveTime,
  MIN_SCHEDULE_LEAD_TIME_MS
} from '../src/shared/note-scheduling-rules.js'

describe('note scheduling rules', () => {
  const now = 1_800_000_000_000

  it('accepts an explicit time at or beyond the two-minute boundary', () => {
    expect(assertMinimumScheduleLeadTime(now + MIN_SCHEDULE_LEAD_TIME_MS, now)).toBe(
      now + MIN_SCHEDULE_LEAD_TIME_MS
    )
  })

  it('rejects past, too-near and invalid explicit times', () => {
    expect(() => assertMinimumScheduleLeadTime(now - 1, now)).toThrow(/2 分钟之后/)
    expect(() => assertMinimumScheduleLeadTime(now + MIN_SCHEDULE_LEAD_TIME_MS - 1, now)).toThrow(
      /2 分钟之后/
    )
    expect(() => assertMinimumScheduleLeadTime('invalid', now)).toThrow(/无效/)
  })

  it('creates a minute-aligned shortcut with enough time to save', () => {
    const currentTime = now + 12_345
    const shortcut = createSafeScheduleShortcutTimestamp(currentTime)
    expect(shortcut % 60_000).toBe(0)
    expect(shortcut - currentTime).toBeGreaterThanOrEqual(MIN_SCHEDULE_LEAD_TIME_MS + 60_000)
    expect(() => assertMinimumScheduleLeadTime(shortcut, currentTime + 60_000)).not.toThrow()
  })

  it('uses 00:01 for future month dates while preserving today immediate defaults', () => {
    const currentTime = new Date(2026, 7, 11, 14, 37, 45)
    expect(DEFAULT_NEW_NOTE_SCHEDULE_TIME).toBe('00:01')
    expect(defaultMonthNoteEffectiveTime('2026-08-12', '2026-08-11', currentTime)).toBe('00:01')
    expect(defaultMonthNoteEffectiveTime('2026-08-11', '2026-08-11', currentTime)).toBe('14:37')
  })

  it('moves a near-midnight future default past the safe scheduling boundary', () => {
    const currentTime = new Date(2026, 7, 11, 23, 59, 30)
    const selectedTime = defaultMonthNoteEffectiveTime('2026-08-12', '2026-08-11', currentTime)
    const [hour, minute] = selectedTime.split(':').map(Number)
    const effectiveAt = new Date(2026, 7, 12, hour, minute).getTime()

    expect(effectiveAt - currentTime.getTime()).toBeGreaterThanOrEqual(
      MIN_SCHEDULE_LEAD_TIME_MS + 60_000
    )
  })
})
