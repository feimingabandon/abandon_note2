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
import { getDb } from '../db/db-connection.js'

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

/** 报表筛选可多选；-1 是未分类筛选项，不是可写入关联表的标签 ID。 */
export function normalizeDailyReportTagIds(tagIds = []) {
  if (!Array.isArray(tagIds)) throw new Error('日报标签筛选必须是数组')
  const normalized = [...new Set(tagIds)]
  if (normalized.some((id) => !Number.isSafeInteger(id) || (id <= 0 && id !== -1))) {
    throw new Error('日报标签筛选包含无效标签 ID')
  }
  return normalized
}

function withDailyReportTags(notes) {
  if (notes.length === 0) return []
  const db = getDb()
  const ids = [...new Set(notes.map((note) => note.id))]
  const tagsByNote = new Map()
  // 日历原始查询不附带关系。只批量读取报表需要的标签，避免逐条查询或额外读取附件、提醒。
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500)
    const tags = db
      .prepare(
        `SELECT nt.note_id, t.id, t.name, t.color FROM note_tags nt
         INNER JOIN tags t ON t.id = nt.tag_id
         WHERE nt.note_id IN (${batch.map(() => '?').join(',')})
         ORDER BY t.sort_order ASC, t.id ASC`
      )
      .all(...batch)
    for (const { note_id, id, name, color } of tags) {
      if (!tagsByNote.has(note_id)) tagsByNote.set(note_id, [])
      tagsByNote.get(note_id).push({ id, name, color })
    }
  }
  return notes.map((note) => ({ ...note, tags: tagsByNote.get(note.id) || [] }))
}

function dailyReportNoteSummary(note) {
  const range = noteDateRange(note)
  return {
    id: note.id,
    content: note.content,
    status: note.status,
    is_pinned: note.is_pinned,
    effective_at: note.effective_at,
    duration_days: note.duration_days,
    duration_kind: note.duration_kind,
    calendar_duration_days: range.durationDays,
    finished_at: note.finished_at,
    tags: note.tags
  }
}

/** 查询与所选自然日范围相交的便签；持续多日的便签只返回一次。 */
export function queryDailyReportNotes({
  dateKey,
  startDateKey,
  endDateKey,
  statuses = DAILY_REPORT_STATUSES,
  tagIds = []
} = {}) {
  const range = normalizeDailyReportRange({ dateKey, startDateKey, endDateKey })
  const normalizedStatuses = normalizeDailyReportStatuses(statuses)
  const selectedTagIds = new Set(normalizeDailyReportTagIds(tagIds))
  if (normalizedStatuses.length === 0) return []

  const candidates = queryCalendarNotes({
    hydrate: false,
    candidateFrom: localMidnightTimestamp(addCalendarDays(range.startDateKey, -364)),
    visibleStart: localMidnightTimestamp(range.startDateKey),
    visibleEndExclusive: localMidnightTimestamp(addCalendarDays(range.endDateKey, 1))
  })
  const allowedStatuses = new Set(normalizedStatuses)

  const matching = candidates.filter((note) => {
    if (!allowedStatuses.has(note.status)) return false
    const noteRange = noteDateRange(note)
    return noteRange.startOrdinal <= range.endOrdinal && noteRange.endOrdinal >= range.startOrdinal
  })

  return withDailyReportTags(matching)
    .filter(
      (note) =>
        selectedTagIds.size === 0 ||
        (note.tags.length === 0 && selectedTagIds.has(-1)) ||
        note.tags.some((tag) => selectedTagIds.has(tag.id))
    )
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

function formatReportNoteTags(note) {
  const names = (Array.isArray(note.tags) ? note.tags : [])
    .map((tag) => String(tag?.name ?? '').trim())
    .filter(Boolean)
  return names.length ? names.join('、') : '未分类'
}

/** 生成适合记事本阅读的纯文本，不写入便签数量。 */
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
        return `${formatReportNoteContent(note.content, index)}\n   标签：${formatReportNoteTags(note)}\n   ${timeLabel}：${formatReportDateTime(timestamp)}`
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
  if (Number.isNaN(date.getTime())) return null
  // Excel dates store floating calendar fields. This UTC carrier preserves the
  // timestamp's local clock fields when ExcelJS serializes its epoch value.
  const carrier = new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      date.getMilliseconds()
    )
  )
  return Number.isNaN(carrier.getTime()) ? null : carrier
}

function excelDateKeyValue(dateKey) {
  const { year, month, day } = parseDateKey(dateKey)
  // A natural date has no local-midnight instant or timezone offset to convert.
  const utc = Date.UTC(year, month - 1, day)
  // ExcelJS applies the offset after Excel's fictitious 1900-02-29 to every
  // epoch. Before March, the carrier must be one UTC day earlier so Excel's
  // serial still displays the requested natural date; this is not its instant.
  return new Date(utc - (year === 1900 && month < 3 ? 86_400_000 : 0))
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
    { header: '标签', key: 'tags', width: 22 },
    { header: '当前状态', key: 'status', width: 12 },
    { header: '是否完成', key: 'completed', width: 12 },
    { header: '生效时间', key: 'effectiveAt', width: 20 },
    { header: '结束日期', key: 'endDate', width: 14 },
    { header: '持续天数', key: 'durationDays', width: 12 },
    { header: '完成时间', key: 'finishedAt', width: 20 },
    { header: '是否置顶', key: 'pinned', width: 12 }
  ]
  sheet.autoFilter = 'A1:I1'
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
      tags: formatReportNoteTags(note),
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
    row.getCell('tags').alignment = { vertical: 'top', wrapText: true }
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
