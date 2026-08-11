/**
 * db-notes.js — 便签实例、三状态流转与列表摘要查询
 *
 * 状态模型：initialized → in_progress ⇄ completed
 */
import { getDb } from './db-connection.js'
import { normalizeAssignedTagIds } from '../../shared/tag-rules.js'

const now = () => Date.now()
export const MIN_NOTE_DURATION_DAYS = 1
export const MAX_NOTE_DURATION_DAYS = 365
const TRANSITIONS = {
  initialized: new Set(['in_progress']),
  in_progress: new Set(['completed']),
  completed: new Set(['in_progress'])
}

/** 保留正文原样，仅拒绝全空白内容。 */
export function normalizeRequiredNoteContent(value) {
  const content = String(value ?? '')
  if (!content.trim()) throw new Error('请输入便签内容')
  return content
}

export function normalizeNoteDurationDays(value = MIN_NOTE_DURATION_DAYS) {
  const durationDays = Number(value)
  if (
    !Number.isInteger(durationDays) ||
    durationDays < MIN_NOTE_DURATION_DAYS ||
    durationDays > MAX_NOTE_DURATION_DAYS
  ) {
    throw new Error(`持续天数必须是 ${MIN_NOTE_DURATION_DAYS}~${MAX_NOTE_DURATION_DAYS} 之间的整数`)
  }
  return durationDays
}

// ============================================================
// CRUD
// ============================================================

/**
 * 创建便签。
 * 只有未来生效的便签进入 initialized，且仅此状态可以保留待触发提醒。
 * finished_at 按当前产品语义记录最近一次状态写入时间，创建时同步初始化。
 */
export function createNote({
  content = '',
  effectiveAt = null,
  durationDays = MIN_NOTE_DURATION_DAYS,
  noteType = 'one_time',
  notifyEnabled = 0,
  isPinned = 0,
  sortOrder = 0
} = {}) {
  const ts = now()
  const normalizedContent = normalizeRequiredNoteContent(content)
  const normalizedDurationDays = normalizeNoteDurationDays(durationDays)
  const parsedEffectiveAt = Number(effectiveAt)
  const hasExplicitTime = Number.isFinite(parsedEffectiveAt) && parsedEffectiveAt > 0
  const effAt = hasExplicitTime ? parsedEffectiveAt : ts
  const hasFutureEffectiveTime = effAt > ts
  const status = hasFutureEffectiveTime ? 'initialized' : 'in_progress'
  const pendingNotification = status === 'initialized' && notifyEnabled ? 1 : 0

  const result = getDb()
    .prepare(
      `INSERT INTO notes (
         note_type, content, status, is_pinned, notify_enabled,
         effective_at, duration_days, finished_at, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      noteType,
      normalizedContent,
      status,
      isPinned ? 1 : 0,
      pendingNotification,
      effAt,
      normalizedDurationDays,
      ts,
      sortOrder,
      ts,
      ts
    )

  return getNoteById(result.lastInsertRowid)
}

/**
 * 创建循环模板的一次性快照实例。
 * 生成实例固定为进行中、关闭便签自身提醒，并在当前事务中复制标签关联。
 */
export function createRecurringNoteSnapshot({
  content = '',
  effectiveAt,
  isPinned = 0,
  tagIds = []
} = {}) {
  const db = getDb()
  // 循环任务可能读取到旧版本留下的多标签模板；生成新便签时稳定继承第一项。
  const normalizedTagIds = normalizeAssignedTagIds(tagIds).slice(0, 1)
  const ts = now()
  const scheduledAt = Number(effectiveAt)
  if (!Number.isFinite(scheduledAt) || scheduledAt <= 0) {
    throw new Error('循环便签缺少有效的计划时间')
  }

  const result = db
    .prepare(
      `INSERT INTO notes (
         note_type, content, status, is_pinned, notify_enabled,
         effective_at, finished_at, sort_order, created_at, updated_at
       ) VALUES ('one_time', ?, 'in_progress', ?, 0, ?, ?, 0, ?, ?)`
    )
    .run(content, isPinned ? 1 : 0, scheduledAt, ts, ts, ts)

  const noteId = Number(result.lastInsertRowid)
  const insertTag = db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)')
  for (const tagId of normalizedTagIds) insertTag.run(noteId, tagId)

  return getNoteById(noteId)
}

/**
 * 更新普通可编辑字段。状态、生效时间、状态变更时间和提醒状态必须走专用业务操作。
 */
export function updateNote(id, fields = {}) {
  const old = getNoteById(id)
  if (!old) return null

  const ts = now()
  const content =
    fields.content === undefined ? old.content : normalizeRequiredNoteContent(fields.content)
  const durationDays =
    fields.durationDays === undefined && fields.duration_days === undefined
      ? old.duration_days
      : normalizeNoteDurationDays(fields.durationDays ?? fields.duration_days)
  getDb()
    .prepare(
      `UPDATE notes SET
         content = ?, is_pinned = ?, duration_days = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      content,
      fields.is_pinned ?? old.is_pinned,
      durationDays,
      fields.sort_order ?? old.sort_order,
      ts,
      id
    )

  return getNoteById(id)
}

