import Database from 'better-sqlite3'
import { buildRecurringNotePreviews } from '../src/main/calendar/recurring-note-preview.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createTag } from '../src/main/db/db-tags.js'
import {
  createTemplate,
  deleteTemplate,
  getTemplateById,
  pauseTemplate
} from '../src/main/db/db-templates.js'
import { runRecurringTemplates } from '../src/main/services/recurrence.js'

function localTs(year, month, day, hour = 9) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

import { app } from 'electron'
import { rm } from 'node:fs/promises'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/recurring-preview-db.mjs',
  mode: 'electron-ready-memory-sqlite-recurring-preview',
  metadata: {
    memoryDatabase: true,
    diskDatabase: false,
    fixedLocalDates: true,
    mainProcessRestart: false,
    browserWindow: false,
    runtimeAppBootstrap: false
  }
})
const { assert } = recorder

app.once('ready', async () => {
  let profile
  let completed = false
  let failure
  let exitCode = 0
  const cleanupErrors = []
  const connections = new Set()
  const originalConsoleError = console.error
  const openDatabase = (...args) => {
    const connection = new Database(...args)
    connections.add(connection)
    return connection
  }
  try {
    profile = prepareTestProfile({ prefix: 'abandon-recurring-preview-db-' })
    app.setPath('userData', profile.directory)
    const db = openDatabase(':memory:')
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
      const deleted = createTemplate(
        {
          content: '已删除模板不可见',
          recurrenceRule: { frequency: 'daily', time_of_day: '09:00' }
        },
        localTs(2026, 9, 14, 8)
      )
      deleteTemplate(deleted.id, localTs(2026, 9, 14, 8))
      const databaseBeforePreview = db.serialize()

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
      assert.equal(
        result.items.some((item) => item.template_id === deleted.id),
        false
      )
      assert.equal(
        result.items.every((item) => item.read_only === true),
        true
      )
      assert.equal(
        result.items.every(
          (item) => typeof item.id === 'string' && item.id.startsWith('recurrence-preview:')
        ),
        true
      )
      assert.equal(new Set(result.items.map((item) => item.id)).size, result.items.length)
      assert.deepEqual(db.serialize(), databaseBeforePreview)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0)

      // Repeated calendar projections are identical and cannot advance a template cursor.
      assert.deepEqual(
        buildRecurringNotePreviews({
          rangeStart: '2026-09-14',
          rangeEnd: '2026-09-16',
          now: localTs(2026, 9, 14, 8)
        }),
        result
      )
      assert.deepEqual(db.serialize(), databaseBeforePreview)

      // Once a node is materialized it disappears from future previews without duplicate notes.
      assert.equal(runRecurringTemplates({ now: localTs(2026, 9, 14, 9) }).count, 1)
      const generatedTemplate = getTemplateById(running.id)
      assert.equal(generatedTemplate.last_generated_at, localTs(2026, 9, 14, 9))
      assert.equal(generatedTemplate.next_run_at, localTs(2026, 9, 15, 9))
      const databaseAfterGeneration = db.serialize()
      const afterGeneration = buildRecurringNotePreviews({
        rangeStart: '2026-09-14',
        rangeEnd: '2026-09-16',
        now: localTs(2026, 9, 14, 9)
      })
      assert.deepEqual(
        afterGeneration.items.map((item) => item.effective_at),
        [localTs(2026, 9, 15, 9), localTs(2026, 9, 16, 9)]
      )
      assert.equal(
        afterGeneration.items.some(
          (item) => item.effective_at === generatedTemplate.last_generated_at
        ),
        false
      )
      assert.deepEqual(db.serialize(), databaseAfterGeneration)
      assert.equal(runRecurringTemplates({ now: localTs(2026, 9, 14, 9) }).count, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 1)
      process.stderr.write('[recurring-preview-db] database projection stayed read-only\n')
    } finally {
      clearDb()
      db.close()
    }
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    originalConsoleError(error)
  } finally {
    console.error = originalConsoleError
    clearDb()
    for (const connection of connections) {
      try {
        if (connection.open) connection.close()
      } catch (error) {
        cleanupErrors.push(error.message)
        exitCode = 1
      }
    }
    if (profile?.ownership === 'script' && !exitCode) {
      try {
        await rm(profile.directory, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error.message)
        exitCode = 1
      }
    }
    try {
      recorder.finish({
        completed,
        error: failure,
        evidence: { status: 'complete' },
        profileOwnership: profile?.ownership,
        cleanup: {
          status: cleanupErrors.length ? 'failed' : exitCode ? 'preserved' : 'complete',
          ...(cleanupErrors.length ? { error: cleanupErrors.join('\n') } : {}),
          ...(exitCode && profile ? { preservedProfile: profile.directory } : {})
        }
      })
    } catch (error) {
      originalConsoleError(error)
      exitCode = 1
    }
    app.exit(exitCode)
  }
})
