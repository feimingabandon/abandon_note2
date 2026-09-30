import { randomUUID } from 'node:crypto'
import { getDb } from './db-connection.js'
import { assertSnoozeTime } from '../../shared/reminder-rules.js'

// One live round per note. A snoozed round is retained so old notification actions
// remain invalid even after its successor has fired or been cancelled.
export function createReminderSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_reminders (
      id TEXT PRIMARY KEY,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      parent_id TEXT UNIQUE,
      due_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'scheduled'
        CHECK(state IN ('scheduled', 'active', 'snoozed', 'cancelled')),
      delivered_channels INTEGER NOT NULL DEFAULT 0,
      dismissed_channels INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_live_note ON note_reminders(note_id)
      WHERE state IN ('scheduled', 'active');
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON note_reminders(state, due_at);
    CREATE TRIGGER IF NOT EXISTS cancel_note_reminders
      AFTER UPDATE OF status, is_deleted, reminder_channels ON notes
      WHEN NEW.status = 'completed' OR NEW.is_deleted = 1 OR NEW.reminder_channels = 0
      BEGIN
        UPDATE note_reminders SET state = 'cancelled', updated_at = NEW.updated_at
          WHERE note_id = NEW.id AND state IN ('scheduled', 'active');
      END;
  `)
}

export function enqueueReminder(noteId, dueAt, timestamp = Date.now(), parentId = null) {
  const db = getDb()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO note_reminders (id, note_id, parent_id, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, noteId, parentId, dueAt, timestamp, timestamp)
  return getReminder(id)
}

const REMINDER_SELECT = `SELECT r.*, n.content, n.reminder_channels, n.status AS note_status,
  n.is_deleted, n.from_template FROM note_reminders r JOIN notes n ON n.id = r.note_id`

export function getReminder(id) {
  return getDb().prepare(`${REMINDER_SELECT} WHERE r.id = ?`).get(String(id)) || null
}

export function getPendingReminder(noteId) {
  return (
    getDb()
      .prepare(
        `SELECT id, due_at FROM note_reminders
    WHERE note_id = ? AND state = 'scheduled'`
      )
      .get(noteId) || null
  )
}

export function listActiveReminders() {
  return getDb()
    .prepare(
      `${REMINDER_SELECT} WHERE r.state = 'active'
    AND n.is_deleted = 0 AND n.status = 'in_progress' AND n.reminder_channels != 0
    ORDER BY r.due_at, r.created_at, r.id`
    )
    .all()
}

export function getNextReminderTime() {
  return getDb()
    .prepare(
      `SELECT MIN(r.due_at) AS due_at FROM note_reminders r
    JOIN notes n ON n.id = r.note_id WHERE r.state = 'scheduled'
    AND n.status = 'in_progress' AND n.is_deleted = 0 AND n.reminder_channels != 0`
    )
    .get().due_at
}

export function activateDueReminders(timestamp = Date.now()) {
  const db = getDb()
  db.prepare(
    `UPDATE note_reminders SET state = 'active', updated_at = ?
    WHERE state = 'scheduled' AND due_at <= ? AND note_id IN (
      SELECT id FROM notes WHERE status = 'in_progress' AND is_deleted = 0 AND reminder_channels != 0
    )`
  ).run(timestamp, timestamp)
  return listActiveReminders()
}

export function snoozeReminder(id, dueAt, timestamp = Date.now()) {
  const db = getDb()
  return db.transaction(() => {
    const round = getReminder(id)
    if (
      !round ||
      round.is_deleted ||
      round.note_status !== 'in_progress' ||
      !round.reminder_channels
    ) {
      throw new Error('便签已完成、删除或关闭提醒，本次操作已失效')
    }
    const pending = getPendingReminder(round.note_id)
    if (round.state === 'snoozed' && pending) {
      const child = getReminder(pending.id)
      if (child.parent_id === round.id) return { created: false, reminder: child }
    }
    if (round.state !== 'active') throw new Error('这轮提醒已处理，请使用最新提醒')
    if (pending) return { created: false, reminder: getReminder(pending.id) }
    const nextTime = assertSnoozeTime(dueAt, timestamp)
    db.prepare(
      `UPDATE note_reminders SET state = 'snoozed', updated_at = ?
      WHERE id = ? AND state = 'active'`
    ).run(timestamp, round.id)
    const reminder = enqueueReminder(round.note_id, nextTime, timestamp, round.id)
    // Invalidate stale note-editor drafts without altering effective/status times.
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(timestamp, round.note_id)
    return { created: true, reminder }
  })()
}

// Called inside the note draft transaction. An old editor cannot modify a newer round.
export function editPendingReminder(noteId, request, timestamp = Date.now()) {
  const current = getPendingReminder(noteId)
  if (!current || current.id !== request.id || current.due_at !== request.expectedDueAt) {
    throw new Error('下次提醒已发生变化，请重新打开便签后修改')
  }
  if (request.dueAt === null) {
    getDb()
      .prepare("UPDATE note_reminders SET state = 'cancelled', updated_at = ? WHERE id = ?")
      .run(timestamp, current.id)
  } else {
    const dueAt = assertSnoozeTime(request.dueAt, timestamp)
    getDb()
      .prepare('UPDATE note_reminders SET due_at = ?, updated_at = ? WHERE id = ?')
      .run(dueAt, timestamp, current.id)
  }
}

export function markReminderDelivered(id, channels) {
  getDb()
    .prepare(
      `UPDATE note_reminders SET delivered_channels = delivered_channels | ?
    WHERE id = ? AND state = 'active'`
    )
    .run(channels, id)
}

export function markReminderAttempt(id, timestamp = Date.now()) {
  getDb()
    .prepare(
      `UPDATE note_reminders SET attempts = attempts + 1, next_attempt_at = ?
    WHERE id = ? AND state = 'active'`
    )
    .run(timestamp + 60000, id)
}

export function markReminderFailure(id, channel) {
  getDb()
    .prepare(
      `UPDATE note_reminders SET delivered_channels = delivered_channels & ?
    WHERE id = ? AND state = 'active'`
    )
    .run(~channel, id)
}

export function dismissReminderChannel(id, channel) {
  getDb()
    .prepare(
      `UPDATE note_reminders SET dismissed_channels = dismissed_channels | ?
    WHERE id = ? AND state = 'active'`
    )
    .run(channel, id)
}
