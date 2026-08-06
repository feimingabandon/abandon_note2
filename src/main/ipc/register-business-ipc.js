import { getDb } from '../db/db.js'
import {
  completeNote,
  countActiveNotes,
  createNote,
  deleteNote,
  getNoteById,
  normalizeRequiredNoteContent,
  queryCustomNormal,
  queryCustomPinned,
  queryEarlierNotes,
  queryPinnedNotes,
  queryRecentNotes,
  reopenNote,
  reorderCustomSortOrder,
  searchNotes,
  startProgress,
  updateCustomSortOrders,
  updateNote
} from '../db/db-notes.js'
import {
  bindTag,
  createTag,
  deleteTag,
  getNoteTags,
  getTagByName,
  getTagUsage,
  listTags,
  setNoteTags,
  unbindTag
} from '../db/db-tags.js'
import {
  createTemplate,
  deleteTemplate,
  getTemplateById,
  listTemplates,
  pauseTemplate,
  purgeTemplate,
  restoreTemplate,
  resumeTemplate,
  updateTemplate
} from '../db/db-templates.js'
import {
  addImageRecord,
  cleanupStagedImage,
  commitStagedImage,
  deleteImageFile,
  deleteImageRecordAndFile,
  getImageBase64,
  getImageCount,
  getImageThumbnail,
  listImageRecords,
  purgeNoteAndFiles,
  restoreStagedImageDeletion,
  stageImage,
  stageImageDeletion
} from '../db/db-images.js'
import { calculateNextRun, normalizeRecurrenceRule } from '../services/recurrence-rules.js'
import { enforceSystemNotificationPolicy } from '../../shared/notification-policy.js'
import { requireSingleAssignedTag } from '../../shared/tag-rules.js'

function sendToMainWindow(getMainWindow, channel, payload) {
  const window = getMainWindow()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(channel, payload)
}

/**
 * 注册便签、标签、循环模板和附件相关 IPC。
 *
 * 这里是业务数据边界：负责 renderer 请求编排、跨 SQLite/文件系统事务补偿，
 * 不负责应用生命周期、窗口创建或调度器启动。
 */
