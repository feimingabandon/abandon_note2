import ExcelJS from 'exceljs'
import {
  addCalendarDays,
  assertCalendarYearMonth,
  dateOrdinal,
  localMidnightTimestamp,
  noteDateRange,
  parseDateKey
} from '../../shared/calendar/calendar-date-rules.js'
import { queryCalendarNotes } from '../db/db-notes.js'

export const DAILY_REPORT_STATUSES = ['initialized', 'in_progress', 'completed']
export const DAILY_REPORT_MAX_RANGE_DAYS = 366
export const DAILY_REPORT_EXPORT_FORMATS = ['txt', 'xlsx']

export const DAILY_REPORT_STATUS_LABELS = Object.freeze({
  initialized: '初始化',
  in_progress: '进行中',
  completed: '已完成'
})

const STATUS_ORDER = new Map(DAILY_REPORT_STATUSES.map((status, index) => [status, index]))

export function normalizeDailyReportDate(dateKey) {
  const { year, month } = parseDateKey(dateKey)
  assertCalendarYearMonth(year, month)
  return String(dateKey)
}

export function normalizeDailyReportRange({ dateKey, startDateKey, endDateKey } = {}) {
  const normalizedStart = normalizeDailyReportDate(startDateKey ?? dateKey)
  const normalizedEnd = normalizeDailyReportDate(endDateKey ?? startDateKey ?? dateKey)
  const startOrdinal = dateOrdinal(normalizedStart)
  const endOrdinal = dateOrdinal(normalizedEnd)
  if (endOrdinal < startOrdinal) throw new Error('结束日期不能早于开始日期')
  const dayCount = endOrdinal - startOrdinal + 1
  if (dayCount > DAILY_REPORT_MAX_RANGE_DAYS) {
    throw new Error(`单次导出范围不能超过 ${DAILY_REPORT_MAX_RANGE_DAYS} 天`)
  }
  return {
    startDateKey: normalizedStart,
    endDateKey: normalizedEnd,
    startOrdinal,
    endOrdinal,
    dayCount
  }
}

export function normalizeDailyReportExportFormat(format = 'txt') {
  const normalized = String(format).toLowerCase()
  if (!DAILY_REPORT_EXPORT_FORMATS.includes(normalized)) throw new Error('报表导出格式无效')
  return normalized
}

export function normalizeDailyReportStatuses(statuses = DAILY_REPORT_STATUSES) {
  if (!Array.isArray(statuses)) throw new Error('日报状态筛选必须是数组')
  const normalized = [...new Set(statuses.map((status) => String(status)))]
  if (normalized.some((status) => !STATUS_ORDER.has(status))) throw new Error('日报状态筛选无效')
  return DAILY_REPORT_STATUSES.filter((status) => normalized.includes(status))
}

function dailyReportNoteSummary(note) {
  return {
    id: note.id,
    content: note.content,
    status: note.status,
    is_pinned: note.is_pinned,
    effective_at: note.effective_at,
    duration_days: note.duration_days,
    finished_at: note.finished_at
  }
}

/** 查询与所选自然日范围相交的便签；持续多日的便签只返回一次。 */
export function queryDailyReportNotes({
  dateKey,
  startDateKey,
  endDateKey,
  statuses = DAILY_REPORT_STATUSES
} = {}) {
  const range = normalizeDailyReportRange({ dateKey, startDateKey, endDateKey })
  const normalizedStatuses = normalizeDailyReportStatuses(statuses)
  if (normalizedStatuses.length === 0) return []

  const candidates = queryCalendarNotes({
    hydrate: false,
    candidateFrom: localMidnightTimestamp(addCalendarDays(range.startDateKey, -364)),
    visibleEndExclusive: localMidnightTimestamp(addCalendarDays(range.endDateKey, 1))
  })
  const allowedStatuses = new Set(normalizedStatuses)

  return candidates
    .filter((note) => {
      if (!allowedStatuses.has(note.status)) return false
      const noteRange = noteDateRange(note)
      return (
        noteRange.startOrdinal <= range.endOrdinal && noteRange.endOrdinal >= range.startOrdinal
      )
    })
    .sort((first, second) => {
      const statusDifference = STATUS_ORDER.get(first.status) - STATUS_ORDER.get(second.status)
      if (statusDifference) return statusDifference
      if (first.is_pinned !== second.is_pinned) return second.is_pinned - first.is_pinned
      if (first.effective_at !== second.effective_at)
        return first.effective_at - second.effective_at
      return first.id - second.id
    })
    .map(dailyReportNoteSummary)
}

function formatReportDate(dateKey) {
  const { year, month, day } = parseDateKey(dateKey)
  return `${year}年${month}月${day}日`
}

function formatReportRange(range) {
  if (range.startDateKey === range.endDateKey) return formatReportDate(range.startDateKey)
  return `${formatReportDate(range.startDateKey)} 至 ${formatReportDate(range.endDateKey)}`
}

