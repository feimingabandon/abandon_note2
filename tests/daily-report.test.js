import ExcelJS from 'exceljs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryCalendarNotes: vi.fn(),
  getDb: vi.fn(),
  prepare: vi.fn(),
  readTags: vi.fn()
}))

vi.mock('../src/main/db/db-notes.js', () => ({
  queryCalendarNotes: mocks.queryCalendarNotes
}))
vi.mock('../src/main/db/db-connection.js', () => ({ getDb: mocks.getDb }))

import {
  buildDailyReportExcel,
  buildDailyReportText,
  normalizeDailyReportDate,
  normalizeDailyReportExportFormat,
  normalizeDailyReportRange,
  normalizeDailyReportStatuses,
  normalizeDailyReportTagIds,
  queryDailyReportNotes,
  selectDailyReportNotes
} from '../src/main/services/daily-report.js'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.queryCalendarNotes.mockReturnValue([])
  mocks.getDb.mockReturnValue({ prepare: mocks.prepare })
  mocks.prepare.mockReturnValue({ all: mocks.readTags })
  mocks.readTags.mockReturnValue([])
})

function taggedQueryFixture() {
  const notes = [1, 2, 3, 4].map((id) => ({
    id,
    content: `便签 ${id}`,
    status: 'in_progress',
    is_pinned: 0,
    effective_at: new Date(2026, 7, 12, 9).getTime(),
    duration_days: 1
  }))
  // Rows arrive in the database's global tag order; note 4 retains legacy multi-tags.
  const tagRows = [
    { note_id: 2, id: 22, name: '产品', color: '#0a84ff' },
    { note_id: 4, id: 22, name: '产品', color: '#0a84ff' },
    { note_id: 1, id: 11, name: '开发', color: null },
    { note_id: 4, id: 11, name: '开发', color: null }
  ]
  mocks.queryCalendarNotes.mockReturnValue(notes)
  mocks.readTags.mockImplementation((...ids) => tagRows.filter((row) => ids.includes(row.note_id)))
  return notes
}

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

  it('accepts all, multiple tags and the unclassified sentinel without the assignment limit', () => {
    expect(normalizeDailyReportTagIds()).toEqual([])
    expect(normalizeDailyReportTagIds([])).toEqual([])
    expect(normalizeDailyReportTagIds([22, -1, 11, 22])).toEqual([22, -1, 11])
  })

  it('rejects malformed tag filters before reading notes, including an empty status selection', () => {
    for (const tagIds of [
      null,
      {},
      '11',
      [0],
      [-2],
      [1.5],
      [Infinity],
      [NaN],
      [Number.MAX_SAFE_INTEGER + 1],
      ['11'],
      [true],
      [null],
      [undefined],
      new Array(1)
    ]) {
      expect(() => normalizeDailyReportTagIds(tagIds)).toThrow(/标签筛选/)
      expect(() => queryDailyReportNotes({ dateKey: '2026-08-12', statuses: [], tagIds })).toThrow(
        /标签筛选/
      )
    }
    expect(mocks.queryCalendarNotes).not.toHaveBeenCalled()
    expect(mocks.getDb).not.toHaveBeenCalled()
  })

  it('treats omitted and empty tag filters as all notes while returning tags for every summary', () => {
    taggedQueryFixture()
    const options = { dateKey: '2026-08-12' }
    const omitted = queryDailyReportNotes(options)
    expect(queryDailyReportNotes({ ...options, tagIds: [] })).toEqual(omitted)
    expect(omitted.map((note) => note.id)).toEqual([1, 2, 3, 4])
    expect(omitted[2].tags).toEqual([])
    expect(omitted[3].tags).toEqual([
      { id: 22, name: '产品', color: '#0a84ff' },
      { id: 11, name: '开发', color: null }
    ])
    expect(mocks.queryCalendarNotes).toHaveBeenCalledWith({
      hydrate: false,
      candidateFrom: expect.any(Number),
      visibleStart: new Date(2026, 7, 12).getTime(),
      visibleEndExclusive: new Date(2026, 7, 13).getTime()
    })
    expect(mocks.prepare.mock.calls[0][0]).toMatch(/ORDER BY t\.sort_order ASC, t\.id ASC/)
  })

  it('matches selected tags by OR, includes unclassified explicitly and keeps all legacy tag names', () => {
    taggedQueryFixture()
    const query = (tagIds) => queryDailyReportNotes({ dateKey: '2026-08-12', tagIds })
    const selected = query([11])
    expect(selected.map((note) => note.id)).toEqual([1, 4])
    expect(selected[1].tags.map((tag) => tag.name)).toEqual(['产品', '开发'])
    expect(query([11, 22, 11]).map((note) => note.id)).toEqual([1, 2, 4])
    expect(query([-1]).map((note) => note.id)).toEqual([3])
    expect(query([22, -1]).map((note) => note.id)).toEqual([2, 3, 4])
    expect(query([999])).toEqual([])
  })

  it('reads tags only for notes matching both the date range and status filter', () => {
    const notes = taggedQueryFixture()
    mocks.queryCalendarNotes.mockReturnValue([
      notes[0],
      { ...notes[1], status: 'completed', finished_at: notes[1].effective_at },
      { ...notes[2], effective_at: new Date(2026, 7, 11, 9).getTime() }
    ])
    expect(
      queryDailyReportNotes({ dateKey: '2026-08-12', statuses: ['in_progress'] }).map(
        (note) => note.id
      )
    ).toEqual([1])
    expect(mocks.readTags).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('avoids tag reads for an empty report and reads large reports in bounded batches', () => {
    expect(queryDailyReportNotes({ dateKey: '2026-08-12' })).toEqual([])
    expect(mocks.getDb).not.toHaveBeenCalled()
    const notes = Array.from({ length: 1001 }, (_, index) => ({
      id: index + 1,
      content: `批量 ${index}`,
      status: 'in_progress',
      is_pinned: 0,
      effective_at: new Date(2026, 7, 12, 9).getTime(),
      duration_days: 1
    }))
    mocks.queryCalendarNotes.mockReturnValue(notes)
    mocks.readTags.mockImplementation((...ids) =>
      ids.map((note_id) => ({ note_id, id: 11, name: '开发', color: null }))
    )
    const result = queryDailyReportNotes({ dateKey: '2026-08-12', tagIds: [11] })
    expect(result).toHaveLength(1001)
    expect(result[1000].tags).toEqual([{ id: 11, name: '开发', color: null }])
    expect(mocks.getDb).toHaveBeenCalledTimes(1)
    expect(mocks.prepare).toHaveBeenCalledTimes(3)
    expect(mocks.readTags.mock.calls.map((ids) => ids.length)).toEqual([500, 500, 1])
  })

  it('exports tag fields in plain text without note totals', () => {
    const text = buildDailyReportText({
      startDateKey: '2026-08-12',
      endDateKey: '2026-08-14',
      notes: [
        {
          id: 1,
          status: 'in_progress',
          content: '调整月视图交互动效',
          effective_at: new Date(2026, 7, 12, 9, 15).getTime(),
          tags: [{ name: '开发' }, { name: '重要' }]
        },
        {
          id: 2,
          status: 'completed',
          content: '完成日报导出功能设计',
          finished_at: new Date(2026, 7, 12, 10, 32).getTime(),
          tags: [{ name: '产品' }]
        },
        {
          id: 3,
          status: 'in_progress',
          content: '没有标签的便签',
          effective_at: new Date(2026, 7, 12, 11).getTime(),
          tags: []
        }
      ]
    })

    expect(text).toContain('便签报表 2026年8月12日 至 2026年8月14日')
    expect(text).toContain('【进行中】')
    expect(text).toContain('生效时间：2026-08-12 09:15')
    expect(text).toContain('【已完成】')
    expect(text).toContain('完成时间：2026-08-12 10:32')
    expect(text).not.toMatch(/共 \d+ 条/)
    expect(text).toContain('1. 调整月视图交互动效\n   标签：开发、重要\n   生效时间：')
    expect(text).toContain('标签：产品')
    expect(text).toContain('标签：未分类')
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
          duration_days: 3,
          tags: [
            { id: 1, name: '=保持标签为纯文本', color: null },
            { id: 2, name: '开发', color: null }
          ]
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
      '标签',
      '当前状态',
      '是否完成',
      '生效时间',
      '结束日期',
      '持续天数',
      '完成时间',
      '是否置顶'
    ])
    expect(sheet.getRow(2).getCell(1).value).toBe('=保持为纯文本')
    expect(sheet.getRow(2).getCell(2).value).toBe('=保持标签为纯文本、开发')
    expect(sheet.getRow(2).getCell(2).type).toBe(ExcelJS.ValueType.String)
    expect(sheet.getRow(2).getCell(2).alignment.wrapText).toBe(true)
    expect(sheet.getRow(2).getCell(3).value).toBe('进行中')
    expect(sheet.getRow(2).getCell(4).value).toBe('否')
    expect(sheet.getRow(2).getCell(6).value).toBeInstanceOf(Date)
    expect(sheet.getRow(2).getCell(7).value).toBe(3)
    expect(sheet.getRow(2).getCell(9).value).toBe('是')
    expect(sheet.getRow(3).getCell(2).value).toBe('未分类')
    expect(sheet.getRow(3).getCell(4).value).toBe('是')
    expect(sheet.getRow(3).getCell(8).value).toBeInstanceOf(Date)
    expect(sheet.autoFilter).toBe('A1:I1')
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
