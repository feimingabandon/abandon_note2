/** 循环便签生成的数据库编排；日期计算位于纯函数模块 recurrence-rules.js。 */
import { getActiveTemplates, updateLastGeneratedAt } from '../db/db-templates.js'
import { createNote, deleteNote } from '../db/db-notes.js'
import { getDb } from '../db/db.js'
import { shouldGenerate } from './recurrence-rules.js'

export { shouldGenerate, calcMostRecentScheduledTime } from './recurrence-rules.js'

export function generateRecurringNotes() {
  const templates = getActiveTemplates()
  if (!templates.length) return { count: 0, generated: [] }

  const db = getDb()
  const now = Date.now()
  let count = 0
  const generated = []

  db.transaction(() => {
    for (const template of templates) {
      let rule
      try {
        rule = JSON.parse(template.recurrence_rule)
      } catch (error) {
        console.warn(`[recurrence] 模板 ${template.id} recurrence_rule 解析失败: ${error.message}，跳过`)
        continue
      }

      const { should, effectiveAt } = shouldGenerate(rule, template.last_generated_at, now)
      if (!should || effectiveAt === null) continue

      const oldInstances = db
        .prepare(
          `SELECT id FROM notes
           WHERE template_id = ? AND is_deleted = 0
             AND status IN ('initialized','in_progress')`
        )
        .all(template.id)
      for (const row of oldInstances) deleteNote(row.id)

      const newNote = createNote({
        content: template.content || '',
        effectiveAt,
        templateId: template.id,
        notifyEnabled: template.notify_enabled
      })
      updateLastGeneratedAt(template.id, effectiveAt)
      count += 1

      if (template.notify_enabled) {
        generated.push({
          id: newNote.id,
          content: newNote.content || '',
          notifyEnabled: template.notify_enabled
        })
      }
      console.log(
        `[recurrence] 模板"${template.id}"生成实例 #${newNote.id} @ ${new Date(effectiveAt).toLocaleString()}`
      )
    }
  })()

  return { count, generated }
}
