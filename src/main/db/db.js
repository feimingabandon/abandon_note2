/**
 * db.js — 数据库模块（主进程）
 *
 * 职责：
 *   1. 初始化 SQLite 数据库连接（使用 better-sqlite3）
 *   2. 提供 app_settings 表的 CRUD 操作
 *   3. 提供窗口几何信息（位置/尺寸）的持久化读写
 *   4. 创建首个正式版本的最终数据库结构
 *
 * 数据库文件存储在 Electron 的 userData 目录下，名为 app.db
 * 使用 WAL 模式提升并发读写性能
 */

import Database from 'better-sqlite3' // SQLite3 同步驱动，适合 Electron 主进程
import { dirname, join } from 'path' // Node.js 路径拼接工具
import { app } from 'electron' // Electron app 模块，用于获取用户数据目录
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs' // 文件系统操作
import { readdir, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import { clearDb, getDb as getConnectionDb, setDb } from './db-connection.js'
import { createDatabaseSchema } from './db-schema.js'
import { createDatabaseMigrationBackup } from './db-migration-backup.js'
import { resolveImagePath } from './db-images.js'

/** 数据库实例引用，整个应用生命周期内复用 */
let db = null

/**
 * 初始化数据库
 * - 在 userData 目录下创建/打开 app.db
 * - 启用 WAL (Write-Ahead Logging) 模式，提升写入性能
 * - 一次性创建首个正式版本的完整数据库结构
 * - 写入 SQLite user_version，供正式发布后的显式迁移使用
 */
export function initDatabase() {
  const dbPath = join(app.getPath('userData'), 'app.db')
  const isNewDatabase = !existsSync(dbPath)
  const connection = new Database(dbPath)
  try {
    connection.pragma('journal_mode = WAL')
    connection.pragma('synchronous = NORMAL')
    connection.pragma('cache_size = -8000')
    connection.pragma('foreign_keys = ON')
    createDatabaseMigrationBackup(connection, dbPath)
    createDatabaseSchema(connection)
    db = connection
    setDb(connection)
    return { isNewDatabase }
  } catch (error) {
    connection.close()
    db = null
    clearDb()
    throw error
  }
}

export function closeDatabase() {
  if (db) {
    db.close()
    db = null
    clearDb()
  }
}

/** 获取指定窗口的全部持久化设置，供共享 schema 一次性解析完整快照。 */
export function getAllSettings(windowName) {
  return db
    .prepare(
      'SELECT type, key, value, remark, created_at, updated_at FROM app_settings WHERE window_name = ?'
    )
    .all(windowName)
}

/**
 * 在一个事务中批量写入设置。
 * @param {string} windowName
 * @param {Array<{type: string, key: string, value: unknown, remark?: string}>} settings
 */
export function setSettingsBatch(windowName, settings) {
  if (!Array.isArray(settings) || settings.length === 0) return

  const upsert = db.prepare(`
    INSERT INTO app_settings (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(window_name, key) DO UPDATE SET
      value = excluded.value,
      type = excluded.type,
      remark = excluded.remark,
      updated_at = excluded.updated_at
  `)
  const writeAll = db.transaction((rows) => {
    const now = Date.now()
    rows.forEach(({ type, key, value, remark = '' }) => {
      upsert.run(windowName, type, key, value == null ? null : String(value), remark, now, now)
    })
  })
  writeAll(settings)
}

/** 清空 app_settings；业务表和附件目录不受影响。 */
export function clearAllSettings() {
  return db.prepare('DELETE FROM app_settings').run().changes
}

/** 只清空一个窗口/视图作用域，应用级设置和其他视图不受影响。 */
export function clearSettings(windowName) {
  return db.prepare('DELETE FROM app_settings WHERE window_name = ?').run(windowName).changes
}

const ATTACHMENT_OPERATION_MANIFEST = 'operation.json'
const ATTACHMENT_OPERATION_COMMITTED = 'committed'

function writeAttachmentOperationManifest(operationDirectory, manifest) {
  const temporaryPath = join(operationDirectory, `${ATTACHMENT_OPERATION_MANIFEST}.tmp`)
  const finalPath = join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST)
  writeFileSync(temporaryPath, JSON.stringify(manifest), 'utf8')
  renameSync(temporaryPath, finalPath)
}

