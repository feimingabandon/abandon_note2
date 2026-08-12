import { describe, expect, it } from 'vitest'
import {
  buildDailyReportText,
  normalizeDailyReportDate,
  normalizeDailyReportStatuses,
  selectDailyReportNotes
} from '../src/main/services/daily-report.js'

describe('daily report', () => {
  it('keeps report dates inside the supported calendar range', () => {
    expect(normalizeDailyReportDate('2026-08-12')).toBe('2026-08-12')
    expect(() => normalizeDailyReportDate('1899-12-31')).toThrow(/年份/)
    expect(() => normalizeDailyReportDate('2101-01-01')).toThrow(/年份/)
  })

  it('normalizes a multi-status selection in stable display order', () => {
    expect(normalizeDailyReportStatuses(['completed', 'initialized', 'completed'])).toEqual([
      'initialized',
      'completed'
    ])
    expect(normalizeDailyReportStatuses([])).toEqual([])
    expect(() => normalizeDailyReportStatuses(['unknown'])).toThrow(/状态筛选/)
  })

  it('exports plain text without note totals or tags', () => {
    const text = buildDailyReportText({
      dateKey: '2026-08-12',
      notes: [
        {
          id: 1,
          status: 'in_progress',
          content: '调整月视图交互动效',
          effective_at: new Date(2026, 7, 12, 9, 15).getTime(),
          tags: [{ name: '开发' }]
        },
        {
          id: 2,
          status: 'completed',
          content: '完成日报导出功能设计',
          finished_at: new Date(2026, 7, 12, 10, 32).getTime(),
          tags: [{ name: '产品' }]
        }
      ]
    })

    expect(text).toContain('日报 2026年8月12日')
    expect(text).toContain('【进行中】')
    expect(text).toContain('生效时间：2026-08-12 09:15')
    expect(text).toContain('【已完成】')
    expect(text).toContain('完成时间：2026-08-12 10:32')
    expect(text).not.toContain('共 2 条')
    expect(text).not.toContain('标签')
    expect(text).not.toContain('开发')
    expect(text).not.toContain('产品')
  })

  it('keeps the preview order while selecting explicit note ids', () => {
    const notes = [{ id: 9 }, { id: 3 }, { id: 5 }]
    expect(selectDailyReportNotes(notes, [5, 9])).toEqual([{ id: 9 }, { id: 5 }])
    expect(() => selectDailyReportNotes(notes, [])).toThrow(/至少一条/)
  })
})
