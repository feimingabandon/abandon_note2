import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import {
  initDatabase,
  closeDatabase,
  cleanupPendingAttachmentDirs,
  clearNoteData
} from '../src/main/db/db.js'
import { getDb } from '../src/main/db/db-connection.js'
import { createNote, getNoteById } from '../src/main/db/db-notes.js'
import { setSettingsBatch, getAllSettings } from '../src/main/db/db-settings-repository.js'
import { resetBusinessData } from '../src/main/db/business-data-reset.js'
import { createNoteWithAssets, saveNoteDraft } from '../src/main/notes/note-commands.js'
import { registerBusinessIpcHandlers } from '../src/main/ipc/register-business-ipc.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const phase = process.env.ABANDON_ATTACHMENT_RECOVERY_PHASE || 'controller'
const recorder = createAssertionRecorder({
  suite: 'tests/attachment-recovery-reset-electron.mjs',
  mode: 'electron-disk-attachment-recovery-reset-two-process',
  metadata: { browserWindow: false, phase, interruptedSnapshot: true }
})
const { assert } = recorder

async function verifyAdditionCompensation(profile) {
  const require = createRequire(import.meta.url)
  const promises = require('node:fs/promises')
  const unlinkDescriptor = Object.getOwnPropertyDescriptor(promises, 'unlink')
  const image = {
    base64: Buffer.from('addition compensation bytes').toString('base64'),
    ext: 'png'
  }
  for (const kind of ['create', 'draft', 'batch']) {
    let original
    if (kind !== 'create') {
      original = await createNoteWithAssets({
        options: { content: `original ${kind}` },
        images: kind === 'draft' ? [image] : [],
        tagIds: []
      })
    }
    const handlers = new Map()
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send() {} }
    }
    if (kind === 'batch')
      registerBusinessIpcHandlers({
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        getMainWindow: () => window
      })
    getDb().exec(
      "CREATE TRIGGER fail_addition_compensation BEFORE INSERT ON note_attachments BEGIN SELECT RAISE(ABORT,'compensation SQL failure'); END"
    )
    let injected = 0
    try {
      const imageRoot = resolve(profile.directory, 'attachments', 'images') + sep
      Object.defineProperty(promises, 'unlink', {
        ...unlinkDescriptor,
        value: async function (target, ...args) {
          if (resolve(String(target)).startsWith(imageRoot)) {
            injected += 1
            throw Object.assign(new Error('controlled final unlink EACCES'), { code: 'EACCES' })
          }
          return Reflect.apply(unlinkDescriptor.value, this, [target, ...args])
        }
      })
      syncBuiltinESMExports()
      const invoke = () =>
        kind === 'create'
          ? createNoteWithAssets({
              options: { content: 'failed creation' },
              images: [image],
              tagIds: []
            })
          : kind === 'draft'
            ? saveNoteDraft({
                id: original.id,
                expectedVersion: original.editVersion,
                fields: { content: 'failed replacement', status: original.status },
                tagIds: [],
                addedImages: [image],
                deletedImageIds: [original.attachments[0].id]
              })
            : handlers.get('images:save-batch')(
                { sender: window.webContents },
                { noteId: original.id, images: [image] }
              )
      await assert.rejects(invoke, /compensation SQL failure/)
      assert.equal(injected, 1)
      const staging = join(profile.directory, '.attachments-staging')
      const operations = readdirSync(staging)
      assert.equal(
        operations.length,
        1,
        `${kind} must preserve exactly its failed final deletion evidence`
      )
      const target = JSON.parse(readFileSync(join(staging, operations[0], 'target.json'), 'utf8'))
      const orphan = join(profile.directory, target.relativePath)
      assert.equal(existsSync(orphan), true)
      assert.equal(readFileSync(orphan, 'utf8'), 'addition compensation bytes')
      if (kind === 'draft') {
        assert.equal(getNoteById(original.id).content, 'original draft')
        assert.equal(
          readFileSync(join(profile.directory, original.attachments[0].file_path), 'utf8'),
          'addition compensation bytes'
        )
      }
      Object.defineProperty(promises, 'unlink', unlinkDescriptor)
      syncBuiltinESMExports()
      getDb().exec('DROP TRIGGER fail_addition_compensation')
      closeDatabase()
      initDatabase({ userDataPath: profile.directory })
      const events = []
      await cleanupPendingAttachmentDirs({ onRecovery: (event) => events.push(event) })
      assert.equal(existsSync(orphan), false)
      assert.equal(existsSync(join(staging, operations[0])), false)
      assert.equal(
        events.some(
          (event) => event.operationType === 'image-add' && event.action === 'rolled-back'
        ),
        true
      )
      await cleanupPendingAttachmentDirs()
      if (kind !== 'create') assert.equal(getNoteById(original.id).content, `original ${kind}`)
      assert.equal(getDb().pragma('integrity_check', { simple: true }), 'ok')
      await clearNoteData()
    } finally {
      Object.defineProperty(promises, 'unlink', unlinkDescriptor)
      syncBuiltinESMExports()
      getDb().exec('DROP TRIGGER IF EXISTS fail_addition_compensation')
    }
  }
}

