import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
  dateKeyFromParts
} from '../src/shared/calendar/calendar-date-rules.js'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd(),
    getVersion: () => 'test-version'
  }
}))

let buildCalendarDayMetadata

beforeAll(async () => {
  ;({ buildCalendarDayMetadata } = await import('../src/main/calendar/calendar-metadata.js'))
})

describe('calendar metadata', () => {
  it('组合农历、传统节日和内置法定节假日', () => {
    const metadata = buildCalendarDayMetadata('2026-02-01', '2026-02-28')

    expect(metadata.get('2026-02-17')).toMatchObject({
      festival: '春节',
      displayLabel: '春节',
      holiday: { type: 'off', name: '春节' },
      lunar: { month: 1, day: 1, monthText: '正月', dayText: '初一' }
    })
    expect(metadata.get('2026-02-14').holiday).toMatchObject({
      type: 'work',
      name: '春节'
    })
  })

  it('覆盖中元、寒衣、下元和南北小年等常见传统节日', () => {
    const august = buildCalendarDayMetadata('2026-08-01', '2026-08-31')
    const november = buildCalendarDayMetadata('2026-11-01', '2026-11-30')
    const february = buildCalendarDayMetadata('2026-02-01', '2026-02-28')

    expect(august.get('2026-08-27')).toMatchObject({ festival: '中元', displayLabel: '中元' })
    expect(august.get('2026-08-27')).toMatchObject({ hasPublicHolidayFestival: false })
    expect(november.get('2026-11-09')).toMatchObject({
      festival: '寒衣',
      hasPublicHolidayFestival: false
    })
    expect(november.get('2026-11-23')).toMatchObject({ festival: '下元' })
    expect(february.get('2026-02-10')).toMatchObject({ festival: '北方小年' })
    expect(february.get('2026-02-11')).toMatchObject({ festival: '南方小年' })
  })

  it('覆盖固定公历和按星期计算的现代节日', () => {
    const march = buildCalendarDayMetadata('2026-03-01', '2026-03-31')
    const may = buildCalendarDayMetadata('2026-05-01', '2026-05-31')
    const june = buildCalendarDayMetadata('2026-06-01', '2026-06-30')
    const october = buildCalendarDayMetadata('2026-10-01', '2026-10-31')
    const november = buildCalendarDayMetadata('2026-11-01', '2026-11-30')

    expect(march.get('2026-03-08')).toMatchObject({
      festival: '妇女节',
      hasPublicHolidayFestival: false
    })
    expect(may.get('2026-05-01')).toMatchObject({
      festival: '劳动节',
      hasPublicHolidayFestival: true
    })
    expect(may.get('2026-05-10')).toMatchObject({ festival: '母亲节' })
    expect(june.get('2026-06-21')).toMatchObject({ festival: '父亲节' })
    expect(october.get('2026-10-01')).toMatchObject({ festival: '国庆节' })
    expect(november.get('2026-11-26')).toMatchObject({ festival: '感恩节' })
  })

  it('同日节日最多并列两个简称并保留全部详情', () => {
    const metadata = buildCalendarDayMetadata('2026-04-01', '2026-04-30')
    const qingming = metadata.get('2026-04-05')

    expect(qingming).toMatchObject({
      solarTerm: '清明',
      festival: '清明',
      hasPublicHolidayFestival: true,
      displayLabel: '清明/复活节'
    })
    expect(qingming.festivals.map((item) => item.name)).toEqual(['清明节', '复活节'])
    expect(qingming.detailLabel).toContain('清明节、复活节')
    expect(metadata.get('2026-04-04')).toMatchObject({ festival: '寒食' })
  })

  it('节气优先于普通农历日期显示', () => {
    const metadata = buildCalendarDayMetadata('2026-08-01', '2026-08-31')

    expect(metadata.get('2026-08-07')).toMatchObject({
      solarTerm: '立秋',
      displayLabel: '立秋'
    })
    expect(metadata.get('2026-08-11')).toMatchObject({
      solarTerm: null,
      festival: null,
      displayLabel: '廿九'
    })
  })

  it('在 1900–2100 的每个月都生成完整农历、节气与跨年节日元数据', () => {
    const failures = []
    const springFestivalYears = new Set()
    const newYearEveYears = new Set()
    const solarTermsByYear = new Map()

    for (let year = MIN_CALENDAR_YEAR; year <= MAX_CALENDAR_YEAR; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate()
        const monthStart = dateKeyFromParts(year, month, 1)
        const monthEnd = dateKeyFromParts(year, month, dayCount)
        const metadata = buildCalendarDayMetadata(monthStart, monthEnd)
        if (metadata.size !== dayCount) failures.push({ year, month, reason: '日期数量不完整' })

        for (let day = 1; day <= dayCount; day += 1) {
          const dateKey = dateKeyFromParts(year, month, day)
          const item = metadata.get(dateKey)
          if (!item || JSON.stringify(item).includes('undefined')) {
            failures.push({ dateKey, reason: '元数据缺失或包含无效占位' })
            continue
          }
          if (dateKey >= '1900-01-31' && (!item.lunar || !item.displayLabel || !item.detailLabel)) {
            failures.push({ dateKey, reason: '完整支持范围内的农历元数据缺失' })
            continue
          }
          if (item.solarTerm) {
            solarTermsByYear.set(year, (solarTermsByYear.get(year) || 0) + 1)
          }
          if (item.lunar?.month === 1 && item.lunar.day === 1) {
            if (!item.festivals.some((festival) => festival.name === '春节')) {
              failures.push({ dateKey, reason: '春节识别失败' })
            }
            springFestivalYears.add(year)
          }
          if (item.festivals.some((festival) => festival.name === '除夕')) {
            newYearEveYears.add(year)
          }
        }
      }
    }

    const supportedYearCount = MAX_CALENDAR_YEAR - MIN_CALENDAR_YEAR + 1
    expect(failures).toEqual([])
    expect(springFestivalYears.size).toBe(supportedYearCount)
    // chinese-days 的农历数据锚点是 1900-01-31，无法可靠推导此前一天的 1899 年农历。
    expect(newYearEveYears.size).toBe(supportedYearCount - 1)
    expect([...solarTermsByYear.values()].every((count) => count === 24)).toBe(true)
  })
})
