import { computed, ref } from 'vue'

const state = ref({
  supported: false,
  mode: 'expanded',
  desiredMode: 'expanded',
  operation: null,
  bounds: null
})
let users = 0
let revision = 0
let stopStateListener = null
let stopRecoveryListener = null

export function usePresentationMode() {
  async function start() {
    users += 1
    if (!stopStateListener) {
      stopStateListener = window.api.onPresentationModeStateChanged?.((next) => {
        revision += 1
        if (next) state.value = next
      })
      stopRecoveryListener = window.api.onPresentationModeForceExpanded?.(() => {
        revision += 1
        state.value = {
          ...state.value,
          mode: 'expanded',
          desiredMode: 'expanded',
          operation: null
        }
      })
    }
    const requestRevision = ++revision
    const next = await window.api.getPresentationModeState?.()
    if (users > 0 && requestRevision === revision && next) state.value = next
    return state.value
  }

  function stop() {
    users = Math.max(0, users - 1)
    if (users !== 0) return
    revision += 1
    stopStateListener?.()
    stopRecoveryListener?.()
    stopStateListener = null
    stopRecoveryListener = null
  }

  return {
    state,
    supported: computed(() => Boolean(state.value.supported)),
    mode: computed(() => state.value.mode || 'expanded'),
    displayMode: computed(() => state.value.operation?.to || state.value.mode || 'expanded'),
    operation: computed(() => state.value.operation),
    changing: computed(() => Boolean(state.value.operation)),
    start,
    stop,
    enter: (anchor) => window.api.enterCompactPresentation(anchor),
    exit: () => window.api.exitCompactPresentation()
  }
}
