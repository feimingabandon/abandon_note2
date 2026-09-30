import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { setDb, clearDb } from '../src/main/db/db-connection.js'
import {
  createNote,
  activateNotes,
  completeNote,
  deleteNote,
  reopenNote,
  restoreNote,
  getNoteById
} from '../src/main/db/db-notes.js'
import { createTemplate } from '../src/main/db/db-templates.js'
import { runRecurringTemplates } from '../src/main/services/recurrence.js'
import {
  activateDueReminders,
  getReminder,
  getPendingReminder,
  snoozeReminder,
  editPendingReminder
} from '../src/main/db/db-reminders.js'

let db = new Database(':memory:')
db.pragma('foreign_keys = ON')
createDatabaseSchema(db)
setDb(db)
const now = Date.now()
const dueNote = (channels = 7) => {
  const note = createNote({
    content: '提醒 <测试>',
    effectiveAt: now + 120000,
    reminderChannels: channels
  })
  db.prepare('UPDATE notes SET effective_at = ? WHERE id = ?').run(now - 1000, note.id)
  activateNotes()
  return {
    note: getNoteById(note.id),
    round: activateDueReminders(now).find((r) => r.note_id === note.id)
  }
}

try {
  const { note, round } = dueNote()
  assert.equal(note.status, 'in_progress')
  assert.equal(note.notify_enabled, 0)
  assert.equal(note.reminder_channels, 7)
  const first = snoozeReminder(round.id, now + 600000, now)
  const duplicate = snoozeReminder(round.id, now + 1800000, now)
  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(first.reminder.id, duplicate.reminder.id)
  assert.equal(duplicate.reminder.due_at, now + 600000)
  assert.equal(getNoteById(note.id).effective_at, note.effective_at)
  assert.equal(getNoteById(note.id).finished_at, note.finished_at)
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO note_reminders (id,note_id,due_at,created_at,updated_at)
    VALUES ('duplicate',?,1,1,1)`
        )
        .run(note.id),
    /UNIQUE/
  )
  activateDueReminders(now + 600000)
  assert.throws(() => snoozeReminder(round.id, now + 1800000, now + 600000), /这轮提醒已处理/)
  const second = snoozeReminder(first.reminder.id, now + 1200000, now + 600000)
  assert.ok(second.created)
  editPendingReminder(
    note.id,
    { id: second.reminder.id, expectedDueAt: now + 1200000, dueAt: now + 1800000 },
    now
  )
  assert.equal(getPendingReminder(note.id).due_at, now + 1800000)
  assert.throws(
    () =>
      editPendingReminder(
        note.id,
        { id: second.reminder.id, expectedDueAt: now + 1200000, dueAt: now + 2000000 },
        now
      ),
    /发生变化/
  )
  completeNote(note.id)
  assert.equal(getPendingReminder(note.id), null)
  assert.equal(getReminder(second.reminder.id).state, 'cancelled')
  reopenNote(note.id)
  assert.equal(getNoteById(note.id).reminder_channels, 0)
  assert.throws(() => snoozeReminder(first.reminder.id, now + 2000000, now), /关闭提醒/)

  const rollback = dueNote()
  db.exec(`CREATE TRIGGER fail_snooze BEFORE INSERT ON note_reminders WHEN NEW.parent_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`)
  assert.throws(() => snoozeReminder(rollback.round.id, now + 600000, now), /injected/)
  assert.equal(getReminder(rollback.round.id).state, 'active')
  db.exec('DROP TRIGGER fail_snooze')
  deleteNote(rollback.note.id)
  assert.equal(getReminder(rollback.round.id).state, 'cancelled')
  restoreNote(rollback.note.id)
  assert.equal(getNoteById(rollback.note.id).reminder_channels, 0)

  const disabled = dueNote(2)
  snoozeReminder(disabled.round.id, now + 600000, now)
  db.prepare('UPDATE notes SET reminder_channels = 0 WHERE id = ?').run(disabled.note.id)
  assert.equal(getPendingReminder(disabled.note.id), null)

  const restart = dueNote(6)
  const saved = snoozeReminder(restart.round.id, now + 600000, now)
  const bytes = db.serialize()
  clearDb()
  db.close()
  db = new Database(bytes)
  db.pragma('foreign_keys = ON')
  createDatabaseSchema(db)
  setDb(db)
  assert.equal(getPendingReminder(restart.note.id).id, saved.reminder.id)
  activateDueReminders(now + 600001)
  activateDueReminders(now + 660000)
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM note_reminders WHERE note_id = ? AND state = 'active'")
      .get(restart.note.id).n,
    1
  )

  const template = createTemplate(
    {
      content: '模板提醒',
      reminderChannels: 6,
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '00:01' }
    },
    now - 86400000
  )
  runRecurringTemplates({ now })
  const instance = db
    .prepare(
      'SELECT * FROM notes WHERE id = (SELECT last_generated_note_id FROM note_templates WHERE id = ?)'
    )
    .get(template.id)
  assert.equal(instance.reminder_channels, 6)
  const templateRound = activateDueReminders(now).find((r) => r.note_id === instance.id)
  snoozeReminder(templateRound.id, now + 172800000, now)
  runRecurringTemplates({ now: now + 86400000 })
  assert.equal(getPendingReminder(instance.id), null)
  assert.equal(
    db.prepare('SELECT is_deleted FROM notes WHERE id = ?').get(instance.id).is_deleted,
    1
  )

  // Reconstruct a V16 database with on/off notification values, then migrate twice.
  clearDb()
  db.close()
  db = new Database(':memory:')
  createDatabaseSchema(db)
  setDb(db)
  const legacyOn = createNote({ content: '旧提醒', effectiveAt: now + 120000, notifyEnabled: true })
  const legacyOff = createNote({ content: '旧关闭', effectiveAt: now + 120000 })
  db.exec(`DROP TRIGGER cancel_note_reminders; DROP TABLE note_reminders;
    ALTER TABLE notes DROP COLUMN reminder_channels;
    ALTER TABLE note_templates DROP COLUMN reminder_channels; PRAGMA user_version=16;`)
  createDatabaseSchema(db)
  createDatabaseSchema(db)
  assert.equal(getNoteById(legacyOn.id).reminder_channels, 1)
  assert.equal(getNoteById(legacyOff.id).reminder_channels, 0)
  console.log(
    'REMINDER_DATABASE_OK: migration, first-wins, stale-round, repeat snooze, edit conflict, rollback, completion, deletion, channels, restart, template replacement'
  )
} finally {
  clearDb()
  db.close()
}