export function getNoteById(id) {
  const note = getDb().prepare('SELECT * FROM notes WHERE id = ? AND is_deleted = 0').get(id)
  if (!note) return null

  note.attachments = getDb()
    .prepare('SELECT * FROM note_attachments WHERE note_id = ? ORDER BY sort_order')
    .all(id)
  note.tags = getDb()
    .prepare(
      `SELECT t.* FROM tags t
       INNER JOIN note_tags nt ON nt.tag_id = t.id
       WHERE nt.note_id = ?
       ORDER BY nt.rowid ASC`
    )
    .all(id)
  note.attachment_count = note.attachments.length
  note.has_text = Boolean(note.content?.trim())
  note.has_image = note.attachment_count > 0

  return note
}

/** 逻辑删除：保留便签、标签关联和附件文件，物理清理由“清空便签数据”统一执行。 */
export function deleteNote(id) {
  const ts = now()
  const result = getDb()
    .prepare(
      `UPDATE notes
       SET is_deleted = 1, notify_enabled = 0, updated_at = ?
       WHERE id = ? AND is_deleted = 0`
    )
    .run(ts, id)
  return result.changes === 1
}

/** 所有未删除便签总数，不受当前列表筛选条件影响。 */
export function countActiveNotes() {
  return getDb().prepare('SELECT COUNT(*) AS total FROM notes WHERE is_deleted = 0').get().total
}

// ============================================================
// 状态流转
// ============================================================

function transitionNote(id, targetStatus, { setEffectiveAtToNow = false } = {}) {
  const db = getDb()
  const current = db.prepare('SELECT status FROM notes WHERE id = ? AND is_deleted = 0').get(id)
  if (!current) return null

  if (!TRANSITIONS[current.status]?.has(targetStatus)) {
    console.warn(`[db-notes] 非法状态流转: ${current.status} → ${targetStatus} (note_id=${id})`)
    return null
  }

  const ts = now()
  const result = setEffectiveAtToNow
    ? db
        .prepare(
          `UPDATE notes
         SET status = ?, effective_at = ?, notify_enabled = 0,
             finished_at = ?, updated_at = ?
         WHERE id = ? AND status = ? AND is_deleted = 0`
        )
        .run(targetStatus, ts, ts, ts, id, current.status)
    : db
        .prepare(
          `UPDATE notes
         SET status = ?, notify_enabled = 0,
             finished_at = ?, updated_at = ?
         WHERE id = ? AND status = ? AND is_deleted = 0`
        )
        .run(targetStatus, ts, ts, id, current.status)

  return result.changes === 1 ? getNoteById(id) : null
}

