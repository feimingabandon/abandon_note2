import { randomUUID } from 'crypto'
import { getDb } from './db-connection.js'

const INSTALLATION_ID_KEY = 'installation_id'
const REMOTE_SERVICE_RETIRED_KEY = 'remote_service_retired'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * 返回当前安装实例的匿名随机标识。
 * 标识只用于统计独立安装量，不读取 MAC、磁盘序列号或其他硬件指纹。
 */
export function getOrCreateInstallationId() {
  const db = getDb()
  const existing = db
    .prepare('SELECT value FROM app_identity WHERE key = ?')
    .get(INSTALLATION_ID_KEY)
  if (UUID_PATTERN.test(existing?.value || '')) return existing.value.toLowerCase()

  const installationId = randomUUID()
  db.prepare(
    `INSERT INTO app_identity (key, value, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`
  ).run(INSTALLATION_ID_KEY, installationId, Date.now())
  return installationId
}

export function isRemoteServiceRetired() {
  return (
    getDb().prepare('SELECT value FROM app_identity WHERE key = ?').get(REMOTE_SERVICE_RETIRED_KEY)
      ?.value === 'true'
  )
}

export function markRemoteServiceRetired() {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO app_identity (key, value, created_at)
       VALUES (?, 'true', ?)
       ON CONFLICT(key) DO UPDATE SET value = 'true'`
    )
    .run(REMOTE_SERVICE_RETIRED_KEY, now)
}
