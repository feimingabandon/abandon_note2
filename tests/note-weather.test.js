import { describe, expect, it } from 'vitest'
import {
  buildDisplayableWeatherByDate,
  buildDisplayableCurrentWeather,
  getNoteEffectiveDateKey,
  getWeatherForNote
} from '../src/renderer/src/utils/noteWeather.js'

describe('note weather mapping', () => {
  it('maps a note to displayable weather using its local effective date', () => {
    const weather = {
      date: '2026-09-03',
      weatherCode: 0,
      label: '晴',
      icon: '☀️',
      temperatureMin: 18,
      temperatureMax: 27
    }
    const weatherByDate = buildDisplayableWeatherByDate({
      fetchedAt: Date.now(),
      days: [
        weather,
        {
          date: '2026-09-04',
          weatherCode: 0,
          temperatureMin: null,
          temperatureMax: null
        }
      ]
    })
    const note = { effective_at: new Date(2026, 8, 3, 9, 30).getTime() }

    expect(getNoteEffectiveDateKey(note)).toBe('2026-09-03')
    expect(getWeatherForNote(note, weatherByDate)).toMatchObject(weather)
    expect(getWeatherForNote(note, weatherByDate).updateLabel).toContain('获取于')
    expect(weatherByDate.has('2026-09-04')).toBe(false)
  })

  it('returns no weather for invalid or uncovered note dates', () => {
    const weatherByDate = buildDisplayableWeatherByDate({ days: [] })

    expect(getWeatherForNote({ effective_at: Date.now() }, weatherByDate)).toBeNull()
    expect(getNoteEffectiveDateKey({ effective_at: 'invalid' })).toBe('')
    expect(getWeatherForNote({ effective_at: null }, weatherByDate)).toBeNull()
  })

  it('shares current detail only with its date and separates valid time, fetch time and model sources', () => {
    const now = Date.parse('2026-09-28T13:05:00Z')
    const source = { name: 'Open-Meteo', model: { name: 'CMA GRAPES' } }
    const fallback = { name: 'Open-Meteo', model: { name: '自动模型' } }
    const day = {
      weatherCode: 51,
      temperatureMin: 26,
      temperatureMax: 35,
      source,
      fieldSources: { precipitationProbability: fallback },
      precipitationProbability: 80
    }
    const forecast = {
      timezone: 'Asia/Shanghai',
      fetchedAt: now,
      source,
      current: {
        time: '2026-09-28T21:00',
        dataAt: now - 5 * 60000,
        weatherCode: 0,
        temperature: 27,
        isDay: false,
        source: fallback
      },
      days: [
        { ...day, date: '2026-09-28' },
        { ...day, date: '2026-09-29' }
      ]
    }
    const current = buildDisplayableCurrentWeather(forecast, now)
    const days = buildDisplayableWeatherByDate(forecast, now)
    expect(days.get('2026-09-28').currentWeather).toEqual(current)
    expect(days.get('2026-09-29').currentWeather).toBeNull()
    expect(current.icon).toBe('🌙')
    expect(current.validTimeLabel).toContain('21:00')
    expect(current.validTimeLabel).toContain('Asia/Shanghai')
    expect(current.updateLabel).toContain('获取于')
    expect(current.sourceLabel).toContain('自动模型')
    expect(days.get('2026-09-28').sourceLabel).toContain('CMA GRAPES')
    expect(days.get('2026-09-28').supplementLabel).toBe('降水概率由 Open-Meteo · 自动模型 补充')

    const oldModel = { ...forecast, current: { ...forecast.current, dataAt: now - 3 * 3600000 } }
    expect(buildDisplayableCurrentWeather(oldModel, now).updateLabel).toContain('数据较旧')
    expect(
      buildDisplayableWeatherByDate(oldModel, now).get('2026-09-28').updateLabel
    ).not.toContain('数据较旧')
    expect(
      buildDisplayableCurrentWeather({ ...forecast, warning: '断网' }, now).updateLabel
    ).toContain('更新失败')
    expect(buildDisplayableCurrentWeather(forecast, now + 6 * 3600000)).toBeNull()
    expect(buildDisplayableCurrentWeather(forecast, Date.parse('2026-09-28T16:01:00Z'))).toBeNull()
    expect(buildDisplayableWeatherByDate(forecast, now + 25 * 3600000).size).toBe(0)
  })
})
