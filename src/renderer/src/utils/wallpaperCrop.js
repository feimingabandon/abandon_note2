const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** 将屏幕上的裁剪框精确映射回原图像素坐标。 */
export function mapFrameToSource({ frame, imageRect, renderScale, imageSize }) {
  if (!Number.isFinite(renderScale) || renderScale <= 0) throw new Error('无效的图片缩放比例')
  const x = clamp((frame.x - imageRect.x) / renderScale, 0, imageSize.width)
  const y = clamp((frame.y - imageRect.y) / renderScale, 0, imageSize.height)
  return {
    x,
    y,
    width: Math.min(frame.width / renderScale, imageSize.width - x),
    height: Math.min(frame.height / renderScale, imageSize.height - y)
  }
}

/** 在给定边界内生成与主窗口同宽高比的最大裁剪框。 */
export function fitAspectFrame({ bounds, stage, ratio, fill = 0.82 }) {
  let width = Math.min(bounds.width * fill, stage.width * 0.78)
  let height = width / ratio
  const maxHeight = Math.min(bounds.height * fill, stage.height * 0.78)
  if (height > maxHeight) {
    height = maxHeight
    width = height * ratio
  }
  return { width: Math.max(40, width), height: Math.max(40, height) }
}

/**
 * 将裁剪框限制在“图片与裁剪舞台的可见交集”内。
 * 图片放大后可以超出舞台，但裁剪框自身始终必须完整可见、可继续拖动。
 */
export function constrainFrameToVisibleBounds({ frame, imageRect, stage }) {
  const visibleLeft = Math.max(0, imageRect.x)
  const visibleTop = Math.max(0, imageRect.y)
  const visibleRight = Math.min(stage.width, imageRect.x + imageRect.width)
  const visibleBottom = Math.min(stage.height, imageRect.y + imageRect.height)
  const maxX = Math.max(visibleLeft, visibleRight - frame.width)
  const maxY = Math.max(visibleTop, visibleBottom - frame.height)

  return {
    x: clamp(frame.x, visibleLeft, maxX),
    y: clamp(frame.y, visibleTop, maxY)
  }
}
