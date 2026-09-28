import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import chinaAreas, {
  getDivisionChildren,
  getTopDivisions,
  matchDivisionByCode
} from '@aurouscia/china-areas/dist/index.js'
import chinaAdminCenters from '../data/china-weather-admin-centers.js'
import {
  WEATHER_SOURCE,
  describeWeatherCode,
  isKnownWeatherCode,
  isDisplayableWeatherDay,
  normalizeWeatherLocation,
  weatherLocationKey
} from '../../shared/weather-rules.js'
import { weatherFreshness } from '../../shared/weather-freshness.js'

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const REQUEST_TIMEOUT_MS = 12_000
const SEARCH_RESULT_LIMIT = 8
const MANUAL_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000
const CACHE_VERSION = 4
const CHINA_WEATHER_MODEL = Object.freeze({
  id: 'cma_grapes_global',
  name: 'CMA GRAPES',
  provider: '中国气象局'
})
const AUTO_WEATHER_MODEL = Object.freeze({ id: 'auto', name: '自动模型' })
const CHINA_HYBRID_WEATHER_MODEL = Object.freeze({
  id: 'cma_grapes_global+auto',
  name: 'CMA GRAPES + 自动补齐',
  provider: '中国气象局 / Open-Meteo'
})

// Electron 打包后，ESM 默认导出可能被包装成带数字键的对象；统一还原为数组。
const chinaAreaRecords = Array.isArray(chinaAreas)
  ? chinaAreas
  : Array.isArray(chinaAreas?.default)
    ? chinaAreas.default
    : Object.values(chinaAreas || {}).filter((item) => item?.code && item?.name)
const SPECIAL_ADMIN_DIVISIONS = Object.freeze({
  810000: [
    ['810001', '中西区'],
    ['810002', '湾仔区'],
    ['810003', '东区'],
    ['810004', '南区'],
    ['810005', '油尖旺区'],
    ['810006', '深水埗区'],
    ['810007', '九龙城区'],
    ['810008', '黄大仙区'],
    ['810009', '观塘区'],
    ['810010', '荃湾区'],
    ['810011', '屯门区'],
    ['810012', '元朗区'],
    ['810013', '北区'],
    ['810014', '大埔区'],
    ['810015', '西贡区'],
    ['810016', '沙田区'],
    ['810017', '葵青区'],
    ['810018', '离岛区']
  ],
  820000: [
    ['820001', '花地玛堂区'],
    ['820002', '花王堂区'],
    ['820003', '望德堂区'],
    ['820004', '大堂区'],
    ['820005', '风顺堂区'],
    ['820006', '嘉模堂区'],
    ['820007', '路凼填海区'],
    ['820008', '圣方济各堂区']
  ]
})

function isMunicipality(province) {
  return ['110000', '120000', '310000', '500000'].includes(province?.code)
}

function divisionParts(code) {
  const chain = matchDivisionByCode(String(code))
  const [province, second, third] = chain
  if (isMunicipality(province) && second && !third) {
    return { province, city: province, district: second }
  }
  if (second && !third && !String(second.code).endsWith('00')) {
    return {
      province,
      city: { code: `${province.code}:direct`, name: '省直辖县级行政区划' },
      district: second
    }
  }
  return { province, city: second, district: third }
}

function locationCandidateFromDivision(code) {
  const { province, city, district } = divisionParts(code)
  return {
    id: Number(code),
    name: district?.name || city?.name || province?.name,
    admin1: province?.name || '',
    admin2: district ? city?.name || '' : '',
    country: '中国',
    countryCode: 'CN',
    latitude: null,
    longitude: null,
    timezone: 'Asia/Shanghai'
  }
}

function locationCandidateFromParts(province, city, district) {
  const target = district || city || province
  return {
    id: Number(target.code),
    name: target.name,
    admin1: province?.name || '',
    admin2: district ? city?.name || '' : '',
    country: '中国',
    countryCode: 'CN',
    latitude: null,
    longitude: null,
    timezone: 'Asia/Shanghai'
  }
}

