import { describe, expect, it } from 'vitest'
import { buildMonthGrid } from '../src/shared/calendar/calendar-date-rules.js'
import {
  buildCalendarEventSegments,
  hasHiddenCalendarNotes,
  noteCountsByDate,
  notesCoveringDate
} from '../src/shared/calendar/calendar-event-layout.js'

function localTs(year, month, day, hour = 9) {
  return new Date(year, month - 1, day, hour).getTime()
}

function note(id, year, month, day, durationDays, overrides = {}) {
  return {
    id,
    content: `note-${id}`,
    effective_at: localTs(year, month, day),
    duration_days: durationDays,
    status: 'in_progress',
    is_pinned: 0,
    ...overrides
  }
}

describe('month multi-day event layout', () => {
  const days = buildMonthGrid(2026, 8).days

  it('keeps a same-week note as one continuous segment', () => {
    const segments = buildCalendarEventSegments(days, [note(1, 2026, 8, 4, 3)])
    expect(segments).toEqual([
      expect.objectContaining({
        noteId: 1,
        weekIndex: 1,
        columnStart: 2,
        columnSpan: 3,
        continuesBefore: false,
        continuesAfter: false
      })
    ])
  })

  it('splits only at Sunday-to-Monday and preserves the lane when possible', () => {
    const segments = buildCalendarEventSegments(days, [note(2, 2026, 8, 8, 5)])
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ columnStart: 6, columnSpan: 2, continuesAfter: true })
    expect(segments[1]).toMatchObject({ columnStart: 1, columnSpan: 3, continuesBefore: true })
    expect(segments[1].lane).toBe(segments[0].lane)
  })

  it('clips a 365-day note to the visible grid without changing its completion state', () => {
    const completed = note(3, 2025, 12, 1, 365, { status: 'completed' })
    const segments = buildCalendarEventSegments(days, [completed])
    expect(segments).toHaveLength(6)
    expect(segments[0]).toMatchObject({ columnStart: 1, columnSpan: 7, continuesBefore: true })
    expect(segments.at(-1)).toMatchObject({ columnStart: 1, columnSpan: 7, continuesAfter: true })
    expect(notesCoveringDate([completed], '2026-08-31')).toHaveLength(1)
    expect(completed.status).toBe('completed')
  })

  it('assigns lanes by duration, pin state and effective time, then reports total daily counts', () => {
    const notes = [note(11, 2026, 8, 3, 4), note(10, 2026, 8, 3, 4, { is_pinned: 1 })]
    const segments = buildCalendarEventSegments(days, notes)
    expect(segments.find((item) => item.noteId === 10).lane).toBe(0)
    expect(segments.find((item) => item.noteId === 11).lane).toBe(1)
    const longerUnpinned = note(12, 2026, 8, 3, 5)
    const prioritized = buildCalendarEventSegments(days, [...notes, longerUnpinned])
    expect(prioritized.find((item) => item.noteId === 12).lane).toBe(0)

    const counts = noteCountsByDate(
      days.filter((day) => day.inCurrentMonth),
      [...notes, longerUnpinned]
    )
    expect(counts.get('2026-08-03')).toBe(3)
    expect(counts.get('2026-08-07')).toBe(1)
  })

  it('sorts the day panel by duration, pin state, effective time and stable id', () => {
    const shortPinned = note(8, 2026, 8, 3, 1, { is_pinned: 1 })
    const longLater = note(6, 2026, 8, 3, 4, { effective_at: localTs(2026, 8, 3, 11) })
    const longEarlierHigherId = note(7, 2026, 8, 3, 4, {
      effective_at: localTs(2026, 8, 3, 8)
    })
    const longEarlierLowerId = note(5, 2026, 8, 3, 4, {
      effective_at: localTs(2026, 8, 3, 8)
    })
    const longPinned = note(9, 2026, 8, 3, 4, { is_pinned: 1 })

    expect(
      notesCoveringDate(
        [shortPinned, longLater, longEarlierHigherId, longEarlierLowerId, longPinned],
        '2026-08-03'
      ).map((item) => item.id)
    ).toEqual([9, 5, 7, 6, 8])
  })

  it('sorts pinned notes first when ordinary notes both last one day', () => {
    const ordinary = note(20, 2026, 8, 12, 1)
    const pinned = note(21, 2026, 8, 12, 1, { is_pinned: 1 })

    expect(notesCoveringDate([ordinary, pinned], '2026-08-12').map((item) => item.id)).toEqual([
      21, 20
    ])
  })

  it('reports overflow even when no event lane fits in the date cell', () => {
    expect(hasHiddenCalendarNotes(4, 0)).toBe(true)
    expect(hasHiddenCalendarNotes(4, 4)).toBe(false)
    expect(hasHiddenCalendarNotes(0, 0)).toBe(false)
  })

  it('clips event bars to current-month cells while preserving the real continuation flags', () => {
    const grid = buildMonthGrid(2026, 8)
    const segments = buildCalendarEventSegments(
      grid.days,
      [note(20, 2026, 7, 30, 5), note(21, 2026, 8, 30, 5)],
      { activeStartKey: grid.monthStart, activeEndKey: grid.monthEnd }
    )
    expect(segments.find((item) => item.noteId === 20)).toMatchObject({
      startKey: '2026-08-01',
      columnStart: 6,
      columnSpan: 2,
      continuesBefore: true
    })
    expect(segments.filter((item) => item.noteId === 21).at(-1)).toMatchObject({
      endKey: '2026-08-31',
      continuesAfter: true
    })
  })
})
