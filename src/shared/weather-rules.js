export const WEATHER_SOURCE = Object.freeze({
  name: 'Open-Meteo',
  url: 'https://open-meteo.com/',
  attribution: '数据来源：Open-Meteo'
})

const WEATHER_CODE_GROUPS = Object.freeze([
  { codes: [0], label: '晴', icon: '☀️' },
  { codes: [1], label: '大部晴朗', icon: '🌤️' },
  { codes: [2], label: '多云', icon: '⛅' },
  { codes: [3], label: '阴', icon: '☁️' },
  { codes: [45, 48], label: '雾', icon: '🌫️' },
  { codes: [51, 53, 55], label: '毛毛雨', icon: '🌦️' },
  { codes: [56, 57], label: '冻毛毛雨', icon: '🌧️' },
  { codes: [61], label: '小雨', icon: '🌦️' },
  { codes: [63], label: '中雨', icon: '🌧️' },
  { codes: [65], label: '大雨', icon: '🌧️' },
  { codes: [66, 67], label: '冻雨', icon: '🌧️' },
  { codes: [71], label: '小雪', icon: '🌨️' },
  { codes: [73], label: '中雪', icon: '🌨️' },
  { codes: [75, 77], label: '大雪', icon: '❄️' },
  { codes: [80], label: '局部阵雨', icon: '🌦️' },
  { codes: [81, 82], label: '阵雨', icon: '🌧️' },
  { codes: [85, 86], label: '阵雪', icon: '🌨️' },
  { codes: [95], label: '雷阵雨', icon: '⛈️' },
  { codes: [96, 99], label: '强雷阵雨', icon: '⛈️' }
])

const WEATHER_BY_CODE = new Map(
  WEATHER_CODE_GROUPS.flatMap((group) =>
    group.codes.map((code) => [code, Object.freeze({ label: group.label, icon: group.icon })])
  )
)

export function describeWeatherCode(value) {
  return WEATHER_BY_CODE.get(Number(value)) || { label: '未知天气', icon: '•' }
}

function isFiniteWeatherNumber(value) {
  if (value === null || value === undefined || value === '') return false
  return Number.isFinite(Number(value))
}

/**
 * 日历中只展示具备天气码和高低温的完整日预报。
 * Open-Meteo 模型超出可用预报范围时会返回 null，旧版曾将它们误转为 0。
 * 同时屏蔽这类历史占位数据，但保留 0°～5° 等真实低温预报。
 */
export function isDisplayableWeatherDay(day) {
  if (
    !isFiniteWeatherNumber(day?.weatherCode) ||
    !isFiniteWeatherNumber(day?.temperatureMin) ||
    !isFiniteWeatherNumber(day?.temperatureMax)
  ) {
    return false
  }
  return !(Number(day.temperatureMin) === 0 && Number(day.temperatureMax) === 0)
}

export function weatherDailyRefreshKey(timestamp = Date.now(), refreshHour = 9) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime()) || date.getHours() < refreshHour) return null
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function normalizeWeatherLocation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.latitude === null || value.latitude === undefined || value.latitude === '') return null
  if (value.longitude === null || value.longitude === undefined || value.longitude === '')
    return null
  const latitude = Number(value.latitude)
  const longitude = Number(value.longitude)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null
  const name = String(value.name || '')
    .trim()
    .slice(0, 80)
  if (!name) return null
  const locationId =
    value.id === null || value.id === undefined || value.id === '' ? null : Number(value.id)
  return {
    id: Number.isFinite(locationId) && locationId > 0 ? Math.round(locationId) : null,
    name,
    admin1: String(value.admin1 || '')
      .trim()
      .slice(0, 80),
    admin2: String(value.admin2 || '')
      .trim()
      .slice(0, 80),
    country: String(value.country || '')
      .trim()
      .slice(0, 80),
    countryCode: String(value.countryCode || '')
      .trim()
      .toUpperCase()
      .slice(0, 2),
    latitude: Number(latitude.toFixed(5)),
    longitude: Number(longitude.toFixed(5)),
    timezone:
      String(value.timezone || 'auto')
        .trim()
        .slice(0, 80) || 'auto'
  }
}

/** 统一天气请求、缓存与过期结果判定使用的地区身份。 */
export function weatherLocationKey(value) {
  const location = normalizeWeatherLocation(value)
  if (!location) return ''
  return JSON.stringify([
    location.id || null,
    location.name,
    location.latitude,
    location.longitude,
    location.timezone || 'auto',
    location.countryCode || ''
  ])
}

export function normalizeWeatherLocationParts(value) {
  const normalized = normalizeWeatherLocation(value)
  if (!normalized) return null
  const province = normalized.admin1 || '—'
  const city = normalized.admin2 || (normalized.name !== normalized.admin1 ? normalized.name : '—')
  const district =
    normalized.admin2 && normalized.name !== normalized.admin2 ? normalized.name : '—'
  return [province, city, district]
}

export function weatherLocationLabel(location) {
  const parts = normalizeWeatherLocationParts(location)
  return parts ? parts.join(' / ') : '未设置'
}

export function weatherLocationFromReverseGeocode(data, coordinates, timezone = 'auto') {
  const city = String(data?.city || data?.locality || '').trim()
  if (!city) return null
  const district = String(data?.locality || '').trim()
  const isDistrict = /(?:区|县|旗|市)$/.test(district) && district !== city
  return normalizeWeatherLocation({
    name: isDistrict ? district : city,
    admin1: data?.principalSubdivision,
    admin2: isDistrict ? city : '',
    country: data?.countryName,
    countryCode: data?.countryCode,
    latitude: coordinates?.latitude,
    longitude: coordinates?.longitude,
    timezone
  })
}
