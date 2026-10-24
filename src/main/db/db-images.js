import { createThumbnailCache } from '../services/thumbnail-cache.js'
import { imageReadService } from '../images/image-read-service.js'
import { startImageDecodeChild, imageFileVersion } from '../images/image-decode-child.js'
import { startImagePreviewRead } from '../images/image-preview-reader.js'
/**
 * db-images.js — 图片附件存储模块（主进程）
 *
 * 职责：
 *   1. 接收渲染进程的图片 Base64 数据并写入磁盘
 *   2. 管理附件存储目录（attachments/images/{noteId}/）
 *   3. 提供图片 CRUD（通过 IPC 调用）
 */

import { dirname, join, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import {
  beginPerformanceOperation,
  recordPerformanceOperation,
  measureSyncPerformance
} from '../logging/operation-performance.js'
import { mkdir, writeFile, unlink, stat, lstat, rm } from 'fs/promises'
import { getDb } from './db-connection.js'
import {
  MAX_ATTACHMENTS_PER_NOTE,
  MAX_IMAGE_BYTES,
  getBase64DecodedSize
} from '../../shared/attachment-rules.js'

const ATTACHMENTS_ROOT = 'attachments'
const STAGING_ROOT = '.attachments-staging'
const OPERATION_MANIFEST = 'operation.json'
const ADDITION_TARGET_MANIFEST = 'target.json'

const now = () => Date.now()

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
}

