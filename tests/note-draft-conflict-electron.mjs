import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { initDatabase, closeDatabase, getDb } from '../src/main/db/db.js'
import {
  completeNote,
  createNote,
  getNoteById,
  updateNote,
  updateNoteTextColor
} from '../src/main/db/db-notes.js'
import {
  addImageRecord,
  commitStagedImage,
  resolveImagePath,
  stageImage,
  cleanupStagedImage
} from '../src/main/db/db-images.js'
import { registerBusinessIpcHandlers } from '../src/main/ipc/register-business-ipc.js'

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
            durationKind: note.duration_kind,
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

    await assert.rejects(
      handlers.get('notes:create-with-assets')(
        { sender: window.webContents },
        { options: { content: '' }, images: [], tagIds: [] }
      ),
      /请输入便签内容/
    )
    const imageOnly = await handlers.get('notes:create-with-assets')(
      { sender: window.webContents },
      { options: { content: '' }, images: [image], tagIds: [] }
    )
    assert.equal(imageOnly.content, '')
    assert.equal(imageOnly.attachments.length, 1)
    const coloredCreated = await handlers.get('notes:create-with-assets')(
      { sender: window.webContents },
      {
        options: {
          content: '新建彩色便签',
          contentColorRanges: [{ start: 2, end: 4, text: '彩色', color: '#34c759' }]
        },
        images: [],
        tagIds: []
      }
    )
    assert.deepEqual(coloredCreated.content_color_ranges, [
      { start: 2, end: 4, text: '彩色', color: '#34c759' }
    ])
    await assert.rejects(
      save(imageOnly, {
        deletedImageIds: [imageOnly.attachments[0].id],
        fields: {
          content: '',
          status: imageOnly.status,
          effectiveAt: imageOnly.effective_at,
          durationKind: imageOnly.duration_kind,
          durationDays: imageOnly.duration_days,
          notifyEnabled: false,
          isPinned: false
        }
      }),
      /请输入便签内容/
    )

    const fresh = createNote({ content: 'original' })
    const saved = await save(fresh)
    assert.equal(saved.is_pinned, 1)
    assert.notEqual(saved.editVersion, fresh.editVersion)
    await assert.rejects(save(saved, { expectedVersion: undefined }), /缺少便签编辑版本/)

    const colorBase = createNote({ content: '今天完成报告' })
    const colored = updateNoteTextColor(colorBase.id, {
      start: 2,
      end: 4,
      color: '#ff3b30',
      expectedContent: colorBase.content,
      expectedColorRanges: colorBase.content_color_ranges
    })
    const shiftedColor = await save(colored, {
      fields: {
        content: '请在今天完成报告',
        status: colored.status,
        effectiveAt: colored.effective_at,
        durationKind: colored.duration_kind,
        durationDays: colored.duration_days,
        notifyEnabled: false,
        isPinned: false
      }
    })
    assert.deepEqual(shiftedColor.content_color_ranges, [
      { start: 4, end: 6, text: '完成', color: '#ff3b30' }
    ])

    const explicitColorBase = createNote({ content: '修改界面选色' })
    const explicitColor = await save(explicitColorBase, {
      fields: {
        content: explicitColorBase.content,
        contentColorRanges: [{ start: 4, end: 6, text: '选色', color: '#af52de' }],
        status: explicitColorBase.status,
        effectiveAt: explicitColorBase.effective_at,
        durationKind: explicitColorBase.duration_kind,
        durationDays: explicitColorBase.duration_days,
        notifyEnabled: false,
        isPinned: false
      }
    })
    assert.deepEqual(explicitColor.content_color_ranges, [
      { start: 4, end: 6, text: '选色', color: '#af52de' }
    ])

    const staleColorDraft = createNote({ content: '颜色版本冲突' })
    updateNoteTextColor(staleColorDraft.id, {
      start: 0,
      end: 2,
      color: '#007aff',
      expectedContent: staleColorDraft.content,
      expectedColorRanges: staleColorDraft.content_color_ranges
    })
    await assert.rejects(save(staleColorDraft), /便签已发生变化/)

    updateNote(saved.id, { content: 'new content from another editor' })
    // Force an identical timestamp to prove the content comparison is not timestamp-only.
    getDb().prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(saved.updated_at, saved.id)
    await assert.rejects(save(saved), /便签已发生变化/)
    assert.equal(getNoteById(saved.id).content, 'new content from another editor')

    const now = Date.now()
    const statusChanged = createNote({ content: 'status changed while editing' })
    assert.equal(completeNote(statusChanged.id).status, 'completed')
    await assert.rejects(save(statusChanged), /便签已发生变化/)
    assert.equal(getNoteById(statusChanged.id).status, 'completed')

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
      'note draft conflicts: fresh save, missing version, same-ms content, concurrent status change, tags, attachments, staging race and retry passed'
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
