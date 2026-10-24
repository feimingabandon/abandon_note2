<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppToggle from '../ui/AppToggle.vue'
import BaseButton from '../ui/BaseButton.vue'
import HelpButton from '../ui/HelpButton.vue'
import ChinaAreaCascader from './ChinaAreaCascader.vue'
import { getSettingsSnapshotStore } from '../../utils/settingsSnapshots.js'
import {
  isSettingsSnapshot,
  parseSettingsReceipt,
  sameSettingsSource
} from '../../../../shared/settings-receipt.js'
import {
  normalizeWeatherLocation,
  weatherLocationFromReverseGeocode,
  weatherLocationKey,
  weatherLocationLabel
} from '../../../../shared/weather-rules.js'

const enabled = ref(false)
const almanacEnabled = ref(true)
const location = ref(null)
const divisionTree = ref([])
const busy = ref('')
const error = ref('')
const locationLabel = computed(() => weatherLocationLabel(location.value))
const REVERSE_GEOCODING_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client'
const DEVICE_LOCATION_TIMEOUT_MS = 20_000
const REVERSE_GEOCODING_TIMEOUT_MS = 10_000
const settingsSnapshots = getSettingsSnapshotStore(window.api)
const settingsUnavailable = ref(false)
const settingsIntentOwner = Symbol('weather-settings')
const settingIntents = new Map()
let locationSavePromise = null
let locationRequestSequence = 0
let activeLocationRequest = null
let settingsRevision = 0
let toggleSaveSequence = 0
let disposed = false
let stopSettingsChanged

function protectSettingIntent(id, value) {
  const previous = settingIntents.get(id)
  const intent = {
    id,
    release: settingsSnapshots.protectSetting(settingsIntentOwner, id, value)
  }
  settingIntents.set(id, intent)
  previous?.release()
  return intent
}

function releaseSettingIntent(intent) {
  if (settingIntents.get(intent.id) === intent) settingIntents.delete(intent.id)
  intent.release()
}

function restoreUnsentEnabledIntent(intent, sequence) {
  if (
    disposed ||
    sequence !== toggleSaveSequence ||
    settingIntents.get(intent.id) !== intent ||
    !intent.release.isActive()
  )
    return
  releaseSettingIntent(intent)
  // Releasing a lease need not publish a snapshot. Restore the v-model from a
  // valid projection explicitly when this enabled SQL was never dispatched.
  const actualEnabled = settingsSnapshots.latest()?.values?.weather?.enabled
  if (!disposed && sequence === toggleSaveSequence && typeof actualEnabled === 'boolean')
    enabled.value = actualEnabled
}

function commitSettingIntent(intent, result, request = null) {
  const receipt = parseSettingsReceipt(result, { source: settingsSnapshots.latest()?.source })
  if (!receipt.saved) throw new Error(receipt.error?.message || '天气设置保存结果尚未确认')
  // Match our own canonical reply before notifying consumers. A saved-only
  // receipt leaves the pending key intact until an actual read confirms it.
  if (request && isCurrentLocationRequest(request) && receipt.canonical?.values?.weather) {
    const weather = receipt.canonical.values.weather
    if (intent.id === 'weather.location') {
      request.locationKey = weatherLocationKey(weather.location)
      request.pendingLocationKey = null
    } else if (intent.id === 'weather.enabled') {
      request.enabled = weather.enabled
      request.pendingEnabled = null
    }
  }
  if (settingIntents.get(intent.id) === intent) settingIntents.delete(intent.id)
  const settlement = settingsSnapshots.settleWrite(intent.release, result)
  return settlement
}

