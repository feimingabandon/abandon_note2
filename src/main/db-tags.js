/**
 * db-tags.js — 标签 CRUD 模块（主进程）
 *
 * 职责：
 *   1. 标签的创建、查询、更新、删除
 *   2. 便签-标签关联关系的绑定与解绑
 *   3. 多标签 AND 筛选
 */

import { getDb } from './db.js'

const now = () => Date.now()

// ============================================================
// 标签 CRUD
// ============================================================

/**
 * 创建标签
 * @param {string} name - 标签名称（全局唯一）
 * @param {string|null} [color=null] - 十六进制颜色，如 '#FF5733'
 * @returns {Object|null} 创建的标签对象，名称冲突返回 null
 */
export function createTag(name, color = null) {
  const ts = now()
  try {
    const result = getDb()
      .prepare(
        `
      INSERT INTO tags (name, color, created_at)
      VALUES (?, ?, ?)
    `
      )
      .run(name, color, ts)
    return getTagById(result.lastInsertRowid)
  } catch (err) {
    // SQLITE_CONSTRAINT_UNIQUE → 名称已存在
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null
    throw err
  }
}

/**
 * 更新标签
 * @param {number} id
 * @param {Object} [fields={}] - { name?, color? }
 * @returns {Object|null} 标签不存在或名称冲突返回 null
 */
export function updateTag(id, { name, color } = {}) {
  const old = getTagById(id)
  if (!old) return null

  try {
    getDb()
      .prepare(
        `
    UPDATE tags SET name = ?, color = ? WHERE id = ?
  `
      )
      .run(name ?? old.name, color ?? old.color, id)
    return getTagById(id)
  } catch (err) {
    // SQLITE_CONSTRAINT_UNIQUE → 改名后与已有标签冲突
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null
    throw err
  }
}

/**
 * 删除标签（级联删除关联关系）
 * @param {number} id
 * @returns {boolean}
 */
export function deleteTag(id) {
  const result = getDb().prepare('DELETE FROM tags WHERE id = ?').run(id)
  return result.changes > 0
}

/**
 * 按 ID 获取标签
 * @param {number} id
 * @returns {Object|null}
 */
export function getTagById(id) {
  return getDb().prepare('SELECT * FROM tags WHERE id = ?').get(id)
}

/**
 * 按名称查找标签
 * @param {string} name
 * @returns {Object|null}
 */
export function getTagByName(name) {
  return getDb().prepare('SELECT * FROM tags WHERE name = ?').get(name)
}

/**
 * 获取所有标签
 * @returns {Object[]} 标签列表，按创建时间升序
 */
export function listTags() {
  return getDb().prepare('SELECT * FROM tags ORDER BY created_at ASC').all()
}

// ============================================================
// 便签-标签关联
// ============================================================

/**
 * 为便签绑定标签
 * @param {number} noteId
 * @param {number} tagId
 * @returns {boolean} 是否成功（已绑定返回 true）
 */
export function bindTag(noteId, tagId) {
  try {
    getDb().prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId)
    return true
  } catch (err) {
    // SQLITE_CONSTRAINT_PRIMARYKEY → 已绑定，视为成功
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true
    throw err
  }
}

/**
 * 解除便签与标签的绑定
 * @param {number} noteId
 * @param {number} tagId
 * @returns {boolean}
 */
export function unbindTag(noteId, tagId) {
  const result = getDb()
    .prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?')
    .run(noteId, tagId)
  return result.changes > 0
}

/**
 * 批量绑定标签（事务内完成，原子替换）
 * @param {number} noteId
 * @param {number[]} tagIds
 */
export function setNoteTags(noteId, tagIds) {
  const db = getDb()
  const del = db.prepare('DELETE FROM note_tags WHERE note_id = ?')
  const ins = db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)')

  const txn = db.transaction(() => {
    del.run(noteId)
    for (const tid of tagIds) {
      ins.run(noteId, tid)
    }
  })
  txn()
}

/**
 * 获取便签的所有标签
 * @param {number} noteId
 * @returns {Object[]}
 */
export function getNoteTags(noteId) {
  return getDb()
    .prepare(
      `
    SELECT t.* FROM tags t
    INNER JOIN note_tags nt ON nt.tag_id = t.id
    WHERE nt.note_id = ?
    ORDER BY t.created_at ASC
  `
    )
    .all(noteId)
}

/**
 * 获取标签关联的便签数量
 * @param {number} tagId
 * @returns {number}
 */
export function getTagNoteCount(tagId) {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM note_tags WHERE tag_id = ?').get(tagId)
  return row?.count ?? 0
}
