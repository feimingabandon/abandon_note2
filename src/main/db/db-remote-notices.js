import { getDb } from './db-connection.js'

const NOTICE_SCOPE = 'notices'

function normalizeLimit(value, fallback = 100) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(500, Math.max(1, parsed)) : fallback
}

function normalizeOffset(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.max(0, parsed) : 0
}

export function getRemoteNoticeCursor() {
  const row = getDb()
    .prepare('SELECT cursor FROM remote_sync_state WHERE scope = ?')
    .get(NOTICE_SCOPE)
  return Number(row?.cursor || 0)
}

export function ingestRemoteNotices(notices, nextCursor) {
  const db = getDb()
  const insert = db.prepare(`
    INSERT INTO remote_notices (
      server_notice_id, sequence, title, body, link, published_at, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_notice_id) DO NOTHING
  `)
  const saveCursor = db.prepare(`
    INSERT INTO remote_sync_state (scope, cursor, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      cursor = MAX(remote_sync_state.cursor, excluded.cursor),
      updated_at = excluded.updated_at
  `)

  return db.transaction((rows, cursor) => {
    const receivedAt = Date.now()
    let inserted = 0
    rows.forEach((notice) => {
      const result = insert.run(
        notice.id,
        notice.sequence,
        notice.title,
        notice.body,
        notice.link,
        notice.publishedAt,
        receivedAt
      )
      inserted += result.changes
    })
    saveCursor.run(NOTICE_SCOPE, cursor, receivedAt)
    return inserted
  })(notices, nextCursor)
}

export function listPendingRemoteNotices() {
  return getDb()
    .prepare(
      `SELECT id, server_notice_id AS serverNoticeId, sequence, title, body, link,
              published_at AS publishedAt, received_at AS receivedAt
       FROM remote_notices
       WHERE acknowledged_at IS NULL
       ORDER BY published_at ASC, sequence ASC`
    )
    .all()
}

export function listRemoteNotices({ limit = 100, offset = 0 } = {}) {
  const db = getDb()
  const safeLimit = normalizeLimit(limit)
  const safeOffset = normalizeOffset(offset)
  const items = db
    .prepare(
      `SELECT id, server_notice_id AS serverNoticeId, sequence, title, body, link,
              published_at AS publishedAt, received_at AS receivedAt,
              acknowledged_at AS acknowledgedAt
       FROM remote_notices
       ORDER BY published_at DESC, sequence DESC
       LIMIT ? OFFSET ?`
    )
    .all(safeLimit, safeOffset)
  const total = Number(db.prepare('SELECT COUNT(*) AS total FROM remote_notices').get()?.total || 0)
  const pending = Number(
    db.prepare('SELECT COUNT(*) AS total FROM remote_notices WHERE acknowledged_at IS NULL').get()
      ?.total || 0
  )
  return { items, total, pending, limit: safeLimit, offset: safeOffset }
}

export function acknowledgeRemoteNotice(id) {
  const parsedId = Number(id)
  if (!Number.isInteger(parsedId) || parsedId <= 0) throw new Error('通知 ID 无效')
  const now = Date.now()
  const result = getDb()
    .prepare(
      `UPDATE remote_notices
       SET acknowledged_at = COALESCE(acknowledged_at, ?)
       WHERE id = ?`
    )
    .run(now, parsedId)
  return result.changes > 0
}

export function getRemoteNoticeLink(id) {
  const parsedId = Number(id)
  if (!Number.isInteger(parsedId) || parsedId <= 0) return null
  return getDb().prepare('SELECT link FROM remote_notices WHERE id = ?').get(parsedId)?.link || null
}
