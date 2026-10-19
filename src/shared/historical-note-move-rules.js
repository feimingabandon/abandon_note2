import {
  MAX_CALENDAR_DATE,
  MIN_CALENDAR_DATE,
  NOTE_DURATION_KINDS,
  addCalendarDays,
  localDateKey,
  localMidnightTimestamp,
  parseDateKey
} from './calendar/calendar-date-rules.js'

export const HISTORICAL_NOTE_MOVE_SCOPES = Object.freeze({ RANGE: 'range', ALL: 'all' })
export const HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE = 100
export const HISTORICAL_NOTE_MOVE_PREVIEW_MAX_CONTENT_LENGTH = 500

export function normalizeHistoricalNoteMovePreviewPage(value = {}) {
  const limit = Math.trunc(Number(value?.limit))
  const offset = Math.trunc(Number(value?.offset))
  return {
    limit: Number.isFinite(limit)
      ? Math.min(HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE, Math.max(1, limit))
      : HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE,
    offset: Number.isSafeInteger(offset) ? Math.max(0, offset) : 0
  }
}

export const normalizeHistoricalNoteMovePaging = normalizeHistoricalNoteMovePreviewPage

export function normalizeHistoricalNoteMoveIds(value) {
  if (value === undefined) return null
  if (!Array.isArray(value)) throw new Error('待移动便签列表无效')
  return [
    ...new Set(
      value.map((item) => {
        const id = Number(item)
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('待移动便签 ID 无效')
        return id
      })
    )
  ]
}

function normalizeDateKey(value, label) {
  const dateKey = String(value || '')
  parseDateKey(dateKey)
  if (dateKey < MIN_CALENDAR_DATE || dateKey > MAX_CALENDAR_DATE) {
    throw new Error(`${label}必须在 ${MIN_CALENDAR_DATE}~${MAX_CALENDAR_DATE} 之间`)
  }
  return dateKey
}

/** 历史范围以生效自然日为准；仅当天也可以有明确的生效日期和循环来源。 */
export function normalizeHistoricalNoteMoveSelection(selection = {}, currentTime = Date.now()) {
  const timestamp = Number(currentTime)
  if (
    !Number.isFinite(timestamp) ||
    timestamp <= 0 ||
    !Number.isFinite(new Date(timestamp).getTime())
  ) {
    throw new Error('当前时间无效')
  }
  const targetDateKey = localDateKey(timestamp)
  const yesterdayDateKey = addCalendarDays(targetDateKey, -1)
  const todayStart = localMidnightTimestamp(targetDateKey)
  const scope = selection?.scope
  if (!Object.values(HISTORICAL_NOTE_MOVE_SCOPES).includes(scope)) {
    throw new Error('请选择有效的移动范围')
  }
  let startDateKey = null
  let endDateKey = yesterdayDateKey
  if (scope === HISTORICAL_NOTE_MOVE_SCOPES.RANGE) {
    startDateKey = normalizeDateKey(selection.startDateKey, '开始日期')
    endDateKey = normalizeDateKey(selection.endDateKey, '结束日期')
    if (endDateKey < startDateKey) throw new Error('结束日期不能早于开始日期')
    if (endDateKey >= targetDateKey) throw new Error('只能选择今天以前的日期')
  }
  return {
    scope,
    targetDateKey,
    todayDateKey: targetDateKey,
    yesterdayDateKey,
    todayStart,
    startDateKey,
    endDateKey,
    rangeStart: startDateKey === null ? null : localMidnightTimestamp(startDateKey),
    rangeEndExclusive: localMidnightTimestamp(addCalendarDays(endDateKey, 1))
  }
}

/** 前端展示理由和主进程预览共用；最终写入仍在 SQL 中重新限定当前资格。 */
export function resolveHistoricalNoteMoveEligibility(note, targetDateKey = localDateKey()) {
  if (note?.read_only || note?.preview_kind) {
    return { canMove: false, disabledReason: '循环预览尚未生成，不能移动' }
  }
  if (!note || Number(note.is_deleted) === 1 || note.status !== 'in_progress') {
    return { canMove: false, disabledReason: '仅可移动进行中的便签' }
  }
  const effectiveAt = Number(note.effective_at)
  if (!Number.isFinite(effectiveAt) || effectiveAt <= 0) {
    return { canMove: false, disabledReason: '生效时间无效' }
  }
  if (localDateKey(effectiveAt) >= targetDateKey) {
    return { canMove: false, disabledReason: '仅可移动今天以前的便签' }
  }
  if (note.duration_kind === NOTE_DURATION_KINDS.FIXED_DAYS) {
    return { canMove: false, disabledReason: '已设置指定天数，不能移动' }
  }
  if (note.duration_kind === NOTE_DURATION_KINDS.UNTIL_COMPLETED) {
    return { canMove: false, disabledReason: '已持续显示到今天，无需移动' }
  }
  if (note.duration_kind !== NOTE_DURATION_KINDS.SINGLE_DAY) {
    return { canMove: false, disabledReason: '持续方式无效，不能移动' }
  }
  return { canMove: true, disabledReason: '' }
}
