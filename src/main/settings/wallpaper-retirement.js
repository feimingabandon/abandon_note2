import { randomUUID } from 'node:crypto'
import { isSettingsSource, sameSettingsSource } from '../../shared/settings-receipt.js'

/** Owns one document's visual barrier; SQL and compensation belong to its caller. */
export function createWallpaperRetirement({ getMainWindow, isSourceCurrent, timeoutMs = 5000 }) {
  let pending = null
  let stopped = false

  function sourceCurrent(source) {
    try {
      return isSettingsSource(source) && isSourceCurrent(source)
    } catch {
      return false
    }
  }

  function finish(record, result) {
    if (pending !== record) return false
    pending = null
    clearTimeout(record.timer)
    for (const [target, name, listener] of record.listeners) target.removeListener(name, listener)
    record.listeners.length = 0
    if (result.status !== 'completed') {
      try {
        if (!record.contents.isDestroyed())
          record.contents.send('wallpapers:retirement-cancel', {
            id: record.id,
            source: record.source,
            reason: result.reason
          })
      } catch {
        // A dead renderer cannot consume cancellation; main still owns settlement.
      }
    }
    record.resolve({ ...result, id: record.id })
    return true
  }

  function cancelAll(reason = 'cancelled') {
    if (pending) finish(pending, { status: 'cancelled', reason })
  }

  function begin(source) {
    const window = getMainWindow()
    const contents = window?.webContents
    const frame = contents?.mainFrame
    if (
      stopped ||
      !sourceCurrent(source) ||
      !window ||
      window.isDestroyed() ||
      !contents ||
      contents.isDestroyed() ||
      contents.isCrashed() ||
      !frame ||
      frame.isDestroyed()
    ) {
      cancelAll('document-invalid')
      throw Object.assign(new Error('壁纸退场请求所属页面已失效'), {
        code: 'WALLPAPER_RETIREMENT_DOCUMENT_INVALID'
      })
    }
    if (!window.isVisible() || window.isMinimized()) {
      cancelAll('hidden')
      throw Object.assign(new Error('窗口不可见，无法确认壁纸退场'), {
        code: 'WALLPAPER_RETIREMENT_HIDDEN'
      })
    }
    if (
      pending &&
      pending.window === window &&
      pending.contents === contents &&
      pending.frame === frame &&
      sameSettingsSource(pending.source, source)
    )
      return pending.handle
    cancelAll('document-replaced')

    const record = {
      id: randomUUID(),
      source: Object.freeze({ token: source.token, scope: source.scope }),
      window,
      contents,
      frame,
      listeners: [],
      timer: null,
      resolve: null
    }
    const finished = new Promise((resolve) => {
      record.resolve = resolve
    })
    record.handle = Object.freeze({
      id: record.id,
      finished,
      cancel: (reason = 'cancelled') => finish(record, { status: 'cancelled', reason })
    })
    pending = record
    const on = (target, name, listener) => {
      target.on(name, listener)
      record.listeners.push([target, name, listener])
    }
    const cancel = (reason) => () => finish(record, { status: 'cancelled', reason })
    on(window, 'hide', cancel('hidden'))
    on(window, 'minimize', cancel('minimized'))
    on(window, 'closed', cancel('window-closed'))
    on(contents, 'did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) finish(record, { status: 'cancelled', reason: 'navigation' })
    })
    on(contents, 'did-navigate', cancel('document-replaced'))
    on(contents, 'render-process-gone', cancel('renderer-gone'))
    on(contents, 'destroyed', cancel('renderer-destroyed'))
    record.timer = setTimeout(
      () => finish(record, { status: 'failed', reason: 'timeout' }),
      timeoutMs
    )
    try {
      contents.send('wallpapers:retirement-request', { id: record.id, source: record.source })
    } catch (error) {
      finish(record, { status: 'failed', reason: 'send-failed' })
      throw error
    }
    return record.handle
  }

  return {
    begin,
    acknowledge(event, payload, source) {
      const record = pending
      if (
        !record ||
        payload?.id !== record.id ||
        !['left', 'absent', 'cancelled'].includes(payload.outcome) ||
        !sameSettingsSource(record.source, source) ||
        !sourceCurrent(source) ||
        getMainWindow() !== record.window ||
        event?.sender !== record.contents ||
        event?.senderFrame !== record.frame ||
        record.window.isDestroyed() ||
        record.contents.isDestroyed() ||
        record.contents.isCrashed() ||
        record.frame.isDestroyed() ||
        record.contents.mainFrame !== record.frame
      )
        return { accepted: false }
      if (!record.window.isVisible() || record.window.isMinimized()) {
        finish(record, { status: 'cancelled', reason: 'hidden' })
        return { accepted: false }
      }
      finish(
        record,
        payload.outcome === 'cancelled'
          ? { status: 'cancelled', reason: payload.reason || 'renderer-cancelled' }
          : { status: 'completed', outcome: payload.outcome }
      )
      return { accepted: true }
    },
    cancelSource(source, reason = 'cancelled') {
      if (pending && sameSettingsSource(pending.source, source)) cancelAll(reason)
    },
    cancelAll,
    stop(reason = 'stopped') {
      stopped = true
      cancelAll(reason)
    },
    snapshot: () => ({
      stopped,
      pending: pending ? { id: pending.id, source: { ...pending.source } } : null,
      timers: pending ? 1 : 0,
      listeners: pending?.listeners.length ?? 0
    })
  }
}
