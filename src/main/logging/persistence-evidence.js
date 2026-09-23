import { createHash } from 'node:crypto'
import { checkpoint, observeDiagnostic } from './operation-context.js'

function textShape(value) {
  const text = String(value ?? '')
  return { length: text.length, sha256: createHash('sha256').update(text).digest('hex') }
}

export function noteEvidence(note) {
  if (!note) return null
  const result = {}
  for (const key of [
    'id',
    'status',
    'is_deleted',
    'is_pinned',
    'effective_at',
    'finished_at',
    'updated_at',
    'duration_days',
    'duration_kind',
    'sort_order',
    'notify_enabled'
  ]) {
    if (note[key] !== undefined) result[key] = note[key]
  }
  result.content = textShape(note.content)
  result.remark = textShape(note.remark)
  // 选区颜色结构内含 text 字段，不能把它当作纯样式原样写入日志。
  result.contentColorRanges = textShape(
    typeof note.content_color_ranges === 'string'
      ? note.content_color_ranges
      : JSON.stringify(note.content_color_ranges || [])
  )
  result.attachments = (note.attachments || []).map((item) => item.id).slice(0, 100)
  result.tags = (note.tags || []).map((item) => item.id).slice(0, 100)
  return result
}

export function changedFields(before, after) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter(
    (key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])
  )
}

// 调用方必须先完成 sender 授权。读回只是证据，不修改业务返回、异常或事务。
export function observeNoteMutation(handler, readNote, event, args, channel = '') {
  const requestedId = Number(args[0]?.id)
  const before =
    Number.isInteger(requestedId) && requestedId > 0
      ? observeDiagnostic(() => noteEvidence(readNote(requestedId)))
      : null
  const finish = (result, failure = false) => {
    const id = Number(result?.id ?? requestedId)
    if (!Number.isInteger(id) || id <= 0) return result
    const after = observeDiagnostic(() => noteEvidence(readNote(id)))
    const available = before !== undefined && after !== undefined
    const fields = available ? changedFields(before, after) : []
    const requested = {}
    const requestedFields = args[0]?.fields || args[0]?.options || args[0] || {}
    for (const key of channel === 'notes:save-draft' ? ['content'] : ['content', 'remark']) {
      if (requestedFields[key] !== undefined) requested[key] = textShape(requestedFields[key])
    }
    const mismatchedFields =
      available && !failure
        ? Object.keys(requested).filter(
            (key) => JSON.stringify(requested[key]) !== JSON.stringify(after?.[key])
          )
        : []
    const dataChanged = fields.some((key) => key !== 'updated_at')
    checkpoint(
      'note.persisted',
      {
        id,
        before,
        after,
        requested,
        changedFields: fields,
        dataChanged,
        mismatchedFields,
        handlerFailed: failure
      },
      {
        level: mismatchedFields.length ? 'warn' : 'info',
        outcome: !available
          ? 'unavailable'
          : mismatchedFields.length
            ? 'mismatch'
            : dataChanged
              ? 'changed'
              : 'no-change'
      }
    )
    return result
  }
  try {
    const result = handler(event, ...args)
    if (result && typeof result.then === 'function')
      return result.then(
        (value) => finish(value),
        (error) => {
          finish(undefined, true)
          throw error
        }
      )
    return finish(result)
  } catch (error) {
    finish(undefined, true)
    throw error
  }
}

export function readSettingEvidence(entries, readRows, applicationIds, viewScope) {
  return observeDiagnostic(() => {
    const scopes = new Map()
    return entries.map(({ id, type, key, value }) => {
      const scope = applicationIds.has(id) ? 'application' : viewScope
      if (!scopes.has(scope)) scopes.set(scope, readRows(scope))
      const row = scopes.get(scope).find((item) => item.type === type && item.key === key)
      return {
        id,
        scope,
        expected: value === null ? null : String(value),
        stored: row?.value ?? null,
        exists: Boolean(row)
      }
    })
  })
}

function settingValue(value) {
  // 只保留数字、布尔和少量有限枚举。路径、位置、快捷键和其他字符串用摘要。
  if (
    value === null ||
    /^(true|false|-?\d+(\.\d+)?|top|bottom|normal|black|white|list|month|week)$/.test(value)
  )
    return value
  return textShape(value)
}

export function reportSettingEvidence(before, after) {
  if (!after) return
  for (const entry of after) {
    const previous = before?.find((item) => item.id === entry.id && item.scope === entry.scope)
    const matches = entry.exists && entry.stored === entry.expected
    checkpoint(
      'settings.persisted',
      {
        id: entry.id,
        scope: entry.scope,
        requested: settingValue(entry.expected),
        before: previous ? settingValue(previous.stored) : undefined,
        stored: settingValue(entry.stored),
        matches,
        changed: previous ? previous.stored !== entry.stored : undefined
      },
      { level: matches ? 'info' : 'warn', outcome: matches ? 'verified' : 'mismatch' }
    )
  }
}
