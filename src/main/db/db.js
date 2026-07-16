/**
 * db.js — 数据库模块（主进程）
 *
 * 职责：
 *   1. 初始化 SQLite 数据库连接（使用 better-sqlite3）
 *   2. 提供 app_settings 表的 CRUD 操作
 *   3. 提供窗口几何信息（位置/尺寸）的持久化读写
 *   4. 自动迁移旧表结构（新增 remark 列等）
 *
 * 数据库文件存储在 Electron 的 userData 目录下，名为 app.db
 * 使用 WAL 模式提升并发读写性能
 */

import Database from 'better-sqlite3' // SQLite3 同步驱动，适合 Electron 主进程
import { join } from 'path' // Node.js 路径拼接工具
import { app } from 'electron' // Electron app 模块，用于获取用户数据目录
import { existsSync, renameSync } from 'fs' // 文件系统操作
import { readdir, rm } from 'fs/promises'

/** 数据库实例引用，整个应用生命周期内复用 */
let db = null

/**
 * 初始化数据库
 * - 在 userData 目录下创建/打开 app.db
 * - 启用 WAL (Write-Ahead Logging) 模式，提升写入性能
 * - 自动检测旧表结构，若缺少 window_name 字段则删除旧表重建
 * - 创建 app_settings 表（如果不存在）
 * - 创建便签模块所需所有表（note_templates、notes 等）
 */