async function verifyResetJournal(profile) {
  const require = createRequire(import.meta.url)
  const fs = require('node:fs')
  const promises = require('node:fs/promises')
  const writeDescriptor = Object.getOwnPropertyDescriptor(fs, 'writeFileSync')
  const rmDescriptor = Object.getOwnPropertyDescriptor(promises, 'rm')
  const image = { base64: Buffer.from('journal reset old bytes').toString('base64'), ext: 'png' }
  for (const newAttachment of [false, true]) {
    const original = await createNoteWithAssets({
      options: { content: 'old reset note' },
      images: [image],
      tagIds: []
    })
    const oldPath = join(profile.directory, original.attachments[0].file_path)
    let markerFailures = 0
    let removeFailures = 0
    try {
      Object.defineProperty(fs, 'writeFileSync', {
        ...writeDescriptor,
        value: function (target, ...args) {
          if (
            resolve(String(target)).startsWith(resolve(profile.directory) + sep) &&
            String(target).endsWith(sep + 'committed')
          ) {
            markerFailures += 1
            throw Object.assign(new Error('controlled marker EACCES'), { code: 'EACCES' })
          }
          return Reflect.apply(writeDescriptor.value, this, [target, ...args])
        }
      })
      Object.defineProperty(promises, 'rm', {
        ...rmDescriptor,
        value: async function (target, ...args) {
          if (
            resolve(String(target)).startsWith(
              resolve(profile.directory) + sep + '.attachments-deleting-reset-'
            )
          ) {
            removeFailures += 1
            throw Object.assign(new Error('controlled reset rm EACCES'), { code: 'EACCES' })
          }
          return Reflect.apply(rmDescriptor.value, this, [target, ...args])
        }
      })
      syncBuiltinESMExports()
      await clearNoteData()
      assert.equal(markerFailures, 1)
      assert.equal(removeFailures, 1)
      assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0)
      assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM note_attachments').get().n, 0)
      assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_reset_commits').get().n, 1)
      assert.equal(existsSync(oldPath), false)
      const operation = readdirSync(profile.directory).find((name) =>
        name.startsWith('.attachments-deleting-reset-')
      )
      const manifest = JSON.parse(
        readFileSync(join(profile.directory, operation, 'operation.json'), 'utf8')
      )
      assert.equal(manifest.version, 2)
      assert.equal(operation, `.attachments-deleting-reset-${manifest.operationId}`)
      Object.defineProperty(fs, 'writeFileSync', writeDescriptor)
      Object.defineProperty(promises, 'rm', rmDescriptor)
      syncBuiltinESMExports()
      const fresh = await createNoteWithAssets({
        options: { content: 'new note after clear' },
        images: newAttachment ? [image] : [],
        tagIds: []
      })
      getDb().prepare("INSERT INTO tags(name,created_at) VALUES('new tag',1)").run()
      getDb()
        .prepare(
          "INSERT INTO note_templates(content,recurrence_rule,schedule_anchor_at,created_at,updated_at) VALUES('new template','{}',1,1,1)"
        )
        .run()
      closeDatabase()
      initDatabase({ userDataPath: profile.directory })
      const events = []
      await cleanupPendingAttachmentDirs({ onRecovery: (event) => events.push(event) })
      assert.equal(
        existsSync(oldPath),
        false,
        'committed old bytes must never be restored by new business rows'
      )
      assert.equal(existsSync(join(profile.directory, operation)), false)
      assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_reset_commits').get().n, 0)
      assert.equal(
        events.some((event) => event.action === 'committed-cleanup'),
        true
      )
      assert.equal(getNoteById(original.id), null)
      assert.equal(getNoteById(fresh.id).content, 'new note after clear')
      if (newAttachment)
        assert.equal(
          readFileSync(join(profile.directory, fresh.attachments[0].file_path), 'utf8'),
          'journal reset old bytes'
        )
      await cleanupPendingAttachmentDirs()
      assert.equal(getDb().pragma('integrity_check', { simple: true }), 'ok')
      await clearNoteData()
    } finally {
      Object.defineProperty(fs, 'writeFileSync', writeDescriptor)
      Object.defineProperty(promises, 'rm', rmDescriptor)
      syncBuiltinESMExports()
    }
  }
  const retained = await createNoteWithAssets({
    options: { content: 'atomic reset journal rollback' },
    images: [image],
    tagIds: []
  })
  getDb().exec(
    "CREATE TRIGGER fail_reset_journal BEFORE INSERT ON attachment_reset_commits BEGIN SELECT RAISE(ABORT,'journal INSERT failure'); END"
  )
  try {
    await assert.rejects(() => clearNoteData(), /journal INSERT failure/)
    assert.equal(getNoteById(retained.id).content, 'atomic reset journal rollback')
    assert.equal(
      readFileSync(join(profile.directory, retained.attachments[0].file_path), 'utf8'),
      'journal reset old bytes'
    )
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_reset_commits').get().n, 0)
  } finally {
    getDb().exec('DROP TRIGGER fail_reset_journal')
  }
  await clearNoteData()

  const cleaned = await createNoteWithAssets({
    options: { content: 'journal cleanup retry' },
    images: [image],
    tagIds: []
  })
  const cleanedPath = join(profile.directory, cleaned.attachments[0].file_path)
  getDb().exec(
    "CREATE TRIGGER fail_journal_cleanup BEFORE DELETE ON attachment_reset_commits BEGIN SELECT RAISE(ABORT,'journal DELETE failure'); END"
  )
  try {
    await clearNoteData()
    assert.equal(getNoteById(cleaned.id), null)
    assert.equal(existsSync(cleanedPath), false)
    assert.equal(
      readdirSync(profile.directory).some((name) =>
        name.startsWith('.attachments-deleting-reset-')
      ),
      false
    )
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_reset_commits').get().n, 1)
    const events = []
    await cleanupPendingAttachmentDirs({ onRecovery: (event) => events.push(event) })
    assert.equal(
      events.some((event) => event.action === 'journal-cleanup-pending'),
      true
    )
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_reset_commits').get().n, 1)
  } finally {
    getDb().exec('DROP TRIGGER fail_journal_cleanup')
  }
  closeDatabase()
  initDatabase({ userDataPath: profile.directory })
  await cleanupPendingAttachmentDirs()
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_reset_commits').get().n, 0)
  assert.equal(existsSync(cleanedPath), false)

  const legacyDirectory = join(profile.directory, '.attachments-deleting-reset-legacy-ambiguous')
  const legacyPayload = join(legacyDirectory, 'attachments', 'images', '99', 'legacy.png')
  mkdirSync(join(legacyDirectory, 'attachments', 'images', '99'), { recursive: true })
  writeFileSync(
    join(legacyDirectory, 'operation.json'),
    JSON.stringify({ version: 1, type: 'reset' })
  )
  writeFileSync(legacyPayload, 'undecidable legacy bytes')
  const legacyEvents = []
  await cleanupPendingAttachmentDirs({ onRecovery: (event) => legacyEvents.push(event) })
  assert.equal(readFileSync(legacyPayload, 'utf8'), 'undecidable legacy bytes')
  assert.equal(
    legacyEvents.some((event) => event.action === 'preserved-ambiguous-legacy'),
    true
  )
  assert.equal(
    existsSync(join(profile.directory, 'attachments', 'images', '99', 'legacy.png')),
    false
  )
  await rm(legacyDirectory, { recursive: true, force: true })
  assert.equal(getDb().pragma('integrity_check', { simple: true }), 'ok')
}

