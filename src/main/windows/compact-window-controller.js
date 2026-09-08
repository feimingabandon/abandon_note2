const TRANSITION_STATUSES = Object.freeze({
  COMPLETED: 'completed',
  WINDOW_REPLACED: 'window-replaced',
  FAILED: 'failed'
})

const PRESENTATION_STAGES = Object.freeze({
  CONTENT_EXIT: 'content-exit',
  SHELL_TRANSFORM: 'shell-transform',
  SHELL_SETTLE: 'shell-settle',
  CONTENT_ENTER: 'content-enter'
})

const NEXT_PRESENTATION_STAGE = Object.freeze({
  [PRESENTATION_STAGES.CONTENT_EXIT]: PRESENTATION_STAGES.SHELL_TRANSFORM,
  [PRESENTATION_STAGES.SHELL_TRANSFORM]: PRESENTATION_STAGES.SHELL_SETTLE,
  [PRESENTATION_STAGES.SHELL_SETTLE]: PRESENTATION_STAGES.CONTENT_ENTER
})

function isUsableWindow(window) {
  return Boolean(window && !window.isDestroyed?.())
}

/**
 * 单 BrowserWindow 胶囊事务状态机。
 *
 * 这里只保存 phase、generation 和当前原生事务；原生层负责把同一个 Electron
 * 外壳交给固定尺寸的 Composition Overlay，真实 HWND 在透明期间一次就位。
 */
export class CompactWindowController {
  constructor({ onPhaseChanged = () => {}, onError = () => {} } = {}) {
    this.onPhaseChanged = onPhaseChanged
    this.onError = onError
    this.window = null
    this.phase = 'expanded'
    this.generation = 0
    this.transition = null
  }

  initializeForWindow(window, phase = 'expanded') {
    if (this.transition) throw new Error('原生窗口过渡尚未结束，不能替换主视图窗口')
    this.generation += 1
    this.window = window
    this.phase = phase
    this.onPhaseChanged(this.snapshot())
    return this.snapshot()
  }

  snapshot() {
    return {
      window: this.window,
      phase: this.phase,
      generation: this.generation,
      transitioning: Boolean(this.transition),
      transition: this.transitionSnapshot()
    }
  }

  transitionSnapshot() {
    const transition = this.transition
    if (!transition) return null
    return {
      generation: transition.generation,
      phase: transition.phase,
      from: { ...transition.from },
      target: { ...transition.target },
      duration: transition.duration,
      startedAt: transition.startedAt,
      stage: transition.stage
    }
  }

  setTransitionStage(window, generation, stage) {
    const transition = this.transition
    if (
      !transition ||
      transition.window !== window ||
      transition.generation !== generation ||
      !Object.values(PRESENTATION_STAGES).includes(stage)
    ) {
      return false
    }
    if (stage === transition.stage) return true
    if (NEXT_PRESENTATION_STAGE[transition.stage] !== stage) return false
    transition.stage = stage
    this.onPhaseChanged(this.snapshot())
    return true
  }

  isActive() {
    return this.phase !== 'expanded'
  }

  setPhase(window, phase) {
    if (window !== this.window || !isUsableWindow(window)) return false
    this.phase = phase
    this.onPhaseChanged(this.snapshot())
    return true
  }

  activePromise() {
    return this.transition?.promise || null
  }

  isCurrentResult(result) {
    return Boolean(result && result.window === this.window && result.generation === this.generation)
  }

  complete(result, phase) {
    if (result?.status !== TRANSITION_STATUSES.COMPLETED || !this.isCurrentResult(result)) {
      return false
    }
    return this.setPhase(result.window, phase)
  }

  /**
   * 登记一个不可中途取消的原生事务。executor 只提交一次原生同步几何过渡；
   * phase 和持久化由调用方在结果返回后收口。
   */
  run(window, { from, target, duration, phase }, executor) {
    if (this.transition) return this.transition.promise
    if (window !== this.window || !isUsableWindow(window)) {
      return Promise.resolve({
        status: TRANSITION_STATUSES.WINDOW_REPLACED,
        generation: this.generation,
        window,
        from,
        target,
        phase,
        error: null
      })
    }

    const generation = ++this.generation
    const transition = {
      generation,
      window,
      from: { ...from },
      target: { ...target },
      duration,
      phase,
      stage: PRESENTATION_STAGES.CONTENT_EXIT,
      startedAt: Date.now(),
      promise: null
    }
    this.transition = transition
    this.phase = phase
    transition.promise = Promise.resolve()
      .then(executor)
      .then((value) => ({
        status: TRANSITION_STATUSES.COMPLETED,
        generation,
        window,
        from: transition.from,
        target: transition.target,
        phase,
        value,
        error: null
      }))
      .catch((error) => {
        // 诊断只传普通快照，不能遍历 BrowserWindow / WebContents 的原生属性。
        this.onError(error, {
          operation: 'native-transition',
          transition: this.transitionSnapshot()
        })
        return {
          status: TRANSITION_STATUSES.FAILED,
          generation,
          window,
          from: transition.from,
          target: transition.target,
          phase,
          error
        }
      })
      .finally(() => {
        if (this.transition === transition) this.transition = null
      })

    this.onPhaseChanged(this.snapshot())
    return transition.promise
  }

  cancelForWindowReplacement(window) {
    if (this.transition) {
      throw new Error('原生窗口过渡尚未结束，不能销毁参与过渡的窗口')
    }
    if (this.window !== window) return null
    this.generation += 1
    this.window = null
    this.onPhaseChanged(this.snapshot())
    return { status: TRANSITION_STATUSES.WINDOW_REPLACED, window }
  }
}

export { PRESENTATION_STAGES, TRANSITION_STATUSES }
