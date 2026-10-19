import Database from 'better-sqlite3'
import { app } from 'electron'
import { rm } from 'node:fs/promises'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import {
  createTemplate,
  deleteTemplate,
  getTemplateById,
  listTemplates,
  pauseTemplate,
  previewTemplateNextRun,
  purgeTemplate,
  recordTemplateFailure,
  restoreTemplate,
  resumeTemplate,
  updateTemplate
} from '../src/main/db/db-templates.js'
import { completeNote, deleteNote, getNoteById, updateNote } from '../src/main/db/db-notes.js'
import { createTag } from '../src/main/db/db-tags.js'
import {
  activateDueReminders,
  getPendingReminder,
  getReminder,
  snoozeReminder
} from '../src/main/db/db-reminders.js'
import { runRecurringTemplates } from '../src/main/services/recurrence.js'
import { buildRecurringNotePreviews } from '../src/main/calendar/recurring-note-preview.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/recurrence-lifecycle-db.mjs',
  mode: 'electron-ready-memory-sqlite-recurrence-lifecycle',
  metadata: {
    memoryDatabase: true,
    diskDatabase: false,
    fixedLocalDates: true,
    browserWindow: false
  }
})
const { assert } = recorder
const localTs = (day, hour = 9) => new Date(2025, 6, day, hour, 0, 0, 0).getTime()

