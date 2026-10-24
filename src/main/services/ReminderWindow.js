import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { createMainWindowIpc } from '../ipc/ipc-authorization.js'

// E2.4 policy: one deadline covers construction, wiring, load and renderer readiness.
export const REMINDER_INITIALIZATION_TIMEOUT_MS = 15000

export class ReminderWindow {
  constructor({
    ipcMain,
    preloadPath,
    rendererPath,
    rendererUrl,
    getSettings,
    onAction,
    onDismissAll,
    reportError = console.error
  }) {
    Object.assign(this, {
      preloadPath,
      rendererPath,
      rendererUrl,
      getSettings,
      onAction,
      onDismissAll,
      reportError
    })
    this.window = null
    this.rows = []
    this.focusId = null
    this.focusRequest = 0
    this.initialization = null
    this.presentationIntent = null
    this.presentationRevision = 0
    this.hiding = false
    this.presentationStopped = false
    this.retainedWindows = new Set()
    this.disposed = false
    this.channels = []
    this.ipcMain = ipcMain
    const ipc = createMainWindowIpc(ipcMain, () => this.window, '便签提醒')
    const handle = (channel, handler) => {
      ipc.handle(channel, handler)
      this.channels.push(channel)
    }
    try {
      handle('reminders:state', () => this.snapshot())
      handle('reminders:action', (_event, payload) => {
        if (!this.rows.some((r) => r.id === payload?.id))
          throw new Error('提醒已更新，请使用最新提醒')
        return this.onAction(payload)
      })
      handle('reminders:ready', (event) => {
        const entry = this.initialization
        if (!this.isCurrent(entry) || event.sender !== entry.window.webContents) return false
        entry.rendererReady = true
        this.present(entry)
        return this.isCurrent(entry)
      })
      handle('reminders:hide', () => {
        this.hideAll()
        return true
      })
    } catch (error) {
      try {
        this.dispose()
      } catch (cleanupError) {
        this.reportError('[reminders] partial IPC cleanup failed', cleanupError)
      }
      throw error
    }
  }

  snapshot() {
    return {
      reminders: this.rows.map(({ id, note_id, content, due_at, from_template }) => ({
        id,
        noteId: note_id,
        content,
        dueAt: due_at,
        fromTemplate: Boolean(from_template)
      })),
      focusId: this.focusId,
      focusRequest: this.focusRequest,
      settings: this.getSettings?.()
    }
  }

  report(scene, error) {
    try {
      this.reportError(scene, error)
    } catch {
      // Diagnostic callbacks cannot revive or interrupt an initialization terminal state.
    }
  }

  isCurrent(entry) {
    return Boolean(
      entry &&
      !this.disposed &&
      this.initialization === entry &&
      !['failed', 'cancelled'].includes(entry.state) &&
      (!entry.window || (this.window === entry.window && !entry.window.isDestroyed()))
    )
  }

  canContinue(entry) {
    if (this.cancelDestroyed(entry)) return false
    if (!this.isCurrent(entry)) return false
    if (entry.state === 'pending' && Date.now() >= entry.deadline) {
      this.expire(entry)
      return false
    }
    return true
  }

  cancelDestroyed(entry) {
    if (
      !entry ||
      this.initialization !== entry ||
      ['failed', 'cancelled'].includes(entry.state) ||
      !entry.window?.isDestroyed()
    )
      return false
    // Destruction can happen before the runtime listeners have been registered.
    this.finish(entry, 'cancelled', { destroy: false })
    return true
  }

  clearIntent() {
    this.presentationRevision += 1
    this.presentationIntent = null
  }

  destroyOwnedWindow(win, failures = null) {
    if (!win) return
    try {
      if (!win.isDestroyed?.()) win.destroy()
      this.retainedWindows.delete(win)
    } catch (error) {
      // Keep ownership for final disposal even when an early cancellation could not destroy it.
      this.retainedWindows.add(win)
      if (failures) failures.push(error)
      else this.report('[reminders] window cleanup failed', error)
    }
  }

  finish(entry, state, { scene, error, destroy = true, failures = null } = {}) {
    if (!entry || ['failed', 'cancelled'].includes(entry.state)) return
    entry.state = state
    clearTimeout(entry.timer)
    entry.timer = null
    for (const [emitter, event, listener] of entry.listeners.splice(0)) {
      try {
        emitter.removeListener(event, listener)
      } catch (cleanupError) {
        if (failures) failures.push(cleanupError)
        else this.report('[reminders] window listener cleanup failed', cleanupError)
      }
    }
    if (this.initialization === entry) {
      this.initialization = null
      // A new public request may be retiring an expired entry before adopting its replacement.
      if (this.presentationIntent?.entry === entry) this.clearIntent()
    }
    if (this.window === entry.window) this.window = null
    if (scene) this.report(scene, error)
    if (destroy) this.destroyOwnedWindow(entry.window, failures)
  }

