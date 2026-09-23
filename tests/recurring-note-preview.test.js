import { describe, expect, it } from 'vitest'
import { buildRecurringNotePreviews } from '../src/main/calendar/recurring-note-preview.js'

function localTs(year, month, day, hour = 9, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function template(id, rule, nextRunAt, overrides = {}) {
  return {
    id,
    content: `模板 ${id}`,
    recurrence_rule: JSON.stringify(rule),
    schedule_anchor_at: localTs(2026, 9, 1, 8),
    next_run_at: nextRunAt,
    is_paused: 0,
    is_deleted: 0,
    is_pinned: 0,
    tags: [],
    ...overrides
  }
}

describe('future recurring note previews', () => {
  it('expands only future occurrences inside the visible range without creating real note ids', () => {
    const source = template(
      7,
      { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      localTs(2026, 9, 15),
      { tags: [{ id: 3, color: '#34c759' }] }
    )

    const result = buildRecurringNotePreviews({
      rangeStart: '2026-09-14',
      rangeEnd: '2026-09-17',
      now: localTs(2026, 9, 14, 10),
      templates: [source]
    })

    expect(result.truncated).toBe(false)
    expect(result.items.map((item) => item.effective_at)).toEqual([
      localTs(2026, 9, 15),
      localTs(2026, 9, 16),
      localTs(2026, 9, 17)
    ])
    expect(result.items[0]).toMatchObject({
      id: `recurrence-preview:7:${localTs(2026, 9, 15)}`,
      template_id: 7,
      preview_kind: 'recurrence',
      read_only: true,
      duration_days: 1,
      tags: [{ id: 3, color: '#34c759' }]
    })
  })

  it('respects the stored next run and clamps monthly end-of-month occurrences', () => {
    const source = template(
      8,
      { frequency: 'monthly', days_of_month: [31], time_of_day: '09:00' },
      localTs(2026, 1, 31),
      { schedule_anchor_at: localTs(2026, 1, 1, 8) }
    )

    const result = buildRecurringNotePreviews({
      rangeStart: '2026-01-30',
      rangeEnd: '2026-02-28',
      now: localTs(2026, 1, 30, 8),
      templates: [source]
    })

    expect(result.items.map((item) => item.effective_at)).toEqual([
      localTs(2026, 1, 31),
      localTs(2026, 2, 28)
    ])
  })

  it('does not preview occurrences after the template end time', () => {
    const source = template(
      12,
      { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      localTs(2026, 9, 15),
      {
        start_at: localTs(2026, 9, 15, 8),
        end_at: localTs(2026, 9, 16)
      }
    )

    const result = buildRecurringNotePreviews({
      rangeStart: '2026-09-14',
      rangeEnd: '2026-09-18',
      now: localTs(2026, 9, 14, 10),
      templates: [source]
    })

    expect(result.items.map((item) => item.effective_at)).toEqual([
      localTs(2026, 9, 15),
      localTs(2026, 9, 16)
    ])
  })

  it('skips paused and malformed templates without failing the complete calendar preview', () => {
    const valid = template(
      9,
      { frequency: 'weekly', days_of_week: [2], time_of_day: '09:00' },
      localTs(2026, 9, 15)
    )
    const paused = template(
      10,
      { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      localTs(2026, 9, 15),
      { is_paused: 1 }
    )
    const malformed = template(11, { frequency: 'unknown' }, localTs(2026, 9, 15))

    const result = buildRecurringNotePreviews({
      rangeStart: '2026-09-14',
      rangeEnd: '2026-09-20',
      now: localTs(2026, 9, 14, 8),
      templates: [valid, paused, malformed]
    })

    expect(result.items.map((item) => item.template_id)).toEqual([9])
    expect(result.skippedTemplateIds).toEqual([11])
  })
})
