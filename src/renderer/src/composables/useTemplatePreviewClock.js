import { onScopeDispose, watch } from 'vue'

/** Refresh only when a boundary expires, while the local clock keeps validation current. */
export function useTemplatePreviewClock({
  active,
  now,
  previewAt,
  endAt,
  relativeStart = () => false,
  refresh
}) {
  let timer = null
  let expiredKey = null
  let previousDay = new Date(now.value).toDateString()
  function stop() {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
  function sync() {
    now.value = Date.now()
    const day = new Date(now.value).toDateString()
    const dayChanged = day !== previousDay
    previousDay = day
    // A relative start anchors every-N-day rules to the current save's calendar day.
    if (dayChanged && relativeStart()) {
      refresh()
      return
    }
    const candidate = Number(previewAt.value)
    const end = Number(endAt.value)
    const candidateExpired =
      previewAt.value !== null && Number.isFinite(candidate) && candidate <= now.value
    const endExpired = endAt.value !== null && Number.isFinite(end) && end <= now.value
    if (!candidateExpired && !endExpired) {
      if (previewAt.value !== null) expiredKey = null
      return
    }
    const key = endExpired ? `end:${end}` : `next:${candidate}`
    if (expiredKey !== key) {
      expiredKey = key
      refresh()
    }
  }
  function onFocus() {
    if (!active()) return
    now.value = Date.now()
    previousDay = new Date(now.value).toDateString()
    expiredKey = null
    refresh()
  }
  watch(
    active,
    (value) => {
      stop()
      if (!value) return
      onFocus()
      timer = setInterval(sync, 1000)
    },
    { immediate: true, flush: 'sync' }
  )
  window.addEventListener('focus', onFocus)
  onScopeDispose(() => {
    stop()
    window.removeEventListener('focus', onFocus)
  })
  return { sync }
}
