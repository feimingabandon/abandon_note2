import { clipboard } from 'electron'
import { getDb } from '../db/db.js'
import {
  completeNote,
  countActiveNotes,
  createNote,
  deleteNote,
  getNoteById,
  resolveNoteDurationUpdate,
  normalizeRequiredNoteContent,
  queryCustomNormal,
  queryCustomPinned,
  queryCompactNote,
  queryEarlierNotes,
  queryPinnedNotes,
  queryRecentNotes,
  queryTagGroupNotes,
  queryTagGroups,
  reopenNote,
  restoreNote,
  reorderCustomSortOrder,
  searchNotes,
  startProgress,
  updateCustomSortOrders,
  updateNote,
  updateNoteTextColor
} from '../db/db-notes.js'
import {
  bindTag,
  createTag,
  deleteTag,
  getNoteTags,
  getTagById,
  getTagUsage,
  listTags,
  setNoteTagIds,
  updateTagOrder,
  updateTag,
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
  getImageDimensions,
  getImageThumbnail,
  listImageRecords,
  purgeNoteAndFiles,
  restoreStagedImageDeletion,
  stageImage,
  stageImageDeletion
} from '../db/db-images.js'
import { calculateNextRun, normalizeRecurrenceRule } from '../services/recurrence-rules.js'
import { enforceSystemNotificationPolicy } from '../../shared/notification-policy.js'
import { requireSingleAssignedTagId } from '../../shared/tag-rules.js'
import {
  MAX_ATTACHMENTS_PER_NOTE,
  assertAttachmentBatchWithinLimit
} from '../../shared/attachment-rules.js'
import {
  assertCreatableNoteEffectiveTime,
  resolveNoteDraftSchedule
} from '../../shared/note-scheduling-rules.js'
import {
  normalizeNoteTextColorRanges,
  reconcileNoteTextColorRanges
} from '../../shared/note-text-color-rules.js'
import { createMainWindowIpc } from './ipc-authorization.js'
import { checkpoint, diagnosticBroadcast } from '../logging/operation-context.js'
import { observeNoteMutation } from '../logging/persistence-evidence.js'

function sendToWindows(getWindows, channel, payload) {
  const diagnosticPayload = diagnosticBroadcast(payload)
  const resolved = getWindows()
  const windows = Array.isArray(resolved) ? resolved : [resolved]
  for (const window of new Set(windows.filter(Boolean))) {
    try {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(channel, diagnosticPayload)
    } catch (error) {
      checkpoint(
        'broadcast.failed',
        { channel, id: payload?.id },
        { level: 'error', outcome: 'failed', error }
      )
      continue
    }
    checkpoint('broadcast.sent', {
      channel,
      webContentsId: window.webContents.id,
      id: payload?.id,
      reason: payload?.reason
    })
  }
}

/**
 * 注册便签、标签、循环模板和附件相关 IPC。
 *
 * 这里是业务数据边界：负责 renderer 请求编排、跨 SQLite/文件系统事务补偿，
 * 不负责应用生命周期、窗口创建或调度器启动。
 */
