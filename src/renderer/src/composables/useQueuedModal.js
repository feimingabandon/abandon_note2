import { computed, nextTick, onBeforeUnmount, ref, toValue, watch, watchPostEffect } from 'vue'
import { modalQueue } from '../utils/modalQueue.js'

// Requested and displayed are deliberately separate: a waiting dialog must not
// mount its form, acquire blur, focus an input, or register a draft editor.
export function useQueuedModal(requested, { child = false, external = false } = {}) {
  const granted = ref(false)
  let release = null
  let disposed = false
  let presented = false
  let generation = 0
  const visible = computed(() => Boolean(toValue(requested)) && granted.value)

  function finishLeave() {
    if (visible.value) return // A reversed transition still owns its ticket.
    granted.value = false
    presented = false
    const done = release
    release = null
    generation++ // Invalidate callbacks before deferred queue removal.
    // Unmount cleanup and focus restoration finish before the next activation.
    if (done) void nextTick(done)
  }

  watch(
    () => Boolean(toValue(requested)),
    (open) => {
      if (open && !release && !disposed) {
        const requestGeneration = ++generation
        if (toValue(child)) {
          release = modalQueue.hold()
          granted.value = true
        } else {
          release = modalQueue.enqueue(() => {
            if (!disposed && requestGeneration === generation && toValue(requested)) {
              granted.value = true
            }
          })
        }
      } else if (!open && !granted.value) {
        finishLeave() // Cancel a request that never reached the screen.
      }
    },
    { immediate: true, flush: 'sync' }
  )

  watchPostEffect(() => {
    if (visible.value && !external) presented = true
    else if (!toValue(requested) && !presented) finishLeave() // Cancelled before rendering.
  })

  onBeforeUnmount(() => {
    disposed = true
    granted.value = false
    finishLeave()
  })
  return {
    visible,
    finishLeave,
    markPresented: () => {
      presented = true
    }
  }
}

// Register at the source of the request, before Vue batches child prop updates.
// Pass this controller to AppModalShell (through business wrappers) as `queue`.
export function useModalRequest(initial = false) {
  const requested = ref(initial)
  return { requested, ...useQueuedModal(requested, { external: true }) }
}
