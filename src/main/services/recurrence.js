/** 循环模板生成编排：错过节点不补偿，实例按快照独立创建。 */
import { getDueTemplates, recordTemplateFailure } from '../db/db-templates.js'
import { createRecurringNoteSnapshot, deleteNote } from '../db/db-notes.js'
import { getDb } from '../db/db-connection.js'
import { calculateNextRun, normalizeRecurrenceRule } from './recurrence-rules.js'

export { calculateNextRun, normalizeRecurrenceRule } from './recurrence-rules.js'

/** 正常整分调度允许的最大延迟；超过后视为应用离线、休眠或调度恢复，只推进节点。 */
export const SCHEDULE_GRACE_MS = 90_000

function advanceWithoutGenerating(db, template, rule, timestamp) {
  const nextRunAt = calculateNextRun(rule, timestamp, template.schedule_anchor_at)
  db.prepare(
    `UPDATE note_templates SET
       next_run_at = ?, consecutive_failures = 0, last_error = NULL,
       last_failed_at = NULL, updated_at = ?
     WHERE id = ? AND is_deleted = 0 AND is_paused = 0`
  ).run(nextRunAt, timestamp, template.id)
  return nextRunAt
}

/**
 * @param {{now?: number, reason?: 'startup'|'scheduled'|'recovery'|'resume'}} context
 * @returns {{count:number, skipped:number, generated:Array, autoPaused:Array, errors:Array}}
 */
export function runRecurringTemplates({ now = Date.now(), reason = 'scheduled' } = {}) {
  const timestamp = Number(now)
  if (!Number.isFinite(timestamp)) throw new Error('调度时间无效')
  // 查询整体失败属于调度服务错误，必须抛给上层的全局失败保护器。
  const templates = getDueTemplates(timestamp)
  const result = { count: 0, skipped: 0, generated: [], autoPaused: [], errors: [] }
  if (templates.length === 0) return result

  const db = getDb()
  for (const summary of templates) {
    try {
      const outcome = db.transaction(() => {
        const template = db
          .prepare(
            `SELECT * FROM note_templates
             WHERE id = ? AND is_deleted = 0 AND is_paused = 0`
          )
          .get(summary.id)
        if (!template) return null

        const rule = normalizeRecurrenceRule(template.recurrence_rule)
        if (template.next_run_at === null || template.next_run_at === undefined) {
          advanceWithoutGenerating(db, template, rule, timestamp)
          return { type: 'skipped' }
        }

        const scheduledAt = Number(template.next_run_at)
        if (!Number.isFinite(scheduledAt)) throw new Error('模板 next_run_at 无效')
        if (scheduledAt > timestamp) return null

        const missed = reason !== 'scheduled' || timestamp - scheduledAt > SCHEDULE_GRACE_MS
        if (missed) {
          advanceWithoutGenerating(db, template, rule, timestamp)
          return { type: 'skipped' }
        }

        if (template.last_generated_note_id) {
          const previous = db
            .prepare('SELECT id, status, is_deleted FROM notes WHERE id = ?')
            .get(template.last_generated_note_id)
          if (previous && !previous.is_deleted && previous.status !== 'completed')
            deleteNote(previous.id)
        }

        const tagNames = db
          .prepare('SELECT tag_name FROM template_tags WHERE template_id = ? ORDER BY rowid')
          .all(template.id)
          .map((row) => row.tag_name)
        const note = createRecurringNoteSnapshot({
          content: template.content,
          effectiveAt: scheduledAt,
          isPinned: template.is_pinned,
          tagNames
        })
        const nextRunAt = calculateNextRun(rule, scheduledAt, template.schedule_anchor_at)

        db.prepare(
          `UPDATE note_templates SET
             last_generated_note_id = ?, last_generated_at = ?, next_run_at = ?,
             consecutive_failures = 0, last_error = NULL, last_failed_at = NULL,
             updated_at = ?
           WHERE id = ? AND is_deleted = 0 AND is_paused = 0`
        ).run(note.id, scheduledAt, nextRunAt, timestamp, template.id)

        return {
          type: 'generated',
          notification: template.notify_enabled ? { content: note.content || '' } : null
        }
      })()

      // 只有 transaction() 完整提交后，才修改不可回滚的 JS 结果和通知队列。
      if (outcome?.type === 'skipped') result.skipped += 1
      if (outcome?.type === 'generated') {
        result.count += 1
        if (outcome.notification) result.generated.push(outcome.notification)
      }
    } catch (error) {
      try {
        const failure = recordTemplateFailure(summary.id, error, timestamp)
        result.errors.push({
          templateId: summary.id,
          message: error.message,
          failures: failure?.failures ?? null
        })
        if (failure?.autoPaused) result.autoPaused.push(failure)
        console.error(`[recurrence] 模板 ${summary.id} 处理失败:`, error)
      } catch (recordError) {
        throw new AggregateError(
          [error, recordError],
          `模板 ${summary.id} 处理失败，且无法记录失败状态`
        )
      }
    }
  }

  return result
}
