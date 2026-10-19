import { ref, readonly } from 'vue'

/** One refresh generation shared by all three list modes. */
export function useNoteListQuerySession({ getFilters }) {
  let sequence = 0
  let disposed = false
  const invalidations = new Set()
  const loading = ref(false),
    loadError = ref(null)
  const allNoteTotal = ref(0),
    lastRefreshedAt = ref(null)
  function invalidate() {
    sequence++
    for (const callback of invalidations) callback()
  }
  function isCurrent(token) {
    return !disposed && token === sequence
  }
  return {
    loading: readonly(loading),
    loadError: readonly(loadError),
    allNoteTotal: readonly(allNoteTotal),
    lastRefreshedAt: readonly(lastRefreshedAt),
    get sequence() {
      return sequence
    },
    get disposed() {
      return disposed
    },
    filters() {
      const { statuses, tagIds } = getFilters()
      return {
        statuses: statuses.length ? [...statuses] : ['initialized', 'in_progress', 'completed'],
        tagIds: tagIds.length ? [...tagIds] : null
      }
    },
    begin({ showLoading = true } = {}) {
      invalidate()
      loadError.value = null
      if (showLoading) loading.value = true
      return sequence
    },
    isCurrent,
    invalidate,
    onInvalidate(callback) {
      invalidations.add(callback)
      return () => invalidations.delete(callback)
    },
    finish(token) {
      if (isCurrent(token)) loading.value = false
    },
    fail(token, error, show = true) {
      if (isCurrent(token) && show) loadError.value = error
    },
    setTotal(total) {
      allNoteTotal.value = Number(total) || 0
    },
    markRefreshed() {
      lastRefreshedAt.value = Date.now()
    },
    dispose() {
      disposed = true
      invalidate()
      invalidations.clear()
    }
  }
}