function createChildEnvironment(profile, resultFile, token) {
  const env = {
    ...process.env,
    ABANDON_ATTACHMENT_RECOVERY_PHASE: resultFile.startsWith('child-seed') ? 'seed' : 'recover',
    ABANDON_TEST_RUN_TOKEN: token
  }
  const evidenceRoot = process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory
  env.ABANDON_TEST_RESULT_FILE = join(evidenceRoot, resultFile)
  env.ABANDON_TEST_EVIDENCE_DIR = evidenceRoot
  env.ABANDON_TEST_USER_DATA = profile.directory
  // Child profiles are already inside this controller's owned TEMP.
  env.TEMP = process.env.TEMP || join(profile.directory, '..')
  env.TMP = env.TEMP
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

app.once('ready', async () => {
  let profile
  let completed = false
  let failure
  let exitCode = 0
  const cleanupErrors = []
  try {
    profile = prepareTestProfile({ prefix: 'abandon-attachment-recovery-' })
    app.setPath('userData', profile.directory)
    if (phase === 'controller') {
      const children = []
      for (const childPhase of ['seed', 'recover']) {
        const token = randomUUID().replaceAll('-', '')
        const resultName = `child-${childPhase}.json`
        const env = createChildEnvironment(profile, resultName, token)
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
          env,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000
        })
        writeFileSync(
          join(
            process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory,
            `child-${childPhase}.txt`
          ),
          (child.stdout || '') + (child.stderr || '')
        )
        assert.equal(child.error, undefined)
        assert.equal(child.status, 0)
        const result = JSON.parse(readFileSync(env.ABANDON_TEST_RESULT_FILE, 'utf8'))
        assert.equal(result.runToken, token)
        assert.equal(result.completed, true)
        assert.ok(result.assertions.total > 0)
        assert.equal(result.assertions.passed, result.assertions.total)
        assert.equal(result.cleanup.status, 'complete')
        children.push({ phase: childPhase, assertions: result.assertions.total })
        if (childPhase === 'seed') {
          assert.equal(
            existsSync(
              join(profile.directory, '.attachments-deleting-reset-interrupted', 'attachments')
            ),
            true
          )
          assert.equal(existsSync(join(profile.directory, 'attachments')), false)
        }
      }
      assert.equal(
        existsSync(join(profile.directory, '.attachments-deleting-reset-interrupted')),
        false
      )
      assert.equal(
        readdirSync(profile.directory).some((name) =>
          name.startsWith('.attachments-deleting-reset-')
        ),
        false
      )
      writeFileSync(
        join(process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory, 'child-counts.json'),
        JSON.stringify(children)
      )
    } else {
      initDatabase({ userDataPath: profile.directory })
      if (phase === 'seed') {
        const note = createNote({ content: '独立进程中断快照' })
        setSettingsBatch('application', [{ type: 'weather', key: 'enabled', value: 'true' }])
        const relativePath = join('attachments', 'images', String(note.id), 'payload.png')
        const absolutePath = join(profile.directory, relativePath)
        mkdirSync(join(absolutePath, '..'), { recursive: true })
        writeFileSync(absolutePath, 'attachment snapshot bytes')
        getDb()
          .prepare('INSERT INTO note_attachments (note_id,file_path,created_at) VALUES (?,?,1)')
          .run(note.id, relativePath)
        const operation = join(profile.directory, '.attachments-deleting-reset-interrupted')
        mkdirSync(operation)
        writeFileSync(
          join(operation, 'operation.json'),
          JSON.stringify({ version: 1, type: 'reset' })
        )
        renameSync(join(profile.directory, 'attachments'), join(operation, 'attachments'))
        writeFileSync(
          join(profile.directory, 'snapshot.json'),
          JSON.stringify({ noteId: note.id, relativePath })
        )
        assert.equal(existsSync(absolutePath), false)
        assert.equal(getNoteById(note.id).content, '独立进程中断快照')
        // Exit without closeDatabase: the next child reopens actual on-disk WAL state.
        completed = true
        return
      }
      const snapshot = JSON.parse(readFileSync(join(profile.directory, 'snapshot.json'), 'utf8'))
      const original = join(profile.directory, snapshot.relativePath)
      const events = []
      await cleanupPendingAttachmentDirs({ onRecovery: (event) => events.push(event) })
      assert.equal(existsSync(original), true)
      assert.equal(readFileSync(original, 'utf8'), 'attachment snapshot bytes')
      assert.equal(getNoteById(snapshot.noteId).content, '独立进程中断快照')
      assert.equal(
        events.some((event) => event.operationType === 'reset' && event.action === 'rolled-back'),
        true
      )
      await cleanupPendingAttachmentDirs()
      assert.equal(existsSync(original), true)
      assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM note_attachments').get().count, 1)

      getDb().exec(`CREATE TRIGGER fail_business_reset BEFORE DELETE ON notes
        BEGIN SELECT RAISE(ABORT,'injected reset failure'); END;`)
      await assert.rejects(() => clearNoteData(), /injected reset failure/)
      assert.equal(existsSync(original), true)
      assert.equal(getNoteById(snapshot.noteId).content, '独立进程中断快照')
      assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM note_attachments').get().count, 1)
      getDb().exec('DROP TRIGGER fail_business_reset')
      await resetBusinessData({
        userDataPath: profile.directory,
        removeDirectory: async () => {
          throw new Error('injected committed cleanup failure')
        }
      })
      assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0)
      assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM note_attachments').get().count, 0)
      assert.equal(getAllSettings('application')[0].value, 'true')
      assert.equal(existsSync(join(profile.directory, 'attachments')), false)
      const pending = readdirSync(profile.directory).filter((name) =>
        name.startsWith('.attachments-deleting-reset-')
      )
      assert.equal(pending.length, 1)
      assert.equal(existsSync(join(profile.directory, pending[0], 'committed')), true)
      await cleanupPendingAttachmentDirs({ onRecovery: (event) => events.push(event) })
      assert.equal(existsSync(join(profile.directory, pending[0])), false)
      assert.equal(
        events.some(
          (event) => event.operationType === 'reset' && event.action === 'committed-cleanup'
        ),
        true
      )
      await cleanupPendingAttachmentDirs()
      assert.equal(getAllSettings('application')[0].value, 'true')
      await verifyAdditionCompensation(profile)
      await verifyResetJournal(profile)
    }
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    if (phase === 'recover') {
      try {
        closeDatabase()
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
      console.error(error)
      exitCode = 1
    }
    app.exit(exitCode)
  }
})
