/**
 * 主页面壁纸的物理文件与数据库记录管理。
 * 原图按内容哈希去重；每次裁剪生成独立版本，并通过暂存目录协调文件和 SQLite。
 */
import { app, nativeImage } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { readFile, readdir, rm, writeFile } from 'fs/promises'
import { dirname, extname, join, resolve, sep } from 'path'
import { getDb } from './db-connection.js'

const WALLPAPER_ROOT = 'wallpapers'
const MAX_IMAGE_SIZE = 50 * 1024 * 1024
const MAX_IMAGE_EDGE = 16_384
const MAX_IMAGE_PIXELS = 100_000_000
const SOURCE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp'])
const CROP_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const OPERATION_MANIFEST = 'operation.json'

let storageFaultInjector = null
let wallpaperMutationQueue = Promise.resolve()

/** 仅供 Electron 存储集成测试注入可预测故障。 */
export function setWallpaperStorageFaultInjectorForTests(injector) {
  storageFaultInjector = typeof injector === 'function' ? injector : null
}

function injectStorageFault(point) {
  storageFaultInjector?.(point)
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp'
}

function getRoot() {
  const root = join(app.getPath('userData'), WALLPAPER_ROOT)
  mkdirSync(root, { recursive: true })
  return root
}

function getStagingRoot() {
  const staging = join(getRoot(), '.staging')
  mkdirSync(staging, { recursive: true })
  return staging
}

function toRelative(...parts) {
  return join(WALLPAPER_ROOT, ...parts)
}

export function resolveWallpaperPath(relativePath) {
  const root = resolve(app.getPath('userData'), WALLPAPER_ROOT)
  const target = resolve(app.getPath('userData'), String(relativePath || ''))
  if (target !== root && !target.startsWith(root + sep)) throw new Error('非法的壁纸文件路径')
  return target
}

function normalizeExtension(ext, allowed) {
  const normalized = String(ext || '')
    .replace(/^\./, '')
    .toLowerCase()
  if (!allowed.has(normalized)) throw new Error('不支持的壁纸图片格式')
  return normalized === 'jpeg' ? 'jpg' : normalized
}

function decodeBase64(base64, ext, allowed) {
  const normalizedExt = normalizeExtension(ext, allowed)
  const value = String(base64 || '').replace(/^data:[^;]+;base64,/, '')
  const buffer = Buffer.from(value, 'base64')
  if (buffer.length === 0) throw new Error('壁纸图片内容为空')
  if (buffer.length > MAX_IMAGE_SIZE) throw new Error('壁纸图片不能超过 50MB')
  return { buffer, ext: normalizedExt }
}

function inspectImage(buffer) {
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) throw new Error('无法解析壁纸图片')
  const { width, height } = image.getSize()
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('壁纸图片分辨率过大')
  }
  return { width, height }
}

function createOperationDirectory(type) {
  const directory = join(getStagingRoot(), `${type}-${randomUUID()}`)
  mkdirSync(directory, { recursive: false })
  return directory
}

async function writeOperationFile(directory, name, buffer) {
  const path = join(directory, name)
  await writeFile(path, buffer)
  return path
}

async function writeOperationManifest(directory, manifest) {
  const temporaryPath = join(directory, `${OPERATION_MANIFEST}.tmp`)
  const finalPath = join(directory, OPERATION_MANIFEST)
  await writeFile(temporaryPath, JSON.stringify(manifest), 'utf8')
  renameSync(temporaryPath, finalPath)
}

function removeFileQuietly(path) {
  if (!path) return
  try {
    rmSync(path, { force: true })
  } catch (error) {
    // 下次启动会继续清理 .staging。
    console.warn('[wallpaper] 删除暂存文件失败，将在下次启动重试:', error, { path })
  }
}

async function removeOperationDirectory(directory, faultPoint = null) {
  try {
    if (faultPoint) injectStorageFault(faultPoint)
    await rm(directory, { recursive: true, force: true })
    return true
  } catch (error) {
    console.warn('[wallpaper] 暂存事务目录稍后清理:', error)
    return false
  }
}

