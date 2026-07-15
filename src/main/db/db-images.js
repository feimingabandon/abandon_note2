/**
 * db-images.js — 图片附件存储模块（主进程）
 *
 * 职责：
 *   1. 接收渲染进程的图片 Base64 数据并写入磁盘
 *   2. 管理附件存储目录（attachments/images/{noteId}/）
 *   3. 提供图片 CRUD（通过 IPC 调用）
 */

import { join, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { app, nativeImage } from 'electron'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync, readFileSync, rmSync } from 'fs'
import { getDb } from './db.js'

const ATTACHMENTS_ROOT = 'attachments'

const now = () => Date.now()

/** 单图片最大 50MB */
const MAX_IMAGE_SIZE = 50 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
}

/** 获取附件根目录绝对路径 */
function getAttachmentsRoot() {
  const root = join(app.getPath('userData'), ATTACHMENTS_ROOT)
  ensureDir(root)
  return root
}

/**
 * 解析相对路径为绝对路径
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveImagePath(relativePath) {
  const root = resolve(app.getPath('userData'), ATTACHMENTS_ROOT)
  const target = resolve(app.getPath('userData'), String(relativePath || ''))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('非法的附件路径')
  }
  return target
}

/**
 * 保存 Base64 图片到磁盘
 * @param {number} noteId
 * @param {string} base64Data - 不含 data:xxx;base64, 前缀的纯 Base64
 * @param {string} ext - 文件扩展名（不含点），如 'png'
 * @returns {{ relativePath: string, fileSize: number }}
 */
export function saveImage(noteId, base64Data, ext) {
  if (!Number.isInteger(Number(noteId)) || Number(noteId) <= 0) throw new Error('无效的便签 ID')
  const normalizedExt = String(ext || '').toLowerCase()
  if (!IMAGE_EXTENSIONS.has(normalizedExt)) throw new Error('不支持的图片格式')

  const buffer = Buffer.from(String(base64Data || ''), 'base64')
  if (buffer.length === 0) throw new Error('图片内容为空')
  if (buffer.length > MAX_IMAGE_SIZE) throw new Error('单张图片不能超过 50MB')

  const root = getAttachmentsRoot()
  const subDir = join(root, 'images', String(noteId))
  ensureDir(subDir)

  const fileName = `${now()}-${randomUUID()}.${normalizedExt}`
  const filePath = join(subDir, fileName)

  writeFileSync(filePath, buffer)

  const fileSize = statSync(filePath).size
  const relativePath = join(ATTACHMENTS_ROOT, 'images', String(noteId), fileName)

  return { relativePath, fileSize }
}

/**
 * 删除单张图片文件
 * @param {string} relativePath
 * @returns {boolean}
 */
export function deleteImageFile(relativePath) {
  try {
    unlinkSync(resolveImagePath(relativePath))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    return false
  }
}

/**
 * 删除某个便签的全部图片（物理删除目录）
 * @param {number} noteId
 */
export function deleteNoteImages(noteId) {
  const dir = join(getAttachmentsRoot(), 'images', String(noteId))
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    // 目录不存在或无法删除，忽略
  }
}

/**
 * 读取图片为 Base64（供渲染进程预览）
 * @param {string} relativePath
 * @returns {string|null} 带 data:image/xxx;base64, 前缀的完整 data URL
 */
export function getImageBase64(relativePath) {
  try {
    const absPath = resolveImagePath(relativePath)
    const buffer = readFileSync(absPath)
    const ext = relativePath.split('.').pop()?.toLowerCase() || 'png'
    const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
    return `data:image/${mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/** 生成列表展示用缩略图，原图只在大图预览时读取。 */
export function getImageThumbnail(relativePath, maxSize = 240) {
  try {
    const image = nativeImage.createFromPath(resolveImagePath(relativePath))
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    const limit = Math.max(32, Math.min(512, Number(maxSize) || 240))
    const resized = width >= height
      ? image.resize({ width: Math.min(width, limit), quality: 'good' })
      : image.resize({ height: Math.min(height, limit), quality: 'good' })
    return resized.toDataURL()
  } catch {
    return null
  }
}

// ============================================================
// DB CRUD（note_attachments 表）
// ============================================================

/** 单个便签附件上限 */
const MAX_ATTACHMENTS_PER_NOTE = 50

/**
 * 添加图片附件记录到数据库
 * @param {Object} options
 * @param {number} options.noteId
 * @param {string} options.filePath - 相对路径
 * @param {number} options.fileSize
 * @returns {Object} 附件对象
 */
export function addImageRecord({ noteId, filePath, fileSize }) {
  const db = getDb()

  const note = db.prepare('SELECT id FROM notes WHERE id = ?').get(noteId)
  if (!note) throw new Error('便签不存在')

  const { count } = db
    .prepare('SELECT COUNT(*) as count FROM note_attachments WHERE note_id = ?')
    .get(noteId)
  if (count >= MAX_ATTACHMENTS_PER_NOTE) {
    throw new Error(`单个便签图片数量不能超过 ${MAX_ATTACHMENTS_PER_NOTE} 张`)
  }

  const ts = now()
  const result = db
    .prepare(
      `INSERT INTO note_attachments (note_id, file_path, file_size, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(noteId, filePath, fileSize, count, ts)
  db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(ts, noteId)

  return db.prepare('SELECT * FROM note_attachments WHERE id = ?').get(result.lastInsertRowid)
}

/**
 * 删除图片附件记录
 * @param {number} id
 * @returns {boolean}
 */
export function removeImageRecord(id) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM note_attachments WHERE id = ?').get(id)
  if (!row) return false
  db.transaction(() => {
    db.prepare('DELETE FROM note_attachments WHERE id = ?').run(id)
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(now(), row.note_id)
  })()
  return true
}

/**
 * 获取便签的所有图片附件
 * @param {number} noteId
 * @returns {Object[]}
 */
export function listImageRecords(noteId) {
  return getDb()
    .prepare('SELECT * FROM note_attachments WHERE note_id = ? ORDER BY sort_order ASC')
    .all(noteId)
}

/**
 * 获取图片附件总数
 * @param {number} noteId
 * @returns {number}
 */
export function getImageCount(noteId) {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM note_attachments WHERE note_id = ?')
    .get(noteId)
  return row?.count ?? 0
}