async function ensureDirAsync(dirPath) {
  await mkdir(dirPath, { recursive: true })
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
function decodeImage(base64Data, ext) {
  const normalizedExt = String(ext || '').toLowerCase()
  if (!IMAGE_EXTENSIONS.has(normalizedExt)) throw new Error('不支持的图片格式')

  const encoded = String(base64Data || '')
  const estimatedSize = getBase64DecodedSize(encoded)
  if (estimatedSize === 0) throw new Error('图片内容为空')
  if (estimatedSize > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 50MB')
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.length === 0) throw new Error('图片内容为空')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 50MB')
  return { buffer, normalizedExt }
}

/** 先异步写入暂存区，避免大文件写入阻塞 Electron 主线程。 */
export async function stageImage(base64Data, ext) {
  const { buffer, normalizedExt } = decodeImage(base64Data, ext)
  const stagingDir = join(app.getPath('userData'), STAGING_ROOT)
  await ensureDirAsync(stagingDir)
  const fileName = `${now()}-${randomUUID()}.${normalizedExt}`
  const operationDirectory = join(stagingDir, `add-${randomUUID()}`)
  await ensureDirAsync(operationDirectory)
  const pendingPath = join(operationDirectory, 'payload')
  try {
    writeOperationManifest(operationDirectory, { version: 1, type: 'image-add' })
    await writeFile(pendingPath, buffer)
    const fileSize = (await stat(pendingPath)).size
    return { pendingPath, fileName, fileSize, operationDirectory }
  } catch (error) {
    await rm(operationDirectory, { recursive: true, force: true })
    throw error
  }
}

/** 在数据库事务内执行同卷重命名；大文件内容此前已经异步写完。 */
export function commitStagedImage(noteId, staged) {
  if (!Number.isInteger(Number(noteId)) || Number(noteId) <= 0) throw new Error('无效的便签 ID')
  if (!staged?.pendingPath || !staged?.fileName) throw new Error('无效的暂存图片')
  const root = getAttachmentsRoot()
  const subDir = join(root, 'images', String(noteId))
  ensureDir(subDir)
  const filePath = join(subDir, staged.fileName)
  const relativePath = join(ATTACHMENTS_ROOT, 'images', String(noteId), staged.fileName)
  if (!staged.operationDirectory) throw new Error('暂存图片缺少恢复目录')
  writeOperationManifest(
    staged.operationDirectory,
    {
      version: 1,
      type: 'image-add-target',
      relativePath
    },
    ADDITION_TARGET_MANIFEST
  )
  renameSync(staged.pendingPath, filePath)
  return { relativePath, fileSize: staged.fileSize }
}

export async function cleanupStagedImage(staged) {
  if (!staged?.pendingPath && !staged?.operationDirectory) return
  try {
    if (staged.operationDirectory) {
      await rm(staged.operationDirectory, { recursive: true, force: true })
    } else {
      await unlink(staged.pendingPath)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[images] 清理暂存图片失败:', error)
  }
}

function writeOperationManifest(operationDirectory, manifest, fileName = OPERATION_MANIFEST) {
  const temporaryPath = join(operationDirectory, `${fileName}.tmp`)
  const finalPath = join(operationDirectory, fileName)
  writeFileSync(temporaryPath, JSON.stringify(manifest), 'utf8')
  renameSync(temporaryPath, finalPath)
}

/** 保存编辑草稿时先把待删除文件移入暂存区，数据库回滚时可以原位恢复。 */
export function stageImageDeletion(relativePath) {
  const originalPath = resolveImagePath(relativePath)
  if (!existsSync(originalPath)) {
    console.warn('[images] 待删除附件文件已丢失:', { relativePath })
    return { missing: true, originalPath }
  }
  const stagingDir = join(app.getPath('userData'), STAGING_ROOT)
  ensureDir(stagingDir)
  const operationDirectory = join(stagingDir, `delete-${randomUUID()}`)
  mkdirSync(operationDirectory)
  try {
    writeOperationManifest(operationDirectory, {
      version: 1,
      type: 'image-delete',
      relativePath
    })
    const pendingPath = join(operationDirectory, 'payload')
    renameSync(originalPath, pendingPath)
    return { pendingPath, originalPath, operationDirectory }
  } catch (error) {
    rmSync(operationDirectory, { recursive: true, force: true })
    throw error
  }
}

/** 恢复一次尚未提交的附件删除。 */
export function restoreStagedImageDeletion(staged) {
  if (!staged?.pendingPath || !existsSync(staged.pendingPath)) return
  try {
    ensureDir(dirname(staged.originalPath))
    renameSync(staged.pendingPath, staged.originalPath)
    if (staged.operationDirectory) {
      rmSync(staged.operationDirectory, { recursive: true, force: true })
    }
  } catch (error) {
    console.warn('[images] 恢复待删除附件失败:', error)
  }
}

/**
 * 删除单张图片文件
 * @param {string} relativePath
 * @returns {boolean}
 */
export async function deleteImageFile(relativePath) {
  try {
    await unlink(resolveImagePath(relativePath))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    console.warn('[images] 删除附件文件失败:', error, { relativePath })
    return false
  }
}

/**
 * 读取图片为 Base64（供渲染进程预览）
 * @param {string} relativePath
 * @returns {string|null} 带 data:image/xxx;base64, 前缀的完整 data URL
 */
export async function getImageBase64(relativePath) {
  const finish = beginPerformanceOperation('image', 'original.read')
  const metrics = {}
  try {
    const source = captureStoredImageSource(relativePath, 'original')
    const value = await imageOriginalPort.request(source.key, source)
    if (!value || !imageSourceCurrent(source)) return null
    const buffer = value.payload
    metrics.bytes = buffer.length
    return measureSyncPerformance(
      'image',
      'original.encode',
      () => `data:${value.mime};base64,${buffer.toString('base64')}`,
      () => ({ bytes: buffer.length })
    )
  } catch (error) {
    metrics.errors = 1
    console.warn('[images] 读取附件原图失败:', error, { relativePath })
    return null
  } finally {
    finish(metrics)
  }
}

// The queue keeps only paths and source identities. One owned child reads/admits/decodes
// the same bytes; no full-resolution NativeImage is created in the product main process.
const thumbnailCache = createThumbnailCache()
const pendingThumbnails = new Map()
const imageSourceCurrent = (source) =>
  imageReadService.isCurrent(source.generation) &&
  source.profile === resolve(app.getPath('userData'))

const imageDecodePort = imageReadService.createPort({
  name: 'stored-derived',
  start: startStoredImageDecode,
  isCurrent: imageSourceCurrent,
  onInvalidate() {
    thumbnailCache.clear()
  }
})
const imageOriginalPort = imageReadService.createPort({
  name: 'stored-original',
  start: (source) => startImagePreviewRead(source, { app, purpose: 'original' }),
  isCurrent: imageSourceCurrent
})

function captureStoredImageSource(relativePath, purpose, size) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 32767)
    throw Object.assign(new Error('图片路径元数据超限或类型无效'), {
      code: 'IMAGE_SOURCE_METADATA_BUDGET'
    })
  const source = {
    kind: 'stored',
    profile: resolve(app.getPath('userData')),
    generation: imageReadService.generation(),
    path: resolveImagePath(relativePath),
    size
  }
  if (source.profile.length > 32767 || source.path.length > 32767)
    throw Object.assign(new Error('图片完整路径超过 Windows 上限'), {
      code: 'IMAGE_SOURCE_METADATA_BUDGET'
    })
  source.key = JSON.stringify([source.profile, source.generation, source.path, purpose, size])
  if (source.key.length > 128 * 1024)
    throw Object.assign(new Error('图片请求键超过元数据预算'), {
      code: 'IMAGE_SOURCE_METADATA_BUDGET'
    })
  return source
}

