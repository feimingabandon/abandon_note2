import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DATABASE_SCHEMA_VERSION, createDatabaseSchema } from '../src/main/db/db-schema.js'
import {
  createDatabaseMigrationBackup,
  createTagIdMigrationBackup
} from '../src/main/db/db-migration-backup.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import {
  createTag,
  deleteTag,
  getNoteTags,
  getTagUsage,
  listTags,
  setNoteTagIds,
  updateTagOrder,
  updateTag
} from '../src/main/db/db-tags.js'
import {
  createTemplate,
  deleteTemplate,
  getTemplateById,
  listTemplates,
  pauseTemplate,
  purgeTemplate,
  restoreTemplate,
  resumeTemplate,
  updateTemplate
} from '../src/main/db/db-templates.js'
import {
  createNote,
  getNoteById,
  normalizeNoteDurationDays,
  normalizeRequiredNoteContent,
  queryCustomNormal,
  queryEarlierNotes,
  queryPinnedNotes,
  searchNotes,
  queryTagGroupNotes,
  queryTagGroups,
  reopenNote
} from '../src/main/db/db-notes.js'
import { getMonthCalendarData } from '../src/main/calendar/calendar-service.js'
import { queryDailyReportNotes } from '../src/main/services/daily-report.js'
import { getOrCreateInstallationId } from '../src/main/db/db-identity.js'
import {
  acknowledgeRemoteNotice,
  applyRemoteNoticeEvents,
  getRemoteNoticeSyncState,
  listPendingRemoteNotices,
  listRemoteNotices
} from '../src/main/db/db-remote-notices.js'
import { runRecurringTemplates } from '../src/main/services/recurrence.js'
import {
  countDesktopStickyRecords,
  deleteDesktopStickyRecord,
  hasDesktopStickyRecord,
  insertDesktopStickyRecord,
  listDesktopStickyRecords,
  updateDesktopStickyRecord
} from '../src/main/db/db-desktop-stickies.js'

