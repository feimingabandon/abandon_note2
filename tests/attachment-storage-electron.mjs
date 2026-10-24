import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createNotesSchema } from '../src/main/db/db-schema.js'
import { createAttachmentResetJournalSchema } from '../src/main/db/attachment-reset-journal.js'
import {
  cleanupStagedImage,
  commitStagedImage,
  deleteImageRecordAndFile,
  purgeNoteAndFiles,
  resolveImagePath,
  stageImage,
  stageImageDeletion
} from '../src/main/db/db-images.js'
import { cleanupPendingAttachmentDirs, getAttachmentRecoveryReport } from '../src/main/db/db.js'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'
import { createAttachmentRecoveryRetryController } from '../src/main/application/attachment-recovery-retry.js'
import { flushLogs } from '../src/main/logging/logger.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/attachment-storage-electron.mjs',
  mode: 'electron-ready-memory-sqlite-real-files',
  metadata: { browserWindow: false, nativeImage: false }
})
const { assert } = recorder

function insertNote(db, content) {
  const timestamp = Date.now()
  return Number(
    db
      .prepare(
        `INSERT INTO notes (
           content, status, effective_at, finished_at, created_at, updated_at
         ) VALUES (?, 'in_progress', ?, ?, ?, ?)`
      )
      .run(content, timestamp, timestamp, timestamp, timestamp).lastInsertRowid
  )
}

function insertAttachment(db, noteId, relativePath) {
  return Number(
    db
      .prepare(
        `INSERT INTO note_attachments (note_id, file_path, file_size, sort_order, created_at)
         VALUES (?, ?, 4, 0, ?)`
      )
      .run(noteId, relativePath, Date.now()).lastInsertRowid
  )
}

function writeAttachment(relativePath, value = 'test') {
  const absolutePath = resolveImagePath(relativePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, value)
  return absolutePath
}

function assertRecoveryOperation(operationDirectory, expected) {
  const report = getAttachmentRecoveryReport()
  const operation = report.operations.find(
    (entry) => entry.operationId === basename(operationDirectory)
  )
  assert.ok(operation, `report must include ${basename(operationDirectory)}`)
  assert.deepEqual(
    {
      status: operation.status,
      statuses: operation.statuses,
      decision: operation.decision,
      action: operation.action
    },
    { statuses: [expected.status], ...expected }
  )
  assert.equal(report.counts[expected.status], 1)
  assert.equal(report.status, expected.status)
  return report
}

async function verifyControlledRetry(
  db,
  profileDirectory,
  operationDirectory,
  originalPath,
  pendingPath
) {
  const admission = createBusinessMutationAdmission()
  const oldRoundId = getAttachmentRecoveryReport().roundId
  const tail = join(profileDirectory, 'retry-admitted-business-tail.txt')
  let finishMutation
  let draftOwner = null
  let recoverCalls = 0
  const mutation = admission.run(async () => {
    await new Promise((resolve) => {
      finishMutation = resolve
    })
    writeFileSync(tail, 'complete business cleanup')
  })
  const controller = createAttachmentRecoveryRetryController({
    businessAdmission: admission,
    // Controlled draft drain port; actual runtime ownership is covered by the product suite.
    draftAssetsRuntime: {
      sealAndDrain(owner) {
        assert.equal(draftOwner, null)
        draftOwner = owner
        return Promise.resolve()
      },
      resume(owner) {
        assert.equal(draftOwner, owner)
        draftOwner = null
        return true
      }
    },
    canStart: () => db.open,
    getSource: () => db,
    isSourceCurrent: (source) => source === db && db.open,
    recover: async () => {
      recoverCalls++
      assert.equal(readFileSync(tail, 'utf8'), 'complete business cleanup')
      await cleanupPendingAttachmentDirs()
    },
    getReport: () => {
      assert.equal(admission.canAdmit(), false, 'report must be copied inside the business lock')
      assert.notEqual(draftOwner, null, 'report must be copied inside the draft lock')
      return getAttachmentRecoveryReport()
    },
    onError: (error) => {
      throw error
    }
  })
  const retrying = controller.retry()
  try {
    assert.equal(admission.canAdmit(), false)
    assert.notEqual(draftOwner, null)
    assert.throws(() => admission.run(() => true), /维护/)
    await Promise.resolve()
    assert.equal(recoverCalls, 0, 'recovery must wait for admitted file cleanup')
    assert.equal(getAttachmentRecoveryReport().roundId, oldRoundId)
    finishMutation()
    await mutation
    const result = await retrying
    assert.equal(result.outcome, 'finished')
    assert.equal(result.report.phase, 'finished')
    assert.equal(result.report.status, 'preservedConflict')
    assert.notEqual(result.report.roundId, oldRoundId)
    assert.equal(result.report.operations[0].operationId, basename(operationDirectory))
    assert.equal(readFileSync(originalPath, 'utf8'), 'current replacement')
    assert.equal(readFileSync(pendingPath, 'utf8'), 'staged original')
    assert.equal(existsSync(operationDirectory), true)
    result.report.counts.preservedConflict = 999
    assert.equal(getAttachmentRecoveryReport().counts.preservedConflict, 1)
    assert.equal(admission.canAdmit(), true)
    assert.equal(draftOwner, null)
  } finally {
    finishMutation()
    await Promise.allSettled([mutation, retrying])
  }
}

