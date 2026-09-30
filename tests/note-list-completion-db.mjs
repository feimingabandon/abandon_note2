import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import {
  completeNote,
  createNote,
  queryCustomNormal,
  queryCustomPinned,
  queryEarlierNotes,
  queryPinnedNotes,
  queryRecentNotes,
  queryTagGroupNotes,
  reopenNote
} from '../src/main/db/db-notes.js'
import { createTag, setNoteTagIds } from '../src/main/db/db-tags.js'

const db = new Database(':memory:')
const ids = (notes) => notes.map((note) => note.id)
const localTime = (day, hour = 0, minute = 0) => new Date(2025, 8, day, hour, minute).getTime()
const realNow = Date.now
let tick = realNow()
Date.now = () => ++tick

try {
  createDatabaseSchema(db)
  setDb(db)
  const tag = createTag('完成排序')
  function seed(content, day, hour, { completed = false, pinned = false, tagged = true } = {}) {
    const note = createNote({
      content,
      effectiveAt: localTime(day, hour),
      isPinned: pinned ? 1 : 0,
      sortOrder: -db.prepare('SELECT COUNT(*) AS total FROM notes').get().total
    })
    if (tagged) setNoteTagIds(note.id, [tag.id])
    if (completed) {
      completeNote(note.id)
      db.prepare('UPDATE notes SET finished_at = ? WHERE id = ?').run(localTime(day, 23), note.id)
    }
    return note.id
  }

  const done = seed('当天较早完成', 30, 22, { completed: true })
  const morning = seed('同一本地日期凌晨', 30, 1)
  const afternoon = seed('当天下午', 30, 15)
  const yesterdayDone = seed('昨天已完成', 29, 23, { completed: true })
  const yesterday = seed('昨天未完成', 29, 1)
  const pinned = seed('当天置顶', 30, 10, { pinned: true })
  const oldPinned = seed('更早置顶', 24, 10, { pinned: true })
  const cutoffTime = localTime(28) - 1
  const recent = () => ids(queryRecentNotes({ cutoffTime }))

  assert.deepEqual(recent(), [afternoon, morning, done, yesterday, yesterdayDone])
  const customPinnedBefore = ids(queryCustomPinned())
  const customBefore = ids(queryCustomNormal({ limit: 100 }).notes)
  completeNote(afternoon)
  assert.deepEqual(recent(), [morning, done, afternoon, yesterday, yesterdayDone])
  completeNote(yesterday)
  assert.deepEqual(recent(), [morning, done, afternoon, yesterdayDone, yesterday])
  completeNote(pinned)
  assert.equal(
    queryPinnedNotes().some((note) => note.id === pinned),
    false
  )
  assert.deepEqual(recent(), [morning, done, afternoon, pinned, yesterdayDone, yesterday])
  assert.deepEqual(ids(queryCustomPinned()), customPinnedBefore, '自定义置顶不受影响')
  assert.deepEqual(ids(queryCustomNormal({ limit: 100 }).notes), customBefore, '自定义顺序不变')
  reopenNote(pinned)
  assert.equal(
    queryPinnedNotes().some((note) => note.id === pinned),
    true
  )
  assert.equal(recent().includes(pinned), false)
  reopenNote(afternoon)
  assert.deepEqual(recent(), [afternoon, morning, done, yesterdayDone, yesterday])
  assert.deepEqual(ids(queryRecentNotes({ cutoffTime, statuses: ['completed'] })), [
    done,
    yesterdayDone,
    yesterday
  ])

  const oldDone = seed('更早的已完成', 25, 23, { completed: true })
  const oldActive = Array.from({ length: 32 }, (_, index) =>
    seed(`更早进行中${index}`, 25, index % 20)
  )
  const oldest = seed('再早一天', 24, 1)
  completeNote(oldPinned)
  const allEarlier = queryEarlierNotes({ cutoffTime, limit: 100 })
  const pages = [
    queryEarlierNotes({ cutoffTime, limit: 10, offset: 0 }),
    queryEarlierNotes({ cutoffTime, limit: 20, offset: 10 }),
    queryEarlierNotes({ cutoffTime, limit: 20, offset: 30 })
  ]
  assert.deepEqual(
    pages.map((page) => page.notes.length),
    [10, 20, 5]
  )
  assert.deepEqual(ids(pages.flatMap((page) => page.notes)), ids(allEarlier.notes))
  assert.equal(new Set(ids(allEarlier.notes)).size, allEarlier.total)
  assert.deepEqual(ids(allEarlier.notes).slice(-3), [oldDone, oldest, oldPinned])
  completeNote(oldActive[0])
  const updatedEarlier = queryEarlierNotes({ cutoffTime, limit: 100 })
  assert.deepEqual(ids(updatedEarlier.notes).slice(-4), [oldDone, oldActive[0], oldest, oldPinned])

  const allTagged = queryTagGroupNotes({ tagId: tag.id, limit: 100 })
  const taggedPages = [0, 10, 30].flatMap(
    (offset) => queryTagGroupNotes({ tagId: tag.id, limit: offset === 0 ? 10 : 20, offset }).notes
  )
  assert.deepEqual(ids(taggedPages), ids(allTagged.notes))
  const firstCompleted = allTagged.notes.findIndex((note) => note.status === 'completed')
  assert.ok(firstCompleted > 10, '超过首屏的未完成项也应先于已完成项')
  assert.ok(allTagged.notes.slice(firstCompleted).every((note) => note.status === 'completed'))
  completeNote(morning)
  assert.equal(queryTagGroupNotes({ tagId: tag.id, limit: 100 }).notes.at(-1).id, morning)
  reopenNote(morning)
  assert.ok(
    queryTagGroupNotes({ tagId: tag.id, limit: 10 }).notes.some((note) => note.id === morning)
  )

  const untaggedDone = seed('未分类完成', 30, 23, { completed: true, tagged: false })
  const untaggedActive = seed('未分类进行中', 20, 1, { tagged: false })
  assert.deepEqual(ids(queryTagGroupNotes({ tagId: null }).notes), [untaggedActive, untaggedDone])
  assert.ok(
    queryTagGroupNotes({ tagId: tag.id, statuses: ['in_progress'], limit: 100 }).notes.every(
      (note) => note.status === 'in_progress'
    )
  )
  console.log(
    'PASS completion ordering: local dates, pins/reopen, custom isolation, tag/untagged groups, filters and paginated boundaries'
  )
} finally {
  Date.now = realNow
  clearDb()
  db.close()
}
