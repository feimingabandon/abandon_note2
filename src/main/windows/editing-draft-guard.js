/** Negotiate with the application's own dialog; never lock the native parent window. */
export function createEditingDraftGuard({
  logger,
  reveal = () => {},
  prepareSettingsOperations = () => {},
  resumeSettingsOperations = () => {}
}) {
  let pending = null
  let pendingOwner = null
  let sequence = 0
  let heldPreparation = null

  function hasCurrentDocument(preparation) {
    try {
      const { window, contents, frame } = preparation
      return Boolean(
        !preparation.documentInvalidated &&
        !window.isDestroyed() &&
        window.webContents === contents &&
        !contents.isDestroyed?.() &&
        !contents.isCrashed() &&
        frame &&
        !frame.isDestroyed() &&
        !frame.detached &&
        contents.mainFrame === frame
      )
    } catch {
      return false
    }
  }

  function execute(preparation, code) {
    if (!hasCurrentDocument(preparation)) {
      const error = new Error('草稿检查所属页面已失效')
      error.code = 'PAGE_LEAVE_DOCUMENT_EXPIRED'
      throw error
    }
    // WebContents.executeJavaScript waits for all page loading to stop. Capture
    // one actual frame instead; never borrow a replacement document for this ID.
    return preparation.frame.executeJavaScript(code)
  }

  function resume(window, owner = null) {
    const preparation = heldPreparation
    if (!preparation || preparation.window !== window || preparation.owner !== owner) return
    heldPreparation = null
    const reportFailure = (error) => {
      if (hasCurrentDocument(preparation)) logger.error('page-leave.resume', error)
    }
    try {
      // Main-process ownership always releases, even when its original document
      // has already been replaced. Renderer cleanup may only target that document.
      try {
        resumeSettingsOperations(preparation)
      } catch (error) {
        logger.error('page-leave.settings-resume', error)
      }
      if (!hasCurrentDocument(preparation)) return
      try {
        // Recovery never waits for an unresponsive renderer to acknowledge cancel.
        void Promise.resolve(
          execute(preparation, `window.__cancelPageLeave?.(${JSON.stringify(preparation.id)})`)
        ).catch(reportFailure)
      } catch (error) {
        reportFailure(error)
      }
    } finally {
      preparation.detachDocumentObservers()
    }
  }

  const confirm = (window, action, { canReveal = () => true, owner = null } = {}) => {
    if (pending) return pendingOwner === owner ? pending : Promise.resolve(false)
    // A successful caller owns the sealed page until it explicitly releases it.
    if (heldPreparation) return Promise.resolve(false)
    pendingOwner = owner
    pending = (async () => {
      if (!window || window.isDestroyed() || window.webContents.isCrashed()) return true
      const contents = window.webContents
      const preparation = {
        window,
        contents,
        frame: contents.mainFrame,
        owner,
        id: `page-leave-${++sequence}`,
        documentInvalidated: false,
        detachDocumentObservers: () => {}
      }
      heldPreparation = preparation
      let allowed = false
      let cancelled = false
      let phase = 'settings'
      let cancelRequest
      const cancellation = new Promise((resolve) => {
        cancelRequest = resolve
      })
      function cancel() {
        if (cancelled) return
        cancelled = true
        cancelRequest(false)
        if (hasCurrentDocument(preparation)) {
          try {
            void Promise.resolve(
              execute(preparation, 'window.__cancelEditingDraftConfirmation?.()')
            ).catch(() => {})
          } catch {
            // A matching local owner must release even if renderer cancellation fails.
          }
        }
        resume(window, owner)
      }
      function invalidateDocument() {
        preparation.documentInvalidated = true
        preparation.detachDocumentObservers()
        // A successful preparation still belongs to navigation until its finally.
        // A committed navigation must not release that main settings owner early.
        if (!allowed) cancel()
      }
      function canContinue() {
        if (cancelled) return false
        if (!hasCurrentDocument(preparation)) {
          cancel()
          return false
        }
        return canReveal()
      }
      function onNavigation(_event, _url, _inPlace, isMainFrame) {
        if (isMainFrame) cancel()
      }
      function notify(text) {
        if (!cancelled && hasCurrentDocument(preparation))
          contents.send?.('app:message', { type: 'warning', text })
      }
      async function readState() {
        let timer
        try {
          return await Promise.race([
            execute(
              preparation,
              'window.__prepareEditingDrafts?.() ?? { dirty: false, blocked: false }'
            ),
            cancellation,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('草稿检查超时')), 3000)
            })
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      async function prepareSettings(recheck = false) {
        let timer
        try {
          const prepared = await Promise.race([
            execute(
              preparation,
              `window.__preparePageLeave?.(${JSON.stringify(preparation.id)}, { recheck: ${recheck} }) ?? { ready: true }`
            ),
            cancellation,
            new Promise((_, reject) => {
              // Native settings can still spend up to seven seconds in initialization/stop.
              timer = setTimeout(() => reject(new Error('设置离开准备超时')), 10000)
            })
          ])
          if (prepared?.ready === false) throw new Error('设置尚未安全保存')
        } finally {
          clearTimeout(timer)
        }
      }
      async function approvePreparedLeave() {
        phase = 'settings'
        // A settings panel can mount or unmount while draft inspection/confirmation awaits.
        await prepareSettings(true)
        if (!canContinue()) return false
        allowed = true
        return true
      }
      async function prepareMainSettings() {
        let timer
        try {
          await Promise.race([
            prepareSettingsOperations(preparation),
            cancellation,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('主进程设置操作尚未结束')), 10000)
            })
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      async function negotiate() {
        try {
          await prepareSettings()
          if (!canContinue()) return false
          await prepareMainSettings()
          if (!canContinue()) return false
          phase = 'drafts'
          const state = await readState()
          if (!canContinue()) return false
          if (!state.dirty && !state.blocked) {
            return await approvePreparedLeave()
          }
          await reveal(window, canContinue)
          if (!canContinue()) return false
          if (state.blocked) {
            notify('正在保存或草稿暂存失败，请先完成保存，再' + action + '。')
            return false
          }
          const accepted = await Promise.race([
            execute(preparation, 'window.__confirmEditingDrafts(' + JSON.stringify(action) + ')'),
            cancellation
          ])
          if (!accepted || !canContinue()) return false
          // Attachments or another save may finish while the dialog is open.
          const latest = await readState()
          if (!canContinue()) return false
          if (latest.blocked) {
            notify('草稿尚未安全暂存，请先保存内容后重试。')
            return false
          }
          return await approvePreparedLeave()
        } catch (error) {
          if (!hasCurrentDocument(preparation)) cancel()
          if (!cancelled) {
            logger.error('editing-draft.guard', error)
            if (phase === 'settings' && canReveal()) {
              try {
                await reveal(window, canContinue)
              } catch (revealError) {
                logger.error('page-leave.reveal', revealError)
              }
            }
            notify(
              phase === 'settings'
                ? '设置尚未保存或未能确认，本次操作已取消，请核对设置后重试。'
                : '暂时无法确认草稿已安全暂存，本次操作已取消，请保存内容后重试。'
            )
          }
          return false
        }
      }
      // Keep the document epoch until held preparation is explicitly released.
      // did-start-navigation only cancels an in-progress negotiation: a prevented
      // navigation has not replaced the original document and still needs cleanup.
      window.on?.('closed', invalidateDocument)
      contents.on?.('did-navigate', invalidateDocument)
      contents.on?.('render-process-gone', invalidateDocument)
      contents.on?.('destroyed', invalidateDocument)
      preparation.detachDocumentObservers = () => {
        window.removeListener?.('closed', invalidateDocument)
        contents.removeListener?.('did-navigate', invalidateDocument)
        contents.removeListener?.('render-process-gone', invalidateDocument)
        contents.removeListener?.('destroyed', invalidateDocument)
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
        if (!allowed || cancelled) resume(window, owner)
      }
    })().finally(() => {
      pending = null
      pendingOwner = null
    })
    return pending
  }
  // Successful preparation stays sealed until the caller commits or abandons navigation.
  confirm.resume = resume
  return confirm
}