/** initialized → in_progress：手动提前开始时，实际生效时间同步为当前时间。 */
export function startProgress(id) {
  return transitionNote(id, 'in_progress', { setEffectiveAtToNow: true })
}

/** in_progress → completed。 */
export function completeNote(id) {
  return transitionNote(id, 'completed')
}

/** completed → in_progress：恢复原任务，保留原生效时间与持续区间。 */
export function reopenNote(id) {
  return transitionNote(id, 'in_progress')
}

/**
 * 批量激活到期便签。
 * 查询、状态切换、提醒清零与 updated_at 更新位于同一个事务。
 */
export function activateNotes() {
  const db = getDb()
  const ts = now()

  return db.transaction(() => {
    const due = db
      .prepare(
        `SELECT id, content, notify_enabled
         FROM notes
         WHERE status = 'initialized' AND is_deleted = 0 AND effective_at <= ?`
      )
      .all(ts)

    if (due.length === 0) return { count: 0, notified: [] }

    const result = db
      .prepare(
        `UPDATE notes
         SET status = 'in_progress', notify_enabled = 0,
             finished_at = ?, updated_at = ?
         WHERE status = 'initialized' AND is_deleted = 0 AND effective_at <= ?`
      )
      .run(ts, ts, ts)

    for (const note of due) {
      const preview = (note.content || '').trim().slice(0, 10) || '空内容'
      console.log(`[activateNotes]「${preview}」便签到达生效时间，进入进行中`)
    }

    return {
      count: result.changes,
      notified: due
        .filter((note) => note.notify_enabled === 1)
        .map(({ id, content }) => ({ id, content }))
    }
  })()
}

// ============================================================
// 列表 DTO
// ============================================================

/**
 * @typedef {Object} NoteListItem
 * @property {number} id
 * @property {string} content
 * @property {'initialized'|'in_progress'|'completed'} status
 * @property {number} is_pinned
 * @property {number} is_deleted
 * @property {number} notify_enabled
 * @property {number} effective_at
 * @property {number} duration_days
 * @property {number|null} finished_at
 * @property {number} sort_order
 * @property {Array<{id:number,name:string,color:string|null}>} tags
 * @property {number} attachment_count
 * @property {boolean} has_text
 * @property {boolean} has_image
 */

