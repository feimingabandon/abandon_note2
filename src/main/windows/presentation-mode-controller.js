export const PRESENTATION_MODES = Object.freeze({
  EXPANDED: 'expanded',
  COMPACT: 'compact'
})

function normalizeMode(mode) {
  if (Object.values(PRESENTATION_MODES).includes(mode)) return mode
  throw new Error(`未知的窗口展示模式：${mode}`)
}

function usableWindow(window) {
  return Boolean(window && !window.isDestroyed?.())
}

/**
 * 只管理 expanded / compact 稳定状态和当前唯一操作。
 * 它不知道 Electron 几何、Renderer 或毛玻璃细节；这些由主进程的 perform/recover 事务负责。
 */
export class PresentationModeController {
  constructor({ onStateChanged = () => {}, onError = () => {} } = {}) {
    this.onStateChanged = onStateChanged
    this.onError = onError
    this.window = null
    this.committedMode = PRESENTATION_MODES.EXPANDED
    this.desiredMode = PRESENTATION_MODES.EXPANDED
    this.desiredContext = null
    this.operation = null
    this.operationId = 0
    this.requestPromise = null
  }

  initialize(window) {
    if (this.requestPromise) throw new Error('展示模式事务尚未结束')
    this.window = window
    this.committedMode = PRESENTATION_MODES.EXPANDED
    this.desiredMode = PRESENTATION_MODES.EXPANDED
    this.desiredContext = null
    this.operation = null
    this.onStateChanged(this.snapshot())
    return this.snapshot()
  }

  snapshot() {
    return {
      committedMode: this.committedMode,
      desiredMode: this.desiredMode,
      operation: this.operation ? { ...this.operation } : null
    }
  }

  isCompact() {
    return this.committedMode === PRESENTATION_MODES.COMPACT
  }

  isBusy() {
    return Boolean(this.operation)
  }

  activePromise() {
    return this.requestPromise
  }

  request(window, mode, context, { perform, recover }) {
    const targetMode = normalizeMode(mode)
    if (window !== this.window || !usableWindow(window)) {
      return Promise.resolve({ changed: false, mode: this.committedMode })
    }

    this.desiredMode = targetMode
    this.desiredContext = context || null
    this.onStateChanged(this.snapshot())
    if (this.requestPromise) return this.requestPromise

    const operationWindow = window
    this.requestPromise = (async () => {
      let changed = false
      let value = null
      while (
        operationWindow === this.window &&
        usableWindow(operationWindow) &&
        this.desiredMode !== this.committedMode
      ) {
        const from = this.committedMode
        const to = this.desiredMode
        const operation = {
          id: ++this.operationId,
          from,
          to,
          context: this.desiredContext,
          startedAt: Date.now()
        }
        this.operation = operation
        this.onStateChanged(this.snapshot())
        try {
          value = await perform({ window: operationWindow, operation: { ...operation } })
          this.committedMode = to
          changed = true
        } catch (error) {
          this.onError(error, { operation: { ...operation } })
          try {
            await recover?.({ window: operationWindow, operation: { ...operation }, error })
          } finally {
            // 任何失败都必须回到可交互的主视图，不允许残留半个灵动岛状态。
            this.committedMode = PRESENTATION_MODES.EXPANDED
            this.desiredMode = PRESENTATION_MODES.EXPANDED
            this.desiredContext = null
          }
          throw error
        } finally {
          this.operation = null
          this.onStateChanged(this.snapshot())
        }
      }
      return { changed, mode: this.committedMode, value }
    })().finally(() => {
      this.requestPromise = null
    })
    return this.requestPromise
  }
}
