import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { initDatabase, closeDatabase, getDb } from '../src/main/db/db.js'
import { createNote, getNoteById, updateNote } from '../src/main/db/db-notes.js'
import {
  addImageRecord,
  commitStagedImage,
  resolveImagePath,
  stageImage,
  cleanupStagedImage
} from '../src/main/db/db-images.js'
import { registerBusinessIpcHandlers } from '../src/main/ipc/register-business-ipc.js'
import { runAutomaticNoteMove } from '../src/main/services/automatic-note-move.js'

const testRoot = mkdtempSync(join(tmpdir(), 'abandon-note-draft-conflict-'))
app.setPath('userData', testRoot)
const image = { base64: Buffer.from('isolated attachment bytes').toString('base64'), ext: 'png' }

app.whenReady().then(async () => {
  let exitCode = 0
  try {
    initDatabase()
    const handlers = new Map()
    const broadcasts = []
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (...args) => broadcasts.push(args) }
    }
    registerBusinessIpcHandlers({
      ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
      getMainWindow: () => window
    })
    const save = (note, patch = {}) =>
      handlers.get('notes:save-draft')(
        { sender: window.webContents },
        {
          id: note.id,
          expectedVersion: note.editVersion,
          fields: {
            content: note.content,
            status: note.status,
            effectiveAt: note.effective_at,
            durationDays: note.duration_days,
            notifyEnabled: false,
            isPinned: true
          },
          tagIds: note.tags.map((tag) => tag.id),
          addedImages: [],
          deletedImageIds: [],
          ...patch
        }
      )

    const fresh = createNote({ content: 'original' })
    const saved = await save(fresh)
    assert.equal(saved.is_pinned, 1)
    assert.notEqual(saved.editVersion, fresh.editVersion)
    await assert.rejects(save(saved, { expectedVersion: undefined }), /缺少便签编辑版本/)

    updateNote(saved.id, { content: 'new content from another editor' })
    // Force an identical timestamp to prove the content comparison is not timestamp-only.
    getDb().prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(saved.updated_at, saved.id)
    await assert.rejects(save(saved), /便签已发生变化/)
    assert.equal(getNoteById(saved.id).content, 'new content from another editor')

    const now = Date.now()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const old = createNote({ content: 'move yesterday', effectiveAt: yesterday.getTime() })
    assert.equal(runAutomaticNoteMove({ enabled: true, now }).count, 1)
    await assert.rejects(save(old), /便签已发生变化/)
    assert.equal(getNoteById(old.id).effective_at, now)

    const tagged = createNote({ content: 'tag conflict' })
    const tagId = getDb()
      .prepare('INSERT INTO tags (name, created_at) VALUES (?, ?)')
      .run('new tag', now).lastInsertRowid
    getDb().prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(tagged.id, tagId)
    await assert.rejects(save(tagged), /便签已发生变化/)
    assert.equal(getNoteById(tagged.id).tags[0].id, Number(tagId))

    const attached = createNote({ content: 'attachment race' })
    const staged = await stageImage(image.base64, image.ext)
    const committed = commitStagedImage(attached.id, staged)
    const attachment = addImageRecord({
      noteId: attached.id,
      filePath: committed.relativePath,
      fileSize: committed.fileSize
    })
    await cleanupStagedImage(staged)
    await assert.rejects(save(attached), /便签已发生变化/)
    const editing = getNoteById(attached.id)
    const pending = save(editing, { addedImages: [image], deletedImageIds: [attachment.id] })
    // stageImage yields before the SQLite transaction; another writer can run here.
    updateNote(attached.id, { content: 'saved while attachment was staging' })
    const countBeforeRejection = broadcasts.length
    await assert.rejects(pending, /便签已发生变化/)
    const after = getNoteById(attached.id)
    assert.equal(after.content, 'saved while attachment was staging')
    assert.deepEqual(
      after.attachments.map((row) => row.id),
      [attachment.id]
    )
    assert.equal(
      readFileSync(resolveImagePath(committed.relativePath), 'utf8'),
      'isolated attachment bytes'
    )
    assert.equal(broadcasts.length, countBeforeRejection)
    const stagingRoot = join(testRoot, '.attachments-staging')
    assert.deepEqual(existsSync(stagingRoot) ? readdirSync(stagingRoot) : [], [])
    const retried = await save(after, { addedImages: [image], deletedImageIds: [attachment.id] })
    assert.equal(retried.attachments.length, 1)
    assert.notEqual(retried.attachments[0].id, attachment.id)
    assert.equal(existsSync(resolveImagePath(committed.relativePath)), false)
    console.log(
      'note draft conflicts: fresh save, missing version, same-ms content, automatic move, tags, attachments, staging race and retry passed'
    )
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    closeDatabase()
    rmSync(testRoot, { recursive: true, force: true })
    app.exit(exitCode)
  }
})
