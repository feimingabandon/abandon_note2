import { computed, ref } from 'vue'

const state = ref({
  supported: false,
  phase: 'expanded',
  mode: 'expanded',
  presentation: null,
  transition: null
})
let stopListener = null
let users = 0
let stateRevision = 0

/** 单 Renderer 订阅同一 BrowserWindow 的稳定模式与单次呈现事务。 */
export function useCompactWindowMode() {
  const start = async () => {
    users += 1
    if (!stopListener) {
      stopListener = window.api.onCompactWindowStateChanged?.((next) => {
        stateRevision += 1
        state.value = next || state.value
      })
    }
    const requestRevision = ++stateRevision
    const next = await window.api.getCompactWindowState?.()
    // 初始化查询不能覆盖查询期间收到的广播，也不能污染已经停止的新会话。
    if (users > 0 && requestRevision === stateRevision) {
      state.value = next || state.value
    }
    return state.value
  }

  const stop = () => {
    users = Math.max(0, users - 1)
    if (users === 0) {
      stateRevision += 1
      stopListener?.()
      stopListener = null
    }
  }

  return {
    state,
    supported: computed(() => Boolean(state.value.supported)),
    mode: computed(() => state.value.mode || 'expanded'),
    phase: computed(() => state.value.phase),
    changing: computed(() => Boolean(state.value.transition)),
    transition: computed(() => state.value.transition),
    presentation: computed(() => state.value.presentation),
    start,
    stop,
    enter: () => window.api.enterCompactWindow(),
    exit: () => window.api.exitCompactWindow()
  }
}
