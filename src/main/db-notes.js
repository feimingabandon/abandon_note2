/**
 * db-notes.js — 便签 CRUD 模块（主进程）
 *
 * 职责：
 *   1. 创建、查询、更新、删除便签实例
 *   2. 状态流转（active → in_progress → completed / cancelled）
 *   3. 列表查询（支持状态筛选、标签筛选、排序模式、分页）
 *   4. 所有操作自动更新 updated_at
 */

import { getDb } from './db.js'

// ============================================================
// 辅助函数
// ============================================================

/** 获取当前时间戳（毫秒） */
const now = () => Date.now()

/**
 * 将用户搜索词转为 FTS5 安全查询字符串
 * 包裹双引号实现短语匹配，转义内部双引号
 */
function fts5Escape(raw) {
  return `"${raw.replace(/"/g, '""')}"`
}

/**
 * 校验状态流转是否合法
 * @param {string} current - 当前状态
 * @param {string} target - 目标状态
 * @returns {boolean}
 */
function isValidTransition(current, target) {
  // 终态不可逆转
  const terminals = ['completed', 'cancelled', 'expired']
  if (terminals.includes(current)) return false

  // 任意非终态 → cancelled 始终允许
  if (target === 'cancelled') return true

  switch (target) {
    case 'active':
      // 允许从 in_progress 退回 active（重新激活）
      return current === 'in_progress'
    case 'in_progress':
      return current === 'active'
    case 'completed':
      // active 或 in_progress 都可以直接完成
      return current === 'active' || current === 'in_progress'
    case 'expired':
      // 仅系统调度器调用，不限制来源状态
      return true
    default:
      return false
  }
}

// ============================================================
// CRUD
// ============================================================

/**
 * 创建便签
 * @param {Object} options
 * @param {string} [options.content=''] - 便签正文（Markdown）
 * @param {number|null} [options.effectiveAt=null] - 生效时间戳，默认等于 created_at
 * @param {string} [options.noteType='one_time'] - 便签类型
 * @param {number|null} [options.templateId=null] - 关联的循环模板 ID
 * @param {boolean} [options.notifyEnabled=true] - 是否启用操作系统通知
 * @returns {Object} 创建的便签完整对象
 */
export function createNote({
  content = '',
  effectiveAt = null,
  noteType = 'one_time',
  templateId = null,
  notifyEnabled = 1
} = {}) {
  const ts = now()
  const effAt = effectiveAt ?? ts

  const result = getDb()
    .prepare(
      `
    INSERT INTO notes (template_id, note_type, content, status, is_pinned, notify_enabled, effective_at, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 0, ?, ?, 0, ?, ?)
  `
    )
    .run(templateId, noteType, content, notifyEnabled ? 1 : 0, effAt, ts, ts)

  return getNoteById(result.lastInsertRowid)
}

/**
 * 更新便签（部分字段）
 * @param {number} id - 便签 ID
 * @param {Object} [fields={}] - 要更新的字段，未传入的保留原值
 * @returns {Object|null} 更新后的便签对象
 */
export function updateNote(id, fields = {}) {
  const old = getNoteById(id)
  if (!old) return null

  // 若尝试修改状态，需校验流转合法性
  if (fields.status && !isValidTransition(old.status, fields.status)) {
    console.warn(`[db-notes] 非法的状态流转: ${old.status} → ${fields.status} (note_id=${id})`)
    return null
  }

  const ts = now()
  getDb()
    .prepare(
      `
    UPDATE notes SET
      content = ?, status = ?, is_pinned = ?, notify_enabled = ?,
      effective_at = ?, sort_order = ?, updated_at = ?
    WHERE id = ?
  `
    )
    .run(
      fields.content ?? old.content,
      fields.status ?? old.status,
      fields.is_pinned ?? old.is_pinned,
      fields.notify_enabled ?? old.notify_enabled,
      fields.effective_at ?? old.effective_at,
      fields.sort_order ?? old.sort_order,
      ts,
      id
    )

  return getNoteById(id)
}

/**
 * 按 ID 获取便签（含附件和标签）
 * @param {number} id
 * @returns {Object|null} 便签对象，不存在返回 null
 */
export function getNoteById(id) {
  const note = getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id)
  if (!note) return null

  // 拼接附件
  note.attachments = getDb()
    .prepare('SELECT * FROM note_attachments WHERE note_id = ? ORDER BY sort_order')
    .all(id)

  // 拼接标签
  note.tags = getDb()
    .prepare(
      `
      SELECT t.* FROM tags t
      INNER JOIN note_tags nt ON nt.tag_id = t.id
      WHERE nt.note_id = ?
    `
    )
    .all(id)

  return note
}

/**
 * 删除便签（状态流转为 cancelled，不物理删除）
 * @param {number} id
 * @returns {boolean} 是否成功
 */
export function deleteNote(id) {
  return updateNote(id, { status: 'cancelled' }) !== null
}

// ============================================================
// 状态流转
// ============================================================

/**
 * 开始处理便签：active → in_progress
 * @param {number} id
 * @returns {Object|null}
 */
export function startProgress(id) {
  return updateNote(id, { status: 'in_progress' })
}

