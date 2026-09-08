/** 帮助页主动导航使用应用自己的时间曲线，不依赖 Chromium / 系统平滑滚动设置。 */
export function createHelpScrollMotion({
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
  now = () => performance.now()
} = {}) {
  let frame = null
  let settle = null

  function cancel() {
    if (frame !== null) cancelFrame(frame)
    frame = null
    settle?.(false)
    settle = null
  }

  function scroll(container, requestedTop) {
    cancel()
    const start = container.scrollTop
    const target = Math.min(
      Math.max(0, requestedTop),
      Math.max(0, container.scrollHeight - container.clientHeight)
    )
    const distance = target - start
    if (Math.abs(distance) < 1) return Promise.resolve(true)
    const duration = Math.min(900, 440 + Math.sqrt(Math.abs(distance)) * 5)
    const started = now()
    return new Promise((resolve) => {
      settle = resolve
      const step = (timestamp) => {
        const progress = Math.min(1, Math.max(0, (timestamp - started) / duration))
        const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
        container.scrollTop = start + distance * eased
        if (progress < 1) frame = requestFrame(step)
        else {
          frame = null
          settle = null
          resolve(true)
        }
      }
      frame = requestFrame(step)
    })
  }
  return { scroll, cancel }
}
