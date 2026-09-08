/**
 * Renderer 已确认目标视口和布局帧；CopyOutput 继续确认合成器已生成画面。
 * 只读回中心 1 DIP 方块，保留合成屏障而避免整窗像素传回 CPU。
 * 不保存图像，也不把它当作屏幕实际呈现时间。目标页面在外壳运动期间准备，
 * 读回完成只是交接条件之一，仍需等待原生动画结束。
 */
export async function prepareCompactTargetFrame(window, timeoutMs = 2000) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    throw new Error('目标窗口已销毁')
  }
  let timer
  try {
    const [width, height] = window.getContentSize()
    const rect = { x: Math.floor(width / 2), y: Math.floor(height / 2), width: 1, height: 1 }
    const image = await Promise.race([
      window.webContents.capturePage(rect, { stayHidden: true, stayAwake: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('目标窗口合成帧准备超时')), timeoutMs)
      })
    ])
    if (window.isDestroyed() || window.webContents.isDestroyed() || image.isEmpty()) {
      throw new Error('目标窗口没有生成有效合成帧')
    }
    return image.getSize()
  } finally {
    clearTimeout(timer)
  }
}
