import { Lunar } from './vendor/cnlunar/lunar.js'
import { CivilDate } from './vendor/cnlunar/civil-date.js'
import { parseDateKey } from '../../shared/calendar/calendar-date-rules.js'

export const ALMANAC_SOURCE = Object.freeze({
  name: 'cnlunar-js 0.2.0',
  revision: 'b7daa47198f7370c4f75d43be1667407f164c4f2',
  rules: 'xieji-8char-year-duty-civil-noon-1',
  reference: '《钦定协纪辨方书》',
  convention: '中国历法 · 春节换年 · 交节日换月 · 日期固定取值',
  minDate: '1901-02-19',
  // Upstream has 200 solar-term years but only 199 lunar-month years. Never let
  // its modulo indexing silently reuse 1901 data for lunar year 2100.
  maxDate: '2099-12-31'
})
const cache = new Map()
const specialTerms = new Set(['诸事不宜', '诸事不忌', '余事勿取'])

function terms(values) {
  const raw = [...new Set(values || [])].filter(
    (value) => typeof value === 'string' && value !== '无'
  )
  return {
    items: raw.filter((value) => !specialTerms.has(value)),
    special: raw.filter((value) => specialTerms.has(value))
  }
}

export function calculateAlmanac(dateKey) {
  const { year, month, day } = parseDateKey(dateKey)
  if (dateKey < ALMANAC_SOURCE.minDate || dateKey > ALMANAC_SOURCE.maxDate) {
    return { dateKey, status: 'unsupported', source: ALMANAC_SOURCE }
  }
  if (cache.has(dateKey)) return structuredClone(cache.get(dateKey))
  const lunar = new Lunar(new CivilDate(year, month - 1, day, 12), '8char', 'year', 'duty')
  const yi = terms(lunar.goodThing)
  const ji = terms(lunar.badThing)
  const result = {
    dateKey,
    status: 'ok',
    source: ALMANAC_SOURCE,
    yi,
    ji,
    yearGanzhi: lunar.year8Char,
    monthGanzhi: lunar.month8Char,
    dayGanzhi: lunar.day8Char,
    officer: lunar.today12DayOfficer,
    dayGod: lunar.today12DayGod,
    goodGods: lunar.goodGodName || [],
    badGods: lunar.badGodName || [],
    // Keep unresolved upstream overlaps visible; never silently declare one side correct.
    conflicts: yi.items.filter((item) => ji.items.includes(item)),
    lunar: {
      year: lunar.lunarYear,
      month: lunar.lunarMonth,
      day: lunar.lunarDay,
      isLeap: lunar.isLunarLeapMonth
    }
  }
  if (cache.size >= 256) cache.delete(cache.keys().next().value)
  cache.set(dateKey, result)
  return structuredClone(result)
}
