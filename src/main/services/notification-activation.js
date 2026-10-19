import { parseReminderProtocol } from '../../shared/reminder-protocol.js'

/** Owns early protocol actions and pending reveal intent, before feature services exist. */
export function createNotificationActivation({
  protocol,
  getWindow,
  exitCompactPresentation,
  openMainWindow,
  logger,
  now = Date.now
}) {
  let pendingReveal = false
  let revealContext = null
  const actions = []
  let reminderAction = null
  let disposed = false

  function windowSnapshot() {
    const window = getWindow()
    const alive = Boolean(window && !window.isDestroyed())
    return {
      windowExists: alive,
      loading: Boolean(
        alive && !window.webContents.isDestroyed() && window.webContents.isLoadingMainFrame()
      ),
      visible: Boolean(alive && window.isVisible()),
      pending: pendingReveal
    }
  }

  function settlePendingReveal() {
    const window = getWindow()
    if (
      disposed ||
      !pendingReveal ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.isLoadingMainFrame()
    )
      return false
    const context = revealContext || {
      source: 'unknown',
      hadLegacyNoteId: false,
      requestedAt: null
    }
    pendingReveal = false
    revealContext = null
    logger.info('notification.reveal', '开始显示通知对应的应用主视图', {
      ...context,
      queuedMs: context.requestedAt ? now() - context.requestedAt : null,
      ...windowSnapshot()
    })
    void Promise.resolve()
      .then(() =>
        disposed
          ? undefined
          : exitCompactPresentation({ source: 'notification', showWhenDone: true })
      )
      .then(() => {
        if (disposed) return
        openMainWindow()
        logger.info('notification.reveal', '通知唤醒与主视图显示完成', {
          ...context,
          result: 'shown',
          ...windowSnapshot()
        })
      })
      .catch((error) => {
        if (disposed) return
        logger.error('presentation-mode.notification-expand', error, context)
        openMainWindow()
      })
    return true
  }

  function reveal(context = {}) {
    if (disposed) return false
    pendingReveal = true
    revealContext = {
      source: context.source || 'notification-click',
      hadLegacyNoteId: Boolean(context.hadLegacyNoteId),
      requestedAt: now()
    }
    logger.info('notification.reveal-request', '收到系统通知唤醒请求', {
      ...revealContext,
      ...windowSnapshot()
    })
    settlePendingReveal()
    return true
  }

  function handleProtocol(rawUrl, source = 'protocol') {
    if (disposed) return false
    try {
      const url = new URL(rawUrl)
      if (url.protocol !== `${protocol}:` || url.hostname !== 'notification') return false
      const action = parseReminderProtocol(rawUrl, protocol)
      if (action) {
        if (reminderAction) reminderAction(action)
        else if (actions.length < 32) actions.push(action)
        return true
      }
      if (url.pathname === '/open') {
        const hadLegacyNoteId = url.searchParams.has('id')
        logger.info('notification.protocol', '已接收系统通知协议', {
          source,
          action: 'open',
          hadLegacyNoteId,
          ...windowSnapshot()
        })
        return reveal({ source, hadLegacyNoteId })
      }
    } catch (error) {
      logger.error('notification.protocol', error, { source })
    }
    return false
  }

  return Object.freeze({
    handleProtocol,
    handleArgs(argv, source = 'startup') {
      const url = argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${protocol}://`))
      return url ? handleProtocol(url, source) : false
    },
    reveal,
    settlePendingReveal,
    attachReminderAction(handler) {
      if (disposed) return false
      reminderAction = handler
      for (const action of actions.splice(0)) {
        try {
          handler(action)
        } catch (error) {
          logger.error('notification.pending-action', error)
        }
      }
      return true
    },
    detachReminderAction() {
      reminderAction = null
    },
    dispose() {
      disposed = true
      reminderAction = null
      pendingReveal = false
      revealContext = null
      actions.length = 0
    },
    snapshot: () => ({
      disposed,
      pendingReveal,
      pendingActions: actions.length,
      revealContext: revealContext ? { ...revealContext } : null
    })
  })
}