function findChinaAdminCenter(code) {
  return chinaAdminCenters?.[String(code)] || null
}

function trimDivisionSuffix(value) {
  return String(value || '').replace(
    /(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|地区|盟|省|市|区|县|旗)$/u,
    ''
  )
}

function cacheKey(location) {
  return `${weatherLocationKey(location)}|${weatherModelForLocation(location).id}`
}

function weatherModelForLocation(location) {
  return location?.countryCode === 'CN' ? CHINA_WEATHER_MODEL : AUTO_WEATHER_MODEL
}

function numberOrNull(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function roundOrNull(value) {
  const number = numberOrNull(value)
  return number === null ? null : Math.round(number)
}

function sanitizeForecast(forecast, legacy = false) {
  if (!forecast || typeof forecast !== 'object') return forecast
  return {
    ...forecast,
    days: Array.isArray(forecast.days)
      ? forecast.days
          .map((day) => {
            if (day?.dailyWeatherCode == null) return day
            const description = describeWeatherCode(day.dailyWeatherCode)
            return { ...day, weatherCode: day.dailyWeatherCode, ...description }
          })
          .filter(
            (day) =>
              isDisplayableWeatherDay(day) &&
              !(legacy && Number(day.temperatureMin) === 0 && Number(day.temperatureMax) === 0)
          )
      : []
  }
}

function mergeForecasts(primary, fallback) {
  if (!primary) return fallback
  if (!fallback) return primary

  const primaryDays = Array.isArray(primary.days) ? primary.days : []
  const fallbackDays = Array.isArray(fallback.days) ? fallback.days : []
  const daysByDate = new Map(fallbackDays.map((day) => [day.date, day]))
  for (const day of primaryDays) {
    const other = daysByDate.get(day.date)
    const merged = { ...day, fieldSources: {} }
    // 天气码和温度范围保持同一模型，只补齐主模型缺失的可选字段。
    for (const field of ['precipitationProbability', 'precipitation', 'windSpeedMax']) {
      if (day[field] == null && other?.[field] != null) {
        merged[field] = other[field]
        merged.fieldSources[field] = other.source
      }
    }
    daysByDate.set(day.date, merged)
  }
  // 新近获取不代表模型时刻新近。先选仍可显示的当前天气，再比较有效时刻。
  const now = Date.now()
  const candidates = [primary, fallback].filter((forecast) => forecast.current)
  candidates.sort(
    (left, right) =>
      Number(weatherFreshness(right, now).currentVisible) -
        Number(weatherFreshness(left, now).currentVisible) ||
      right.current.dataAt - left.current.dataAt
  )
  const current = candidates[0]?.current || null
  const days = [...daysByDate.values()].sort((left, right) => left.date.localeCompare(right.date))
  const models = new Set(
    [
      current?.source,
      ...days.flatMap((day) => [day.source, ...Object.values(day.fieldSources || {})])
    ]
      .map((source) => source?.model?.id)
      .filter(Boolean)
  )
  const source =
    models.size > 1
      ? { ...WEATHER_SOURCE, model: CHINA_HYBRID_WEATHER_MODEL }
      : models.has(CHINA_WEATHER_MODEL.id)
        ? primary.source
        : fallback.source

  return {
    ...primary,
    fetchedAt: Math.max(primary.fetchedAt, fallback.fetchedAt),
    timezone: primary.timezone || fallback.timezone,
    current,
    days,
    source
  }
}

async function responseJson(response) {
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.error) {
    const error = new Error(body?.reason || `天气服务返回 ${response.status}`)
    error.status = response.status
    const retry = response.headers?.get?.('retry-after')
    error.retryAt = retry
      ? Number.isFinite(Number(retry))
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry)
      : 0
    throw error
  }
  return body
}

