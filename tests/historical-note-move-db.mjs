import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createNotesSchema } from '../src/main/db/db-schema.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import {
  moveHistoricalInProgressNotesToToday,
  previewHistoricalInProgressMove
} from '../src/main/db/db-notes.js'

function localTs(year, month, day, hour = 9) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

const db = new Database(':memory:')
createNotesSchema(db)
setDb(db)

const insert = db.prepare(`
  INSERT INTO notes (
    content, status, is_deleted, is_pinned, notify_enabled, effective_at,
    duration_days, finished_at, sort_order, created_at, updated_at
  ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?)
`)

function seed({
  content,
  status = 'in_progress',
  deleted = 0,
  notify = 0,
  effectiveAt,
  durationDays = 1,
  finishedAt = localTs(2026, 8, 20),
  createdAt = localTs(2026, 8, 1)
}) {
  return Number(
    insert.run(
      content,
      status,
      deleted,
      notify,
      effectiveAt,
      durationDays,
      finishedAt,
      createdAt,
      createdAt
    ).lastInsertRowid
  )
}

const currentTime = localTs(2026, 9, 4, 10)
const yesterdayId = seed({
  content: '昨天进行中',
  effectiveAt: localTs(2026, 9, 3, 21),
  notify: 1,
  durationDays: 4
})
const threeDayId = seed({ content: '三天内进行中', effectiveAt: localTs(2026, 9, 1, 8) })
const oldId = seed({ content: '更早进行中', effectiveAt: localTs(2026, 8, 1, 8) })
seed({ content: '今天进行中', effectiveAt: localTs(2026, 9, 4, 8) })
seed({ content: '昨天已完成', status: 'completed', effectiveAt: localTs(2026, 9, 3, 8) })
seed({ content: '昨天初始化', status: 'initialized', effectiveAt: localTs(2026, 9, 3, 8) })
seed({ content: '昨天已删除', deleted: 1, effectiveAt: localTs(2026, 9, 3, 8) })

try {
  const yesterdayPreview = previewHistoricalInProgressMove(
    { scope: 'range', startDateKey: '2026-09-03', endDateKey: '2026-09-03' },
    currentTime
  )
  assert.equal(yesterdayPreview.count, 1)
  assert.deepEqual(yesterdayPreview.notes, [
    { id: yesterdayId, content: '昨天进行中', dateKey: '2026-09-03' }
  ])

  const recentPreview = previewHistoricalInProgressMove(
    { scope: 'range', startDateKey: '2026-09-01', endDateKey: '2026-09-03' },
    currentTime
  )
  assert.equal(recentPreview.count, 2)
  assert.deepEqual(
    recentPreview.notes.map(({ content, dateKey }) => ({ content, dateKey })),
    [
      { content: '昨天进行中', dateKey: '2026-09-03' },
      { content: '三天内进行中', dateKey: '2026-09-01' }
    ]
  )

  const allPreview = previewHistoricalInProgressMove({ scope: 'all' }, currentTime)
  assert.equal(allPreview.count, 3)
  assert.deepEqual(
    allPreview.notes.map(({ content, dateKey }) => ({ content, dateKey })),
    [
      { content: '昨天进行中', dateKey: '2026-09-03' },
      { content: '三天内进行中', dateKey: '2026-09-01' },
      { content: '更早进行中', dateKey: '2026-08-01' }
    ]
  )

  const originalYesterday = db.prepare('SELECT * FROM notes WHERE id = ?').get(yesterdayId)
  const movedRecent = moveHistoricalInProgressNotesToToday(
    {
      scope: 'range',
      startDateKey: '2026-09-01',
      endDateKey: '2026-09-03',
      noteIds: [yesterdayId]
    },
    currentTime
  )
  assert.equal(movedRecent.count, 1)
  assert.equal(movedRecent.targetDateKey, '2026-09-04')

  const movedYesterday = db.prepare('SELECT * FROM notes WHERE id = ?').get(yesterdayId)
  assert.equal(movedYesterday.effective_at, currentTime)
  assert.equal(movedYesterday.updated_at, currentTime)
  assert.equal(movedYesterday.notify_enabled, 0)
  assert.equal(movedYesterday.created_at, originalYesterday.created_at)
  assert.equal(movedYesterday.finished_at, originalYesterday.finished_at)
  assert.equal(movedYesterday.duration_days, originalYesterday.duration_days)
  assert.equal(
    db.prepare('SELECT effective_at FROM notes WHERE id = ?').get(threeDayId).effective_at,
    localTs(2026, 9, 1, 8)
  )

  assert.equal(previewHistoricalInProgressMove({ scope: 'all' }, currentTime).count, 2)
  const movedAll = moveHistoricalInProgressNotesToToday(
    { scope: 'all', noteIds: [oldId, yesterdayId] },
    currentTime + 1000
  )
  assert.equal(movedAll.count, 1)
  assert.equal(
    db.prepare('SELECT effective_at FROM notes WHERE id = ?').get(oldId).effective_at,
    currentTime + 1000
  )
  assert.equal(previewHistoricalInProgressMove({ scope: 'all' }, currentTime + 1000).count, 1)

  const movedRemaining = moveHistoricalInProgressNotesToToday({ scope: 'all' }, currentTime + 2000)
  assert.equal(movedRemaining.count, 1, '未传 noteIds 时应保留原有整批移动语义')
  assert.equal(previewHistoricalInProgressMove({ scope: 'all' }, currentTime + 2000).count, 0)

  process.stderr.write('historical note move database integration passed\n')
} finally {
  clearDb()
  db.close()
}
