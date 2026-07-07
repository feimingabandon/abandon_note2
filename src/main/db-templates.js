/**
 * db-templates.js — 循环模板 CRUD 模块（主进程）
 *
 * 职责：
 *   1. 循环便签模板的创建、查询、更新、软删除
 *   2. 暂停/恢复模板生成
 *   3. 获取活跃模板（供调度器使用）
 */

import { getDb } from './db.js'

const now = () => Date.now()

/**
 * 校验 recurrence_rule JSON 字符串格式合法性
 * @param {string} rule - JSON 字符串
 * @returns {boolean}
 */
function isValidRecurrenceRule(rule) {
  if (!rule || typeof rule !== 'string') return false
  try {
    const parsed = JSON.parse(rule)
    return typeof parsed.frequency === 'string'
  } catch {
    return false
  }
}

// ============================================================
// CRUD
// ============================================================

/**
 * 创建循环模板
 * @param {Object} options
 * @param {string} options.recurrenceRule - JSON 字符串，循环规则
 * @param {string} [options.content=''] - 模板默认正文
 * @param {boolean} [options.notifyEnabled=true] - 生成实例时是否发送操作系统通知
 * @returns {Object} 创建的模板对象
 * @throws {Error} recurrenceRule 为空或 JSON 格式无效时抛出
 */
export function createTemplate({ recurrenceRule, content = '', notifyEnabled = true }) {
  if (!isValidRecurrenceRule(recurrenceRule)) {
    throw new Error('recurrenceRule 必须是一个合法的 JSON 字符串，且包含 frequency 字段')
  }

  const ts = now()
  const result = getDb()
    .prepare(
      `
    INSERT INTO note_templates (content, recurrence_rule, is_paused, is_deleted, notify_enabled, created_at, updated_at)
    VALUES (?, ?, 0, 0, ?, ?, ?)
  `
    )
    .run(content, recurrenceRule, notifyEnabled ? 1 : 0, ts, ts)

  return getTemplateById(result.lastInsertRowid)
}

/**
 * 更新模板
 * @param {number} id
 * @param {Object} [fields={}] - { content?, recurrenceRule?, isPaused?, notifyEnabled? }
 * @returns {Object|null}
 * @throws {Error} recurrenceRule JSON 格式无效时抛出
 */
export function updateTemplate(id, fields = {}) {
  const old = getTemplateById(id)
  if (!old) return null

  // 如果传入了 recurrenceRule，校验 JSON 合法性
  if (fields.recurrenceRule !== undefined && !isValidRecurrenceRule(fields.recurrenceRule)) {
    throw new Error('recurrenceRule 必须是一个合法的 JSON 字符串，且包含 frequency 字段')
  }

  const ts = now()
  getDb()
    .prepare(
      `
    UPDATE note_templates SET
      content = ?, recurrence_rule = ?, is_paused = ?, notify_enabled = ?, updated_at = ?
    WHERE id = ?
  `
    )
    .run(
      fields.content ?? old.content,
      fields.recurrenceRule ?? old.recurrence_rule,
      fields.isPaused ?? old.is_paused,
      fields.notifyEnabled ?? old.notify_enabled,
      ts,
      id
    )

  return getTemplateById(id)
}

/**
 * 软删除模板
 * @param {number} id
 * @returns {boolean}
 */
export function deleteTemplate(id) {
  const result = getDb()
    .prepare(
      `
    UPDATE note_templates SET is_deleted = 1, updated_at = ? WHERE id = ?
  `
    )
    .run(now(), id)
  return result.changes > 0
}

/**
 * 按 ID 获取模板
 * @param {number} id
 * @returns {Object|null}
 */
export function getTemplateById(id) {
  return getDb().prepare('SELECT * FROM note_templates WHERE id = ?').get(id)
}

/**
 * 获取所有模板（不含已删除）
 * @returns {Object[]}
 */
export function listTemplates() {
  return getDb()
    .prepare(
      `
    SELECT * FROM note_templates WHERE is_deleted = 0 ORDER BY created_at DESC
  `
    )
    .all()
}

// ============================================================
// 暂停/恢复
// ============================================================

export function pauseTemplate(id) {
  return updateTemplate(id, { isPaused: 1 })
}

export function resumeTemplate(id) {
  return updateTemplate(id, { isPaused: 0 })
}

// ============================================================
// 调度器接口
// ============================================================

/**
 * 获取所有活跃模板（未暂停、未删除），供调度器遍历
 * @returns {Object[]} 模板对象数组
 */
export function getActiveTemplates() {
  return getDb()
    .prepare(
      `
    SELECT * FROM note_templates
    WHERE is_paused = 0 AND is_deleted = 0
    ORDER BY id ASC
  `
    )
    .all()
}

/**
 * 更新模板的上次生成时间（生成实例后调用）
 * @param {number} templateId
 * @param {number} scheduledAt - 本次生成对应的时间戳（毫秒）
 * @returns {Object|null}
 */
export function updateLastGeneratedAt(templateId, scheduledAt) {
  const result = getDb()
    .prepare(
      `
    UPDATE note_templates SET last_generated_at = ?, updated_at = ? WHERE id = ?
  `
    )
    .run(scheduledAt, now(), templateId)
  return result.changes > 0
}
