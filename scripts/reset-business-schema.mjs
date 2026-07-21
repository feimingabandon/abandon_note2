import Database from 'better-sqlite3'
import { join } from 'node:path'
import { createNotesSchema } from '../src/main/db/db-schema.js'

const dbPath = process.env.ABANDON_DB_PATH || join(process.env.APPDATA, 'abandon_note2', 'app.db')
const db = new Database(dbPath)
const businessTables = [
  'template_tags',
  'note_tags',
  'note_attachments',
  'note_templates',
  'notes',
  'tags'
]

try {
  const existing = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  )
  const nonEmpty = businessTables
    .filter((table) => existing.has(table))
    .map((table) => ({
      table,
      count: db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
    }))
    .filter(({ count }) => count > 0)
  if (nonEmpty.length > 0) {
    throw new Error(`业务表并非空库，拒绝重建：${JSON.stringify(nonEmpty)}`)
  }

  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    for (const table of businessTables) db.exec(`DROP TABLE IF EXISTS ${table}`)
    createNotesSchema(db)
  })()
  db.pragma('foreign_keys = ON')

  const foreignKeyErrors = db.pragma('foreign_key_check')
  if (foreignKeyErrors.length > 0)
    throw new Error(`外键检查失败：${JSON.stringify(foreignKeyErrors)}`)
  const noteColumns = db
    .prepare("PRAGMA table_info('notes')")
    .all()
    .map((column) => column.name)
  if (noteColumns.includes('template_id')) throw new Error('notes.template_id 仍然存在')
  const templateColumns = new Set(
    db
      .prepare("PRAGMA table_info('note_templates')")
      .all()
      .map((column) => column.name)
  )
  for (const column of ['consecutive_failures', 'last_error', 'last_failed_at', 'pause_reason']) {
    if (!templateColumns.has(column)) throw new Error(`note_templates.${column} 不存在`)
  }
  console.log(`business schema reset complete: ${dbPath}`)
} finally {
  db.close()
}