/**
 * 完成便签：active/in_progress → completed
 * @param {number} id
 * @returns {Object|null}
 */
export function completeNote(id) {
  return updateNote(id, { status: 'completed' })
}

/**
 * 取消便签：任意非终态 → cancelled
 * @param {number} id
 * @returns {Object|null}
 */
export function cancelNote(id) {
  return updateNote(id, { status: 'cancelled' })
}

/**
 * 将便签标记为过期（由调度器调用）
 * @param {number} id
 * @returns {Object|null}
 */
export function expireNote(id) {
  return updateNote(id, { status: 'expired' })
}

// ============================================================
// 列表查询
// ============================================================

/**
 * 查询便签列表
 * @param {Object} options
 * @param {string[]} [options.statuses] - 状态筛选，默认 ['active','in_progress']
 * @param {number[]} [options.tagIds] - 标签 AND 筛选（同时包含所有指定标签）
 * @param {string} [options.search] - FTS5 搜索关键词（自动转义）
 * @param {'timeline'|'custom'} [options.sortMode='timeline'] - 排序模式
 * @param {number} [options.limit=50] - 分页条数
 * @param {number} [options.offset=0] - 偏移量
 * @returns {{ notes: Object[], total: number }} 便签列表和总数
 */
export function listNotes({
  statuses = ['active', 'in_progress'],
  tagIds = null,
  search = null,
  sortMode = 'timeline',
  limit = 50,
  offset = 0
} = {}) {
  const db = getDb()
  const where = []
  const params = []

  // 状态筛选
  if (statuses && statuses.length > 0) {
    where.push(`n.status IN (${statuses.map(() => '?').join(',')})`)
    params.push(...statuses)
  }

  // 标签 AND 筛选
  if (tagIds && tagIds.length > 0) {
    where.push(`n.id IN (
      SELECT note_id FROM note_tags
      WHERE tag_id IN (${tagIds.map(() => '?').join(',')})
      GROUP BY note_id
      HAVING COUNT(DISTINCT tag_id) = ?
    )`)
    params.push(...tagIds, tagIds.length)
  }

  // FTS5 搜索（与 searchNotes 一致的转义策略）
  if (search && search.trim()) {
    where.push(`n.id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)`)
    params.push(fts5Escape(search.trim()))
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  // 排序
  let orderBy
  if (sortMode === 'custom') {
    orderBy = 'ORDER BY n.is_pinned DESC, n.sort_order ASC, n.created_at DESC'
  } else {
    orderBy = 'ORDER BY n.is_pinned DESC, n.effective_at DESC, n.created_at DESC'
  }

  // 查询总数
  const { total } = db
    .prepare(`SELECT COUNT(*) as total FROM notes n ${whereClause}`)
    .get(...params)

  // 查询列表
  const notes = db
    .prepare(`SELECT n.* FROM notes n ${whereClause} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)

  return { notes, total }
}

// ============================================================
// 批量操作
// ============================================================

/**
 * 批量更新便签状态
 * 仅允许对非终态便签执行批量状态流转（completed/cancelled/expired 不可逆）
 * @param {number[]} ids - 便签 ID 数组
 * @param {string} status - 目标状态
 * @returns {number} 受影响行数
 */
export function batchUpdateStatus(ids, status) {
  if (!ids || ids.length === 0) return 0
  const db = getDb()
  const ts = now()
  const placeholders = ids.map(() => '?').join(',')
  return db
    .prepare(
      `
    UPDATE notes SET status = ?, updated_at = ?
    WHERE id IN (${placeholders})
      AND status NOT IN ('completed','cancelled','expired')
  `
    )
    .run(status, ts, ...ids).changes
}

/**
 * 批量更新置顶状态
 * @param {number[]} ids
 * @param {boolean} pinned
 * @returns {number}
 */
export function batchSetPinned(ids, pinned) {
  if (!ids || ids.length === 0) return 0
  const db = getDb()
  const ts = now()
  const val = pinned ? 1 : 0
  const placeholders = ids.map(() => '?').join(',')
  return db
    .prepare(
      `
    UPDATE notes SET is_pinned = ?, updated_at = ? WHERE id IN (${placeholders})
  `
    )
    .run(val, ts, ...ids).changes
}

/**
 * 批量修改生效时间
 * @param {number[]} ids
 * @param {number} effectiveAt
 * @returns {number}
 */
export function batchSetEffectiveAt(ids, effectiveAt) {
  if (!ids || ids.length === 0) return 0
  const db = getDb()
  const ts = now()
  const placeholders = ids.map(() => '?').join(',')
  return db
    .prepare(
      `
    UPDATE notes SET effective_at = ?, updated_at = ? WHERE id IN (${placeholders})
  `
    )
    .run(effectiveAt, ts, ...ids).changes
}

/**
 * 批量添加标签
 * @param {number[]} noteIds
 * @param {number[]} tagIds
 */
export function batchAddTags(noteIds, tagIds) {
  if (!noteIds?.length || !tagIds?.length) return
  const db = getDb()
  const insert = db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)')
  const batch = db.transaction(() => {
    for (const nid of noteIds) {
      for (const tid of tagIds) {
        insert.run(nid, tid)
      }
    }
  })
  batch()
}
