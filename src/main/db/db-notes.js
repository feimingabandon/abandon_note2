/**
 * db-notes.js — 便签 CRUD 模块（主进程）
 *
 * 职责：
 *   1. 创建、查询、更新、删除便签实例
 *   2. 状态流转（active → in_progress → completed / expired）
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
 * 校验状态流转是否合法
 * @param {string} current - 当前状态
 * @param {string} target - 目标状态
 * @returns {boolean}
 */
function isValidTransition(current, target) {
  // 终态不可逆转
  const terminals = ['completed', 'expired']
  if (terminals.includes(current)) return false

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
 * @param {boolean} [options.notifyEnabled=false] - 是否启用操作系统通知，默认关闭
 * @param {boolean} [options.isPinned=false] - 是否置顶，默认关闭
 * @param {number} [options.sortOrder=0] - 排序序号
 * @returns {Object} 创建的便签完整对象
 */
export function createNote({
  content = '',
  effectiveAt = null,
  noteType = 'one_time',
  templateId = null,
  notifyEnabled = 0,
  isPinned = 0,
  sortOrder = 0
} = {}) {
  const ts = now()
  const effAt = effectiveAt ?? ts

  // 一次性便签状态逻辑：
  // - 未设生效时间（立即）→ in_progress
  // - 已设生效时间且已到达 → in_progress
  // - 已设生效时间但未到达 → active（等待激活）
  let status = 'in_progress'
  if (effectiveAt && effectiveAt > ts && effectiveAt > 0) {
    status = 'active'
  }

  const result = getDb()
    .prepare(
      `
    INSERT INTO notes (template_id, note_type, content, status, is_pinned, notify_enabled, effective_at, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(templateId, noteType, content, status, isPinned ? 1 : 0, notifyEnabled ? 1 : 0, effAt, sortOrder, ts, ts)

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
 * 按 ID 获取便签（含图片附件和标签）
 * @param {number} id
 * @returns {Object|null} 便签对象，不存在返回 null
 */
export function getNoteById(id) {
  const note = getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id)
  if (!note) return null

  // 拼接图片附件
  note.attachments = getDb()
    .prepare('SELECT * FROM note_attachments WHERE note_id = ? ORDER BY sort_order')
    .all(id)

  // 拼接标签
  note.tags = getDb()
    .prepare(
      `
      SELECT t.* FROM tags t
      INNER JOIN note_tags nt ON nt.tag_name = t.name
      WHERE nt.note_id = ?
    `
    )
    .all(id)

  return note
}

/**
 * 删除便签（状态流转为 expired，不物理删除）
 * @param {number} id
 * @returns {boolean} 是否成功
 */
export function deleteNote(id) {
  return updateNote(id, { status: 'expired' }) !== null
}

/**
 * 批量激活便签：将生效时间已到的 active 便签转为 in_progress
 * 由调度器的激活任务每分钟调用一次
 * @returns {{ count: number, notified: Array<{id:number, content:string}> }}
 */
export function activateNotes() {
  const db = getDb()
  const now = Date.now()

  // 加 59 秒缓冲窗口：覆盖当前分钟边界内的便签，下一分钟的留给下个 tick
  const deadline = now + 59_000

  // 查询缓冲窗口内到期的 active 便签
  const allToActivate = db
    .prepare(
      `SELECT id, content, notify_enabled FROM notes
       WHERE status = 'active' AND effective_at <= ?`
    )
    .all(deadline)

  // 从中筛选启用通知的（供调度器发送系统通知），只保留需要的字段
  const toNotify = allToActivate
    .filter((n) => n.notify_enabled === 1)
    .map((n) => ({ id: n.id, content: n.content }))

  // 批量转状态
  const result = db
    .prepare(
      `UPDATE notes SET status = 'in_progress', updated_at = ?
       WHERE status = 'active' AND effective_at <= ?`
    )
    .run(now, deadline)

  const count = result.changes

  // 日志：每条激活的便签打印一行
  for (const note of allToActivate) {
    const preview = (note.content || '').trim().slice(0, 10) || '空内容'
    console.log(`[activateNotes]「${preview}」便签到达生效时间，已激活`)
  }

  return { count, notified: toNotify }
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
 * 取消便签：任意非终态 → expired
 * @param {number} id
 * @returns {Object|null}
 */
export function cancelNote(id) {
  return updateNote(id, { status: 'expired' })
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
// 共享 WHERE 子句构建（供各查询方法复用）
// ============================================================

/**
 * 构建 WHERE 子句
 * @param {Object} opts
 * @param {string[]} opts.statuses - 状态列表
 * @param {string[]} opts.tagNames - 标签名列表
 * @param {string} opts.search - 搜索词
 * @param {string[]} opts.extraWhere - 额外的 WHERE 条件（不含参数）
 * @param {any[]} opts.extraParams - 额外条件的参数值
 * @returns {{ whereClause: string, params: any[] }}
 */
function buildWhereClause({ statuses, tagNames, search, extraWhere = [], extraParams = [] } = {}) {
  const where = [...extraWhere]
  const params = [...extraParams]

  if (statuses && statuses.length > 0) {
    where.push(`n.status IN (${statuses.map(() => '?').join(',')})`)
    params.push(...statuses)
  }

  if (tagNames && tagNames.length > 0) {
    where.push(`n.id IN (
      SELECT note_id FROM note_tags
      WHERE tag_name IN (${tagNames.map(() => '?').join(',')})
      GROUP BY note_id
      HAVING COUNT(DISTINCT tag_name) = ?
    )`)
    params.push(...tagNames, tagNames.length)
  }

  if (search && search.trim()) {
    where.push(`n.content LIKE '%' || ? || '%'`)
    params.push(search.trim())
  }

  return { whereClause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params }
}

// ============================================================
// 分组专用查询（时间线模式）
// ============================================================

/**
 * 方法一：查询置顶便签（全量，不分页）
 * 仅接受状态 + 标签 + 搜索条件，不加任何额外限制
 * @param {Object} opts
 * @param {string[]} opts.statuses
 * @param {string[]} [opts.tagNames]
 * @param {string} [opts.search]
 * @returns {Object[]} 便签列表
 */
export function queryPinnedNotes({ statuses, tagNames, search } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses, tagNames, search,
    extraWhere: ['n.is_pinned = 1'],
    extraParams: []
  })

  return db
    .prepare(`SELECT n.* FROM notes n ${whereClause} ORDER BY n.effective_at DESC, n.created_at DESC`)
    .all(...params)
}

/**
 * 方法二：查询三天内非置顶便签（全量，不分页）
 * @param {Object} opts
 * @param {string[]} opts.statuses
 * @param {string[]} [opts.tagNames]
 * @param {string} [opts.search]
 * @param {number} opts.cutoffTime - 三天截止时间戳（毫秒）
 * @returns {Object[]} 便签列表
 */
export function queryRecentNotes({ statuses, tagNames, search, cutoffTime } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses, tagNames, search,
    extraWhere: ['n.is_pinned = 0', 'n.effective_at > ?'],
    extraParams: [cutoffTime]
  })

  return db
    .prepare(`SELECT n.* FROM notes n ${whereClause} ORDER BY n.effective_at DESC, n.created_at DESC`)
    .all(...params)
}

/**
 * 方法三：查询更早的非置顶便签（分页，每次默认 10 条）
 * @param {Object} opts
 * @param {string[]} opts.statuses
 * @param {string[]} [opts.tagNames]
 * @param {string} [opts.search]
 * @param {number} opts.cutoffTime - 三天截止时间戳（毫秒）
 * @param {number} [opts.limit=10]
 * @param {number} [opts.offset=0]
 * @returns {{ notes: Object[], total: number }}
 */
export function queryEarlierNotes({ statuses, tagNames, search, cutoffTime, limit = 10, offset = 0 } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses, tagNames, search,
    extraWhere: ['n.is_pinned = 0', 'n.effective_at <= ?'],
    extraParams: [cutoffTime]
  })

  const { total } = db
    .prepare(`SELECT COUNT(*) as total FROM notes n ${whereClause}`)
    .get(...params)

  const notes = db
    .prepare(`SELECT n.* FROM notes n ${whereClause} ORDER BY n.effective_at DESC, n.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)

  return { notes, total }
}

// ============================================================
// 自定义模式专用查询（按 sort_order 排序）
// ============================================================

/**
 * 自定义模式——查询置顶便签（全量，按 sort_order 排序）
 * 仅接受状态 + 标签 + 搜索条件，不加任何额外限制
 */
export function queryCustomPinned({ statuses, tagNames, search } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses, tagNames, search,
    extraWhere: ['n.is_pinned = 1'],
    extraParams: []
  })
  return db
    .prepare(`SELECT n.* FROM notes n ${whereClause} ORDER BY n.sort_order ASC, n.created_at DESC`)
    .all(...params)
}

