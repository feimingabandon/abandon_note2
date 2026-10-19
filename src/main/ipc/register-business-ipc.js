import { clipboard } from 'electron'
import { getDb } from '../db/db.js'
import {
  previewHistoricalNotesToToday,
  moveHistoricalNotesToToday
} from '../db/db-historical-note-move.js'
import {
  completeNote,
  countActiveNotes,
  createNote,
  deleteNote,
  getNoteById,
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
  previewTemplateNextRun,
  purgeTemplate,
  restoreTemplate,
  resumeTemplate,
  updateTemplate
} from '../db/db-templates.js'
import {
  addImageRecord,
  cleanupStagedImage,
  commitStagedImage,
  deleteImageRecordAndFile,
  getImageBase64,
  getImageCount,
  getImageDimensions,
  getImageThumbnail,
  listImageRecords,
  purgeNoteAndFiles,
  stageImage
} from '../db/db-images.js'
import { compensateFailedNoteAssets } from '../db/image-addition-compensation.js'
import { enforceSystemNotificationPolicy } from '../../shared/notification-policy.js'
import {
  MAX_ATTACHMENTS_PER_NOTE,
  assertAttachmentBatchWithinLimit
} from '../../shared/attachment-rules.js'
import {
  createNoteWithAssets,
  normalizeNoteCreateOptions,
  saveNoteDraft
} from '../notes/note-commands.js'
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
 * 这里是业务数据边界：负责授权、请求观察与提交后广播，完整便签命令承担跨资源事务，
 * 不负责应用生命周期、窗口创建或调度器启动。
 */
export function registerBusinessIpcHandlers({
  ipcMain: rawIpcMain,
  getMainWindow,
  getAuthorizedWindows = getMainWindow,
  getBroadcastWindows = getMainWindow,
  getViewMode = () => null,
  diagnosticLogger = null,
  runMutation = (operation) => operation(),
  onNotePurged = () => {},
  onRemindersChanged = () => {}
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
  const mutationChannels = new Set([
    ...observedNoteChannels,
    'notes:move-historical-to-today',
    'notes:reorder-custom',
    'notes:update-custom-order',
    'tags:create',
    'tags:update',
    'tags:delete',
    'tags:update-order',
    'note-tags:bind',
    'note-tags:unbind',
    'note-tags:set',
    'templates:create',
    'templates:update',
    'templates:delete',
    'templates:pause',
    'templates:resume',
    'templates:restore',
    'templates:purge',
    'images:save-batch',
    'images:delete'
  ])
  const readDiagnosticNote = (id, { relations = false } = {}) => {
    const db = getDb()
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
    if (!note) return null
    if (!relations) return note
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
      const observed = observedNoteChannels.has(channel)
        ? (event, ...args) => observeNoteMutation(handler, readDiagnosticNote, event, args, channel)
        : handler
      authorizedIpc.handle(
        channel,
        mutationChannels.has(channel)
          ? (event, ...args) => runMutation(() => observed(event, ...args))
          : observed
      )
      return this
    }
  }
  const enforceNotificationPolicy = enforceSystemNotificationPolicy
  const normalizeUserCreateOptions = normalizeNoteCreateOptions
  const broadcastNoteChange = (reason, result, payload = {}) => {
    if (!result) return result
    // Presentation failures cannot turn a committed database mutation into a failure.
    try {
      onRemindersChanged()
    } catch (error) {
      console.error('[reminders] refresh failed', error)
    }
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

  ipcMain.handle('notes:create-with-assets', async (_event, payload) =>
    broadcastNoteChange('create', await createNoteWithAssets(payload))
  )

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

  ipcMain.handle('notes:save-draft', async (_event, payload = {}) =>
    broadcastNoteChange('update', await saveNoteDraft(payload), {
      id: Number(payload.id)
    })
  )

  ipcMain.handle('notes:delete', (_event, { id }) =>
    broadcastNoteChange('deletion', deleteNote(id), { id })
  )

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
      broadcastNoteChange('purge', purged, { id: noteId })
    }
    return purged
  })

  ipcMain.handle('notes:get', (_event, { id }) => getNoteById(id))
  ipcMain.handle('notes:preview-historical-move', (_event, selection = {}) =>
    previewHistoricalNotesToToday(selection)
  )
  ipcMain.handle('notes:move-historical-to-today', (_event, selection = {}) => {
    const result = moveHistoricalNotesToToday(selection)
    return result.count > 0 ? broadcastNoteChange('manual-historical-move', result) : result
  })
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
  ipcMain.handle('templates:preview-next-run', (_event, fields = {}) =>
    previewTemplateNextRun(fields)
  )

  ipcMain.handle('images:save-batch', async (_event, { noteId, images }) => {
    const batch = Array.isArray(images) ? images : []
    const remaining = MAX_ATTACHMENTS_PER_NOTE - getImageCount(noteId)
    assertAttachmentBatchWithinLimit(batch, { maxCount: remaining })

    const db = getDb()
    const writtenImages = []
    const stagedImages = []
    try {
      for (const image of batch) stagedImages.push(await stageImage(image.base64, image.ext))
    } catch (error) {
      await compensateFailedNoteAssets({ stagedImages })
      throw error
    }

    const transaction = db.transaction(() => {
      const results = []
      for (const staged of stagedImages) {
        const { relativePath, fileSize } = commitStagedImage(noteId, staged)
        writtenImages.push({ relativePath, staged })
        results.push(addImageRecord({ noteId, filePath: relativePath, fileSize }))
      }
      return results
    })

    let results
    try {
      results = transaction()
    } catch (error) {
      await compensateFailedNoteAssets({ writtenImages, stagedImages })
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
