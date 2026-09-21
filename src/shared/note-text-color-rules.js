export const NOTE_TEXT_COLOR_PRESETS = Object.freeze([
  '#007aff',
  '#ff3b30',
  '#34c759',
  '#ff9500',
  '#af52de',
  '#ff2d55',
  '#5856d6',
  '#00c7be',
  '#7b7b7b',
  '#ff9f0a',
  '#30b0c7',
  '#d35400'
])

export const MAX_NOTE_TEXT_COLOR_RANGES = 512

const VALID_COLOR = /^#[0-9a-f]{6}$/i

export function normalizeNoteTextColor(value) {
  const color = String(value || '')
    .trim()
    .toLowerCase()
  if (!VALID_COLOR.test(color)) throw new Error('文字颜色必须是 6 位十六进制颜色')
  return color
}

function parseRanges(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function createRange(content, start, end, color) {
  return {
    start,
    end,
    text: content.slice(start, end),
    color: normalizeNoteTextColor(color)
  }
}

function mergeAdjacentRanges(ranges, content) {
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && previous.end === range.start && previous.color === range.color) {
      previous.end = range.end
      previous.text = content.slice(previous.start, previous.end)
      continue
    }
    merged.push({ ...range })
  }
  if (merged.length > MAX_NOTE_TEXT_COLOR_RANGES) {
    throw new Error(`每条便签最多保存 ${MAX_NOTE_TEXT_COLOR_RANGES} 段文字颜色`)
  }
  return merged
}

/**
 * 将数据库或 Renderer 传入的区间收敛为有序、互不重叠且与正文匹配的记录。
 * 无效或已经过期的记录直接忽略，避免错误颜色污染正文。
 */
export function normalizeNoteTextColorRanges(value, contentValue = '') {
  const content = String(contentValue ?? '')
  const normalized = []
  for (const candidate of parseRanges(value)) {
    const start = Number(candidate?.start)
    const end = Number(candidate?.end)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue
    if (end > content.length || content.slice(start, end) !== String(candidate?.text ?? ''))
      continue
    let color
    try {
      color = normalizeNoteTextColor(candidate?.color)
    } catch {
      continue
    }
    normalized.push({ start, end, text: content.slice(start, end), color })
  }
  normalized.sort((left, right) => left.start - right.start || left.end - right.end)

  const nonOverlapping = []
  for (const range of normalized) {
    if (nonOverlapping.at(-1)?.end > range.start) continue
    nonOverlapping.push(range)
  }
  return mergeAdjacentRanges(nonOverlapping, content)
}

export function serializeNoteTextColorRanges(value, contentValue = '') {
  return JSON.stringify(normalizeNoteTextColorRanges(value, contentValue))
}

/** 设置或清除一个选区的颜色；color=null 表示清除。 */
export function applyNoteTextColorRange(value, { content: contentValue, start, end, color }) {
  const content = String(contentValue ?? '')
  const rangeStart = Number(start)
  const rangeEnd = Number(end)
  if (
    !Number.isInteger(rangeStart) ||
    !Number.isInteger(rangeEnd) ||
    rangeStart < 0 ||
    rangeEnd <= rangeStart ||
    rangeEnd > content.length ||
    !content.slice(rangeStart, rangeEnd).trim()
  ) {
    throw new Error('请选择有效的便签正文')
  }

  const next = []
  for (const range of normalizeNoteTextColorRanges(value, content)) {
    if (range.end <= rangeStart || range.start >= rangeEnd) {
      next.push(range)
      continue
    }
    if (range.start < rangeStart) {
      next.push(createRange(content, range.start, rangeStart, range.color))
    }
    if (range.end > rangeEnd) {
      next.push(createRange(content, rangeEnd, range.end, range.color))
    }
  }
  if (color !== null && color !== undefined && color !== '') {
    next.push(createRange(content, rangeStart, rangeEnd, color))
  }
  next.sort((left, right) => left.start - right.start || left.end - right.end)
  return mergeAdjacentRanges(next, content)
}

function overlapsReserved(start, end, reserved) {
  return reserved.some((range) => start < range.end && end > range.start)
}

function findAvailableOccurrences(content, text, reserved) {
  const occurrences = []
  let cursor = 0
  while (cursor <= content.length - text.length) {
    const start = content.indexOf(text, cursor)
    if (start === -1) break
    const end = start + text.length
    if (!overlapsReserved(start, end, reserved)) occurrences.push({ start, end })
    cursor = start + Math.max(1, text.length)
  }
  return occurrences
}

/**
 * 正文保存时校正颜色位置：原位置仍匹配就保留；否则只接受正文中的唯一匹配。
 * 找不到或出现多个候选时删除该记录，宁可丢失颜色也不把颜色贴到错误文字。
 */
export function reconcileNoteTextColorRanges(value, oldContentValue, newContentValue) {
  const oldContent = String(oldContentValue ?? '')
  const newContent = String(newContentValue ?? '')
  if (oldContent === newContent) return normalizeNoteTextColorRanges(value, newContent)

  const reserved = []
  for (const range of normalizeNoteTextColorRanges(value, oldContent)) {
    if (
      newContent.slice(range.start, range.end) === range.text &&
      !overlapsReserved(range.start, range.end, reserved)
    ) {
      reserved.push(createRange(newContent, range.start, range.end, range.color))
      continue
    }
    const occurrences = findAvailableOccurrences(newContent, range.text, reserved)
    if (occurrences.length !== 1) continue
    reserved.push(createRange(newContent, occurrences[0].start, occurrences[0].end, range.color))
  }
  reserved.sort((left, right) => left.start - right.start || left.end - right.end)
  return mergeAdjacentRanges(reserved, newContent)
}

/** 将正文切分为可安全使用 Vue 文本插值渲染的普通/着色片段。 */
export function buildNoteTextColorSegments(contentValue, value) {
  const content = String(contentValue ?? '')
  const ranges = normalizeNoteTextColorRanges(value, content)
  const segments = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ start: cursor, end: range.start, text: content.slice(cursor, range.start) })
    }
    segments.push({ ...range })
    cursor = range.end
  }
  if (cursor < content.length) {
    segments.push({ start: cursor, end: content.length, text: content.slice(cursor) })
  }
  return segments.length ? segments : [{ start: 0, end: content.length, text: content }]
}
