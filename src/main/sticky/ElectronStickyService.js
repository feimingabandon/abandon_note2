import { BrowserWindow, screen } from 'electron'
import { pathToFileURL } from 'url'
import { ipcMain } from '../logging/ipc-main.js'
import { setWindowLogContext } from '../logging/window-capture.js'
import { StickyService } from './StickyService.js'
import { StickyDisplayManager } from './StickyDisplayManager.js'
import {
  DEFAULT_STICKY_BACKGROUND,
  DEFAULT_STICKY_FONT_SIZE,
  MAX_STICKY_WINDOWS,
  MIN_STICKY_HEIGHT,
  MIN_STICKY_WIDTH,
  STICKY_PALETTE,
  STICKY_READY_TIMEOUT_MS,
  STICKY_TOOLBAR_HEIGHT
} from './stickyConstants.js'
import {
  calculateTotalOverlap,
  chooseStickyBounds,
  constrainBoundsToWorkArea,
  createStickyPreview,
  getContrastTextColor,
  isToolbarAccessible,
  mapBoundsBetweenWorkAreas,
  normalizeBackgroundColor,
  normalizeCornerRadius,
  normalizeFontSize,
  normalizeNoteId,
  normalizeStickyContent,
  rectanglesOverlap
} from './stickyUtils.js'

const IPC_CHANNELS = [
  'sticky:create',
  'sticky:ready',
  'sticky:get-state',
  'sticky:close',
  'sticky:toggle-pin',
  'sticky:update-appearance'
]

class StickyCreationError extends Error {}

export class ElectronStickyService extends StickyService {
  constructor({
    getMainWindow,
    getNoteById,
    getDefaultAppearance,
    preloadPath,
    rendererFile,
    rendererUrl,
    isDevelopment = false,
    onRegistryChanged,
    onError
  }) {
    super()
    this.getMainWindow = getMainWindow
    this.getNoteById = getNoteById
    this.getDefaultAppearance = getDefaultAppearance
    this.preloadPath = preloadPath
    this.rendererFile = rendererFile
    this.rendererUrl = rendererUrl
    this.isDevelopment = isDevelopment
    this.onRegistryChanged = onRegistryChanged
    this.onError = onError
    this.registry = new Map()
    this.byWebContentsId = new Map()
    this.sequence = 0
    this.initialized = false
    this.disposing = false
    this.displayManager = new StickyDisplayManager(screen, (change) =>
      this.handleDisplayTopologyChange(change)
    )
  }