function escapeLikePattern(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function buildWhereClause({
  statuses,
  tagIds,
  search,
  includeDeleted = false,
  extraWhere = [],
  extraParams = []
} = {}) {
  const where = [...(includeDeleted ? [] : ['n.is_deleted = 0']), ...extraWhere]
  const params = [...extraParams]

  if (statuses?.length) {
    where.push(`n.status IN (${statuses.map(() => '?').join(',')})`)
    params.push(...statuses)
  }

  if (tagIds?.length) {
    where.push(`n.id IN (
      SELECT note_id FROM note_tags
      WHERE tag_id IN (${tagIds.map(() => '?').join(',')})
    )`)
    params.push(...tagIds)
  }

  if (search?.trim()) {
    where.push(`n.content LIKE '%' || ? || '%' ESCAPE '\\'`)
    params.push(escapeLikePattern(search.trim()))
  }

  return { whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

/** @returns {NoteListItem[]} */
export function toNoteListItems(notes) {
  if (!notes?.length) return []

  const db = getDb()
  const ids = notes.map((note) => note.id)
  const placeholders = ids.map(() => '?').join(',')
  const tagsByNote = new Map()

  const tagRows = db
    .prepare(
      `SELECT nt.note_id, t.id, t.name, t.color
       FROM note_tags nt
       INNER JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id IN (${placeholders})
       ORDER BY nt.rowid ASC`
    )
    .all(...ids)

  for (const tag of tagRows) {
    if (!tagsByNote.has(tag.note_id)) tagsByNote.set(tag.note_id, [])
    tagsByNote.get(tag.note_id).push({ id: tag.id, name: tag.name, color: tag.color })
  }

  const attachmentCounts = new Map(
    db
      .prepare(
        `SELECT note_id, COUNT(*) AS count
         FROM note_attachments
         WHERE note_id IN (${placeholders})
         GROUP BY note_id`
      )
      .all(...ids)
      .map((row) => [row.note_id, row.count])
  )

  return notes.map((note) => {
    const attachmentCount = attachmentCounts.get(note.id) || 0
    return {
      id: note.id,
      content: note.content,
      status: note.status,
      is_pinned: note.is_pinned,
      is_deleted: note.is_deleted,
      notify_enabled: note.notify_enabled,
      effective_at: note.effective_at,
      duration_days: note.duration_days,
      finished_at: note.finished_at,
      sort_order: note.sort_order,
      created_at: note.created_at,
      updated_at: note.updated_at,
      tags: tagsByNote.get(note.id) || [],
      attachment_count: attachmentCount,
      has_text: Boolean(note.content?.trim()),
      has_image: attachmentCount > 0
    }
  })
}

/**
 * 查询可能与当前月份相交的真实便签。candidateFrom 已按最大持续天数
 * 向前扩展，避免 SQLite 对每行做本地日期运算；精确区间相交由日历服务统一判断。
 */
export function queryCalendarNotes({ candidateFrom, visibleEndExclusive } = {}) {
  const from = Number(candidateFrom)
  const end = Number(visibleEndExclusive)
  if (!Number.isFinite(from) || !Number.isFinite(end) || from >= end) {
    throw new Error('无效的月历查询范围')
  }
  const notes = getDb()
    .prepare(
      `SELECT n.* FROM notes n
       WHERE n.is_deleted = 0 AND n.effective_at >= ? AND n.effective_at < ?
       ORDER BY n.is_pinned DESC, n.effective_at ASC, n.duration_days DESC, n.id ASC`
    )
    .all(from, end)
  return toNoteListItems(notes)
}

// ============================================================
// 时间线查询
// ============================================================

export function queryPinnedNotes({ statuses, tagIds, search } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses,
    tagIds,
    search,
    extraWhere: ['n.is_pinned = 1']
  })
  const notes = db
    .prepare(
      `SELECT n.* FROM notes n ${whereClause} ORDER BY n.effective_at DESC, n.created_at DESC`
    )
    .all(...params)
  return toNoteListItems(notes)
}

export function queryRecentNotes({ statuses, tagIds, search, cutoffTime } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses,
    tagIds,
    search,
    extraWhere: ['n.is_pinned = 0', 'n.effective_at > ?'],
    extraParams: [cutoffTime]
  })
  const notes = db
    .prepare(
      `SELECT n.* FROM notes n ${whereClause} ORDER BY n.effective_at DESC, n.created_at DESC`
    )
    .all(...params)
  return toNoteListItems(notes)
}

export function queryEarlierNotes({
  statuses,
  tagIds,
  search,
  cutoffTime,
  limit = 10,
  offset = 0
} = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses,
    tagIds,
    search,
    extraWhere: ['n.is_pinned = 0', 'n.effective_at <= ?'],
    extraParams: [cutoffTime]
  })
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM notes n ${whereClause}`)
    .get(...params)
  const notes = db
    .prepare(
      `SELECT n.* FROM notes n ${whereClause}
       ORDER BY n.effective_at DESC, n.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset)
  return { notes: toNoteListItems(notes), total }
}

// ============================================================
// 自定义排序查询
// ============================================================

export function queryCustomPinned({ statuses, tagIds, search } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses,
    tagIds,
    search,
    extraWhere: ['n.is_pinned = 1']
  })
  const notes = db
    .prepare(`SELECT n.* FROM notes n ${whereClause} ORDER BY n.sort_order ASC, n.created_at DESC`)
    .all(...params)
  return toNoteListItems(notes)
}