export function registerBusinessIpcHandlers({
  ipcMain: rawIpcMain,
  getMainWindow,
  getAuthorizedWindows = getMainWindow,
  getBroadcastWindows = getMainWindow,
  getViewMode = () => null,
  platform = process.platform,
  diagnosticLogger = null,
  onNotePurged = () => {}
}) {
  const authorizedIpc = createMainWindowIpc(rawIpcMain, getAuthorizedWindows, '便签业务数据')
  const observedNoteChannels = new Set([
    'notes:create',
    'notes:create-with-assets',
    'notes:update',
    'notes:save-draft',
    'notes:set-text-color',
    'notes:restore',
    'notes:delete',
    'notes:purge',
    'notes:start-progress',
    'notes:complete',
    'notes:reopen'
  ])
  const readDiagnosticNote = (id) => {
    const db = getDb()
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
    if (!note) return null
    return {
      ...note,
      attachments: db
        .prepare('SELECT id FROM note_attachments WHERE note_id = ? ORDER BY id')
        .all(id),
      tags: db
        .prepare('SELECT tag_id AS id FROM note_tags WHERE note_id = ? ORDER BY tag_id')
        .all(id)
    }
  }
  const ipcMain = {
    handle(channel, handler) {
      authorizedIpc.handle(
        channel,
        observedNoteChannels.has(channel)
          ? (event, ...args) =>
              observeNoteMutation(handler, readDiagnosticNote, event, args, channel)
          : handler
      )
      return this
    }
  }
  const enforceNotificationPolicy = (payload) => enforceSystemNotificationPolicy(payload, platform)
  const normalizeUserCreateOptions = (payload) => {
    const options = enforceNotificationPolicy(payload)
    const hasExplicitEffectiveAt =
      options.effectiveAt !== undefined &&
      options.effectiveAt !== null &&
      options.effectiveAt !== ''
    if (hasExplicitEffectiveAt) {
      options.effectiveAt = assertCreatableNoteEffectiveTime(options.effectiveAt)
    }
    return options
  }
  const broadcastNoteChange = (reason, result, payload = {}) => {
    if (!result) return result
    const id = Number(result?.id ?? payload.id)
    sendToWindows(getBroadcastWindows, 'notes:changed', {
      reason,
      ...(Number.isInteger(id) && id > 0 ? { id } : {}),
      ...payload
    })
    return result
  }
  const broadcastTagChange = (reason, result, payload = {}) => {
    if (!result) return result
    sendToWindows(getBroadcastWindows, 'tags:changed', { reason, ...payload })
    return result
  }
  const broadcastTemplateChange = (reason, result, payload = {}) => {
    if (!result) return result
    const id = Number(result?.id ?? payload.id)
    sendToWindows(getBroadcastWindows, 'templates:changed', {
      reason,
      ...(Number.isInteger(id) && id > 0 ? { ids: [id] } : {}),
      ...payload
    })
    return result
  }

  ipcMain.handle('clipboard:write-text', (_event, payload = {}) => {
    const text = payload?.text
    if (typeof text !== 'string') throw new Error('剪贴板内容必须是文本')
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle('notes:create', (_event, options) => {
    return broadcastNoteChange('create', createNote(normalizeUserCreateOptions(options)))
  })

  ipcMain.handle('notes:create-with-assets', async (_event, { options, images, tagIds }) => {
    const db = getDb()
    const normalizedTagIds = requireSingleAssignedTagId(tagIds || [])
    const batch = Array.isArray(images) ? images : []
    assertAttachmentBatchWithinLimit(batch)
    const writtenFiles = []
    const stagedImages = []

    try {
      for (const image of batch) stagedImages.push(await stageImage(image.base64, image.ext))
    } catch (error) {
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }

    const transaction = db.transaction(() => {
      const note = createNote(normalizeUserCreateOptions(options), {
        allowEmptyContent: stagedImages.length > 0
      })
      if (!note?.id) throw new Error('创建便签失败')

      for (const staged of stagedImages) {
        const { relativePath, fileSize } = commitStagedImage(note.id, staged)
        writtenFiles.push(relativePath)
        addImageRecord({ noteId: note.id, filePath: relativePath, fileSize })
      }

      if (normalizedTagIds.length > 0) {
        db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(note.id)
        const insertTag = db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)')
        for (const tagId of normalizedTagIds) insertTag.run(note.id, tagId)
      }

      return getNoteById(note.id)
    })

    let created
    try {
      created = transaction()
    } catch (error) {
      await Promise.all(writtenFiles.map(deleteImageFile))
      await Promise.all(stagedImages.map(cleanupStagedImage))
      console.error('[notes:create-with-assets] 创建失败，已回滚并清理文件:', error)
      throw error
    }
    // SQLite has committed: notification failures must never remove committed files.
    await Promise.all(stagedImages.map(cleanupStagedImage))
    return broadcastNoteChange('create', created)
  })

  ipcMain.handle('notes:restore', (_event, { id }) =>
    broadcastNoteChange('restore', restoreNote(id), { id })
  )

  ipcMain.handle('notes:update', (_event, { id, fields, expectedContent, expectedRemark }) => {
    if (expectedContent !== undefined || expectedRemark !== undefined) {
      const current = getNoteById(id)
      if (!current) throw new Error('便签不存在或已被删除')
      if (expectedContent !== undefined && current.content !== expectedContent)
        throw new Error('便签正文已被其他操作修改，草稿已保留。请复制草稿或加载最新正文后重试。')
      if (expectedRemark !== undefined && current.remark !== expectedRemark)
        throw new Error('便签备注已被其他操作修改，草稿已保留。请复制草稿或加载最新内容后重试。')
    }
    return broadcastNoteChange('update', updateNote(id, enforceNotificationPolicy(fields)), { id })
  })

  ipcMain.handle('notes:set-text-color', (_event, payload = {}) => {
    const id = Number(payload.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('无效的便签 ID')
    return broadcastNoteChange('text-color', updateNoteTextColor(id, payload), { id })
  })

  ipcMain.handle('notes:save-draft', async (_event, payload = {}) => {
    const db = getDb()
    const id = Number(payload.id)
    const fields = enforceNotificationPolicy(payload.fields)
    const tagIds = requireSingleAssignedTagId(payload.tagIds || [])
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
    const assertDraftVersion = (note) => {
      if (!note) throw new Error('便签不存在或已删除')
      if (typeof payload.expectedVersion !== 'string' || !payload.expectedVersion) {
        throw new Error('缺少便签编辑版本，请重新打开编辑器')
      }
      if (note.editVersion !== payload.expectedVersion) {
        throw new Error('便签已发生变化，当前草稿尚未保存；请保留草稿后重新打开编辑器')
      }
    }
    assertDraftVersion(original)

    const duration = resolveNoteDurationUpdate(original, fields)
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

    const finalAttachmentCount =
      original.attachments.length - deletedImageIds.length + addedImages.length
    const requestedContent = String(fields.content ?? '')
    const content =
      finalAttachmentCount > 0 ? requestedContent : normalizeRequiredNoteContent(requestedContent)

    const remaining =
      MAX_ATTACHMENTS_PER_NOTE - original.attachments.length + deletedImageIds.length
    assertAttachmentBatchWithinLimit(addedImages, { maxCount: remaining })

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
      const current = getNoteById(id)
      // 大附件暂存期间其他 IPC / 调度器仍可修改便签，提交前必须再次核对。
      assertDraftVersion(current)

      const timestamp = Date.now()
      const requestedEffectiveAt =
        fields.effectiveAt === undefined || fields.effectiveAt === null || fields.effectiveAt === ''
          ? current.effective_at
          : fields.effectiveAt
      const schedule = resolveNoteDraftSchedule({
        status: current.status,
        currentEffectiveAt: current.effective_at,
        currentNotifyEnabled: current.notify_enabled,
        currentFinishedAt: current.finished_at,
        requestedEffectiveAt,
        requestedNotifyEnabled: fields.notifyEnabled,
        currentTime: timestamp
      })
      const submittedColorRanges = fields.contentColorRanges ?? fields.content_color_ranges
      const contentColorRanges =
        submittedColorRanges === undefined
          ? reconcileNoteTextColorRanges(current.content_color_ranges, current.content, content)
          : normalizeNoteTextColorRanges(submittedColorRanges, content)

      db.prepare(
        `UPDATE notes SET
           content = ?, content_color_ranges = ?, status = ?, is_pinned = ?, notify_enabled = ?, effective_at = ?, duration_days = ?, duration_kind = ?,
           finished_at = ?, updated_at = ?
         WHERE id = ? AND is_deleted = 0`
      ).run(
        content,
        JSON.stringify(contentColorRanges),
        schedule.status,
        fields.isPinned ? 1 : 0,
        schedule.notifyEnabled,
        schedule.effectiveAt,
        duration.durationDays,
        duration.durationKind,
        schedule.finishedAt,
        timestamp,
        id
      )

      db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(id)
      const insertTag = db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)')
      for (const tagId of tagIds) insertTag.run(id, tagId)

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

    let updated
    try {
      updated = transaction()
    } catch (error) {
      await Promise.all(writtenFiles.map(deleteImageFile))
      await Promise.all(stagedImages.map(cleanupStagedImage))
      for (const staged of stagedDeletions.reverse()) restoreStagedImageDeletion(staged)
      throw error
    }
    await Promise.all([
      ...stagedImages.map(cleanupStagedImage),
      ...stagedDeletions.map(cleanupStagedImage)
    ])
    return broadcastNoteChange('update', updated, { id })
  })

  ipcMain.handle('notes:delete', (_event, { id }) => {
    const deleted = deleteNote(id)
    if (deleted) sendToWindows(getBroadcastWindows, 'notes:changed', { reason: 'deletion', id })
    return deleted
  })

  ipcMain.handle('notes:purge', async (_event, { id }) => {
    const noteId = Number(id)
    const note = getNoteById(noteId)
    const purged = await purgeNoteAndFiles(noteId)
    if (purged) {
      diagnosticLogger?.info?.('note.purge', '便签已永久删除', {
        noteId,
        viewMode: getViewMode(),
        attachmentCount: Array.isArray(note?.attachments) ? note.attachments.length : null
      })
      onNotePurged(noteId)
      sendToWindows(getBroadcastWindows, 'notes:changed', { reason: 'purge', id: noteId })
    }
    return purged
  })

  ipcMain.handle('notes:get', (_event, { id }) => getNoteById(id))
  ipcMain.handle('notes:query-pinned', (_event, options) => queryPinnedNotes(options || {}))
  ipcMain.handle('notes:query-recent', (_event, options) => queryRecentNotes(options || {}))
  ipcMain.handle('notes:query-compact', () => queryCompactNote())
  ipcMain.handle('notes:query-earlier', (_event, options) => queryEarlierNotes(options || {}))
  ipcMain.handle('notes:query-custom-pinned', (_event, options) => queryCustomPinned(options || {}))
  ipcMain.handle('notes:query-custom-normal', (_event, options) => queryCustomNormal(options || {}))
  ipcMain.handle('notes:query-tag-groups', (_event, options) => queryTagGroups(options || {}))
  ipcMain.handle('notes:query-tag-group', (_event, options) => queryTagGroupNotes(options || {}))
  ipcMain.handle('notes:search', (_event, options) => searchNotes(options || {}))
  ipcMain.handle('notes:count-active', () => countActiveNotes())
  ipcMain.handle('notes:reorder-custom', () => reorderCustomSortOrder())
  ipcMain.handle('notes:update-custom-order', (_event, { items }) => updateCustomSortOrders(items))
  ipcMain.handle('notes:start-progress', (_event, { id }) =>
    broadcastNoteChange('status', startProgress(id), { id, status: 'in_progress' })
  )
  ipcMain.handle('notes:complete', (_event, { id }) =>
    broadcastNoteChange('status', completeNote(id), { id, status: 'completed' })
  )
  ipcMain.handle('notes:reopen', (_event, { id }) =>
    broadcastNoteChange('status', reopenNote(id), { id, status: 'in_progress' })
  )

  ipcMain.handle('tags:create', (_event, { name, color }) => {
    const tag = createTag(name, color)
    return broadcastTagChange('create', tag, { tag })
  })
  ipcMain.handle('tags:update', (_event, { id, fields }) => {
    const result = updateTag(id, fields)
    broadcastTagChange('update', result, {
      tag: result.tag,
      oldName: result.oldName
    })
    broadcastNoteChange('tag', true, { tagId: result.tag.id })
    return result.tag
  })
  ipcMain.handle('tags:delete', (_event, { id }) => {
    const deleted = deleteTag(id)
    if (deleted) {
      broadcastTagChange('delete', true, { id: Number(id) })
      broadcastNoteChange('tag', true, { tagId: Number(id) })
    }
    return deleted
  })
  ipcMain.handle('tags:update-order', (_event, { tagIds }) => {
    const tags = updateTagOrder(tagIds)
    const normalizedTagIds = Array.isArray(tagIds) ? tagIds.map(Number) : []
    return broadcastTagChange('reorder', tags, { tagIds: normalizedTagIds })
  })
  ipcMain.handle('tags:list', () => listTags())
  ipcMain.handle('tags:get', (_event, { id }) => getTagById(id))
  ipcMain.handle('tags:usage', (_event, { id }) => getTagUsage(id))
  ipcMain.handle('note-tags:bind', (_event, { noteId, tagId }) =>
    broadcastNoteChange('tag', bindTag(noteId, tagId), { id: noteId, tagId })
  )
  ipcMain.handle('note-tags:unbind', (_event, { noteId, tagId }) =>
    broadcastNoteChange('tag', unbindTag(noteId, tagId), { id: noteId, tagId })
  )
  ipcMain.handle('note-tags:set', (_event, { noteId, tagIds }) => {
    setNoteTagIds(noteId, tagIds)
    const tags = getNoteTags(noteId)
    broadcastNoteChange('tag', true, { id: noteId })
    return tags
  })
  ipcMain.handle('note-tags:list', (_event, { noteId }) => getNoteTags(noteId))

  ipcMain.handle('templates:create', (_event, options) => {
    return broadcastTemplateChange('create', createTemplate(enforceNotificationPolicy(options)))
  })
  ipcMain.handle('templates:update', (_event, { id, fields }) => {
    return broadcastTemplateChange('update', updateTemplate(id, enforceNotificationPolicy(fields)))
  })
  ipcMain.handle('templates:delete', (_event, { id }) =>
    broadcastTemplateChange('delete', deleteTemplate(id), { id: Number(id) })
  )
  ipcMain.handle('templates:list', (_event, options) => listTemplates(options || {}))
  ipcMain.handle('templates:get', (_event, { id, includeDeleted }) =>
    getTemplateById(id, { includeDeleted: !!includeDeleted })
  )
  ipcMain.handle('templates:pause', (_event, { id }) =>
    broadcastTemplateChange('pause', pauseTemplate(id))
  )
  ipcMain.handle('templates:resume', (_event, { id }) =>
    broadcastTemplateChange('resume', resumeTemplate(id))
  )
  ipcMain.handle('templates:restore', (_event, { id }) =>
    broadcastTemplateChange('restore', restoreTemplate(id))
  )
  ipcMain.handle('templates:purge', (_event, { id }) => {
    const templateId = Number(id)
    const purged = purgeTemplate(templateId)
    if (purged) {
      diagnosticLogger?.info?.('template.purge', '循环模板已永久删除', {
        templateId,
        viewMode: getViewMode()
      })
      broadcastTemplateChange('purge', true, { id: templateId })
    }
    return purged
  })
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
    const remaining = MAX_ATTACHMENTS_PER_NOTE - getImageCount(noteId)
    assertAttachmentBatchWithinLimit(batch, { maxCount: remaining })

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

    let results
    try {
      results = transaction()
    } catch (error) {
      await Promise.all(writtenFiles.map(deleteImageFile))
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }
    await Promise.all(stagedImages.map(cleanupStagedImage))
    broadcastNoteChange('attachment', true, { id: noteId })
    return results
  })

  ipcMain.handle('images:delete', async (_event, { id }) => {
    const attachment = getDb().prepare('SELECT note_id FROM note_attachments WHERE id = ?').get(id)
    const deleted = await deleteImageRecordAndFile(id)
    if (deleted) broadcastNoteChange('attachment', true, { id: attachment?.note_id })
    return deleted
  })
  ipcMain.handle('images:list', (_event, { noteId }) => listImageRecords(noteId))
  ipcMain.handle('images:get-base64', (_event, { relativePath }) => getImageBase64(relativePath))
  ipcMain.handle('images:get-dimensions', (_event, { relativePath }) =>
    getImageDimensions(relativePath)
  )
  ipcMain.handle('images:get-thumbnail', (_event, { relativePath, maxSize }) =>
    getImageThumbnail(relativePath, maxSize)
  )
  ipcMain.handle('images:count', (_event, { noteId }) => getImageCount(noteId))
}