function formatReportDateTime(timestamp) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未记录'
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatReportNoteContent(content, index) {
  const lines = String(content ?? '')
    .trim()
    .split(/\r?\n/)
  const [firstLine = '', ...rest] = lines
  return [`${index + 1}. ${firstLine}`, ...rest.map((line) => `   ${line}`)].join('\n')
}

/** 生成适合记事本阅读的纯文本，不写入标签或便签数量。 */
export function buildDailyReportText({ dateKey, startDateKey, endDateKey, notes } = {}) {
  const range = normalizeDailyReportRange({ dateKey, startDateKey, endDateKey })
  const items = Array.isArray(notes) ? notes : []
  const sections = DAILY_REPORT_STATUSES.flatMap((status) => {
    const statusNotes = items.filter((note) => note.status === status)
    if (statusNotes.length === 0) return []
    const body = statusNotes
      .map((note, index) => {
        const timestamp = status === 'completed' ? note.finished_at : note.effective_at
        const timeLabel = status === 'completed' ? '完成时间' : '生效时间'
        return `${formatReportNoteContent(note.content, index)}\n   ${timeLabel}：${formatReportDateTime(timestamp)}`
      })
      .join('\n\n')
    return [`【${DAILY_REPORT_STATUS_LABELS[status]}】\n${body}`]
  })

  return [`便签报表 ${formatReportRange(range)}`, ...sections].join('\n\n') + '\n'
}

const EXCEL_CELL_MAX_CHARACTERS = 32767

function normalizeExcelContent(content) {
  const value = String(content ?? '')
  if (value.length <= EXCEL_CELL_MAX_CHARACTERS) return { value, truncated: false }
  return {
    value: value.slice(0, EXCEL_CELL_MAX_CHARACTERS - 1) + '…',
    truncated: true
  }
}

function excelDateValue(timestamp) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function excelDateKeyValue(dateKey) {
  const { year, month, day } = parseDateKey(dateKey)
  return new Date(year, month - 1, day)
}

/** 生成标准 XLSX 工作簿；每条便签固定占一行。 */
export async function buildDailyReportExcel({ dateKey, startDateKey, endDateKey, notes } = {}) {
  const range = normalizeDailyReportRange({ dateKey, startDateKey, endDateKey })
  const items = Array.isArray(notes) ? notes : []
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Abandon Note'
  workbook.subject = `便签报表 ${formatReportRange(range)}`
  const sheet = workbook.addWorksheet('便签报表', {
    views: [{ state: 'frozen', ySplit: 1 }]
  })
  sheet.columns = [
    { header: '便签内容', key: 'content', width: 52 },
    { header: '当前状态', key: 'status', width: 12 },
    { header: '是否完成', key: 'completed', width: 12 },
    { header: '生效时间', key: 'effectiveAt', width: 20 },
    { header: '结束日期', key: 'endDate', width: 14 },
    { header: '持续天数', key: 'durationDays', width: 12 },
    { header: '完成时间', key: 'finishedAt', width: 20 },
    { header: '是否置顶', key: 'pinned', width: 12 }
  ]
  sheet.autoFilter = 'A1:H1'
  sheet.getColumn('effectiveAt').numFmt = 'yyyy-mm-dd hh:mm'
  sheet.getColumn('endDate').numFmt = 'yyyy-mm-dd'
  sheet.getColumn('finishedAt').numFmt = 'yyyy-mm-dd hh:mm'

  let truncatedCount = 0
  for (const note of items) {
    const content = normalizeExcelContent(note.content)
    if (content.truncated) truncatedCount += 1
    const noteRange = noteDateRange(note)
    const row = sheet.addRow({
      content: content.value,
      status: DAILY_REPORT_STATUS_LABELS[note.status] || String(note.status ?? ''),
      completed: note.status === 'completed' ? '是' : '否',
      effectiveAt: excelDateValue(note.effective_at),
      endDate: excelDateKeyValue(noteRange.endKey),
      durationDays: noteRange.durationDays,
      finishedAt: note.status === 'completed' ? excelDateValue(note.finished_at) : null,
      pinned: Number(note.is_pinned) === 1 ? '是' : '否'
    })
    row.alignment = { vertical: 'top' }
    row.getCell('content').alignment = { vertical: 'top', wrapText: true }
  }

  const header = sheet.getRow(1)
  header.height = 24
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A84FF' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return { buffer: Buffer.from(buffer), truncatedCount }
}

export function selectDailyReportNotes(notes, noteIds) {
  if (!Array.isArray(noteIds)) throw new Error('请选择要导出的便签')
  const selectedIds = new Set(noteIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))
  const selectedNotes = notes.filter((note) => selectedIds.has(Number(note.id)))
  if (selectedNotes.length === 0) throw new Error('请选择至少一条便签')
  return selectedNotes
}
