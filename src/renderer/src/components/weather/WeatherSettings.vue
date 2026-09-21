<script setup>
import { computed, onMounted, ref } from 'vue'
import AppToggle from '../ui/AppToggle.vue'
import BaseButton from '../ui/BaseButton.vue'
import ChinaAreaCascader from './ChinaAreaCascader.vue'
import {
  normalizeWeatherLocation,
  weatherLocationFromReverseGeocode,
  weatherLocationLabel
} from '../../../../shared/weather-rules.js'

const enabled = ref(false)
const location = ref(null)
const divisionTree = ref([])
const busy = ref('')
const error = ref('')
const locationLabel = computed(() => weatherLocationLabel(location.value))
const REVERSE_GEOCODING_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client'
const DEVICE_LOCATION_TIMEOUT_MS = 20_000
const REVERSE_GEOCODING_TIMEOUT_MS = 10_000
let locationSavePromise = null

function reportWeatherLocation(level, message, metadata) {
  try {
    window.api.reportLog?.({
      level,
      scope: 'weather.location',
      message,
      metadata
    })
  } catch {
    // 诊断日志失败不能影响定位或覆盖用户可见的错误。
  }
}

function deviceLocationErrorMessage(code) {
  if (Number(code) === 1) return '定位权限已被拒绝，请在系统设置中允许桌面应用访问位置'
  if (Number(code) === 2) return '系统暂时无法确定位置，请检查系统定位服务和网络后重试'
  if (Number(code) === 3) return '获取设备位置超时，请检查系统定位服务和网络后重试'
  return '无法获取设备位置，可以改用地区选择'
}

function errorMessage(value, fallback) {
  return String(value?.message || fallback).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  )
}

/**
 * contextBridge / ipcRenderer 只能传输可结构化克隆的数据。即使调用方以后再次
 * 传入 Vue Proxy，也在 IPC 边界前收敛为固定字段的普通对象。
 */
function weatherLocationCandidatePayload(candidate) {
  if (!candidate || typeof candidate !== 'object') return null
  return {
    id: candidate.id ?? null,
    name: candidate.name || '',
    admin1: candidate.admin1 || '',
    admin2: candidate.admin2 || '',
    country: candidate.country || '',
    countryCode: candidate.countryCode || '',
    latitude: candidate.latitude ?? null,
    longitude: candidate.longitude ?? null,
    timezone: candidate.timezone || 'auto'
  }
}

async function load() {
  const [snapshot, areas] = await Promise.all([
    window.api.getSettingsSnapshot(),
    window.api.getWeatherDivisionTree()
  ])
  divisionTree.value = areas || []
  enabled.value = Boolean(snapshot?.values?.weather?.enabled)
  location.value = snapshot?.values?.weather?.location || null
  if (
    location.value &&
    !location.value.id &&
    !location.value.admin2 &&
    location.value.countryCode === 'CN'
  ) {
    try {
      const enriched = await reverseGeocodeDeviceLocation(location.value)
      if (enriched?.admin2) {
        location.value = enriched
        await window.api.setSettingValue('weather.location', enriched)
      }
    } catch {
      // 旧版仅保存到城市级时继续展示已有数据；反向地理编码失败不阻断设置页。
    }
  }
}

async function persistEnabled(value) {
  if (value && !location.value) {
    enabled.value = false
    error.value = '请先选择省、市、区县'
    return
  }
  busy.value = 'save'
  error.value = ''
  try {
    await window.api.setSettingValue('weather.enabled', value)
  } catch (saveError) {
    enabled.value = !value
    error.value = errorMessage(saveError, '保存天气开关失败')
  } finally {
    busy.value = ''
  }
}

async function saveLocationCandidate(candidate) {
  const candidatePayload = weatherLocationCandidatePayload(candidate)
  if (!candidatePayload) {
    error.value = '无法保存该位置'
    return false
  }
  if (candidatePayload.id && Number(candidatePayload.id) === Number(location.value?.id)) return true
  let resolvedCandidate = candidatePayload
  const hasCoordinates =
    candidatePayload.latitude !== null &&
    candidatePayload.latitude !== undefined &&
    candidatePayload.longitude !== null &&
    candidatePayload.longitude !== undefined
  if (!hasCoordinates && !candidatePayload.id) {
    error.value = '无法保存该位置'
    return false
  }
  busy.value = 'save'
  error.value = ''
  try {
    if (!hasCoordinates) {
      resolvedCandidate = await window.api.resolveWeatherLocation(candidatePayload)
    }
    const normalized = normalizeWeatherLocation(resolvedCandidate)
    if (!normalized) throw new Error('无法获得该地区的天气坐标')
    await window.api.setSettingValue('weather.location', normalized)
    location.value = normalized
    if (!enabled.value) {
      enabled.value = true
      await window.api.setSettingValue('weather.enabled', true)
    }
    return true
  } catch (saveError) {
    error.value = errorMessage(saveError, '保存地区失败')
    reportWeatherLocation('error', '天气地区保存失败', {
      reason: errorMessage(saveError, '保存地区失败')
    })
    return false
  } finally {
    busy.value = ''
  }
}

