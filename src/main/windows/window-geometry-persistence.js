import { getPersistableWindowBounds } from '../window-bounds.js'

/** Ordinary geometry owns its timer and stable snapshot. Dock/compact state stays in its runtime. */
export function createWindowGeometryPersistence({
  getWindow,
  canSchedule,
  isDockSuppressed,
  readDockBounds,
  persistValues,
  persistStoredBounds,
  onError,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let timer = null
  let dirty = false
  let stableBounds = null
  let suppressionDeadline = 0
  const liveWindow = () => {
    const window = getWindow()
    return window && !window.isDestroyed() ? window : null
  }
  const entries = (bounds) => [
    { id: 'geometry.posX', value: bounds.x },
    { id: 'geometry.posY', value: bounds.y },
    { id: 'geometry.width', value: bounds.width },
    { id: 'geometry.height', value: bounds.height }
  ]
  const cancel = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const readPendingBounds = () => {
    const window = liveWindow()
    return dirty && window
      ? getPersistableWindowBounds({
          dockStableBounds: readDockBounds(),
          lastVisibleBounds: stableBounds,
          currentBounds: window.getBounds()
        })
      : null
  }
  const save = (bounds) => {
    persistValues(entries(bounds))
    dirty = false
  }
  return {
    getStableBounds: () => (stableBounds ? { ...stableBounds } : null),
    setStableBounds: (bounds) => {
      stableBounds = bounds ? { ...bounds } : null
    },
    isDirty: () => dirty,
    markDirty: () => {
      dirty = true
    },
    markSaved: () => {
      dirty = false
    },
    getSuppressionDeadline: () => suppressionDeadline,
    suppressUntil: (deadline) => {
      suppressionDeadline = deadline
    },
    cancel,
    readPendingBounds,
    save,
    schedule() {
      if (!canSchedule() || now() < suppressionDeadline || isDockSuppressed()) return
      const window = liveWindow()
      if (!window) return
      stableBounds = { ...window.getBounds() }
      dirty = true
      cancel()
      timer = setTimer(() => {
        timer = null
        if (now() < suppressionDeadline || isDockSuppressed()) return
        const current = liveWindow()
        if (!current) return
        try {
          save(readDockBounds() || stableBounds || current.getBounds())
        } catch (error) {
          onError(error, 'debounce')
        }
      }, 500)
    },
    persistStableBounds(bounds) {
      const normalized = Object.fromEntries(
        Object.entries(bounds).map(([key, value]) => [key, Math.round(Number(value))])
      )
      persistStoredBounds(entries(normalized))
      stableBounds = { ...normalized }
      dirty = false
      return normalized
    },
    flush() {
      cancel()
      const bounds = readPendingBounds()
      if (!bounds) return false
      persistStoredBounds(entries(bounds))
      dirty = false
      return true
    }
  }
}