export function queryCustomNormal({ statuses, tagIds, search, limit = 10, offset = 0 } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses,
    tagIds,
    search,
    extraWhere: ['n.is_pinned = 0']
  })
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM notes n ${whereClause}`)
    .get(...params)
  const notes = db
    .prepare(
      `SELECT n.* FROM notes n ${whereClause}
       ORDER BY n.sort_order ASC, n.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset)
  return { notes: toNoteListItems(notes), total }
}

// ============================================================
// 标签分组查询
// ============================================================

/**
 * 查询标签分组概览。标签筛选只决定展示哪些真实标签组；未筛选标签时，
 * 额外返回一个“未分类”合成组。total 始终受状态条件约束。
 */
export function queryTagGroups({ statuses, tagIds } = {}) {
  const db = getDb()
  const selectedTagIds = Array.isArray(tagIds)
    ? [...new Set(tagIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : []
  const statusList = Array.isArray(statuses) ? statuses : []
  const statusJoin = statusList.length
    ? `AND n.status IN (${statusList.map(() => '?').join(',')})`
    : ''
  const tagWhere = selectedTagIds.length
    ? `WHERE t.id IN (${selectedTagIds.map(() => '?').join(',')})`
    : ''

  const groups = db
    .prepare(
      `SELECT t.id, t.name, t.color, t.created_at, COUNT(n.id) AS total
       FROM tags t
       LEFT JOIN note_tags nt ON nt.tag_id = t.id
       LEFT JOIN notes n ON n.id = nt.note_id AND n.is_deleted = 0 ${statusJoin}
       ${tagWhere}
       GROUP BY t.id, t.name, t.color, t.created_at
       ORDER BY t.created_at ASC, t.id ASC`
    )
    .all(...statusList, ...selectedTagIds)
    .map((group) => ({
      key: `tag:${group.id}`,
      id: group.id,
      name: group.name,
      color: group.color,
      total: Number(group.total) || 0,
      untagged: false
    }))

  if (selectedTagIds.length > 0) return groups

  const { whereClause, params } = buildWhereClause({
    statuses: statusList,
    extraWhere: ['NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id)']
  })
  const untaggedTotal = db
    .prepare(`SELECT COUNT(*) AS total FROM notes n ${whereClause}`)
    .get(...params).total
  groups.push({
    key: 'untagged',
    id: null,
    name: '未分类',
    color: null,
    total: Number(untaggedTotal) || 0,
    untagged: true
  })
  return groups
}

/**
 * 分页查询单个标签组。tagId 为 null 时查询“未分类”；组内只按生效时间
 * 从未来到过去排列，id 仅用于相同时间下提供稳定顺序。
 */
export function queryTagGroupNotes({ tagId = null, statuses, limit = 10, offset = 0 } = {}) {
  const db = getDb()
  const untagged = tagId === null
  const normalizedTagId = untagged ? null : Number(tagId)
  if (!untagged && (!Number.isInteger(normalizedTagId) || normalizedTagId <= 0)) {
    throw new Error('无效的标签 ID')
  }

  const extraWhere = untagged
    ? ['NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id)']
    : ['EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag_id = ?)']
  const { whereClause, params } = buildWhereClause({
    statuses,
    extraWhere,
    extraParams: untagged ? [] : [normalizedTagId]
  })
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 10))
  const safeOffset = Math.max(0, Math.trunc(Number(offset)) || 0)
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM notes n ${whereClause}`)
    .get(...params)
  const notes = db
    .prepare(
      `SELECT n.* FROM notes n ${whereClause}
       ORDER BY n.effective_at DESC, n.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset)

  return { notes: toNoteListItems(notes), total: Number(total) || 0 }
}

// ============================================================
// 独立搜索工作区
// ============================================================

/**
 * 搜索全部便签。搜索拥有独立筛选状态，不继承首页列表条件。
 * 多标签筛选采用 OR 语义；分页参数在主进程内收敛，避免异常大查询。
 */
