/** 收放请求只保留最后目标；一次原生事务完整交接后再处理下一目标。 */
export class CompactIntent {
  constructor({ getWindow, isCompact, apply }) {
    this.getWindow = getWindow
    this.isCompact = isCompact
    this.apply = apply
    this.pending = null
  }

  request(compact) {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return Promise.resolve({ changed: false })
    if (this.pending) {
      if (this.pending.window !== window) return Promise.resolve({ changed: false })
      this.pending.compact = compact
      return this.pending.promise
    }
    const request = { window, compact, promise: null }
    this.pending = request
    request.promise = Promise.resolve()
      .then(async () => {
        let result = { changed: false }
        while (this.getWindow() === window && !window.isDestroyed()) {
          const target = request.compact
          if (target === this.isCompact()) break
          result = await this.apply(target)
          // 无法切换（窗口锁定、销毁等）不能形成重试死循环。
          if (!result?.changed) break
        }
        return result
      })
      .finally(() => {
        if (this.pending === request) this.pending = null
      })
    return request.promise
  }

  toggle() {
    return this.request(!(this.pending?.compact ?? this.isCompact()))
  }
}
