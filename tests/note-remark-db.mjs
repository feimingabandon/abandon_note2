import Database from 'better-sqlite3'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createNote, getNoteById, queryRecentNotes, updateNote } from '../src/main/db/db-notes.js'
import { createDatabaseSchema, DATABASE_SCHEMA_VERSION } from '../src/main/db/db-schema.js'
import { createNoteWithAssets, saveNoteDraft } from '../src/main/notes/note-commands.js'

import { app } from 'electron'
import { rm } from 'node:fs/promises'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/note-remark-db.mjs',
  mode: 'electron-ready-memory-sqlite-remark-migration',
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
    profile = prepareTestProfile({ prefix: 'abandon-note-remark-db-' })
    app.setPath('userData', profile.directory)
    const db = openDatabase(':memory:')

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

      const creationRemark = '创建时填写的备注\n保留第二行'
      const withRemark = createNote({ content: '新建正文', remark: creationRemark })
      assert.equal(withRemark.remark, creationRemark)
      assert.equal(getNoteById(withRemark.id).remark, creationRemark)
      assert.equal(
        db.prepare('SELECT remark FROM notes WHERE id = ?').get(withRemark.id).remark,
        creationRemark
      )
      assert.equal(createNote({ content: '备注显式为空', remark: null }).remark, '')

      const withAssets = await createNoteWithAssets({
        options: { content: '统一新建入口', remark: creationRemark },
        images: [],
        tagIds: []
      })
      assert.equal(withAssets.remark, creationRemark)

      const saveRemarkDraft = (note, fields) =>
        saveNoteDraft({
          id: note.id,
          expectedVersion: note.editVersion,
          fields: { content: note.content, isPinned: false, ...fields },
          tagIds: []
        })
      const changedRemark = await saveRemarkDraft(withAssets, { remark: '完整编辑器修改备注' })
      assert.equal(changedRemark.remark, '完整编辑器修改备注')
      assert.equal(
        db.prepare('SELECT remark FROM notes WHERE id = ?').get(withAssets.id).remark,
        '完整编辑器修改备注'
      )
      const preservedRemark = await saveRemarkDraft(changedRemark, { content: '只修改正文和时间' })
      assert.equal(preservedRemark.remark, '完整编辑器修改备注')
      const clearedRemark = await saveRemarkDraft(preservedRemark, { remark: '' })
      assert.equal(clearedRemark.remark, '')
      const restoredRemark = await saveRemarkDraft(clearedRemark, { remark: creationRemark })
      const nullRemark = await saveRemarkDraft(restoredRemark, { remark: null })
      assert.equal(nullRemark.remark, '')

      updateNote(nullRemark.id, { remark: '其他窗口刚修改的备注' })
      await assert.rejects(
        saveRemarkDraft(nullRemark, { remark: '过期草稿中的备注' }),
        /便签已发生变化/
      )
      assert.equal(getNoteById(nullRemark.id).remark, '其他窗口刚修改的备注')
      console.log('note remark database tests passed')
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