export function searchNotes({
  search,
  statuses,
  tagIds,
  timeFrom,
  timeTo,
  onlyPinned = false,
  hasAttachments = false,
  includeDeleted = true,
  sort = 'effective',
  limit = 15,
  offset = 0
} = {}) {
  const db = getDb()
  const extraWhere = []
  const extraParams = []
  const parsedFrom = Number(timeFrom)
  const parsedTo = Number(timeTo)

  if (Number.isFinite(parsedFrom) && parsedFrom > 0) {
    extraWhere.push('n.effective_at >= ?')
    extraParams.push(parsedFrom)
  }
  if (Number.isFinite(parsedTo) && parsedTo > 0) {
    extraWhere.push('n.effective_at <= ?')
    extraParams.push(parsedTo)
  }
  if (onlyPinned) extraWhere.push('n.is_pinned = 1')
  if (hasAttachments) {
    extraWhere.push('EXISTS (SELECT 1 FROM note_attachments a WHERE a.note_id = n.id)')
  }

  const { whereClause, params } = buildWhereClause({
    search,
    statuses,
    tagIds,
    includeDeleted,
    extraWhere,
    extraParams
  })
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 15))
  const safeOffset = Math.max(0, Math.trunc(Number(offset)) || 0)
  const orderBy =
    sort === 'updated' ? 'n.updated_at DESC, n.id DESC' : 'n.effective_at DESC, n.created_at DESC'
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM notes n ${whereClause}`)
    .get(...params)
  const notes = db
    .prepare(`SELECT n.* FROM notes n ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, safeOffset)

  return { notes: toNoteListItems(notes), total }
}

export function reorderCustomSortOrder() {
  const db = getDb()
  const groups = db
    .prepare(
      `SELECT is_pinned, COUNT(*) AS total, COUNT(DISTINCT sort_order) AS distinct_total,
              SUM(CASE WHEN sort_order <= 0 THEN 1 ELSE 0 END) AS invalid_total
       FROM notes WHERE is_deleted = 0 GROUP BY is_pinned`
    )
    .all()
  const needsRepair = groups.some(
    (group) => group.total !== group.distinct_total || group.invalid_total > 0
  )
  if (!needsRepair) return false

  const all = db
    .prepare(
      `SELECT n.id, n.is_pinned FROM notes n WHERE n.is_deleted = 0
       ORDER BY n.is_pinned DESC, n.sort_order ASC, n.created_at DESC`
    )
    .all()

  if (!all.length) return false

  db.transaction(() => {
    let pinnedOrder = 65536
    let normalOrder = 65536
    for (const note of all) {
      const order = note.is_pinned ? pinnedOrder : normalOrder
      db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(order, note.id)
      if (note.is_pinned) pinnedOrder += 65536
      else normalOrder += 65536
    }
  })()
  return true
}

/** 在单个事务内提交一次拖拽产生的排序槽位交换。 */
export function updateCustomSortOrders(items = []) {
  if (!Array.isArray(items) || items.length === 0) return true
  const normalized = items.map((item) => ({
    id: Number(item?.id),
    sortOrder: Number(item?.sortOrder)
  }))
  if (
    normalized.some(
      ({ id, sortOrder }) => !Number.isInteger(id) || id <= 0 || !Number.isFinite(sortOrder)
    ) ||
    new Set(normalized.map(({ id }) => id)).size !== normalized.length
  ) {
    throw new Error('无效的自定义排序数据')
  }

  const db = getDb()
  const update = db.prepare(
    'UPDATE notes SET sort_order = ?, updated_at = ? WHERE id = ? AND is_deleted = 0'
  )
  return db.transaction((rows) => {
    const timestamp = now()
    for (const { id, sortOrder } of rows) {
      const result = update.run(sortOrder, timestamp, id)
      if (result.changes !== 1) throw new Error(`便签不存在或已删除: ${id}`)
    }
    return true
  })(normalized)
}