function isReferencedPath(table, column, relativePath) {
  return Boolean(
    getDb().prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(relativePath)
  )
}

function restoreQuarantinedFile(stagedPath, relativePath) {
  if (!stagedPath || !existsSync(stagedPath)) return
  const finalPath = resolveWallpaperPath(relativePath)
  if (existsSync(finalPath)) {
    removeFileQuietly(stagedPath)
    return
  }
  mkdirSync(dirname(finalPath), { recursive: true })
  renameSync(stagedPath, finalPath)
}

async function recoverWallpaperOperation(directory, manifest) {
  const db = getDb()
  if (manifest?.version !== 1 || !['save', 'delete'].includes(manifest?.type)) {
    await removeOperationDirectory(directory)
    return
  }

  if (manifest.type === 'save') {
    const committed = Boolean(
      db.prepare('SELECT 1 FROM wallpapers WHERE cropped_path = ?').get(manifest.cropPath)
    )
    if (!committed) {
      if (!isReferencedPath('wallpapers', 'cropped_path', manifest.cropPath)) {
        removeFileQuietly(resolveWallpaperPath(manifest.cropPath))
      }
      if (
        manifest.originalPath &&
        !isReferencedPath('wallpaper_sources', 'original_path', manifest.originalPath)
      ) {
        removeFileQuietly(resolveWallpaperPath(manifest.originalPath))
      }
    }
    await removeOperationDirectory(directory)
    return
  }

  const deleteCommitted = !db
    .prepare('SELECT 1 FROM wallpapers WHERE id = ?')
    .get(manifest.wallpaperId)
  if (!deleteCommitted) {
    restoreQuarantinedFile(join(directory, manifest.cropQuarantine), manifest.cropPath)
    if (manifest.originalPath && manifest.originalQuarantine) {
      restoreQuarantinedFile(join(directory, manifest.originalQuarantine), manifest.originalPath)
    }
  }
  await removeOperationDirectory(directory)
}

function normalizeCrop(crop, sourceSize, targetSize) {
  const values = {
    x: Number(crop?.x),
    y: Number(crop?.y),
    width: Number(crop?.width),
    height: Number(crop?.height),
    scale: Number(crop?.scale)
  }
  if (
    !Number.isFinite(values.x) ||
    !Number.isFinite(values.y) ||
    !Number.isFinite(values.width) ||
    !Number.isFinite(values.height) ||
    values.x < 0 ||
    values.y < 0 ||
    values.width <= 0 ||
    values.height <= 0
  ) {
    throw new Error('无效的壁纸裁剪参数')
  }
  const epsilon = 0.5
  if (
    values.x + values.width > sourceSize.width + epsilon ||
    values.y + values.height > sourceSize.height + epsilon
  ) {
    throw new Error('壁纸裁剪区域超出原图范围')
  }
  return {
    ...values,
    scale: Number.isFinite(values.scale) && values.scale > 0 ? values.scale : 1,
    targetWidth: targetSize.width,
    targetHeight: targetSize.height
  }
}

function selectWallpaper(id) {
  return getDb()
    .prepare(
      `SELECT w.*, s.content_hash, s.original_path, s.mime_type,
              s.width AS original_width, s.height AS original_height, s.file_size AS original_size
       FROM wallpapers w
       JOIN wallpaper_sources s ON s.id = w.source_id
       WHERE w.id = ?`
    )
    .get(id)
}

export function getWallpaperRecord(id) {
  const parsedId = Number(id)
  if (!Number.isInteger(parsedId) || parsedId <= 0) return null
  return selectWallpaper(parsedId) || null
}

export function listWallpaperRecords() {
  return getDb()
    .prepare(
      `SELECT w.*, s.content_hash, s.original_path, s.mime_type,
              s.width AS original_width, s.height AS original_height, s.file_size AS original_size
       FROM wallpapers w
       JOIN wallpaper_sources s ON s.id = w.source_id
       ORDER BY (w.last_used_at IS NOT NULL) DESC, w.last_used_at DESC, w.created_at DESC`
    )
    .all()
}

