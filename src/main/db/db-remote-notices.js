import { getDb } from './db-connection.js'

const NOTICE_SCOPE = 'notices-v2'

function normalizeLimit(value, fallback = 100) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(500, Math.max(1, parsed)) : fallback
}

function normalizeOffset(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.max(0, parsed) : 0
}

export function getRemoteNoticeSyncState() {
  const row = getDb()
    .prepare('SELECT stream_id AS streamId, cursor FROM remote_notice_stream_state WHERE scope = ?')
    .get(NOTICE_SCOPE)
  return {
    streamId: row?.streamId || null,
    cursor: Number(row?.cursor || 0)
  }
}

export function applyRemoteNoticeEvents(streamId, events, nextCursor) {
  const normalizedStreamId = String(streamId || '').trim()
  if (!normalizedStreamId) throw new Error('通知流 ID 无效')
  const cursor = Number(nextCursor)
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error('通知游标无效')
  const db = getDb()
  const insert = db.prepare(`
    INSERT INTO remote_notices (
      server_notice_id, sequence, title, body, link, published_at, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_notice_id) DO UPDATE SET
      sequence = excluded.sequence,
      title = excluded.title,
      body = excluded.body,
      link = excluded.link,
      published_at = excluded.published_at,
      received_at = excluded.received_at,
      acknowledged_at = CASE WHEN ? THEN NULL ELSE remote_notices.acknowledged_at END
  `)
  const revoke = db.prepare('DELETE FROM remote_notices WHERE server_notice_id = ?')
  const saveState = db.prepare(`
    INSERT INTO remote_notice_stream_state (scope, stream_id, cursor, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      stream_id = excluded.stream_id,
      cursor = excluded.cursor,
      updated_at = excluded.updated_at
  `)

  return db.transaction((rows) => {
    const receivedAt = Date.now()
    const previous = getRemoteNoticeSyncState()
    const streamChanged = Boolean(previous.streamId && previous.streamId !== normalizedStreamId)
    if (streamChanged) db.prepare('DELETE FROM remote_notices').run()
    let inserted = 0
    let updated = 0
    let revoked = 0
    rows.forEach((event) => {
      const serverNoticeId = `${normalizedStreamId}:${event.noticeId}`
      if (event.type === 'revoke') {
        revoked += revoke.run(serverNoticeId).changes
        return
      }
      const existed = Boolean(
        db.prepare('SELECT 1 FROM remote_notices WHERE server_notice_id = ?').get(serverNoticeId)
      )
      const notice = event.notice
      insert.run(
        serverNoticeId,
        event.sequence,
        notice.title,
        notice.body,
        notice.link,
        notice.publishedAt,
        receivedAt,
        event.notifyAgain ? 1 : 0
      )
      if (existed) updated += 1
      else inserted += 1
    })
    saveState.run(NOTICE_SCOPE, normalizedStreamId, cursor, receivedAt)
    return {
      inserted,
      updated,
      revoked,
      streamChanged,
      changed: inserted + updated + revoked + (streamChanged ? 1 : 0)
    }
  })(events)
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
