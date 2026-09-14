import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { buildRecurringNotePreviews } from '../src/main/calendar/recurring-note-preview.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createTag } from '../src/main/db/db-tags.js'
import { createTemplate, pauseTemplate } from '../src/main/db/db-templates.js'

function localTs(year, month, day, hour = 9) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

const db = new Database(':memory:')
setDb(db)

try {
  createDatabaseSchema(db)
  const tag = createTag('循环预览标签', '#34c759')
  const running = createTemplate(
    {
      content: '数据库循环预览',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      tagIds: [tag.id]
    },
    localTs(2026, 9, 14, 8)
  )
  const paused = createTemplate(
    {
      content: '暂停模板不可见',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
    },
    localTs(2026, 9, 14, 8)
  )
  pauseTemplate(paused.id, localTs(2026, 9, 14, 8))

  const result = buildRecurringNotePreviews({
    rangeStart: '2026-09-14',
    rangeEnd: '2026-09-16',
    now: localTs(2026, 9, 14, 8)
  })

  assert.deepEqual(
    result.items.map((item) => [item.template_id, item.effective_at]),
    [
      [running.id, localTs(2026, 9, 14)],
      [running.id, localTs(2026, 9, 15)],
      [running.id, localTs(2026, 9, 16)]
    ]
  )
  assert.deepEqual(
    result.items[0].tags.map((item) => item.id),
    [tag.id]
  )
  assert.equal(
    result.items.some((item) => item.template_id === paused.id),
    false
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0)
  process.stderr.write('[recurring-preview-db] database projection stayed read-only\n')
} finally {
  clearDb()
  db.close()
}
