import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { DATABASE_SCHEMA_VERSION, createDatabaseSchema } from '../src/main/db/db-schema.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createTag, deleteTag, getTagUsage } from '../src/main/db/db-tags.js'
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
} from '../src/main/db/db-templates.js'
import { normalizeRequiredNoteContent } from '../src/main/db/db-notes.js'
import { runRecurringTemplates } from '../src/main/services/recurrence.js'

function localTs(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

const futureDb = new Database(':memory:')
futureDb.pragma(`user_version = ${DATABASE_SCHEMA_VERSION + 1}`)
assert.throws(() => createDatabaseSchema(futureDb), /高于当前程序支持的版本/)
assert.equal(futureDb.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION + 1)
assert.equal(
  futureDb
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
    .get().count,
  0
)
futureDb.close()

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
createDatabaseSchema(db)
setDb(db)
const originalConsoleError = console.error

try {
  assert.equal(db.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
  assert.deepEqual(
    db
      .prepare("PRAGMA table_info('app_settings')")
      .all()
      .map((column) => column.name),
    ['window_name', 'type', 'key', 'value', 'remark', 'created_at', 'updated_at']
  )
  const noteColumns = db
    .prepare("PRAGMA table_info('notes')")
    .all()
    .map((column) => column.name)
  assert.equal(noteColumns.includes('template_id'), false)
  assert.deepEqual(
    db
      .prepare("PRAGMA table_info('wallpaper_sources')")
      .all()
      .map((column) => column.name),
    [
      'id',
      'content_hash',
      'original_path',
      'mime_type',
      'width',
      'height',
      'file_size',
      'created_at'
    ]
  )
  assert.equal(
    db
      .prepare("PRAGMA table_info('wallpapers')")
      .all()
      .some((column) => column.name === 'cropped_path'),
    true
  )
  assert.equal(normalizeRequiredNoteContent('  保留首尾空白\n'), '  保留首尾空白\n')
  assert.throws(() => normalizeRequiredNoteContent(' \n\t '), /请输入便签内容/)

  createTag('日常', '#007aff')
  createTag('重要', '#ff3b30')

  const missedAnchor = localTs(2025, 7, 20, 8)
  const missedTemplate = createTemplate(
    {
      content: '错过节点不补偿',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      tagNames: ['日常']
    },
    missedAnchor
  )
  const startup = runRecurringTemplates({ now: localTs(2025, 7, 20, 10), reason: 'startup' })
  assert.equal(startup.count, 0)
  assert.equal(startup.skipped, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0)
  assert.equal(getTemplateById(missedTemplate.id).next_run_at, localTs(2025, 7, 21, 9))

  const activeAnchor = localTs(2025, 7, 20, 8)
  const activeTemplate = createTemplate(
    {
      content: '生成快照',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' },
      isPinned: true,
      notifyEnabled: true,
      tagNames: ['日常', '重要']
    },
    activeAnchor
  )
  const firstRun = runRecurringTemplates({
    now: localTs(2025, 7, 20, 9, 0, 30),
    reason: 'scheduled'
  })
  assert.equal(firstRun.count, 1)
  assert.equal(firstRun.generated.length, 1)
  assert.deepEqual(firstRun.generated[0], { content: '生成快照' })

  const firstNote = db.prepare('SELECT * FROM notes WHERE is_deleted = 0').get()
  assert.equal(firstNote.status, 'in_progress')
  assert.equal(firstNote.is_pinned, 1)
  assert.equal(firstNote.notify_enabled, 0)
  assert.deepEqual(
    db
      .prepare('SELECT tag_name FROM note_tags WHERE note_id = ? ORDER BY tag_name')
      .all(firstNote.id),
    [{ tag_name: '日常' }, { tag_name: '重要' }]
  )

  assert.deepEqual(getTagUsage('日常'), {
    noteCount: 1,
    activeNoteCount: 1,
    deletedNoteCount: 0,
    templateCount: 2,
    runningTemplateCount: 2,
    pausedTemplateCount: 0,
    deletedTemplateCount: 0
  })
  assert.deepEqual(getTagUsage('重要'), {
    noteCount: 1,
    activeNoteCount: 1,
    deletedNoteCount: 0,
    templateCount: 1,
    runningTemplateCount: 1,
    pausedTemplateCount: 0,
    deletedTemplateCount: 0
  })

  db.prepare('UPDATE notes SET is_deleted = 1 WHERE id = ?').run(firstNote.id)
  db.prepare('UPDATE note_templates SET is_paused = 1 WHERE id = ?').run(missedTemplate.id)
  db.prepare('UPDATE note_templates SET is_deleted = 1, is_paused = 1 WHERE id = ?').run(
    activeTemplate.id
  )
  assert.deepEqual(getTagUsage('日常'), {
    noteCount: 1,
    activeNoteCount: 0,
    deletedNoteCount: 1,
    templateCount: 2,
    runningTemplateCount: 0,
    pausedTemplateCount: 1,
    deletedTemplateCount: 1
  })
  db.prepare('UPDATE notes SET is_deleted = 0 WHERE id = ?').run(firstNote.id)
  db.prepare('UPDATE note_templates SET is_paused = 0 WHERE id = ?').run(missedTemplate.id)
  db.prepare('UPDATE note_templates SET is_deleted = 0, is_paused = 0 WHERE id = ?').run(
    activeTemplate.id
  )

  const secondDue = getTemplateById(activeTemplate.id).next_run_at
  const secondRun = runRecurringTemplates({ now: secondDue + 20_000, reason: 'scheduled' })
  assert.equal(secondRun.count, 2)
  assert.equal(
    db.prepare('SELECT is_deleted FROM notes WHERE id = ?').get(firstNote.id).is_deleted,
    1
  )
  const secondNoteId = getTemplateById(activeTemplate.id).last_generated_note_id
  db.prepare("UPDATE notes SET status = 'completed' WHERE id = ?").run(secondNoteId)

  const thirdDue = getTemplateById(activeTemplate.id).next_run_at
  const thirdRun = runRecurringTemplates({ now: thirdDue + 20_000, reason: 'scheduled' })
  assert.equal(thirdRun.count, 2)
  assert.equal(
    db.prepare('SELECT is_deleted FROM notes WHERE id = ?').get(secondNoteId).is_deleted,
    0
  )

  const pauseAt = localTs(2025, 7, 23, 12)
  pauseTemplate(activeTemplate.id, pauseAt)
  assert.equal(getTemplateById(activeTemplate.id).next_run_at, null)
  const resumeAt = localTs(2025, 7, 25, 10)
  const resumed = resumeTemplate(activeTemplate.id, resumeAt)
  assert.equal(resumed.is_paused, 0)
  assert.equal(resumed.next_run_at, localTs(2025, 7, 26, 9))

  deleteTemplate(activeTemplate.id, localTs(2025, 7, 25, 11))
  assert.equal(getTemplateById(activeTemplate.id), null)
  const restored = restoreTemplate(activeTemplate.id, localTs(2025, 7, 27, 10))
  assert.equal(restored.is_deleted, 0)
  assert.equal(restored.is_paused, 0)
  assert.equal(restored.next_run_at, localTs(2025, 7, 28, 9))

  const intervalTemplate = createTemplate(
    {
      content: '保留三天循环节奏',
      recurrenceRule: { frequency: 'daily', interval: 3, time_of_day: '09:00' }
    },
    localTs(2025, 7, 20, 8)
  )
  pauseTemplate(intervalTemplate.id, localTs(2025, 7, 21, 12))
  const intervalResumed = resumeTemplate(intervalTemplate.id, localTs(2025, 7, 22, 10))
  assert.equal(intervalResumed.schedule_anchor_at, localTs(2025, 7, 20, 8))
  assert.equal(intervalResumed.next_run_at, localTs(2025, 7, 23, 9))
  deleteTemplate(intervalTemplate.id, localTs(2025, 7, 22, 11))
  const intervalRestored = restoreTemplate(intervalTemplate.id, localTs(2025, 7, 24, 10))
  assert.equal(intervalRestored.schedule_anchor_at, localTs(2025, 7, 20, 8))
  assert.equal(intervalRestored.next_run_at, localTs(2025, 7, 26, 9))

  const unchangedSchedule = updateTemplate(
    missedTemplate.id,
    {
      content: '只修改正文不重排时间',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
    },
    localTs(2025, 7, 22, 12)
  )
  assert.equal(unchangedSchedule.schedule_anchor_at, missedAnchor)
  assert.equal(unchangedSchedule.next_run_at, localTs(2025, 7, 23, 9))

  const failingTemplate = createTemplate(
    {
      content: '连续失败后暂停',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
    },
    localTs(2025, 8, 1, 8)
  )
  db.prepare("UPDATE note_templates SET recurrence_rule = '{bad json' WHERE id = ?").run(
    failingTemplate.id
  )
  console.error = () => {}
  const failingDue = localTs(2025, 8, 1, 9)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const failureResult = runRecurringTemplates({
      now: failingDue + attempt * 10_000,
      reason: 'scheduled'
    })
    const failedRow = getTemplateById(failingTemplate.id, { includeDeleted: true })
    assert.equal(
      failureResult.errors.some((item) => item.templateId === failingTemplate.id),
      true
    )
    assert.equal(failedRow.consecutive_failures, attempt)
    if (attempt < 3) {
      assert.equal(failedRow.is_paused, 0)
      assert.equal(failureResult.autoPaused.length, 0)
    } else {
      assert.equal(failedRow.is_paused, 1)
      assert.equal(failedRow.pause_reason, 'error')
      assert.equal(failedRow.next_run_at, null)
      assert.equal(failureResult.autoPaused[0].id, failingTemplate.id)
    }
  }

  const failedBeforeEdit = getTemplateById(failingTemplate.id, { includeDeleted: true })
  updateTemplate(failingTemplate.id, {
    content: '修改正文但保留错误状态',
    recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
  })
  const failedAfterEdit = getTemplateById(failingTemplate.id, { includeDeleted: true })
  assert.equal(failedAfterEdit.is_paused, 1)
  assert.equal(failedAfterEdit.pause_reason, 'error')
  assert.equal(failedAfterEdit.consecutive_failures, failedBeforeEdit.consecutive_failures)
  assert.equal(failedAfterEdit.last_error, failedBeforeEdit.last_error)

  const listedTemplates = listTemplates({ state: 'all' })
  const listedActive = listedTemplates.find((template) => template.id === activeTemplate.id)
  assert.deepEqual(listedActive.tags.map((tag) => tag.name).sort(), ['日常', '重要'])

  const commitFailureTemplate = createTemplate(
    {
      content: '提交失败不通知',
      recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: '09:00' }
    },
    localTs(2025, 8, 2, 8)
  )
  // 隔离本用例，避免其他正常模板在同一时间节点生成便签并进入结果计数。
  pauseTemplate(missedTemplate.id, localTs(2025, 8, 2, 8, 30))
  pauseTemplate(activeTemplate.id, localTs(2025, 8, 2, 8, 30))
  pauseTemplate(intervalTemplate.id, localTs(2025, 8, 2, 8, 30))
  db.pragma('foreign_keys = OFF')
  db.prepare('INSERT INTO template_tags (template_id, tag_name) VALUES (?, ?)').run(
    commitFailureTemplate.id,
    '不存在的标签'
  )
  db.pragma('foreign_keys = ON')
  db.pragma('defer_foreign_keys = ON')
  const commitFailure = runRecurringTemplates({
    now: localTs(2025, 8, 2, 9, 0, 10),
    reason: 'scheduled'
  })
  assert.equal(commitFailure.count, 0)
  assert.equal(commitFailure.generated.length, 0)
  assert.equal(
    commitFailure.errors.some((item) => item.templateId === commitFailureTemplate.id),
    true
  )
  db.prepare('DELETE FROM template_tags WHERE template_id = ? AND tag_name = ?').run(
    commitFailureTemplate.id,
    '不存在的标签'
  )

  const lastNoteId = restored.last_generated_note_id
  assert.equal(db.prepare('DELETE FROM notes WHERE id = ?').run(lastNoteId).changes, 1)
  assert.equal(getTemplateById(activeTemplate.id).last_generated_note_id, null)

  deleteTemplate(activeTemplate.id, localTs(2025, 7, 27, 11))
  const noteCountBeforePurge = db.prepare('SELECT COUNT(*) AS count FROM notes').get().count
  assert.equal(purgeTemplate(activeTemplate.id), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, noteCountBeforePurge)

  const usageBeforeDelete = getTagUsage('日常')
  assert.equal(usageBeforeDelete.templateCount, 1)
  assert.equal(deleteTag('日常'), true)
  assert.deepEqual(getTagUsage('日常'), {
    noteCount: 0,
    activeNoteCount: 0,
    deletedNoteCount: 0,
    templateCount: 0,
    runningTemplateCount: 0,
    pausedTemplateCount: 0,
    deletedTemplateCount: 0
  })

  console.log('backend integration tests passed')
} finally {
  console.error = originalConsoleError
  clearDb()
  db.close()
}
