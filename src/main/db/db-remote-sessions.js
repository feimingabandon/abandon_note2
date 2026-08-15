import { getDb } from './db-connection.js'

const MAX_OUTBOX_ITEMS = 20
const MAX_OUTBOX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function queueRemoteSessionEnd(sessionId, endedAt = new Date().toISOString()) {
  const id = String(sessionId || '').trim()
  if (!id) throw new Error('远程会话 ID 不能为空')
  const timestamp = Date.parse(endedAt)
  if (!Number.isFinite(timestamp)) throw new Error('远程会话退出时间无效')
  const now = Date.now()
  const db = getDb()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO remote_session_end_outbox (
         session_id, ended_at, attempts, created_at, updated_at
       ) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         ended_at = excluded.ended_at,
         updated_at = excluded.updated_at`
    ).run(id, new Date(timestamp).toISOString(), now, now)
    db.prepare('DELETE FROM remote_session_end_outbox WHERE created_at < ?').run(
      now - MAX_OUTBOX_AGE_MS
    )
    db.prepare(
      `DELETE FROM remote_session_end_outbox
       WHERE session_id IN (
         SELECT session_id FROM remote_session_end_outbox
         ORDER BY created_at DESC
         LIMIT -1 OFFSET ?
       )`
    ).run(MAX_OUTBOX_ITEMS)
  })()
}

export function listPendingRemoteSessionEnds() {
  const cutoff = Date.now() - MAX_OUTBOX_AGE_MS
  const db = getDb()
  db.prepare('DELETE FROM remote_session_end_outbox WHERE created_at < ?').run(cutoff)
  return db
    .prepare(
      `SELECT session_id AS sessionId, ended_at AS endedAt, attempts
       FROM remote_session_end_outbox
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(MAX_OUTBOX_ITEMS)
}

export function markRemoteSessionEndAttempt(sessionId) {
  getDb()
    .prepare(
      `UPDATE remote_session_end_outbox
       SET attempts = attempts + 1, updated_at = ?
       WHERE session_id = ?`
    )
    .run(Date.now(), sessionId)
}

export function removePendingRemoteSessionEnd(sessionId) {
  return (
    getDb().prepare('DELETE FROM remote_session_end_outbox WHERE session_id = ?').run(sessionId)
      .changes > 0
  )
}

export function clearPendingRemoteSessionEnds() {
  return getDb().prepare('DELETE FROM remote_session_end_outbox').run().changes
}
