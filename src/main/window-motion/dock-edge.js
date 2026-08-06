function verticalOverlap(first, second) {
  const top = Math.max(first.y, second.y)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  return bottom > top
}

function horizontalOverlap(first, second) {
  const left = Math.max(first.x, second.x)
  const right = Math.min(first.x + first.width, second.x + second.width)
  return right > left
}

/**
 * 非 Windows 平台使用 Electron 的统一坐标检查真实外边缘。
 * Windows 由原生后端在物理像素空间执行同一判断，避免混合 DPI 坐标歧义。
 */
export function isDisplayEdgeExposed(display, displays, side, windowBounds) {
  if (!display?.bounds || !display?.workArea || !windowBounds) return false
  if (!['left', 'right', 'top', 'bottom'].includes(side)) return false

  const verticalSide = side === 'top' || side === 'bottom'

  const displayEdge = verticalSide
    ? side === 'top'
      ? display.bounds.y
      : display.bounds.y + display.bounds.height
    : side === 'left'
      ? display.bounds.x
      : display.bounds.x + display.bounds.width
  const workAreaEdge = verticalSide
    ? side === 'top'
      ? display.workArea.y
      : display.workArea.y + display.workArea.height
    : side === 'left'
      ? display.workArea.x
      : display.workArea.x + display.workArea.width
  if (displayEdge !== workAreaEdge) return false

  return !(displays || []).some((candidate) => {
    if (!candidate?.bounds || candidate.id === display.id) return false
    const touches = verticalSide
      ? side === 'top'
        ? candidate.bounds.y + candidate.bounds.height === displayEdge
        : candidate.bounds.y === displayEdge
      : side === 'left'
        ? candidate.bounds.x + candidate.bounds.width === displayEdge
        : candidate.bounds.x === displayEdge
    return (
      touches &&
      (verticalSide
        ? horizontalOverlap(windowBounds, candidate.bounds)
        : verticalOverlap(windowBounds, candidate.bounds))
    )
  })
}
