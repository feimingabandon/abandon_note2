/**
 * db-tags.js — 标签 CRUD 模块（主进程）
 *
 * 职责：
 *   1. 标签的创建、查询、更新、删除
 *   2. 便签-标签关联关系的绑定与解绑
 *   3. 便签标签关联的单标签写入约束
 */

import { getDb } from './db-connection.js'
import { requireSingleAssignedTagId } from '../../shared/tag-rules.js'

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
export function createTag(name, color = null, pinned = false) {
  const normalizedName = normalizeTagName(name)
  const normalizedColor = normalizeTagColor(color)
  const ts = now()
  try {
    getDb()
      .prepare(
        'INSERT INTO tags (name, color, created_at, is_pinned, pinned_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(normalizedName, normalizedColor, ts, pinned ? 1 : 0, pinned ? ts : null)
    return getTagByName(normalizedName)
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null
    throw err
  }
}

function normalizeTagName(value) {
  const name = String(value ?? '').trim()
  if (!name) throw new Error('标签名称不能为空')
  if (name.length > 10) throw new Error('标签名称不能超过 10 个字符')
  return name
}

function normalizeTagColor(value) {
  if (value === null || value === undefined || value === '') return null
  const color = String(value).trim().toLowerCase()
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error('标签颜色格式无效')
  return color
}

/** 按稳定 ID 修改标签名称与颜色；关联表无需改写。 */
export function updateTag(id, { name, color = null, pinned } = {}) {
  const tagId = Number(id)
  if (!Number.isInteger(tagId) || tagId <= 0) throw new Error('无效的标签 ID')
  const normalizedName = normalizeTagName(name)
  const normalizedColor = normalizeTagColor(color)
  const db = getDb()
  const current = getTagById(tagId)
  if (!current) throw new Error('标签不存在')
  const nextPinned = pinned === undefined ? Number(current.is_pinned) === 1 : Boolean(pinned)
  const pinnedAt = nextPinned
    ? Number(current.is_pinned) === 1 && current.pinned_at
      ? current.pinned_at
      : now()
    : null
  try {
    db.prepare(
      'UPDATE tags SET name = ?, color = ?, is_pinned = ?, pinned_at = ? WHERE id = ?'
    ).run(normalizedName, normalizedColor, nextPinned ? 1 : 0, pinnedAt, tagId)
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('标签名称已存在')
    throw error
  }
  return { tag: getTagById(tagId), oldName: current.name }
}

/**
 * 删除标签（按稳定 ID，级联删除关联关系）
 * @param {number} id
 * @returns {boolean}
 */
export function deleteTag(id) {
  const result = getDb().prepare('DELETE FROM tags WHERE id = ?').run(Number(id))
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
 * @returns {Object[]} 标签列表，按创建时间倒序
 */
export function listTags() {
  return getDb().prepare('SELECT * FROM tags ORDER BY created_at DESC, id DESC').all()
}

/** 置顶标签保持稳定顺序：只有显式置顶时才更新 pinned_at。 */
export function setTagPinned(id, pinned, timestamp = now()) {
  const tagId = Number(id)
  if (!Number.isInteger(tagId) || tagId <= 0) throw new Error('无效的标签 ID')
  const isPinned = Boolean(pinned)
  const result = getDb()
    .prepare('UPDATE tags SET is_pinned = ?, pinned_at = ? WHERE id = ?')
    .run(isPinned ? 1 : 0, isPinned ? Number(timestamp) : null, tagId)
  if (result.changes !== 1) throw new Error('标签不存在')
  return getTagById(tagId)
}

// ============================================================
// 便签-标签关联（以 tags.id 为稳定标识）
// ============================================================

function requireActiveNote(db, noteId) {
  const note = db.prepare('SELECT id FROM notes WHERE id = ? AND is_deleted = 0').get(noteId)
  if (!note) throw new Error('便签不存在或已删除')
}

/**
 * 为便签绑定标签
 * @param {number} noteId
 * @param {number} tagId
 * @returns {boolean} 是否成功（已绑定返回 true）
 */
export function bindTag(noteId, tagId) {
  const [normalizedTagId] = requireSingleAssignedTagId([tagId])
  const db = getDb()
  db.transaction(() => {
    requireActiveNote(db, noteId)
    db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId)
    db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, normalizedTagId)
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), noteId)
  })()
  return true
}