function businessDataExists() {
  const row = getConnectionDb()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM notes) +
         (SELECT COUNT(*) FROM note_templates) +
         (SELECT COUNT(*) FROM tags) AS total`
    )
    .get()
  return Number(row?.total) > 0
}

async function recoverImageDeletionOperation(operationDirectory) {
  const manifestPath = join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.version !== 1 || manifest?.type !== 'image-delete') return false

  const pendingPath = join(operationDirectory, 'payload')
  if (!existsSync(pendingPath)) {
    await rm(operationDirectory, { recursive: true, force: true })
    return true
  }

  const row = getConnectionDb()
    .prepare('SELECT 1 FROM note_attachments WHERE file_path = ? LIMIT 1')
    .get(manifest.relativePath)
  if (!row) {
    await rm(operationDirectory, { recursive: true, force: true })
    return true
  }

  const originalPath = resolveImagePath(manifest.relativePath)
  if (existsSync(originalPath)) {
    console.warn('[images] 附件原路径已存在，保留待恢复文件:', operationDirectory)
    return true
  }
  mkdirSync(dirname(originalPath), { recursive: true })
  renameSync(pendingPath, originalPath)
  await rm(operationDirectory, { recursive: true, force: true })
  return true
}

async function recoverImageAdditionOperation(operationDirectory) {
  const manifestPath = join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.version !== 1 || manifest?.type !== 'image-add') return false

  const pendingPath = join(operationDirectory, 'payload')
  if (existsSync(pendingPath)) {
    // 文件仍在暂存区，说明尚未进入数据库事务，可以直接丢弃。
    await rm(operationDirectory, { recursive: true, force: true })
    return true
  }

  const targetManifestPath = join(operationDirectory, 'target.json')
  if (!existsSync(targetManifestPath)) {
    await rm(operationDirectory, { recursive: true, force: true })
    return true
  }
  const target = JSON.parse(readFileSync(targetManifestPath, 'utf8'))
  if (target?.version !== 1 || target?.type !== 'image-add-target' || !target.relativePath) {
    throw new Error('附件新增恢复目标无效')
  }

  const finalPath = resolveImagePath(target.relativePath)
  const row = getConnectionDb()
    .prepare('SELECT 1 FROM note_attachments WHERE file_path = ? LIMIT 1')
    .get(target.relativePath)
  // 重命名成功但事务未提交时，最终文件没有数据库记录，必须清理孤儿文件。
  if (!row && existsSync(finalPath)) await rm(finalPath, { force: true })
  await rm(operationDirectory, { recursive: true, force: true })
  return true
}

async function recoverAttachmentStagingDirectory(stagingDirectory) {
  const entries = await readdir(stagingDirectory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(stagingDirectory, entry.name)
    if (entry.isDirectory()) {
      try {
        if (await recoverImageAdditionOperation(path)) continue
        if (await recoverImageDeletionOperation(path)) continue
      } catch (error) {
        console.warn('[images] 恢复暂存附件失败，保留现场:', error)
        continue
      }
      console.warn('[images] 发现未知附件暂存目录，保留现场:', path)
      continue
    }

    await rm(path, { force: true })
  }
}

async function recoverResetOperation(operationDirectory) {
  const payloadPath = join(operationDirectory, 'attachments')
  const attachmentsDir = join(app.getPath('userData'), 'attachments')
  const committed = existsSync(join(operationDirectory, ATTACHMENT_OPERATION_COMMITTED))

  if (committed || !businessDataExists() || !existsSync(payloadPath)) {
    await rm(operationDirectory, { recursive: true, force: true })
    return
  }
  if (existsSync(attachmentsDir)) {
    console.warn('[clearNoteData] 附件目录已重新创建，保留待恢复目录:', operationDirectory)
    return
  }
  renameSync(payloadPath, attachmentsDir)
  await rm(operationDirectory, { recursive: true, force: true })
}

/** 启动时恢复未提交的附件操作，并清理已经提交的暂存数据。 */
export async function cleanupPendingAttachmentDirs() {
  const userDataDir = app.getPath('userData')
  const entries = await readdir(userDataDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.attachments-staging') {
      await recoverAttachmentStagingDirectory(join(userDataDir, entry.name))
      continue
    }
    if (entry.name.startsWith('.attachments-deleting-reset-')) {
      await recoverResetOperation(join(userDataDir, entry.name))
    }
  }
}

/** 清空便签业务数据；保留 app_settings 和开机自启等系统状态。 */
export async function clearNoteData() {
  const attachmentsDir = join(app.getPath('userData'), 'attachments')
  const operationDirectory = join(
    app.getPath('userData'),
    `.attachments-deleting-reset-${Date.now()}-${process.pid}-${randomUUID()}`
  )
  const pendingDeleteDir = join(operationDirectory, 'attachments')
  let attachmentsMoved = false

  // 同卷目录重命名是常量时间操作，先将旧附件与后续可能创建的新目录隔离。
  if (existsSync(attachmentsDir)) {
    mkdirSync(operationDirectory)
    writeAttachmentOperationManifest(operationDirectory, {
      version: 1,
      type: 'reset'
    })
    renameSync(attachmentsDir, pendingDeleteDir)
    attachmentsMoved = true
  }

  try {
    // 显式清理关联表，保持操作顺序清晰，也避免把大量级联工作留到最后一步。
    db.transaction(() => {
      db.prepare('DELETE FROM template_tags').run()
      db.prepare('DELETE FROM note_tags').run()
      db.prepare('DELETE FROM note_attachments').run()
      db.prepare('DELETE FROM note_templates').run()
      db.prepare('DELETE FROM notes').run()
      db.prepare('DELETE FROM tags').run()
    })()
  } catch (error) {
    // 数据库未提交时恢复附件目录，使数据库记录和文件仍保持一致。
    if (attachmentsMoved && !existsSync(attachmentsDir)) {
      try {
        renameSync(pendingDeleteDir, attachmentsDir)
        rmSync(operationDirectory, { recursive: true, force: true })
      } catch (restoreError) {
        console.error('[clearNoteData] 恢复附件目录失败:', restoreError)
      }
    }
    throw error
  }

  // 递归删除移出主路径后异步执行，不阻塞 Electron 主线程，也不占用 SQLite 事务。
  if (attachmentsMoved) {
    try {
      writeFileSync(join(operationDirectory, ATTACHMENT_OPERATION_COMMITTED), '', 'utf8')
    } catch (error) {
      console.error('[clearNoteData] 写入附件清理提交标记失败:', error)
    }
    try {
      await rm(operationDirectory, { recursive: true, force: true })
    } catch (error) {
      console.error('[clearNoteData] 清理待删除附件目录失败:', error)
      // 数据库已经成功提交，不能再向 UI 报告“清空失败”。遗留目录会在下次启动重试。
    }
  }
}

/**
 * 获取数据库实例（供其他 db-*.js 模块使用）
 * @returns {import('better-sqlite3').Database} SQLite 数据库连接实例
 */
export function getDb() {
  return db
}
