import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { clearDb, getDbIfInitialized, setDb } from './db-connection.js'
import { createDatabaseSchema } from './db-schema.js'
import { createDatabaseMigrationBackup } from './db-migration-backup.js'

/** Configure and migrate a candidate before publishing it as the application's only connection. */
export function initializeDatabase({ userDataPath }) {
  if (getDbIfInitialized()) throw new Error('数据库已经初始化')
  const dbPath = join(userDataPath, 'app.db')
  const isNewDatabase = !existsSync(dbPath)
  const connection = new Database(dbPath)
  try {
    connection.pragma('journal_mode = WAL')
    connection.pragma('synchronous = NORMAL')
    connection.pragma('cache_size = -8000')
    connection.pragma('foreign_keys = ON')
    createDatabaseMigrationBackup(connection, dbPath)
    createDatabaseSchema(connection)
    setDb(connection)
    return { isNewDatabase }
  } catch (error) {
    try {
      connection.close()
    } finally {
      clearDb()
    }
    throw error
  }
}

export function closeDatabase() {
  const connection = getDbIfInitialized()
  if (!connection) return
  connection.close()
  clearDb()
}
