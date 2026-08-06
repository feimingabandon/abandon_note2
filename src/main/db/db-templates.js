/** 循环模板 CRUD、标签快照配置与可恢复删除。 */
import { getDb } from './db-connection.js'
import { calculateNextRun, normalizeRecurrenceRule } from '../services/recurrence-rules.js'
import { requireSingleAssignedTag } from '../../shared/tag-rules.js'

const now = () => Date.now()

function normalizeTemplateId(id) {
  const value = Number(id)
  if (!Number.isInteger(value) || value <= 0) throw new Error('无效的模板 ID')
  return value
}

function normalizeContent(content) {
  const value = String(content ?? '')
  if (!value.trim()) throw new Error('模板内容不能为空')
  return value
}

function normalizeTagNames(tagNames = []) {
  return requireSingleAssignedTag(tagNames)
}

function ensureTagsExist(db, tagNames) {
  if (tagNames.length === 0) return
  const placeholders = tagNames.map(() => '?').join(',')
  const rows = db.prepare(`SELECT name FROM tags WHERE name IN (${placeholders})`).all(...tagNames)
  if (rows.length !== tagNames.length) throw new Error('模板包含不存在的标签')
}

function replaceTemplateTags(db, templateId, tagNames) {
  ensureTagsExist(db, tagNames)
  db.prepare('DELETE FROM template_tags WHERE template_id = ?').run(templateId)
  const insert = db.prepare('INSERT INTO template_tags (template_id, tag_name) VALUES (?, ?)')
  for (const tagName of tagNames) insert.run(templateId, tagName)
}

function getTemplateRow(db, id) {
  return db.prepare('SELECT * FROM note_templates WHERE id = ?').get(id) || null
}

function attachTags(db, template) {
  if (!template) return null
  template.tags = db
    .prepare(
      `SELECT t.* FROM tags t
       INNER JOIN template_tags tt ON tt.tag_name = t.name
       WHERE tt.template_id = ?
       ORDER BY tt.rowid ASC`
    )
    .all(template.id)
  return template
}