export class WeatherService {
  constructor({
    cachePath,
    fetchImpl = globalThis.fetch,
    userAgent = 'Abandon-Note/unknown',
    diagnosticLog = null
  } = {}) {
    if (!cachePath) throw new Error('天气缓存路径不能为空')
    if (typeof fetchImpl !== 'function') throw new Error('当前运行时不支持 fetch')
    if (!String(userAgent).trim() || /[\r\n]/.test(String(userAgent))) {
      throw new Error('天气服务 User-Agent 无效')
    }
    this.cachePath = cachePath
    this.fetchImpl = fetchImpl
    this.userAgent = String(userAgent).trim()
    this.diagnosticLog = typeof diagnosticLog === 'function' ? diagnosticLog : null
    this.cacheLoaded = false
    this.cacheLoadPromise = null
    this.cacheWriteQueue = Promise.resolve()
    this.cache = { version: CACHE_VERSION, forecasts: {} }
  }

  report(level, scope, message, metadata) {
    this.diagnosticLog?.(level, scope, message, metadata)
  }

  loadCache() {
    if (!this.cacheLoadPromise) this.cacheLoadPromise = this.readCache()
    return this.cacheLoadPromise
  }

  async readCache() {
    if (this.cacheLoaded) return
    this.cacheLoaded = true
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, 'utf8'))
      if (
        [1, 2, 3, CACHE_VERSION].includes(parsed?.version) &&
        parsed.forecasts &&
        typeof parsed.forecasts === 'object'
      ) {
        let changed = parsed.version !== CACHE_VERSION
        const forecasts = Object.fromEntries(
          Object.entries(parsed.forecasts).map(([key, forecast]) => {
            const sanitized = sanitizeForecast(forecast, parsed.version < CACHE_VERSION)
            if ((forecast?.days?.length || 0) !== (sanitized?.days?.length || 0)) changed = true
            return [key, sanitized]
          })
        )
        this.cache = { version: CACHE_VERSION, forecasts }
        if (changed) {
          await this.saveCache().catch((error) => console.warn('[weather] 迁移缓存失败:', error))
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[weather] 读取缓存失败，将重新获取:', error)
    }
  }

  saveCache() {
    const content = JSON.stringify(this.cache)
    const write = this.cacheWriteQueue.then(async () => {
      await mkdir(dirname(this.cachePath), { recursive: true })
      const temporaryPath = `${this.cachePath}.tmp`
      await writeFile(temporaryPath, content, 'utf8')
      await rename(temporaryPath, this.cachePath)
    })
    this.cacheWriteQueue = write.catch(() => {})
    return write
  }

  async request(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await responseJson(
        await this.fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': this.userAgent }
        })
      )
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('天气服务请求超时')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  getChinaDivisionTree() {
    return getTopDivisions().map((province) => {
      const directChildren = getDivisionChildren(province.code)
      const centerOnlyChildren = (SPECIAL_ADMIN_DIVISIONS[province.code] || []).map(
        ([code, name]) => ({ code, name })
      )
      if (!directChildren.length && centerOnlyChildren.length) {
        return {
          code: province.code,
          name: province.name,
          candidate: locationCandidateFromDivision(province.code),
          children: [
            {
              code: `${province.code}:direct`,
              name: province.name,
              children: centerOnlyChildren.map((district) => ({
                ...district,
                candidate: locationCandidateFromParts(province, province, district)
              }))
            }
          ]
        }
      }
      const cities = directChildren.filter((item) => String(item.code).endsWith('00'))
      const directDistricts = directChildren.filter((item) => !String(item.code).endsWith('00'))
      const cityNodes = cities.map((city) => ({
        code: city.code,
        name: city.name,
        candidate: locationCandidateFromDivision(city.code),
        children: getDivisionChildren(city.code).map((district) => ({
          code: district.code,
          name: district.name,
          candidate: locationCandidateFromDivision(district.code)
        }))
      }))

      if (directDistricts.length) {
        cityNodes.push({
          code: `${province.code}:direct`,
          name: isMunicipality(province) ? province.name : '省直辖县级行政区划',
          children: directDistricts.map((district) => ({
            code: district.code,
            name: district.name,
            candidate: locationCandidateFromDivision(district.code)
          }))
        })
      }

      return {
        code: province.code,
        name: province.name,
        candidate: locationCandidateFromDivision(province.code),
        children: cityNodes
      }
    })
  }

  async resolveLocation(rawLocation) {
    const code = String(Math.round(Number(rawLocation?.id))).padStart(6, '0')
    const division = chinaAreaRecords.find((item) => item.code === code)
    if (!division) {
      const center = findChinaAdminCenter(code)
      if (!Array.isArray(center) || center.length < 2) return normalizeWeatherLocation(rawLocation)
      return normalizeWeatherLocation({
        ...rawLocation,
        latitude: center[1],
        longitude: center[0]
      })
    }

    const { province, city, district } = divisionParts(code)
    const center = findChinaAdminCenter(code)
    if (Array.isArray(center) && center.length >= 2) {
      return normalizeWeatherLocation({
        id: Number(code),
        name: district?.name || city?.name || province?.name,
        admin1: province?.name || '',
        admin2: district ? city?.name || '' : '',
        country: '中国',
        countryCode: 'CN',
        latitude: center[1],
        longitude: center[0],
        timezone: 'Asia/Shanghai'
      })
    }

    const parentCenter = findChinaAdminCenter(
      city?.code && !String(city.code).includes(':') ? city.code : province?.code
    )
    if (Array.isArray(parentCenter) && parentCenter.length >= 2) {
      return normalizeWeatherLocation({
        id: Number(code),
        name: district?.name || city?.name || province?.name,
        admin1: province?.name || '',
        admin2: district ? city?.name || '' : '',
        country: '中国',
        countryCode: 'CN',
        latitude: parentCenter[1],
        longitude: parentCenter[0],
        timezone: 'Asia/Shanghai'
      })
    }

    const searchName = trimDivisionSuffix(city?.name || province?.name)
    const url = new URL(GEOCODING_URL)
    url.searchParams.set('name', searchName)
    url.searchParams.set('count', String(SEARCH_RESULT_LIMIT))
    url.searchParams.set('language', 'zh')
    url.searchParams.set('format', 'json')
    url.searchParams.set('countryCode', 'CN')
    const data = await this.request(url)
    const provinceName = trimDivisionSuffix(province?.name)
    const cityName = trimDivisionSuffix(city?.name)
    const coordinateMatch = (data.results || []).find((item) => {
      const itemProvince = trimDivisionSuffix(item.admin1)
      const itemCity = trimDivisionSuffix(item.admin2)
      return (
        (!provinceName || itemProvince === provinceName) &&
        (!cityName || itemCity === cityName || trimDivisionSuffix(item.name) === cityName)
      )
    })
    if (!coordinateMatch) throw new Error('无法获得该地区的天气坐标')
    return normalizeWeatherLocation({
      id: Number(code),
      name: district?.name || city?.name || province?.name,
      admin1: province?.name || '',
      admin2: district ? city?.name || '' : '',
      country: '中国',
      countryCode: 'CN',
      latitude: coordinateMatch.latitude,
      longitude: coordinateMatch.longitude,
      timezone: 'Asia/Shanghai'
    })
  }

  createForecastUrl(location, model) {
    const url = new URL(FORECAST_URL)
    url.searchParams.set('latitude', String(location.latitude))
    url.searchParams.set('longitude', String(location.longitude))
    url.searchParams.set(
      'current',
      'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day'
    )
    url.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max'
    )
    url.searchParams.set('forecast_days', '16')
    url.searchParams.set('timezone', location.timezone || 'auto')
    if (model.id !== 'auto') url.searchParams.set('models', model.id)
    return url
  }

  normalizeForecast(data, location, fetchedAt, model = weatherModelForLocation(location)) {
    const daily = data?.daily || {}
    const times = ['time', 'weather_code', 'temperature_2m_min', 'temperature_2m_max'].every(
      (field) => Array.isArray(daily[field])
    )
      ? daily.time
      : []
    const source = { ...WEATHER_SOURCE, model }
    const currentCode = numberOrNull(data?.current?.weather_code)
    const days = times
      .map((date, index) => {
        const dailyCode = numberOrNull(daily.weather_code?.[index])
        const temperatureMin = numberOrNull(daily.temperature_2m_min?.[index])
        const temperatureMax = numberOrNull(daily.temperature_2m_max?.[index])
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().slice(0, 10) !== date ||
          !isDisplayableWeatherDay({ weatherCode: dailyCode, temperatureMin, temperatureMax })
        )
          return null
        // 全天概括和当前天气分别保留，不能用此刻晴天覆盖当天降雨预报。
        const code = dailyCode
        const description =
          code === null ? { label: '未知天气', icon: '•' } : describeWeatherCode(code)
        return {
          date: String(date),
          weatherCode: code,
          dailyWeatherCode: dailyCode,
          label: description.label,
          icon: description.icon,
          temperatureMax: Math.round(temperatureMax),
          temperatureMin: Math.round(temperatureMin),
          precipitationProbability: roundOrNull(daily.precipitation_probability_max?.[index]),
          precipitation: numberOrNull(daily.precipitation_sum?.[index]),
          windSpeedMax: roundOrNull(daily.wind_speed_10m_max?.[index]),
          source,
          fetchedAt
        }
      })
      .filter((day) => isDisplayableWeatherDay(day))
    const currentTemperature = roundOrNull(data?.current?.temperature_2m)
    const isDay = data?.current?.is_day === 1 ? true : data?.current?.is_day === 0 ? false : null
    const currentDescription = describeWeatherCode(currentCode, isDay)
    const dataAt =
      Date.parse(`${data?.current?.time}Z`) - Number(data?.utc_offset_seconds || 0) * 1000
    return {
      location,
      fetchedAt,
      timezone: data?.timezone || location.timezone || 'auto',
      current:
        data?.current &&
        isKnownWeatherCode(currentCode) &&
        currentTemperature !== null &&
        Number.isFinite(dataAt)
          ? {
              time: data.current.time,
              dataAt,
              isDay,
              source,
              fetchedAt,
              weatherCode: currentCode,
              label: currentDescription.label,
              icon: currentDescription.icon,
              temperature: currentTemperature,
              apparentTemperature: roundOrNull(data.current.apparent_temperature),
              windSpeed: roundOrNull(data.current.wind_speed_10m)
            }
          : null,
      days,
      source
    }
  }

  async requestForecast(location, model) {
    const data = await this.request(this.createForecastUrl(location, model))
    const forecast = this.normalizeForecast(data, location, Date.now(), model)
    // 该请求必需返回日预报；HTTP 200 的空体、损坏数组不能覆盖已有缓存。
    if (!forecast.days.length) throw new Error('天气服务未返回有效日预报')
    return forecast
  }

  async getForecast(
    rawLocation,
    { refresh = false, cacheOnly = false, shouldStore = null, trigger = 'unspecified' } = {}
  ) {
    const location = normalizeWeatherLocation(rawLocation)
    if (!location) throw new Error('请先在设置中选择城市')
    await this.loadCache()
    const key = cacheKey(location)
    const cached = this.cache.forecasts[key]
    if (!refresh && cached) {
      return {
        ...cached,
        cache: {
          hit: true,
          stale: false,
          policy: 'visible-30-minutes'
        }
      }
    }
    if (cacheOnly) return null

    const model = weatherModelForLocation(location)

    try {
      let forecast
      if (model.id === CHINA_WEATHER_MODEL.id) {
        const [primaryResult, fallbackResult] = await Promise.allSettled([
          this.requestForecast(location, CHINA_WEATHER_MODEL),
          this.requestForecast(location, AUTO_WEATHER_MODEL)
        ])
        const primary = primaryResult.status === 'fulfilled' ? primaryResult.value : null
        const fallback = fallbackResult.status === 'fulfilled' ? fallbackResult.value : null
        if (!primary && !fallback) throw primaryResult.reason || fallbackResult.reason
        if (!primary && fallback) {
          this.report(
            'warn',
            'weather.provider-fallback',
            '中国气象局天气模型失败，已使用自动模型',
            {
              trigger,
              locationKey: weatherLocationKey(location),
              failedModel: CHINA_WEATHER_MODEL.id,
              actualModel: fallback.source?.model?.id || AUTO_WEATHER_MODEL.id,
              reason: primaryResult.reason?.message || String(primaryResult.reason || '')
            }
          )
        }
        if (primary && !fallback) {
          this.report(
            'warn',
            'weather.provider-partial',
            '自动补齐模型失败，保留中国气象局有效预报',
            {
              trigger,
              locationKey: weatherLocationKey(location),
              failedModel: AUTO_WEATHER_MODEL.id,
              reason: fallbackResult.reason?.message || String(fallbackResult.reason || '')
            }
          )
        }
        forecast = mergeForecasts(primary, fallback)
      } else {
        forecast = await this.requestForecast(location, model)
      }
      // 地区可能在请求期间被修改。由调用方确认结果仍属于当前设置，避免旧请求
      // 后完成时覆盖新地区缓存；服务独立使用时保持原有写入行为。
      const stored = typeof shouldStore !== 'function' || shouldStore() !== false
      let cachePersisted = false
      if (stored) {
        this.cache.forecasts = { [key]: forecast }
        try {
          await this.saveCache()
          cachePersisted = true
        } catch (error) {
          console.warn('[weather] 保存缓存失败:', error)
        }
      }
      this.report('info', 'weather.network-refresh', '天气网络更新完成', {
        trigger,
        locationKey: weatherLocationKey(location),
        requestedModel: model.id,
        actualModel: forecast.source?.model?.id || model.id,
        dayCount: forecast.days.length,
        stored,
        cachePersisted
      })
      return {
        ...forecast,
        cache: { hit: false, stale: false, policy: 'visible-30-minutes' }
      }
    } catch (error) {
      if (cached) {
        this.report('warn', 'weather.stale-cache', '天气更新失败，已返回旧缓存', {
          trigger,
          locationKey: weatherLocationKey(location),
          cachedAt: cached.fetchedAt || null,
          reason: error?.message || String(error)
        })
        return {
          ...cached,
          cache: { hit: true, stale: true, policy: 'visible-30-minutes' },
          warning: error?.message || '无法更新天气',
          failure: { status: error?.status || null, retryAt: error?.retryAt || 0 }
        }
      }
      throw error
    }
  }

  async refreshForecastManually(rawLocation, { shouldStore = null, trigger = 'manual' } = {}) {
    const location = normalizeWeatherLocation(rawLocation)
    if (!location) throw new Error('请先在设置中选择地区')
    await this.loadCache()
    const cached = this.cache.forecasts[cacheKey(location)]
    const checkedAt = Date.now()
    const cachedAt = Number(cached?.fetchedAt)
    if (
      cached &&
      Number.isFinite(cachedAt) &&
      checkedAt - cachedAt >= 0 &&
      checkedAt - cachedAt < MANUAL_REFRESH_MIN_INTERVAL_MS
    ) {
      return {
        ...cached,
        cache: { hit: true, stale: false, policy: 'visible-30-minutes' },
        manualRefresh: { status: 'current', checkedAt }
      }
    }

    const forecast = await this.getForecast(location, { refresh: true, shouldStore, trigger })
    return {
      ...forecast,
      manualRefresh: {
        status: forecast.cache?.stale ? 'stale' : 'updated',
        checkedAt: Date.now()
      }
    }
  }
}