  initialize() {
    if (this.initialized) return
    this.initialized = true
    this.disposing = false
    this.displayManager.start()

    ipcMain.handle('sticky:create', async (event, payload) => {
      const mainWindow = this.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
        return { ok: false, message: '无法创建便利贴' }
      }
      try {
        const sticky = await this.create({ noteId: payload?.noteId })
        return { ok: true, sticky }
      } catch (error) {
        if (!(error instanceof StickyCreationError)) {
          console.error('[sticky] 创建便利贴失败:', error)
        }
        return {
          ok: false,
          message: error instanceof StickyCreationError ? error.message : '无法创建便利贴，请重试'
        }
      }
    })
    ipcMain.handle('sticky:get-state', (event) => this.getStateForSender(event.sender.id))
    ipcMain.handle('sticky:ready', (event) => this.markReady(event.sender.id))
    ipcMain.handle('sticky:close', (event) => this.closeForSender(event.sender.id))
    ipcMain.handle('sticky:toggle-pin', (event) => this.togglePinForSender(event.sender.id))
    ipcMain.handle('sticky:update-appearance', (event, payload) =>
      this.updateAppearanceForSender(event.sender.id, payload)
    )
  }

  async create({ noteId }) {
    if (!this.initialized || this.disposing) throw new StickyCreationError('便利贴服务尚未就绪')
    if (this.registry.size >= MAX_STICKY_WINDOWS) {
      throw new StickyCreationError(
        `最多同时展示 ${MAX_STICKY_WINDOWS} 张便利贴，请先关闭部分便利贴`
      )
    }

    let normalizedNoteId
    try {
      normalizedNoteId = normalizeNoteId(noteId)
    } catch (error) {
      throw new StickyCreationError(error.message)
    }
    const note = this.getNoteById(normalizedNoteId)
    if (!note) throw new StickyCreationError('便签不存在或已被删除')
    let content
    try {
      content = normalizeStickyContent(note.content)
    } catch (error) {
      throw new StickyCreationError(error.message)
    }
    const cursor = screen.getCursorScreenPoint()
    const { display, bounds } = this.choosePlacement(cursor)
    const defaultAppearance = this.getDefaultAppearance?.() || {}
    const fontSize = normalizeFontSize(defaultAppearance.fontSize ?? DEFAULT_STICKY_FONT_SIZE)
    const backgroundColor = normalizeBackgroundColor(
      defaultAppearance.backgroundColor ?? DEFAULT_STICKY_BACKGROUND
    )
    const cornerRadius = normalizeCornerRadius(defaultAppearance.cornerRadius ?? 0)
    const pinned = defaultAppearance.alwaysOnTop === true
    const id = `sticky-${Date.now()}-${++this.sequence}`
    const win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_STICKY_WIDTH,
      minHeight: MIN_STICKY_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      roundedCorners: cornerRadius > 0,
      hasShadow: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      alwaysOnTop: pinned,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: this.isDevelopment,
        spellcheck: false,
        plugins: false,
        webgl: false,
        backgroundThrottling: true
      }
    })
    setWindowLogContext(win, { role: 'sticky', stickyId: id, noteId: normalizedNoteId })

    const entry = {
      id,
      noteId: normalizedNoteId,
      content,
      preview: createStickyPreview(content, this.registry.size),
      window: win,
      webContentsId: win.webContents.id,
      bounds,
      displayId: display.id,
      fontSize,
      backgroundColor,
      textColor: getContrastTextColor(backgroundColor),
      cornerRadius,
      transparent: true,
      pinned,
      ready: false,
      finishReadyWait: null,
      readyTimer: null,
      createdAt: Date.now(),
      lastFocusedAt: Date.now()
    }
    const readyPromise = new Promise((resolve) => {
      let settled = false
      entry.finishReadyWait = (ready) => {
        if (settled) return
        settled = true
        if (entry.readyTimer) {
          clearTimeout(entry.readyTimer)
          entry.readyTimer = null
        }
        resolve(ready)
      }
      entry.readyTimer = setTimeout(() => entry.finishReadyWait(false), STICKY_READY_TIMEOUT_MS)
    })
    this.registry.set(id, entry)
    this.byWebContentsId.set(entry.webContentsId, id)
    this.attachWindowListeners(entry)
    this.onRegistryChanged?.()

    try {
      if (this.rendererUrl) {
        await win.loadURL(this.rendererUrl)
      } else {
        await win.loadFile(this.rendererFile)
      }
    } catch (error) {
      this.destroyEntry(entry)
      console.error('[sticky] 页面加载失败:', error)
      throw new StickyCreationError('便利贴页面加载失败')
    }

    if (!(await readyPromise)) {
      this.destroyEntry(entry)
      throw new StickyCreationError('便利贴初始化失败，请重试')
    }

    return { id, count: this.registry.size, limit: MAX_STICKY_WINDOWS }
  }

  choosePlacement(cursor) {
    const cursorDisplay = screen.getDisplayNearestPoint(cursor)
    const displays = [
      cursorDisplay,
      ...screen.getAllDisplays().filter((display) => display.id !== cursorDisplay.id)
    ]
    const mainWindow = this.getMainWindow()
    const mainBounds =
      mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
        ? mainWindow.getBounds()
        : null
    for (const display of displays) {
      const existingBounds = [...this.registry.values()]
        .filter((item) => item.displayId === display.id)
        .map((item) => item.bounds)
      const blockedBounds =
        mainBounds && rectanglesOverlap(mainBounds, display.workArea) ? [mainBounds] : []
      const bounds = chooseStickyBounds({
        cursor,
        workArea: display.workArea,
        existingBounds,
        blockedBounds
      })
      const blockedOverlap = calculateTotalOverlap(bounds, blockedBounds)
      if (blockedOverlap === 0) return { display, bounds }
    }

    throw new StickyCreationError('主窗口外没有足够空间展示便利贴，请移动或缩小主窗口后重试')
  }

  attachWindowListeners(entry) {
    const win = entry.window
    const expectedUrl = this.rendererUrl || pathToFileURL(this.rendererFile).toString()
    const updateBounds = () => {
      if (win.isDestroyed()) return
      entry.bounds = win.getBounds()
      const center = {
        x: entry.bounds.x + Math.round(entry.bounds.width / 2),
        y: entry.bounds.y + Math.round(entry.bounds.height / 2)
      }
      entry.displayId = screen.getDisplayNearestPoint(center).id
    }

    win.on('move', updateBounds)
    win.on('resize', updateBounds)
    win.on('focus', () => {
      entry.lastFocusedAt = Date.now()
    })
    win.once('closed', () => this.removeEntry(entry))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== expectedUrl) event.preventDefault()
    })
    win.webContents.on('will-redirect', (event) => event.preventDefault())
    win.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') {
        this.onError?.('一张便利贴异常关闭')
      }
      this.destroyEntry(entry)
    })
  }

  requireEntryForSender(webContentsId) {
    const id = this.byWebContentsId.get(webContentsId)
    const entry = id ? this.registry.get(id) : null
    if (!entry || entry.window.isDestroyed()) throw new Error('便利贴窗口无效或已关闭')
    return entry
  }

  getStateForSender(webContentsId) {
    const entry = this.requireEntryForSender(webContentsId)
    return this.serializeState(entry)
  }

  markReady(webContentsId) {
    const entry = this.requireEntryForSender(webContentsId)
    if (!entry.ready) {
      entry.ready = true
      entry.window.showInactive()
      const finishReadyWait = entry.finishReadyWait
      entry.finishReadyWait = null
      finishReadyWait?.(true)
      this.onRegistryChanged?.()
    }
    return true
  }

  closeForSender(webContentsId) {
    const entry = this.requireEntryForSender(webContentsId)
    this.destroyEntry(entry)
    return true
  }

  togglePinForSender(webContentsId) {
    const entry = this.requireEntryForSender(webContentsId)
    entry.pinned = !entry.pinned
    entry.window.setAlwaysOnTop(entry.pinned)
    return { pinned: entry.pinned }
  }

  updateAppearanceForSender(webContentsId, payload = {}) {
    const entry = this.requireEntryForSender(webContentsId)
    const allowedKeys = new Set(['fontSize', 'backgroundColor'])
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.keys(payload).some((key) => !allowedKeys.has(key))
    ) {
      throw new Error('无效的便利贴外观设置')
    }

    if (payload.fontSize !== undefined) entry.fontSize = normalizeFontSize(payload.fontSize)
    if (payload.backgroundColor !== undefined) {
      entry.backgroundColor = normalizeBackgroundColor(payload.backgroundColor)
      entry.textColor = getContrastTextColor(entry.backgroundColor)
    }
    return this.serializeAppearance(entry)
  }

  serializeAppearance(entry) {
    return {
      fontSize: entry.fontSize,
      backgroundColor: entry.backgroundColor,
      textColor: entry.textColor,
      cornerRadius: entry.cornerRadius,
      pinned: entry.pinned
    }
  }

  serializeState(entry) {
    return {
      id: entry.id,
      noteId: entry.noteId,
      content: entry.content,
      palette: STICKY_PALETTE,
      ...this.serializeAppearance(entry)
    }
  }

  list() {
    return [...this.registry.values()]
      .filter((entry) => entry.ready && !entry.window.isDestroyed())
      .sort((first, second) => first.createdAt - second.createdAt)
      .map((entry) => ({
        id: entry.id,
        noteId: entry.noteId,
        preview: entry.preview,
        pinned: entry.pinned,
        createdAt: entry.createdAt,
        lastFocusedAt: entry.lastFocusedAt
      }))
  }

  focus(id) {
    const entry = this.registry.get(id)
    if (!entry?.ready || entry.window.isDestroyed()) return false
    entry.window.show()
    entry.window.moveTop()
    entry.window.focus()
    entry.lastFocusedAt = Date.now()
    return true
  }

  showAll() {
    const entries = [...this.registry.values()].filter(
      (entry) => entry.ready && !entry.window.isDestroyed()
    )
    if (!entries.length) return false
    for (const entry of entries) {
      entry.window.showInactive()
      entry.window.moveTop()
    }
    const target = entries.reduce((latest, entry) =>
      entry.lastFocusedAt > latest.lastFocusedAt ? entry : latest
    )
    target.window.focus()
    target.lastFocusedAt = Date.now()
    return true
  }

  close(id) {
    const entry = this.registry.get(id)
    if (!entry) return false
    this.destroyEntry(entry)
    return true
  }

  closeAll() {
    for (const entry of [...this.registry.values()]) this.destroyEntry(entry)
  }

  destroyEntry(entry) {
    if (!entry) return
    if (!entry.window.isDestroyed()) {
      entry.window.destroy()
    } else {
      this.removeEntry(entry)
    }
  }

  removeEntry(entry) {
    if (this.registry.get(entry.id) !== entry) return
    entry.finishReadyWait?.(false)
    entry.finishReadyWait = null
    this.byWebContentsId.delete(entry.webContentsId)
    this.registry.delete(entry.id)
    this.onRegistryChanged?.()
  }

  handleDisplayTopologyChange({ previous, current }) {
    if (!this.registry.size || !current.size) return
    const currentWorkAreas = [...current.values()].map((display) => display.workArea)

    for (const entry of this.registry.values()) {
      if (entry.window.isDestroyed()) continue
      const oldDisplay = previous.get(entry.displayId)
      if (!current.has(entry.displayId) && oldDisplay) {
        const center = {
          x: entry.bounds.x + Math.round(entry.bounds.width / 2),
          y: entry.bounds.y + Math.round(entry.bounds.height / 2)
        }
        const target = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay()
        const mapped = mapBoundsBetweenWorkAreas(entry.bounds, oldDisplay.workArea, target.workArea)
        entry.window.setBounds(mapped)
        entry.bounds = mapped
        entry.displayId = target.id
        continue
      }

      if (!isToolbarAccessible(entry.bounds, currentWorkAreas, STICKY_TOOLBAR_HEIGHT)) {
        const center = {
          x: entry.bounds.x + Math.round(entry.bounds.width / 2),
          y: entry.bounds.y + Math.round(entry.bounds.height / 2)
        }
        const target = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay()
        const bounded = constrainBoundsToWorkArea(entry.bounds, target.workArea)
        entry.window.setBounds(bounded)
        entry.bounds = bounded
        entry.displayId = target.id
      }
    }
  }

  dispose() {
    if (!this.initialized) return
    this.disposing = true
    this.closeAll()
    this.displayManager.stop()
    for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel)
    this.initialized = false
  }
}
