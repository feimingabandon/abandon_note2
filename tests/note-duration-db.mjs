import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseSchema, DATABASE_SCHEMA_VERSION } from '../src/main/db/db-schema.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import {
  completeNote,
  createNote,
  queryCalendarNotes,
  reopenNote,
  updateNote
} from '../src/main/db/db-notes.js'
import {
  NOTE_DURATION_KINDS,
  addCalendarDays,
  localDateKey,
  localMidnightTimestamp,
  noteDateRange
} from '../src/shared/calendar/calendar-date-rules.js'

const dir = mkdtempSync(join(tmpdir(), 'abandon-note-duration-db-'))
const path = join(dir, 'test.db')
const db = new Database(path)

try {
  createDatabaseSchema(db)
  const historicalStart = localMidnightTimestamp('2025-01-01')
  db.prepare(
    `INSERT INTO notes
      (content, status, effective_at, duration_days, finished_at, created_at, updated_at)
     VALUES ('旧固定跨日', 'in_progress', ?, 3, ?, ?, ?)`
  ).run(historicalStart, historicalStart, historicalStart, historicalStart)
  db.prepare(
    `INSERT INTO app_settings
      (window_name, type, key, value, created_at, updated_at)
     VALUES ('application', 'notes', 'auto_move_yesterday', '1', ?, ?),
            ('application', 'notes', 'auto_move_last_date', '2026-09-20', ?, ?)`
  ).run(historicalStart, historicalStart, historicalStart, historicalStart)
  db.exec(`
    DROP INDEX IF EXISTS idx_notes_calendar_until_progress;
    DROP INDEX IF EXISTS idx_notes_calendar_until_completed;
    ALTER TABLE notes DROP COLUMN duration_kind;
    PRAGMA user_version = 12;
  `)

  createDatabaseSchema(db)
  assert.equal(db.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
  assert.equal(
    db.prepare("SELECT duration_kind FROM notes WHERE content = '旧固定跨日'").get().duration_kind,
    NOTE_DURATION_KINDS.FIXED_DAYS
  )
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS total FROM app_settings WHERE type = 'notes' AND key LIKE 'auto_move_%'"
      )
      .get().total,
    0
  )

  setDb(db)
  const single = createNote({ content: '默认一天' })
  assert.equal(single.duration_kind, NOTE_DURATION_KINDS.SINGLE_DAY)
  assert.equal(single.duration_days, 1)
  const modeOnlyFixed = updateNote(single.id, {
    durationKind: NOTE_DURATION_KINDS.FIXED_DAYS
  })
  assert.equal(modeOnlyFixed.duration_kind, NOTE_DURATION_KINDS.FIXED_DAYS)
  assert.equal(modeOnlyFixed.duration_days, 2)

  const fixed = createNote({ content: '指定三天', durationDays: 3 })
  assert.equal(fixed.duration_kind, NOTE_DURATION_KINDS.FIXED_DAYS)
  assert.equal(fixed.duration_days, 3)
  assert.throws(
    () =>
      createNote({
        content: '无效指定天数',
        durationKind: NOTE_DURATION_KINDS.FIXED_DAYS,
        durationDays: 1
      }),
    /2~365/
  )

  const oldDateKey = addCalendarDays(localDateKey(), -500)
  const ongoing = createNote({
    content: '长期进行中',
    effectiveAt: localMidnightTimestamp(oldDateKey),
    durationKind: NOTE_DURATION_KINDS.UNTIL_COMPLETED
  })
  assert.equal(ongoing.duration_kind, NOTE_DURATION_KINDS.UNTIL_COMPLETED)
  assert.equal(ongoing.duration_days, 1)
  assert.equal(noteDateRange(ongoing).durationDays, 501)
  const legacyDraftUpdate = updateNote(ongoing.id, { durationDays: 1 })
  assert.equal(legacyDraftUpdate.duration_kind, NOTE_DURATION_KINDS.UNTIL_COMPLETED)

  const expired = createNote({
    content: '已结束的长期便签',
    effectiveAt: localMidnightTimestamp(oldDateKey),
    durationKind: NOTE_DURATION_KINDS.UNTIL_COMPLETED
  })
  const expiredAt = localMidnightTimestamp(addCalendarDays(oldDateKey, 2))
  db.prepare(
    "UPDATE notes SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?"
  ).run(expiredAt, expiredAt, expired.id)

  const todayKey = localDateKey()
  const candidates = queryCalendarNotes({
    candidateFrom: localMidnightTimestamp(addCalendarDays(todayKey, -364)),
    visibleStart: localMidnightTimestamp(todayKey),
    visibleEndExclusive: localMidnightTimestamp(addCalendarDays(todayKey, 1)),
    hydrate: false
  })
  assert.ok(
    candidates.some((note) => note.id === ongoing.id),
    '超过一年仍未完成的便签必须可查询'
  )
  assert.ok(
    !candidates.some((note) => note.id === expired.id),
    '早已完成且与可见日期无交集的持续便签不应成为候选'
  )
  assert.deepEqual(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_notes_calendar_until_%' ORDER BY name"
      )
      .all()
      .map((row) => row.name),
    ['idx_notes_calendar_until_completed', 'idx_notes_calendar_until_progress']
  )

  const completed = completeNote(ongoing.id)
  assert.equal(completed.status, 'completed')
  assert.equal(noteDateRange(completed).endKey, localDateKey(completed.finished_at))
  const reopened = reopenNote(ongoing.id)
  assert.equal(reopened.status, 'in_progress')
  assert.equal(noteDateRange(reopened).endKey, todayKey)

  const changed = updateNote(ongoing.id, {
    durationKind: NOTE_DURATION_KINDS.FIXED_DAYS,
    durationDays: 4
  })
  assert.equal(changed.duration_kind, NOTE_DURATION_KINDS.FIXED_DAYS)
  assert.equal(changed.duration_days, 4)

  console.log('note duration modes: migration, defaults, dynamic range and reopen passed')
} finally {
  clearDb()
  db.close()
  rmSync(dir, { recursive: true, force: true })
}
