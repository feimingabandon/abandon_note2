/** 模板调度服务级故障保护：连续失败告警、告警后降频、成功后恢复。 */
export class TemplateSchedulerGuard {
  constructor({ failureThreshold = 3, retryDelayMs = 5 * 60 * 1000, onAlert = () => {} } = {}) {
    this.failureThreshold = Math.max(1, Math.trunc(Number(failureThreshold)) || 3)
    this.retryDelayMs = Math.max(60_000, Math.trunc(Number(retryDelayMs)) || 5 * 60 * 1000)
    this.onAlert = onAlert
    this.consecutiveFailures = 0
    this.nextRetryAt = 0
    this.alerted = false
  }

  shouldRun(timestamp = Date.now()) {
    return Number(timestamp) >= this.nextRetryAt
  }

  run(operation, timestamp = Date.now()) {
    const attemptedAt = Number(timestamp)
    try {
      const result = operation()
      this.consecutiveFailures = 0
      this.nextRetryAt = 0
      this.alerted = false
      return result
    } catch (error) {
      this.consecutiveFailures += 1
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.nextRetryAt = attemptedAt + this.retryDelayMs
        if (!this.alerted) {
          this.onAlert(error, this.consecutiveFailures)
          this.alerted = true
        }
      }
      throw error
    }
  }
}
