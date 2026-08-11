import assert from 'node:assert/strict'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createNotesSchema } from '../src/main/db/db-schema.js'
import {
  cleanupStagedImage,
  commitStagedImage,
  deleteImageRecordAndFile,
  purgeNoteAndFiles,
  resolveImagePath,
  stageImage,
  stageImageDeletion
} from '../src/main/db/db-images.js'
import { cleanupPendingAttachmentDirs } from '../src/main/db/db.js'

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

app.once('ready', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'abandon-attachment-test-'))
  let db = null
  let exitCode = 0

  try {
    app.setPath('userData', tempRoot)
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    createNotesSchema(db)
    setDb(db)

    const noteId = insertNote(db, '附件恢复测试')
    const relativePath = join('attachments', 'images', String(noteId), 'recover.png')
    const originalPath = writeAttachment(relativePath)
    const attachmentId = insertAttachment(db, noteId, relativePath)

    stageImageDeletion(relativePath)
    assert.equal(existsSync(originalPath), false)
    await cleanupPendingAttachmentDirs()
    assert.equal(existsSync(originalPath), true)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM note_attachments WHERE id = ?').get(attachmentId)
        .count,
      1
    )

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
    await cleanupStagedImage(committedAddition)

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
    renameSync(join(tempRoot, 'attachments'), join(operationDirectory, 'attachments'))

    await cleanupPendingAttachmentDirs()
    assert.equal(existsSync(resetOriginalPath), true)
    assert.equal(existsSync(operationDirectory), false)

    const stagingEntries = await readdir(join(tempRoot, '.attachments-staging'))
    assert.equal(stagingEntries.length, 0)
    console.log('attachment storage integration tests passed')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    clearDb()
    db?.close()
    await rm(tempRoot, { recursive: true, force: true })
    app.exit(exitCode)
  }
})
