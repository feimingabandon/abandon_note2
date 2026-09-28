import { buildCalendarDayMetadata } from './calendar-metadata.js'
import { ALMANAC_SOURCE, calculateAlmanac } from './almanac-engine.js'
import {
  parseDateKey,
  MIN_CALENDAR_DATE,
  MAX_CALENDAR_DATE
} from '../../shared/calendar/calendar-date-rules.js'

export function getAlmanacDay(dateKey) {
  parseDateKey(dateKey)
  if (dateKey < MIN_CALENDAR_DATE || dateKey > MAX_CALENDAR_DATE)
    throw new Error('日期超出日历范围')
  const metadata = buildCalendarDayMetadata(dateKey, dateKey).get(dateKey)
  let almanac
  try {
    almanac = calculateAlmanac(dateKey)
  } catch {
    almanac = { dateKey, status: 'error', source: ALMANAC_SOURCE }
  }
  return { dateKey, metadata, almanac }
}
