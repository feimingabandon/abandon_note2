/** 数据库结构版本。公开版本只能通过显式迁移递增。 */
export const DATABASE_SCHEMA_VERSION = 2

function hasColumn(db, tableName, columnName) {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .some((column) => column.name === columnName)
}

/**
 * V2 为便签增加月视图跨日渲染天数。
 * 列检查使迁移可重入：即使旧版数据库的 user_version 不准确，
 * 或上次升级在写版本号前意外中断，也不会重复 ADD COLUMN。
 */
function migrateToVersion2(db) {
  if (!hasColumn(db, 'notes', 'duration_days')) {
    db.exec(`
      ALTER TABLE notes
      ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 1
                 CHECK(duration_days >= 1 AND duration_days <= 365);
    `)
  }
}

function migrateDatabaseSchema(db, existingVersion) {
  const missingDurationDays = !hasColumn(db, 'notes', 'duration_days')
  if (existingVersion >= DATABASE_SCHEMA_VERSION && !missingDurationDays) return
  db.transaction(() => {
    if (existingVersion < 2 || missingDurationDays) migrateToVersion2(db)
    if (existingVersion < DATABASE_SCHEMA_VERSION) {
      db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`)
    }
  })()
}

/** 创建首个正式版本的完整数据库结构。 */
export function createDatabaseSchema(db) {
  const existingVersion = Number(db.pragma('user_version', { simple: true }) || 0)
  if (existingVersion > DATABASE_SCHEMA_VERSION) {
    console.error(
      `[db-schema] 数据库版本 ${existingVersion} 高于程序支持的 ${DATABASE_SCHEMA_VERSION}，拒绝打开`
    )
    throw new Error(
      `数据库版本 ${existingVersion} 高于当前程序支持的版本 ${DATABASE_SCHEMA_VERSION}，` +
        '请使用更新版本的 Abandon Note 打开此数据库'
    )
  }

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

  createNotesSchema(db)
  createRemoteServiceSchema(db)
  migrateDatabaseSchema(db, existingVersion)
  if (existingVersion < DATABASE_SCHEMA_VERSION) {
    console.log(
      `[db-schema] 数据库结构版本 ${existingVersion} → ${DATABASE_SCHEMA_VERSION}` +
        (existingVersion === 0 ? '（全新创建）' : '（升级迁移）')
    )
  }
}

/** 创建远程通知的本地缓存和同步状态。开发阶段直接纳入完整初始化结构。 */
export function createRemoteServiceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_identity (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_notices (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      server_notice_id    TEXT    NOT NULL UNIQUE,
      sequence            INTEGER NOT NULL UNIQUE,
      title               TEXT    NOT NULL,
      body                TEXT    NOT NULL,
      link                TEXT,
      published_at        INTEGER NOT NULL,
      received_at         INTEGER NOT NULL,
      acknowledged_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_remote_notices_pending
      ON remote_notices(acknowledged_at, published_at DESC);

    CREATE TABLE IF NOT EXISTS remote_sync_state (
      scope       TEXT PRIMARY KEY,
      cursor      INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    );
  `)
}

/** 创建最终业务表结构；供完整初始化和隔离业务表测试复用。 */
export function createNotesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      note_type           TEXT    NOT NULL DEFAULT 'one_time'
                          CHECK(note_type IN ('one_time')),
      content             TEXT    NOT NULL DEFAULT '',
      status              TEXT    NOT NULL DEFAULT 'initialized'
                          CHECK(status IN ('initialized','in_progress','completed')),
      is_deleted          INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
      is_pinned           INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
      notify_enabled      INTEGER NOT NULL DEFAULT 0 CHECK(notify_enabled IN (0, 1)),
      effective_at        INTEGER NOT NULL,
      duration_days       INTEGER NOT NULL DEFAULT 1
                          CHECK(duration_days >= 1 AND duration_days <= 365),
      finished_at         INTEGER,
      remind_again_at     INTEGER,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
    CREATE INDEX IF NOT EXISTS idx_notes_effective_at ON notes(effective_at);
    CREATE INDEX IF NOT EXISTS idx_notes_is_pinned ON notes(is_pinned);
    CREATE INDEX IF NOT EXISTS idx_notes_status_pinned_sort ON notes(status, is_pinned, sort_order);
    CREATE INDEX IF NOT EXISTS idx_notes_remind_again_at ON notes(remind_again_at);
    CREATE INDEX IF NOT EXISTS idx_notes_is_deleted ON notes(is_deleted);

    CREATE TABLE IF NOT EXISTS note_templates (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      content                 TEXT    NOT NULL DEFAULT '',
      recurrence_rule         TEXT    NOT NULL,
      is_pinned               INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
      notify_enabled          INTEGER NOT NULL DEFAULT 1 CHECK(notify_enabled IN (0, 1)),
      is_paused               INTEGER NOT NULL DEFAULT 0 CHECK(is_paused IN (0, 1)),
      is_deleted              INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
      deleted_at              INTEGER,
      schedule_anchor_at      INTEGER NOT NULL,
      next_run_at             INTEGER,
      last_generated_at       INTEGER,
      last_generated_note_id  INTEGER REFERENCES notes(id) ON DELETE SET NULL,
      consecutive_failures    INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
      last_error              TEXT,
      last_failed_at          INTEGER,
      pause_reason            TEXT CHECK(pause_reason IS NULL OR pause_reason IN ('manual', 'error')),
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_templates_due
      ON note_templates(is_deleted, is_paused, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_templates_last_note
      ON note_templates(last_generated_note_id);

    CREATE TABLE IF NOT EXISTS note_attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      file_path   TEXT    NOT NULL,
      file_size   INTEGER,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_note_id ON note_attachments(note_id);

    CREATE TABLE IF NOT EXISTS wallpaper_sources (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      content_hash  TEXT    NOT NULL UNIQUE,
      original_path TEXT    NOT NULL,
      mime_type     TEXT    NOT NULL,
      width         INTEGER NOT NULL CHECK(width > 0),
      height        INTEGER NOT NULL CHECK(height > 0),
      file_size     INTEGER NOT NULL CHECK(file_size > 0),
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallpapers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id      INTEGER NOT NULL REFERENCES wallpaper_sources(id) ON DELETE RESTRICT,
      cropped_path   TEXT    NOT NULL,
      crop_x         REAL    NOT NULL,
      crop_y         REAL    NOT NULL,
      crop_width     REAL    NOT NULL CHECK(crop_width > 0),
      crop_height    REAL    NOT NULL CHECK(crop_height > 0),
      scale          REAL    NOT NULL DEFAULT 1 CHECK(scale > 0),
      target_width   INTEGER NOT NULL CHECK(target_width > 0),
      target_height  INTEGER NOT NULL CHECK(target_height > 0),
      created_at     INTEGER NOT NULL,
      last_used_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wallpapers_source_id ON wallpapers(source_id);
    CREATE INDEX IF NOT EXISTS idx_wallpapers_last_used ON wallpapers(last_used_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS tags (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      color       TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag_name  TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
      PRIMARY KEY (note_id, tag_name)
    );
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag_name ON note_tags(tag_name);

    CREATE TABLE IF NOT EXISTS template_tags (
      template_id  INTEGER NOT NULL REFERENCES note_templates(id) ON DELETE CASCADE,
      tag_name     TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
      PRIMARY KEY (template_id, tag_name)
    );
    CREATE INDEX IF NOT EXISTS idx_template_tags_tag_name ON template_tags(tag_name);
  `)
}
