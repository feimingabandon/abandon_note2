import { getDb } from '../db/db-connection.js'
import {
  createNote,
  getNoteById,
  resolveNoteDurationUpdate,
  normalizeRequiredNoteContent
} from '../db/db-notes.js'
import { cancelLiveNoteReminders, editPendingReminder } from '../db/db-reminders.js'
import {
  addImageRecord,
  cleanupStagedImage,
  commitStagedImage,
  getImageCount,
  stageImage,
  stageImageDeletion
} from '../db/db-images.js'
import { compensateFailedNoteAssets } from '../db/image-addition-compensation.js'
import { normalizeReminderChannels } from '../../shared/reminder-rules.js'
import { enforceSystemNotificationPolicy } from '../../shared/notification-policy.js'
import { requireSingleAssignedTagId } from '../../shared/tag-rules.js'
import {
  MAX_ATTACHMENTS_PER_NOTE,
  assertAttachmentBatchWithinLimit
} from '../../shared/attachment-rules.js'
import { resolveNoteDraftSchedule } from '../../shared/note-scheduling-rules.js'
import {
  normalizeNoteTextColorRanges,
  reconcileNoteTextColorRanges
} from '../../shared/note-text-color-rules.js'

/** Complete note mutations own staging, synchronous SQL and file compensation.
 * IPC authorization, diagnostics and post-commit broadcast remain at the boundary.
 */
export function normalizeNoteCreateOptions(payload) {
  // Resolve immediate time and validate state only at the database commit boundary,
  // after asynchronous asset staging, using one timestamp for effective/finished time.
  return enforceSystemNotificationPolicy(payload)
}

export async function createNoteWithAssets({ options, images, tagIds }) {
  const db = getDb()
  const normalizedTagIds = requireSingleAssignedTagId(tagIds || [])
  const batch = Array.isArray(images) ? images : []
  assertAttachmentBatchWithinLimit(batch)
  const writtenImages = []
  const stagedImages = []

  try {
    for (const image of batch) stagedImages.push(await stageImage(image.base64, image.ext))
  } catch (error) {
    await compensateFailedNoteAssets({ stagedImages })
    throw error
  }

  const transaction = db.transaction(() => {
    const note = createNote(normalizeNoteCreateOptions(options), {
      allowEmptyContent: stagedImages.length > 0
    })
    if (!note?.id) throw new Error('创建便签失败')

    for (const staged of stagedImages) {
      const { relativePath, fileSize } = commitStagedImage(note.id, staged)
      writtenImages.push({ relativePath, staged })
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
    await compensateFailedNoteAssets({ writtenImages, stagedImages })
    console.error('[notes:create-with-assets] 数据库已回滚，未完成的附件补偿保留待恢复:', error)
    throw error
  }
  // SQLite has committed: notification failures must never remove committed files.
  await Promise.all(stagedImages.map(cleanupStagedImage))
  return created
}

export async function addNoteImages({ noteId, images }) {
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
  return results
}

export async function saveNoteDraft(payload = {}) {
  const db = getDb()
  const id = Number(payload.id)
  const fields = enforceSystemNotificationPolicy(payload.fields)
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

  const remaining = MAX_ATTACHMENTS_PER_NOTE - original.attachments.length + deletedImageIds.length
  assertAttachmentBatchWithinLimit(addedImages, { maxCount: remaining })

  const stagedImages = []
  const writtenImages = []
  try {
    for (const image of addedImages) stagedImages.push(await stageImage(image.base64, image.ext))
  } catch (error) {
    await compensateFailedNoteAssets({ stagedImages })
    throw error
  }

  const stagedDeletions = []
  try {
    for (const row of ownedDeletedRows) stagedDeletions.push(stageImageDeletion(row.file_path))
  } catch (error) {
    await compensateFailedNoteAssets({ stagedImages, stagedDeletions })
    throw error
  }

  const transaction = db.transaction(() => {
    const current = getNoteById(id)
    // 大附件暂存期间其他 IPC / 调度器仍可修改便签，提交前必须再次核对。
    assertDraftVersion(current)

    const timestamp = Date.now()
    const schedule = resolveNoteDraftSchedule({
      status: current.status,
      currentEffectiveAt: current.effective_at,
      currentNotifyEnabled: current.notify_enabled,
      currentFinishedAt: current.finished_at,
      requestedEffectiveAt: fields.effectiveAt,
      requestedStatus: fields.status,
      requestedFinishedAt: fields.finishedAt,
      requestedNotifyEnabled: fields.notifyEnabled,
      currentTime: timestamp
    })
    const movedToFuture = schedule.status === 'initialized' && current.status !== 'initialized'
    const startReminderInvalidated =
      current.status === 'initialized' && schedule.status === 'in_progress'
    const reopened = current.status === 'completed' && schedule.status === 'in_progress'
    let channels =
      fields.reminderChannels === undefined
        ? schedule.status === 'initialized'
          ? fields.notifyEnabled === undefined
            ? current.status === 'initialized'
              ? current.reminder_channels
              : 0
            : normalizeReminderChannels(undefined, fields.notifyEnabled)
          : current.reminder_channels
        : normalizeReminderChannels(fields.reminderChannels)
    if (schedule.status === 'completed' || startReminderInvalidated || reopened) channels = 0
    // A future reschedule needs a fresh start round when activated, even when its
    // new reminder channels stay enabled. The schema trigger alone cannot cancel it.
    const rescheduledFuture =
      schedule.status === 'initialized' &&
      (movedToFuture || schedule.effectiveAt !== current.effective_at)
    const invalidateLiveReminder =
      schedule.status === 'completed' || startReminderInvalidated || reopened || rescheduledFuture
    if (invalidateLiveReminder) cancelLiveNoteReminders(id, timestamp)
    if (fields.pendingReminder !== undefined && channels && !invalidateLiveReminder) {
      editPendingReminder(id, fields.pendingReminder, timestamp)
    }
    const submittedColorRanges = fields.contentColorRanges ?? fields.content_color_ranges
    const contentColorRanges =
      submittedColorRanges === undefined
        ? reconcileNoteTextColorRanges(current.content_color_ranges, current.content, content)
        : normalizeNoteTextColorRanges(submittedColorRanges, content)
    const remark = fields.remark === undefined ? current.remark : String(fields.remark ?? '')

    db.prepare(
      `UPDATE notes SET
            content = ?, content_color_ranges = ?, status = ?, is_pinned = ?, notify_enabled = ?, reminder_channels = ?, effective_at = ?, duration_days = ?, duration_kind = ?,
            finished_at = ?, remark = ?, updated_at = ?
         WHERE id = ? AND is_deleted = 0`
    ).run(
      content,
      JSON.stringify(contentColorRanges),
      schedule.status,
      fields.isPinned ? 1 : 0,
      schedule.status === 'initialized' && channels ? 1 : 0,
      channels,
      schedule.effectiveAt,
      duration.durationDays,
      duration.durationKind,
      schedule.finishedAt,
      remark,
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
      writtenImages.push({ relativePath, staged })
      addImageRecord({ noteId: id, filePath: relativePath, fileSize })
    }

    return getNoteById(id)
  })

  let updated
  try {
    updated = transaction()
  } catch (error) {
    await compensateFailedNoteAssets({ writtenImages, stagedImages, stagedDeletions })
    throw error
  }
  await Promise.all([
    ...stagedImages.map(cleanupStagedImage),
    ...stagedDeletions.map(cleanupStagedImage)
  ])
  return updated
}