function choose(candidate) {
  // Teleport 浮层在 leave 动画结束前仍保留 DOM。即使旧节点收到第二次点击，
  // 同一时刻也只允许一条解析与设置写入链路，避免地区和天气开关重复提交。
  if (locationSavePromise) return locationSavePromise
  const request = saveLocationCandidate(candidate)
  locationSavePromise = request
  const clearRequest = () => {
    if (locationSavePromise === request) locationSavePromise = null
  }
  request.then(clearRequest, clearRequest)
  return request
}

function useDeviceLocation() {
  if (busy.value) return
  const startedAt = Date.now()
  busy.value = 'locate'
  error.value = ''
  reportWeatherLocation('info', '用户请求设备位置', {
    timeoutMs: DEVICE_LOCATION_TIMEOUT_MS,
    highAccuracy: false,
    maximumAgeMs: 3_600_000
  })
  if (!navigator.geolocation) {
    reportWeatherLocation('warn', '当前运行环境不支持 Geolocation API')
    void handleDeviceLocationFailure({ code: 0 }, startedAt)
    return
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      reportWeatherLocation('info', '系统已返回设备位置', {
        elapsedMs: Date.now() - startedAt,
        latitude: Number(coords?.latitude),
        longitude: Number(coords?.longitude),
        accuracyMeters: Number.isFinite(Number(coords?.accuracy)) ? Number(coords.accuracy) : null
      })
      void chooseDeviceLocation(coords)
    },
    (locationError) => {
      void handleDeviceLocationFailure(locationError, startedAt)
    },
    { enableHighAccuracy: false, timeout: DEVICE_LOCATION_TIMEOUT_MS, maximumAge: 3_600_000 }
  )
}

async function reverseGeocodeNetworkLocation() {
  const url = new URL(REVERSE_GEOCODING_URL)
  url.searchParams.set('localityLanguage', 'zh')
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REVERSE_GEOCODING_TIMEOUT_MS)
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(data?.message || `地名服务返回 ${response.status}`)
  const coordinates = {
    latitude: Number(data.latitude),
    longitude: Number(data.longitude)
  }
  if (!Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude)) {
    throw new Error('网络位置没有返回有效坐标')
  }
  const location = weatherLocationFromReverseGeocode(
    data,
    coordinates,
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'auto'
  )
  if (!location) throw new Error('网络位置没有返回有效城市')
  return location
}

async function handleDeviceLocationFailure(locationError, startedAt) {
  const code = Number(locationError?.code) || 0
  const failureMessage = deviceLocationErrorMessage(code)
  reportWeatherLocation('warn', '设备位置请求失败', {
    code,
    reason: String(locationError?.message || failureMessage),
    elapsedMs: Date.now() - startedAt,
    timeoutMs: DEVICE_LOCATION_TIMEOUT_MS
  })
  if (code === 1) {
    busy.value = ''
    error.value = failureMessage
    return
  }

  error.value = `${failureMessage}，正在尝试网络大致地区…`
  reportWeatherLocation('info', '开始使用网络大致地区作为定位降级')
  try {
    const saved = await choose(await reverseGeocodeNetworkLocation())
    if (!saved) return
    error.value = `${failureMessage}，已使用网络大致地区；可手动选择地区修正`
    reportWeatherLocation('info', '网络大致地区已保存', {
      name: location.value?.name || '',
      admin1: location.value?.admin1 || '',
      admin2: location.value?.admin2 || '',
      countryCode: location.value?.countryCode || ''
    })
  } catch (networkError) {
    busy.value = ''
    error.value = `${failureMessage}；网络大致地区也不可用，可以改用地区选择`
    reportWeatherLocation('warn', '网络大致地区定位失败', {
      reason: String(networkError?.message || '网络定位失败')
    })
  }
}

