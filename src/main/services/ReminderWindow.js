import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { createMainWindowIpc } from '../ipc/ipc-authorization.js'

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
    this.focusOnReady = false
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
      handle('reminders:ready', () => {
        this.send()
        this.present()
        if (this.focusOnReady && this.rows.length) this.focusRound(this.focusId)
        return true
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

  ensureWindow() {
    if (this.disposed || (this.window && !this.window.isDestroyed())) return
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
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
    this.window = win
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.on('close', (event) => {
      if (!this.disposed) {
        event.preventDefault()
        this.hideAll()
      }
    })
    win.on('closed', () => {
      if (this.window === win) this.window = null
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.reportError('[reminders] renderer exited', details)
      win.destroy()
    })
    const load = this.rendererUrl
      ? win.loadURL(
          new URL(
            'reminder.html',
            this.rendererUrl.endsWith('/') ? this.rendererUrl : this.rendererUrl + '/'
          ).href
        )
      : win.loadFile(join(this.rendererPath, 'reminder.html'))
    void load.catch((error) => {
      this.reportError('[reminders] window load failed', error)
      win.destroy()
    })
  }

  sync(rows) {
    this.rows = rows
    if (!rows.some((r) => r.id === this.focusId)) this.focusId = null
    if (!rows.length) {
      this.focusOnReady = false
      this.window?.hide()
      this.send()
      return
    }
    this.ensureWindow()
    this.send()
    this.present()
  }

  send() {
    if (
      this.window &&
      !this.window.isDestroyed() &&
      !this.window.webContents.isLoadingMainFrame()
    ) {
      this.window.webContents.send('reminders:changed', this.snapshot())
    }
  }

  present() {
    const win = this.window
    if (
      win &&
      !win.isDestroyed() &&
      this.rows.length &&
      !win.webContents.isLoadingMainFrame() &&
      !win.isVisible()
    )
      win.showInactive()
  }

  focusRound(id) {
    this.focusId = id
    this.focusRequest += 1
    this.focusOnReady = true
    this.ensureWindow()
    this.send()
    if (this.window && !this.window.webContents.isLoadingMainFrame()) {
      this.window.show()
      this.window.focus()
      this.focusOnReady = false
    }
  }

  hideAll() {
    try {
      this.onDismissAll(this.rows.map((row) => row.id))
    } catch (error) {
      this.reportError('[reminders] dismiss failed', error)
    }
    this.window?.hide()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const failures = []
    for (const channel of this.channels.splice(0)) {
      try {
        this.ipcMain.removeHandler(channel)
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      this.window?.destroy()
    } catch (error) {
      failures.push(error)
    }
    this.window = null
    if (failures.length) throw new AggregateError(failures, '提醒窗口释放失败')
  }
}
