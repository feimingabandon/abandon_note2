import Database from 'better-sqlite3'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import {
  createNote,
  queryRecentNotes,
  updateNote,
  updateNoteTextColor
} from '../src/main/db/db-notes.js'
import { createDatabaseSchema, DATABASE_SCHEMA_VERSION } from '../src/main/db/db-schema.js'

import { app } from 'electron'
import { rm } from 'node:fs/promises'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/note-text-color-db.mjs',
  mode: 'electron-ready-memory-sqlite-text-color-migration',
  metadata: {
    memoryDatabase: true,
    diskDatabase: false,
    reconstructedLegacySchema: true,
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
    profile = prepareTestProfile({ prefix: 'abandon-note-text-color-db-' })
    app.setPath('userData', profile.directory)
    const db = openDatabase(':memory:')

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