/**
 * 解除便签与标签的绑定
 * @param {number} noteId
 * @param {number} tagId
 * @returns {boolean}
 */
export function unbindTag(noteId, tagId) {
  const db = getDb()
  requireActiveNote(db, noteId)
  const result = db
    .prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?')
    .run(noteId, Number(tagId))
  if (result.changes > 0) {
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), noteId)
  }
  return result.changes > 0
}

/**
 * 批量绑定标签（事务内完成，原子替换）
 * @param {number} noteId
 * @param {number[]} tagIds
 */
export function setNoteTagIds(noteId, tagIds) {
  const normalizedTagIds = requireSingleAssignedTagId(tagIds)
  const db = getDb()
  const del = db.prepare('DELETE FROM note_tags WHERE note_id = ?')
  const ins = db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)')
  const txn = db.transaction(() => {
    requireActiveNote(db, noteId)
    del.run(noteId)
    for (const tagId of normalizedTagIds) {
      ins.run(noteId, tagId)
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
       INNER JOIN note_tags nt ON nt.tag_id = t.id
       INNER JOIN notes n ON n.id = nt.note_id
       WHERE nt.note_id = ? AND n.is_deleted = 0
       ORDER BY nt.rowid ASC`
    )
    .all(noteId)
}

/**
 * 获取标签关联的便签数量
 * @param {number} tagId
 * @returns {number}
 */
export function getTagNoteCount(tagId) {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM note_tags WHERE tag_id = ?')
    .get(Number(tagId))
  return row?.count ?? 0
}

/**
 * 获取全局标签删除会影响的全部关联数量。
 * 逻辑删除记录仍保留关联，因此计数同时包含未彻底删除的便签和模板。
 */
export function getTagUsage(tagId) {
  const db = getDb()
  const noteUsage = db
    .prepare(
      `SELECT
         COUNT(DISTINCT n.id) AS noteCount,
         COUNT(DISTINCT CASE WHEN n.is_deleted = 0 THEN n.id END) AS activeNoteCount,
         COUNT(DISTINCT CASE WHEN n.is_deleted = 1 THEN n.id END) AS deletedNoteCount
       FROM note_tags nt
       INNER JOIN notes n ON n.id = nt.note_id
       WHERE nt.tag_id = ?`
    )
    .get(Number(tagId))
  const templateUsage = db
    .prepare(
      `SELECT
         COUNT(DISTINCT t.id) AS templateCount,
         COUNT(DISTINCT CASE
           WHEN t.is_deleted = 0 AND t.is_paused = 0 THEN t.id
         END) AS runningTemplateCount,
         COUNT(DISTINCT CASE
           WHEN t.is_deleted = 0 AND t.is_paused = 1 THEN t.id
         END) AS pausedTemplateCount,
         COUNT(DISTINCT CASE WHEN t.is_deleted = 1 THEN t.id END) AS deletedTemplateCount
       FROM template_tags tt
       INNER JOIN note_templates t ON t.id = tt.template_id
       WHERE tt.tag_id = ?`
    )
    .get(Number(tagId))
  return {
    noteCount: noteUsage?.noteCount ?? 0,
    activeNoteCount: noteUsage?.activeNoteCount ?? 0,
    deletedNoteCount: noteUsage?.deletedNoteCount ?? 0,
    templateCount: templateUsage?.templateCount ?? 0,
    runningTemplateCount: templateUsage?.runningTemplateCount ?? 0,
    pausedTemplateCount: templateUsage?.pausedTemplateCount ?? 0,
    deletedTemplateCount: templateUsage?.deletedTemplateCount ?? 0
  }
}
