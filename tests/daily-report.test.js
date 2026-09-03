import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  buildDailyReportExcel,
  buildDailyReportText,
  normalizeDailyReportDate,
  normalizeDailyReportExportFormat,
  normalizeDailyReportRange,
  normalizeDailyReportStatuses,
  selectDailyReportNotes
} from '../src/main/services/daily-report.js'

describe('daily report', () => {
  it('keeps report dates inside the supported calendar range', () => {
    expect(normalizeDailyReportDate('2026-08-12')).toBe('2026-08-12')
    expect(() => normalizeDailyReportDate('1899-12-31')).toThrow(/年份/)
    expect(() => normalizeDailyReportDate('2101-01-01')).toThrow(/年份/)
  })

  it('accepts inclusive date ranges up to 366 days', () => {
    expect(
      normalizeDailyReportRange({ startDateKey: '2025-01-01', endDateKey: '2026-01-01' })
    ).toMatchObject({
      startDateKey: '2025-01-01',
      endDateKey: '2026-01-01',
      dayCount: 366
    })
    expect(() =>
      normalizeDailyReportRange({ startDateKey: '2026-01-02', endDateKey: '2026-01-01' })
    ).toThrow(/结束日期/)
    expect(() =>
      normalizeDailyReportRange({ startDateKey: '2025-01-01', endDateKey: '2026-01-02' })
    ).toThrow(/366 天/)
    expect(normalizeDailyReportExportFormat('XLSX')).toBe('xlsx')
    expect(() => normalizeDailyReportExportFormat('csv')).toThrow(/格式/)
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
      startDateKey: '2026-08-12',
      endDateKey: '2026-08-14',
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

    expect(text).toContain('便签报表 2026年8月12日 至 2026年8月14日')
    expect(text).toContain('【进行中】')
    expect(text).toContain('生效时间：2026-08-12 09:15')
    expect(text).toContain('【已完成】')
    expect(text).toContain('完成时间：2026-08-12 10:32')
    expect(text).not.toContain('共 2 条')
    expect(text).not.toContain('标签')
    expect(text).not.toContain('开发')
    expect(text).not.toContain('产品')
  })

  it('builds a real Excel workbook with one note per row and named columns', async () => {
    const { buffer, truncatedCount } = await buildDailyReportExcel({
      startDateKey: '2026-08-12',
      endDateKey: '2026-08-14',
      notes: [
        {
          id: 1,
          status: 'in_progress',
          content: '=保持为纯文本',
          is_pinned: 1,
          effective_at: new Date(2026, 7, 12, 9, 15).getTime(),
          duration_days: 3
        },
        {
          id: 2,
          status: 'completed',
          content: '完成 Excel 导出',
          is_pinned: 0,
          effective_at: new Date(2026, 7, 13, 8).getTime(),
          duration_days: 1,
          finished_at: new Date(2026, 7, 13, 10, 32).getTime()
        }
      ]
    })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer)
    const sheet = workbook.getWorksheet('便签报表')

    expect(truncatedCount).toBe(0)
    expect(sheet.rowCount).toBe(3)
    expect(sheet.getRow(1).values.slice(1)).toEqual([
      '便签内容',
      '当前状态',
      '是否完成',
      '生效时间',
      '结束日期',
      '持续天数',
      '完成时间',
      '是否置顶'
    ])
    expect(sheet.getRow(2).getCell(1).value).toBe('=保持为纯文本')
    expect(sheet.getRow(2).getCell(2).value).toBe('进行中')
    expect(sheet.getRow(2).getCell(3).value).toBe('否')
    expect(sheet.getRow(2).getCell(5).value).toBeInstanceOf(Date)
    expect(sheet.getRow(2).getCell(6).value).toBe(3)
    expect(sheet.getRow(2).getCell(8).value).toBe('是')
    expect(sheet.getRow(3).getCell(3).value).toBe('是')
    expect(sheet.getRow(3).getCell(7).value).toBeInstanceOf(Date)
  })

  it('reports Excel cell truncation without adding extra note rows', async () => {
    const { buffer, truncatedCount } = await buildDailyReportExcel({
      dateKey: '2026-08-12',
      notes: [
        {
          status: 'in_progress',
          content: '长'.repeat(32768),
          effective_at: new Date(2026, 7, 12, 9).getTime(),
          duration_days: 1
        }
      ]
    })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer)
    const sheet = workbook.getWorksheet('便签报表')

    expect(truncatedCount).toBe(1)
    expect(sheet.rowCount).toBe(2)
    expect(sheet.getRow(2).getCell(1).value).toHaveLength(32767)
  })

  it('keeps the preview order while selecting explicit note ids', () => {
    const notes = [{ id: 9 }, { id: 3 }, { id: 5 }]
    expect(selectDailyReportNotes(notes, [5, 9])).toEqual([{ id: 9 }, { id: 5 }])
    expect(() => selectDailyReportNotes(notes, [])).toThrow(/至少一条/)
  })
})
