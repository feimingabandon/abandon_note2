export const NOTE_TEXT_COLOR_FALLBACK = 'var(--text-color)'

const VALID_TAG_COLOR = /^#[0-9a-f]{6}$/i

function firstTagColor(note) {
  const color = note?.tags?.[0]?.color
  return typeof color === 'string' && VALID_TAG_COLOR.test(color.trim()) ? color.trim() : null
}

/**
 * 便签正文优先使用第一个标签的颜色；无标签或颜色异常时跟随设置页文字颜色。
 */
export function getNoteTextColor(note, { tagColorEnabled = true } = {}) {
  return tagColorEnabled
    ? firstTagColor(note) || NOTE_TEXT_COLOR_FALLBACK
    : NOTE_TEXT_COLOR_FALLBACK
}

/** 月、周视图在关闭标签颜色后统一回退到便签状态色。 */
export function getCalendarNoteAccent(note, { tagColorEnabled = true } = {}) {
  if (note?.preview_kind === 'recurrence') {
    return (tagColorEnabled && firstTagColor(note)) || '#0a84ff'
  }
  if (note?.status === 'completed') return '#8e8e93'
  if (tagColorEnabled) {
    const tagColor = firstTagColor(note)
    if (tagColor) return tagColor
  }
  return { initialized: '#0a84ff', in_progress: '#ff9f0a' }[note?.status] || '#0a84ff'
}
