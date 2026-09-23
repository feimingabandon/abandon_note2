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

/**
 * 比较当前边界与约束后的目标边界，避免显示器指标事件无条件重提交窗口尺寸。
 * 只有工作区确实容不下当前窗口时，才允许调用 setBounds 改变宽高。
 */
export function getWindowBoundsUpdate(currentBounds, nextBounds) {
  if (
    currentBounds.x === nextBounds.x &&
    currentBounds.y === nextBounds.y &&
    currentBounds.width === nextBounds.width &&
    currentBounds.height === nextBounds.height
  ) {
    return { mode: 'none' }
  }

  if (currentBounds.width === nextBounds.width && currentBounds.height === nextBounds.height) {
    return { mode: 'position', x: nextBounds.x, y: nextBounds.y }
  }

  return { mode: 'bounds', bounds: { ...nextBounds } }
}

/** 退出保存时永远优先使用最后一个已知可见边界，不能把贴边动画帧写入设置。 */
export function getPersistableWindowBounds({
  dockStableBounds = null,
  lastVisibleBounds = null,
  currentBounds = null
} = {}) {
  const selected = dockStableBounds || lastVisibleBounds || currentBounds
  return selected ? { ...selected } : null
}
