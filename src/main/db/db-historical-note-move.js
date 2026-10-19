import { getDb } from './db-connection.js'
import {
  HISTORICAL_NOTE_MOVE_PREVIEW_MAX_CONTENT_LENGTH,
  normalizeHistoricalNoteMoveIds,
  normalizeHistoricalNoteMovePreviewPage,
  normalizeHistoricalNoteMoveSelection,
  resolveHistoricalNoteMoveEligibility
} from '../../shared/historical-note-move-rules.js'
import { localDateKey } from '../../shared/calendar/calendar-date-rules.js'

function buildCandidateWhere(range) {
  const clauses = ["status = 'in_progress'", 'is_deleted = 0', 'effective_at < ?']
  const params = [range.rangeEndExclusive]
  if (range.rangeStart !== null) {
    clauses.push('effective_at >= ?')
    params.push(range.rangeStart)
  }
  return { clauses, params }
}

function rangeMetadata(range) {
  return {
    scope: range.scope,
    targetDateKey: range.targetDateKey,
    startDateKey: range.startDateKey,
    endDateKey: range.endDateKey
  }
}

/** 包含所有历史进行中便签，禁用项保留持续方式与原因供用户核对。 */
export function previewHistoricalNotesToToday(selection = {}, { now = Date.now() } = {}) {
  const range = normalizeHistoricalNoteMoveSelection(selection, now)
  const page = normalizeHistoricalNoteMovePreviewPage(selection)
  const db = getDb()
  return db.transaction(() => {
    const { clauses, params } = buildCandidateWhere(range)
    const where = clauses.join(' AND ')
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS count,
         COALESCE(SUM(CASE WHEN duration_kind = 'single_day' THEN 1 ELSE 0 END), 0) AS movableCount
       FROM notes WHERE ${where}`
      )
      .get(...params)
    const notes = db
      .prepare(
        `SELECT id, substr(content, 1, ?) AS content, status, effective_at, duration_kind, duration_days
       FROM notes WHERE ${where}
       ORDER BY effective_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(HISTORICAL_NOTE_MOVE_PREVIEW_MAX_CONTENT_LENGTH, ...params, page.limit, page.offset)
      .map((note) => ({
        id: note.id,
        content: note.content,
        dateKey: localDateKey(note.effective_at),
        durationKind: note.duration_kind,
        durationDays: note.duration_days,
        ...resolveHistoricalNoteMoveEligibility(note, range.targetDateKey)
      }))
    return {
      ...counts,
      disabledCount: counts.count - counts.movableCount,
      notes,
      hasMore: page.offset + notes.length < counts.count,
      ...page,
      ...rangeMetadata(range)
    }
  })()
}

/**
 * 原记录改为提交时生效；创建/完成时间、内容、关系和既有提醒全部保留。
 * 第二参数仅供可信主进程调度器和隔离测试使用，IPC 不接受 renderer 的绕过选项。
 */
export function moveHistoricalNotesToToday(
  selection = {},
  { now = Date.now(), validateTargetDate = true } = {}
) {
  const range = normalizeHistoricalNoteMoveSelection(selection, now)
  if (validateTargetDate && selection.targetDateKey !== range.targetDateKey) {
    throw new Error('日期已变化，请重新预览后再移动到今天')
  }
  const noteIds = normalizeHistoricalNoteMoveIds(selection.noteIds)
  const excludedNoteIds = normalizeHistoricalNoteMoveIds(selection.excludedNoteIds)
  if (noteIds !== null && excludedNoteIds !== null) {
    throw new Error('不能同时指定选中和排除的便签')
  }
  if (noteIds === null && excludedNoteIds === null) throw new Error('请选择要移动的便签')
  const timestamp = Number(now)
  const db = getDb()
  return db.transaction(() => {
    const { clauses, params } = buildCandidateWhere(range)
    clauses.push("duration_kind = 'single_day'")
    // JSON1 将任意页数的 ID 压成一个绑定参数，避免 SQLite 的占位符数量上限。
    if (noteIds !== null) {
      clauses.push('id IN (SELECT value FROM json_each(?))')
      params.push(JSON.stringify(noteIds))
    } else if (excludedNoteIds.length) {
      clauses.push('id NOT IN (SELECT value FROM json_each(?))')
      params.push(JSON.stringify(excludedNoteIds))
    }
    const count = db
      .prepare(`UPDATE notes SET effective_at = ?, updated_at = ? WHERE ${clauses.join(' AND ')}`)
      .run(timestamp, timestamp, ...params).changes
    return { count, movedAt: timestamp, ...rangeMetadata(range) }
  })()
}
