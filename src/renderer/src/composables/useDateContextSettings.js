import { onScopeDispose, readonly, ref } from 'vue'
import { weatherLocationKey } from '../../../shared/weather-rules.js'
import { getSettingsSnapshotStore } from '../utils/settingsSnapshots.js'

// The bridge belongs to one renderer document. Cards, lists and calendars lease
// the same owner; a replacement owner never reactivates an already released lease.
const owners = new WeakMap()

function createOwner(api) {
  const settingsSnapshots = getSettingsSnapshotStore(api)
  const weatherEnabled = ref(false),
    almanacEnabled = ref(true),
    forecast = ref(null)
  const loading = ref(false),
    error = ref('')
  let users = 0,
    active = true,
    generation = 0,
    requestSequence = 0,
    locationKey = ''
  let stopSettings,
    stopForecast,
    requestLease = null

  const validContext = (context) =>
    active &&
    weatherEnabled.value &&
    Boolean(locationKey) &&
    context?.key === locationKey &&
    context.generation === generation
  const capture = () =>
    active && weatherEnabled.value && locationKey
      ? Object.freeze({ key: locationKey, generation })
      : null
  function invalidateRequest() {
    requestSequence += 1
    requestLease = null
    loading.value = false
  }
  async function loadForecast(isLeaseAlive = () => true, lease = null) {
    const context = capture()
    if (!context || !isLeaseAlive()) return { status: 'cancelled' }
    const sequence = ++requestSequence
    requestLease = lease
    const current = () => isLeaseAlive() && validContext(context) && sequence === requestSequence
    loading.value = true
    error.value = ''
    try {
      const value = await api.getWeatherForecast()
      if (!current()) return { status: 'cancelled' }
      if (!value || weatherLocationKey(value.location) !== context.key)
        throw new Error('天气获取未完成，请稍后重试')
      forecast.value = value
      error.value = value.warning || ''
      return { status: 'success', forecast: value }
    } catch (failure) {
      if (!current()) return { status: 'cancelled' }
      forecast.value = null
      error.value = failure?.message || '天气获取失败'
      return { status: 'error', error: failure }
    } finally {
      if (current()) {
        loading.value = false
        requestLease = null
      }
    }
  }
  function applySettings(snapshot) {
    if (!active) return
    const enabled = Boolean(snapshot?.values?.weather?.enabled)
    const nextKey = weatherLocationKey(snapshot?.values?.weather?.location)
    const changed = enabled !== weatherEnabled.value || nextKey !== locationKey
    weatherEnabled.value = enabled
    almanacEnabled.value = snapshot?.values?.almanac?.enabled ?? true
    locationKey = nextKey
    if (!changed) return
    generation += 1
    invalidateRequest()
    forecast.value = null
    error.value = ''
    if (enabled && nextKey) void loadForecast()
  }
  function acceptForecast(value) {
    if (
      !active ||
      !weatherEnabled.value ||
      !locationKey ||
      !value ||
      weatherLocationKey(value.location) !== locationKey
    )
      return false
    invalidateRequest()
    forecast.value = value
    error.value = value.warning || ''
    return true
  }
  function stop() {
    active = false
    invalidateRequest()
    stopSettings?.()
    stopForecast?.()
    forecast.value = null
    weatherEnabled.value = false
    almanacEnabled.value = true
    locationKey = ''
    error.value = ''
    owners.delete(api)
  }
  let settingsReady
  try {
    stopForecast = api.onWeatherForecastUpdated?.(acceptForecast)
    stopSettings = settingsSnapshots.subscribe(applySettings, { availabilityEvents: true })
    const cached = settingsSnapshots.latest()
    settingsReady = cached ? Promise.resolve(cached) : settingsSnapshots.read()
    // Display consumers do not await initialization. Windows become ready using
    // local data while this owner observes the background read's failure.
    void settingsReady.catch(() => {})
  } catch (failure) {
    stop()
    throw failure
  }
  return {
    acquire() {
      users += 1
      let alive = true
      const lease = Symbol('date-context-consumer'),
        contexts = new WeakSet()
      return {
        weatherEnabled: readonly(weatherEnabled),
        almanacEnabled: readonly(almanacEnabled),
        forecast: readonly(forecast),
        loading: readonly(loading),
        error: readonly(error),
        settingsReady,
        loadForecast: () => loadForecast(() => alive, lease),
        captureWeatherContext() {
          if (!alive) return null
          const context = capture()
          if (context) contexts.add(context)
          return context
        },
        isWeatherContextCurrent: (context) =>
          alive && Boolean(context) && contexts.has(context) && validContext(context),
        dispose() {
          if (!alive) return
          alive = false
          users -= 1
          if (!users) stop()
          else if (requestLease === lease) invalidateRequest()
        }
      }
    }
  }
}

export function acquireDateContextSettings(api) {
  let owner = owners.get(api)
  if (!owner) {
    owner = createOwner(api)
    owners.set(api, owner)
  }
  return owner.acquire()
}

export function useDateContextSettings() {
  const lease = acquireDateContextSettings(window.api)
  onScopeDispose(lease.dispose)
  return lease
}