function verifySnapshotReads(db, profileDirectory) {
  const expected = getAttachmentRecoveryReport()
  const mutable = getAttachmentRecoveryReport()
  mutable.status = 'completed'
  mutable.counts.preservedConflict = 99
  mutable.operations[0].statuses.push('completed')
  mutable.operations[0].action = 'changed by caller'
  mutable.operations.push({ operationId: 'caller-only' })
  assert.deepEqual(getAttachmentRecoveryReport(), expected)

  const require = createRequire(import.meta.url)
  const fs = require('node:fs')
  const promises = require('node:fs/promises')
  const originals = []
  let ioCalls = 0
  try {
    for (const [owner, methods] of [
      [
        fs,
        [
          'existsSync',
          'statSync',
          'lstatSync',
          'readdirSync',
          'readFileSync',
          'writeFileSync',
          'mkdirSync',
          'renameSync',
          'rmSync',
          'unlinkSync'
        ]
      ],
      [
        promises,
        ['readdir', 'rm', 'readFile', 'stat', 'lstat', 'mkdir', 'writeFile', 'rename', 'unlink']
      ],
      [db, ['prepare', 'exec', 'pragma', 'transaction']]
    ]) {
      for (const name of methods) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, name)
        originals.push({ owner, name, descriptor })
        Object.defineProperty(owner, name, {
          configurable: true,
          writable: true,
          value() {
            ioCalls += 1
            throw new Error(`snapshot getter must not call ${name}`)
          }
        })
      }
    }
    syncBuiltinESMExports()
    assert.deepEqual(getAttachmentRecoveryReport(), expected)
    assert.deepEqual(getAttachmentRecoveryReport(), expected)
    assert.equal(ioCalls, 0)
  } finally {
    for (const { owner, name, descriptor } of originals) {
      if (descriptor) Object.defineProperty(owner, name, descriptor)
      else delete owner[name]
    }
    syncBuiltinESMExports()
  }

  const otherProfile = join(profileDirectory, 'other-profile')
  mkdirSync(otherProfile)
  try {
    app.setPath('userData', otherProfile)
    const report = getAttachmentRecoveryReport()
    assert.equal(report.phase, 'not-started')
    assert.equal(report.status, 'undetermined')
    assert.deepEqual(report.operations, [])
  } finally {
    app.setPath('userData', profileDirectory)
  }
  clearDb()
  assert.equal(getAttachmentRecoveryReport().phase, 'not-started')
  assert.deepEqual(getAttachmentRecoveryReport().operations, [])
  const replacement = new Database(':memory:')
  try {
    setDb(replacement)
    assert.equal(getAttachmentRecoveryReport().phase, 'not-started')
    assert.deepEqual(getAttachmentRecoveryReport().operations, [])
  } finally {
    setDb(db)
    replacement.close()
  }
}