/** 保存一个新裁剪版本；sourceId 存在时直接复用历史原图。 */
async function saveWallpaperVersionUnlocked({ sourceId, original, cropped, crop }) {
  const db = getDb()
  let source = null
  let originalPayload = null
  let createdSource = false
  let restoredExistingOriginal = false

  if (sourceId !== null && sourceId !== undefined) {
    const parsedSourceId = Number(sourceId)
    if (!Number.isInteger(parsedSourceId) || parsedSourceId <= 0) throw new Error('无效的壁纸原图')
    source = db.prepare('SELECT * FROM wallpaper_sources WHERE id = ?').get(parsedSourceId)
    if (!source || !existsSync(resolveWallpaperPath(source.original_path))) {
      throw new Error('壁纸原图已丢失，无法重新裁剪')
    }
  } else {
    originalPayload = decodeBase64(original?.base64, original?.ext, SOURCE_EXTENSIONS)
    const originalSize = inspectImage(originalPayload.buffer)
    const contentHash = createHash('sha256').update(originalPayload.buffer).digest('hex')
    source = db.prepare('SELECT * FROM wallpaper_sources WHERE content_hash = ?').get(contentHash)

    if (!source) {
      const relativePath = toRelative('originals', `${contentHash}.${originalPayload.ext}`)
      source = {
        id: null,
        content_hash: contentHash,
        original_path: relativePath,
        mime_type: MIME_BY_EXT[originalPayload.ext],
        width: originalSize.width,
        height: originalSize.height,
        file_size: originalPayload.buffer.length
      }
      createdSource = true
    } else if (!existsSync(resolveWallpaperPath(source.original_path))) {
      restoredExistingOriginal = true
    }
  }

  const croppedPayload = decodeBase64(cropped?.base64, cropped?.ext || 'png', CROP_EXTENSIONS)
  const croppedSize = inspectImage(croppedPayload.buffer)
  const normalizedCrop = normalizeCrop(
    crop,
    { width: source.width, height: source.height },
    croppedSize
  )
  const cropFileName = `${Date.now()}-${randomUUID()}.${croppedPayload.ext}`
  const cropRelativePath = toRelative('crops', cropFileName)
  const cropFinalPath = resolveWallpaperPath(cropRelativePath)
  const shouldWriteOriginal = createdSource || restoredExistingOriginal
  const originalFinalPath = shouldWriteOriginal ? resolveWallpaperPath(source.original_path) : null
  const operationDirectory = createOperationDirectory('save')
  const originalStageName = shouldWriteOriginal ? `original.${originalPayload.ext}` : null
  const cropStageName = `crop.${croppedPayload.ext}`
  const manifest = {
    version: 1,
    type: 'save',
    cropPath: cropRelativePath,
    originalPath: shouldWriteOriginal ? source.original_path : null
  }
  let committed = false

  try {
    let originalStagedPath = null
    if (shouldWriteOriginal) {
      originalStagedPath = await writeOperationFile(
        operationDirectory,
        originalStageName,
        originalPayload.buffer
      )
      injectStorageFault('save:after-stage-original')
    }
    const cropStagedPath = await writeOperationFile(
      operationDirectory,
      cropStageName,
      croppedPayload.buffer
    )
    injectStorageFault('save:after-stage-crop')
    await writeOperationManifest(operationDirectory, manifest)
    injectStorageFault('save:after-manifest')

    if (originalStagedPath) {
      mkdirSync(dirname(originalFinalPath), { recursive: true })
      renameSync(originalStagedPath, originalFinalPath)
      injectStorageFault('save:after-first-rename')
    }
    mkdirSync(dirname(cropFinalPath), { recursive: true })
    renameSync(cropStagedPath, cropFinalPath)
    injectStorageFault('save:after-crop-rename')

    const insertedId = db.transaction(() => {
      if (createdSource) {
        injectStorageFault('save:before-source-insert')
        const result = db
          .prepare(
            `INSERT INTO wallpaper_sources
             (content_hash, original_path, mime_type, width, height, file_size, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            source.content_hash,
            source.original_path,
            source.mime_type,
            source.width,
            source.height,
            source.file_size,
            Date.now()
          )
        source.id = Number(result.lastInsertRowid)
      }

      injectStorageFault('save:before-wallpaper-insert')
      const now = Date.now()
      const result = db
        .prepare(
          `INSERT INTO wallpapers
           (source_id, cropped_path, crop_x, crop_y, crop_width, crop_height, scale,
            target_width, target_height, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          source.id,
          cropRelativePath,
          normalizedCrop.x,
          normalizedCrop.y,
          normalizedCrop.width,
          normalizedCrop.height,
          normalizedCrop.scale,
          normalizedCrop.targetWidth,
          normalizedCrop.targetHeight,
          now,
          now
        )
      return Number(result.lastInsertRowid)
    })()
    committed = true
    const record = selectWallpaper(insertedId)
    await removeOperationDirectory(operationDirectory, 'save:final-cleanup')
    return record
  } catch (error) {
    if (!committed) await recoverWallpaperOperation(operationDirectory, manifest)
    throw error
  }
}

export function markWallpaperUsed(id) {
  const record = getWallpaperRecord(id)
  if (!record) throw new Error('壁纸不存在')
  if (!existsSync(resolveWallpaperPath(record.cropped_path))) throw new Error('壁纸文件已丢失')
  getDb().prepare('UPDATE wallpapers SET last_used_at = ? WHERE id = ?').run(Date.now(), record.id)
  return selectWallpaper(record.id)
}

function mimeForPath(path) {
  const ext = extname(path).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] || 'image/png'
}

export async function getWallpaperDataUrl(id, { original = false } = {}) {
  const record = getWallpaperRecord(id)
  if (!record) return null
  const relativePath = original ? record.original_path : record.cropped_path
  try {
    const buffer = await readFile(resolveWallpaperPath(relativePath))
    return `data:${mimeForPath(relativePath)};base64,${buffer.toString('base64')}`
  } catch (error) {
    console.warn('[wallpaper] 读取壁纸文件失败:', error, { id: record.id, relativePath, original })
    return null
  }
}

export function getWallpaperThumbnail(id, maxSize = 240) {
  const record = getWallpaperRecord(id)
  if (!record) return null
  try {
    const image = nativeImage.createFromPath(resolveWallpaperPath(record.cropped_path))
    if (image.isEmpty()) {
      console.warn('[wallpaper] 无法解析壁纸缩略图:', {
        id: record.id,
        relativePath: record.cropped_path
      })
      return null
    }
    const { width, height } = image.getSize()
    const limit = Math.max(80, Math.min(480, Number(maxSize) || 240))
    const resized =
      width >= height
        ? image.resize({ width: Math.min(width, limit), quality: 'good' })
        : image.resize({ height: Math.min(height, limit), quality: 'good' })
    return resized.toDataURL()
  } catch (error) {
    console.warn('[wallpaper] 生成壁纸缩略图失败:', error, {
      id: record.id,
      relativePath: record.cropped_path,
      maxSize
    })
    return null
  }
}

/** 删除一个裁剪版本；最后一个引用消失时一并删除原图。 */
async function deleteWallpaperVersionUnlocked(id, { clearSelectionForWindow = null } = {}) {
  const record = getWallpaperRecord(id)
  if (!record) return false
  const db = getDb()
  const sourceUseCount = db
    .prepare('SELECT COUNT(*) AS count FROM wallpapers WHERE source_id = ?')
    .get(record.source_id).count
  const operationDirectory = createOperationDirectory('delete')
  const cropQuarantine = `crop${extname(record.cropped_path) || '.bin'}`
  const originalQuarantine =
    sourceUseCount === 1 ? `original${extname(record.original_path) || '.bin'}` : null
  const manifest = {
    version: 1,
    type: 'delete',
    wallpaperId: record.id,
    sourceId: record.source_id,
    cropPath: record.cropped_path,
    originalPath: sourceUseCount === 1 ? record.original_path : null,
    cropQuarantine,
    originalQuarantine
  }
  let committed = false

  try {
    await writeOperationManifest(operationDirectory, manifest)
    injectStorageFault('delete:after-manifest')

    const cropFinalPath = resolveWallpaperPath(record.cropped_path)
    if (existsSync(cropFinalPath)) {
      renameSync(cropFinalPath, join(operationDirectory, cropQuarantine))
      injectStorageFault('delete:after-first-rename')
    }
    if (sourceUseCount === 1) {
      const originalFinalPath = resolveWallpaperPath(record.original_path)
      if (existsSync(originalFinalPath)) {
        renameSync(originalFinalPath, join(operationDirectory, originalQuarantine))
        injectStorageFault('delete:after-original-rename')
      }
    }

    db.transaction(() => {
      injectStorageFault('delete:before-wallpaper-delete')
      db.prepare('DELETE FROM wallpapers WHERE id = ?').run(record.id)
      if (sourceUseCount === 1) {
        injectStorageFault('delete:before-source-delete')
        db.prepare('DELETE FROM wallpaper_sources WHERE id = ?').run(record.source_id)
      }
      if (clearSelectionForWindow) {
        db.prepare(
          `DELETE FROM app_settings
           WHERE window_name = ? AND key IN ('active_wallpaper_id', 'wallpaper_enabled')`
        ).run(clearSelectionForWindow)
      }
    })()
    committed = true
    await removeOperationDirectory(operationDirectory, 'delete:final-cleanup')
    return true
  } catch (error) {
    if (!committed) await recoverWallpaperOperation(operationDirectory, manifest)
    throw error
  }
}

/**
 * 删除同一原图的多个裁剪版本时必须串行化。否则两个并发请求都可能在事务外读到
 * sourceUseCount === 2，最终两个版本都删除却没有任何一方清理原图记录和文件。
 */
function enqueueWallpaperMutation(operation) {
  const result = wallpaperMutationQueue.then(operation)
  wallpaperMutationQueue = result.catch((error) => {
    // result 仍原样返回给调用者；这里只吸收内部队列尾部的拒绝，保证后续操作能够继续排队。
    console.error('[wallpaper] 串行存储操作失败:', error)
  })
  return result
}

/**
 * 同一原图的去重判断、文件提交和数据库插入必须作为一段串行变更执行。
 * 否则两个并发保存会同时判断 source 不存在，并竞争同一个哈希原图路径。
 */
export function saveWallpaperVersion(payload) {
  return enqueueWallpaperMutation(() => saveWallpaperVersionUnlocked(payload))
}

export function deleteWallpaperVersion(id, options = {}) {
  const operation = enqueueWallpaperMutation(() => deleteWallpaperVersionUnlocked(id, options))
  return operation
}

export async function cleanupPendingWallpaperFiles() {
  const staging = getStagingRoot()
  const entries = await readdir(staging, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(staging, entry.name)
    if (!entry.isDirectory()) {
      await rm(path, { force: true })
      continue
    }
    try {
      const manifest = JSON.parse(await readFile(join(path, OPERATION_MANIFEST), 'utf8'))
      await recoverWallpaperOperation(path, manifest)
    } catch (error) {
      // 只有完整清单写入后才会移动正式文件；无清单目录可直接视为未开始事务。
      console.warn('[wallpaper] 暂存操作清单缺失或损坏，清理未开始的事务目录:', error, {
        path
      })
      await removeOperationDirectory(path)
    }
  }

  // 清除数据库已不再引用的孤立文件（例如进程在 DB 提交与文件清理之间退出）。
  const db = getDb()
  const referenced = new Set(
    [
      ...db.prepare('SELECT original_path AS path FROM wallpaper_sources').all(),
      ...db.prepare('SELECT cropped_path AS path FROM wallpapers').all()
    ].map((row) => resolveWallpaperPath(row.path))
  )
  for (const directoryName of ['originals', 'crops']) {
    const directory = join(getRoot(), directoryName)
    mkdirSync(directory, { recursive: true })
    const files = await readdir(directory, { withFileTypes: true })
    await Promise.all(
      files
        .filter((entry) => entry.isFile() && !referenced.has(join(directory, entry.name)))
        .map((entry) => rm(join(directory, entry.name), { force: true }))
    )
  }
}