async function confirmLocationForFollowUp(request, settlement) {
  if (!settlement.settled || !settlement.current || !isCurrentLocationRequest(request)) return null
  const expectedKey = request.pendingLocationKey || request.locationKey
  let actual = settlement.canonical
  if (!actual) {
    try {
      // Saved intent is a display projection. A dependent enabled write needs a
      // fresh, unmasked read of the actual region, never another location SQL.
      actual = await settingsSnapshots.read({ allowCachedOnError: false, protectIntents: false })
    } catch (readError) {
      if (isCurrentLocationRequest(request)) {
        error.value = '地区已保存，当前值尚待确认，暂未自动开启天气'
        reportWeatherLocation('warn', '天气地区已保存，读回确认暂不可用', {
          reason: errorMessage(readError, '地区读回失败')
        })
      }
      return null
    }
    // A read superseded by another publication can return the retained base.
    // It confirms this dependent action only after the saved shadow converges.
    if (settingsSnapshots.status().awaitingCanonical) {
      if (isCurrentLocationRequest(request))
        error.value = '地区已保存，当前值尚待确认，暂未自动开启天气'
      return null
    }
  }
  if (!isCurrentLocationRequest(request)) return null
  const weather = actual?.values?.weather
  if (
    !isSettingsSnapshot(actual) ||
    !sameSettingsSource(actual.source, settlement.source) ||
    (request.source && !sameSettingsSource(actual.source, request.source)) ||
    typeof weather?.enabled !== 'boolean' ||
    !expectedKey ||
    weatherLocationKey(weather.location) !== expectedKey
  ) {
    error.value = '地区已保存，当前地区尚未确认，暂未自动开启天气'
    return null
  }
  request.locationKey = expectedKey
  request.pendingLocationKey = null
  request.enabled = weather.enabled
  return weather
}

async function restoreSettingIntent(intent) {
  if (disposed || settingIntents.get(intent.id) !== intent || !intent.release.isActive()) return
  try {
    // A failed write may still have changed persisted state. Keep the preview
    // protected until a fresh authoritative read establishes the actual value.
    const actual = await settingsSnapshots.read({
      allowCachedOnError: false,
      protectIntents: false
    })
    if (disposed || settingIntents.get(intent.id) !== intent || !intent.release.isActive()) return
    releaseSettingIntent(intent)
    settingsSnapshots.acceptCommitted(actual, { reconcile: true })
  } catch {
    // Without confirmed actual state, unrelated snapshots must not erase intent.
  }
}

function applySettingsSnapshot(snapshot) {
  if (disposed) return
  settingsRevision += 1
  if (!snapshot?.values) {
    settingsUnavailable.value = true
    invalidateLocationRequest()
    return
  }
  settingsUnavailable.value = false
  const request = activeLocationRequest
  const nextLocationKey = weatherLocationKey(snapshot?.values?.weather?.location)
  const nextEnabled = Boolean(snapshot?.values?.weather?.enabled)
  // Own writes also broadcast. Accept their pending values, but another weather
  // choice or reset invalidates every earlier lookup before it can write again.
  if (
    request &&
    (!request.release.isActive() ||
      (nextLocationKey !== request.locationKey && nextLocationKey !== request.pendingLocationKey) ||
      (nextEnabled !== request.enabled && nextEnabled !== request.pendingEnabled))
  )
    invalidateLocationRequest()
  enabled.value = Boolean(snapshot?.values?.weather?.enabled)
  almanacEnabled.value = snapshot?.values?.almanac?.enabled !== false
  location.value = snapshot?.values?.weather?.location || null
}

function isCurrentLocationRequest(request) {
  return Boolean(
    request && !disposed && activeLocationRequest === request && request.release.isActive()
  )
}

function invalidateLocationRequest() {
  locationRequestSequence += 1
  const previous = activeLocationRequest
  activeLocationRequest = null
  locationSavePromise = null
  previous?.controller.abort()
  previous?.release()
  if (previous?.phase && busy.value === previous.phase) busy.value = ''
}

function beginLocationRequest(phase = '') {
  invalidateLocationRequest()
  const request = {
    controller: new AbortController(),
    // This empty lease versions request ownership only. It never masks values
    // or runtime, and lets reset cancel a lookup even when defaults are unchanged.
    release: settingsSnapshots.protectDomain(settingsIntentOwner, 'location-request', {}),
    source: settingsSnapshots.latest()?.source,
    locationKey: weatherLocationKey(location.value),
    enabled: enabled.value,
    pendingLocationKey: null,
    pendingEnabled: null,
    phase
  }
  activeLocationRequest = request
  if (phase) busy.value = phase
  return request
}

