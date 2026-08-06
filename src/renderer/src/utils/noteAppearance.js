export const NOTE_TEXT_COLOR_FALLBACK = 'var(--text-color)'

const VALID_TAG_COLOR = /^#[0-9a-f]{6}$/i

/**
 * 便签正文优先使用第一个标签的颜色；无标签或颜色异常时跟随设置页文字颜色。
 */
export function getNoteTextColor(note) {
  const color = note?.tags?.[0]?.color
  return typeof color === 'string' && VALID_TAG_COLOR.test(color.trim())
    ? color.trim()
    : NOTE_TEXT_COLOR_FALLBACK
}
