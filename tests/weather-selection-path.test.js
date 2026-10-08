import { describe, it, expect } from 'vitest'
import { weatherSelectionPath } from '../src/renderer/src/utils/weatherSelectionPath.js'
const options = [
  {
    code: '44',
    name: '广东省',
    children: [
      {
        code: '4401',
        name: '广州市',
        candidate: { id: 440100 },
        children: [{ code: '440104', name: '越秀区', candidate: { id: 440104 } }]
      }
    ]
  }
]
describe('saved weather selection', () => {
  it('restores district by persisted id', () =>
    expect(weatherSelectionPath(options, { id: 440104 })).toEqual(['44', '4401', '440104']))
  it('restores city-level selection without inventing a district', () =>
    expect(weatherSelectionPath(options, { id: 440100 })).toEqual(['44', '4401']))
  it('restores device names with city suffix variants', () =>
    expect(
      weatherSelectionPath(options, {
        admin1: '广东',
        admin2: '广州',
        name: '越秀区',
        countryCode: 'CN'
      })
    ).toEqual(['44', '4401', '440104']))
  it('keeps unavailable or foreign locations unselected', () => {
    expect(weatherSelectionPath(options, { name: '伦敦', countryCode: 'GB' })).toEqual([])
    expect(weatherSelectionPath(options, null)).toEqual([])
  })
})