function finishLocationRequest(request) {
  if (!isCurrentLocationRequest(request)) return
  invalidateLocationRequest()
}

function trackLocationRequest(request, promise) {
  locationSavePromise = promise
  const finish = () => {
    if (locationSavePromise === promise) locationSavePromise = null
    finishLocationRequest(request)
  }
  promise.then(finish, finish)
  return promise
}

function locationRequestSignal(request) {
  return AbortSignal.any([
    request.controller.signal,
    AbortSignal.timeout(REVERSE_GEOCODING_TIMEOUT_MS)
  ])
}

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
  const requestSequence = locationRequestSequence
  const [, areas] = await Promise.all([
    settingsSnapshots.read(),
    window.api.getWeatherDivisionTree()
  ])
  if (disposed) return
  divisionTree.value = areas || []
  // Snapshot ordering belongs to the shared store. A local location action
  // still owns whether this initial read may start automatic enrichment.
  if (requestSequence !== locationRequestSequence) return
  const enrichmentRevision = settingsRevision
  if (
    location.value &&
    !location.value.id &&
    !location.value.admin2 &&
    location.value.countryCode === 'CN'
  ) {
    const request = beginLocationRequest()
    let intent = null
    try {
      const enriched = await reverseGeocodeDeviceLocation(location.value, request)
      if (!isCurrentLocationRequest(request) || settingsRevision !== enrichmentRevision) return
      if (enriched?.admin2) {
        request.pendingLocationKey = weatherLocationKey(enriched)
        intent = protectSettingIntent('weather.location', enriched)
        const snapshot = await window.api.setSettingValue('weather.location', enriched)
        commitSettingIntent(intent, snapshot, request)
        intent = null
      }
    } catch {
      if (intent) await restoreSettingIntent(intent)
      // 旧版仅保存到城市级时继续展示已有数据；反向地理编码失败不阻断设置页。
    } finally {
      finishLocationRequest(request)
    }
  }
}

async function persistEnabled(value) {
  if (disposed || settingsUnavailable.value) return
  invalidateLocationRequest()
  if (value && !location.value) {
    enabled.value = false
    error.value = '请先选择省、市、区县'
    return
  }
  const sequence = ++toggleSaveSequence
  const expectedSource = settingsSnapshots.latest()?.source
  const expectedLocationKey = weatherLocationKey(location.value)
  const needsLocationReadback = value && settingsSnapshots.status().awaitingCanonical
  const intent = protectSettingIntent('weather.enabled', value)
  busy.value = 'save'
  error.value = ''
  try {
    if (needsLocationReadback) {
      let actual
      try {
        actual = await settingsSnapshots.read({ allowCachedOnError: false, protectIntents: false })
      } catch {
        if (!disposed && sequence === toggleSaveSequence && intent.release.isActive()) {
          error.value = '当前地区尚待确认，暂未开启天气'
          restoreUnsentEnabledIntent(intent, sequence)
        }
        return
      }
      if (disposed || sequence !== toggleSaveSequence || !intent.release.isActive()) return
      if (
        settingsSnapshots.status().awaitingCanonical ||
        !isSettingsSnapshot(actual) ||
        (expectedSource && !sameSettingsSource(actual.source, expectedSource)) ||
        typeof actual.values?.weather?.enabled !== 'boolean' ||
        !expectedLocationKey ||
        weatherLocationKey(actual.values.weather.location) !== expectedLocationKey
      ) {
        error.value = '当前地区尚未确认，暂未开启天气'
        restoreUnsentEnabledIntent(intent, sequence)
        return
      }
      if (actual.values.weather.enabled === value) {
        restoreUnsentEnabledIntent(intent, sequence)
        return
      }
    }
    const snapshot = await window.api.setSettingValue('weather.enabled', value)
    commitSettingIntent(intent, snapshot)
  } catch (saveError) {
    if (!disposed && sequence === toggleSaveSequence && intent.release.isActive()) {
      error.value = errorMessage(saveError, '保存天气开关失败')
    }
    await restoreSettingIntent(intent)
  } finally {
    if (!disposed && sequence === toggleSaveSequence) busy.value = ''
  }
}

