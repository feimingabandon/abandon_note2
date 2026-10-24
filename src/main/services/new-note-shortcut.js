/** Coalesces window-opening work; the current renderer owns its existing form/draft. */
export function createNewNoteShortcut({ canOpen, openWindow, getWindow, isReady }) {
  let pending = null
  function trigger() {
    if (!canOpen()) return Promise.resolve(false)
    if (pending) return pending
    pending = (async () => {
      if (!(await openWindow()) || !canOpen()) return false
      const window = getWindow()
      if (!window || window.isDestroyed() || !isReady(window)) return false
      window.webContents.send('notes:new-requested')
      return true
    })().finally(() => {
      pending = null
    })
    return pending
  }
  return { trigger }
}
