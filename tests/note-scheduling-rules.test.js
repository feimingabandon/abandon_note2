import { describe, expect, it } from 'vitest'
import {
  assertCreatableNoteEffectiveTime,
  assertMinimumScheduleLeadTime,
  canScheduleNoteNotification,
  createSafeScheduleShortcutTimestamp,
  DEFAULT_NEW_NOTE_SCHEDULE_TIME,
  defaultMonthNoteEffectiveTime,
  MIN_SCHEDULE_LEAD_TIME_MS,
  resolveNoteDraftSchedule
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

  it('allows historical backfill while still rejecting too-near future schedules', () => {
    expect(assertCreatableNoteEffectiveTime(now - 1, now)).toBe(now - 1)
    expect(assertCreatableNoteEffectiveTime(now, now)).toBe(now)
    expect(() =>
      assertCreatableNoteEffectiveTime(now + MIN_SCHEDULE_LEAD_TIME_MS - 1, now)
    ).toThrow(/2 分钟之后/)
    expect(assertCreatableNoteEffectiveTime(now + MIN_SCHEDULE_LEAD_TIME_MS, now)).toBe(
      now + MIN_SCHEDULE_LEAD_TIME_MS
    )
    expect(() => assertCreatableNoteEffectiveTime(0, now)).toThrow(/无效/)
  })

  it('only allows notifications for future schedules with the minimum lead time', () => {
    expect(canScheduleNoteNotification(now - 1, now)).toBe(false)
    expect(canScheduleNoteNotification(now, now)).toBe(false)
    expect(canScheduleNoteNotification(now + MIN_SCHEDULE_LEAD_TIME_MS - 1, now)).toBe(false)
    expect(canScheduleNoteNotification(now + MIN_SCHEDULE_LEAD_TIME_MS, now)).toBe(true)
  })

  it('creates a minute-aligned shortcut with enough time to save', () => {
    const currentTime = now + 12_345
    const shortcut = createSafeScheduleShortcutTimestamp(currentTime)
    expect(shortcut % 60_000).toBe(0)
    expect(shortcut - currentTime).toBeGreaterThanOrEqual(MIN_SCHEDULE_LEAD_TIME_MS + 60_000)
    expect(() => assertMinimumScheduleLeadTime(shortcut, currentTime + 60_000)).not.toThrow()
  })

  it('uses 00:01 for non-today month dates while preserving today immediate defaults', () => {
    const currentTime = new Date(2026, 7, 11, 14, 37, 45)
    expect(DEFAULT_NEW_NOTE_SCHEDULE_TIME).toBe('00:01')
    expect(defaultMonthNoteEffectiveTime('2026-08-10', '2026-08-11', currentTime)).toBe('00:01')
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

  it('derives initialized historical corrections as in progress with notifications off', () => {
    expect(
      resolveNoteDraftSchedule({
        status: 'initialized',
        currentEffectiveAt: now + 86_400_000,
        currentNotifyEnabled: 1,
        currentFinishedAt: now - 10_000,
        requestedEffectiveAt: now - 86_400_000,
        requestedNotifyEnabled: true,
        currentTime: now
      })
    ).toEqual({
      status: 'in_progress',
      effectiveAt: now - 86_400_000,
      notifyEnabled: 0,
      finishedAt: now
    })
  })

  it('allows in-progress historical corrections but blocks future and completed changes', () => {
    expect(
      resolveNoteDraftSchedule({
        status: 'in_progress',
        currentEffectiveAt: now - 10_000,
        currentFinishedAt: now - 5_000,
        requestedEffectiveAt: now - 86_400_000,
        currentTime: now
      })
    ).toMatchObject({
      status: 'in_progress',
      effectiveAt: now - 86_400_000,
      notifyEnabled: 0,
      finishedAt: now - 5_000
    })
    expect(() =>
      resolveNoteDraftSchedule({
        status: 'in_progress',
        currentEffectiveAt: now - 10_000,
        currentFinishedAt: now - 5_000,
        requestedEffectiveAt: now + MIN_SCHEDULE_LEAD_TIME_MS,
        currentTime: now
      })
    ).toThrow(/只能修正为当前或过去时间/)
    expect(() =>
      resolveNoteDraftSchedule({
        status: 'completed',
        currentEffectiveAt: now - 10_000,
        currentFinishedAt: now - 5_000,
        requestedEffectiveAt: now - 20_000,
        currentTime: now
      })
    ).toThrow(/已完成便签的生效时间不可修改/)
  })
})
