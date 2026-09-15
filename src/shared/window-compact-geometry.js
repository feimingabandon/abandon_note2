export const COMPACT_WINDOW_LIMITS = Object.freeze({
  minWidth: 100,
  maxWidth: 720,
  minHeight: 40,
  maxHeight: 180,
  defaultWidth: 200,
  defaultHeight: 40,
  screenMargin: 0
})

function finite(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundBounds(bounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
}

export function normalizeCompactSize(size = {}, workArea = null) {
  const limits = COMPACT_WINDOW_LIMITS
  const availableWidth = workArea
    ? Math.max(1, finite(workArea.width) - limits.screenMargin * 2)
    : Infinity
  const availableHeight = workArea
    ? Math.max(1, finite(workArea.height) - limits.screenMargin * 2)
    : Infinity
  const maxWidth = Math.max(1, Math.min(limits.maxWidth, availableWidth))
  const maxHeight = Math.max(1, Math.min(limits.maxHeight, availableHeight))
  const minWidth = Math.min(limits.minWidth, maxWidth)
  const minHeight = Math.min(limits.minHeight, maxHeight)
  return {
    width: Math.round(clamp(finite(size.width, limits.defaultWidth), minWidth, maxWidth)),
    height: Math.round(clamp(finite(size.height, limits.defaultHeight), minHeight, maxHeight))
  }
}

function insetWorkArea(workArea, margin = COMPACT_WINDOW_LIMITS.screenMargin) {
  const x = finite(workArea?.x)
  const y = finite(workArea?.y)
  const width = Math.max(1, finite(workArea?.width, 1))
  const height = Math.max(1, finite(workArea?.height, 1))
  const safeMargin = Math.max(0, Math.min(finite(margin), width / 2, height / 2))
  return {
    x: x + safeMargin,
    y: y + safeMargin,
    width: Math.max(1, width - safeMargin * 2),
    height: Math.max(1, height - safeMargin * 2)
  }
}

export function boundsCenter(bounds) {
  return {
    x: finite(bounds?.x) + finite(bounds?.width) / 2,
    y: finite(bounds?.y) + finite(bounds?.height) / 2
  }
}

/**
 * 使用持久化的左上角坐标恢复/调整胶囊；尺寸变化只在越过安全区时修正位置。
 */
export function compactBoundsFromPosition({ position, size, workArea, margin } = {}) {
  const safeArea = insetWorkArea(workArea, margin)
  const normalizedSize = normalizeCompactSize(size, workArea)
  const width = Math.min(normalizedSize.width, safeArea.width)
  const height = Math.min(normalizedSize.height, safeArea.height)
  return roundBounds({
    x: clamp(finite(position?.x, safeArea.x), safeArea.x, safeArea.x + safeArea.width - width),
    y: clamp(finite(position?.y, safeArea.y), safeArea.y, safeArea.y + safeArea.height - height),
    width,
    height
  })
}

/**
 * 主视图主动收起时，胶囊只能落在主视图上边线的水平中心。
 * 这里故意不对 Y 做安全区修正，确保两条上边线严格重合。
 */
export function compactBoundsFromExpandedTop({ expandedBounds, size, workArea } = {}) {
  const safeArea = insetWorkArea(workArea)
  const normalizedSize = normalizeCompactSize(size, workArea)
  const centerX = finite(expandedBounds?.x) + finite(expandedBounds?.width) / 2
  return roundBounds({
    x: clamp(
      centerX - normalizedSize.width / 2,
      safeArea.x,
      safeArea.x + safeArea.width - normalizedSize.width
    ),
    y: finite(expandedBounds?.y),
    width: normalizedSize.width,
    height: normalizedSize.height
  })
}

export function mapCompactPositionToWorkArea({ position, previousWorkArea, nextWorkArea } = {}) {
  const previousSafe = insetWorkArea(previousWorkArea)
  const nextSafe = insetWorkArea(nextWorkArea)
  const ratioX = clamp((finite(position?.x) - previousSafe.x) / previousSafe.width, 0, 1)
  const ratioY = clamp((finite(position?.y) - previousSafe.y) / previousSafe.height, 0, 1)
  return {
    x: nextSafe.x + nextSafe.width * ratioX,
    y: nextSafe.y + nextSafe.height * ratioY
  }
}
