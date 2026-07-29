function verticalOverlap(first, second) {
  const top = Math.max(first.y, second.y)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  return bottom > top
}

/**
 * 非 Windows 平台使用 Electron 的统一坐标检查真实外边缘。
 * Windows 由原生后端在物理像素空间执行同一判断，避免混合 DPI 坐标歧义。
 */
export function isDisplayEdgeExposed(display, displays, side, windowBounds) {
  if (!display?.bounds || !display?.workArea || !windowBounds) return false
  if (side !== 'left' && side !== 'right') return false

  const displayEdge = side === 'left' ? display.bounds.x : display.bounds.x + display.bounds.width
  const workAreaEdge =
    side === 'left' ? display.workArea.x : display.workArea.x + display.workArea.width
  if (displayEdge !== workAreaEdge) return false

  return !(displays || []).some((candidate) => {
    if (!candidate?.bounds || candidate.id === display.id) return false
    const touches =
      side === 'left'
        ? candidate.bounds.x + candidate.bounds.width === displayEdge
        : candidate.bounds.x === displayEdge
    return touches && verticalOverlap(windowBounds, candidate.bounds)
  })
}
