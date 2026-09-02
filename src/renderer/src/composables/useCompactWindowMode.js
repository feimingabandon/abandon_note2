import { computed, ref } from 'vue'

const state = ref({
  supported: false,
  phase: 'expanded',
  compact: false,
  bounds: null,
  transition: null
})
let stopListener = null
let users = 0

/** 单 Renderer 订阅共享窗口的稳定状态与三阶段呈现协议。 */
export function useCompactWindowMode() {
  const start = async () => {
    users += 1
    if (!stopListener) {
      stopListener = window.api.onCompactWindowStateChanged?.((next) => {
        state.value = next || state.value
      })
    }
    const next = (await window.api.getCompactWindowState?.()) || state.value
    state.value = next
    return state.value
  }

  const stop = () => {
    users = Math.max(0, users - 1)
    if (users === 0) {
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