function startStoredImageDecode(source) {
  let child
  let cancelled = false
  let resolveClosed, rejectClosed
  const closed = new Promise((done, reject) => {
    resolveClosed = done
    rejectClosed = reject
  })
  const result = (async () => {
    const finish = beginPerformanceOperation('image', 'thumbnail.decode')
    const metrics = {}
    try {
      const before = await lstat(source.path, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n || cancelled || !imageSourceCurrent(source))
        return null
      metrics.bytes = Number(before.size)
      const cacheKey = source.key + ':' + imageFileVersion(before)
      const cached = thumbnailCache.get(cacheKey)
      if (cached !== undefined) {
        metrics.cacheHits = 1
        return JSON.parse(cached)
      }
      metrics.cacheMisses = 1
      child = startImageDecodeChild(source, {
        app,
        onDiagnostic: (detail) => {
          if (!['IMAGE_DECODER_STARTED', 'IMAGE_DECODER_CLOSED'].includes(detail.code))
            console.warn('[images] 图片解码子进程:', detail)
        }
      })
      if (cancelled) child.cancel()
      const value = await child.result
      await child.closed
      if (!value || cancelled || !imageSourceCurrent(source)) return null
      const after = await lstat(source.path, { bigint: true })
      if (!after.isFile() || imageFileVersion(after) !== value.version) return null
      Object.assign(metrics, {
        width: value.width,
        height: value.height,
        pixels: value.width * value.height
      })
      // The result is retained once, within the existing 16MiB / 128-entry LRU.
      thumbnailCache.set(source.key + ':' + value.version, JSON.stringify(value))
      return value
    } catch (error) {
      metrics.errors = 1
      console.warn('[images] 图片派生读取失败:', error, { path: source.path })
      child?.cancel()
      return null
    } finally {
      finish(metrics)
      try {
        const closure = child ? await child.closed : undefined
        resolveClosed(closure)
      } catch (error) {
        rejectClosed(error)
      }
    }
  })()
  return {
    result,
    closed,
    cancel() {
      cancelled = true
      child?.cancel()
    }
  }
}

function requestImageDecode(relativePath, size) {
  try {
    const source = captureStoredImageSource(relativePath, 'derived', size)
    return {
      key: source.key,
      promise: imageDecodePort.request(source.key, source)
    }
  } catch (error) {
    console.warn('[images] 图片读取来源无效:', error)
    return { key: null, promise: Promise.resolve(null) }
  }
}

/** Async internally; preload has always exposed a Promise. Shares the default thumbnail job. */
export function getImageDimensions(relativePath) {
  const finish = beginPerformanceOperation('image', 'dimensions')
  return requestImageDecode(relativePath, 240).promise.then((value) => {
    finish(
      value
        ? { width: value.width, height: value.height, pixels: value.width * value.height }
        : { errors: 1 }
    )
    return value ? { width: value.width, height: value.height } : null
  })
}

export function invalidateImageDecodes() {
  imageReadService.invalidate()
}

export function suspendImageDecodes(owner) {
  return imageReadService.suspend(owner)
}

export function resumeImageDecodes(owner) {
  return imageReadService.resume(owner)
}

export function disposeImageDecodes() {
  return imageReadService.dispose()
}

function requestThumbnailDecode(relativePath, maxSize) {
  const size = Math.floor(Math.max(32, Math.min(512, Number(maxSize) || 240)))
  const { key, promise } = requestImageDecode(relativePath, size)
  if (pendingThumbnails.has(key)) {
    recordPerformanceOperation('image', 'thumbnail.deduplicated')
    return pendingThumbnails.get(key)
  }
  const finishWait = beginPerformanceOperation('image', 'thumbnail.queue')
  const queueDepth = pendingThumbnails.size + 1
  const pending = {
    details: promise
      .then((value) => {
        finishWait({ queueDepth })
        return value ? { data: value.data, width: value.width, height: value.height } : null
      })
      .finally(() => pendingThumbnails.delete(key)),
    thumbnail: null
  }
  pendingThumbnails.set(key, pending)
  return pending
}

