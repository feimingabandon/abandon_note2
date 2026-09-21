import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createNote, queryRecentNotes, updateNote } from '../src/main/db/db-notes.js'
import { createDatabaseSchema, DATABASE_SCHEMA_VERSION } from '../src/main/db/db-schema.js'

const db = new Database(':memory:')

try {
  createDatabaseSchema(db)
  db.exec('ALTER TABLE notes DROP COLUMN remark; PRAGMA user_version = 11;')
  createDatabaseSchema(db)
  assert.equal(db.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
  assert.equal(
    db
      .prepare("PRAGMA table_info('notes')")
      .all()
      .some((column) => column.name === 'remark'),
    true
  )

  setDb(db)
  const created = createNote({ content: '带备注的便签' })
  assert.equal(created.remark, '')

  const updated = updateNote(created.id, { remark: '正文下面的备注' })
  assert.equal(updated.remark, '正文下面的备注')
  assert.equal(
    queryRecentNotes({ cutoffTime: 0 }).find((note) => note.id === created.id)?.remark,
    '正文下面的备注'
  )

  updateNote(created.id, { content: '只修改正文' })
  assert.equal(updateNote(created.id, {}).remark, '正文下面的备注')
  console.log('note remark database tests passed')
} finally {
  clearDb()
  db.close()
}