function localTs(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

const futureDb = new Database(':memory:')
futureDb.pragma(`user_version = ${DATABASE_SCHEMA_VERSION + 1}`)
assert.throws(() => createDatabaseSchema(futureDb), /高于当前程序支持的版本/)
assert.equal(futureDb.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION + 1)
assert.equal(
  futureDb
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
    .get().count,
  0
)
futureDb.close()

const backupRoot = mkdtempSync(join(tmpdir(), 'abandon-v0-backup-test-'))
const backupSourcePath = join(backupRoot, 'app.db')
const versionZeroDb = new Database(backupSourcePath)
try {
  versionZeroDb.exec(`
    CREATE TABLE note_tags (
      note_id INTEGER NOT NULL,
      tag_name TEXT NOT NULL,
      PRIMARY KEY (note_id, tag_name)
    );
    INSERT INTO note_tags (note_id, tag_name) VALUES (1, 'V0 标签');
    PRAGMA user_version = 0;
  `)
  const backupPath = createTagIdMigrationBackup(versionZeroDb, backupSourcePath)
  assert.equal(backupPath, join(backupRoot, 'app-v0-before-v3.db'))
  assert.equal(existsSync(backupPath), true)
  const backupDb = new Database(backupPath, { readonly: true })
  assert.deepEqual(backupDb.prepare('SELECT * FROM note_tags').all(), [
    { note_id: 1, tag_name: 'V0 标签' }
  ])
  backupDb.close()
} finally {
  versionZeroDb.close()
  rmSync(backupRoot, { recursive: true, force: true })
}

const v5BackupRoot = mkdtempSync(join(tmpdir(), 'abandon-v5-backup-test-'))
const v5BackupSourcePath = join(v5BackupRoot, 'app.db')
const versionFiveDb = new Database(v5BackupSourcePath)
try {
  versionFiveDb.exec(`
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT,
      created_at INTEGER NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
      pinned_at INTEGER
    );
    INSERT INTO tags (id, name, color, created_at, is_pinned, pinned_at)
      VALUES (1, 'V5 置顶标签', '#007aff', 1000, 1, 2000);
    PRAGMA user_version = 5;
  `)
  const backupPath = createDatabaseMigrationBackup(versionFiveDb, v5BackupSourcePath)
  assert.equal(backupPath, join(v5BackupRoot, 'app-v5-before-v6.db'))
  assert.equal(existsSync(backupPath), true)
  assert.equal(createDatabaseMigrationBackup(versionFiveDb, v5BackupSourcePath), backupPath)
  const backupDb = new Database(backupPath, { readonly: true })
  assert.deepEqual(backupDb.prepare('SELECT id, name, is_pinned, pinned_at FROM tags').all(), [
    { id: 1, name: 'V5 置顶标签', is_pinned: 1, pinned_at: 2000 }
  ])
  backupDb.close()
} finally {
  versionFiveDb.close()
  rmSync(v5BackupRoot, { recursive: true, force: true })
}

const legacyDb = new Database(':memory:')
legacyDb.exec(`
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_type TEXT NOT NULL DEFAULT 'one_time' CHECK(note_type IN ('one_time')),
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'initialized'
      CHECK(status IN ('initialized','in_progress','completed')),
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
    notify_enabled INTEGER NOT NULL DEFAULT 0 CHECK(notify_enabled IN (0, 1)),
    effective_at INTEGER NOT NULL,
    finished_at INTEGER,
    remind_again_at INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO notes (
    content, status, effective_at, finished_at, created_at, updated_at
  ) VALUES ('legacy note', 'in_progress', 1000, 1000, 1000, 1000);
  PRAGMA user_version = 1;
`)
createDatabaseSchema(legacyDb)
assert.equal(legacyDb.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.equal(
  legacyDb
    .prepare("PRAGMA table_info('notes')")
    .all()
    .some((column) => column.name === 'duration_days'),
  true
)
assert.equal(
  legacyDb
    .prepare("PRAGMA table_info('notes')")
    .all()
    .some((column) => column.name === 'remind_again_at'),
  false
)
assert.deepEqual(legacyDb.prepare('SELECT content, duration_days FROM notes WHERE id = 1').get(), {
  content: 'legacy note',
  duration_days: 1
})
assert.throws(
  () =>
    legacyDb
      .prepare(
        `INSERT INTO notes (content, status, effective_at, duration_days, created_at, updated_at)
         VALUES ('invalid duration', 'in_progress', 2000, 0, 2000, 2000)`
      )
      .run(),
  /CHECK constraint failed/
)
createDatabaseSchema(legacyDb)
assert.equal(
  legacyDb
    .prepare("PRAGMA table_info('notes')")
    .all()
    .filter((column) => column.name === 'duration_days').length,
  1
)
legacyDb.close()

// V2 使用标签名称作为关联键；V3 必须原子迁移为稳定 ID，并同步转换持久化筛选。
const tagIdMigrationDb = new Database(':memory:')
tagIdMigrationDb.pragma('foreign_keys = ON')
createDatabaseSchema(tagIdMigrationDb)
tagIdMigrationDb.exec(`
  DROP TABLE note_tags;
  DROP TABLE template_tags;
  DROP TABLE tags;
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE note_tags (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_name TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_name)
  );
  CREATE TABLE template_tags (
    template_id INTEGER NOT NULL REFERENCES note_templates(id) ON DELETE CASCADE,
    tag_name TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
    PRIMARY KEY (template_id, tag_name)
  );
  INSERT INTO tags (id, name, color, created_at) VALUES (41, '迁移标签', '#007aff', 1000);
  INSERT INTO notes (id, content, effective_at, created_at, updated_at)
    VALUES (51, '迁移便签', 1000, 1000, 1000);
  INSERT INTO note_templates (
    id, content, recurrence_rule, schedule_anchor_at, created_at, updated_at
  ) VALUES (61, '迁移模板', '{"frequency":"daily","interval":1,"time_of_day":"09:00"}', 1000, 1000, 1000);
  INSERT INTO note_tags (note_id, tag_name) VALUES (51, '迁移标签');
  INSERT INTO template_tags (template_id, tag_name) VALUES (61, '迁移标签');
  INSERT INTO app_settings (
    window_name, type, key, value, remark, created_at, updated_at
  ) VALUES (
    'main', 'filter', 'list_filter',
    '{"listMode":"tag-group","tagNames":["迁移标签"],"statusFilter":["initialized"]}',
    '', 1000, 1000
  );
  PRAGMA user_version = 2;
`)
createDatabaseSchema(tagIdMigrationDb)
assert.equal(tagIdMigrationDb.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.deepEqual(
  tagIdMigrationDb
    .prepare("PRAGMA table_info('note_tags')")
    .all()
    .map((column) => column.name),
  ['note_id', 'tag_id']
)
assert.deepEqual(
  tagIdMigrationDb
    .prepare("PRAGMA table_info('tags')")
    .all()
    .filter((column) => ['sort_order', 'is_pinned', 'pinned_at'].includes(column.name))
    .map((column) => column.name),
  ['sort_order']
)
assert.deepEqual(tagIdMigrationDb.prepare('SELECT * FROM note_tags').all(), [
  { note_id: 51, tag_id: 41 }
])
assert.deepEqual(tagIdMigrationDb.prepare('SELECT * FROM template_tags').all(), [
  { template_id: 61, tag_id: 41 }
])
assert.deepEqual(
  JSON.parse(
    tagIdMigrationDb.prepare("SELECT value FROM app_settings WHERE key = 'list_filter'").get().value
  ),
  { listMode: 'tag-group', statusFilter: ['initialized'], tagIds: [41] }
)
assert.deepEqual(tagIdMigrationDb.pragma('foreign_key_check'), [])
tagIdMigrationDb.close()

// V5 的标签置顶偏好必须原子转换为 V6 全局顺序，迁移后不再保留置顶字段。
const tagOrderMigrationDb = new Database(':memory:')
tagOrderMigrationDb.pragma('foreign_keys = ON')
createDatabaseSchema(tagOrderMigrationDb)
tagOrderMigrationDb.exec(`
  INSERT INTO tags (id, name, color, created_at, sort_order) VALUES
    (71, '旧普通标签', '#007aff', 1000, 65536),
    (72, '旧置顶标签一', '#ff3b30', 2000, 131072),
    (73, '旧置顶标签二', '#34c759', 3000, 196608);
  ALTER TABLE tags DROP COLUMN sort_order;
  ALTER TABLE tags ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1));
  ALTER TABLE tags ADD COLUMN pinned_at INTEGER;
  UPDATE tags SET is_pinned = 1, pinned_at = 100 WHERE id = 72;
  UPDATE tags SET is_pinned = 1, pinned_at = 200 WHERE id = 73;
  PRAGMA user_version = 5;
`)
createDatabaseSchema(tagOrderMigrationDb)
assert.equal(tagOrderMigrationDb.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.deepEqual(
  tagOrderMigrationDb
    .prepare("PRAGMA table_info('tags')")
    .all()
    .map((column) => column.name),
  ['id', 'name', 'color', 'created_at', 'sort_order']
)
assert.deepEqual(
  tagOrderMigrationDb
    .prepare('SELECT id FROM tags ORDER BY sort_order ASC, id ASC')
    .all()
    .map((row) => row.id),
  [73, 72, 71]
)
assert.deepEqual(tagOrderMigrationDb.pragma('foreign_key_check'), [])
tagOrderMigrationDb.close()

const versionSixDb = new Database(':memory:')
versionSixDb.pragma('foreign_keys = ON')
createDatabaseSchema(versionSixDb)
versionSixDb.exec('DROP TABLE desktop_stickies; PRAGMA user_version = 6;')
createDatabaseSchema(versionSixDb)
assert.equal(versionSixDb.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.equal(
  versionSixDb
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'desktop_stickies'"
    )
    .get().count,
  1
)
versionSixDb.close()

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
createDatabaseSchema(db)
setDb(db)
const originalConsoleError = console.error

try {
  assert.equal(db.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
  assert.deepEqual(
    db
      .prepare("PRAGMA table_info('app_settings')")
      .all()
      .map((column) => column.name),
    ['window_name', 'type', 'key', 'value', 'remark', 'created_at', 'updated_at']
  )
  const noteColumns = db
    .prepare("PRAGMA table_info('notes')")
    .all()
    .map((column) => column.name)
  assert.equal(noteColumns.includes('template_id'), false)
  assert.equal(noteColumns.includes('duration_days'), true)
  assert.equal(noteColumns.includes('remind_again_at'), false)
  assert.deepEqual(
    db
      .prepare("PRAGMA table_info('wallpaper_sources')")
      .all()
      .map((column) => column.name),
    [
      'id',
      'content_hash',
      'original_path',
      'mime_type',
      'width',
      'height',
      'file_size',
      'created_at'
    ]
  )
  assert.equal(
    db
      .prepare("PRAGMA table_info('wallpapers')")
      .all()
      .some((column) => column.name === 'cropped_path'),
    true
  )
  assert.deepEqual(
    db
      .prepare("PRAGMA table_info('remote_notices')")
      .all()
      .map((column) => column.name),
    [
      'id',
      'server_notice_id',
      'sequence',
      'title',
      'body',
      'link',
      'published_at',
      'received_at',
      'acknowledged_at'
    ]
  )
  const installationId = getOrCreateInstallationId()
  assert.match(
    installationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  )
  assert.equal(getOrCreateInstallationId(), installationId)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM app_identity').get().count, 1)
  assert.deepEqual(getRemoteNoticeSyncState(), { streamId: null, cursor: 0 })
  const noticeStreamId = '78c01b83-7d07-4f0d-9223-9980e0cdb9cb'
  const initialNoticeResult = applyRemoteNoticeEvents(
    noticeStreamId,
    [
      {
        type: 'upsert',
        noticeId: '101',
        sequence: 101,
        notifyAgain: false,
        notice: {
          title: '第一条通知',
          body: '第一行\n第二行',
          link: 'https://example.com/notice/101',
          publishedAt: localTs(2026, 7, 30, 10)
        }
      },
      {
        type: 'upsert',
        noticeId: '102',
        sequence: 102,
        notifyAgain: false,
        notice: {
          title: '第二条通知',
          body: '正文',
          link: null,
          publishedAt: localTs(2026, 7, 30, 11)
        }
      }
    ],
    102
  )
  assert.equal(initialNoticeResult.inserted, 2)
  assert.deepEqual(getRemoteNoticeSyncState(), { streamId: noticeStreamId, cursor: 102 })
  const updatedNoticeResult = applyRemoteNoticeEvents(
    noticeStreamId,
    [
      {
        type: 'upsert',
        noticeId: '101',
        sequence: 103,
        notifyAgain: false,
        notice: {
          title: '已更新通知',
          body: '更新后的正文',
          link: null,
          publishedAt: localTs(2026, 7, 30, 10)
        }
      }
    ],
    103
  )
  assert.equal(updatedNoticeResult.updated, 1)
  assert.equal(listPendingRemoteNotices().length, 2)
  const firstRemoteNotice = listPendingRemoteNotices()[0]
  assert.equal(firstRemoteNotice.body, '更新后的正文')
  assert.equal(acknowledgeRemoteNotice(firstRemoteNotice.id), true)
  const remoteHistory = listRemoteNotices()
  assert.equal(remoteHistory.total, 2)
  assert.equal(remoteHistory.pending, 1)
  assert.equal(
    remoteHistory.items.find((item) => item.id === firstRemoteNotice.id).acknowledgedAt > 0,
    true
  )
  const revokeResult = applyRemoteNoticeEvents(
    noticeStreamId,
    [{ type: 'revoke', noticeId: '102', sequence: 104 }],
    104
  )
  assert.equal(revokeResult.revoked, 1)
  assert.equal(listRemoteNotices().total, 1)
  const replacementStreamId = '12c37c33-8269-4915-9e69-a98988b042c6'
  const resetResult = applyRemoteNoticeEvents(replacementStreamId, [], 0)
  assert.equal(resetResult.streamChanged, true)
  assert.equal(listRemoteNotices().total, 0)
  assert.equal(normalizeRequiredNoteContent('  保留首尾空白\n'), '  保留首尾空白\n')
  assert.throws(() => normalizeRequiredNoteContent(' \n\t '), /请输入便签内容/)
  assert.equal(normalizeNoteDurationDays(1), 1)
  assert.equal(normalizeNoteDurationDays('365'), 365)
  assert.throws(() => normalizeNoteDurationDays(0), /持续天数/)
  assert.throws(() => normalizeNoteDurationDays(1.5), /持续天数/)

  const dailyTag = createTag('日常', '#007aff')
  const importantTag = createTag('重要', '#ff3b30')
  const orderedThirdTag = createTag('排序测试', '#34c759')
  assert.deepEqual(
    listTags().map((tag) => tag.id),
    [dailyTag.id, importantTag.id, orderedThirdTag.id]
  )
  updateTagOrder([orderedThirdTag.id, dailyTag.id])
  assert.deepEqual(
    listTags().map((tag) => tag.id),
    [orderedThirdTag.id, importantTag.id, dailyTag.id]
  )
  assert.equal(listTags().find((tag) => tag.id === importantTag.id).sort_order, 131072)
  assert.equal(deleteTag(orderedThirdTag.id), true)
  const editedTag = updateTag(importantTag.id, {
    name: '重要',
    color: '#ff3b30'
  }).tag
  assert.equal(editedTag.name, '重要')
  assert.throws(
    () => updateTag(importantTag.id, { name: '日常', color: '#ff3b30' }),
    /标签名称已存在/
  )

  const missedAnchor = localTs(2025, 7, 20, 8)
  const missedTemplate = createTemplate(
    {
      content: '错过节点不补偿',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      tagIds: [dailyTag.id]
    },
    missedAnchor
  )
  const startup = runRecurringTemplates({ now: localTs(2025, 7, 20, 10), reason: 'startup' })
  assert.equal(startup.count, 0)
  assert.equal(startup.skipped, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0)
  assert.equal(getTemplateById(missedTemplate.id).next_run_at, localTs(2025, 7, 21, 9))

  const activeAnchor = localTs(2025, 7, 20, 8)
  const activeTemplate = createTemplate(
    {
      content: '生成快照',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      isPinned: true,
      notifyEnabled: true,
      tagIds: [dailyTag.id]
    },
    activeAnchor
  )
  assert.throws(
    () =>
      updateTemplate(activeTemplate.id, {
        tagIds: [dailyTag.id, importantTag.id]
      }),
    /一个便签最多只能设置一个标签/
  )
  // 模拟旧版本遗留的多标签模板；循环生成时只继承关联顺序中的第一项。
  db.prepare('INSERT INTO template_tags (template_id, tag_id) VALUES (?, ?)').run(
    activeTemplate.id,
    importantTag.id
  )
  const firstRun = runRecurringTemplates({
    now: localTs(2025, 7, 20, 9, 0, 30),
    reason: 'scheduled'
  })
  assert.equal(firstRun.count, 1)
  assert.equal(firstRun.generated.length, 1)
  assert.deepEqual(firstRun.generated[0], { id: firstRun.generated[0].id, content: '生成快照' })
  assert.equal(Number.isInteger(firstRun.generated[0].id), true)

  const firstNote = db.prepare('SELECT * FROM notes WHERE is_deleted = 0').get()
  assert.equal(firstNote.status, 'in_progress')
  assert.equal(firstNote.is_pinned, 1)
  assert.equal(firstNote.notify_enabled, 0)
  assert.deepEqual(
    db.prepare('SELECT tag_id FROM note_tags WHERE note_id = ? ORDER BY tag_id').all(firstNote.id),
    [{ tag_id: dailyTag.id }]
  )
  assert.deepEqual(
    queryPinnedNotes({ statuses: ['in_progress'], tagIds: [dailyTag.id, importantTag.id] }).map(
      (note) => note.id
    ),
    [firstNote.id]
  )
  const generatedCalendar = getMonthCalendarData(2025, 7)
  assert.equal(
    generatedCalendar.notes.some((note) => note.content === '生成快照'),
    true
  )
  assert.equal(
    generatedCalendar.notes.some((note) => note.content === '错过节点不补偿'),
    false,
    '月视图不得虚拟展开尚未生成的循环模板'
  )

  // 历史多标签便签仍完整读取，第一项保持关联插入顺序；新保存则拒绝多标签。
  db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(
    firstNote.id,
    importantTag.id
  )
  assert.deepEqual(
    getNoteById(firstNote.id).tags.map((tag) => tag.name),
    ['日常', '重要']
  )
  assert.deepEqual(
    getNoteTags(firstNote.id).map((tag) => tag.name),
    ['日常', '重要']
  )
  assert.throws(
    () => setNoteTagIds(firstNote.id, [dailyTag.id, importantTag.id]),
    /一个便签最多只能设置一个标签/
  )

  assert.deepEqual(getTagUsage(dailyTag.id), {
    noteCount: 1,
    activeNoteCount: 1,
    deletedNoteCount: 0,
    templateCount: 2,
    runningTemplateCount: 2,
    pausedTemplateCount: 0,
    deletedTemplateCount: 0
  })
  assert.deepEqual(getTagUsage(importantTag.id), {
    noteCount: 1,
    activeNoteCount: 1,
    deletedNoteCount: 0,
    templateCount: 1,
    runningTemplateCount: 1,
    pausedTemplateCount: 0,
    deletedTemplateCount: 0
  })

  db.prepare('UPDATE notes SET is_deleted = 1 WHERE id = ?').run(firstNote.id)
  db.prepare('UPDATE note_templates SET is_paused = 1 WHERE id = ?').run(missedTemplate.id)
  db.prepare('UPDATE note_templates SET is_deleted = 1, is_paused = 1 WHERE id = ?').run(
    activeTemplate.id
  )
  assert.deepEqual(getTagUsage(dailyTag.id), {
    noteCount: 1,
    activeNoteCount: 0,
    deletedNoteCount: 1,
    templateCount: 2,
    runningTemplateCount: 0,
    pausedTemplateCount: 1,
    deletedTemplateCount: 1
  })
  db.prepare('UPDATE notes SET is_deleted = 0 WHERE id = ?').run(firstNote.id)
  db.prepare('UPDATE note_templates SET is_paused = 0 WHERE id = ?').run(missedTemplate.id)
  db.prepare('UPDATE note_templates SET is_deleted = 0, is_paused = 0 WHERE id = ?').run(
    activeTemplate.id
  )

  const secondDue = getTemplateById(activeTemplate.id).next_run_at
  const secondRun = runRecurringTemplates({ now: secondDue + 20_000, reason: 'scheduled' })
  assert.equal(secondRun.count, 2)
  assert.equal(
    db.prepare('SELECT is_deleted FROM notes WHERE id = ?').get(firstNote.id).is_deleted,
    1
  )
  const secondNoteId = getTemplateById(activeTemplate.id).last_generated_note_id
  db.prepare("UPDATE notes SET status = 'completed' WHERE id = ?").run(secondNoteId)

  const thirdDue = getTemplateById(activeTemplate.id).next_run_at
  const thirdRun = runRecurringTemplates({ now: thirdDue + 20_000, reason: 'scheduled' })
  assert.equal(thirdRun.count, 2)
  assert.equal(
    db.prepare('SELECT is_deleted FROM notes WHERE id = ?').get(secondNoteId).is_deleted,
    0
  )

  const pauseAt = localTs(2025, 7, 23, 12)
  pauseTemplate(activeTemplate.id, pauseAt)
  assert.equal(getTemplateById(activeTemplate.id).next_run_at, null)
  const resumeAt = localTs(2025, 7, 25, 10)
  const resumed = resumeTemplate(activeTemplate.id, resumeAt)
  assert.equal(resumed.is_paused, 0)
  assert.equal(resumed.next_run_at, localTs(2025, 7, 26, 9))

  deleteTemplate(activeTemplate.id, localTs(2025, 7, 25, 11))
  assert.equal(getTemplateById(activeTemplate.id), null)
  const restored = restoreTemplate(activeTemplate.id, localTs(2025, 7, 27, 10))
  assert.equal(restored.is_deleted, 0)
  assert.equal(restored.is_paused, 0)
  assert.equal(restored.next_run_at, localTs(2025, 7, 28, 9))

  const intervalTemplate = createTemplate(
    {
      content: '保留三天循环节奏',
      recurrenceRule: { frequency: 'daily', interval: 3, time_of_day: '09:00' }
    },
    localTs(2025, 7, 20, 8)
  )
  pauseTemplate(intervalTemplate.id, localTs(2025, 7, 21, 12))
  const intervalResumed = resumeTemplate(intervalTemplate.id, localTs(2025, 7, 22, 10))
  assert.equal(intervalResumed.schedule_anchor_at, localTs(2025, 7, 20, 8))
  assert.equal(intervalResumed.next_run_at, localTs(2025, 7, 23, 9))
  deleteTemplate(intervalTemplate.id, localTs(2025, 7, 22, 11))
  const intervalRestored = restoreTemplate(intervalTemplate.id, localTs(2025, 7, 24, 10))
  assert.equal(intervalRestored.schedule_anchor_at, localTs(2025, 7, 20, 8))
  assert.equal(intervalRestored.next_run_at, localTs(2025, 7, 26, 9))

  const unchangedSchedule = updateTemplate(
    missedTemplate.id,
    {
      content: '只修改正文不重排时间',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
    },
    localTs(2025, 7, 22, 12)
  )
  assert.equal(unchangedSchedule.schedule_anchor_at, missedAnchor)
  assert.equal(unchangedSchedule.next_run_at, localTs(2025, 7, 23, 9))

  const failingTemplate = createTemplate(
    {
      content: '连续失败后暂停',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
    },
    localTs(2025, 8, 1, 8)
  )
  db.prepare("UPDATE note_templates SET recurrence_rule = '{bad json' WHERE id = ?").run(
    failingTemplate.id
  )
  console.error = () => {}
  const failingDue = localTs(2025, 8, 1, 9)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const failureResult = runRecurringTemplates({
      now: failingDue + attempt * 10_000,
      reason: 'scheduled'
    })
    const failedRow = getTemplateById(failingTemplate.id, { includeDeleted: true })
    assert.equal(
      failureResult.errors.some((item) => item.templateId === failingTemplate.id),
      true
    )
    assert.equal(failedRow.consecutive_failures, attempt)
    if (attempt < 3) {
      assert.equal(failedRow.is_paused, 0)
      assert.equal(failureResult.autoPaused.length, 0)
    } else {
      assert.equal(failedRow.is_paused, 1)
      assert.equal(failedRow.pause_reason, 'error')
      assert.equal(failedRow.next_run_at, null)
      assert.equal(failureResult.autoPaused[0].id, failingTemplate.id)
    }
  }

  const failedBeforeEdit = getTemplateById(failingTemplate.id, { includeDeleted: true })
  updateTemplate(failingTemplate.id, {
    content: '修改正文但保留错误状态',
    recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
  })
  const failedAfterEdit = getTemplateById(failingTemplate.id, { includeDeleted: true })
  assert.equal(failedAfterEdit.is_paused, 1)
  assert.equal(failedAfterEdit.pause_reason, 'error')
  assert.equal(failedAfterEdit.consecutive_failures, failedBeforeEdit.consecutive_failures)
  assert.equal(failedAfterEdit.last_error, failedBeforeEdit.last_error)

  const listedTemplates = listTemplates({ state: 'all' })
  const listedActive = listedTemplates.find((template) => template.id === activeTemplate.id)
  assert.deepEqual(listedActive.tags.map((tag) => tag.name).sort(), ['日常', '重要'])

  const commitFailureTemplate = createTemplate(
    {
      content: '提交失败不通知',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
    },
    localTs(2025, 8, 2, 8)
  )
  // 隔离本用例，避免其他正常模板在同一时间节点生成便签并进入结果计数。
  pauseTemplate(missedTemplate.id, localTs(2025, 8, 2, 8, 30))
  pauseTemplate(activeTemplate.id, localTs(2025, 8, 2, 8, 30))
  pauseTemplate(intervalTemplate.id, localTs(2025, 8, 2, 8, 30))
  db.pragma('foreign_keys = OFF')
  db.prepare('INSERT INTO template_tags (template_id, tag_id) VALUES (?, ?)').run(
    commitFailureTemplate.id,
    999999
  )
  db.pragma('foreign_keys = ON')
  db.pragma('defer_foreign_keys = ON')
  const commitFailure = runRecurringTemplates({
    now: localTs(2025, 8, 2, 9, 0, 10),
    reason: 'scheduled'
  })
  assert.equal(commitFailure.count, 0)
  assert.equal(commitFailure.generated.length, 0)
  assert.equal(
    commitFailure.errors.some((item) => item.templateId === commitFailureTemplate.id),
    true
  )
  db.prepare('DELETE FROM template_tags WHERE template_id = ? AND tag_id = ?').run(
    commitFailureTemplate.id,
    999999
  )

  const lastNoteId = restored.last_generated_note_id
  assert.equal(db.prepare('DELETE FROM notes WHERE id = ?').run(lastNoteId).changes, 1)
  assert.equal(getTemplateById(activeTemplate.id).last_generated_note_id, null)

  deleteTemplate(activeTemplate.id, localTs(2025, 7, 27, 11))
  const noteCountBeforePurge = db.prepare('SELECT COUNT(*) AS count FROM notes').get().count
  assert.equal(purgeTemplate(activeTemplate.id), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, noteCountBeforePurge)

  const renamedDaily = updateTag(dailyTag.id, { name: '日常事务', color: '#00c7be' })
  assert.equal(renamedDaily.oldName, '日常')
  assert.equal(getNoteById(secondNoteId).tags[0].id, dailyTag.id)
  const usageBeforeDelete = getTagUsage(dailyTag.id)
  assert.equal(usageBeforeDelete.templateCount, 1)
  assert.equal(deleteTag(dailyTag.id), true)
  assert.deepEqual(getTagUsage(dailyTag.id), {
    noteCount: 0,
    activeNoteCount: 0,
    deletedNoteCount: 0,
    templateCount: 0,
    runningTemplateCount: 0,
    pausedTemplateCount: 0,
    deletedTemplateCount: 0
  })

  const defaultDurationNote = createNote({ content: '默认单日便签' })
  const multiDayNote = createNote({ content: '跨日便签', durationDays: 7 })
  assert.equal(defaultDurationNote.duration_days, 1)
  assert.equal(multiDayNote.duration_days, 7)
  assert.throws(() => createNote({ content: '无效持续时间', durationDays: 366 }), /持续天数/)

  const stickySource = createNote({ content: '便利贴持久化来源' })
  const stickyRecord = {
    id: 'sticky-integration-1',
    noteId: stickySource.id,
    content: stickySource.content,
    bounds: { x: 100, y: 120, width: 280, height: 260 },
    displayId: 'display-1',
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    fontSize: 16,
    backgroundColor: '#FFF2A8',
    cornerRadius: 0,
    pinned: false,
    createdAt: localTs(2025, 7, 20, 10),
    updatedAt: localTs(2025, 7, 20, 10)
  }
  insertDesktopStickyRecord(stickyRecord)
  assert.equal(countDesktopStickyRecords(), 1)
  assert.equal(hasDesktopStickyRecord(stickyRecord.id), true)
  assert.deepEqual(listDesktopStickyRecords()[0].bounds, stickyRecord.bounds)
  assert.equal(
    updateDesktopStickyRecord(stickyRecord.id, {
      boundsX: 160,
      alwaysOnTop: true,
      updatedAt: localTs(2025, 7, 20, 11)
    }),
    true
  )
  assert.equal(listDesktopStickyRecords()[0].bounds.x, 160)
  assert.equal(listDesktopStickyRecords()[0].pinned, true)
  assert.equal(deleteDesktopStickyRecord(stickyRecord.id), true)
  assert.equal(hasDesktopStickyRecord(stickyRecord.id), false)
  insertDesktopStickyRecord(stickyRecord)
  db.prepare('DELETE FROM notes WHERE id = ?').run(stickySource.id)
  assert.equal(countDesktopStickyRecords(), 0, '彻底删除来源便签必须级联删除便利贴记录')

  const literalPercentNote = createNote({ content: '进度 100% 已完成' })
  const literalUnderscoreNote = createNote({ content: '项目_alpha' })
  assert.deepEqual(
    searchNotes({ search: '%', includeDeleted: false }).notes.map((note) => note.id),
    [literalPercentNote.id]
  )
  assert.deepEqual(
    searchNotes({ search: '_', includeDeleted: false }).notes.map((note) => note.id),
    [literalUnderscoreNote.id]
  )

  const pageCutoff = Date.now() + 60_000
  assert.equal(queryEarlierNotes({ cutoffTime: pageCutoff, limit: 0, offset: -10 }).notes.length, 0)
  assert.equal(queryEarlierNotes({ cutoffTime: pageCutoff, limit: -1 }).notes.length <= 100, true)
  assert.equal(queryCustomNormal({ limit: 10_000, offset: -5 }).notes.length <= 100, true)

  const completedForReopen = createNote({ content: '重新进行保留原时间' })
  const originalEffectiveAt = completedForReopen.effective_at
  db.prepare("UPDATE notes SET status = 'completed' WHERE id = ?").run(completedForReopen.id)
  const reopened = reopenNote(completedForReopen.id)
  assert.equal(reopened.status, 'in_progress')
  assert.equal(reopened.effective_at, originalEffectiveAt)

  const firstGroupTag = createTag('标签分组甲', '#3366ff')
  const secondGroupTag = createTag('标签分组乙', '#ff6633')
  const laterGroupedNote = createNote({ content: '标签组未来便签' })
  const earlierPinnedGroupedNote = createNote({ content: '标签组过去置顶便签' })
  const otherStatusGroupedNote = createNote({ content: '标签组其他状态便签' })
  const untaggedGroupedNote = createNote({ content: '未分类测试便签' })
  setNoteTagIds(laterGroupedNote.id, [firstGroupTag.id])
  setNoteTagIds(earlierPinnedGroupedNote.id, [firstGroupTag.id])
  setNoteTagIds(otherStatusGroupedNote.id, [secondGroupTag.id])
  db.prepare(
    "UPDATE notes SET status = 'initialized', effective_at = ?, is_pinned = 0 WHERE id = ?"
  ).run(localTs(2100, 1, 1), laterGroupedNote.id)
  db.prepare(
    "UPDATE notes SET status = 'initialized', effective_at = ?, is_pinned = 1 WHERE id = ?"
  ).run(localTs(2000, 1, 1), earlierPinnedGroupedNote.id)
  db.prepare("UPDATE notes SET status = 'completed' WHERE id = ?").run(otherStatusGroupedNote.id)
  db.prepare("UPDATE notes SET status = 'initialized', effective_at = ? WHERE id = ?").run(
    localTs(2099, 1, 1),
    untaggedGroupedNote.id
  )

  assert.deepEqual(
    queryTagGroups({
      tagIds: [firstGroupTag.id, secondGroupTag.id],
      statuses: ['initialized']
    }).map(({ name, total, untagged }) => ({ name, total, untagged })),
    [
      { name: '标签分组甲', total: 2, untagged: false },
      { name: '标签分组乙', total: 0, untagged: false }
    ]
  )
  const allTagGroups = queryTagGroups({ statuses: ['initialized'] })
  assert.equal(allTagGroups.at(-1).key, 'untagged')
  assert.equal(allTagGroups.at(-1).total >= 1, true)

  const firstTagPage = queryTagGroupNotes({
    tagId: firstGroupTag.id,
    statuses: ['initialized'],
    limit: 1,
    offset: 0
  })
  const secondTagPage = queryTagGroupNotes({
    tagId: firstGroupTag.id,
    statuses: ['initialized'],
    limit: 1,
    offset: 1
  })
  assert.equal(firstTagPage.total, 2)
  assert.equal(firstTagPage.notes[0].content, '标签组未来便签')
  assert.equal(secondTagPage.notes[0].content, '标签组过去置顶便签')
  assert.equal(
    queryTagGroupNotes({ tagId: null, statuses: ['initialized'], limit: 100 }).notes.some(
      (note) => note.id === untaggedGroupedNote.id
    ),
    true
  )

  const calendarInsert = db.prepare(`
    INSERT INTO notes (
      content, status, is_deleted, is_pinned, notify_enabled, effective_at,
      duration_days, finished_at, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?)
  `)
  const calendarCreatedAt = localTs(2026, 7, 1)
  calendarInsert.run(
    '月历跨月便签',
    'completed',
    0,
    1,
    localTs(2026, 7, 30, 9),
    5,
    localTs(2026, 7, 31, 10),
    calendarCreatedAt,
    calendarCreatedAt
  )
  calendarInsert.run(
    '月历已删除便签',
    'in_progress',
    1,
    0,
    localTs(2026, 8, 3, 9),
    1,
    calendarCreatedAt,
    calendarCreatedAt,
    calendarCreatedAt
  )
  calendarInsert.run(
    '月历范围外便签',
    'in_progress',
    0,
    0,
    localTs(2026, 10, 1, 9),
    1,
    calendarCreatedAt,
    calendarCreatedAt,
    calendarCreatedAt
  )
  const calendar = getMonthCalendarData(2026, 8)
  assert.equal(calendar.days.length, 42)
  assert.equal(calendar.days[0].weekday, 0)
  assert.equal(calendar.visibleStart, '2026-07-27')
  assert.equal(
    calendar.notes.some((note) => note.content === '月历跨月便签'),
    true
  )
  assert.equal(
    calendar.notes.some((note) => note.content === '月历已删除便签'),
    false
  )
  assert.equal(
    calendar.notes.some((note) => note.content === '月历范围外便签'),
    false
  )
  assert.deepEqual(
    queryDailyReportNotes({ dateKey: '2026-08-01', statuses: ['completed'] }).map(
      (note) => note.content
    ),
    ['月历跨月便签']
  )
  assert.deepEqual(queryDailyReportNotes({ dateKey: '2026-08-01', statuses: ['in_progress'] }), [])

  console.log('backend integration tests passed')
} finally {
  console.error = originalConsoleError
  clearDb()
  db.close()
}
