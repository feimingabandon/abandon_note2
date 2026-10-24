import Database from 'better-sqlite3'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'
import { clearDb, getDbIfInitialized, setDb } from '../src/main/db/db-connection.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { registerBusinessIpcHandlers } from '../src/main/ipc/register-business-ipc.js'
import { closeLogs } from '../src/main/logging/logger.js'
import { NOTE_TAG_LIMIT_MESSAGE } from '../src/shared/tag-rules.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/tag-commands-electron.mjs',
  mode: 'electron-ready-disk-sqlite-tag-commands-mocked-ipc',
  metadata: {
    sqlite: 'real-disk',
    ipc: 'production registrar with in-process authorized-sender fixture',
    mutationAdmission: 'production business-mutation-admission',
    renderer: false,
    browserWindow: false,
    runtimeAppBootstrap: false,
    limits: ['No renderer UI claim', 'No process restart or full-regression claim']
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-tag-commands-' })
app.setPath('userData', profile.directory)

app.whenReady().then(async () => {
  let db = null,
    admission = null,
    completed = false,
    failure = null,
    exitCode = 0
  const cleanupErrors = []
  try {
    db = new Database(join(profile.directory, 'app.db'))
    db.pragma('foreign_keys = ON')
    createDatabaseSchema(db)
    setDb(db)
    admission = createBusinessMutationAdmission()
    const handlers = new Map(),
      broadcasts = []
    let admitted = 0
    const window = {
      isDestroyed: () => false,
      webContents: { id: 41, isDestroyed: () => false, send: (...args) => broadcasts.push(args) }
    }
    registerBusinessIpcHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      getMainWindow: () => window,
      runMutation(operation) {
        admitted++
        return admission.run(operation)
      }
    })
    const invoke = (channel, payload) =>
      handlers.get(channel)({ sender: window.webContents }, payload)
    const ids = (tags) => tags.map((tag) => tag.id)
    const relationRows = () => db.prepare('SELECT * FROM note_tags ORDER BY note_id, tag_id').all()
    const changes = () => broadcasts.map(([channel, payload]) => [channel, payload.reason])
    const resetBroadcasts = () => {
      broadcasts.length = 0
    }

    const first = invoke('tags:create', { name: '  甲标签  ', color: '#ABCDEF' })
    const middle = invoke('tags:create', { name: '中标签' })
    const last = invoke('tags:create', { name: '乙标签', color: '#123456' })
    assert.equal(first.name, '甲标签')
    assert.equal(first.color, '#abcdef')
    assert.deepEqual(ids(invoke('tags:list')), [first.id, middle.id, last.id])
    assert.deepEqual(
      invoke('tags:list').map((tag) => tag.sort_order),
      [65536, 131072, 196608]
    )
    assert.deepEqual(changes(), [
      ['tags:changed', 'create'],
      ['tags:changed', 'create'],
      ['tags:changed', 'create']
    ])
    resetBroadcasts()
    assert.equal(invoke('tags:create', { name: '甲标签' }), null)
    assert.throws(() => invoke('tags:create', { name: '  ' }), /标签名称不能为空/)
    assert.equal(broadcasts.length, 0)

    const note = invoke('notes:create', { content: '标签归属原便签' })
    assert.equal(invoke('note-tags:bind', { noteId: note.id, tagId: first.id }), true)
    const stableRelations = relationRows()
    resetBroadcasts()
    const renamed = invoke('tags:update', {
      id: String(first.id),
      fields: { name: '新甲标签', color: '#654321' }
    })
    assert.equal(renamed.id, first.id)
    assert.equal(renamed.name, '新甲标签')
    assert.deepEqual(relationRows(), stableRelations)
    assert.equal(invoke('note-tags:list', { noteId: note.id })[0].name, '新甲标签')
    assert.deepEqual(changes(), [
      ['tags:changed', 'update'],
      ['notes:changed', 'tag']
    ])
    assert.equal(broadcasts[0][1].oldName, '甲标签')
    assert.equal(broadcasts[0][1].tag.id, first.id)
    assert.equal(broadcasts[1][1].tagId, first.id)
    resetBroadcasts()
    const beforeConflict = invoke('tags:get', { id: first.id })
    assert.throws(
      () =>
        invoke('tags:update', {
          id: first.id,
          fields: { name: middle.name }
        }),
      /标签名称已存在/
    )
    assert.deepEqual(invoke('tags:get', { id: first.id }), beforeConflict)
    assert.equal(broadcasts.length, 0)

    const reordered = invoke('tags:update-order', { tagIds: [String(last.id), String(first.id)] })
    assert.deepEqual(ids(reordered), [last.id, middle.id, first.id])
    assert.equal(reordered.find((tag) => tag.id === middle.id).sort_order, middle.sort_order)
    assert.equal(reordered.find((tag) => tag.id === last.id).sort_order, first.sort_order)
    assert.equal(reordered.find((tag) => tag.id === first.id).sort_order, last.sort_order)
    assert.deepEqual(changes(), [['tags:changed', 'reorder']])
    assert.deepEqual(broadcasts[0][1].tagIds, [last.id, first.id])
    resetBroadcasts()
    assert.throws(() => invoke('tags:update-order', { tagIds: [first.id, first.id] }), /重复/)
    assert.deepEqual(ids(invoke('tags:list')), [last.id, middle.id, first.id])
    assert.equal(broadcasts.length, 0)

    assert.equal(invoke('note-tags:bind', { noteId: note.id, tagId: last.id }), true)
    assert.deepEqual(ids(invoke('note-tags:list', { noteId: note.id })), [last.id])
    resetBroadcasts()
    assert.equal(invoke('note-tags:unbind', { noteId: note.id, tagId: first.id }), false)
    assert.equal(broadcasts.length, 0)
    assert.equal(invoke('note-tags:unbind', { noteId: note.id, tagId: last.id }), true)
    assert.deepEqual(changes(), [['notes:changed', 'tag']])
    assert.deepEqual(invoke('note-tags:list', { noteId: note.id }), [])
    resetBroadcasts()
    assert.deepEqual(
      ids(
        invoke('note-tags:set', {
          noteId: String(note.id),
          tagIds: [String(first.id)]
        })
      ),
      [first.id]
    )
    assert.deepEqual(changes(), [['notes:changed', 'tag']])
    assert.equal(broadcasts[0][1].id, String(note.id))
    resetBroadcasts()
    const assignedBeforeInvalidSet = relationRows()
    assert.throws(
      () =>
        invoke('note-tags:set', {
          noteId: note.id,
          tagIds: [first.id, last.id]
        }),
      (error) => error.message === NOTE_TAG_LIMIT_MESSAGE
    )
    assert.deepEqual(relationRows(), assignedBeforeInvalidSet)
    assert.throws(
      () =>
        invoke('note-tags:bind', {
          noteId: note.id,
          tagId: 999999
        }),
      (error) => error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
    )
    assert.deepEqual(relationRows(), assignedBeforeInvalidSet)
    assert.equal(broadcasts.length, 0)

    const deletedNote = invoke('notes:create', { content: '保留关联的删除便签' })
    invoke('note-tags:bind', { noteId: deletedNote.id, tagId: first.id })
    invoke('notes:delete', { id: deletedNote.id })
    const template = invoke('templates:create', {
      content: '稳定标签模板',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      tagIds: [first.id]
    })
    assert.deepEqual(invoke('tags:usage', { id: first.id }), {
      noteCount: 2,
      activeNoteCount: 1,
      deletedNoteCount: 1,
      templateCount: 1,
      runningTemplateCount: 1,
      pausedTemplateCount: 0,
      deletedTemplateCount: 0
    })
    resetBroadcasts()
    assert.equal(invoke('tags:delete', { id: String(first.id) }), true)
    assert.deepEqual(changes(), [
      ['tags:changed', 'delete'],
      ['notes:changed', 'tag']
    ])
    assert.equal(broadcasts[0][1].id, first.id)
    assert.equal(broadcasts[1][1].tagId, first.id)
    assert.deepEqual(relationRows(), [])
    assert.deepEqual(
      db.prepare('SELECT * FROM template_tags WHERE template_id = ?').all(template.id),
      []
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_templates').get().count, 1)
    resetBroadcasts()
    assert.equal(invoke('tags:delete', { id: first.id }), false)
    assert.equal(broadcasts.length, 0)

    const admittedBeforeForeign = admitted
    for (const channel of [
      'tags:create',
      'tags:update',
      'tags:delete',
      'tags:update-order',
      'note-tags:bind',
      'note-tags:unbind',
      'note-tags:set',
      'tags:list',
      'note-tags:list'
    ]) {
      assert.throws(() => handlers.get(channel)({ sender: {} }, {}), /无权访问/)
    }
    assert.equal(
      admitted,
      admittedBeforeForeign,
      'sender authorization must precede mutation admission'
    )
    assert.equal(broadcasts.length, 0)
    const remaining = invoke('tags:list')
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const maintenance = admission.exclusive(() => gate)
    try {
      assert.throws(() => invoke('tags:create', { name: '维护期间禁止写入' }), /正在维护/)
      assert.deepEqual(
        invoke('tags:list'),
        remaining,
        'read transport remains authorized during maintenance'
      )
      assert.equal(broadcasts.length, 0)
    } finally {
      release()
      await maintenance
    }
    assert.equal(invoke('tags:create', { name: '维护后标签' }).name, '维护后标签')
    resetBroadcasts()
    admission.preventNewMutations()
    await admission.drain()
    const sealedTags = invoke('tags:list')
    assert.throws(() => invoke('tags:create', { name: '退出后禁止写入' }), /正在退出/)
    assert.deepEqual(invoke('tags:list'), sealedTags)
    assert.deepEqual(admission.snapshot(), { clearing: false, pending: 0 })
    assert.equal(broadcasts.length, 0)
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    try {
      admission?.preventNewMutations()
      await admission?.drain()
      clearDb()
      if (db?.open) db.close()
      if (db) assert.equal(db.open, false, 'the real SQLite owner must close before process exit')
      assert.equal(getDbIfInitialized(), null, 'no shared DB reference survives cleanup')
    } catch (error) {
      cleanupErrors.push(error.stack || error.message)
      exitCode = 1
    }
    try {
      const logging = await closeLogs()
      assert.equal(logging.outcome, 'completed', 'the logging cleanup result must remain complete')
      assert.equal(
        logging.writer.termination.confirmed,
        true,
        'the actual logging worker must exit'
      )
    } catch (error) {
      cleanupErrors.push(error.stack || error.message)
      exitCode = 1
    }
    if (profile.ownership === 'script' && exitCode === 0) {
      try {
        await rm(profile.directory, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error.stack || error.message)
        exitCode = 1
      }
    }
    try {
      recorder.finish({
        completed,
        error: failure,
        evidence: { status: 'complete' },
        profileOwnership: profile.ownership,
        cleanup: {
          status: cleanupErrors.length ? 'failed' : exitCode ? 'preserved' : 'complete',
          ...(cleanupErrors.length ? { error: cleanupErrors.join('\n') } : {}),
          ...(exitCode ? { preservedProfile: profile.directory } : {})
        }
      })
    } catch (error) {
      console.error(error)
      exitCode = 1
    }
    app.exit(exitCode)
  }
})