app.once('ready', async () => {
  let profile = null
  let tempRoot = null
  let db = null
  let exitCode = 0
  let completed = false
  let failure = null

  try {
    profile = prepareTestProfile({ prefix: 'abandon-attachment-test-' })
    tempRoot = profile.directory
    app.setPath('userData', tempRoot)
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    createNotesSchema(db)
    createAttachmentResetJournalSchema(db)
    setDb(db)
    const recoveryEvents = []

    const noteId = insertNote(db, '附件恢复测试')
    const relativePath = join('attachments', 'images', String(noteId), 'recover.png')
    const originalPath = writeAttachment(relativePath)
    const attachmentId = insertAttachment(db, noteId, relativePath)

    const pendingDeletion = stageImageDeletion(relativePath)
    assert.equal(existsSync(originalPath), false)
    assert.equal(
      await cleanupPendingAttachmentDirs({
        onRecovery: (event) => recoveryEvents.push(event)
      }),
      undefined
    )
    assert.equal(existsSync(originalPath), true)
    assert.equal(
      recoveryEvents.some(
        (event) =>
          event.operationType === 'image-delete' &&
          event.action === 'rolled-back' &&
          event.recoveredFiles === 1
      ),
      true
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM note_attachments WHERE id = ?').get(attachmentId)
        .count,
      1
    )
    const firstReport = assertRecoveryOperation(pendingDeletion.operationDirectory, {
      status: 'completed',
      decision: 'uncommitted',
      action: 'rolled-back'
    })
    assert.equal(firstReport.schemaVersion, 1)
    assert.equal(firstReport.scope, 'pending-attachment-recovery-round')
    assert.equal(firstReport.phase, 'finished')
    assert.equal(firstReport.partial, false)
    assert.equal(firstReport.failure, null)
    assert.ok(firstReport.roundId)
    assert.ok(Number.isFinite(Date.parse(firstReport.startedAt)))
    assert.ok(Number.isFinite(Date.parse(firstReport.finishedAt)))

    db.exec(`
      CREATE TRIGGER fail_attachment_delete
      BEFORE DELETE ON note_attachments
      BEGIN
        SELECT RAISE(ABORT, 'injected attachment delete failure');
      END;
    `)
    await assert.rejects(
      () => deleteImageRecordAndFile(attachmentId),
      /injected attachment delete failure/
    )
    assert.equal(existsSync(originalPath), true)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM note_attachments WHERE id = ?').get(attachmentId)
        .count,
      1
    )
    db.exec('DROP TRIGGER fail_attachment_delete')

    assert.equal(await deleteImageRecordAndFile(attachmentId), true)
    assert.equal(existsSync(originalPath), false)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM note_attachments WHERE id = ?').get(attachmentId)
        .count,
      0
    )

    const imageOnlyNoteId = insertNote(db, '')
    const imageOnlyRelativePath = join(
      'attachments',
      'images',
      String(imageOnlyNoteId),
      'only-image.png'
    )
    const imageOnlyPath = writeAttachment(imageOnlyRelativePath)
    const imageOnlyAttachmentId = insertAttachment(db, imageOnlyNoteId, imageOnlyRelativePath)
    await assert.rejects(
      () => deleteImageRecordAndFile(imageOnlyAttachmentId),
      /纯图片便签至少需要保留一张图片/
    )
    assert.equal(existsSync(imageOnlyPath), true)
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM note_attachments WHERE id = ?')
        .get(imageOnlyAttachmentId).count,
      1
    )
    db.prepare('UPDATE notes SET content = ? WHERE id = ?').run('补充正文后可删除', imageOnlyNoteId)
    assert.equal(await deleteImageRecordAndFile(imageOnlyAttachmentId), true)
    assert.equal(existsSync(imageOnlyPath), false)

    const purgeFailureNoteId = insertNote(db, '彻底删除失败恢复测试')
    const purgeFailureRelativePath = join(
      'attachments',
      'images',
      String(purgeFailureNoteId),
      'purge-failure.png'
    )
    const purgeFailurePath = writeAttachment(purgeFailureRelativePath)
    insertAttachment(db, purgeFailureNoteId, purgeFailureRelativePath)
    db.exec(`
      CREATE TRIGGER fail_note_purge
      BEFORE DELETE ON notes
      BEGIN
        SELECT RAISE(ABORT, 'injected note purge failure');
      END;
    `)
    await assert.rejects(() => purgeNoteAndFiles(purgeFailureNoteId), /injected note purge failure/)
    assert.equal(existsSync(purgeFailurePath), true)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM notes WHERE id = ?').get(purgeFailureNoteId).count,
      1
    )
    db.exec('DROP TRIGGER fail_note_purge')

    assert.equal(await purgeNoteAndFiles(purgeFailureNoteId), true)
    assert.equal(existsSync(purgeFailurePath), false)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM notes WHERE id = ?').get(purgeFailureNoteId).count,
      0
    )

    const additionNoteId = insertNote(db, '新增附件恢复测试')
    const uncommittedAddition = await stageImage(Buffer.from('pending').toString('base64'), 'png')
    await cleanupPendingAttachmentDirs()
    assert.equal(existsSync(uncommittedAddition.operationDirectory), false)

    const orphanAddition = await stageImage(Buffer.from('orphan').toString('base64'), 'png')
    const orphanResult = commitStagedImage(additionNoteId, orphanAddition)
    const orphanPath = resolveImagePath(orphanResult.relativePath)
    assert.equal(existsSync(orphanPath), true)
    await cleanupPendingAttachmentDirs()
    assert.equal(existsSync(orphanPath), false)
    assert.equal(existsSync(orphanAddition.operationDirectory), false)

    const committedAddition = await stageImage(Buffer.from('committed').toString('base64'), 'png')
    const committedResult = commitStagedImage(additionNoteId, committedAddition)
    const committedPath = resolveImagePath(committedResult.relativePath)
    insertAttachment(db, additionNoteId, committedResult.relativePath)
    await cleanupPendingAttachmentDirs()
    assert.equal(existsSync(committedPath), true)
    assert.equal(existsSync(committedAddition.operationDirectory), false)
    assertRecoveryOperation(committedAddition.operationDirectory, {
      status: 'completed',
      decision: 'committed',
      action: 'committed-cleanup'
    })
    await cleanupStagedImage(committedAddition)

    const missingAddition = await stageImage(Buffer.from('lost addition').toString('base64'), 'png')
    const missingAdditionResult = commitStagedImage(additionNoteId, missingAddition)
    insertAttachment(db, additionNoteId, missingAdditionResult.relativePath)
    await rm(resolveImagePath(missingAdditionResult.relativePath))
    const missingAdditionEvents = []
    await cleanupPendingAttachmentDirs({
      onRecovery: (event) => missingAdditionEvents.push(event)
    })
    assert.deepEqual(missingAdditionEvents, [
      {
        operationId: basename(missingAddition.operationDirectory),
        operationType: 'image-add',
        action: 'committed-cleanup',
        deletedFiles: 0
      }
    ])
    assert.equal(existsSync(missingAddition.operationDirectory), false)
    assertRecoveryOperation(missingAddition.operationDirectory, {
      status: 'referenceMissing',
      decision: 'committed',
      action: 'committed-cleanup'
    })

    const missingDeletionRelativePath = join(
      'attachments',
      'images',
      String(additionNoteId),
      'missing-deletion.png'
    )
    const missingDeletionOriginal = writeAttachment(missingDeletionRelativePath)
    insertAttachment(db, additionNoteId, missingDeletionRelativePath)
    const missingDeletion = stageImageDeletion(missingDeletionRelativePath)
    await rm(missingDeletion.pendingPath)
    const missingDeletionEvents = []
    await cleanupPendingAttachmentDirs({
      onRecovery: (event) => missingDeletionEvents.push(event)
    })
    assert.deepEqual(missingDeletionEvents, [
      {
        operationId: basename(missingDeletion.operationDirectory),
        operationType: 'image-delete',
        action: 'cleanup-missing-payload'
      }
    ])
    assert.equal(existsSync(missingDeletionOriginal), false)
    assert.equal(existsSync(missingDeletion.operationDirectory), false)
    assertRecoveryOperation(missingDeletion.operationDirectory, {
      status: 'referenceMissing',
      decision: 'uncommitted',
      action: 'cleanup-missing-payload'
    })

    const conflictRelativePath = join(
      'attachments',
      'images',
      String(additionNoteId),
      'conflicting-deletion.png'
    )
    writeAttachment(conflictRelativePath, 'staged original')
    insertAttachment(db, additionNoteId, conflictRelativePath)
    const conflictDeletion = stageImageDeletion(conflictRelativePath)
    const conflictOriginal = writeAttachment(conflictRelativePath, 'current replacement')
    await cleanupPendingAttachmentDirs()
    assert.equal(readFileSync(conflictDeletion.pendingPath, 'utf8'), 'staged original')
    assert.equal(readFileSync(conflictOriginal, 'utf8'), 'current replacement')
    assertRecoveryOperation(conflictDeletion.operationDirectory, {
      status: 'preservedConflict',
      decision: 'uncommitted',
      action: 'preserved-conflict'
    })
    verifySnapshotReads(db, tempRoot)
    await verifyControlledRetry(
      db,
      tempRoot,
      conflictDeletion.operationDirectory,
      conflictOriginal,
      conflictDeletion.pendingPath
    )
    await rm(conflictDeletion.operationDirectory, { recursive: true, force: true })

    const resetNoteId = insertNote(db, '全量清理恢复测试')
    const resetRelativePath = join('attachments', 'images', String(resetNoteId), 'reset.png')
    const resetOriginalPath = writeAttachment(resetRelativePath)
    insertAttachment(db, resetNoteId, resetRelativePath)
    const operationDirectory = join(tempRoot, '.attachments-deleting-reset-test')
    mkdirSync(operationDirectory)
    writeFileSync(
      join(operationDirectory, 'operation.json'),
      JSON.stringify({ version: 1, type: 'reset' })
    )
    const resetSource = join(tempRoot, 'attachments')
    const resetTarget = join(operationDirectory, 'attachments')
    try {
      renameSync(resetSource, resetTarget)
    } catch (error) {
      // Optional one-attempt diagnosis only. Preserve and rethrow the original
      // rename error if observation fails; an external timeout remains incomplete.
      if (process.env.ABANDON_RENAME_DIAGNOSTIC_HELPER) {
        // Persist the original to the runner's stderr before any native query can block.
        console.error('Reset rename failed before handle observation:', error)
        const diagnostic = {
          pid: process.pid,
          at: new Date().toISOString(),
          nodeError: Object.fromEntries(
            ['name', 'message', 'stack', 'code', 'errno', 'syscall', 'path', 'dest'].map((key) => [
              key,
              error[key]
            ])
          ),
          activeResources: process.getActiveResourcesInfo()
        }
        try {
          const requireDiagnostic = createRequire(import.meta.url)
          const helper = requireDiagnostic(process.env.ABANDON_RENAME_DIAGNOSTIC_HELPER)
          diagnostic.selfHandles = helper.captureCurrentProcessFileHandles(tempRoot)
          const fs = requireDiagnostic('node:fs')
          diagnostic.paths = [resetSource, resetTarget, operationDirectory].map((path) => {
            try {
              const stat = fs.lstatSync(path)
              return {
                path,
                directory: stat.isDirectory(),
                symbolicLink: stat.isSymbolicLink(),
                mode: stat.mode
              }
            } catch (failure) {
              return { path, code: failure.code, errno: failure.errno }
            }
          })
        } catch (failure) {
          diagnostic.observationError = failure?.stack || String(failure)
        }
        try {
          writeFileSync(
            join(
              process.env.ABANDON_TEST_EVIDENCE_DIR || tempRoot,
              'reset-rename-failure-diagnostic.json'
            ),
            JSON.stringify(diagnostic, null, 2),
            { flag: 'wx' }
          )
        } catch (failure) {
          console.error('Reset rename diagnostic could not be saved:', failure)
        }
      }
      throw error
    }

    await cleanupPendingAttachmentDirs()
    assert.equal(existsSync(resetOriginalPath), true)
    assert.equal(existsSync(operationDirectory), false)
    assertRecoveryOperation(operationDirectory, {
      status: 'completed',
      decision: 'uncommitted',
      action: 'rolled-back'
    })

    const stagingEntries = await readdir(join(tempRoot, '.attachments-staging'))
    assert.equal(stagingEntries.length, 0)
    completed = true
    console.log('attachment storage integration tests passed')
  } catch (error) {
    console.error(error)
    failure = error
    exitCode = 1
  } finally {
    const cleanupErrors = []
    for (const release of [clearDb, () => db?.close()]) {
      try {
        release()
      } catch (error) {
        cleanupErrors.push(error.message)
        console.error(error)
        exitCode = 1
      }
    }
    let evidence = { status: 'complete' }
    if (tempRoot) {
      try {
        const flush = await flushLogs()
        evidence = { status: flush.incomplete ? 'incomplete' : 'complete', flush }
      } catch (error) {
        evidence = { status: 'failed', reason: error.message }
        console.error(error)
        exitCode = 1
      }
    }
    const preserveProfile = Boolean(tempRoot && (exitCode || evidence.status !== 'complete'))
    if (profile?.ownership === 'script' && !preserveProfile) {
      try {
        await rm(tempRoot, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error.message)
        console.error(error)
        exitCode = 1
      }
    }
    try {
      recorder.finish({
        completed,
        error: failure,
        evidence,
        profileOwnership: profile?.ownership,
        cleanup: {
          status: cleanupErrors.length ? 'failed' : preserveProfile ? 'preserved' : 'complete',
          ...(cleanupErrors.length ? { error: cleanupErrors.join('\n') } : {}),
          ...(preserveProfile || cleanupErrors.length ? { preservedProfile: tempRoot } : {})
        }
      })
    } catch (error) {
      console.error(error)
      exitCode = 1
    }
    app.exit(exitCode)
  }
})
