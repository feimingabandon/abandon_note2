import { describe, expect, it } from 'vitest'
import {
  describeWeatherCode,
  isDisplayableWeatherDay,
  normalizeWeatherLocation,
  weatherDailyRefreshKey,
  weatherLocationFromReverseGeocode,
  weatherLocationLabel
} from '../src/shared/weather-rules.js'

describe('weather rules', () => {
  it('only displays complete daily weather and rejects legacy zero placeholders', () => {
    expect(isDisplayableWeatherDay({ weatherCode: 0, temperatureMin: 0, temperatureMax: 5 })).toBe(
      true
    )
    expect(isDisplayableWeatherDay({ weatherCode: 0, temperatureMin: 0, temperatureMax: 0 })).toBe(
      false
    )
    expect(
      isDisplayableWeatherDay({ weatherCode: null, temperatureMin: null, temperatureMax: null })
    ).toBe(false)
  })

  it('maps WMO weather codes to local Chinese labels', () => {
    expect(describeWeatherCode(0)).toEqual({ label: '晴', icon: '☀️' })
    expect(describeWeatherCode(63).label).toBe('中雨')
    expect(describeWeatherCode(95).label).toBe('雷阵雨')
    expect(describeWeatherCode(999).label).toBe('未知天气')
  })

  it('creates one local-date refresh key only after 09:00', () => {
    const beforeNine = new Date(2026, 7, 12, 8, 59).getTime()
    const afterNine = new Date(2026, 7, 12, 9, 0).getTime()
    expect(weatherDailyRefreshKey(beforeNine)).toBeNull()
    expect(weatherDailyRefreshKey(afterNine)).toBe('2026-08-12')
  })

  it('stores only a normalized point rather than a location trail', () => {
    const location = normalizeWeatherLocation({
      name: '上海',
      admin1: '上海市',
      country: '中国',
      latitude: 31.230416,
      longitude: 121.473701,
      timezone: 'Asia/Shanghai',
      ignored: 'not persisted'
    })
    expect(location).not.toHaveProperty('ignored')
    expect(location).toMatchObject({ latitude: 31.23042, longitude: 121.4737 })
    expect(weatherLocationLabel(location)).toBe('上海市 / 上海 / —')
    expect(normalizeWeatherLocation({ name: '缺坐标' })).toBeNull()
  })

  it('converts a reverse-geocoding response into a Chinese city location', () => {
    expect(
      weatherLocationFromReverseGeocode(
        {
          city: '广州市',
          locality: '增城区',
          principalSubdivision: '广东省',
          countryName: '中华人民共和国',
          countryCode: 'CN'
        },
        { latitude: 23.282221578, longitude: 113.668993588 },
        'Asia/Shanghai'
      )
    ).toEqual({
      id: null,
      name: '增城区',
      admin1: '广东省',
      admin2: '广州市',
      country: '中华人民共和国',
      countryCode: 'CN',
      latitude: 23.28222,
      longitude: 113.66899,
      timezone: 'Asia/Shanghai'
    })
  })
})
