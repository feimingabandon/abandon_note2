const MODES = Object.freeze({
  EXPANDED: 'expanded',
  COMPACT: 'compact'
})

function isUsableWindow(window) {
  return Boolean(window && !window.isDestroyed?.())
}

function normalizeMode(mode) {
  if (mode === MODES.EXPANDED || mode === MODES.COMPACT) return mode
  throw new Error(`未知的灵动岛目标状态：${mode}`)
}

/**
 * 单窗口灵动岛协调器。
 *
 * 稳定状态只有 expanded / compact；动画步骤完全封装在一次 transition 中。
 * 连续请求只更新 desiredMode，当前事务收口后再处理用户最后一次意图。
 */
export class CompactWindowController {
  constructor({ onStateChanged = () => {}, onError = () => {} } = {}) {
    this.onStateChanged = onStateChanged
    this.onError = onError
    this.window = null
    this.committedMode = MODES.EXPANDED
    this.desiredMode = MODES.EXPANDED
    this.generation = 0
    this.transition = null
    this.requestPromise = null
  }

  get phase() {
    if (!this.transition) return this.committedMode
    return this.transition.to === MODES.COMPACT ? 'collapsing' : 'expanding'
  }

  initializeForWindow(window) {
    if (this.requestPromise) throw new Error('窗口呈现事务尚未结束，不能替换主视图窗口')
    this.generation += 1
    this.window = window
    this.committedMode = MODES.EXPANDED
    this.desiredMode = MODES.EXPANDED
    this.transition = null
    this.onStateChanged(this.snapshot())
    return this.snapshot()
  }

  snapshot() {
    return {
      phase: this.phase,
      committedMode: this.committedMode,
      desiredMode: this.desiredMode,
      transition: this.transitionSnapshot()
    }
  }

  transitionSnapshot() {
    return this.transition ? { ...this.transition } : null
  }

  isCompact() {
    return this.committedMode === MODES.COMPACT
  }

  isActive() {
    return this.isCompact() || Boolean(this.transition)
  }

  activePromise() {
    return this.requestPromise
  }

  publishTransition(window, generation) {
    if (!this.transition || this.window !== window || this.transition.generation !== generation) {
      return false
    }
    this.onStateChanged(this.snapshot())
    return true
  }

  request(window, mode, perform) {
    const targetMode = normalizeMode(mode)
    if (window !== this.window || !isUsableWindow(window)) {
      return Promise.resolve({ changed: false, mode: this.committedMode })
    }

    this.desiredMode = targetMode
    this.onStateChanged(this.snapshot())
    if (this.requestPromise) return this.requestPromise

    const operationWindow = window
    this.requestPromise = (async () => {
      let changed = false
      let value = null
      while (
        operationWindow === this.window &&
        isUsableWindow(operationWindow) &&
        this.desiredMode !== this.committedMode
      ) {
        const from = this.committedMode
        const to = this.desiredMode
        const generation = ++this.generation
        this.transition = {
          generation,
          from,
          to,
          startedAt: Date.now()
        }
        try {
          value = await perform({ window: operationWindow, generation, from, to })
          this.committedMode = to
          changed = true
        } catch (error) {
          this.desiredMode = this.committedMode
          this.onError(error, { transition: this.transitionSnapshot() })
          throw error
        } finally {
          this.transition = null
          this.onStateChanged(this.snapshot())
        }
      }
      return { changed, mode: this.committedMode, value }
    })().finally(() => {
      this.requestPromise = null
    })
    return this.requestPromise
  }

  cancelForWindowReplacement(window) {
    if (this.requestPromise) {
      throw new Error('窗口呈现事务尚未结束，不能销毁参与过渡的窗口')
    }
    if (this.window !== window) return null
    this.generation += 1
    this.window = null
    this.committedMode = MODES.EXPANDED
    this.desiredMode = MODES.EXPANDED
    this.transition = null
    this.onStateChanged(this.snapshot())
    return { status: 'window-replaced', window }
  }
}

export { MODES as COMPACT_WINDOW_MODES }