export function registerBusinessIpcHandlers({
  ipcMain,
  getMainWindow,
  platform = process.platform
}) {
  const enforceNotificationPolicy = (payload) => enforceSystemNotificationPolicy(payload, platform)

  ipcMain.handle('notes:create', (_event, options) => {
    return createNote(enforceNotificationPolicy(options))
  })

  ipcMain.handle('notes:create-with-assets', async (_event, { options, images, tagNames }) => {
    const db = getDb()
    const normalizedTagNames = requireSingleAssignedTag(tagNames || [])
    const writtenFiles = []
    const stagedImages = []

    try {
      for (const image of images || []) stagedImages.push(await stageImage(image.base64, image.ext))
    } catch (error) {
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }

    const transaction = db.transaction(() => {
      const note = createNote(enforceNotificationPolicy(options))
      if (!note?.id) throw new Error('创建便签失败')

      for (const staged of stagedImages) {
        const { relativePath, fileSize } = commitStagedImage(note.id, staged)
        writtenFiles.push(relativePath)
        addImageRecord({ noteId: note.id, filePath: relativePath, fileSize })
      }

      if (normalizedTagNames.length > 0) {
        db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(note.id)
        const insertTag = db.prepare('INSERT INTO note_tags (note_id, tag_name) VALUES (?, ?)')
        for (const tagName of normalizedTagNames) insertTag.run(note.id, tagName)
      }

      return getNoteById(note.id)
    })

    try {
      return transaction()
    } catch (error) {
      await Promise.all(writtenFiles.map(deleteImageFile))
      await Promise.all(stagedImages.map(cleanupStagedImage))
      console.error('[notes:create-with-assets] 创建失败，已回滚并清理文件:', error)
      throw error
    }
  })

  ipcMain.handle('notes:update', (_event, { id, fields }) => {
    return updateNote(id, enforceNotificationPolicy(fields))
  })

  ipcMain.handle('notes:save-draft', async (_event, payload = {}) => {
    const db = getDb()
    const id = Number(payload.id)
    const fields = enforceNotificationPolicy(payload.fields)
    const tagNames = requireSingleAssignedTag(payload.tagNames || [])
    const addedImages = Array.isArray(payload.addedImages) ? payload.addedImages : []
    const deletedImageIds = [
      ...new Set(
        (Array.isArray(payload.deletedImageIds) ? payload.deletedImageIds : [])
          .map(Number)
          .filter((imageId) => Number.isInteger(imageId) && imageId > 0)
      )
    ]

    if (!Number.isInteger(id) || id <= 0) throw new Error('无效的便签 ID')
    const original = getNoteById(id)
    if (!original) throw new Error('便签不存在或已删除')

    const content = normalizeRequiredNoteContent(fields.content)
    const requestedStatus = String(fields.status || original.status)
    if (requestedStatus !== original.status) {
      throw new Error(`不允许的状态修改：${original.status} → ${requestedStatus}`)
    }

    const ownedDeletedRows = deletedImageIds.length
      ? db
          .prepare(
            `SELECT id, file_path FROM note_attachments
             WHERE note_id = ? AND id IN (${deletedImageIds.map(() => '?').join(',')})`
          )
          .all(id, ...deletedImageIds)
      : []
    if (ownedDeletedRows.length !== deletedImageIds.length) {
      throw new Error('附件不存在或不属于当前便签')
    }

    const resultingCount = original.attachments.length - deletedImageIds.length + addedImages.length
    if (resultingCount > 50) throw new Error('单条便签最多只能保存 50 张图片')

    const stagedImages = []
    const writtenFiles = []
    try {
      for (const image of addedImages) stagedImages.push(await stageImage(image.base64, image.ext))
    } catch (error) {
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }

    const stagedDeletions = []
    try {
      for (const row of ownedDeletedRows) stagedDeletions.push(stageImageDeletion(row.file_path))
    } catch (error) {
      for (const staged of stagedDeletions.reverse()) restoreStagedImageDeletion(staged)
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }

    const transaction = db.transaction(() => {
      const current = db.prepare('SELECT * FROM notes WHERE id = ? AND is_deleted = 0').get(id)
      if (!current) throw new Error('便签不存在或已删除')
      if (current.status !== original.status) {
        throw new Error('便签状态已发生变化，请重新打开后再修改')
      }

      const timestamp = Date.now()
      let effectiveAt = current.effective_at
      let notifyEnabled = current.notify_enabled

      if (current.status === 'initialized') {
        const requestedEffectiveAt = Number(fields.effectiveAt)
        if (!Number.isFinite(requestedEffectiveAt) || requestedEffectiveAt <= 0) {
          throw new Error('请选择有效的生效时间')
        }
        const effectiveAtChanged =
          Math.floor(requestedEffectiveAt / 1000) !== Math.floor(current.effective_at / 1000)
        if (effectiveAtChanged && requestedEffectiveAt - timestamp < 5 * 60 * 1000) {
          throw new Error('生效时间需在当前时间 5 分钟之后')
        }
        effectiveAt = effectiveAtChanged ? requestedEffectiveAt : current.effective_at
        notifyEnabled = fields.notifyEnabled ? 1 : 0
      }

      db.prepare(
        `UPDATE notes SET
           content = ?, status = ?, is_pinned = ?, notify_enabled = ?, effective_at = ?,
           finished_at = ?, remind_again_at = ?, updated_at = ?
         WHERE id = ? AND is_deleted = 0`
      ).run(
        content,
        current.status,
        fields.isPinned ? 1 : 0,
        notifyEnabled,
        effectiveAt,
        current.finished_at,
        current.remind_again_at,
        timestamp,
        id
      )

      db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(id)
      const insertTag = db.prepare('INSERT INTO note_tags (note_id, tag_name) VALUES (?, ?)')
      for (const tagName of tagNames) insertTag.run(id, tagName)

      if (deletedImageIds.length) {
        db.prepare(
          `DELETE FROM note_attachments
           WHERE note_id = ? AND id IN (${deletedImageIds.map(() => '?').join(',')})`
        ).run(id, ...deletedImageIds)
      }

      for (const staged of stagedImages) {
        const { relativePath, fileSize } = commitStagedImage(id, staged)
        writtenFiles.push(relativePath)
        addImageRecord({ noteId: id, filePath: relativePath, fileSize })
      }

      return getNoteById(id)
    })

    try {
      const updated = transaction()
      await Promise.all(stagedDeletions.map(cleanupStagedImage))
      return updated
    } catch (error) {
      await Promise.all(writtenFiles.map(deleteImageFile))
      await Promise.all(stagedImages.map(cleanupStagedImage))
      for (const staged of stagedDeletions.reverse()) restoreStagedImageDeletion(staged)
      throw error
    }
  })

  ipcMain.handle('notes:delete', (_event, { id }) => {
    const deleted = deleteNote(id)
    if (deleted) sendToMainWindow(getMainWindow, 'notes:changed', { reason: 'deletion', id })
    return deleted
  })

  ipcMain.handle('notes:purge', async (_event, { id }) => {
    const noteId = Number(id)
    const purged = await purgeNoteAndFiles(noteId)
    if (purged) {
      sendToMainWindow(getMainWindow, 'notes:changed', { reason: 'purge', id: noteId })
    }
    return purged
  })

  ipcMain.handle('notes:get', (_event, { id }) => getNoteById(id))
  ipcMain.handle('notes:query-pinned', (_event, options) => queryPinnedNotes(options || {}))
  ipcMain.handle('notes:query-recent', (_event, options) => queryRecentNotes(options || {}))
  ipcMain.handle('notes:query-earlier', (_event, options) => queryEarlierNotes(options || {}))
  ipcMain.handle('notes:query-custom-pinned', (_event, options) => queryCustomPinned(options || {}))
  ipcMain.handle('notes:query-custom-normal', (_event, options) => queryCustomNormal(options || {}))
  ipcMain.handle('notes:search', (_event, options) => searchNotes(options || {}))
  ipcMain.handle('notes:count-active', () => countActiveNotes())
  ipcMain.handle('notes:reorder-custom', () => reorderCustomSortOrder())
  ipcMain.handle('notes:update-custom-order', (_event, { items }) => updateCustomSortOrders(items))
  ipcMain.handle('notes:start-progress', (_event, { id }) => startProgress(id))
  ipcMain.handle('notes:complete', (_event, { id }) => completeNote(id))
  ipcMain.handle('notes:reopen', (_event, { id }) => reopenNote(id))

  ipcMain.handle('tags:create', (_event, { name, color }) => createTag(name, color))
  ipcMain.handle('tags:delete', (_event, { name }) => deleteTag(name))
  ipcMain.handle('tags:list', () => listTags())
  ipcMain.handle('tags:get', (_event, { name }) => getTagByName(name))
  ipcMain.handle('tags:usage', (_event, { name }) => getTagUsage(name))
  ipcMain.handle('note-tags:bind', (_event, { noteId, tagName }) => bindTag(noteId, tagName))
  ipcMain.handle('note-tags:unbind', (_event, { noteId, tagName }) => unbindTag(noteId, tagName))
  ipcMain.handle('note-tags:set', (_event, { noteId, tagNames }) => {
    setNoteTags(noteId, tagNames)
    return getNoteTags(noteId)
  })
  ipcMain.handle('note-tags:list', (_event, { noteId }) => getNoteTags(noteId))

  ipcMain.handle('templates:create', (_event, options) => {
    return createTemplate(enforceNotificationPolicy(options))
  })
  ipcMain.handle('templates:update', (_event, { id, fields }) => {
    return updateTemplate(id, enforceNotificationPolicy(fields))
  })
  ipcMain.handle('templates:delete', (_event, { id }) => deleteTemplate(id))
  ipcMain.handle('templates:list', (_event, options) => listTemplates(options || {}))
  ipcMain.handle('templates:get', (_event, { id, includeDeleted }) =>
    getTemplateById(id, { includeDeleted: !!includeDeleted })
  )
  ipcMain.handle('templates:pause', (_event, { id }) => pauseTemplate(id))
  ipcMain.handle('templates:resume', (_event, { id }) => resumeTemplate(id))
  ipcMain.handle('templates:restore', (_event, { id }) => restoreTemplate(id))
  ipcMain.handle('templates:purge', (_event, { id }) => purgeTemplate(id))
  ipcMain.handle(
    'templates:preview-next-run',
    (_event, { recurrenceRule, afterTimestamp } = {}) => {
      const after = Number.isFinite(Number(afterTimestamp)) ? Number(afterTimestamp) : Date.now()
      const rule = normalizeRecurrenceRule(recurrenceRule)
      return calculateNextRun(rule, after, after)
    }
  )

  ipcMain.handle('images:save-batch', async (_event, { noteId, images }) => {
    const batch = Array.isArray(images) ? images : []
    const remaining = 50 - getImageCount(noteId)
    if (batch.length > remaining) throw new Error(`最多还能添加 ${Math.max(0, remaining)} 张图片`)

    const db = getDb()
    const writtenFiles = []
    const stagedImages = []
    try {
      for (const image of batch) stagedImages.push(await stageImage(image.base64, image.ext))
    } catch (error) {
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }

    const transaction = db.transaction(() => {
      const results = []
      for (const staged of stagedImages) {
        const { relativePath, fileSize } = commitStagedImage(noteId, staged)
        writtenFiles.push(relativePath)
        results.push(addImageRecord({ noteId, filePath: relativePath, fileSize }))
      }
      return results
    })

    try {
      return transaction()
    } catch (error) {
      await Promise.all(writtenFiles.map(deleteImageFile))
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }
  })

  ipcMain.handle('images:delete', async (_event, { id }) => deleteImageRecordAndFile(id))
  ipcMain.handle('images:list', (_event, { noteId }) => listImageRecords(noteId))
  ipcMain.handle('images:get-base64', (_event, { relativePath }) => getImageBase64(relativePath))
  ipcMain.handle('images:get-thumbnail', (_event, { relativePath, maxSize }) =>
    getImageThumbnail(relativePath, maxSize)
  )
  ipcMain.handle('images:count', (_event, { noteId }) => getImageCount(noteId))
}
