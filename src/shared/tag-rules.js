export const MAX_ASSIGNED_TAGS = 1

export const NOTE_TAG_LIMIT_MESSAGE = '一个便签最多只能设置一个标签，请只保留一个标签后再保存'

/** 清理并去重标签名称，同时保留调用方提供的顺序。 */
export function normalizeAssignedTagNames(tagNames = []) {
  if (!Array.isArray(tagNames)) throw new Error('tagNames 必须是数组')
  return [...new Set(tagNames.map((name) => String(name).trim()).filter(Boolean))]
}

/**
 * 新写入的便签和循环模板只能关联一个标签。
 * 历史数据仍可保留多标签；只有发生保存时才执行此校验。
 */
export function requireSingleAssignedTag(tagNames = []) {
  const normalized = normalizeAssignedTagNames(tagNames)
  if (normalized.length > MAX_ASSIGNED_TAGS) throw new Error(NOTE_TAG_LIMIT_MESSAGE)
  return normalized
}
