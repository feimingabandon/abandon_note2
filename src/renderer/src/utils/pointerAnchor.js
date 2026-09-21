function rectValue(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function plainRect(rect = {}) {
  const left = rectValue(rect.left)
  const top = rectValue(rect.top)
  const width = Math.max(0, rectValue(rect.width, rectValue(rect.right) - left))
  const height = Math.max(0, rectValue(rect.height, rectValue(rect.bottom) - top))
  return {
    left,
    top,
    right: rectValue(rect.right, left + width),
    bottom: rectValue(rect.bottom, top + height),
    width,
    height
  }
}

/** 鼠标触发时返回点击点；键盘或程序触发时保留控件矩形。 */
export function pointerAnchorRect(event, fallbackRect) {
  const clientX = Number(event?.clientX)
  const clientY = Number(event?.clientY)
  if (Number(event?.detail) > 0 && Number.isFinite(clientX) && Number.isFinite(clientY)) {
    return {
      left: clientX,
      top: clientY,
      right: clientX,
      bottom: clientY,
      width: 0,
      height: 0
    }
  }
  return plainRect(fallbackRect)
}
