import { describe, expect, it } from 'vitest'
import {
  assertCreatableNoteEffectiveTime,
  assertMinimumScheduleLeadTime,
  canScheduleNoteNotification,
  createSafeScheduleShortcutTimestamp,
  deriveNoteStatusForTime,
  DEFAULT_NEW_NOTE_SCHEDULE_TIME,
  defaultMonthNoteEffectiveTime,
  getAllowedNoteStatuses,
  MIN_SCHEDULE_LEAD_TIME_MS,
  resolveNoteCreateSchedule,
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

  it('allows in-progress rescheduling and completed historical corrections', () => {
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
    expect(
      resolveNoteDraftSchedule({
        status: 'in_progress',
        currentEffectiveAt: now - 10_000,
        currentFinishedAt: now - 5_000,
        requestedEffectiveAt: now + MIN_SCHEDULE_LEAD_TIME_MS,
        currentTime: now
      })
    ).toMatchObject({ status: 'initialized', effectiveAt: now + MIN_SCHEDULE_LEAD_TIME_MS })
    expect(
      resolveNoteDraftSchedule({
        status: 'completed',
        currentEffectiveAt: now - 10_000,
        currentFinishedAt: now - 5_000,
        requestedEffectiveAt: now - 20_000,
        currentTime: now
      })
    ).toMatchObject({ status: 'completed', effectiveAt: now - 20_000, finishedAt: now - 5_000 })
  })

  it('limits UI states by time without mutating a remembered completed choice', () => {
    expect(getAllowedNoteStatuses(null, now)).toEqual(['in_progress', 'completed'])
    expect(getAllowedNoteStatuses(now - 1, now)).toEqual(['in_progress', 'completed'])
    expect(getAllowedNoteStatuses(now + 1, now)).toEqual(['initialized'])
    expect(getAllowedNoteStatuses(Number.NaN, now)).toEqual([])
    expect(
      deriveNoteStatusForTime({
        effectiveAt: now + 1,
        requestedStatus: 'completed',
        currentTime: now
      })
    ).toBe('initialized')
    expect(
      deriveNoteStatusForTime({
        effectiveAt: now - 1,
        requestedStatus: 'completed',
        currentTime: now
      })
    ).toBe('completed')
  })

  it('uses one commit time for immediate creation and completion', () => {
    for (const currentTime of [now, now + 60_000]) {
      expect(
        resolveNoteCreateSchedule({
          requestedStatus: 'completed',
          requestedEffectiveAt: null,
          requestedFinishedAt: null,
          requestedNotifyEnabled: true,
          currentTime
        })
      ).toEqual({
        status: 'completed',
        effectiveAt: currentTime,
        finishedAt: currentTime,
        notifyEnabled: 0
      })
    }
    expect(resolveNoteCreateSchedule({ currentTime: now })).toEqual({
      status: 'in_progress',
      effectiveAt: now,
      finishedAt: now,
      notifyEnabled: 0
    })
  })

  it('preserves actual historical completion independently of the recording time', () => {
    expect(
      resolveNoteCreateSchedule({
        requestedEffectiveAt: now - 172_800_000,
        requestedStatus: 'completed',
        requestedFinishedAt: now - 86_400_000,
        requestedNotifyEnabled: true,
        currentTime: now
      })
    ).toMatchObject({
      status: 'completed',
      effectiveAt: now - 172_800_000,
      finishedAt: now - 86_400_000,
      notifyEnabled: 0
    })
    for (const finishedAt of [now - 172_800_001, now + 1, 'invalid']) {
      expect(() =>
        resolveNoteCreateSchedule({
          requestedEffectiveAt: now - 172_800_000,
          requestedStatus: 'completed',
          requestedFinishedAt: finishedAt,
          currentTime: now
        })
      ).toThrow(/完成时间/)
    }
  })

  it('rejects impossible explicit future states while accepting overdue pending submissions', () => {
    for (const requestedStatus of ['in_progress', 'completed']) {
      expect(() =>
        resolveNoteCreateSchedule({
          requestedEffectiveAt: now + MIN_SCHEDULE_LEAD_TIME_MS,
          requestedStatus,
          currentTime: now
        })
      ).toThrow(/只能设置为未开始/)
    }
    expect(
      resolveNoteCreateSchedule({
        requestedEffectiveAt: now + MIN_SCHEDULE_LEAD_TIME_MS,
        requestedNotifyEnabled: true,
        currentTime: now
      })
    ).toMatchObject({ status: 'initialized', notifyEnabled: 1 })
    expect(
      resolveNoteCreateSchedule({
        requestedEffectiveAt: now - 1,
        requestedStatus: 'initialized',
        requestedNotifyEnabled: true,
        currentTime: now
      })
    ).toMatchObject({ status: 'in_progress', notifyEnabled: 0 })
    expect(() =>
      resolveNoteCreateSchedule({ requestedStatus: 'unknown', currentTime: now })
    ).toThrow(/不支持/)
  })

  it('keeps an unchanged imminent appointment and its reminder eligible', () => {
    expect(
      resolveNoteDraftSchedule({
        status: 'initialized',
        currentEffectiveAt: now + 1,
        currentFinishedAt: now - 5_000,
        requestedNotifyEnabled: true,
        currentTime: now
      })
    ).toEqual({
      status: 'initialized',
      effectiveAt: now + 1,
      finishedAt: now - 5_000,
      notifyEnabled: 1
    })
    expect(() =>
      resolveNoteDraftSchedule({
        status: 'in_progress',
        currentEffectiveAt: now - 5_000,
        requestedEffectiveAt: now + 60_000,
        currentTime: now
      })
    ).toThrow(/2 分钟/)
  })

  it('preserves precise completion on content edits and resolves explicit reopening', () => {
    const original = {
      status: 'completed',
      currentEffectiveAt: now - 12_345,
      currentFinishedAt: now - 5_678,
      currentTime: now
    }
    expect(resolveNoteDraftSchedule(original)).toMatchObject({
      status: 'completed',
      effectiveAt: now - 12_345,
      finishedAt: now - 5_678,
      notifyEnabled: 0
    })
    expect(resolveNoteDraftSchedule({ ...original, requestedStatus: 'in_progress' })).toMatchObject(
      { status: 'in_progress', finishedAt: null, notifyEnabled: 0 }
    )
    expect(() =>
      resolveNoteDraftSchedule({
        ...original,
        requestedEffectiveAt: now + MIN_SCHEDULE_LEAD_TIME_MS
      })
    ).toThrow(/明确取消完成/)
    expect(
      resolveNoteDraftSchedule({
        ...original,
        requestedEffectiveAt: now + MIN_SCHEDULE_LEAD_TIME_MS,
        requestedStatus: 'initialized',
        requestedNotifyEnabled: true
      })
    ).toMatchObject({ status: 'initialized', finishedAt: null, notifyEnabled: 1 })
  })

  it('supports explicit completion and immediate rescheduling in an edit', () => {
    expect(
      resolveNoteDraftSchedule({
        status: 'initialized',
        currentEffectiveAt: now + MIN_SCHEDULE_LEAD_TIME_MS,
        requestedEffectiveAt: null,
        requestedStatus: 'completed',
        requestedFinishedAt: null,
        currentTime: now
      })
    ).toEqual({
      status: 'completed',
      effectiveAt: now,
      finishedAt: now,
      notifyEnabled: 0
    })
    expect(
      resolveNoteDraftSchedule({
        status: 'in_progress',
        currentEffectiveAt: now - 100_000,
        currentFinishedAt: now - 90_000,
        requestedStatus: 'completed',
        requestedFinishedAt: now - 10_000,
        currentTime: now
      })
    ).toMatchObject({ status: 'completed', finishedAt: now - 10_000 })
  })

  it('never guesses a missing legacy completion time during a content edit', () => {
    for (const currentFinishedAt of [null, undefined, '']) {
      const legacy = {
        status: 'completed',
        currentEffectiveAt: now - 100_000,
        currentFinishedAt,
        currentTime: now
      }
      expect(() => resolveNoteDraftSchedule(legacy)).toThrow(/缺少完成时间/)
      expect(resolveNoteDraftSchedule({ ...legacy, requestedFinishedAt: null })).toMatchObject({
        status: 'completed',
        finishedAt: now
      })
      expect(resolveNoteDraftSchedule({ ...legacy, requestedStatus: 'in_progress' })).toMatchObject(
        {
          status: 'in_progress',
          finishedAt: null
        }
      )
    }
  })
})
