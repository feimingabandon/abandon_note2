export const COMPACT_WINDOW_LIMITS = Object.freeze({
  minWidth: 180,
  maxWidth: 720,
  minHeight: 48,
  maxHeight: 180,
  defaultWidth: 180,
  defaultHeight: 48,
  screenMargin: 0
})

function finite(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeWorkArea(workArea = {}) {
  return {
    x: Math.round(finite(workArea.x)),
    y: Math.round(finite(workArea.y)),
    width: Math.max(1, Math.round(finite(workArea.width, 1))),
    height: Math.max(1, Math.round(finite(workArea.height, 1)))
  }
}

export function normalizeCompactSize(size = {}, workArea = null) {
  const limits = COMPACT_WINDOW_LIMITS
  const area = workArea ? normalizeWorkArea(workArea) : null
  const maxWidth = Math.max(
    1,
    Math.min(limits.maxWidth, area ? area.width - limits.screenMargin * 2 : Infinity)
  )
  const maxHeight = Math.max(
    1,
    Math.min(limits.maxHeight, area ? area.height - limits.screenMargin * 2 : Infinity)
  )
  const minWidth = Math.min(limits.minWidth, maxWidth)
  const minHeight = Math.min(limits.minHeight, maxHeight)
  return {
    width: Math.round(clamp(finite(size.width, limits.defaultWidth), minWidth, maxWidth)),
    height: Math.round(clamp(finite(size.height, limits.defaultHeight), minHeight, maxHeight))
  }
}

/**
 * 把本次标题栏双击的屏幕坐标作为灵动岛中心。
 * 位置只属于当前运行会话；靠近屏幕边缘时整体约束在 workArea 内。
 */
export function compactBoundsFromAnchor({ anchor, size, workArea } = {}) {
  const area = normalizeWorkArea(workArea)
  const normalizedSize = normalizeCompactSize(size, area)
  const width = Math.min(normalizedSize.width, area.width)
  const height = Math.min(normalizedSize.height, area.height)
  const centerX = finite(anchor?.x, area.x + area.width / 2)
  const centerY = finite(anchor?.y, area.y + area.height / 2)
  return {
    x: Math.round(clamp(centerX - width / 2, area.x, area.x + area.width - width)),
    y: Math.round(clamp(centerY - height / 2, area.y, area.y + area.height - height)),
    width,
    height
  }
}

export function boundsCenter(bounds = {}) {
  return {
    x: finite(bounds.x) + finite(bounds.width) / 2,
    y: finite(bounds.y) + finite(bounds.height) / 2
  }
}

export function compactBoundsAroundCenter({ bounds, size, workArea } = {}) {
  return compactBoundsFromAnchor({
    anchor: boundsCenter(bounds),
    size,
    workArea
  })
}
