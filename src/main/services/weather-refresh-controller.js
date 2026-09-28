import { weatherLocationKey } from '../../shared/weather-rules.js'
import {
  WEATHER_MANUAL_MS,
  WEATHER_REFRESH_MS,
  weatherAge
} from '../../shared/weather-freshness.js'

/** One request owner for automatic, initial and manual refreshes. */
export function createWeatherRefreshController({
  service,
  getSettings,
  canAutoRefresh = () => true,
  publish,
  now = Date.now,
  random = Math.random
}) {
  let signature = ''
  let generation = 0
  const pending = new Map()
  const states = new Map()
  function synchronize() {
    const settings = getSettings()
    const next = JSON.stringify([Boolean(settings?.enabled), settings?.location || null])
    if (signature !== next) {
      signature = next
      generation += 1
    }
    return { settings, generation, key: weatherLocationKey(settings?.location) }
  }
  function stateFor(key) {
    if (!states.has(key))
      states.set(key, {
        attemptedAt: null,
        retryAt: 0,
        failures: 0,
        blocked: false,
        nextAt: 0,
        serverUntil: 0,
        lastError: ''
      })
    return states.get(key)
  }
  function fail(state, error) {
    state.failures += 1
    state.lastError = error?.message || '天气更新失败'
    const status = Number(error?.status)
    state.blocked = status >= 400 && status < 500 && status !== 408 && status !== 429
    const delay = [5, 15, 30, 60][Math.min(state.failures - 1, 3)] * 60_000
    state.serverUntil = Number(error?.retryAt) || 0
    state.retryAt = Math.max(now() + delay, state.serverUntil)
  }
  function refresh({ manual = false, trigger = 'automatic' } = {}) {
    const context = synchronize()
    const { settings, key } = context
    if (!settings?.enabled || !key || (!manual && !canAutoRefresh())) return Promise.resolve(null)
    const taskKey = `${context.generation}:${key}`
    if (pending.has(taskKey)) return pending.get(taskKey)
    const isCurrent = () => synchronize().generation === context.generation
    const request = (async () => {
      const cached = await service.getForecast(settings.location, { cacheOnly: true })
      if (!isCurrent()) return null
      const state = stateFor(key)
      const time = now()
      if (state.attemptedAt > time) {
        state.attemptedAt = null
        state.nextAt = 0
        state.retryAt = 0
        state.serverUntil = 0
      }
      const recentAttempt =
        state.attemptedAt !== null && time - state.attemptedAt < WEATHER_MANUAL_MS
      const fresh = weatherAge(cached, time) < (manual ? WEATHER_MANUAL_MS : WEATHER_REFRESH_MS)
      const delayed =
        state.serverUntil > time || (!manual && (state.retryAt > time || state.nextAt > time))
      if (state.blocked || recentAttempt || fresh || delayed) {
        if (manual && !cached) throw new Error(state.lastError || '请求过于频繁，请稍后更新')
        if (manual)
          return {
            ...cached,
            manualRefresh: { status: state.failures ? 'stale' : 'current', checkedAt: time },
            warning: state.blocked
              ? '天气服务请求被拒绝，请检查设置后重试'
              : state.lastError || cached?.warning || (!cached ? '请求过于频繁，请稍后更新' : '')
          }
        return cached
      }
      state.attemptedAt = time
      let result
      try {
        result = await service.getForecast(settings.location, {
          refresh: true,
          shouldStore: isCurrent,
          trigger
        })
        if (!isCurrent()) return null
        if (result?.cache?.stale) fail(state, { ...result.failure, message: result.warning })
        else {
          state.failures = 0
          state.retryAt = 0
          state.serverUntil = 0
          state.blocked = false
          state.lastError = ''
          state.nextAt = now() + WEATHER_REFRESH_MS + Math.floor(random() * 60_000)
        }
      } catch (error) {
        if (!isCurrent()) return null
        fail(state, error)
        throw error
      }
      if (manual)
        result = {
          ...result,
          manualRefresh: { status: result?.cache?.stale ? 'stale' : 'updated', checkedAt: now() }
        }
      publish(result)
      return result
    })().finally(() => {
      if (pending.get(taskKey) === request) pending.delete(taskKey)
    })
    pending.set(taskKey, request)
    return request
  }
  async function read() {
    const context = synchronize()
    if (!context.settings?.enabled || !context.key) return null
    const cached = await service.getForecast(context.settings.location, { cacheOnly: true })
    if (synchronize().generation !== context.generation) return null
    if (cached) {
      if (weatherAge(cached, now()) >= WEATHER_REFRESH_MS)
        void refresh({ trigger: 'cache-expired' }).catch(() => {})
      const state = stateFor(context.key)
      return state.failures
        ? { ...cached, cache: { ...cached.cache, stale: true }, warning: state.lastError }
        : cached
    }
    return refresh({ trigger: 'initial-load' })
  }
  return {
    read,
    refresh,
    settingsChanged() {
      const before = generation
      synchronize()
      if (before !== generation) {
        // Changing settings is an explicit opportunity to recover invalid parameters.
        for (const state of states.values()) state.blocked = false
      }
    }
  }
}
