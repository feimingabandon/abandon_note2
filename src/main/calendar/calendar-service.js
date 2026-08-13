import { queryCalendarNotes } from '../db/db-notes.js'
import {
  MAX_CALENDAR_DATE,
  MIN_CALENDAR_DATE,
  addCalendarDays,
  buildMonthGrid,
  buildWeekGrid,
  dateOrdinal,
  localMidnightTimestamp,
  noteDateRange
} from '../../shared/calendar/calendar-date-rules.js'
import { buildCalendarDayMetadata } from './calendar-metadata.js'

function emptyCalendarDayMetadata() {
  return {
    lunar: null,
    solarTerm: null,
    festival: null,
    festivalType: null,
    festivals: [],
    hasPublicHolidayFestival: false,
    displayLabel: null,
    detailLabel: '',
    holiday: null
  }
}

function buildSupportedRangeMetadata(rangeStart, rangeEnd) {
  const metadataStart = rangeStart < MIN_CALENDAR_DATE ? MIN_CALENDAR_DATE : rangeStart
  const metadataEnd = rangeEnd > MAX_CALENDAR_DATE ? MAX_CALENDAR_DATE : rangeEnd
  return metadataStart <= metadataEnd
    ? buildCalendarDayMetadata(metadataStart, metadataEnd)
    : new Map()
}

function populateCalendarRange(
  grid,
  rangeStart,
  rangeEnd,
  hasMetadata,
  missingMetadata = () => ({})
) {
  const metadataByDate = buildSupportedRangeMetadata(rangeStart, rangeEnd)
  const visibleStartOrdinal = dateOrdinal(rangeStart)
  const visibleEndOrdinal = dateOrdinal(rangeEnd)
  const candidateFromKey = addCalendarDays(rangeStart, -364)
  const visibleEndExclusiveKey = addCalendarDays(rangeEnd, 1)
  const candidates = queryCalendarNotes({
    candidateFrom: localMidnightTimestamp(candidateFromKey),
    visibleEndExclusive: localMidnightTimestamp(visibleEndExclusiveKey)
  })
  const notes = candidates.filter((note) => {
    const range = noteDateRange(note)
    return range.startOrdinal <= visibleEndOrdinal && range.endOrdinal >= visibleStartOrdinal
  })
  return {
    ...grid,
    days: grid.days.map((day) => ({
      ...day,
      metadata: hasMetadata(day) ? metadataByDate.get(day.key) || missingMetadata() : {}
    })),
    notes
  }
}

export function getMonthCalendarData(year, month) {
  const grid = buildMonthGrid(year, month)
  return populateCalendarRange(grid, grid.monthStart, grid.monthEnd, (day) => day.inCurrentMonth)
}

export function getWeekCalendarData(anchorDate) {
  const grid = buildWeekGrid(anchorDate)
  return populateCalendarRange(
    grid,
    grid.weekStart,
    grid.weekEnd,
    () => true,
    emptyCalendarDayMetadata
  )
}
