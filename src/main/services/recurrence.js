/** 循环模板生成编排：只补偿当天节点，实例按快照独立创建。 */
import { getDueTemplates, recordTemplateFailure } from '../db/db-templates.js'
import { createRecurringNoteSnapshot, deleteNote } from '../db/db-notes.js'
import { getDb } from '../db/db-connection.js'
import { calculateNextRun, normalizeRecurrenceRule } from './recurrence-rules.js'

export { calculateNextRun, normalizeRecurrenceRule } from './recurrence-rules.js'

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

function startOfLocalDay(timestamp) {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 返回今天已经到时的规则节点；历史节点只用于确认模板确实存在积压，不会生成实例。
 * 不能只检查 next_run_at 是否属于今天：连续计划日积压时，next_run_at 仍可能停在昨天。
 */
function resolveTodayDueAt(template, rule, timestamp) {
  const scheduledAt = Number(template.next_run_at)
  if (!Number.isFinite(scheduledAt)) throw new Error('模板 next_run_at 无效')

  const todayStart = startOfLocalDay(timestamp)
  if (scheduledAt >= todayStart) return scheduledAt

  const todayCandidate = calculateNextRun(rule, todayStart - 1, template.schedule_anchor_at)
  return todayCandidate >= scheduledAt && todayCandidate <= timestamp ? todayCandidate : null
}

/**
 * @param {{now?: number, reason?: 'startup'|'scheduled'|'recovery'|'resume'}} context
 * @returns {{count:number, skipped:number, generated:Array, autoPaused:Array, errors:Array}}
 */
export function runRecurringTemplates({ now = Date.now() } = {}) {
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

        const storedDueAt = Number(template.next_run_at)
        if (!Number.isFinite(storedDueAt)) throw new Error('模板 next_run_at 无效')
        if (storedDueAt > timestamp) return null

        const scheduledAt = resolveTodayDueAt(template, rule, timestamp)
        if (scheduledAt === null) {
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

        const tagIds = db
          .prepare('SELECT tag_id FROM template_tags WHERE template_id = ? ORDER BY rowid')
          .all(template.id)
          .map((row) => row.tag_id)
        const note = createRecurringNoteSnapshot({
          content: template.content,
          effectiveAt: scheduledAt,
          isPinned: template.is_pinned,
          tagIds
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
          notification: template.notify_enabled
            ? { id: note.id, content: note.content || '' }
            : null
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
