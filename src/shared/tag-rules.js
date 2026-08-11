export const MAX_ASSIGNED_TAGS = 1

export const NOTE_TAG_LIMIT_MESSAGE = '一个便签最多只能设置一个标签，请只保留一个标签后再保存'

/** 校验并去重标签 ID，同时保留调用方提供的顺序。 */
export function normalizeAssignedTagIds(tagIds = []) {
  if (!Array.isArray(tagIds)) throw new Error('tagIds 必须是数组')
  const normalized = tagIds.map(Number)
  if (normalized.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('tagIds 包含无效标签 ID')
  }
  return [...new Set(normalized)]
}

/**
 * 新写入的便签和循环模板只能关联一个标签。
 * 历史数据仍可保留多标签；只有发生保存时才执行此校验。
 */
export function requireSingleAssignedTagId(tagIds = []) {
  const normalized = normalizeAssignedTagIds(tagIds)
  if (normalized.length > MAX_ASSIGNED_TAGS) throw new Error(NOTE_TAG_LIMIT_MESSAGE)
  return normalized
}
