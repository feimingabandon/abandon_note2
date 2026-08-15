/** 数据库结构版本。公开版本只能通过显式迁移递增。 */
export const DATABASE_SCHEMA_VERSION = 6

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

function migrateTagRelationTable(db, { tableName, ownerColumn, ownerTable }) {
  if (hasColumn(db, tableName, 'tag_id')) return
  if (!hasColumn(db, tableName, 'tag_name')) {
    throw new Error(`${tableName} 缺少 tag_name，无法迁移标签关联`)
  }

  const orphanCount = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM ${tableName} relation
       LEFT JOIN tags t ON t.name = relation.tag_name
       WHERE t.id IS NULL`
    )
    .get().total
  if (orphanCount > 0) {
    throw new Error(`${tableName} 存在 ${orphanCount} 条无效标签关联，已取消迁移`)
  }

  const temporaryTable = `${tableName}_v3`
  const previousCount = db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total
  db.exec(`
    DROP TABLE IF EXISTS ${temporaryTable};
    CREATE TABLE ${temporaryTable} (
      ${ownerColumn} INTEGER NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (${ownerColumn}, tag_id)
    );
    INSERT INTO ${temporaryTable} (${ownerColumn}, tag_id)
    SELECT relation.${ownerColumn}, t.id
    FROM ${tableName} relation
    INNER JOIN tags t ON t.name = relation.tag_name;
  `)
  const migratedCount = db.prepare(`SELECT COUNT(*) AS total FROM ${temporaryTable}`).get().total
  if (migratedCount !== previousCount) {
    throw new Error(`${tableName} 标签关联迁移数量不一致：${previousCount} → ${migratedCount}`)
  }
  db.exec(`
    DROP TABLE ${tableName};
    ALTER TABLE ${temporaryTable} RENAME TO ${tableName};
  `)
}

function migrateListFilterSettingsToTagIds(db) {
  const rows = db
    .prepare("SELECT window_name, key, value FROM app_settings WHERE key = 'list_filter'")
    .all()
  if (rows.length === 0) return

  const findTagId = db.prepare('SELECT id FROM tags WHERE name = ?')
  const update = db.prepare(
    'UPDATE app_settings SET value = ?, updated_at = ? WHERE window_name = ? AND key = ?'
  )
  const timestamp = Date.now()

  for (const row of rows) {
    let value
    try {
      value = JSON.parse(row.value || '{}')
    } catch {
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue

    const existingIds = Array.isArray(value.tagIds)
      ? value.tagIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : []
    const migratedIds = Array.isArray(value.tagNames)
      ? value.tagNames
          .filter((name) => typeof name === 'string' && name.trim())
          .map((name) => findTagId.get(name.trim())?.id)
          .filter((id) => Number.isInteger(id) && id > 0)
      : []
    value.tagIds = [...new Set(existingIds.length > 0 ? existingIds : migratedIds)]
    delete value.tagNames
    update.run(JSON.stringify(value), timestamp, row.window_name, row.key)
  }
}

/** V3 将便签与模板的标签关联从可变名称迁移为稳定 tag_id。 */
function migrateToVersion3(db) {
  migrateTagRelationTable(db, {
    tableName: 'note_tags',
    ownerColumn: 'note_id',
    ownerTable: 'notes'
  })
  migrateTagRelationTable(db, {
    tableName: 'template_tags',
    ownerColumn: 'template_id',
    ownerTable: 'note_templates'
  })
  migrateListFilterSettingsToTagIds(db)

  const violations = db.pragma('foreign_key_check')
  if (violations.length > 0) {
    throw new Error(`V3 标签迁移后存在 ${violations.length} 条外键异常`)
  }
}

/** V4 为标签增加稳定的用户置顶状态；不引入会频繁重排的最近使用时间。 */
function migrateToVersion4(db) {
  if (!hasColumn(db, 'tags', 'is_pinned')) {
    db.exec(`
      ALTER TABLE tags
      ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1));
    `)
  }
  if (!hasColumn(db, 'tags', 'pinned_at')) {
    db.exec('ALTER TABLE tags ADD COLUMN pinned_at INTEGER;')
  }
}

/** V5 移除已经废弃的“稍后提醒”状态；普通到时提醒不受影响。 */
function migrateToVersion5(db) {
  db.exec('DROP INDEX IF EXISTS idx_notes_remind_again_at;')
  if (hasColumn(db, 'notes', 'remind_again_at')) {
    db.exec('ALTER TABLE notes DROP COLUMN remind_again_at;')
  }
}

/**
 * V6 用全局稳定顺序替代标签置顶。
 *
 * 旧数据先按“置顶优先、最近置顶优先、其余按最近创建优先”生成排序槽位，
 * 尽量保持升级前标签选择器和管理弹窗中的可见顺序；完成后物理移除废弃字段。
 */
function migrateToVersion6(db) {
  const hadSortOrder = hasColumn(db, 'tags', 'sort_order')
  const hasPinned = hasColumn(db, 'tags', 'is_pinned')
  const hasPinnedAt = hasColumn(db, 'tags', 'pinned_at')

  if (!hadSortOrder) {
    db.exec('ALTER TABLE tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;')
  }

  const sortState = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT sort_order) AS distinct_total,
              SUM(CASE WHEN sort_order <= 0 THEN 1 ELSE 0 END) AS invalid_total
       FROM tags`
    )
    .get()
  const needsInitialOrder =
    !hadSortOrder ||
    Number(sortState.invalid_total) > 0 ||
    Number(sortState.distinct_total) !== Number(sortState.total)

  if (needsInitialOrder) {
    const legacyOrder = hasPinned
      ? `is_pinned DESC,
         CASE WHEN is_pinned = 1 THEN ${hasPinnedAt ? 'COALESCE(pinned_at, 0)' : '0'} END DESC,
         created_at DESC, id DESC`
      : 'created_at DESC, id DESC'
    const rows = db.prepare(`SELECT id FROM tags ORDER BY ${legacyOrder}`).all()
    const update = db.prepare('UPDATE tags SET sort_order = ? WHERE id = ?')
    rows.forEach((row, index) => update.run((index + 1) * 65536, row.id))
  }

  if (hasPinnedAt) db.exec('ALTER TABLE tags DROP COLUMN pinned_at;')
  if (hasPinned) db.exec('ALTER TABLE tags DROP COLUMN is_pinned;')
}

