import { describe, expect, it } from 'vitest'
import {
  assertMinimumScheduleLeadTime,
  createSafeScheduleShortcutTimestamp,
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
})
