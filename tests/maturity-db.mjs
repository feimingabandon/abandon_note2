import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { setDb, clearDb } from '../src/main/db/db-connection.js'
import {
  deleteNote,
  restoreNote,
  queryCalendarNotes,
  searchNotes
} from '../src/main/db/db-notes.js'

const db = new Database(':memory:')
setDb(db)
createDatabaseSchema(db)
try {
  const ts = Date.now() - 3600_000
  const insert = db.prepare(
    "INSERT INTO notes(content,status,effective_at,created_at,updated_at,notify_enabled) VALUES (?, 'initialized', ?, ?, ?, 1)"
  )
  const id = Number(insert.run('恢复中文便签', ts, ts, ts).lastInsertRowid)
  db.prepare("INSERT INTO tags(name,color,created_at) VALUES ('测试','#ff0000',?)").run(ts)
  db.prepare('INSERT INTO note_tags(note_id,tag_id) VALUES (?,1)').run(id)
  db.prepare(
    'INSERT INTO note_attachments(note_id,file_path,file_size,created_at) VALUES (?,?,?,?)'
  ).run(id, 'attachments/retained.png', 10, ts)
  assert.equal(deleteNote(id), true)
  const restored = restoreNote(id)
  assert.equal(restored.status, 'in_progress')
  assert.equal(restored.notify_enabled, 0)
  assert.equal(restored.tags[0].name, '测试')
  assert.equal(restored.attachments[0].file_path, 'attachments/retained.png')
  assert.equal(restoreNote(id), null)
  assert.equal(restoreNote(999), null)
  db.prepare("UPDATE notes SET status = 'completed', finished_at = ? WHERE id = ?").run(ts, id)
  deleteNote(id)
  assert.equal(restoreNote(id).status, 'completed')
  db.prepare("UPDATE notes SET status = 'initialized', effective_at = ? WHERE id = ?").run(
    Date.now() + 3600_000,
    id
  )
  deleteNote(id)
  assert.equal(restoreNote(id).status, 'initialized')
  db.prepare('UPDATE notes SET effective_at = ? WHERE id = ?').run(ts, id)
  const counts = [1000, 10000, 33000, 50000]
  let total = 1
  const timings = []
  for (const count of counts) {
    db.transaction(() => {
      while (total < count) {
        insert.run('中文工作计划 检查材料 ' + total, ts, ts, ts)
        total++
      }
    })()
    const start = performance.now()
    const notes = queryCalendarNotes({ candidateFrom: ts - 1, visibleEndExclusive: ts + 1 })
    assert.equal(notes.length, count)
    const calendarMs = performance.now() - start
    const queryStart = performance.now()
    const results = searchNotes({ search: '工作计划', limit: 50, offset: 0 })
    timings.push({
      count,
      calendarMs: Math.round(calendarMs),
      searchMs: Math.round(performance.now() - queryStart),
      resultCount: results.notes.length
    })
    assert.equal(
      queryCalendarNotes({
        candidateFrom: ts - 1,
        visibleEndExclusive: ts + 1,
        filter: (n) => n.id === id
      }).length,
      1
    )
  }
  console.log(JSON.stringify({ restore: 'passed', timings }, null, 2))
} finally {
  clearDb()
  db.close()
}