function ensureTagRelationIndexes(db) {
  if (hasColumn(db, 'note_tags', 'tag_id')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id);')
  }
  if (hasColumn(db, 'template_tags', 'tag_id')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_template_tags_tag_id ON template_tags(tag_id);')
  }
}

function migrateDatabaseSchema(db, existingVersion) {
  const missingDurationDays = !hasColumn(db, 'notes', 'duration_days')
  const missingTagIds =
    !hasColumn(db, 'note_tags', 'tag_id') || !hasColumn(db, 'template_tags', 'tag_id')
  const missingTagSortOrder = !hasColumn(db, 'tags', 'sort_order')
  const hasObsoleteTagPinning =
    hasColumn(db, 'tags', 'is_pinned') || hasColumn(db, 'tags', 'pinned_at')
  const hasObsoleteSnoozeColumn = hasColumn(db, 'notes', 'remind_again_at')
  if (
    existingVersion >= DATABASE_SCHEMA_VERSION &&
    !missingDurationDays &&
    !missingTagIds &&
    !missingTagSortOrder &&
    !hasObsoleteTagPinning &&
    !hasObsoleteSnoozeColumn
  )
    return
  db.transaction(() => {
    if (existingVersion < 2 || missingDurationDays) migrateToVersion2(db)
    if (existingVersion < 3 || missingTagIds) migrateToVersion3(db)
    // 新数据库直接创建 V6 最终结构；只有缺少排序字段的旧库才临时补齐 V4 字段，
    // 供 V6 将用户原有的置顶偏好转换成初始顺序。
    if (existingVersion < 6 && missingTagSortOrder) migrateToVersion4(db)
    if (existingVersion < 5 || hasObsoleteSnoozeColumn) migrateToVersion5(db)
    if (existingVersion < 6 || missingTagSortOrder || hasObsoleteTagPinning) {
      migrateToVersion6(db)
    }
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
  ensureTagRelationIndexes(db)
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

    CREATE TABLE IF NOT EXISTS remote_notice_stream_state (
      scope       TEXT PRIMARY KEY,
      stream_id   TEXT NOT NULL,
      cursor      INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_session_end_outbox (
      session_id  TEXT PRIMARY KEY,
      ended_at    TEXT NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_remote_session_end_outbox_created
      ON remote_session_end_outbox(created_at);
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
      sort_order          INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
    CREATE INDEX IF NOT EXISTS idx_notes_effective_at ON notes(effective_at);
    CREATE INDEX IF NOT EXISTS idx_notes_is_pinned ON notes(is_pinned);
    CREATE INDEX IF NOT EXISTS idx_notes_status_pinned_sort ON notes(status, is_pinned, sort_order);
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
      created_at  INTEGER NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (note_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS template_tags (
      template_id  INTEGER NOT NULL REFERENCES note_templates(id) ON DELETE CASCADE,
      tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (template_id, tag_id)
    );
  `)
}
