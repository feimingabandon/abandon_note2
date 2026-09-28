import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ALMANAC_SOURCE, calculateAlmanac } from '../src/main/calendar/almanac-engine.js'
import { almanacSummary } from '../src/shared/calendar/almanac-display.js'

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/almanac-reference.json', import.meta.url), 'utf8')
)
describe('offline almanac', () => {
  it('matches the fixed Python reference on festivals, leap month, boundaries and weekly samples', () => {
    for (const row of reference.days) {
      const actual = calculateAlmanac(row.dateKey)
      expect(actual.status, row.dateKey).toBe('ok')
      for (const side of ['yi', 'ji'])
        expect(
          [...actual[side].items, ...actual[side].special].sort(),
          `${row.dateKey} ${side}`
        ).toEqual(row[side].filter((x) => x !== '无').sort())
      for (const key of ['lunar', 'dayGanzhi', 'officer'])
        expect(actual[key], `${row.dateKey} ${key}`).toEqual(row[key])
    }
  })
  it('rejects invalid dates and refuses the upstream year-index wraparound', () => {
    expect(() => calculateAlmanac('2026-02-30')).toThrow()
    expect(() => calculateAlmanac('../../file')).toThrow()
    for (const key of ['1900-06-01', '1901-02-18', '2100-01-01', '2100-12-31'])
      expect(calculateAlmanac(key).status).toBe('unsupported')
    expect(calculateAlmanac(ALMANAC_SOURCE.minDate).status).toBe('ok')
    expect(calculateAlmanac(ALMANAC_SOURCE.maxDate).status).toBe('ok')
  })
  it('does not change a selected date at 23:00 and does not expose mutable cached results', () => {
    const expected = calculateAlmanac('2026-09-28')
    vi.useFakeTimers()
    try {
      for (const time of ['2026-09-28T23:30:00+08:00', '2026-09-29T00:30:00+08:00']) {
        vi.setSystemTime(new Date(time))
        expect(calculateAlmanac('2026-09-28')).toEqual(expected)
      }
      const changed = calculateAlmanac('2026-09-28')
      changed.yi.items.length = 0
      expect(calculateAlmanac('2026-09-28')).toEqual(expected)
    } finally {
      vi.useRealTimers()
    }
  })
  it('is identical under Shanghai, UTC and DST host timezones', () => {
    const code = `import { calculateAlmanac } from './src/main/calendar/almanac-engine.js'; console.log(JSON.stringify(['2026-03-08','2026-11-01','2023-03-22'].map(calculateAlmanac)))`
    const values = ['Asia/Shanghai', 'UTC', 'America/New_York'].map((TZ) =>
      execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: process.cwd(),
        env: { ...process.env, TZ },
        encoding: 'utf8'
      }).trim()
    )
    expect(new Set(values).size).toBe(1)
  })
  it('keeps special statements separate from ordinary empty results', () => {
    expect(almanacSummary({ special: ['余事勿取'], items: [] }, '无特别忌项')).toBe('余事勿取')
    expect(almanacSummary({ special: [], items: [] }, '无特别忌项')).toBe('无特别忌项')
    expect(almanacSummary({ items: ['祭祀', '出行', '开市', '嫁娶'] }, '')).toBe(
      '嫁娶、出行、开市…'
    )
    expect(almanacSummary({ items: ['祭祀', '出行', '开市', '嫁娶'] }, '', Infinity)).toBe(
      '嫁娶、出行、开市、祭祀'
    )
  })
})
