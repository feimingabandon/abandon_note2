/**
 * db-search.js — 全文搜索模块（主进程）
 *
 * 职责：
 *   1. 基于 SQLite FTS5 对便签正文进行全文搜索
 *   2. 高亮匹配片段
 *   3. 搜索词预处理（中文分词兼容）
 */

import { getDb } from './db.js'

/**
 * 全文搜索便签
 * FTS5 使用 'simple' 分词器（内置），Unicode 6.0+ 支持 CJK 字符分割
 *
 * @param {string} query - 搜索关键词
 * @param {Object} [options]
 * @param {number} [options.limit=50] - 返回条数上限
 * @param {number} [options.offset=0] - 偏移量
 * @param {string[]} [options.statuses] - 状态筛选，默认全部
 * @returns {{ results: Object[], total: number }}
 *   results 中每条便签额外包含 highlight 字段（匹配片段）
 */
export function searchNotes(query, { limit = 50, offset = 0, statuses = null } = {}) {
  const db = getDb()

  // 空查询返回空结果
  if (!query || !query.trim()) {
    return { results: [], total: 0 }
  }

  const trimmed = query.trim()

  // FTS5 查询语法预处理：转义双引号，包裹双引号实现短语匹配
  const ftsQuery = `"${trimmed.replace(/"/g, '""')}"`

  let statusFilter = ''
  let statusParams = []
  if (statuses && statuses.length > 0) {
    statusFilter = `AND notes.status IN (${statuses.map(() => '?').join(',')})`
    statusParams = statuses
  }

  // 获取搜索结果总数
  const countSQL = `
    SELECT COUNT(*) as total FROM notes_fts
    INNER JOIN notes ON notes.id = notes_fts.rowid
    WHERE notes_fts MATCH ? ${statusFilter}
  `
  const { total } = db.prepare(countSQL).get(ftsQuery, ...statusParams)

  if (total === 0) {
    return { results: [], total: 0 }
  }

  // 获取搜索结果（含高亮）
  const searchSQL = `
    SELECT
      notes.*,
      snippet(notes_fts, 1, '<mark>', '</mark>', '...', 40) AS highlight
    FROM notes_fts
    INNER JOIN notes ON notes.id = notes_fts.rowid
    WHERE notes_fts MATCH ? ${statusFilter}
    ORDER BY rank
    LIMIT ? OFFSET ?
  `
  const results = db.prepare(searchSQL).all(ftsQuery, ...statusParams, limit, offset)

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