/** One derived read supplies both the bounded thumbnail and original geometry. */
export function getImageThumbnailDetails(relativePath, maxSize = 240) {
  return requestThumbnailDecode(relativePath, maxSize).details
}

export function getImageThumbnail(relativePath, maxSize = 240) {
  const pending = requestThumbnailDecode(relativePath, maxSize)
  // Retain the legacy API's same-key Promise identity as well as its string result.
  pending.thumbnail ||= pending.details.then((value) => value?.data || null)
  return pending.thumbnail
}

// ============================================================
// DB CRUD（note_attachments 表）
// ============================================================

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

  const note = db.prepare('SELECT id FROM notes WHERE id = ? AND is_deleted = 0').get(noteId)
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
 * 原子删除一张图片：先隔离文件，数据库提交后再清理；数据库失败时恢复原文件。
 */
export async function deleteImageRecordAndFile(id) {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT a.*, n.content,
              (SELECT COUNT(*) FROM note_attachments WHERE note_id = a.note_id) AS attachment_count
       FROM note_attachments a
       INNER JOIN notes n ON n.id = a.note_id
       WHERE a.id = ? AND n.is_deleted = 0`
    )
    .get(id)
  if (!row) return false
  if (!String(row.content || '').trim() && Number(row.attachment_count) <= 1) {
    throw new Error('纯图片便签至少需要保留一张图片')
  }

  const staged = stageImageDeletion(row.file_path)
  try {
    db.transaction(() => {
      const deleted = db.prepare('DELETE FROM note_attachments WHERE id = ?').run(row.id)
      if (deleted.changes !== 1) throw new Error('附件记录已发生变化')
      db.prepare('UPDATE notes SET updated_at = ? WHERE id = ? AND is_deleted = 0').run(
        now(),
        row.note_id
      )
    })()
  } catch (error) {
    restoreStagedImageDeletion(staged)
    throw error
  }

  await cleanupStagedImage(staged)
  return true
}

/**
 * 彻底删除一张便签及其附件。
 * 所有附件先移入可恢复暂存区；数据库提交后再清理，失败或异常退出时由恢复流程处理。
 */
export async function purgeNoteAndFiles(noteId) {
  const parsedNoteId = Number(noteId)
  if (!Number.isInteger(parsedNoteId) || parsedNoteId <= 0) throw new Error('无效的便签 ID')

  const db = getDb()
  const note = db.prepare('SELECT id FROM notes WHERE id = ?').get(parsedNoteId)
  if (!note) return false

  const attachments = db
    .prepare('SELECT file_path FROM note_attachments WHERE note_id = ? ORDER BY id ASC')
    .all(parsedNoteId)
  const stagedDeletions = []

  try {
    for (const attachment of attachments) {
      stagedDeletions.push(stageImageDeletion(attachment.file_path))
    }

    db.transaction(() => {
      const deleted = db.prepare('DELETE FROM notes WHERE id = ?').run(parsedNoteId)
      if (deleted.changes !== 1) throw new Error('便签记录已发生变化')
    })()
  } catch (error) {
    for (const staged of stagedDeletions.reverse()) restoreStagedImageDeletion(staged)
    throw error
  }

  await Promise.all(stagedDeletions.map(cleanupStagedImage))
  return true
}

/**
 * 获取便签的所有图片附件
 * @param {number} noteId
 * @returns {Object[]}
 */
export function listImageRecords(noteId) {
  return getDb()
    .prepare(
      `SELECT a.* FROM note_attachments a
       INNER JOIN notes n ON n.id = a.note_id
       WHERE a.note_id = ? AND n.is_deleted = 0
       ORDER BY a.sort_order ASC`
    )
    .all(noteId)
}

/**
 * 获取图片附件总数
 * @param {number} noteId
 * @returns {number}
 */
export function getImageCount(noteId) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM note_attachments a
       INNER JOIN notes n ON n.id = a.note_id
       WHERE a.note_id = ? AND n.is_deleted = 0`
    )
    .get(noteId)
  return row?.count ?? 0
}
