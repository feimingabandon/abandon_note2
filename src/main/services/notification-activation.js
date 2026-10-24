import { parseReminderProtocol } from '../../shared/reminder-protocol.js'

/** Owns early protocol actions and pending reveal intent, before feature services exist. */
export function createNotificationActivation({
  protocol,
  getWindow,
  openMainWindow,
  canRequestOpen = (window) => !window.webContents.isLoadingMainFrame(),
  logger,
  now = Date.now
}) {
  let pendingReveal = null
  let openingReveal = null
  let revealGeneration = 0
  const actions = []
  let reminderAction = null
  let disposed = false

  function observe(level, ...args) {
    try {
      logger[level](...args)
    } catch {
      // Logging is an observer, never ownership of a display request or cancellation.
    }
  }

  function windowSnapshot() {
    const window = getWindow()
    const alive = Boolean(window && !window.isDestroyed())
    return {
      windowExists: alive,
      loading: Boolean(
        alive && !window.webContents.isDestroyed() && window.webContents.isLoadingMainFrame()
      ),
      visible: Boolean(alive && window.isVisible()),
      pending: Boolean(pendingReveal)
    }
  }

  function currentOpening(intent) {
    return Boolean(
      !disposed &&
      openingReveal === intent &&
      intent.generation === revealGeneration &&
      intent.window === getWindow() &&
      !intent.window.isDestroyed() &&
      !intent.window.webContents.isDestroyed()
    )
  }

  function settlePendingReveal() {
    const window = getWindow()
    const intent = pendingReveal
    if (disposed || !intent || !window || window.isDestroyed() || window.webContents.isDestroyed())
      return false
    let allowed
    try {
      allowed = canRequestOpen(window)
    } catch (error) {
      observe('error', 'notification.reveal-gate', error, intent.context)
      return false
    }
    if (
      !allowed ||
      disposed ||
      pendingReveal !== intent ||
      intent.generation !== revealGeneration ||
      window !== getWindow() ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    )
      return false
    intent.window = window
    pendingReveal = null
    openingReveal = intent
    const context = intent.context
    observe('info', 'notification.reveal', '开始显示通知对应的应用主视图', {
      ...context,
      queuedMs: context.requestedAt ? now() - context.requestedAt : null,
      ...windowSnapshot()
    })
    void Promise.resolve()
      .then(() => (currentOpening(intent) ? openMainWindow() : undefined))
      .then((shown) => {
        if (!currentOpening(intent)) return
        const snapshot = windowSnapshot()
        if (!currentOpening(intent)) return
        openingReveal = null
        observe(
          'info',
          'notification.reveal',
          shown === true ? '通知唤醒与主视图显示完成' : '通知唤醒未显示主视图',
          {
            ...context,
            result: shown === true ? 'shown' : 'not-shown',
            ...snapshot
          }
        )
      })
      .catch((error) => {
        if (!currentOpening(intent)) return
        openingReveal = null
        observe('error', 'notification.reveal', error, { ...context, result: 'failed' })
      })
      .finally(() => {
        if (openingReveal === intent) openingReveal = null
      })
    return true
  }

  function reveal(context = {}) {
    if (disposed) return false
    const contextDetails = {
      source: context.source || 'notification-click',
      hadLegacyNoteId: Boolean(context.hadLegacyNoteId),
      requestedAt: now()
    }
    pendingReveal = {
      generation: ++revealGeneration,
      context: contextDetails,
      window: null
    }
    openingReveal = null
    observe('info', 'notification.reveal-request', '收到系统通知唤醒请求', {
      ...contextDetails,
      ...windowSnapshot()
    })
    settlePendingReveal()
    return true
  }

  function cancelPendingReveal(reason = 'cancelled') {
    const current = pendingReveal || openingReveal
    if (!current) return false
    revealGeneration += 1
    pendingReveal = null
    openingReveal = null
    observe('info', 'notification.reveal-cancel', '通知唤醒显示意图已取消', {
      ...current.context,
      reason
    })
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
        observe('info', 'notification.protocol', '已接收系统通知协议', {
          source,
          action: 'open',
          hadLegacyNoteId,
          ...windowSnapshot()
        })
        return reveal({ source, hadLegacyNoteId })
      }
    } catch (error) {
      observe('error', 'notification.protocol', error, { source })
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
    cancelPendingReveal,
    attachReminderAction(handler) {
      if (disposed) return false
      reminderAction = handler
      for (const action of actions.splice(0)) {
        try {
          handler(action)
        } catch (error) {
          observe('error', 'notification.pending-action', error)
        }
      }
      return true
    },
    detachReminderAction() {
      reminderAction = null
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelPendingReveal('disposed')
      reminderAction = null
      actions.length = 0
    },
    snapshot: () => ({
      disposed,
      pendingReveal: Boolean(pendingReveal),
      pendingActions: actions.length,
      revealContext: pendingReveal ? { ...pendingReveal.context } : null
    })
  })
}