export function initDatabase() {
  const dbPath = join(app.getPath('userData'), 'app.db')
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -8000')
  db.pragma('foreign_keys = ON')

  // 旧表兼容性处理
  let tableInfo = db.prepare("PRAGMA table_info('app_settings')").all()
  const hasWindowName = tableInfo.some((col) => col.name === 'window_name')
  if (tableInfo.length > 0 && !hasWindowName) {
    db.exec('DROP TABLE app_settings')
    tableInfo = []
  }

  // 创建 app_settings 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      window_name TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      remark TEXT DEFAULT '',
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (window_name, key)
    );
  `)

  // 增量迁移：为已存在的表添加 remark 列
  const hasRemark = tableInfo.some((col) => col.name === 'remark')
  if (tableInfo.length > 0 && !hasRemark) {
    db.exec("ALTER TABLE app_settings ADD COLUMN remark TEXT DEFAULT ''")
  }

  // 便签模块建表（在 app_settings 之后，可安全重复调用）
  initNotesTables()

  // 早期版本未启用外键，可能遗留已不存在便签或标签的关联记录。
  // 先清理存量脏数据，之后由 foreign_keys 保证新增写入和删除级联的一致性。
  db.prepare(
    `DELETE FROM note_tags
     WHERE note_id NOT IN (SELECT id FROM notes)
        OR tag_name NOT IN (SELECT name FROM tags)`
  ).run()
}

export function closeDatabase() {
  if (db) {
    db.close()
    db = null
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

/** 删除所有窗口下的旧设置键，供不再持久化的设置做一次性兼容清理。 */
export function deleteSettingsByKey(key) {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
}

/** 后台重试清理先前已与数据库解绑、但因文件占用等原因遗留的附件目录。 */
export async function cleanupPendingAttachmentDirs() {
  const userDataDir = app.getPath('userData')
  const entries = await readdir(userDataDir, { withFileTypes: true })
  const pendingDirs = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      (entry.name.startsWith('.attachments-deleting-') || entry.name === '.attachments-staging')
  )
  await Promise.all(
    pendingDirs.map((entry) => rm(join(userDataDir, entry.name), { recursive: true, force: true }))
  )
}

/** 清空便签业务数据；保留 app_settings 和开机自启等系统状态。 */
export async function clearNoteData() {
  const attachmentsDir = join(app.getPath('userData'), 'attachments')
  const pendingDeleteDir = join(
    app.getPath('userData'),
    `.attachments-deleting-${Date.now()}-${process.pid}`
  )
  let attachmentsMoved = false

  // 同卷目录重命名是常量时间操作，先将旧附件与后续可能创建的新目录隔离。
  if (existsSync(attachmentsDir)) {
    renameSync(attachmentsDir, pendingDeleteDir)
    attachmentsMoved = true
  }

  try {
    // 显式清理关联表，保持操作顺序清晰，也避免把大量级联工作留到最后一步。
    db.transaction(() => {
      db.prepare('DELETE FROM note_tags').run()
      db.prepare('DELETE FROM note_attachments').run()
      db.prepare('DELETE FROM notes').run()
      db.prepare('DELETE FROM note_templates').run()
      db.prepare('DELETE FROM tags').run()
    })()
  } catch (error) {
    // 数据库未提交时恢复附件目录，使数据库记录和文件仍保持一致。
    if (attachmentsMoved && !existsSync(attachmentsDir)) {
      try {
        renameSync(pendingDeleteDir, attachmentsDir)
      } catch (restoreError) {
        console.error('[clearNoteData] 恢复附件目录失败:', restoreError.message)
      }
    }
    throw error
  }

  // 递归删除移出主路径后异步执行，不阻塞 Electron 主线程，也不占用 SQLite 事务。
  if (attachmentsMoved) {
    try {
      await rm(pendingDeleteDir, { recursive: true, force: true })
    } catch (error) {
      console.error('[clearNoteData] 清理待删除附件目录失败:', error.message)
      // 数据库已经成功提交，不能再向 UI 报告“清空失败”。遗留目录会在下次启动重试。
    }
  }
}

// ============================================================
// 便签模块 — 建表迁移
// ============================================================

/**
 * 初始化便签模块所需的所有表
 * 由 initDatabase() 自动调用，使用 IF NOT EXISTS 保证幂等
 */
export function initNotesTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_templates (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      content             TEXT    NOT NULL DEFAULT '',
      recurrence_rule     TEXT    NOT NULL,
      is_paused           INTEGER NOT NULL DEFAULT 0,
      is_deleted          INTEGER NOT NULL DEFAULT 0,
      notify_enabled      INTEGER NOT NULL DEFAULT 1,
      last_generated_at   INTEGER,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id         INTEGER REFERENCES note_templates(id) ON DELETE SET NULL,
      note_type           TEXT    NOT NULL DEFAULT 'one_time'
                          CHECK(note_type IN ('one_time')),
      content             TEXT    NOT NULL DEFAULT '',
      status              TEXT    NOT NULL DEFAULT 'initialized'
                          CHECK(status IN ('initialized','in_progress','completed','cancelled')),
      is_deleted          INTEGER NOT NULL DEFAULT 0
                          CHECK(is_deleted IN (0, 1)),
      is_pinned           INTEGER NOT NULL DEFAULT 0,
      notify_enabled      INTEGER NOT NULL DEFAULT 0
                          CHECK(notify_enabled IN (0, 1)),
      effective_at        INTEGER NOT NULL,
      finished_at         INTEGER,
      remind_again_at     INTEGER,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
    CREATE INDEX IF NOT EXISTS idx_notes_effective_at ON notes(effective_at);
    CREATE INDEX IF NOT EXISTS idx_notes_template_id ON notes(template_id);
    CREATE INDEX IF NOT EXISTS idx_notes_is_pinned ON notes(is_pinned);
    CREATE INDEX IF NOT EXISTS idx_notes_status_pinned_sort ON notes(status, is_pinned, sort_order);

    CREATE TABLE IF NOT EXISTS note_attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      file_path   TEXT    NOT NULL,
      file_size   INTEGER,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_note_id ON note_attachments(note_id);

    CREATE TABLE IF NOT EXISTS tags (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT    NOT NULL UNIQUE,
      color               TEXT,
      created_at          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id             INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag_name            TEXT    NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
      PRIMARY KEY (note_id, tag_name)
    );
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag_name ON note_tags(tag_name);
  `)

  // 开发期增量同步：延后提醒独立于便签状态与原始提醒参数。
  const noteColumns = db.prepare("PRAGMA table_info('notes')").all()
  if (!noteColumns.some((col) => col.name === 'remind_again_at')) {
    db.exec('ALTER TABLE notes ADD COLUMN remind_again_at INTEGER')
  }
  if (!noteColumns.some((col) => col.name === 'is_deleted')) {
    db.exec('ALTER TABLE notes ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_notes_remind_again_at ON notes(remind_again_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_notes_is_deleted ON notes(is_deleted)')
}

/**
 * 获取数据库实例（供其他 db-*.js 模块使用）
 * @returns {import('better-sqlite3').Database} SQLite 数据库连接实例
 */
export function getDb() {
  return db
}