async function persistAlmanacEnabled(value) {
  if (disposed || settingsUnavailable.value) return
  const sequence = ++toggleSaveSequence
  const intent = protectSettingIntent('almanac.enabled', value)
  busy.value = 'almanac'
  error.value = ''
  try {
    const snapshot = await window.api.setSettingValue('almanac.enabled', value)
    commitSettingIntent(intent, snapshot)
  } catch (saveError) {
    if (!disposed && sequence === toggleSaveSequence && intent.release.isActive()) {
      error.value = errorMessage(saveError, '保存宜忌开关失败')
    }
    await restoreSettingIntent(intent)
  } finally {
    if (!disposed && sequence === toggleSaveSequence) busy.value = ''
  }
}

async function saveLocationCandidate(candidate, request) {
  if (!isCurrentLocationRequest(request)) return false
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
  request.phase = 'save'
  error.value = ''
  let intent = null
  try {
    if (!hasCoordinates) {
      resolvedCandidate = await window.api.resolveWeatherLocation(candidatePayload)
      if (!isCurrentLocationRequest(request)) return false
    }
    const normalized = normalizeWeatherLocation(resolvedCandidate)
    if (!normalized) throw new Error('无法获得该地区的天气坐标')
    if (!isCurrentLocationRequest(request)) return false
    request.pendingLocationKey = weatherLocationKey(normalized)
    intent = protectSettingIntent('weather.location', normalized)
    const locationSnapshot = await window.api.setSettingValue('weather.location', normalized)
    const locationSettlement = commitSettingIntent(intent, locationSnapshot, request)
    intent = null
    const actualWeather = await confirmLocationForFollowUp(request, locationSettlement)
    if (!actualWeather || !isCurrentLocationRequest(request)) return false
    if (!actualWeather.enabled) {
      request.pendingEnabled = true
      intent = protectSettingIntent('weather.enabled', true)
      const enabledSnapshot = await window.api.setSettingValue('weather.enabled', true)
      const enabledSettlement = commitSettingIntent(intent, enabledSnapshot, request)
      intent = null
      if (
        !enabledSettlement.settled ||
        !enabledSettlement.current ||
        !isCurrentLocationRequest(request)
      )
        return false
    }
    return true
  } catch (saveError) {
    if (isCurrentLocationRequest(request) && (!intent || intent.release.isActive())) {
      error.value = errorMessage(saveError, '保存地区失败')
      reportWeatherLocation('error', '天气地区保存失败', {
        reason: errorMessage(saveError, '保存地区失败')
      })
    }
    if (intent) await restoreSettingIntent(intent)
    return false
  }
}

function choose(candidate) {
  if (disposed || settingsUnavailable.value) return Promise.resolve(false)
  // Teleport 浮层在 leave 动画结束前仍保留 DOM。即使旧节点收到第二次点击，
  // 同一时刻也只允许一条解析与设置写入链路，避免地区和天气开关重复提交。
  if (locationSavePromise) return locationSavePromise
  const request = beginLocationRequest('save')
  return trackLocationRequest(request, saveLocationCandidate(candidate, request))
}

