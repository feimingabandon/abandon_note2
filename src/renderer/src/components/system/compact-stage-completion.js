const DEFAULT_RETRY_INTERVAL_MS = 50
const DEFAULT_MAX_WAIT_MS = 1800

/**
 * transitionend 在窗口缩放、遮挡或 Runner 调度繁忙时可能丢失。
 * 首次兜底检查未到终点时继续短间隔复查，但仍由主进程的阶段超时负责最终失败。
 */
export function pollCompactStageEndpoint({
  initialDelayMs,
  isCurrent,
  isAtEndpoint,
  onReady,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = () => performance.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer)
}) {
  const startedAt = now()
  let timer = null
  let stopped = false

  const stop = () => {
    stopped = true
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  const check = () => {
    timer = null
    if (stopped || !isCurrent()) return
    if (isAtEndpoint()) {
      stopped = true
      onReady()
      return
    }
    const remainingMs = maxWaitMs - (now() - startedAt)
    if (remainingMs <= 0) return
    timer = setTimer(check, Math.min(retryIntervalMs, remainingMs))
  }

  timer = setTimer(check, Math.max(0, initialDelayMs))
  return stop
}
