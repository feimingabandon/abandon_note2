import { listTemplates } from '../db/db-templates.js'
import { calculateNextRun, normalizeRecurrenceRule } from '../services/recurrence-rules.js'
import {
  addCalendarDays,
  localMidnightTimestamp
} from '../../shared/calendar/calendar-date-rules.js'

const MAX_PREVIEWS_PER_TEMPLATE = 64
const MAX_TOTAL_PREVIEWS = 5000

function previewId(templateId, scheduledAt) {
  return `recurrence-preview:${templateId}:${scheduledAt}`
}

/**
 * 只计算可见日期范围内尚未生成的循环节点。返回值是日历展示数据，绝不写入 notes。
 * 单个损坏模板只会被跳过，不能阻断真实便签和日历元数据的加载。
 */
export function buildRecurringNotePreviews({
  rangeStart,
  rangeEnd,
  now = Date.now(),
  templates = null
} = {}) {
  const currentTime = Number(now)
  if (!Number.isFinite(currentTime)) throw new Error('循环便签预览时间无效')

  const rangeStartAt = localMidnightTimestamp(rangeStart)
  const rangeEndExclusive = localMidnightTimestamp(addCalendarDays(rangeEnd, 1))
  const runningTemplates = templates ?? listTemplates({ state: 'running' })
  const items = []
  const skippedTemplateIds = []
  let truncated = false

  for (const template of runningTemplates) {
    if (items.length >= MAX_TOTAL_PREVIEWS) {
      truncated = true
      break
    }

    try {
      if (template?.is_deleted || template?.is_paused) continue
      const templateId = Number(template.id)
      const nextRunAt = Number(template.next_run_at)
      const scheduleAnchorAt = Number(template.schedule_anchor_at)
      if (!Number.isInteger(templateId) || templateId <= 0) throw new Error('模板 ID 无效')
      if (!Number.isFinite(nextRunAt) || !Number.isFinite(scheduleAnchorAt)) {
        throw new Error('模板调度时间无效')
      }

      const rule = normalizeRecurrenceRule(template.recurrence_rule)
      let cursor = Math.max(currentTime, rangeStartAt - 1, nextRunAt - 1)
      let generatedForTemplate = 0

      while (generatedForTemplate < MAX_PREVIEWS_PER_TEMPLATE) {
        const scheduledAt = calculateNextRun(rule, cursor, scheduleAnchorAt)
        if (scheduledAt >= rangeEndExclusive) break
        if (scheduledAt <= cursor) throw new Error('循环规则没有向未来推进')

        if (scheduledAt >= rangeStartAt && scheduledAt > currentTime) {
          items.push({
            id: previewId(templateId, scheduledAt),
            preview_kind: 'recurrence',
            read_only: true,
            template_id: templateId,
            content: template.content || '',
            status: 'initialized',
            is_pinned: Number(Boolean(template.is_pinned)),
            notify_enabled: 0,
            effective_at: scheduledAt,
            duration_days: 1,
            duration_kind: 'single_day',
            attachment_count: 0,
            from_template: 1,
            tags: Array.isArray(template.tags) ? template.tags : []
          })
          if (items.length >= MAX_TOTAL_PREVIEWS) {
            truncated = true
            break
          }
        }

        cursor = scheduledAt
        generatedForTemplate += 1
      }

      if (generatedForTemplate >= MAX_PREVIEWS_PER_TEMPLATE) truncated = true
    } catch {
      skippedTemplateIds.push(Number(template?.id) || null)
    }
  }

  return { items, truncated, skippedTemplateIds }
}