  expire(entry) {
    if (this.cancelDestroyed(entry)) return
    if (!this.isCurrent(entry) || entry.state !== 'pending') return
    const error = new Error('提醒窗口初始化超时')
    error.code = 'REMINDER_INITIALIZATION_TIMEOUT'
    this.finish(entry, 'failed', {
      scene: '[reminders] window initialization timed out',
      error
    })
  }

  ensureWindow() {
    if (this.disposed || this.presentationStopped || this.hiding) return null
    const previous = this.initialization
    if (this.canContinue(previous)) return previous
    if (previous && this.initialization === previous) this.finish(previous, 'cancelled')
    if (this.disposed || this.presentationStopped || this.hiding) return null
    // A cleanup/diagnostic callback may already have started the replacement.
    if (this.initialization)
      return this.canContinue(this.initialization) ? this.initialization : null
    const entry = {
      window: null,
      state: 'pending',
      loaded: false,
      rendererReady: false,
      deadline: Date.now() + REMINDER_INITIALIZATION_TIMEOUT_MS,
      timer: null,
      listeners: [],
      presenting: false,
      presentAgain: false
    }
    // Reserve before invoking native APIs: construction and wiring can reenter shutdown.
    this.initialization = entry
    if (this.presentationIntent && !this.presentationIntent.entry)
      this.presentationIntent.entry = entry
    entry.timer = setTimeout(() => this.expire(entry), REMINDER_INITIALIZATION_TIMEOUT_MS)
    entry.timer.unref?.()
    const listen = (emitter, event, listener) => {
      entry.listeners.push([emitter, event, listener])
      emitter.on(event, listener)
      if (this.canContinue(entry)) return true
      emitter.removeListener(event, listener)
      return false
    }
    try {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
      if (!this.canContinue(entry) || this.presentationStopped) return null
      const width = Math.min(480, area.width)
      const height = Math.min(520, area.height)
      const win = new BrowserWindow({
        width,
        height,
        x: area.x + Math.max(0, area.width - width - 16),
        y: area.y + Math.max(0, area.height - height - 16),
        title: '便签提醒',
        show: false,
        frame: false,
        resizable: true,
        minWidth: Math.min(360, area.width),
        minHeight: Math.min(300, area.height),
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          preload: this.preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false
        }
      })
      entry.window = win
      if (this.initialization !== entry || this.disposed || this.presentationStopped) {
        this.destroyOwnedWindow(win)
        return null
      }
      this.window = win
      if (!this.canContinue(entry)) return null
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      if (!this.canContinue(entry)) return null
      if (!listen(win.webContents, 'will-navigate', (event) => event.preventDefault())) return null
      if (
        !listen(win, 'close', (event) => {
          if (!this.isCurrent(entry)) return
          event.preventDefault()
          this.hideAll()
          if (entry.state === 'pending') this.finish(entry, 'cancelled')
        })
      )
        return null
      if (
        !listen(win, 'hide', () => {
          if (this.isCurrent(entry)) this.clearIntent()
        })
      )
        return null
      if (!listen(win, 'closed', () => this.finish(entry, 'cancelled', { destroy: false })))
        return null
      if (!listen(win.webContents, 'destroyed', () => this.finish(entry, 'cancelled'))) return null
      if (
        !listen(win.webContents, 'render-process-gone', (_event, details) => {
          this.finish(entry, 'failed', { scene: '[reminders] renderer exited', error: details })
        })
      )
        return null
      const load = this.rendererUrl
        ? win.loadURL(
            new URL(
              'reminder.html',
              this.rendererUrl.endsWith('/') ? this.rendererUrl : this.rendererUrl + '/'
            ).href
          )
        : win.loadFile(join(this.rendererPath, 'reminder.html'))
      // did-stop-loading also occurs on failures. Only this owned load's success opens the gate.
      void Promise.resolve(load).then(
        () => {
          if (!this.canContinue(entry)) return
          entry.loaded = true
          this.present(entry)
        },
        (error) => {
          if (!this.isCurrent(entry)) return
          this.finish(entry, 'failed', { scene: '[reminders] window load failed', error })
        }
      )
      return this.canContinue(entry) ? entry : null
    } catch (error) {
      if (['failed', 'cancelled'].includes(entry.state))
        this.report('[reminders] window cleanup failed', error)
      else
        this.finish(entry, 'failed', { scene: '[reminders] window initialization failed', error })
      return null
    }
  }

  sync(rows) {
    if (this.disposed) return
    this.rows = rows
    if (!rows.some((r) => r.id === this.focusId)) this.focusId = null
    if (!rows.length) {
      this.clearIntent()
      this.window?.hide()
      this.send()
      return
    }
    if (this.hiding || this.presentationStopped) {
      this.send()
      return
    }
    const pending = this.presentationIntent
    const pendingEntry = pending?.entry
    const preserveFocus =
      pending?.focus &&
      this.isCurrent(pendingEntry) &&
      (pendingEntry.state !== 'pending' || Date.now() < pendingEntry.deadline) &&
      rows.some((row) => row.id === pending.id)
    const intent = {
      revision: ++this.presentationRevision,
      focus: preserveFocus,
      id: pending?.id,
      entry: null
    }
    this.presentationIntent = intent
    const entry = this.ensureWindow()
    if (this.presentationIntent === intent) {
      if (entry && this.isCurrent(entry)) intent.entry = entry
      else this.clearIntent()
    }
    this.present()
  }

  send() {
    const entry = this.initialization
    if (!this.isCurrent(entry) || !entry.loaded || !entry.rendererReady) return
    const snapshot = this.snapshot()
    if (this.isCurrent(entry)) entry.window.webContents.send('reminders:changed', snapshot)
  }

  present(entry = this.initialization) {
    if (!this.canContinue(entry) || !entry.loaded || !entry.rendererReady) return
    if (entry.presenting) {
      entry.presentAgain = true
      return
    }
    if (entry.state === 'pending') {
      entry.state = 'ready'
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.presenting = true
    try {
      this.send()
      const intent = this.presentationIntent
      if (
        !this.isCurrent(entry) ||
        this.presentationStopped ||
        this.hiding ||
        !this.rows.length ||
        !intent
      )
        return
      this.presentationIntent = null
      const win = entry.window
      const stillWanted = () =>
        this.isCurrent(entry) &&
        !this.presentationStopped &&
        !this.hiding &&
        this.presentationRevision === intent.revision &&
        this.rows.length > 0
      if (intent.focus && this.rows.some((row) => row.id === intent.id)) {
        win.show()
        if (stillWanted() && this.rows.some((row) => row.id === intent.id)) win.focus()
      } else if (!win.isVisible() && stillWanted()) {
        win.showInactive()
      }
      // A native presentation callback may hide/dispose or replace the owned window.
      if (!stillWanted()) return
    } catch (error) {
      this.finish(entry, 'failed', { scene: '[reminders] window presentation failed', error })
    } finally {
      entry.presenting = false
      if (entry.presentAgain) {
        entry.presentAgain = false
        if (this.isCurrent(entry)) this.present(entry)
      }
    }
  }

  focusRound(id) {
    if (
      this.disposed ||
      this.presentationStopped ||
      this.hiding ||
      !this.rows.some((row) => row.id === id)
    )
      return false
    this.focusId = id
    this.focusRequest += 1
    const intent = { revision: ++this.presentationRevision, focus: true, id, entry: null }
    this.presentationIntent = intent
    const entry = this.ensureWindow()
    if (this.presentationIntent === intent) {
      if (entry && this.isCurrent(entry)) intent.entry = entry
      else this.clearIntent()
    }
    this.present()
    return true
  }

  hideAll() {
    if (this.disposed) return
    this.clearIntent()
    if (this.hiding) return
    this.hiding = true
    try {
      this.onDismissAll(this.rows.map((row) => row.id))
    } catch (error) {
      this.report('[reminders] dismiss failed', error)
    } finally {
      // dismissAll synchronously refreshes rows; that refresh cannot overrule this hide.
      this.clearIntent()
      try {
        this.window?.hide()
      } finally {
        this.hiding = false
      }
    }
  }

  stopPresentation() {
    if (this.presentationStopped) return
    this.presentationStopped = true
    this.clearIntent()
    if (this.initialization?.state === 'pending') this.finish(this.initialization, 'cancelled')
  }

  dispose() {
    if (this.disposed) return
    this.presentationStopped = true
    this.disposed = true
    this.clearIntent()
    const failures = []
    const retained = [...this.retainedWindows]
    for (const channel of this.channels.splice(0)) {
      try {
        this.ipcMain.removeHandler(channel)
      } catch (error) {
        failures.push(error)
      }
    }
    if (this.initialization) this.finish(this.initialization, 'cancelled', { failures })
    else if (this.window) this.destroyOwnedWindow(this.window, failures)
    for (const win of retained) this.destroyOwnedWindow(win, failures)
    this.window = null
    if (failures.length) throw new AggregateError(failures, '提醒窗口释放失败')
  }
}
