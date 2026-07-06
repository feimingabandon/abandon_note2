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

  // 旧表兼容性处理
  const tableInfo = db.prepare("PRAGMA table_info('app_settings')").all()
  const hasWindowName = tableInfo.some((col) => col.name === 'window_name')
  if (tableInfo.length > 0 && !hasWindowName) {
    db.exec('DROP TABLE app_settings')
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
}

export function closeDatabase() {
  if (db) {
    db.close()
    db = null
  }
}

export function getSetting(windowName, key) {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE window_name = ? AND key = ?')
    .get(windowName, key)
  return row?.value ?? null
}

export function setSetting(windowName, type, key, value, remark = '') {
  const now = Date.now()
  db.prepare(
    `
    INSERT INTO app_settings (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(window_name, key) DO UPDATE SET
      value = excluded.value,
      type = excluded.type,
      updated_at = excluded.updated_at
  `
  ).run(windowName, type, key, String(value), remark, now, now)
}

export function getSettingsByType(windowName, type) {
  return db
    .prepare('SELECT key, value FROM app_settings WHERE window_name = ? AND type = ?')
    .all(windowName, type)
}

export function deleteSetting(windowName, key) {
  db.prepare('DELETE FROM app_settings WHERE window_name = ? AND key = ?').run(windowName, key)
}

export function saveGeometry(windowName, x, y, width, height) {
  const save = db.transaction(() => {
    setSetting(windowName, 'geometry', 'pos_x', String(x), '窗口左上角 X 坐标（像素）')
    setSetting(windowName, 'geometry', 'pos_y', String(y), '窗口左上角 Y 坐标（像素）')
    setSetting(windowName, 'geometry', 'width', String(width), '窗口宽度（像素）')
    setSetting(windowName, 'geometry', 'height', String(height), '窗口高度（像素）')
  })
  save()
}

export function resetDatabase() {
  db.exec('DELETE FROM app_settings')
}

export function getGeometry(windowName) {
  const rows = db
    .prepare(
      "SELECT key, value FROM app_settings WHERE window_name = ? AND key IN ('pos_x','pos_y','width','height')"
    )
    .all(windowName)
  if (rows.length !== 4) return null
  const map = {}
  rows.forEach((r) => {
    map[r.key] = r.value
  })
  return {
    x: Number(map.pos_x),
    y: Number(map.pos_y),
    width: Number(map.width),
    height: Number(map.height)
  }
}

export function deleteGeometry(windowName) {
  db.prepare(
    "DELETE FROM app_settings WHERE window_name = ? AND key IN ('pos_x','pos_y','width','height')"
  ).run(windowName)
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
      status              TEXT    NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active','in_progress','completed','cancelled','expired')),
      is_pinned           INTEGER NOT NULL DEFAULT 0,
      notify_enabled      INTEGER NOT NULL DEFAULT 1,
      effective_at        INTEGER NOT NULL,
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
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id             INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      media_type          TEXT    NOT NULL
                          CHECK(media_type IN ('image','video','audio')),
      file_path           TEXT    NOT NULL,
      file_size           INTEGER,
      transcription       TEXT,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL
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
      tag_id              INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (note_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      content,
      content=notes,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
  `)

  // 修复：首次创建 FTS 时，将已存在的便签内容补入索引
  // CREATE TRIGGER 只对新写入生效，历史数据需手动填充
  // 安全条件：仅当 notes 有数据且 FTS 为空时才填充（幂等）
  const noteCount = db.prepare('SELECT COUNT(*) as count FROM notes').get().count
  const ftsCount = db.prepare('SELECT COUNT(*) as count FROM notes_fts').get().count
  if (noteCount > 0 && ftsCount === 0) {
    db.exec('INSERT INTO notes_fts(rowid, content) SELECT id, content FROM notes')
  }
}

/**
 * 获取数据库实例（供其他 db-*.js 模块使用）
 * @returns {import('better-sqlite3').Database} SQLite 数据库连接实例
 */
export function getDb() {
  return db
}
