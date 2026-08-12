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
  normalizeWeatherLocation,
  weatherLocationKey
} from '../../shared/weather-rules.js'

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const REQUEST_TIMEOUT_MS = 12_000
const SEARCH_RESULT_LIMIT = 8
const MANUAL_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000
const CHINA_WEATHER_MODEL = Object.freeze({
  id: 'cma_grapes_global',
  name: 'CMA GRAPES',
  provider: '中国气象局'
})
const AUTO_WEATHER_MODEL = Object.freeze({ id: 'auto', name: '自动模型' })

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
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function roundOrNull(value) {
  const number = numberOrNull(value)
  return number === null ? null : Math.round(number)
}

async function responseJson(response) {
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.error) {
    throw new Error(body?.reason || `天气服务返回 ${response.status}`)
  }
  return body
}

export class WeatherService {
  constructor({ cachePath, fetchImpl = globalThis.fetch } = {}) {
    if (!cachePath) throw new Error('天气缓存路径不能为空')
    if (typeof fetchImpl !== 'function') throw new Error('当前运行时不支持 fetch')
    this.cachePath = cachePath
    this.fetchImpl = fetchImpl
    this.cacheLoaded = false
    this.cache = { version: 1, forecasts: {} }
  }

  async loadCache() {
    if (this.cacheLoaded) return
    this.cacheLoaded = true
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, 'utf8'))
      if (parsed?.version === 1 && parsed.forecasts && typeof parsed.forecasts === 'object') {
        this.cache = parsed
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[weather] 读取缓存失败，将重新获取:', error)
    }
  }

  async saveCache() {
    await mkdir(dirname(this.cachePath), { recursive: true })
    const temporaryPath = `${this.cachePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(this.cache), 'utf8')
    await rename(temporaryPath, this.cachePath)
  }

  async request(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await responseJson(
        await this.fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'AbandonNote/0.9.2' }
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

  normalizeForecast(data, location, fetchedAt) {
    const daily = data?.daily || {}
    const times = Array.isArray(daily.time) ? daily.time : []
    const currentCode = roundOrNull(data?.current?.weather_code)
    const currentDate = String(data?.current?.time || '').slice(0, 10)
    const days = times.map((date, index) => {
      const dailyCode = roundOrNull(daily.weather_code?.[index])
      // 日 weather_code 是当天最严重天气；今天优先展示当前实况，避免一次短时阵雨
      // 把整天误导性地概括为雷阵雨。未来日期仍保留日预报码。
      const code = String(date) === currentDate && currentCode !== null ? currentCode : dailyCode
      const description = describeWeatherCode(code)
      return {
        date: String(date),
        weatherCode: code,
        dailyWeatherCode: dailyCode,
        label: description.label,
        icon: description.icon,
        temperatureMax: roundOrNull(daily.temperature_2m_max?.[index]),
        temperatureMin: roundOrNull(daily.temperature_2m_min?.[index]),
        precipitationProbability: roundOrNull(daily.precipitation_probability_max?.[index]),
        precipitation: numberOrNull(daily.precipitation_sum?.[index]),
        windSpeedMax: roundOrNull(daily.wind_speed_10m_max?.[index])
      }
    })
    const currentDescription = describeWeatherCode(currentCode)
    return {
      location,
      fetchedAt,
      timezone: data?.timezone || location.timezone || 'auto',
      current: data?.current
        ? {
            time: data.current.time,
            weatherCode: currentCode,
            label: currentDescription.label,
            icon: currentDescription.icon,
            temperature: roundOrNull(data.current.temperature_2m),
            apparentTemperature: roundOrNull(data.current.apparent_temperature),
            windSpeed: roundOrNull(data.current.wind_speed_10m)
          }
        : null,
      days,
      source: { ...WEATHER_SOURCE, model: weatherModelForLocation(location) }
    }
  }

  async getForecast(rawLocation, { refresh = false, cacheOnly = false, shouldStore = null } = {}) {
    const location = normalizeWeatherLocation(rawLocation)
    if (!location) throw new Error('请先在设置中选择城市')
    await this.loadCache()
    const key = cacheKey(location)
    const cached = this.cache.forecasts[key]
    const now = Date.now()
    if (!refresh && cached) {
      return { ...cached, cache: { hit: true, stale: false, policy: 'startup-and-daily-09:00' } }
    }
    if (cacheOnly) return null

    const url = new URL(FORECAST_URL)
    url.searchParams.set('latitude', String(location.latitude))
    url.searchParams.set('longitude', String(location.longitude))
    url.searchParams.set(
      'current',
      'temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
    )
    url.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max'
    )
    url.searchParams.set('forecast_days', '16')
    url.searchParams.set('timezone', location.timezone || 'auto')
    const model = weatherModelForLocation(location)
    if (model.id !== 'auto') url.searchParams.set('models', model.id)

    try {
      const forecast = this.normalizeForecast(await this.request(url), location, now)
      // 地区可能在请求期间被修改。由调用方确认结果仍属于当前设置，避免旧请求
      // 后完成时覆盖新地区缓存；服务独立使用时保持原有写入行为。
      if (typeof shouldStore !== 'function' || shouldStore() !== false) {
        this.cache.forecasts = { [key]: forecast }
        await this.saveCache().catch((error) => console.warn('[weather] 保存缓存失败:', error))
      }
      return {
        ...forecast,
        cache: { hit: false, stale: false, policy: 'startup-and-daily-09:00' }
      }
    } catch (error) {
      if (cached) {
        return {
          ...cached,
          cache: { hit: true, stale: true, policy: 'startup-and-daily-09:00' },
          warning: error?.message || '无法更新天气'
        }
      }
      throw error
    }
  }

  async refreshForecastManually(rawLocation, { shouldStore = null } = {}) {
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
        cache: { hit: true, stale: false, policy: 'startup-and-daily-09:00' },
        manualRefresh: { status: 'current', checkedAt }
      }
    }

    const forecast = await this.getForecast(location, { refresh: true, shouldStore })
    return {
      ...forecast,
      manualRefresh: {
        status: forecast.cache?.stale ? 'stale' : 'updated',
        checkedAt: Date.now()
      }
    }
  }
}
