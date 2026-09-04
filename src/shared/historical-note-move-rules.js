import {
  MAX_CALENDAR_DATE,
  MIN_CALENDAR_DATE,
  addCalendarDays,
  localDateKey,
  localMidnightTimestamp,
  parseDateKey
} from './calendar/calendar-date-rules.js'

export const HISTORICAL_NOTE_MOVE_SCOPES = Object.freeze({
  RANGE: 'range',
  ALL: 'all'
})

export const HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE = 100
export const HISTORICAL_NOTE_MOVE_PREVIEW_MAX_CONTENT_LENGTH = 500

export function normalizeHistoricalNoteMovePreviewPage(value = {}) {
  const parsedLimit = Math.trunc(Number(value?.limit))
  const parsedOffset = Math.trunc(Number(value?.offset))
  return {
    limit: Number.isFinite(parsedLimit)
      ? Math.min(HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE, Math.max(1, parsedLimit))
      : HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE,
    offset: Number.isSafeInteger(parsedOffset) ? Math.max(0, parsedOffset) : 0
  }
}

/**
 * 未传 noteIds 时保留原有的整批移动语义；显式传入数组时只接受去重后的正整数 ID。
 */
export function normalizeHistoricalNoteMoveIds(value) {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error('待移动便签列表无效')
  const ids = []
  const seen = new Set()
  for (const valueItem of value) {
    const id = Number(valueItem)
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('待移动便签 ID 无效')
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function normalizeCurrentTime(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('当前时间无效')
  return timestamp
}

function normalizeHistoricalDateKey(value, fieldLabel) {
  const dateKey = String(value || '')
  parseDateKey(dateKey)
  if (dateKey < MIN_CALENDAR_DATE || dateKey > MAX_CALENDAR_DATE) {
    throw new Error(`${fieldLabel}必须在 ${MIN_CALENDAR_DATE}~${MAX_CALENDAR_DATE} 之间`)
  }
  return dateKey
}

/**
 * 将 renderer 提交的快捷范围或自定义范围收敛成主进程可直接查询的本地时间边界。
 * “历史”只按便签 effective_at 所属自然日判断，不读取 created_at。
 */
export function normalizeHistoricalNoteMoveSelection(selection = {}, currentTime = Date.now()) {
  const timestamp = normalizeCurrentTime(currentTime)
  const todayDateKey = localDateKey(timestamp)
  const yesterdayDateKey = addCalendarDays(todayDateKey, -1)
  const todayStart = localMidnightTimestamp(todayDateKey)
  const scope = selection?.scope === HISTORICAL_NOTE_MOVE_SCOPES.ALL ? 'all' : 'range'

  if (scope === HISTORICAL_NOTE_MOVE_SCOPES.ALL) {
    return {
      scope,
      todayDateKey,
      yesterdayDateKey,
      todayStart,
      rangeStart: null,
      rangeEndExclusive: todayStart,
      startDateKey: null,
      endDateKey: yesterdayDateKey
    }
  }

  const startDateKey = normalizeHistoricalDateKey(selection?.startDateKey, '开始日期')
  const endDateKey = normalizeHistoricalDateKey(selection?.endDateKey, '结束日期')
  if (endDateKey < startDateKey) throw new Error('结束日期不能早于开始日期')
  if (endDateKey >= todayDateKey) throw new Error('只能选择今天以前的日期')

  return {
    scope,
    todayDateKey,
    yesterdayDateKey,
    todayStart,
    rangeStart: localMidnightTimestamp(startDateKey),
    rangeEndExclusive: localMidnightTimestamp(addCalendarDays(endDateKey, 1)),
    startDateKey,
    endDateKey
  }
}