/**
 * 自定义模式——查询日常便签（分页，按 sort_order 排序）
 * 仅接受状态 + 标签 + 搜索条件
 */
export function queryCustomNormal({ statuses, tagNames, search, limit = 10, offset = 0 } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses, tagNames, search,
    extraWhere: ['n.is_pinned = 0'],
    extraParams: []
  })
  const { total } = db
    .prepare(`SELECT COUNT(*) as total FROM notes n ${whereClause}`)
    .get(...params)
  const notes = db
    .prepare(`SELECT n.* FROM notes n ${whereClause} ORDER BY n.sort_order ASC, n.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
  return { notes, total }
}

/**
 * 自定义模式——全局重排 sort_order
 * 查询所有活跃便签，按置顶优先、effective_at 降序，分配大间距 sort_order
 */
export function reorderCustomSortOrder({ statuses, tagNames, search } = {}) {
  const db = getDb()
  const { whereClause, params } = buildWhereClause({
    statuses, tagNames, search,
    extraWhere: [],
    extraParams: []
  })

  const all = db
    .prepare(`SELECT n.id, n.is_pinned FROM notes n ${whereClause} ORDER BY n.is_pinned DESC, n.effective_at DESC`)
    .all(...params)

  if (all.length === 0) return false

  const txn = db.transaction(() => {
    let pinnedOrder = 65536
    let normalOrder = 65536
    for (const n of all) {
      const order = n.is_pinned ? pinnedOrder : normalOrder
      db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(order, n.id)
      if (n.is_pinned) pinnedOrder += 65536
      else normalOrder += 65536
    }
  })
  txn()
  return true
}
