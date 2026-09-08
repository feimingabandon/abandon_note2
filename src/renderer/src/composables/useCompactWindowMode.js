import { computed, ref } from 'vue'
import { createCompactTransitionDiagnostics } from './compact-transition-diagnostics.js'

const state = ref({
  supported: false,
  phase: 'expanded',
  compact: false,
  bounds: null,
  transition: null
})
let stopListener = null
let users = 0
let diagnostics = null
let stateRevision = 0

/** 单 Renderer 订阅共享窗口的稳定状态与分阶段呈现协议。 */
export function useCompactWindowMode() {
  const start = async () => {
    users += 1
    if (!stopListener) {
      diagnostics ||= createCompactTransitionDiagnostics()
      stopListener = window.api.onCompactWindowStateChanged?.((next) => {
        stateRevision += 1
        state.value = next || state.value
        diagnostics.update(state.value)
      })
    }
    const requestRevision = ++stateRevision
    const next = await window.api.getCompactWindowState?.()
    // 初始化查询不能覆盖查询期间收到的广播，也不能污染已经停止的新会话。
    if (users > 0 && requestRevision === stateRevision) {
      state.value = next || state.value
      diagnostics?.update(state.value)
    }
    return state.value
  }

  const stop = () => {
    users = Math.max(0, users - 1)
    if (users === 0) {
      stateRevision += 1
      diagnostics?.stop()
      stopListener?.()
      stopListener = null
    }
  }

  return {
    state,
    supported: computed(() => Boolean(state.value.supported)),
    phase: computed(() => state.value.phase),
    compact: computed(() => Boolean(state.value.compact)),
    changing: computed(() => !['expanded', 'compact'].includes(state.value.phase)),
    transition: computed(() => state.value.transition),
    stage: computed(() => state.value.transition?.stage || 'stable'),
    start,
    stop,
    enter: () => window.api.enterCompactWindow(),
    exit: () => window.api.exitCompactWindow()
  }
}