async function reverseGeocodeDeviceLocation(coords) {
  const url = new URL(REVERSE_GEOCODING_URL)
  url.searchParams.set('latitude', String(coords.latitude))
  url.searchParams.set('longitude', String(coords.longitude))
  url.searchParams.set('localityLanguage', 'zh')
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REVERSE_GEOCODING_TIMEOUT_MS)
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(data?.message || `地名服务返回 ${response.status}`)
  const location = weatherLocationFromReverseGeocode(
    data,
    coords,
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'auto'
  )
  if (!location) throw new Error('未能解析所在城市')
  return location
}

async function chooseDeviceLocation(coords) {
  busy.value = 'locate'
  error.value = ''
  try {
    const saved = await choose(await reverseGeocodeDeviceLocation(coords))
    if (saved) {
      reportWeatherLocation('info', '设备位置已解析并保存', {
        name: location.value?.name || '',
        admin1: location.value?.admin1 || '',
        admin2: location.value?.admin2 || '',
        countryCode: location.value?.countryCode || ''
      })
    }
  } catch (reverseError) {
    reportWeatherLocation('warn', '设备位置地名解析失败，尝试只保存坐标', {
      reason: String(reverseError?.message || '无法解析城市')
    })
    const saved = await choose({
      name: '设备位置',
      admin1: '',
      admin2: '',
      country: '',
      countryCode: '',
      latitude: coords.latitude,
      longitude: coords.longitude,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'auto'
    })
    if (saved) {
      error.value = `${reverseError?.message || '无法解析城市'}，已保存坐标；可手动选择地区修正`
      reportWeatherLocation('info', '设备位置坐标已保存，未取得城市名称', {
        latitude: Number(coords.latitude),
        longitude: Number(coords.longitude)
      })
    }
  }
}

onMounted(() =>
  load().catch((loadError) => (error.value = errorMessage(loadError, '读取天气设置失败')))
)
</script>

<template>
  <div class="weather-settings">
    <div class="setting-item">
      <div class="setting-left">
        <span class="setting-label">显示天气</span>
        <span class="setting-hint-caption">启动时、每天 09:00 或手动更新</span>
      </div>
      <div class="setting-right">
        <AppToggle
          v-model="enabled"
          :disabled="Boolean(busy)"
          @update:model-value="persistEnabled"
        />
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-left">
        <span class="setting-label">当前地区</span>
      </div>
      <div class="setting-right weather-settings__current-location">
        <span class="setting-value">{{ locationLabel }}</span>
        <span class="setting-hint-caption">
          {{ location ? `${location.latitude}, ${location.longitude}` : '位置只保存在本机' }}
        </span>
      </div>
    </div>

    <div class="weather-settings__picker">
      <ChinaAreaCascader
        :options="divisionTree"
        :display-value="locationLabel === '未设置' ? '' : locationLabel"
        :disabled="Boolean(busy)"
        @complete="choose"
      />
      <BaseButton size="sm" :disabled="Boolean(busy)" @click.prevent="useDeviceLocation">
        {{ busy === 'locate' ? '定位中…' : '使用设备位置' }}
      </BaseButton>
    </div>

    <p v-if="busy === 'save'" class="weather-settings__message">正在确认地区坐标并保存…</p>
    <p v-if="error" class="weather-settings__message is-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.weather-settings .setting-item {
  display: flex;
  min-height: 45rem;
  align-items: center;
  justify-content: space-between;
  gap: 16rem;
  padding: 10rem 14rem;
  border-radius: 10rem;
  background: var(--ui-surface-subtle);
  margin-bottom: 4rem;
}
.weather-settings .setting-left {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3rem;
}
.weather-settings .setting-right {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  justify-content: flex-end;
}
.weather-settings__current-location {
  max-width: 72%;
  align-items: flex-end;
  flex-direction: column;
  gap: 3rem;
  text-align: right;
}
.weather-settings .setting-label {
  color: var(--text-color);
  font-size: var(--fs-body);
}
.weather-settings .setting-hint-caption,
.weather-settings .setting-value {
  overflow: hidden;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.weather-settings__picker {
  display: flex;
  align-items: center;
  gap: 7rem;
  padding: 8rem 14rem;
  border-radius: 10rem;
  background: var(--ui-surface-subtle);
}
.weather-settings__picker :deep(.base-btn) {
  min-height: 34rem;
  flex: 0 0 auto;
  white-space: nowrap;
}
.weather-settings__message {
  margin: 7rem 0 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.5;
}
.weather-settings__message.is-error {
  color: #ff453a;
}
</style>
