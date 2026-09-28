import { weatherFreshness } from '../../../shared/weather-freshness.js'
import {
  weatherUpdateLabel,
  weatherValidTimeLabel,
  weatherSourceLabel,
  weatherSupplementLabel
} from '../../../shared/weather-display.js'
import { localDateKey } from '../../../shared/calendar/calendar-date-rules.js'
import {
  describeWeatherCode,
  isDisplayableWeatherDay,
  weatherLocationLabel
} from '../../../shared/weather-rules.js'

export function buildDisplayableCurrentWeather(forecast, now = Date.now()) {
  const freshness = weatherFreshness(forecast, now)
  if (!freshness.currentVisible) return null
  const current = forecast.current
  return {
    ...current,
    ...describeWeatherCode(current.weatherCode, current.isDay),
    date: freshness.currentDate,
    validTimeLabel: weatherValidTimeLabel(current, forecast.timezone),
    updateLabel: weatherUpdateLabel(
      {
        ...forecast,
        fetchedAt: current.fetchedAt || forecast.fetchedAt,
        cache: { ...forecast.cache, stale: freshness.currentStale }
      },
      now
    ),
    sourceLabel: weatherSourceLabel(current.source || forecast.source)
  }
}

export function buildDisplayableWeatherByDate(forecast, now = Date.now()) {
  if (!weatherFreshness(forecast, now).dailyVisible) return new Map()
  const currentWeather = buildDisplayableCurrentWeather(forecast, now)
  return new Map(
    (Array.isArray(forecast?.days) ? forecast.days : [])
      .filter((day) => day?.date && isDisplayableWeatherDay(day))
      .map((day) => [
        String(day.date),
        {
          ...day,
          updateLabel: weatherUpdateLabel(
            { ...forecast, fetchedAt: day.fetchedAt || forecast.fetchedAt },
            now
          ),
          sourceLabel: weatherSourceLabel(day.source || forecast.source),
          supplementLabel: weatherSupplementLabel(day),
          currentWeather: currentWeather?.date === day.date ? currentWeather : null,
          locationLabel: forecast.location ? weatherLocationLabel(forecast.location) : ''
        }
      ])
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
