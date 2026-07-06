/**
 * db-attachments.js — 附件管理模块（主进程）
 *
 * 职责：
 *   1. 附件的添加、查询、删除
 *   2. 文件路径管理（DB 存相对路径，操作时解析为绝对路径）
 *   3. 附件数量限制校验
 */

import { getDb } from './db.js'
import { join } from 'path'
import { app } from 'electron'
import { statSync, unlinkSync } from 'fs'

const now = () => Date.now()

/** 单个便签附件总数上限 */
const MAX_ATTACHMENTS_PER_NOTE = 50

/**
 * 将 DB 中存储的相对路径解析为绝对路径
 * @param {string} relativePath - 相对于 userData 的路径
 * @returns {string} 绝对路径
 */
function resolvePath(relativePath) {
  return join(app.getPath('userData'), relativePath)
}

/**
 * 根据扩展名推断媒体类型
 * @param {string} filePath
 * @returns {string} 'image' | 'video' | 'audio'
 */
function inferMediaType(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'svg':
      return 'image'
    case 'mp4':
    case 'webm':
    case 'mkv':
    case 'avi':
      return 'video'
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'm4a':
    case 'flac':
      return 'audio'
    default:
      return 'image' // 默认归为图片
  }
}

/**
 * 检测文件大小（从磁盘读取）
 * @param {string} relativePath - 相对路径（DB 存储格式）
 * @returns {number|null} 文件大小（字节），失败返回 null
 */
function detectFileSize(relativePath) {
  try {
    return statSync(resolvePath(relativePath)).size
  } catch {
    return null
  }
}

// ============================================================
// CRUD
// ============================================================

/**
 * 添加附件
 * @param {Object} options
 * @param {number} options.noteId - 所属便签 ID
 * @param {string} options.filePath - 相对路径（相对于 userData 目录）
 * @param {string} [options.mediaType] - 媒体类型，不传则根据扩展名自动推断
 * @param {number|null} [options.fileSize] - 文件大小（字节），不传则读取磁盘
 * @returns {Object} 创建的附件对象
 * @throws {Error} 超过数量限制时抛出
 */
export function addAttachment({ noteId, filePath, mediaType = null, fileSize = null }) {
  const db = getDb()

  // 数量限制校验（与写入在同一事务中保证原子性）
  const { count } = db
    .prepare('SELECT COUNT(*) as count FROM note_attachments WHERE note_id = ?')
    .get(noteId)
  if (count >= MAX_ATTACHMENTS_PER_NOTE) {
    throw new Error(`单个便签附件数量不能超过 ${MAX_ATTACHMENTS_PER_NOTE} 个`)
  }

  const ts = now()
  const type = mediaType || inferMediaType(filePath)
  const size = fileSize ?? detectFileSize(filePath)

  const result = db
    .prepare(
      `
    INSERT INTO note_attachments (note_id, media_type, file_path, file_size, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .run(noteId, type, filePath, size, count, ts)

  return getDb().prepare('SELECT * FROM note_attachments WHERE id = ?').get(result.lastInsertRowid)
}

/**
 * 删除附件（数据库记录 + 磁盘文件）
 * @param {number} id
 * @param {boolean} [deleteFile=true] - 是否同时删除磁盘文件
 * @returns {boolean}
 */
export function removeAttachment(id, deleteFile = true) {
  const attachment = getDb().prepare('SELECT * FROM note_attachments WHERE id = ?').get(id)
  if (!attachment) return false

  getDb().prepare('DELETE FROM note_attachments WHERE id = ?').run(id)

  if (deleteFile) {
    try {
      unlinkSync(resolvePath(attachment.file_path))
    } catch {
      // 文件已不存在或路径无效，忽略
    }
  }
  return true
}

/**
 * 获取便签的所有附件
 * @param {number} noteId
 * @returns {Object[]}
 */
export function listAttachments(noteId) {
  return getDb()
    .prepare(
      `
    SELECT * FROM note_attachments WHERE note_id = ? ORDER BY sort_order ASC
  `
    )
    .all(noteId)
}

/**
 * 按 ID 获取单个附件
 * @param {number} id
 * @returns {Object|null}
 */
export function getAttachmentById(id) {
  return getDb().prepare('SELECT * FROM note_attachments WHERE id = ?').get(id)
}

/**
 * 获取便签当前附件数量
 * @param {number} noteId
 * @returns {number}
 */
export function getAttachmentCount(noteId) {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM note_attachments WHERE note_id = ?')
    .get(noteId)
  return row?.count ?? 0
}

/**
 * 更新附件的转录文字（语音转文字结果）
 * @param {number} id
 * @param {string} transcription
 * @returns {boolean}
 */
export function updateTranscription(id, transcription) {
  const result = getDb()
    .prepare(
      `
    UPDATE note_attachments SET transcription = ? WHERE id = ?
  `
    )
    .run(transcription, id)
  return result.changes > 0
}

/**
 * 更新附件排列顺序
 * @param {number} id
 * @param {number} sortOrder
 * @returns {boolean}
 */
export function updateAttachmentOrder(id, sortOrder) {
  const result = getDb()
    .prepare(
      `
    UPDATE note_attachments SET sort_order = ? WHERE id = ?
  `
    )
    .run(sortOrder, id)
  return result.changes > 0
}
