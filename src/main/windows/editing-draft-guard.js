/** Negotiate with the application's own dialog; never lock the native parent window. */
export function createEditingDraftGuard({ logger, reveal = () => {} }) {
  let pending = null
  return (window, action) => {
    if (pending) return pending
    pending = (async () => {
      if (!window || window.isDestroyed() || window.webContents.isCrashed()) return true
      const contents = window.webContents
      let cancelled = false
      let cancelRequest
      const cancellation = new Promise((resolve) => {
        cancelRequest = resolve
      })
      function cancel() {
        cancelled = true
        cancelRequest(false)
        if (!window.isDestroyed() && !contents.isDestroyed?.() && !contents.isCrashed()) {
          void contents
            .executeJavaScript('window.__cancelEditingDraftConfirmation?.()')
            .catch(() => {})
        }
      }
      function onNavigation(_event, _url, _inPlace, isMainFrame) {
        if (isMainFrame) cancel()
      }
      function notify(text) {
        if (!cancelled && !window.isDestroyed())
          contents.send?.('app:message', { type: 'warning', text })
      }
      async function readState() {
        let timer
        try {
          return await Promise.race([
            contents.executeJavaScript(
              'window.__prepareEditingDrafts?.() ?? { dirty: false, blocked: false }'
            ),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('草稿检查超时')), 3000)
            })
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      async function negotiate() {
        try {
          const state = await readState()
          if (cancelled) return false
          if (!state.dirty && !state.blocked) return true
          await reveal(window)
          if (cancelled) return false
          if (state.blocked) {
            notify('正在保存或草稿暂存失败，请先完成保存，再' + action + '。')
            return false
          }
          const accepted = await contents.executeJavaScript(
            'window.__confirmEditingDrafts(' + JSON.stringify(action) + ')'
          )
          if (!accepted || cancelled) return false
          // Attachments or another save may finish while the dialog is open.
          const latest = await readState()
          if (cancelled) return false
          if (latest.blocked) {
            notify('草稿尚未安全暂存，请先保存内容后重试。')
            return false
          }
          return true
        } catch (error) {
          if (!cancelled) {
            logger.error('editing-draft.guard', error)
            notify('暂时无法确认草稿已安全暂存，本次操作已取消，请保存内容后重试。')
          }
          return false
        }
      }
      window.on?.('closed', cancel)
      window.on?.('hide', cancel)
      contents.on?.('render-process-gone', cancel)
      contents.on?.('did-start-navigation', onNavigation)
      try {
        return await Promise.race([negotiate(), cancellation])
      } finally {
        window.removeListener?.('closed', cancel)
        window.removeListener?.('hide', cancel)
        contents.removeListener?.('render-process-gone', cancel)
        contents.removeListener?.('did-start-navigation', onNavigation)
      }
    })().finally(() => {
      pending = null
    })
    return pending
  }
}
