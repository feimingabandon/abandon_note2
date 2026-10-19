import { getDb } from './db-connection.js'

const KEY = 'daily-remote-v3'

export function getRemoteDailyState() {
  const row = getDb().prepare('SELECT value FROM remote_daily_state WHERE key = ?').get(KEY)
  return row ? JSON.parse(row.value) : {}
}

export function saveRemoteDailyState(state) {
  getDb()
    .prepare(
      'INSERT INTO remote_daily_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(KEY, JSON.stringify(state))
}
