import { getDb } from '../db/db-connection.js'
import {
  addCalendarDays,
  localDateKey,
  localMidnightTimestamp
} from '../../shared/calendar/calendar-date-rules.js'

/** 每个本地自然日一次，移动和完成标记同一事务；开启开关时允许主动补检查。 */
export function runAutomaticNoteMove({ enabled, now = Date.now(), force = false } = {}) {
  if (!enabled) return { count: 0, skipped: true, reason: 'disabled' }
  if (!Number.isFinite(now) || now <= 0) throw new Error('自动移动时间无效')
  const targetDateKey = localDateKey(now)
  const sourceDateKey = addCalendarDays(targetDateKey, -1)
  const rangeStart = localMidnightTimestamp(sourceDateKey)
  const rangeEnd = localMidnightTimestamp(targetDateKey)
  const db = getDb()
  return db.transaction(() => {
    const lastDate = db
      .prepare(
        `SELECT value FROM app_settings
      WHERE window_name = 'application' AND key = 'auto_move_last_date'`
      )
      .get()?.value
    // 时钟回拨不重跑旧日期；用户重新开启时仍可明确要求补检查。
    if (!force && lastDate && lastDate >= targetDateKey) {
      return { count: 0, skipped: true, reason: 'already-checked', sourceDateKey, targetDateKey }
    }
    const count = db
      .prepare(
        `UPDATE notes
      SET effective_at = ?, notify_enabled = 0, updated_at = ?
      WHERE status = 'in_progress' AND is_deleted = 0
        AND duration_days = 1 AND from_template = 0
        AND effective_at >= ? AND effective_at < ?
        AND NOT EXISTS (SELECT 1 FROM note_templates t WHERE t.last_generated_note_id = notes.id)`
      )
      .run(now, now, rangeStart, rangeEnd).changes
    db.prepare(
      `INSERT INTO app_settings (window_name, type, key, value, created_at, updated_at)
      VALUES ('application', 'notes', 'auto_move_last_date', ?, ?, ?)
      ON CONFLICT(window_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(targetDateKey, now, now)
    return { count, skipped: false, sourceDateKey, targetDateKey, movedAt: now }
  })()
}
