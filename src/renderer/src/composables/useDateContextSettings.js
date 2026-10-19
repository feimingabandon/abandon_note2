import { onScopeDispose, readonly, ref } from 'vue'
import { weatherLocationKey } from '../../../shared/weather-rules.js'

// 同一窗口的摘要和详情共享设置及天气，卡片数量不会增加 IPC 订阅或请求。
const weatherEnabled = ref(false)
const almanacEnabled = ref(true)
const forecast = ref(null)
let users = 0
let revision = 0
let requestSequence = 0
let locationKey = ''
let stopSettings
let stopForecast

async function loadForecast() {
  const sequence = ++requestSequence
  try {
    const value = await window.api.getWeatherForecast()
    if (
      users &&
      sequence === requestSequence &&
      weatherEnabled.value &&
      weatherLocationKey(value?.location) === locationKey
    )
      forecast.value = value
  } catch {
    // 详情保留无可用预报状态；开关关闭时不显示占位。
    if (sequence === requestSequence) forecast.value = null
  }
}

function applySettings(snapshot) {
  revision += 1
  const enabled = Boolean(snapshot?.values?.weather?.enabled)
  const nextKey = weatherLocationKey(snapshot?.values?.weather?.location)
  const changed = enabled !== weatherEnabled.value || nextKey !== locationKey
  weatherEnabled.value = enabled
  almanacEnabled.value = snapshot?.values?.almanac?.enabled ?? true
  locationKey = nextKey
  if (!enabled || !nextKey || changed) {
    requestSequence += 1
    forecast.value = null
  }
  if (enabled && nextKey && (changed || !forecast.value)) void loadForecast()
}

function start() {
  stopSettings = window.api.onSettingsChanged?.(applySettings)
  stopForecast = window.api.onWeatherForecastUpdated?.((value) => {
    if (!weatherEnabled.value || weatherLocationKey(value?.location) !== locationKey) return
    requestSequence += 1
    forecast.value = value
  })
  const currentRevision = revision
  void window.api
    .getSettingsSnapshot()
    .then((snapshot) => {
      if (users && revision === currentRevision) applySettings(snapshot)
    })
    .catch(() => {})
}

export function useDateContextSettings() {
  users += 1
  if (users === 1) start()
  onScopeDispose(() => {
    users -= 1
    if (users) return
    revision += 1
    requestSequence += 1
    stopSettings?.()
    stopForecast?.()
    stopSettings = stopForecast = null
    locationKey = ''
    forecast.value = null
    weatherEnabled.value = false
    almanacEnabled.value = true
  })
  return {
    weatherEnabled: readonly(weatherEnabled),
    almanacEnabled: readonly(almanacEnabled),
    forecast: readonly(forecast)
  }
}
