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
    getDb()
      .prepare('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)')
      .run(name, color, ts)
    return getTagByName(name)
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null
    throw err
  }
}

/**
 * 更新标签（按名称查找）
 * @param {string} name - 标签名称
 * @param {Object} [fields={}] - { name?, color? }
 * @returns {Object|null} 标签不存在或名称冲突返回 null
 */
export function updateTag(name, { newName, color } = {}) {
  const old = getTagByName(name)
  if (!old) return null
  const targetName = newName ?? name
  try {
    getDb()
      .prepare('UPDATE tags SET name = ?, color = ? WHERE name = ?')
      .run(targetName, color ?? old.color, name)
    return getTagByName(targetName)
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null
    throw err
  }
}

/**
 * 删除标签（按名称，级联删除关联关系）
 * @param {string} name
 * @returns {boolean}
 */
export function deleteTag(name) {
  const result = getDb().prepare('DELETE FROM tags WHERE name = ?').run(name)
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
// 便签-标签关联（以 tag_name 为唯一标识）
// ============================================================

function requireActiveNote(db, noteId) {
  const note = db.prepare('SELECT id FROM notes WHERE id = ? AND is_deleted = 0').get(noteId)
  if (!note) throw new Error('便签不存在或已删除')
}

/**
 * 为便签绑定标签
 * @param {number} noteId
 * @param {string} tagName
 * @returns {boolean} 是否成功（已绑定返回 true）
 */
export function bindTag(noteId, tagName) {
  try {
    const db = getDb()
    db.transaction(() => {
      requireActiveNote(db, noteId)
      db.prepare('INSERT INTO note_tags (note_id, tag_name) VALUES (?, ?)').run(noteId, tagName)
      db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), noteId)
    })()
    return true
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true
    throw err
  }
}

/**
 * 解除便签与标签的绑定
 * @param {number} noteId
 * @param {string} tagName
 * @returns {boolean}
 */
export function unbindTag(noteId, tagName) {
  const db = getDb()
  requireActiveNote(db, noteId)
  const result = db
    .prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_name = ?')
    .run(noteId, tagName)
  if (result.changes > 0) {
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), noteId)
  }
  return result.changes > 0
}

/**
 * 批量绑定标签（事务内完成，原子替换）
 * @param {number} noteId
 * @param {string[]} tagNames
 */
export function setNoteTags(noteId, tagNames) {
  const db = getDb()
  const del = db.prepare('DELETE FROM note_tags WHERE note_id = ?')
  const ins = db.prepare('INSERT INTO note_tags (note_id, tag_name) VALUES (?, ?)')
  const txn = db.transaction(() => {
    requireActiveNote(db, noteId)
    del.run(noteId)
    for (const tn of tagNames) {
      ins.run(noteId, tn)
    }
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), noteId)
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
      `SELECT t.* FROM tags t
       INNER JOIN note_tags nt ON nt.tag_name = t.name
       INNER JOIN notes n ON n.id = nt.note_id
       WHERE nt.note_id = ? AND n.is_deleted = 0
       ORDER BY t.created_at ASC`
    )
    .all(noteId)
}

/**
 * 获取标签关联的便签数量
 * @param {string} tagName
 * @returns {number}
 */
export function getTagNoteCount(tagName) {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM note_tags WHERE tag_name = ?').get(tagName)
  return row?.count ?? 0
}
