import {
  DEFAULT_STICKY_HEIGHT,
  DEFAULT_STICKY_WIDTH,
  MAX_STICKY_FONT_SIZE,
  MAX_STICKY_TEXT_LENGTH,
  MIN_STICKY_FONT_SIZE
} from './stickyConstants.js'

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

export function normalizeNoteId(value) {
  const noteId = Number(value)
  if (!Number.isInteger(noteId) || noteId <= 0) {
    throw new Error('无效的便签')
  }
  return noteId
}

export function normalizeStickyContent(value) {
  const content = String(value ?? '')
  if (!content.trim()) throw new Error('便签内容为空，无法贴到桌面')
  if (content.length > MAX_STICKY_TEXT_LENGTH) {
    throw new Error('便签正文过长，无法贴到桌面')
  }
  return content
}

export function normalizeFontSize(value) {
  const fontSize = Number(value)
  if (
    !Number.isFinite(fontSize) ||
    !Number.isInteger(fontSize) ||
    fontSize < MIN_STICKY_FONT_SIZE ||
    fontSize > MAX_STICKY_FONT_SIZE
  ) {
    throw new Error('字号必须是 12～32 之间的整数')
  }
  return fontSize
}

export function normalizeCornerRadius(value) {
  const cornerRadius = Number(value)
  if (
    !Number.isFinite(cornerRadius) ||
    !Number.isInteger(cornerRadius) ||
    cornerRadius < 0 ||
    cornerRadius > 32
  ) {
    throw new Error('圆角必须是 0～32 之间的整数')
  }
  return cornerRadius
}

export function normalizeBackgroundColor(value) {
  const color = String(value ?? '').toUpperCase()
  if (!HEX_COLOR_PATTERN.test(color)) throw new Error('无效的便利贴背景颜色')
  return color
}

export function relativeLuminance(hexColor) {
  const color = normalizeBackgroundColor(hexColor)
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(color.slice(start, start + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(first, second) {
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

export function getContrastTextColor(backgroundColor) {
  const background = relativeLuminance(backgroundColor)
  const dark = relativeLuminance('#1F2328')
  return contrastRatio(background, dark) >= contrastRatio(background, 1) ? '#1F2328' : '#FFFFFF'
}

export function createStickyPreview(content, fallbackIndex = 0) {
  const firstLine = String(content)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  const title = firstLine || `便利贴 ${fallbackIndex + 1}`
  return title.length > 24 ? `${title.slice(0, 24)}…` : title
}

export function constrainBoundsToWorkArea(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  return {
    x: Math.round(Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)),
    width: Math.round(width),
    height: Math.round(height)
  }
}

export function calculateOverlapArea(first, second) {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x)
  )
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y)
  )
  return width * height
}

export function calculateTotalOverlap(bounds, otherBounds = []) {
  return otherBounds.reduce((sum, item) => sum + calculateOverlapArea(bounds, item), 0)
}

export function rectanglesOverlap(first, second) {
  return calculateOverlapArea(first, second) > 0
}

export function chooseStickyBounds({
  cursor,
  workArea,
  existingBounds = [],
  blockedBounds = [],
  width = DEFAULT_STICKY_WIDTH,
  height = DEFAULT_STICKY_HEIGHT
}) {
  const gap = 16
  const step = 32
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  const occupiedBounds = [...blockedBounds, ...existingBounds]
  const xValues = new Set([workArea.x, maxX, cursor.x + gap, cursor.x - width - gap])
  const yValues = new Set([workArea.y, maxY, cursor.y + gap, cursor.y - height - gap])

  for (const occupied of occupiedBounds) {
    xValues.add(occupied.x - width - gap)
    xValues.add(occupied.x + occupied.width + gap)
    yValues.add(occupied.y - height - gap)
    yValues.add(occupied.y + occupied.height + gap)
  }
  for (let x = workArea.x; x <= maxX; x += step) xValues.add(x)
  for (let y = workArea.y; y <= maxY; y += step) yValues.add(y)

  const candidates = new Map()
  for (const x of xValues) {
    for (const y of yValues) {
      const bounded = constrainBoundsToWorkArea({ x, y, width, height }, workArea)
      candidates.set(`${bounded.x}:${bounded.y}`, bounded)
    }
  }

  let best = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const bounded of candidates.values()) {
    const blockedOverlap = calculateTotalOverlap(bounded, blockedBounds)
    const existingOverlap = calculateTotalOverlap(bounded, existingBounds)
    const distance =
      (bounded.x - cursor.x) * (bounded.x - cursor.x) +
      (bounded.y - cursor.y) * (bounded.y - cursor.y)
    const score = blockedOverlap * 1_000_000_000_000 + existingOverlap * 1_000_000 + distance
    if (score < bestScore) {
      best = bounded
      bestScore = score
      if (blockedOverlap === 0 && existingOverlap === 0 && distance === 0) break
    }
  }

  return best || constrainBoundsToWorkArea({ x: cursor.x, y: cursor.y, width, height }, workArea)
}

export function mapBoundsBetweenWorkAreas(bounds, oldWorkArea, newWorkArea) {
  const ratioX = (bounds.x - oldWorkArea.x) / Math.max(1, oldWorkArea.width - bounds.width)
  const ratioY = (bounds.y - oldWorkArea.y) / Math.max(1, oldWorkArea.height - bounds.height)
  return constrainBoundsToWorkArea(
    {
      ...bounds,
      x: newWorkArea.x + ratioX * (newWorkArea.width - bounds.width),
      y: newWorkArea.y + ratioY * (newWorkArea.height - bounds.height)
    },
    newWorkArea
  )
}

export function isToolbarAccessible(bounds, workAreas, toolbarHeight) {
  return workAreas.some((area) => {
    const horizontal = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
    const vertical = bounds.y < area.y + area.height && bounds.y + toolbarHeight > area.y
    return horizontal && vertical
  })
}
