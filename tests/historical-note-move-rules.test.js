import { describe, expect, it } from 'vitest'
import {
  normalizeHistoricalNoteMoveIds,
  normalizeHistoricalNoteMovePreviewPage,
  normalizeHistoricalNoteMoveSelection,
  resolveHistoricalNoteMoveEligibility
} from '../src/shared/historical-note-move-rules.js'
import { localMidnightTimestamp } from '../src/shared/calendar/calendar-date-rules.js'

const now = new Date(2026, 9, 15, 10, 30).getTime()
const note = {
  id: 1,
  status: 'in_progress',
  is_deleted: 0,
  effective_at: new Date(2026, 9, 14, 23, 59).getTime(),
  duration_kind: 'single_day',
  duration_days: 1
}

describe('historical note move rules', () => {
  it('accepts explicit historical dates and generated recurring snapshots as single-day notes', () => {
    expect(resolveHistoricalNoteMoveEligibility(note, '2026-10-15')).toEqual({
      canMove: true,
      disabledReason: ''
    })
    expect(
      resolveHistoricalNoteMoveEligibility({ ...note, from_template: 1 }, '2026-10-15').canMove
    ).toBe(true)
  })

  it('retains a specific disabled reason for each unsupported duration even when stored days is one', () => {
    expect(
      resolveHistoricalNoteMoveEligibility(
        { ...note, duration_kind: 'fixed_days', duration_days: 3 },
        '2026-10-15'
      )
    ).toEqual({ canMove: false, disabledReason: '已设置指定天数，不能移动' })
    expect(
      resolveHistoricalNoteMoveEligibility(
        { ...note, duration_kind: 'until_completed' },
        '2026-10-15'
      )
    ).toEqual({ canMove: false, disabledReason: '已持续显示到今天，无需移动' })
  })

  it('rejects previews, deleted, completed, pending, today and future notes', () => {
    for (const fields of [
      { read_only: true, preview_kind: 'recurrence' },
      { is_deleted: 1 },
      { status: 'completed' },
      { status: 'initialized' },
      { effective_at: localMidnightTimestamp('2026-10-15') },
      { effective_at: localMidnightTimestamp('2026-10-16') },
      { effective_at: 0 },
      { duration_kind: 'unknown' }
    ]) {
      const result = resolveHistoricalNoteMoveEligibility({ ...note, ...fields }, '2026-10-15')
      expect(result.canMove).toBe(false)
      expect(result.disabledReason).not.toBe('')
    }
  })

  it('normalizes inclusive local dates into an exclusive next-day boundary', () => {
    const range = normalizeHistoricalNoteMoveSelection(
      {
        scope: 'range',
        startDateKey: '2026-10-01',
        endDateKey: '2026-10-14'
      },
      now
    )
    expect(range.rangeStart).toBe(localMidnightTimestamp('2026-10-01'))
    expect(range.rangeEndExclusive).toBe(localMidnightTimestamp('2026-10-15'))
    expect(range.targetDateKey).toBe('2026-10-15')
    expect(normalizeHistoricalNoteMoveSelection({ scope: 'all' }, now).rangeStart).toBe(null)
  })

  it('rejects unsupported, invalid, inverted or nonhistorical ranges', () => {
    for (const selection of [
      { scope: 'unknown' },
      { scope: 'range', startDateKey: '2026-02-30', endDateKey: '2026-10-14' },
      { scope: 'range', startDateKey: '2026-10-14', endDateKey: '2026-10-13' },
      { scope: 'range', startDateKey: '2026-10-14', endDateKey: '2026-10-15' },
      { scope: 'range', startDateKey: '1899-12-31', endDateKey: '2026-10-14' }
    ])
      expect(() => normalizeHistoricalNoteMoveSelection(selection, now)).toThrow()
    expect(() => normalizeHistoricalNoteMoveSelection({ scope: 'all' }, NaN)).toThrow(
      '当前时间无效'
    )
  })

  it('bounds page sizes and validates IDs without conflating no selection with select all', () => {
    expect(normalizeHistoricalNoteMovePreviewPage({ limit: 10000, offset: -10 })).toEqual({
      limit: 100,
      offset: 0
    })
    expect(normalizeHistoricalNoteMovePreviewPage()).toEqual({ limit: 100, offset: 0 })
    expect(normalizeHistoricalNoteMoveIds(undefined)).toBe(null)
    expect(normalizeHistoricalNoteMoveIds([])).toEqual([])
    expect(normalizeHistoricalNoteMoveIds([1, '2', 1])).toEqual([1, 2])
    for (const ids of [null, {}, [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
      expect(() => normalizeHistoricalNoteMoveIds(ids)).toThrow()
    }
  })
})
