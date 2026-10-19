import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import {
  activateNotes,
  completeNote,
  createNote,
  deleteNote,
  getNoteById,
  reopenNote,
  restoreNote,
  searchNotes,
  startProgress,
  updateNote
} from '../src/main/db/db-notes.js'
import { bindTag, createTag } from '../src/main/db/db-tags.js'
import { resolveImagePath } from '../src/main/db/db-images.js'
import {
  activateDueReminders,
  enqueueReminder,
  getPendingReminder,
  getReminder
} from '../src/main/db/db-reminders.js'
import { createNoteWithAssets, saveNoteDraft } from '../src/main/notes/note-commands.js'
import { localDateKey, noteDateRange } from '../src/shared/calendar/calendar-date-rules.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/note-state-db.mjs',
  mode: 'electron-ready-disk-sqlite-note-state-time-reminder-transactions',
  metadata: { diskDatabase: true, browserWindow: false, runtimeAppBootstrap: false }
})
const { assert } = recorder

app.once('ready', async () => {
  let profile
  let db
  let completed = false
  let failure
  let exitCode = 0
  const cleanupErrors = []
  try {
    profile = prepareTestProfile({ prefix: 'abandon-note-state-db-' })
    app.setPath('userData', profile.directory)
    db = new Database(join(profile.directory, 'notes.db'))
    db.pragma('foreign_keys = ON')
    createDatabaseSchema(db)
    setDb(db)
    const now = Date.now()
    const past = now - 3 * 86400000
    const finished = now - 2 * 86400000
    const draft = (note, fields) => ({
      id: note.id,
      expectedVersion: note.editVersion,
      fields: { content: note.content, ...fields },
      tagIds: note.tags.map((tag) => tag.id),
      addedImages: [],
      deletedImageIds: []
    })

    const immediate = createNote({ content: '默认立即便签' })
    assert.equal(immediate.status, 'in_progress')
    assert.equal(immediate.duration_kind, 'single_day')
    assert.equal(immediate.duration_days, 1)
    assert.equal(immediate.reminder_channels, 0)
    assert.ok(immediate.effective_at >= now)

    // Full-draft and quick-field edits share persisted business times, including
    // milliseconds that are not visible in the date/time inputs.
    const precisePast = Math.floor(past / 1000) * 1000 + 123
    const preciseFinished = Math.floor(finished / 1000) * 1000 + 789
    for (const [status, effectiveAt] of [
      ['initialized', now + 600123],
      ['in_progress', precisePast],
      ['completed', precisePast]
    ]) {
      const original = createNote({
        content: `属性编辑-${status}`,
        effectiveAt,
        status,
        ...(status === 'completed' ? { finishedAt: preciseFinished } : {}),
        reminderChannels: status === 'initialized' ? 3 : 0
      })
      const edited = await saveNoteDraft(
        draft(original, { content: `${original.content}-新`, isPinned: true, durationDays: 3 })
      )
      assert.equal(edited.status, status)
      assert.equal(edited.effective_at, original.effective_at)
      assert.equal(edited.finished_at, original.finished_at)
      assert.equal(edited.reminder_channels, original.reminder_channels)
      assert.equal(edited.is_pinned, 1)
      assert.equal(edited.duration_kind, 'fixed_days')
      assert.equal(edited.duration_days, 3)
      const quickEdited = updateNote(edited.id, { content: '快捷正文', remark: '快捷备注' })
      assert.equal(quickEdited.status, edited.status)
      assert.equal(quickEdited.effective_at, edited.effective_at)
      assert.equal(quickEdited.finished_at, edited.finished_at)
      assert.equal(quickEdited.reminder_channels, edited.reminder_channels)
      assert.equal(quickEdited.remark, '快捷备注')
    }

    const oldSingle = createNote({ content: '仅当天不会自动完成', effectiveAt: precisePast })
    activateNotes()
    assert.equal(getNoteById(oldSingle.id).status, 'in_progress')
    assert.equal(noteDateRange(getNoteById(oldSingle.id)).endKey, localDateKey(precisePast))
    assert.equal(getNoteById(oldSingle.id).effective_at, precisePast)

    const maximumDuration = createNote({ content: '365天边界', durationDays: 365 })
    assert.equal(maximumDuration.duration_days, 365)
    assert.throws(() => createNote({ content: '366天拒绝', durationDays: 366 }), /1~365/)
    assert.throws(() => updateNote(maximumDuration.id, { durationDays: 366 }), /1~365/)
    assert.equal(getNoteById(maximumDuration.id).duration_days, 365)

    const historical = createNote({
      content: '历史已完成',
      effectiveAt: past,
      status: 'completed',
      finishedAt: finished,
      durationKind: 'until_completed',
      reminderChannels: 1
    })
    assert.equal(historical.status, 'completed')
    assert.equal(historical.effective_at, past)
    assert.equal(historical.finished_at, finished)
    assert.equal(historical.reminder_channels, 0)
    assert.ok(historical.created_at >= now)
    assert.equal(noteDateRange(historical).endKey, localDateKey(finished))
    const contentOnly = await saveNoteDraft(draft(historical, { content: '修正正文' }))
    assert.equal(contentOnly.status, 'completed')
    assert.equal(contentOnly.finished_at, finished)
    const corrected = await saveNoteDraft(
      draft(contentOnly, { effectiveAt: past - 86400000, finishedAt: finished - 3600000 })
    )
    assert.equal(corrected.effective_at, past - 86400000)
    assert.equal(corrected.finished_at, finished - 3600000)

    const immediateCompleted = await createNoteWithAssets({
      options: { content: '立即完成', effectiveAt: null, status: 'completed', finishedAt: 'now' },
      images: [],
      tagIds: []
    })
    assert.equal(immediateCompleted.status, 'completed')
    assert.equal(immediateCompleted.effective_at, immediateCompleted.finished_at)
    assert.equal(immediateCompleted.created_at, immediateCompleted.finished_at)
    assert.throws(
      () => createNote({ content: '未来不能完成', effectiveAt: now + 600000, status: 'completed' }),
      /未来|未开始/
    )
    assert.throws(
      () =>
        createNote({
          content: '结束早于开始',
          effectiveAt: past,
          status: 'completed',
          finishedAt: past - 1
        }),
      /完成时间/
    )
    await assert.rejects(
      createNoteWithAssets({
        options: {
          content: '未来附件入口也校验',
          effectiveAt: now + 600000,
          status: 'in_progress'
        },
        images: [],
        tagIds: []
      }),
      /未来|未开始/
    )

    const beforeFinish = createNote({ content: '单事务历史完成', effectiveAt: past })
    const afterFinish = await saveNoteDraft(
      draft(beforeFinish, { status: 'completed', finishedAt: finished })
    )
    assert.equal(afterFinish.status, 'completed')
    assert.equal(afterFinish.finished_at, finished)
    const reopened = reopenNote(afterFinish.id)
    assert.equal(reopened.status, 'in_progress')
    assert.equal(reopened.effective_at, past)
    assert.equal(reopened.finished_at, null)
    assert.equal(reopened.reminder_channels, 0)

    const completedReschedule = createNote({
      content: '完成改未来必须明确取消',
      effectiveAt: precisePast,
      status: 'completed',
      finishedAt: preciseFinished
    })
    await assert.rejects(
      saveNoteDraft(
        draft(completedReschedule, { content: '不应部分保存', effectiveAt: now + 600000 })
      ),
      /明确取消完成/
    )
    assert.equal(getNoteById(completedReschedule.id).content, completedReschedule.content)
    assert.equal(getNoteById(completedReschedule.id).finished_at, preciseFinished)
    const cancelledCompletion = await saveNoteDraft(
      draft(completedReschedule, {
        status: 'initialized',
        effectiveAt: now + 600000,
        reminderChannels: 1
      })
    )
    assert.equal(cancelledCompletion.status, 'initialized')
    assert.equal(cancelledCompletion.finished_at, null)
    assert.equal(cancelledCompletion.reminder_channels, 1)

    const restoredTag = createTag('恢复保留标签')
    for (const [status, effectiveAt] of [
      ['initialized', now + 600000],
      ['in_progress', precisePast],
      ['completed', precisePast]
    ]) {
      const original = createNote({
        content: `删除恢复-${status}`,
        effectiveAt,
        status,
        ...(status === 'completed' ? { finishedAt: preciseFinished } : {}),
        reminderChannels: status === 'initialized' ? 3 : 0,
        durationDays: 4,
        isPinned: true
      })
      bindTag(original.id, restoredTag.id)
      assert.equal(deleteNote(original.id), true)
      assert.equal(getNoteById(original.id), null)
      assert.equal(searchNotes({ search: original.content, includeDeleted: false }).total, 0)
      const deleted = searchNotes({ search: original.content, includeDeleted: true })
      assert.equal(deleted.total, 1)
      assert.equal(deleted.notes[0].is_deleted, 1)
      const restored = restoreNote(original.id)
      assert.equal(restored.status, status)
      assert.equal(restored.effective_at, original.effective_at)
      assert.equal(restored.finished_at, original.finished_at)
      assert.equal(restored.duration_days, 4)
      assert.equal(restored.is_pinned, 1)
      assert.deepEqual(
        restored.tags.map((tag) => tag.id),
        [restoredTag.id]
      )
      assert.equal(restored.notify_enabled, 0)
      assert.equal(restored.reminder_channels, 0)
      assert.equal(getPendingReminder(restored.id), null)
      assert.equal(deleteNote(restored.id), true)
      assert.equal(deleteNote(restored.id), false)
    }

    const deletedAppointment = createNote({
      content: '删除期间预约到期',
      effectiveAt: now + 600000,
      reminderChannels: 1
    })
    deleteNote(deletedAppointment.id)
    db.prepare('UPDATE notes SET effective_at = ? WHERE id = ?').run(
      precisePast,
      deletedAppointment.id
    )
    activateNotes()
    assert.equal(
      db.prepare('SELECT status FROM notes WHERE id = ?').get(deletedAppointment.id).status,
      'initialized'
    )
    const restoredAppointment = restoreNote(deletedAppointment.id)
    assert.equal(restoredAppointment.status, 'in_progress')
    assert.equal(restoredAppointment.effective_at, precisePast)
    assert.equal(restoredAppointment.reminder_channels, 0)
    assert.equal(getPendingReminder(restoredAppointment.id), null)

    const deletedWithReminder = createNote({
      content: '恢复不复活旧提醒',
      effectiveAt: precisePast
    })
    db.prepare('UPDATE notes SET reminder_channels = 1 WHERE id = ?').run(deletedWithReminder.id)
    const deletedRound = enqueueReminder(deletedWithReminder.id, now + 600000)
    deleteNote(deletedWithReminder.id)
    assert.equal(getReminder(deletedRound.id).state, 'cancelled')
    restoreNote(deletedWithReminder.id)
    assert.equal(getReminder(deletedRound.id).state, 'cancelled')
    assert.equal(getPendingReminder(deletedWithReminder.id), null)

    const attachmentBytes = Buffer.from('isolated restore attachment')
    const withAttachment = await createNoteWithAssets({
      options: { content: '删除恢复附件' },
      images: [{ base64: attachmentBytes.toString('base64'), ext: 'png' }],
      tagIds: [restoredTag.id]
    })
    const attachmentPath = resolveImagePath(withAttachment.attachments[0].file_path)
    assert.equal(deleteNote(withAttachment.id), true)
    assert.equal(existsSync(attachmentPath), true)
    const restoredAttachment = restoreNote(withAttachment.id)
    assert.deepEqual(restoredAttachment.attachments, withAttachment.attachments)
    assert.deepEqual(restoredAttachment.tags, withAttachment.tags)
    assert.deepEqual(readFileSync(attachmentPath), attachmentBytes)

    // Validation occurs after file staging. An invalid completion must restore a
    // staged deletion and leave every saved field/attachment association intact.
    await assert.rejects(
      saveNoteDraft({
        ...draft(restoredAttachment, {
          content: '非法时间不能半写',
          status: 'completed',
          effectiveAt: precisePast,
          finishedAt: precisePast - 1,
          isPinned: true,
          durationDays: 8
        }),
        tagIds: [],
        addedImages: [{ base64: Buffer.from('new rejected image').toString('base64'), ext: 'png' }],
        deletedImageIds: [restoredAttachment.attachments[0].id]
      }),
      /完成时间不能早于生效时间/
    )
    const failedAttachmentDraft = getNoteById(restoredAttachment.id)
    assert.equal(failedAttachmentDraft.editVersion, restoredAttachment.editVersion)
    assert.equal(failedAttachmentDraft.content, restoredAttachment.content)
    assert.equal(failedAttachmentDraft.status, restoredAttachment.status)
    assert.equal(failedAttachmentDraft.is_pinned, restoredAttachment.is_pinned)
    assert.equal(failedAttachmentDraft.duration_days, restoredAttachment.duration_days)
    assert.deepEqual(failedAttachmentDraft.tags, restoredAttachment.tags)
    assert.deepEqual(failedAttachmentDraft.attachments, restoredAttachment.attachments)
    assert.deepEqual(readFileSync(attachmentPath), attachmentBytes)

    const nearSchedule = createNote({
      content: '临近到期正文编辑',
      effectiveAt: now + 600000,
      reminderChannels: 1
    })
    const nearTime = Date.now() + 60000
    db.prepare('UPDATE notes SET effective_at = ? WHERE id = ?').run(nearTime, nearSchedule.id)
    const nearSaved = await saveNoteDraft(
      draft(getNoteById(nearSchedule.id), { content: '不改变预约时间' })
    )
    assert.equal(nearSaved.effective_at, nearTime)
    assert.equal(nearSaved.status, 'initialized')
    assert.equal(nearSaved.reminder_channels, 1)
    db.prepare('UPDATE notes SET effective_at = ? WHERE id = ?').run(now - 1, nearSchedule.id)
    const overdueSaved = await saveNoteDraft(
      draft(getNoteById(nearSchedule.id), { status: 'initialized', content: '编辑期间已到期' })
    )
    assert.equal(overdueSaved.status, 'in_progress')
    assert.equal(overdueSaved.reminder_channels, 0)
    assert.equal(getPendingReminder(nearSchedule.id), null)

    const scheduled = createNote({
      content: '提前开始',
      effectiveAt: now + 600000,
      reminderChannels: 1
    })
    const early = startProgress(scheduled.id)
    assert.equal(early.status, 'in_progress')
    assert.ok(early.effective_at >= now)
    assert.equal(early.reminder_channels, 0)
    const complete = completeNote(early.id)
    assert.equal(complete.status, 'completed')
    assert.ok(complete.finished_at >= complete.effective_at)

    const reminderNote = createNote({ content: '改期取消旧轮次', effectiveAt: past })
    db.prepare('UPDATE notes SET reminder_channels = 1 WHERE id = ?').run(reminderNote.id)
    const oldRound = enqueueReminder(reminderNote.id, now - 1000)
    activateDueReminders(now)
    const rescheduled = await saveNoteDraft(
      draft(getNoteById(reminderNote.id), {
        status: 'initialized',
        effectiveAt: now + 600000,
        reminderChannels: 1
      })
    )
    assert.equal(rescheduled.status, 'initialized')
    assert.equal(rescheduled.reminder_channels, 1)
    assert.equal(rescheduled.notify_enabled, 1)
    assert.equal(getReminder(oldRound.id).state, 'cancelled')
    assert.equal(getPendingReminder(reminderNote.id), null)
    db.prepare('UPDATE notes SET effective_at = ? WHERE id = ?').run(now - 1, reminderNote.id)
    activateNotes()
    assert.equal(getNoteById(reminderNote.id).status, 'in_progress')
    assert.equal(getPendingReminder(reminderNote.id).due_at, now - 1)
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM note_reminders WHERE note_id = ? AND state IN ('scheduled', 'active')"
        )
        .get(reminderNote.id).n,
      1
    )

    const rollbackNote = createNote({ content: '事务原值', effectiveAt: past })
    db.prepare('UPDATE notes SET reminder_channels = 1 WHERE id = ?').run(rollbackNote.id)
    const rollbackRound = enqueueReminder(rollbackNote.id, now - 1000)
    activateDueReminders(now)
    const original = getNoteById(rollbackNote.id)
    db.exec(`CREATE TRIGGER reject_state_save BEFORE UPDATE ON notes
      WHEN NEW.content = '注入失败'
      BEGIN SELECT RAISE(ABORT, 'injected note update failure'); END;`)
    await assert.rejects(
      saveNoteDraft(
        draft(original, {
          content: '注入失败',
          status: 'initialized',
          effectiveAt: now + 600000,
          reminderChannels: 1
        })
      ),
      /injected/
    )
    assert.equal(getReminder(rollbackRound.id).state, 'active')
    assert.equal(getNoteById(original.id).editVersion, original.editVersion)
    db.exec('DROP TRIGGER reject_state_save')
    completeNote(original.id)
    await assert.rejects(saveNoteDraft(draft(original, { content: '旧草稿' })), /发生变化/)
    assert.equal(getNoteById(original.id).status, 'completed')

    const legacy = createNote({
      content: '旧完成记录',
      effectiveAt: past,
      status: 'completed',
      finishedAt: finished
    })
    db.prepare('UPDATE notes SET finished_at = NULL WHERE id = ?').run(legacy.id)
    const missingCompletion = getNoteById(legacy.id)
    await assert.rejects(
      saveNoteDraft(draft(missingCompletion, { content: '只修正文' })),
      /缺少完成时间/
    )
    assert.equal(getNoteById(legacy.id).finished_at, null)
    assert.equal(getNoteById(legacy.id).content, '旧完成记录')
    const repairStartedAt = Date.now()
    const repaired = await saveNoteDraft(draft(missingCompletion, { finishedAt: null }))
    assert.ok(repaired.finished_at >= repairStartedAt)
    assert.equal(repaired.effective_at, past)
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    clearDb()
    if (db?.open) {
      try {
        db.close()
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
