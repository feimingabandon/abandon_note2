import { getDb } from '../db/db-connection.js'
import { moveHistoricalNotesToToday } from '../db/db-historical-note-move.js'
import { addCalendarDays, localDateKey } from '../../shared/calendar/calendar-date-rules.js'

export const AUTOMATIC_NOTE_MOVE_CHECKED_DATE_KEY = 'auto_move_checked_date'

/** 每天只检查昨天；移动和检查日期同一事务，开启开关时可主动再检查。 */
export function runAutomaticNoteMove({ enabled, now = Date.now(), force = false } = {}) {
  if (!enabled) return { count: 0, skipped: true, reason: 'disabled' }
  const timestamp = Number(now)
  if (
    !Number.isFinite(timestamp) ||
    timestamp <= 0 ||
    !Number.isFinite(new Date(timestamp).getTime())
  ) {
    throw new Error('自动移动时间无效')
  }
  const targetDateKey = localDateKey(timestamp)
  const sourceDateKey = addCalendarDays(targetDateKey, -1)
  const db = getDb()
  return db.transaction(() => {
    const checkedDate = db
      .prepare(
        `SELECT value FROM app_settings
       WHERE window_name = 'application' AND type = 'notes' AND key = ?`
      )
      .get(AUTOMATIC_NOTE_MOVE_CHECKED_DATE_KEY)?.value
    // 回拨时不重新移动历史日期；用户重新开启仍可明确补检查。
    if (!force && checkedDate && checkedDate >= targetDateKey) {
      return { count: 0, skipped: true, reason: 'already-checked', sourceDateKey, targetDateKey }
    }
    const result = moveHistoricalNotesToToday(
      {
        scope: 'range',
        startDateKey: sourceDateKey,
        endDateKey: sourceDateKey,
        excludedNoteIds: []
      },
      { now: timestamp, validateTargetDate: false }
    )
    db.prepare(
      `INSERT INTO app_settings (window_name, type, key, value, created_at, updated_at)
       VALUES ('application', 'notes', ?, ?, ?, ?)
       ON CONFLICT(window_name, key) DO UPDATE SET
         type = excluded.type, value = excluded.value, updated_at = excluded.updated_at`
    ).run(AUTOMATIC_NOTE_MOVE_CHECKED_DATE_KEY, targetDateKey, timestamp, timestamp)
    return { ...result, skipped: false, sourceDateKey }
  })()
}
