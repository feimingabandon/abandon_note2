import { getDb } from './db-connection.js'

/** Settings operations share the application's current connection and schema. */
export function getAllSettings(windowName) {
  return getDb()
    .prepare(
      'SELECT type, key, value, remark, created_at, updated_at FROM app_settings WHERE window_name = ?'
    )
    .all(windowName)
}

/** Keep related scope writes on the same connection and commit them together. */
export function runSettingsTransaction(operation) {
  return getDb().transaction(operation)()
}

/** Commit a related group of settings in one synchronous SQLite transaction. */
export function setSettingsBatch(windowName, settings) {
  if (!Array.isArray(settings) || settings.length === 0) return

  const db = getDb()
  const upsert = db.prepare(`
    INSERT INTO app_settings (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(window_name, key) DO UPDATE SET
      value = excluded.value,
      type = excluded.type,
      remark = excluded.remark,
      updated_at = excluded.updated_at
  `)
  const writeAll = db.transaction((rows) => {
    const now = Date.now()
    rows.forEach(({ type, key, value, remark = '' }) => {
      upsert.run(windowName, type, key, value == null ? null : String(value), remark, now, now)
    })
  })
  writeAll(settings)
}

/** Clear settings only; business tables and attachment files are unaffected. */
export function clearAllSettings() {
  return getDb().prepare('DELETE FROM app_settings').run().changes
}

/** Clear one view/scope without affecting application settings or other views. */
export function clearSettings(windowName) {
  return getDb().prepare('DELETE FROM app_settings WHERE window_name = ?').run(windowName).changes
}

/** The user-facing reset spans two scopes on the same connection or commits neither. */
export function resetSettingsGroup({ viewScope, applicationScope, applicationEntries }) {
  return getDb().transaction(() => {
    setSettingsBatch(applicationScope, applicationEntries)
    const clearedViewSettingCount = clearSettings(viewScope)
    return { resetApplicationSettingCount: applicationEntries.length, clearedViewSettingCount }
  })()
}
