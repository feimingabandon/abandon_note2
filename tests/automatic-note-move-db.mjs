import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseSchema, DATABASE_SCHEMA_VERSION } from '../src/main/db/db-schema.js'
import { setDb, clearDb } from '../src/main/db/db-connection.js'
import { createRecurringNoteSnapshot } from '../src/main/db/db-notes.js'
import { runAutomaticNoteMove } from '../src/main/services/automatic-note-move.js'

const dir = mkdtempSync(join(tmpdir(), 'abandon-auto-move-db-'))
const path = join(dir, 'test.db')
let db = new Database(path)
const ts = (day, hour = 8) => new Date(2026, 8, day, hour).getTime()
const current = ts(8)
function seed(content, { day = 7, duration = 1, status = 'in_progress', deleted = 0 } = {}) {
  return Number(
    db
      .prepare(
        `INSERT INTO notes
    (content, status, is_deleted, effective_at, duration_days, created_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(content, status, deleted, ts(day), duration, ts(1), ts(1), ts(2)).lastInsertRowid
  )
}
const read = (id) => db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
function linkTemplate(id) {
  return Number(
    db
      .prepare(
        `INSERT INTO note_templates
    (content, recurrence_rule, schedule_anchor_at, last_generated_note_id, created_at, updated_at)
    VALUES ('模板', '{}', ?, ?, ?, ?)`
      )
      .run(ts(1), id, ts(1), ts(1)).lastInsertRowid
  )
}

try {
  createDatabaseSchema(db)
  setDb(db)
  const ordinary = seed('普通单日')
  const multi = seed('跨日', { duration: 3 })
  const complete = seed('已完成', { status: 'completed' })
  const future = seed('未到期', { status: 'initialized' })
  const deleted = seed('已删除', { deleted: 1 })
  const older = seed('前天', { day: 6 })
  const today = seed('今天', { day: 8 })
  const recurring = seed('旧模板实例')
  const template = linkTemplate(recurring)
  db.exec('ALTER TABLE notes DROP COLUMN from_template; PRAGMA user_version = 8;')
  createDatabaseSchema(db)
  assert.equal(db.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
  assert.equal(read(recurring).from_template, 1)
  assert.equal(read(ordinary).from_template, 0)
  createDatabaseSchema(db)
  db.prepare('DELETE FROM note_templates WHERE id = ?').run(template)
  assert.equal(read(recurring).from_template, 1, '模板删除不能抹去来源')
  const generated = createRecurringNoteSnapshot({ content: '新模板实例', effectiveAt: ts(7) })
  assert.equal(generated.from_template, 1)
  db.prepare('UPDATE notes SET status = ? WHERE id = ?').run('completed', generated.id)
  db.prepare('UPDATE notes SET status = ? WHERE id = ?').run('in_progress', generated.id)

  const original = read(ordinary)
  assert.equal(runAutomaticNoteMove({ enabled: false, now: current }).count, 0)
  assert.equal(read(ordinary).effective_at, original.effective_at)
  const result = runAutomaticNoteMove({ enabled: true, now: current })
  assert.equal(result.count, 1)
  assert.equal(result.sourceDateKey, '2026-09-07')
  assert.equal(result.targetDateKey, '2026-09-08')
  assert.equal(read(ordinary).effective_at, current)
  assert.equal(read(ordinary).updated_at, current)
  for (const key of ['content', 'created_at', 'finished_at', 'status', 'duration_days']) {
    assert.equal(read(ordinary)[key], original[key])
  }
  for (const id of [multi, complete, future, deleted, recurring, generated.id]) {
    assert.equal(read(id).effective_at, ts(7))
  }
  assert.equal(read(older).effective_at, ts(6))
  assert.equal(read(today).effective_at, ts(8))

  const late = seed('当天检查之后补录')
  db.close()
  db = new Database(path)
  setDb(db)
  assert.equal(runAutomaticNoteMove({ enabled: true, now: current + 60_000 }).skipped, true)
  assert.equal(read(late).effective_at, ts(7), '重启同一天不再次自动扫历史')
  assert.equal(runAutomaticNoteMove({ enabled: true, now: ts(7) }).skipped, true)
  assert.equal(runAutomaticNoteMove({ enabled: true, now: current, force: true }).count, 1)

  db.exec(`CREATE TRIGGER fail_auto_checkpoint BEFORE UPDATE ON app_settings
    WHEN NEW.key = 'auto_move_last_date' BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END;`)
  assert.throws(() => runAutomaticNoteMove({ enabled: true, now: ts(9) }), /checkpoint failed/)
  assert.equal(read(ordinary).effective_at, current, '完成标记失败必须回滚移动')
  db.exec('DROP TRIGGER fail_auto_checkpoint')
  assert.equal(runAutomaticNoteMove({ enabled: true, now: ts(9) }).count, 3)
  assert.equal(
    runAutomaticNoteMove({ enabled: true, now: ts(12) }).count,
    0,
    '停用多天后只处理昨天，不补搬所有历史'
  )
  console.log(
    'automatic note move: V8 migration, origin exclusion, daily/restart deduplication, clock rollback and atomic failure passed'
  )
} finally {
  clearDb()
  db.close()
  rmSync(dir, { recursive: true, force: true })
}