function useDeviceLocation() {
  if (disposed || settingsUnavailable.value || busy.value) return
  const request = beginLocationRequest('locate')
  const startedAt = Date.now()
  error.value = ''
  reportWeatherLocation('info', '用户请求设备位置', {
    timeoutMs: DEVICE_LOCATION_TIMEOUT_MS,
    highAccuracy: false,
    maximumAgeMs: 3_600_000
  })
  if (!navigator.geolocation) {
    reportWeatherLocation('warn', '当前运行环境不支持 Geolocation API')
    void trackLocationRequest(request, handleDeviceLocationFailure({ code: 0 }, startedAt, request))
    return
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      if (!isCurrentLocationRequest(request)) return
      reportWeatherLocation('info', '系统已返回设备位置', {
        elapsedMs: Date.now() - startedAt,
        latitude: Number(coords?.latitude),
        longitude: Number(coords?.longitude),
        accuracyMeters: Number.isFinite(Number(coords?.accuracy)) ? Number(coords.accuracy) : null
      })
      void trackLocationRequest(request, chooseDeviceLocation(coords, request))
    },
    (locationError) => {
      if (!isCurrentLocationRequest(request)) return
      void trackLocationRequest(
        request,
        handleDeviceLocationFailure(locationError, startedAt, request)
      )
    },
    { enableHighAccuracy: false, timeout: DEVICE_LOCATION_TIMEOUT_MS, maximumAge: 3_600_000 }
  )
}

