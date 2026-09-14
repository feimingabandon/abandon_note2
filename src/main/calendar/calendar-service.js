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
import { buildRecurringNotePreviews } from './recurring-note-preview.js'

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
  missingMetadata = () => ({}),
  { includeRecurringPreviews = false, now = Date.now() } = {}
) {
  const metadataByDate = buildSupportedRangeMetadata(rangeStart, rangeEnd)
  const visibleStartOrdinal = dateOrdinal(rangeStart)
  const visibleEndOrdinal = dateOrdinal(rangeEnd)
  const candidateFromKey = addCalendarDays(rangeStart, -364)
  const visibleEndExclusiveKey = addCalendarDays(rangeEnd, 1)
  const candidates = queryCalendarNotes({
    candidateFrom: localMidnightTimestamp(candidateFromKey),
    visibleEndExclusive: localMidnightTimestamp(visibleEndExclusiveKey),
    filter: (note) => {
      const range = noteDateRange(note)
      return range.startOrdinal <= visibleEndOrdinal && range.endOrdinal >= visibleStartOrdinal
    }
  })
  const notes = candidates.filter((note) => {
    const range = noteDateRange(note)
    return range.startOrdinal <= visibleEndOrdinal && range.endOrdinal >= visibleStartOrdinal
  })
  const recurringPreviewResult = includeRecurringPreviews
    ? buildRecurringNotePreviews({ rangeStart, rangeEnd, now })
    : { items: [], truncated: false, skippedTemplateIds: [] }
  return {
    ...grid,
    days: grid.days.map((day) => ({
      ...day,
      metadata: hasMetadata(day) ? metadataByDate.get(day.key) || missingMetadata() : {}
    })),
    notes,
    recurringPreviews: recurringPreviewResult.items,
    recurringPreviewsTruncated: recurringPreviewResult.truncated
  }
}

export function getMonthCalendarData(year, month, options = {}) {
  const grid = buildMonthGrid(year, month)
  return populateCalendarRange(
    grid,
    grid.visibleStart,
    grid.visibleEnd,
    () => true,
    emptyCalendarDayMetadata,
    options
  )
}

export function getWeekCalendarData(anchorDate, options = {}) {
  const grid = buildWeekGrid(anchorDate)
  return populateCalendarRange(
    grid,
    grid.weekStart,
    grid.weekEnd,
    () => true,
    emptyCalendarDayMetadata,
    options
  )
}
