function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function finiteNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 将持久化窗口边界约束到当前显示器工作区，避免显示器拓扑变化后窗口落在屏幕外。
 */
export function constrainMainWindowBounds(
  bounds,
  workArea,
  { minWidth = 240, minHeight = 240 } = {}
) {
  const area = {
    x: Math.round(finiteNumber(workArea?.x, 0)),
    y: Math.round(finiteNumber(workArea?.y, 0)),
    width: Math.max(1, Math.round(finiteNumber(workArea?.width, 1))),
    height: Math.max(1, Math.round(finiteNumber(workArea?.height, 1)))
  }
  const width = Math.min(
    area.width,
    Math.max(Math.min(minWidth, area.width), Math.round(finiteNumber(bounds?.width, minWidth)))
  )
  const height = Math.min(
    area.height,
    Math.max(Math.min(minHeight, area.height), Math.round(finiteNumber(bounds?.height, minHeight)))
  )
  const maxX = area.x + area.width - width
  const maxY = area.y + area.height - height

  return {
    x: Math.round(clamp(finiteNumber(bounds?.x, area.x), area.x, maxX)),
    y: Math.round(clamp(finiteNumber(bounds?.y, area.y), area.y, maxY)),
    width,
    height
  }
}
