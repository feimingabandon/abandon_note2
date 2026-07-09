/**
 * db-search.js — 搜索模块（主进程）
 *
 * 职责：
 *   1. 基于 SQL LIKE 对便签正文进行模糊搜索
 *   2. 搜索建议/自动补全
 */

import { getDb } from './db.js'

/**
 * 模糊搜索便签（LIKE 模式匹配）
 *
 * @param {string} query - 搜索关键词
 * @param {Object} [options]
 * @param {number} [options.limit=50] - 返回条数上限
 * @param {number} [options.offset=0] - 偏移量
 * @param {string[]} [options.statuses] - 状态筛选，默认全部
 * @returns {{ results: Object[], total: number }}
 */
export function searchNotes(query, { limit = 50, offset = 0, statuses = null } = {}) {
  const db = getDb()

  if (!query || !query.trim()) {
    return { results: [], total: 0 }
  }

  const keyword = query.trim()
  const likePattern = `%${keyword}%`

  let statusFilter = ''
  let statusParams = []
  if (statuses && statuses.length > 0) {
    statusFilter = `AND status IN (${statuses.map(() => '?').join(',')})`
    statusParams = statuses
  }

  const countSQL = `
    SELECT COUNT(*) as total FROM notes
    WHERE content LIKE ? ${statusFilter}
  `
  const { total } = db.prepare(countSQL).get(likePattern, ...statusParams)

  if (total === 0) {
    return { results: [], total: 0 }
  }

  const searchSQL = `
    SELECT * FROM notes
    WHERE content LIKE ? ${statusFilter}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `
  const results = db.prepare(searchSQL).all(likePattern, ...statusParams, limit, offset)

  return { results, total }
}

/**
 * 获取搜索建议（基于现有便签文本的自动补全）
 * 使用参数化查询防止 SQL 注入，通过 SQL 字符串拼接实现 LIKE 模式匹配
 *
 * @param {string} prefix - 前缀文本
 * @param {number} [limit=5] - 返回条数
 * @returns {string[]} 匹配的上下文片段
 */
export function searchSuggestions(prefix, limit = 5) {
  if (!prefix || prefix.length < 2) return []

  const db = getDb()
  const rows = db
    .prepare(
      `
    SELECT content FROM notes
    WHERE content LIKE '%' || ? || '%' AND status IN ('active', 'in_progress')
    LIMIT ?
  `
    )
    .all(prefix, limit)

  // 提取包含前缀的上下文片段（前缀前后各取若干字符）
  return rows.map((r) => {
    const idx = r.content.indexOf(prefix)
    const start = Math.max(0, idx - 10)
    const end = Math.min(r.content.length, idx + prefix.length + 50)
    return r.content.slice(start, end)
  })
}