function attachTagsToTemplates(db, templates) {
  if (templates.length === 0) return templates
  const tagsByTemplate = new Map(templates.map((template) => [template.id, []]))
  const ids = templates.map((template) => template.id)
  for (let offset = 0; offset < ids.length; offset += 900) {
    const batch = ids.slice(offset, offset + 900)
    const placeholders = batch.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT tt.template_id, t.* FROM template_tags tt
         INNER JOIN tags t ON t.name = tt.tag_name
         WHERE tt.template_id IN (${placeholders})
         ORDER BY tt.rowid ASC`
      )
      .all(...batch)
    for (const row of rows) {
      const { template_id: templateId, ...tag } = row
      tagsByTemplate.get(templateId)?.push(tag)
    }
  }
  return templates.map((template) => ({ ...template, tags: tagsByTemplate.get(template.id) || [] }))
}

export function createTemplate(
  { recurrenceRule, content = '', notifyEnabled = true, isPinned = false, tagNames = [] } = {},
  timestamp = now()
) {
  const db = getDb()
  const normalizedContent = normalizeContent(content)
  const normalizedRule = normalizeRecurrenceRule(recurrenceRule)
  const normalizedTags = normalizeTagNames(tagNames)
  const nextRunAt = calculateNextRun(normalizedRule, timestamp, timestamp)

  return db.transaction(() => {
    ensureTagsExist(db, normalizedTags)
    const result = db
      .prepare(
        `INSERT INTO note_templates (
         content, recurrence_rule, is_pinned, notify_enabled, is_paused, is_deleted,
           deleted_at, schedule_anchor_at, next_run_at, last_generated_at,
           last_generated_note_id, consecutive_failures, last_error, last_failed_at,
           pause_reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?, NULL, NULL, 0, NULL, NULL, NULL, ?, ?)`
      )
      .run(
        normalizedContent,
        JSON.stringify(normalizedRule),
        isPinned ? 1 : 0,
        notifyEnabled ? 1 : 0,
        timestamp,
        nextRunAt,
        timestamp,
        timestamp
      )
    const templateId = Number(result.lastInsertRowid)
    replaceTemplateTags(db, templateId, normalizedTags)
    return attachTags(db, getTemplateRow(db, templateId))
  })()
}

export function updateTemplate(id, fields = {}, timestamp = now()) {
  const templateId = normalizeTemplateId(id)
  const db = getDb()

  return db.transaction(() => {
    const old = getTemplateRow(db, templateId)
    if (!old || old.is_deleted) throw new Error('模板不存在或已删除')

    const content = fields.content === undefined ? old.content : normalizeContent(fields.content)
    let oldRule = null
    try {
      oldRule = normalizeRecurrenceRule(old.recurrence_rule)
    } catch (error) {
      if (fields.recurrenceRule === undefined) throw error
    }
    const rule =
      fields.recurrenceRule === undefined ? oldRule : normalizeRecurrenceRule(fields.recurrenceRule)
    const scheduleChanged =
      fields.recurrenceRule !== undefined &&
      (!oldRule || JSON.stringify(rule) !== JSON.stringify(oldRule))
    const scheduleAnchorAt = scheduleChanged ? timestamp : old.schedule_anchor_at
    const nextRunAt = old.is_paused
      ? null
      : scheduleChanged
        ? calculateNextRun(rule, timestamp, timestamp)
        : old.next_run_at

    db.prepare(
      `UPDATE note_templates SET
         content = ?, recurrence_rule = ?, is_pinned = ?, notify_enabled = ?,
         schedule_anchor_at = ?, next_run_at = ?,
         updated_at = ?
       WHERE id = ? AND is_deleted = 0`
    ).run(
      content,
      JSON.stringify(rule),
      fields.isPinned === undefined ? old.is_pinned : fields.isPinned ? 1 : 0,
      fields.notifyEnabled === undefined ? old.notify_enabled : fields.notifyEnabled ? 1 : 0,
      scheduleAnchorAt,
      nextRunAt,
      timestamp,
      templateId
    )

    if (fields.tagNames !== undefined)
      replaceTemplateTags(db, templateId, normalizeTagNames(fields.tagNames))
    return attachTags(db, getTemplateRow(db, templateId))
  })()
}

export function deleteTemplate(id, timestamp = now()) {
  const templateId = normalizeTemplateId(id)
  const result = getDb()
    .prepare(
      `UPDATE note_templates
       SET is_deleted = 1, is_paused = 1, deleted_at = ?, next_run_at = NULL,
           pause_reason = NULL, updated_at = ?
       WHERE id = ? AND is_deleted = 0`
    )
    .run(timestamp, timestamp, templateId)
  return result.changes === 1
}

export function restoreTemplate(id, timestamp = now()) {
  const templateId = normalizeTemplateId(id)
  const db = getDb()
  return db.transaction(() => {
    const old = getTemplateRow(db, templateId)
    if (!old || !old.is_deleted) throw new Error('模板不存在或未删除')
    const rule = normalizeRecurrenceRule(old.recurrence_rule)
    const nextRunAt = calculateNextRun(rule, timestamp, old.schedule_anchor_at)
    db.prepare(
      `UPDATE note_templates
       SET is_deleted = 0, is_paused = 0, deleted_at = NULL,
           next_run_at = ?, consecutive_failures = 0, last_error = NULL,
           last_failed_at = NULL, pause_reason = NULL, updated_at = ?
       WHERE id = ? AND is_deleted = 1`
    ).run(nextRunAt, timestamp, templateId)
    return attachTags(db, getTemplateRow(db, templateId))
  })()
}

export function purgeTemplate(id) {
  const templateId = normalizeTemplateId(id)
  const result = getDb()
    .prepare('DELETE FROM note_templates WHERE id = ? AND is_deleted = 1')
    .run(templateId)
  return result.changes === 1
}

export function pauseTemplate(id, timestamp = now()) {
  const templateId = normalizeTemplateId(id)
  const result = getDb()
    .prepare(
      `UPDATE note_templates
       SET is_paused = 1, next_run_at = NULL, pause_reason = 'manual', updated_at = ?
       WHERE id = ? AND is_deleted = 0 AND is_paused = 0`
    )
    .run(timestamp, templateId)
  if (result.changes !== 1) throw new Error('模板不存在、已删除或已暂停')
  return getTemplateById(templateId)
}

export function resumeTemplate(id, timestamp = now()) {
  const templateId = normalizeTemplateId(id)
  const db = getDb()
  return db.transaction(() => {
    const old = getTemplateRow(db, templateId)
    if (!old || old.is_deleted || !old.is_paused) throw new Error('模板不存在、已删除或未暂停')
    const rule = normalizeRecurrenceRule(old.recurrence_rule)
    const nextRunAt = calculateNextRun(rule, timestamp, old.schedule_anchor_at)
    db.prepare(
      `UPDATE note_templates
       SET is_paused = 0, next_run_at = ?, consecutive_failures = 0,
           last_error = NULL, last_failed_at = NULL, pause_reason = NULL, updated_at = ?
       WHERE id = ? AND is_deleted = 0 AND is_paused = 1`
    ).run(nextRunAt, timestamp, templateId)
    return attachTags(db, getTemplateRow(db, templateId))
  })()
}

export function getTemplateById(id, { includeDeleted = false } = {}) {
  const templateId = normalizeTemplateId(id)
  const db = getDb()
  const row = includeDeleted
    ? getTemplateRow(db, templateId)
    : db.prepare('SELECT * FROM note_templates WHERE id = ? AND is_deleted = 0').get(templateId)
  return attachTags(db, row || null)
}

export function listTemplates({ state = 'active' } = {}) {
  const where = {
    active: 'WHERE is_deleted = 0',
    running: 'WHERE is_deleted = 0 AND is_paused = 0',
    paused: 'WHERE is_deleted = 0 AND is_paused = 1',
    deleted: 'WHERE is_deleted = 1',
    all: ''
  }[state]
  if (where === undefined) throw new Error('无效的模板列表状态')
  const db = getDb()
  const templates = db
    .prepare(`SELECT * FROM note_templates ${where} ORDER BY created_at DESC`)
    .all()
  return attachTagsToTemplates(db, templates)
}

/** 只读取已经到达生成节点的运行中模板，避免每分钟扫描未来模板。 */
export function getDueTemplates(timestamp) {
  const dueAt = Number(timestamp)
  if (!Number.isFinite(dueAt)) throw new Error('调度时间无效')
  return getDb()
    .prepare(
      `SELECT * FROM note_templates
       WHERE is_deleted = 0 AND is_paused = 0
         AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC, id ASC`
    )
    .all(dueAt)
}

/** 记录单模板连续失败；第三次失败时原子切换为错误暂停。 */
export function recordTemplateFailure(id, error, timestamp = now(), threshold = 3) {
  const templateId = normalizeTemplateId(id)
  const message = String(error?.message || error || '未知错误').slice(0, 1000)
  const failureThreshold = Math.max(1, Math.trunc(Number(threshold)) || 3)
  const db = getDb()

  return db.transaction(() => {
    const template = db
      .prepare(
        `SELECT id, content, consecutive_failures FROM note_templates
         WHERE id = ? AND is_deleted = 0 AND is_paused = 0`
      )
      .get(templateId)
    if (!template) return null

    const failures = Number(template.consecutive_failures || 0) + 1
    const autoPaused = failures >= failureThreshold
    db.prepare(
      `UPDATE note_templates SET
         consecutive_failures = ?, last_error = ?, last_failed_at = ?,
         is_paused = ?, next_run_at = CASE WHEN ? = 1 THEN NULL ELSE next_run_at END,
         pause_reason = CASE WHEN ? = 1 THEN 'error' ELSE pause_reason END,
         updated_at = ?
       WHERE id = ? AND is_deleted = 0 AND is_paused = 0`
    ).run(
      failures,
      message,
      timestamp,
      autoPaused ? 1 : 0,
      autoPaused ? 1 : 0,
      autoPaused ? 1 : 0,
      timestamp,
      templateId
    )

    return { id: templateId, content: template.content, failures, autoPaused, error: message }
  })()
}