app.once('ready', async () => {
  let profile
  let db
  let failure
  let completed = false
  let exitCode = 0
  const cleanupErrors = []
  try {
    profile = prepareTestProfile({ prefix: 'abandon-recurrence-lifecycle-db-' })
    app.setPath('userData', profile.directory)
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    createDatabaseSchema(db)
    setDb(db)

    // Historical and midnight boundaries used to be previewed with a different daily anchor.
    const intervalDraft = {
      content: '历史锚点',
      recurrenceRule: { frequency: 'daily', interval: 3, time_of_day: '09:00' },
      startAt: localTs(21, 0),
      endAt: localTs(31, 9)
    }
    const intervalPreview = previewTemplateNextRun(intervalDraft, localTs(22, 10))
    const intervalTemplate = createTemplate(intervalDraft, localTs(22, 10))
    assert.equal(intervalPreview, localTs(24, 9))
    assert.equal(intervalTemplate.next_run_at, intervalPreview)
    assert.equal(intervalTemplate.reminder_channels, 0)
    assert.equal(intervalTemplate.notify_enabled, 0)
    const midnightDraft = { ...intervalDraft, startAt: localTs(27, 0) }
    const midnightPreview = previewTemplateNextRun(midnightDraft, localTs(22, 10))
    assert.equal(midnightPreview, localTs(27, 9))
    assert.equal(createTemplate(midnightDraft, localTs(22, 10)).next_run_at, midnightPreview)
    const renamed = updateTemplate(intervalTemplate.id, { content: '修改内容' }, localTs(25, 10))
    assert.equal(renamed.next_run_at, intervalPreview)
    assert.equal(renamed.schedule_anchor_at, intervalTemplate.schedule_anchor_at)
    assert.equal(
      previewTemplateNextRun({ ...intervalDraft, templateId: renamed.id }, localTs(25, 10)),
      intervalPreview
    )
    const changedDraft = {
      ...intervalDraft,
      templateId: renamed.id,
      recurrenceRule: { ...intervalDraft.recurrenceRule, interval: 2 }
    }
    const changedPreview = previewTemplateNextRun(changedDraft, localTs(25, 10))
    assert.equal(
      updateTemplate(renamed.id, changedDraft, localTs(25, 10)).next_run_at,
      changedPreview
    )
    pauseTemplate(renamed.id, localTs(25, 11))
    assert.equal(previewTemplateNextRun(changedDraft, localTs(25, 11)), changedPreview)
    const pausedSave = updateTemplate(renamed.id, { content: '保持暂停' }, localTs(25, 11))
    assert.equal(pausedSave.is_paused, 1)
    assert.equal(pausedSave.next_run_at, null)
    assert.throws(
      () => previewTemplateNextRun({ ...intervalDraft, endAt: localTs(22, 9) }, localTs(22, 10)),
      /没有可生成节点/
    )
    assert.throws(
      () =>
        previewTemplateNextRun({ ...intervalDraft, endAt: intervalDraft.startAt }, localTs(22, 10)),
      /必须晚于/
    )

    // Keep later fixtures independent of the scheduling-only templates above.
    db.prepare('UPDATE note_templates SET is_paused = 1, next_run_at = NULL').run()
    const template = createTemplate(
      {
        content: '各期独立',
        reminderChannels: 6,
        recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
      },
      localTs(21, 8)
    )
    assert.equal(runRecurringTemplates({ now: localTs(21, 10) }).count, 1)
    const first = getNoteById(getTemplateById(template.id).last_generated_note_id)
    assert.equal(first.status, 'in_progress')
    assert.equal(first.duration_kind, 'single_day')
    assert.equal(first.duration_days, 1)
    const round = activateDueReminders(localTs(21, 10)).find((item) => item.note_id === first.id)
    const snoozed = snoozeReminder(round.id, localTs(23, 15), localTs(21, 10)).reminder
    const beforeNext = getNoteById(first.id)
    updateTemplate(template.id, { content: '新一期内容', reminderChannels: 0 }, localTs(21, 11))
    assert.equal(runRecurringTemplates({ now: localTs(22, 10) }).count, 1)
    const retained = getNoteById(first.id)
    assert.equal(retained.is_deleted, 0)
    assert.equal(retained.status, 'in_progress')
    assert.equal(retained.effective_at, beforeNext.effective_at)
    assert.equal(retained.updated_at, beforeNext.updated_at)
    assert.equal(retained.reminder_channels, 6)
    assert.equal(retained.content, '各期独立')
    assert.equal(getPendingReminder(first.id).id, snoozed.id)
    assert.equal(getReminder(snoozed.id).state, 'scheduled')
    const secondId = getTemplateById(template.id).last_generated_note_id
    assert.equal(getNoteById(secondId).content, '新一期内容')
    assert.equal(getNoteById(secondId).reminder_channels, 0)
    assert.equal(getPendingReminder(secondId), null)
    completeNote(secondId)
    const completedSecond = getNoteById(secondId)
    assert.equal(runRecurringTemplates({ now: localTs(23, 10) }).count, 1)
    assert.equal(getNoteById(secondId).status, 'completed')
    assert.equal(getNoteById(secondId).is_deleted, 0)
    assert.deepEqual(getNoteById(secondId), completedSecond)
    assert.equal(runRecurringTemplates({ now: localTs(23, 10) }).count, 0)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM notes WHERE is_deleted = 0').get().count,
      3
    )
    const previews = buildRecurringNotePreviews({
      rangeStart: '2025-07-21',
      rangeEnd: '2025-07-24',
      now: localTs(23, 10)
    })
    assert.deepEqual(
      previews.items.map((item) => item.effective_at),
      [localTs(24, 9)]
    )
    assert.equal(previews.items[0].duration_kind, 'single_day')
    deleteNote(first.id)
    assert.equal(runRecurringTemplates({ now: localTs(24, 10) }).count, 1)
    assert.equal(
      db.prepare('SELECT is_deleted FROM notes WHERE id = ?').get(first.id).is_deleted,
      1
    )

    // A failed cursor update rolls back the new instance and its reminder, keeping prior records.
    const rollbackTemplate = createTemplate(
      {
        content: 'rollback',
        reminderChannels: 6,
        recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
      },
      localTs(25, 8)
    )
    db.prepare('UPDATE note_templates SET is_paused = 1 WHERE id != ?').run(rollbackTemplate.id)
    db.exec(`CREATE TRIGGER fail_recurrence_cursor BEFORE UPDATE OF last_generated_note_id ON note_templates
      WHEN NEW.id = ${rollbackTemplate.id} BEGIN SELECT RAISE(ABORT, 'injected cursor failure'); END;`)
    const noteCount = db.prepare('SELECT COUNT(*) AS count FROM notes').get().count
    const reminderCount = db.prepare('SELECT COUNT(*) AS count FROM note_reminders').get().count
    const failedRun = runRecurringTemplates({ now: localTs(25, 10) })
    assert.equal(failedRun.count, 0)
    assert.equal(failedRun.errors.length, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, noteCount)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM note_reminders').get().count,
      reminderCount
    )
    assert.equal(getTemplateById(rollbackTemplate.id).last_generated_note_id, null)
    db.exec('DROP TRIGGER fail_recurrence_cursor')
    assert.equal(runRecurringTemplates({ now: localTs(25, 10) }).count, 1)

    // Each following scenario owns the only running template; all dates are injected.
    const isolate = () =>
      db.prepare('UPDATE note_templates SET is_paused = 1, next_run_at = NULL').run()
    const noteRows = () => db.prepare('SELECT * FROM notes ORDER BY id').all()
    const reminderRows = () => db.prepare('SELECT * FROM note_reminders ORDER BY id').all()
    const dailyRule = { frequency: 'daily', interval: 1, time_of_day: '09:00' }

    // Opening at the configured minute does not add an immediate extra occurrence.
    isolate()
    const sameMinute = createTemplate(
      { content: '不额外立即生成', recurrenceRule: dailyRule },
      localTs(25, 9)
    )
    assert.equal(sameMinute.next_run_at, localTs(26, 9))
    assert.equal(runRecurringTemplates({ now: localTs(25, 9) }).count, 0)

    // Start/end boundaries both include the exact recurrence node, then end automatically.
    isolate()
    const bounded = createTemplate(
      {
        content: '有效期边界',
        recurrenceRule: dailyRule,
        startAt: localTs(26, 9),
        endAt: localTs(27, 9)
      },
      localTs(25, 8)
    )
    assert.equal(bounded.next_run_at, localTs(26, 9))
    assert.equal(runRecurringTemplates({ now: localTs(26, 9) - 1 }).count, 0)
    assert.equal(runRecurringTemplates({ now: localTs(26, 9) }).count, 1)
    assert.equal(
      getNoteById(getTemplateById(bounded.id).last_generated_note_id).effective_at,
      localTs(26, 9)
    )
    assert.equal(runRecurringTemplates({ now: localTs(27, 9) }).count, 1)
    const ended = getTemplateById(bounded.id)
    assert.equal(getNoteById(ended.last_generated_note_id).effective_at, localTs(27, 9))
    assert.equal(ended.is_paused, 1)
    assert.equal(ended.pause_reason, null)
    assert.equal(ended.next_run_at, null)
    assert.equal(runRecurringTemplates({ now: localTs(28, 10) }).count, 0)
    assert.throws(() => resumeTemplate(bounded.id, localTs(28, 8)), /结束时间已到/)
    const endedRename = updateTemplate(bounded.id, { content: '只改正文仍结束' }, localTs(28, 8))
    assert.equal(endedRename.is_paused, 1)
    assert.equal(endedRename.next_run_at, null)
    const extended = updateTemplate(bounded.id, { endAt: localTs(29, 9) }, localTs(28, 8))
    assert.equal(extended.is_paused, 0)
    assert.equal(extended.next_run_at, localTs(28, 9))
    pauseTemplate(bounded.id, localTs(28, 8))
    const manualExtended = updateTemplate(bounded.id, { endAt: localTs(30, 9) }, localTs(28, 8))
    assert.equal(manualExtended.is_paused, 1)
    assert.equal(manualExtended.pause_reason, 'manual')
    assert.equal(manualExtended.next_run_at, null)

    // Resume retains the original interval anchor and skips every paused occurrence.
    isolate()
    const anchored = createTemplate(
      { content: '暂停恢复原锚点', recurrenceRule: { ...dailyRule, interval: 3 } },
      localTs(21, 8)
    )
    pauseTemplate(anchored.id, localTs(21, 8))
    assert.equal(runRecurringTemplates({ now: localTs(25, 10) }).count, 0)
    const resumed = resumeTemplate(anchored.id, localTs(25, 10))
    assert.equal(resumed.schedule_anchor_at, anchored.schedule_anchor_at)
    assert.equal(resumed.start_at, anchored.start_at)
    assert.equal(resumed.next_run_at, localTs(27, 9))
    assert.equal(resumed.pause_reason, null)
    assert.equal(runRecurringTemplates({ now: localTs(25, 10) }).count, 0)
    assert.equal(runRecurringTemplates({ now: localTs(27, 9) }).count, 1)
    assert.equal(
      getNoteById(getTemplateById(anchored.id).last_generated_note_id).effective_at,
      localTs(27, 9)
    )

    // A multi-day outage compensates only today's due node, once, without historical batches.
    isolate()
    const recovery = createTemplate(
      { content: '多天停运只补今天', recurrenceRule: dailyRule, reminderChannels: 6 },
      localTs(21, 8)
    )
    const recoveryNotesBefore = noteRows().length
    const recoveryRemindersBefore = reminderRows().length
    const recovered = runRecurringTemplates({ now: localTs(25, 10), reason: 'startup' })
    assert.equal(recovered.count, 1)
    assert.equal(recovered.skipped, 0)
    assert.equal(noteRows().length, recoveryNotesBefore + 1)
    assert.equal(reminderRows().length, recoveryRemindersBefore + 1)
    const recoveredTemplate = getTemplateById(recovery.id)
    const recoveredNote = getNoteById(recoveredTemplate.last_generated_note_id)
    assert.equal(recoveredNote.effective_at, localTs(25, 9))
    assert.equal(recoveredNote.status, 'in_progress')
    assert.equal(recoveredTemplate.last_generated_at, localTs(25, 9))
    assert.equal(recoveredTemplate.next_run_at, localTs(26, 9))
    assert.equal(getPendingReminder(recoveredNote.id).due_at, localTs(25, 9))
    assert.equal(runRecurringTemplates({ now: localTs(25, 10), reason: 'startup' }).count, 0)
    assert.equal(noteRows().length, recoveryNotesBefore + 1)

    isolate()
    const beforeToday = createTemplate(
      { content: '今天未到时先跳过历史', recurrenceRule: dailyRule },
      localTs(21, 8)
    )
    const beforeTodayCount = noteRows().length
    const skippedBeforeDue = runRecurringTemplates({ now: localTs(25, 8), reason: 'recovery' })
    assert.equal(skippedBeforeDue.count, 0)
    assert.equal(skippedBeforeDue.skipped, 1)
    assert.equal(noteRows().length, beforeTodayCount)
    assert.equal(getTemplateById(beforeToday.id).next_run_at, localTs(25, 9))
    assert.equal(runRecurringTemplates({ now: localTs(25, 9) }).count, 1)

    isolate()
    const offDay = createTemplate(
      { content: '今天不是间隔节点', recurrenceRule: { ...dailyRule, interval: 3 } },
      localTs(21, 8)
    )
    const offDayCount = noteRows().length
    const skippedOffDay = runRecurringTemplates({ now: localTs(25, 10) })
    assert.equal(skippedOffDay.count, 0)
    assert.equal(skippedOffDay.skipped, 1)
    assert.equal(noteRows().length, offDayCount)
    assert.equal(getTemplateById(offDay.id).next_run_at, localTs(27, 9))

    isolate()
    const expiredBacklog = createTemplate(
      { content: '停运期间已结束', recurrenceRule: dailyRule, endAt: localTs(24, 9) },
      localTs(21, 8)
    )
    const expiredCount = noteRows().length
    const expiredRecovery = runRecurringTemplates({ now: localTs(25, 10) })
    assert.equal(expiredRecovery.count, 0)
    assert.equal(expiredRecovery.skipped, 1)
    assert.equal(noteRows().length, expiredCount)
    assert.equal(getTemplateById(expiredBacklog.id).is_paused, 1)
    assert.equal(getTemplateById(expiredBacklog.id).next_run_at, null)

    // Template changes affect future snapshots; ordinary instance edits never mutate the template.
    isolate()
    const firstTag = createTag('循环实例原标签', '#34c759')
    const nextTag = createTag('循环实例后标签', '#007aff')
    const snapshots = createTemplate(
      {
        content: '模板快照A',
        recurrenceRule: dailyRule,
        isPinned: true,
        reminderChannels: 6,
        tagIds: [firstTag.id]
      },
      localTs(21, 8)
    )
    assert.equal(runRecurringTemplates({ now: localTs(21, 9) }).count, 1)
    const snapshotA = getNoteById(getTemplateById(snapshots.id).last_generated_note_id)
    const beforeSnapshotEdit = getNoteById(snapshotA.id)
    const snapshotAReminder = getPendingReminder(snapshotA.id)
    const templateB = updateTemplate(
      snapshots.id,
      {
        content: '模板快照B',
        recurrenceRule: { ...dailyRule, time_of_day: '10:00' },
        isPinned: false,
        reminderChannels: 0,
        tagIds: [nextTag.id]
      },
      localTs(21, 9)
    )
    assert.equal(templateB.next_run_at, localTs(21, 10))
    assert.deepEqual(getNoteById(snapshotA.id), beforeSnapshotEdit)
    assert.deepEqual(getPendingReminder(snapshotA.id), snapshotAReminder)
    assert.equal(runRecurringTemplates({ now: localTs(21, 10) }).count, 1)
    const snapshotB = getNoteById(getTemplateById(snapshots.id).last_generated_note_id)
    assert.equal(snapshotB.content, '模板快照B')
    assert.equal(snapshotB.is_pinned, 0)
    assert.equal(snapshotB.reminder_channels, 0)
    assert.deepEqual(
      snapshotB.tags.map((tag) => tag.id),
      [nextTag.id]
    )
    assert.deepEqual(
      snapshotA.tags.map((tag) => tag.id),
      [firstTag.id]
    )
    assert.equal(snapshotA.is_pinned, 1)
    const templateBeforeInstanceEdit = getTemplateById(snapshots.id)
    updateNote(snapshotA.id, { content: '实例自行修改', durationKind: 'until_completed' })
    assert.equal(getNoteById(snapshotA.id).content, '实例自行修改')
    assert.equal(getNoteById(snapshotA.id).duration_kind, 'until_completed')
    assert.deepEqual(getTemplateById(snapshots.id), templateBeforeInstanceEdit)
    assert.deepEqual(getNoteById(snapshotB.id), snapshotB)

    // Logical deletion, restore and purge preserve every generated note and reminder.
    const notesBeforeDelete = noteRows()
    const remindersBeforeDelete = reminderRows()
    assert.equal(purgeTemplate(snapshots.id), false)
    assert.equal(deleteTemplate(snapshots.id, localTs(21, 11)), true)
    assert.equal(getTemplateById(snapshots.id), null)
    assert.equal(getTemplateById(snapshots.id, { includeDeleted: true }).is_deleted, 1)
    assert.equal(
      listTemplates({ state: 'deleted' }).some((row) => row.id === snapshots.id),
      true
    )
    assert.equal(
      listTemplates({ state: 'active' }).some((row) => row.id === snapshots.id),
      false
    )
    assert.equal(runRecurringTemplates({ now: localTs(22, 11) }).count, 0)
    assert.deepEqual(noteRows(), notesBeforeDelete)
    assert.deepEqual(reminderRows(), remindersBeforeDelete)
    assert.throws(() => updateTemplate(snapshots.id, { content: '已删除不能修改' }), /已删除/)
    const restored = restoreTemplate(snapshots.id, localTs(22, 11))
    assert.equal(restored.is_deleted, 0)
    assert.equal(restored.is_paused, 0)
    assert.equal(restored.next_run_at, localTs(23, 10))
    assert.equal(restored.schedule_anchor_at, templateBeforeInstanceEdit.schedule_anchor_at)
    assert.deepEqual(
      restored.tags.map((tag) => tag.id),
      [nextTag.id]
    )
    assert.deepEqual(noteRows(), notesBeforeDelete)
    assert.deepEqual(reminderRows(), remindersBeforeDelete)
    assert.equal(deleteTemplate(snapshots.id, localTs(22, 12)), true)
    assert.equal(purgeTemplate(snapshots.id), true)
    assert.equal(getTemplateById(snapshots.id, { includeDeleted: true }), null)
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM template_tags WHERE template_id = ?')
        .get(snapshots.id).count,
      0
    )
    assert.deepEqual(noteRows(), notesBeforeDelete)
    assert.deepEqual(reminderRows(), remindersBeforeDelete)
    assert.equal(purgeTemplate(snapshots.id), false)
    assert.throws(() => restoreTemplate(snapshots.id, localTs(23, 8)), /不存在/)

    // Restoring an expired deleted template stays ended; restoring a paused one runs at a future node.
    assert.equal(deleteTemplate(expiredBacklog.id, localTs(25, 11)), true)
    const restoredExpired = restoreTemplate(expiredBacklog.id, localTs(25, 11))
    assert.equal(restoredExpired.is_paused, 1)
    assert.equal(restoredExpired.next_run_at, null)
    assert.equal(restoredExpired.pause_reason, null)
    assert.equal(deleteTemplate(anchored.id, localTs(28, 11)), true)
    const restoredAnchored = restoreTemplate(anchored.id, localTs(28, 11))
    assert.equal(restoredAnchored.is_paused, 0)
    assert.equal(restoredAnchored.next_run_at, localTs(30, 9))
    assert.equal(restoredAnchored.schedule_anchor_at, anchored.schedule_anchor_at)

    // Error pauses stay paused when edited and explicitly clear their failure state on resume.
    isolate()
    const errors = createTemplate(
      { content: '错误暂停', recurrenceRule: dailyRule },
      localTs(21, 8)
    )
    assert.equal(
      recordTemplateFailure(errors.id, new Error('可恢复故障'), localTs(21, 9)).autoPaused,
      false
    )
    assert.equal(
      recordTemplateFailure(errors.id, new Error('可恢复故障'), localTs(21, 9)).autoPaused,
      false
    )
    assert.equal(
      recordTemplateFailure(errors.id, new Error('可恢复故障'), localTs(21, 9)).autoPaused,
      true
    )
    const errorEdited = updateTemplate(
      errors.id,
      { content: '已编辑但仍暂停', endAt: localTs(29, 9) },
      localTs(22, 10)
    )
    assert.equal(errorEdited.is_paused, 1)
    assert.equal(errorEdited.pause_reason, 'error')
    assert.equal(errorEdited.consecutive_failures, 3)
    const errorResumed = resumeTemplate(errors.id, localTs(22, 10))
    assert.equal(errorResumed.next_run_at, localTs(23, 9))
    assert.equal(errorResumed.consecutive_failures, 0)
    assert.equal(errorResumed.last_error, null)
    assert.equal(errorResumed.pause_reason, null)
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    clearDb()
    if (db?.open) db.close()
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
