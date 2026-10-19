import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { initDatabase, closeDatabase, clearNoteData, getDb } from '../src/main/db/db.js'
import { createRecurringNoteSnapshot, getNoteById } from '../src/main/db/db-notes.js'
import * as reminderStore from '../src/main/db/db-reminders.js'
import { ReminderService } from '../src/main/services/ReminderService.js'
import { registerBusinessIpcHandlers } from '../src/main/ipc/register-business-ipc.js'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'
import { getAllSettings, setSettingsBatch } from '../src/main/db/db-settings-repository.js'
import { flushLogs } from '../src/main/logging/logger.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/business-clear-admission-electron.mjs',
  mode: 'electron-ready-disk-sqlite-real-files-business-clear-admission-mocked-ipc',
  metadata: {
    sqlite: 'real-disk',
    files: 'actual-attachment-staging',
    ipc: 'in-process-authorized-sender-fixture',
    reminders: 'production ReminderService and real db-reminders store',
    nativeNotificationTransport: 'controlled accepted and failed callbacks, no OS toast',
    sqlObservation: 'actual database prepare calls at sealed callback boundaries',
    renderer: false,
    browserWindow: false
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-business-admission-' })
app.setPath('userData', profile.directory)
const image = {
  base64: Buffer.from('actual isolated attachment bytes').toString('base64'),
  ext: 'png'
}

app.whenReady().then(async () => {
  let completed = false,
    failure = null,
    exitCode = 0,
    reminders = null,
    restorePrepare = null
  const cleanupErrors = []
  try {
    initDatabase({ userDataPath: profile.directory })
    const owner = createBusinessMutationAdmission()
    const handlers = new Map(),
      broadcasts = []
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (...args) => broadcasts.push(args) }
    }
    registerBusinessIpcHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      getMainWindow: () => window,
      runMutation: owner.run
    })
    const invoke = (channel, payload) =>
      handlers.get(channel)({ sender: window.webContents }, payload)
    const count = () => getDb().prepare('SELECT count(*) AS n FROM notes').get().n
    const create = () =>
      invoke('notes:create-with-assets', {
        options: { content: 'old form' },
        images: [image],
        tagIds: []
      })
    setSettingsBatch('application', [{ type: 'weather', key: 'enabled', value: true }])

    const pendingCreate = create()
    assert.equal(owner.snapshot().pending, 1)
    assert.equal(count(), 0)
    let clearStarted = false
    const clearing = owner.clear(async () => {
      clearStarted = true
      assert.equal(count(), 1)
      const note = getDb().prepare('SELECT id FROM notes').get()
      const assets = getNoteById(note.id).attachments
      assert.equal(assets.length, 1)
      assert.equal(existsSync(join(profile.directory, assets[0].file_path)), true)
      await clearNoteData()
    })
    assert.equal(clearStarted, false)
    assert.throws(() => invoke('notes:create', { content: 'late form' }), /正在清空/)
    assert.throws(() => invoke('tags:create', { name: 'late tag' }), /正在清空/)
    assert.throws(
      () => handlers.get('notes:create')({ sender: {} }, { content: 'foreign' }),
      /无权访问/
    )
    assert.equal(invoke('notes:count-active'), 0)
    await pendingCreate
    await clearing
    assert.equal(count(), 0)
    assert.equal(existsSync(join(profile.directory, 'attachments')), false)
    assert.equal(owner.snapshot().pending, 0)
    assert.equal(getAllSettings('application')[0].value, 'true')
    assert.equal(
      broadcasts.some(
        ([channel, payload]) => channel === 'notes:changed' && payload.reason === 'create'
      ),
      true
    )

    const draftNote = await create()
    const saving = invoke('notes:save-draft', {
      id: draftNote.id,
      expectedVersion: draftNote.editVersion,
      fields: { content: 'saved before clear', status: draftNote.status },
      tagIds: [],
      addedImages: [image],
      deletedImageIds: []
    })
    const draftClear = owner.clear(async () => {
      assert.equal(getNoteById(draftNote.id).content, 'saved before clear')
      assert.equal(getNoteById(draftNote.id).attachments.length, 2)
      await clearNoteData()
    })
    await saving
    await draftClear
    assert.equal(count(), 0)

    const batchNote = await invoke('notes:create', { content: 'batch target' })
    const batch = invoke('images:save-batch', { noteId: batchNote.id, images: [image] })
    const batchClear = owner.clear(async () => {
      assert.equal(getNoteById(batchNote.id).attachments.length, 1)
      await clearNoteData()
    })
    await batch
    await batchClear
    assert.equal(count(), 0)

    getDb().exec(
      "CREATE TRIGGER fail_attachment_insert BEFORE INSERT ON note_attachments BEGIN SELECT RAISE(ABORT, 'admission SQL failure'); END"
    )
    const failedCreate = create()
    const caught = failedCreate.catch((error) => error)
    const failedCreateClear = owner.clear(async () => {
      assert.equal(count(), 0)
      assert.equal(getDb().prepare('SELECT count(*) AS n FROM note_attachments').get().n, 0)
      await clearNoteData()
    })
    assert.match((await caught).message, /admission SQL failure/)
    await failedCreateClear
    getDb().exec('DROP TRIGGER fail_attachment_insert')

    const retained = await create()
    const retainedPath = join(profile.directory, retained.attachments[0].file_path)
    getDb().exec(
      "CREATE TRIGGER fail_note_clear BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT, 'clear SQL failure'); END"
    )
    await assert.rejects(owner.clear(clearNoteData), /clear SQL failure/)
    assert.equal(owner.snapshot().clearing, false)
    assert.equal(getNoteById(retained.id).content, 'old form')
    assert.equal(existsSync(retainedPath), true)
    assert.equal((await invoke('tags:create', { name: '失败后可写' })).name, '失败后可写')
    getDb().exec('DROP TRIGGER fail_note_clear')
    await owner.clear(clearNoteData)
    assert.equal(count(), 0)
    assert.equal(
      readdirSync(profile.directory).some((name) =>
        name.startsWith('.attachments-deleting-reset-')
      ),
      false
    )

    // The native transport is controlled; the service, joined reminder rows,
    // attempts/backoff, delivery updates and clear rollback use real disk SQLite.
    const db = getDb()
    const preparedSql = []
    const originalPrepare = db.prepare
    db.prepare = function (source) {
      preparedSql.push(String(source))
      return originalPrepare.call(this, source)
    }
    restorePrepare = () => {
      db.prepare = originalPrepare
    }
    const deliveries = []
    const transport = {
      sendReminder(round, failed) {
        deliveries.push({ id: round.id, failed })
        return true
      },
      reconcileReminders() {},
      dispose() {}
    }
    reminders = new ReminderService({
      notifications: transport,
      popup: { sync() {}, dispose() {} },
      tray: { sync() {}, dispose() {} },
      runMutation: owner.run,
      canRunMutations: owner.canAdmit,
      reportError() {}
    })
    const deliveryTime = Date.now()
    const reminderNote = owner.run(() =>
      createRecurringNoteSnapshot({
        content: '真实提醒失败与清空回滚',
        effectiveAt: deliveryTime - 1,
        reminderChannels: 1
      })
    )
    const firstRound = owner.run(() =>
      reminderStore.enqueueReminder(reminderNote.id, deliveryTime - 1, deliveryTime)
    )
    reminders.tick(deliveryTime)
    const acceptedRound = reminderStore.getReminder(firstRound.id)
    assert.equal(acceptedRound.state, 'active')
    assert.equal(acceptedRound.note_status, 'in_progress')
    assert.equal(acceptedRound.attempts, 1)
    assert.equal(acceptedRound.delivered_channels, 1)
    assert.equal(deliveries.length, 1)

    db.exec(
      "CREATE TRIGGER fail_reminder_clear BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT, 'reminder clear SQL failure'); END"
    )
    const reminderClearFailure = owner.clear(clearNoteData)
    assert.equal(owner.snapshot().clearing, true)
    const sqlBeforeSealedCallback = preparedSql.length
    deliveries[0].failed(new Error('native transport failed while clear was sealed'))
    reminders.tick(deliveryTime + 60000)
    assert.equal(preparedSql.length, sqlBeforeSealedCallback)
    assert.equal(deliveries.length, 1)
    await assert.rejects(reminderClearFailure, /reminder clear SQL failure/)
    assert.equal(owner.canAdmit(), true)
    assert.deepEqual(reminderStore.getReminder(firstRound.id), acceptedRound)
    db.exec('DROP TRIGGER fail_reminder_clear')
    reminders.tick(deliveryTime + 60000)
    const retriedRound = reminderStore.getReminder(firstRound.id)
    assert.equal(deliveries.length, 2)
    assert.equal(retriedRound.attempts, 2)
    assert.equal(retriedRound.delivered_channels, 1)
    assert.equal(retriedRound.next_attempt_at, deliveryTime + 120000)

    const oldFailure = deliveries[1].failed
    await owner.clear(async () => {
      await clearNoteData()
      reminders.refresh()
    })
    assert.equal(reminderStore.getReminder(firstRound.id), null)
    assert.equal(count(), 0)
    const newNote = owner.run(() =>
      createRecurringNoteSnapshot({
        content: '清空后的新轮次',
        effectiveAt: deliveryTime - 1,
        reminderChannels: 1
      })
    )
    // Deliberately reuse every durable identity field after the successful clear.
    // These valid fixture rows exercise token isolation beyond random UUID uniqueness.
    owner.run(() => {
      db.prepare('UPDATE notes SET id = ? WHERE id = ?').run(reminderNote.id, newNote.id)
    })
    const freshRound = owner.run(() =>
      reminderStore.enqueueReminder(reminderNote.id, firstRound.due_at, firstRound.created_at)
    )
    owner.run(() => {
      db.prepare('UPDATE note_reminders SET id = ?, attempts = ? WHERE id = ?').run(
        firstRound.id,
        retriedRound.attempts - 1,
        freshRound.id
      )
    })
    reminders.tick(deliveryTime + 120000)
    const newAcceptedRound = reminderStore.getReminder(firstRound.id)
    assert.deepEqual(
      ['id', 'note_id', 'parent_id', 'due_at', 'created_at', 'attempts'].map(
        (field) => newAcceptedRound[field]
      ),
      ['id', 'note_id', 'parent_id', 'due_at', 'created_at', 'attempts'].map(
        (field) => retriedRound[field]
      )
    )
    assert.equal(deliveries.length, 3)
    assert.equal(newAcceptedRound.content, '清空后的新轮次')
    assert.equal(newAcceptedRound.delivered_channels, 1)
    const sqlBeforeOldCallback = preparedSql.length
    oldFailure(new Error('old delivery must not alter the new round'))
    assert.equal(preparedSql.length, sqlBeforeOldCallback)
    assert.deepEqual(reminderStore.getReminder(firstRound.id), newAcceptedRound)
    assert.equal(deliveries.length, 3)

    owner.preventNewMutations()
    const sqlBeforeShutdownCallback = preparedSql.length
    deliveries[2].failed(new Error('late failure after shutdown admission'))
    reminders.tick(deliveryTime + 180000)
    await owner.drain()
    assert.equal(preparedSql.length, sqlBeforeShutdownCallback)
    assert.deepEqual(reminderStore.getReminder(firstRound.id), newAcceptedRound)
    reminders.dispose()
    const sqlAfterDispose = preparedSql.length
    deliveries[2].failed(new Error('late failure after service disposal'))
    assert.equal(preparedSql.length, sqlAfterDispose)
    assert.deepEqual(reminderStore.getReminder(firstRound.id), newAcceptedRound)
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    try {
      reminders?.dispose()
    } catch (error) {
      cleanupErrors.push(error.message)
      exitCode = 1
    } finally {
      restorePrepare?.()
    }
    try {
      closeDatabase()
      await flushLogs()
    } catch (error) {
      cleanupErrors.push(error.message)
      exitCode = 1
    }
    if (profile.ownership === 'script' && exitCode === 0) {
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
