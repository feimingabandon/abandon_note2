/**
 * recurrence.js — 循环便签生成算法
 *
 * 职责：
 *   1. 计算最近一次应生成的时刻（供 scheduler 调用）
 *   2. 判断模板是否应当生成实例
 *   3. 执行生成流程（事务内：过期旧实例 + 创建新实例 + 更新模板时间戳）
 *
 * 依赖：
 *   getActiveTemplates()  — db-templates.js
 *   updateLastGeneratedAt() — db-templates.js
 *   createNote()          — db-notes.js
 *   expireNote()          — db-notes.js
 *   getDb()               — db.js
 */

import { getActiveTemplates, updateLastGeneratedAt } from './db-templates.js'
import { createNote, expireNote } from './db-notes.js'
import { getDb } from './db.js'

// ============================================================
// 公共入口：由 Scheduler tick 调用
// ============================================================

/**
 * 遍历所有活跃模板，为应当生成的模板创建实例
 * 在事务内完成：过期旧实例 + 创建新实例 + 更新 last_generated_at
 * @returns {number} 本次生成的实例数（0 = 没有模板需要生成）
 */
export function generateRecurringNotes() {
  const templates = getActiveTemplates()
  if (!templates.length) return 0

  const db = getDb()
  const now = Date.now()
  let generated = 0

  db.transaction(() => {
    for (const tpl of templates) {
      let rule
      try {
        rule = JSON.parse(tpl.recurrence_rule)
      } catch (e) {
        console.warn(`[recurrence] 模板 ${tpl.id} recurrence_rule 解析失败: ${e.message}，跳过`)
        continue
      }

      const { should, effectiveAt } = shouldGenerate(rule, tpl.last_generated_at, now)
      if (!should || effectiveAt === null) continue

      // 1. 将该模板上一周期未完成的实例标记为 expired
      const oldInstances = db
        .prepare(
          `SELECT id FROM notes WHERE template_id = ? AND status IN ('active','in_progress')`
        )
        .all(tpl.id)

      for (const row of oldInstances) {
        expireNote(row.id)
      }

      // 2. 创建新实例
      const newNote = createNote({
        content: tpl.content || '',
        effectiveAt,
        templateId: tpl.id,
        notifyEnabled: tpl.notify_enabled
      })

      // 3. 更新模板的最后生成时间
      updateLastGeneratedAt(tpl.id, effectiveAt)

      generated++

      console.log(
        `[recurrence] 模板"${tpl.id}"生成实例 #${newNote.id} @ ${new Date(effectiveAt).toLocaleString()}`
      )
    }
  })()

  return generated
}

// ============================================================
// 核心算法：判断是否应生成
// ============================================================

/**
 * 判断模板是否应当生成实例
 * @param {Object} rule - recurrence_rule JSON 对象
 * @param {number|null} lastGeneratedAt - 上次生成时间戳（毫秒），NULL = 从未生成
 * @param {number} now - 当前时间戳（毫秒）
 * @returns {{ should: boolean, effectiveAt: number|null }}
 */
export function shouldGenerate(rule, lastGeneratedAt, now) {
  const scheduledAt = calcMostRecentScheduledTime(rule, now)
  if (scheduledAt === null) return { should: false, effectiveAt: null }

  // 从未生成过 → 必须生成
  if (lastGeneratedAt === null) return { should: true, effectiveAt: scheduledAt }

  // 最近应生成时刻晚于上次生成时刻 → 有新周期
  return {
    should: scheduledAt > lastGeneratedAt,
    effectiveAt: scheduledAt
  }
}

/**
 * 计算「最近一次应当生成的时刻」
 * 返回的时间戳 ≤ now，是该规则下最近一次触发点
 * @param {Object} rule
 * @param {number} now
 * @returns {number|null}
 */
export function calcMostRecentScheduledTime(rule, now) {
  const timeOfDay = rule.time_of_day || '00:00'
  const [hour, minute] = timeOfDay.split(':').map(Number)

  switch (rule.frequency) {
    case 'daily':
    case 'every_other_day':
      return calcDaily(
        now,
        hour,
        minute,
        rule.frequency === 'every_other_day' ? 2 : rule.interval || 1
      )

    case 'weekly':
      return calcWeekly(now, hour, minute, rule.days_of_week || [])

    case 'monthly':
      return calcMonthly(now, hour, minute, rule.days_of_month || [])

    default:
      return null
  }
}

// ============================================================
// 每日 / 隔日
// ============================================================

/**
 * 计算 ≤ now 的最近一个符合间隔条件的日期的目标时刻
 * @param {number} now
 * @param {number} hour
 * @param {number} minute
 * @param {number} interval - 间隔天数（daily=1, every_other_day=2）
 */
function calcDaily(now, hour, minute, interval) {
  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)

  // 如果今天目标时刻已过 → 回退到最近一个匹配日
  while (d.getTime() > now) {
    d.setDate(d.getDate() - interval)
  }

  // 向前推进到 ≤ now 的最近匹配日
  while (d.getTime() <= now) {
    const next = new Date(d)
    next.setDate(next.getDate() + interval)
    if (next.getTime() > now) break
    d.setDate(d.getDate() + interval)
  }

  return d.getTime()
}

// ============================================================
// 每周（指定星期几）
// ============================================================

/**
 * @param {number} now
 * @param {number} hour
 * @param {number} minute
 * @param {number[]} daysOfWeek - [1=周一 ... 7=周日]
 */
function calcWeekly(now, hour, minute, daysOfWeek) {
  if (!daysOfWeek.length) return null

  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)

  // 从今天往回找最近匹配的星期（最多 7 天）
  for (let i = 0; i < 7; i++) {
    const dow = d.getDay() === 0 ? 7 : d.getDay() // 周日=7
    if (daysOfWeek.includes(dow) && d.getTime() <= now) {
      return d.getTime()
    }
    d.setDate(d.getDate() - 1)
  }

  return null
}

// ============================================================
// 每月（指定几号）
// ============================================================

/**
 * @param {number} now
 * @param {number} hour
 * @param {number} minute
 * @param {number[]} daysOfMonth - 日号数组 [1, 15, 31]
 */
function calcMonthly(now, hour, minute, daysOfMonth) {
  if (!daysOfMonth.length) return null

  const current = new Date(now)
  current.setHours(hour, minute, 0, 0)

  // 检查当月和上月，找 ≤ now 的最晚匹配日
  for (let m = 0; m < 2; m++) {
    const year = current.getFullYear()
    const month = current.getMonth()

    // 日号降序排列，找 ≤ now 的最大日号
    const sorted = [...daysOfMonth].sort((a, b) => b - a)

    for (const day of sorted) {
      // 处理无效日期（如 2 月 30 号 → 自动回退到当月最后一天）
      const maxDay = new Date(year, month + 1, 0).getDate()
      const actualDay = Math.min(day, maxDay)

      const candidate = new Date(year, month, actualDay, hour, minute, 0, 0)
      if (candidate.getTime() <= now) {
        return candidate.getTime()
      }
    }

    // 当月没有匹配 → 回退一个月
    current.setMonth(current.getMonth() - 1)
  }

  return null
}
