import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import {
  createNote,
  queryRecentNotes,
  updateNote,
  updateNoteTextColor
} from '../src/main/db/db-notes.js'
import { createDatabaseSchema, DATABASE_SCHEMA_VERSION } from '../src/main/db/db-schema.js'

const db = new Database(':memory:')

try {
  createDatabaseSchema(db)
  db.exec('ALTER TABLE notes DROP COLUMN content_color_ranges; PRAGMA user_version = 13;')
  createDatabaseSchema(db)
  assert.equal(db.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
  assert.equal(
    db
      .prepare("PRAGMA table_info('notes')")
      .all()
      .some((column) => column.name === 'content_color_ranges'),
    true
  )

  setDb(db)
  const created = createNote({ content: '今天完成报告' })
  assert.deepEqual(created.content_color_ranges, [])

  const createdWithColors = createNote({
    content: '新建彩色便签',
    contentColorRanges: [{ start: 2, end: 4, text: '彩色', color: '#34c759' }]
  })
  assert.deepEqual(createdWithColors.content_color_ranges, [
    { start: 2, end: 4, text: '彩色', color: '#34c759' }
  ])

  const first = updateNoteTextColor(created.id, {
    start: 2,
    end: 4,
    color: '#ff3b30',
    expectedContent: created.content,
    expectedColorRanges: created.content_color_ranges
  })
  const second = updateNoteTextColor(created.id, {
    start: 4,
    end: 6,
    color: '#007aff',
    expectedContent: first.content,
    expectedColorRanges: first.content_color_ranges
  })
  assert.deepEqual(second.content_color_ranges, [
    { start: 2, end: 4, text: '完成', color: '#ff3b30' },
    { start: 4, end: 6, text: '报告', color: '#007aff' }
  ])
  assert.deepEqual(
    queryRecentNotes({ cutoffTime: 0 }).find((note) => note.id === created.id)
      ?.content_color_ranges,
    second.content_color_ranges
  )

  const shifted = updateNote(created.id, { content: '请在今天完成报告' })
  assert.deepEqual(shifted.content_color_ranges, [
    { start: 4, end: 6, text: '完成', color: '#ff3b30' },
    { start: 6, end: 8, text: '报告', color: '#007aff' }
  ])
  const changed = updateNote(created.id, { content: '请在今天完成周报' })
  assert.deepEqual(changed.content_color_ranges, [
    { start: 4, end: 6, text: '完成', color: '#ff3b30' }
  ])

  const cleared = updateNoteTextColor(created.id, {
    start: 0,
    end: changed.content.length,
    color: null,
    expectedContent: changed.content,
    expectedColorRanges: changed.content_color_ranges
  })
  assert.deepEqual(cleared.content_color_ranges, [])
  console.log('note text color database tests passed')
} finally {
  clearDb()
  db.close()
}
