export const WEATHER_REFRESH_MS = 30 * 60_000
export const WEATHER_MANUAL_MS = 5 * 60_000

export function weatherAge(forecast, now = Date.now()) {
  const at = Number(forecast?.fetchedAt)
  return at > 0 && at <= now ? now - at : Infinity
}

export function weatherFreshness(forecast, now = Date.now()) {
  const age = weatherAge(forecast, now)
  const dataAt = Number(forecast?.current?.dataAt)
  const currentFetchAge = forecast?.current?.fetchedAt ? weatherAge(forecast.current, now) : age
  const currentAge =
    dataAt > 0 && dataAt <= now ? Math.max(age, currentFetchAge, now - dataAt) : Infinity
  let currentDate = ''
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: forecast?.timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now)
    const get = (type) => parts.find((part) => part.type === type)?.value
    currentDate = `${get('year')}-${get('month')}-${get('day')}`
  } catch {
    /* An invalid timezone must never make an old reading current. */
  }
  return {
    due: age >= WEATHER_REFRESH_MS,
    stale: Boolean(forecast?.cache?.stale) || age >= 6 * 60 * 60_000,
    dailyVisible: age < 24 * 60 * 60_000,
    currentVisible:
      currentAge < 6 * 60 * 60_000 && forecast?.current?.time?.slice(0, 10) === currentDate,
    currentStale: Boolean(forecast?.cache?.stale) || currentAge >= 2 * 60 * 60_000,
    currentDate
  }
}
