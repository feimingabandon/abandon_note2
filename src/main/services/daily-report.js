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

/** 查询在所选自然日内有效的便签；持续多日的便签只要覆盖该日就会命中。 */
export function queryDailyReportNotes({ dateKey, statuses = DAILY_REPORT_STATUSES } = {}) {
  const normalizedDate = normalizeDailyReportDate(dateKey)
  const normalizedStatuses = normalizeDailyReportStatuses(statuses)
  if (normalizedStatuses.length === 0) return []

  const targetOrdinal = dateOrdinal(normalizedDate)
  const candidates = queryCalendarNotes({
    candidateFrom: localMidnightTimestamp(addCalendarDays(normalizedDate, -364)),
    visibleEndExclusive: localMidnightTimestamp(addCalendarDays(normalizedDate, 1))
  })
  const allowedStatuses = new Set(normalizedStatuses)

  return candidates
    .filter((note) => {
      if (!allowedStatuses.has(note.status)) return false
      const range = noteDateRange(note)
      return range.startOrdinal <= targetOrdinal && range.endOrdinal >= targetOrdinal
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
export function buildDailyReportText({ dateKey, notes } = {}) {
  const normalizedDate = normalizeDailyReportDate(dateKey)
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

  return [`日报 ${formatReportDate(normalizedDate)}`, ...sections].join('\n\n') + '\n'
}

export function selectDailyReportNotes(notes, noteIds) {
  if (!Array.isArray(noteIds)) throw new Error('请选择要导出的便签')
  const selectedIds = new Set(noteIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))
  const selectedNotes = notes.filter((note) => selectedIds.has(Number(note.id)))
  if (selectedNotes.length === 0) throw new Error('请选择至少一条便签')
  return selectedNotes
}
