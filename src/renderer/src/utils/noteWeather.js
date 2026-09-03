import { localDateKey } from '../../../shared/calendar/calendar-date-rules.js'
import { isDisplayableWeatherDay } from '../../../shared/weather-rules.js'

export function buildDisplayableWeatherByDate(forecast) {
  return new Map(
    (Array.isArray(forecast?.days) ? forecast.days : [])
      .filter((day) => day?.date && isDisplayableWeatherDay(day))
      .map((day) => [String(day.date), day])
  )
}

export function getNoteEffectiveDateKey(note) {
  const timestamp = Number(note?.effective_at)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  try {
    return localDateKey(timestamp)
  } catch {
    return ''
  }
}

export function getWeatherForNote(note, weatherByDate) {
  const dateKey = getNoteEffectiveDateKey(note)
  return dateKey && weatherByDate instanceof Map ? weatherByDate.get(dateKey) || null : null
}
