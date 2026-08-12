import { describe, expect, it } from 'vitest'
import {
  holidayDataDownloadUrl,
  holidayMetadataForDate,
  normalizeHolidayDataset
} from '../src/shared/calendar/holiday-data-rules.js'

function createYearData(year = 2027) {
  return {
    holidays: {
      [`${year}-01-01`]: "New Year's Day,元旦,1",
      [`${year}-01-02`]: "New Year's Day,元旦,1"
    },
    workdays: {
      [`${year}-01-03`]: "New Year's Day,元旦,1"
    },
    inLieuDays: {
      [`${year}-01-02`]: "New Year's Day,元旦,1"
    }
  }
}

describe('holiday data rules', () => {
  it('校验并按年份拆分 chinese-days JSON', () => {
    const payload = {
      holidays: {
        ...createYearData(2026).holidays,
        ...createYearData(2027).holidays
      },
      workdays: {
        ...createYearData(2026).workdays,
        ...createYearData(2027).workdays
      },
      inLieuDays: {
        ...createYearData(2026).inLieuDays,
        ...createYearData(2027).inLieuDays
      }
    }

    const result = normalizeHolidayDataset(JSON.stringify(payload))

    expect(result.years).toEqual([2026, 2027])
    expect(result.dataByYear['2027'].holidays['2027-01-01']).toContain('元旦')
  })

  it('在线下载只接受请求年份', () => {
    expect(() => normalizeHolidayDataset(createYearData(2027), { expectedYear: 2026 })).toThrow(
      '下载内容不是 2026 年节假日数据'
    )
    expect(normalizeHolidayDataset(createYearData(2027), { expectedYear: 2027 }).years).toEqual([
      2027
    ])
  })

  it('拒绝同时标记为休息和工作的日期', () => {
    const payload = createYearData(2027)
    payload.workdays['2027-01-01'] = payload.holidays['2027-01-01']
    expect(() => normalizeHolidayDataset(payload)).toThrow('不能同时是休息日和调班工作日')
  })

  it('将有效数据转换为月视图休班标记', () => {
    const yearData = normalizeHolidayDataset(createYearData(2027)).dataByYear['2027']
    expect(holidayMetadataForDate(yearData, '2027-01-02')).toEqual({
      type: 'off',
      name: '元旦',
      inLieu: true
    })
    expect(holidayMetadataForDate(yearData, '2027-01-03')).toEqual({
      type: 'work',
      name: '元旦',
      inLieu: false
    })
    expect(holidayMetadataForDate(null, '2027-01-01')).toBeNull()
  })

  it('只生成固定的官方按年下载地址', () => {
    expect(holidayDataDownloadUrl(2027)).toBe(
      'https://cdn.jsdelivr.net/npm/chinese-days/dist/years/2027.json'
    )
    expect(() => holidayDataDownloadUrl(2200)).toThrow('年份必须在 1900~2100 之间')
  })
})
