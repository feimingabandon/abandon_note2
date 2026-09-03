import { describe, expect, it } from 'vitest'
import {
  buildDisplayableWeatherByDate,
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
      days: [
        weather,
        {
          date: '2026-09-04',
          weatherCode: 0,
          temperatureMin: 0,
          temperatureMax: 0
        }
      ]
    })
    const note = { effective_at: new Date(2026, 8, 3, 9, 30).getTime() }

    expect(getNoteEffectiveDateKey(note)).toBe('2026-09-03')
    expect(getWeatherForNote(note, weatherByDate)).toBe(weather)
    expect(weatherByDate.has('2026-09-04')).toBe(false)
  })

  it('returns no weather for invalid or uncovered note dates', () => {
    const weatherByDate = buildDisplayableWeatherByDate({ days: [] })

    expect(getWeatherForNote({ effective_at: Date.now() }, weatherByDate)).toBeNull()
    expect(getNoteEffectiveDateKey({ effective_at: 'invalid' })).toBe('')
    expect(getWeatherForNote({ effective_at: null }, weatherByDate)).toBeNull()
  })
})