async function reverseGeocodeNetworkLocation(request) {
  const url = new URL(REVERSE_GEOCODING_URL)
  url.searchParams.set('localityLanguage', 'zh')
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: locationRequestSignal(request)
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

async function handleDeviceLocationFailure(locationError, startedAt, request) {
  if (!isCurrentLocationRequest(request)) return false
  const code = Number(locationError?.code) || 0
  const failureMessage = deviceLocationErrorMessage(code)
  reportWeatherLocation('warn', '设备位置请求失败', {
    code,
    reason: String(locationError?.message || failureMessage),
    elapsedMs: Date.now() - startedAt,
    timeoutMs: DEVICE_LOCATION_TIMEOUT_MS
  })
  if (code === 1) {
    error.value = failureMessage
    return
  }

  error.value = `${failureMessage}，正在尝试网络大致地区…`
  reportWeatherLocation('info', '开始使用网络大致地区作为定位降级')
  try {
    const candidate = await reverseGeocodeNetworkLocation(request)
    if (!isCurrentLocationRequest(request)) return false
    const saved = await saveLocationCandidate(candidate, request)
    if (!saved) return
    error.value = `${failureMessage}，已使用网络大致地区；可手动选择地区修正`
    reportWeatherLocation('info', '网络大致地区已保存', {
      name: location.value?.name || '',
      admin1: location.value?.admin1 || '',
      admin2: location.value?.admin2 || '',
      countryCode: location.value?.countryCode || ''
    })
  } catch (networkError) {
    if (!isCurrentLocationRequest(request)) return false
    error.value = `${failureMessage}；网络大致地区也不可用，可以改用地区选择`
    reportWeatherLocation('warn', '网络大致地区定位失败', {
      reason: String(networkError?.message || '网络定位失败')
    })
  }
}

async function reverseGeocodeDeviceLocation(coords, request) {
  const url = new URL(REVERSE_GEOCODING_URL)
  url.searchParams.set('latitude', String(coords.latitude))
  url.searchParams.set('longitude', String(coords.longitude))
  url.searchParams.set('localityLanguage', 'zh')
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: locationRequestSignal(request)
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

async function chooseDeviceLocation(coords, request) {
  if (!isCurrentLocationRequest(request)) return false
  error.value = ''
  try {
    const candidate = await reverseGeocodeDeviceLocation(coords, request)
    if (!isCurrentLocationRequest(request)) return false
    const saved = await saveLocationCandidate(candidate, request)
    if (saved) {
      reportWeatherLocation('info', '设备位置已解析并保存', {
        name: location.value?.name || '',
        admin1: location.value?.admin1 || '',
        admin2: location.value?.admin2 || '',
        countryCode: location.value?.countryCode || ''
      })
    }
  } catch (reverseError) {
    if (!isCurrentLocationRequest(request)) return false
    reportWeatherLocation('warn', '设备位置地名解析失败，尝试只保存坐标', {
      reason: String(reverseError?.message || '无法解析城市')
    })
    const saved = await saveLocationCandidate(
      {
        name: '设备位置',
        admin1: '',
        admin2: '',
        country: '',
        countryCode: '',
        latitude: coords.latitude,
        longitude: coords.longitude,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'auto'
      },
      request
    )
    if (saved) {
      error.value = `${reverseError?.message || '无法解析城市'}，已保存坐标；可手动选择地区修正`
      reportWeatherLocation('info', '设备位置坐标已保存，未取得城市名称', {
        latitude: Number(coords.latitude),
        longitude: Number(coords.longitude)
      })
    }
  }
}

onMounted(() => {
  stopSettingsChanged = settingsSnapshots.subscribe(applySettingsSnapshot, {
    availabilityEvents: true
  })
  const requestSequence = locationRequestSequence
  void load().catch((loadError) => {
    if (!disposed && locationRequestSequence === requestSequence)
      error.value = errorMessage(loadError, '读取天气设置失败')
  })
})
onBeforeUnmount(() => {
  disposed = true
  invalidateLocationRequest()
  settingsSnapshots.clearOwner(settingsIntentOwner)
  settingIntents.clear()
  stopSettingsChanged?.()
})
</script>

<template>
  <div class="weather-settings">
    <p v-if="settingsUnavailable" class="weather-settings__message" role="status">
      当前天气设置尚待确认，重新读取设置后即可继续修改。
    </p>
    <template v-else>
      <div class="setting-item">
        <div class="setting-left">
          <span class="setting-label"
            >显示天气<HelpButton
              text="各视图同步显示天气，关闭后留空。窗口显示时每 30 分钟更新，也可手动刷新。"
          /></span>
        </div>
        <div class="setting-right">
          <AppToggle
            v-model="enabled"
            size="sm"
            aria-label="显示天气"
            :disabled="Boolean(busy)"
            @update:model-value="persistEnabled"
          />
        </div>
      </div>

      <div class="setting-item" data-search-text="显示宜忌 黄历 开启 关闭">
        <div class="setting-left">
          <span class="setting-label"
            >显示宜忌<HelpButton
              text="与天气独立控制，各视图同步。关闭后留空，农历和节假日仍正常显示。"
          /></span>
        </div>
        <div class="setting-right">
          <AppToggle
            v-model="almanacEnabled"
            size="sm"
            aria-label="显示宜忌"
            :disabled="Boolean(busy)"
            @update:model-value="persistAlmanacEnabled"
          />
        </div>
      </div>

      <div class="setting-item" data-search-text="当前地区 选择地区">
        <div class="setting-left">
          <span class="setting-label"
            >当前地区<HelpButton
              :text="
                location
                  ? `${locationLabel}；坐标 ${location.latitude}, ${location.longitude}。位置只保存在本机。`
                  : '请选择地区。位置只保存在本机。'
              "
          /></span>
        </div>
        <div class="setting-right weather-settings__current-location">
          <ChinaAreaCascader
            :options="divisionTree"
            :model-value="location"
            :display-value="locationLabel === '未设置' ? '' : locationLabel"
            :disabled="Boolean(busy)"
            :title="locationLabel"
            @complete="choose"
          />
        </div>
      </div>

      <div
        class="setting-item weather-settings__picker"
        data-settings-search-item
        data-search-text="选择地区 使用设备位置 定位"
      >
        <div class="setting-left"><span class="setting-label">设备位置</span></div>
        <BaseButton size="sm" :disabled="Boolean(busy)" @click.prevent="useDeviceLocation">
          {{ busy === 'locate' ? '定位中…' : '使用设备位置' }}
        </BaseButton>
      </div>

      <p v-if="busy === 'save'" class="weather-settings__message">正在确认地区坐标并保存…</p>
      <p v-if="error" class="weather-settings__message is-error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.weather-settings .setting-item {
  display: flex;
  min-height: max(40px, 2.85em);
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 8rem;
  background: var(--ui-surface-subtle);
  margin-bottom: 2rem;
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
  width: 156px;
  max-width: 58%;
  text-align: right;
}
.weather-settings__current-location :deep(.china-area-cascader__trigger) {
  min-height: 26px;
  padding: 3px 7px;
  font-size: var(--fs-secondary);
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
.weather-settings__picker :deep(.base-btn) {
  min-height: 26px;
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
  color: var(--ui-danger);
}
</style>
