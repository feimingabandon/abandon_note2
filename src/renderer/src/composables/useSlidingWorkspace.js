import { computed, nextTick, onUnmounted, ref } from 'vue'

const FALLBACK_PADDING_MS = 80

function parseTime(value) {
  const normalized = String(value || '').trim()
  if (normalized.endsWith('ms')) return Number.parseFloat(normalized) || 0
  if (normalized.endsWith('s')) return (Number.parseFloat(normalized) || 0) * 1000
  return 0
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function getTransitionTotalMs(element, propertyName = 'transform') {
  if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return 0
  }
  const style = window.getComputedStyle(element)
  const properties = splitList(style.transitionProperty)
  const durations = splitList(style.transitionDuration).map(parseTime)
  const delays = splitList(style.transitionDelay).map(parseTime)
  const count = Math.max(properties.length, durations.length, delays.length)
  let maximum = 0
  for (let index = 0; index < count; index += 1) {
    const property = properties[index % Math.max(1, properties.length)] || 'all'
    if (property !== 'all' && property !== propertyName) continue
    const duration = durations[index % Math.max(1, durations.length)] || 0
    const delay = delays[index % Math.max(1, delays.length)] || 0
    maximum = Math.max(maximum, duration + delay)
  }
  return maximum
}

export function useSlidingWorkspace({ getElement, propertyName = 'transform' }) {
  const rendered = ref(false)
  const active = ref(false)
  const phase = ref('closed')
  const interactive = computed(() => phase.value === 'opening' || phase.value === 'open')
  let revision = 0
  let completionTimer = null

  function clearCompletionTimer() {
    if (completionTimer !== null) clearTimeout(completionTimer)
    completionTimer = null
  }

  function finish(expectedPhase, expectedRevision = revision) {
    if (expectedRevision !== revision || phase.value !== expectedPhase) return
    clearCompletionTimer()
    if (expectedPhase === 'opening' && active.value) {
      phase.value = 'open'
      return
    }
    if (expectedPhase === 'closing' && !active.value) {
      rendered.value = false
      phase.value = 'closed'
    }
  }

  function scheduleCompletion(expectedPhase, expectedRevision) {
    clearCompletionTimer()
    const transitionMs = getTransitionTotalMs(getElement?.(), propertyName)
    if (transitionMs <= 0) {
      queueMicrotask(() => finish(expectedPhase, expectedRevision))
      return
    }
    completionTimer = setTimeout(
      () => finish(expectedPhase, expectedRevision),
      transitionMs + FALLBACK_PADDING_MS
    )
  }

  async function open() {
    if (phase.value === 'opening' || phase.value === 'open') return
    const currentRevision = ++revision
    clearCompletionTimer()
    phase.value = 'opening'
    rendered.value = true
    await nextTick()
    if (currentRevision !== revision || phase.value !== 'opening') return
    void getElement?.()?.offsetWidth
    active.value = true
    scheduleCompletion('opening', currentRevision)
  }

  function close() {
    if (phase.value === 'closed' || phase.value === 'closing') return
    const currentRevision = ++revision
    clearCompletionTimer()
    phase.value = 'closing'
    active.value = false
    scheduleCompletion('closing', currentRevision)
  }

  function toggle() {
    if (phase.value === 'closed' || phase.value === 'closing') void open()
    else close()
  }

  function onTransitionComplete(event) {
    if (event.target !== getElement?.() || event.propertyName !== propertyName) return
    if (phase.value === 'opening') finish('opening')
    else if (phase.value === 'closing') finish('closing')
  }

  onUnmounted(() => {
    revision += 1
    clearCompletionTimer()
  })

  return {
    rendered,
    active,
    phase,
    interactive,
    open,
    close,
    toggle,
    onTransitionEnd: onTransitionComplete,
    onTransitionCancel: onTransitionComplete
  }
}
