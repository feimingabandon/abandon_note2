import { queryCalendarNotes } from '../db/db-notes.js'
import {
  addCalendarDays,
  buildMonthGrid,
  dateOrdinal,
  localMidnightTimestamp,
  noteDateRange
} from '../../shared/calendar/calendar-date-rules.js'

export function getMonthCalendarData(year, month) {
  const grid = buildMonthGrid(year, month)
  const visibleStartOrdinal = dateOrdinal(grid.monthStart)
  const visibleEndOrdinal = dateOrdinal(grid.monthEnd)
  const candidateFromKey = addCalendarDays(grid.monthStart, -364)
  const visibleEndExclusiveKey = addCalendarDays(grid.monthEnd, 1)
  const candidates = queryCalendarNotes({
    candidateFrom: localMidnightTimestamp(candidateFromKey),
    visibleEndExclusive: localMidnightTimestamp(visibleEndExclusiveKey)
  })
  const notes = candidates.filter((note) => {
    const range = noteDateRange(note)
    return range.startOrdinal <= visibleEndOrdinal && range.endOrdinal >= visibleStartOrdinal
  })
  return { ...grid, notes }
}
