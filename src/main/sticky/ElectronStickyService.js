import { BrowserWindow, screen } from 'electron'
import { randomUUID } from 'node:crypto'
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
  STICKY_BOUNDS_PERSIST_DELAY_MS,
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
    stickyRepository,
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
    this.repository = stickyRepository || {
      list: () => [],
      count: () => 0,
      exists: () => true,
      insert: () => {},
      update: () => true,
      delete: () => true,
      deleteAll: () => 0
    }
    this.isDevelopment = isDevelopment
    this.onRegistryChanged = onRegistryChanged
    this.onError = onError
    this.registry = new Map()
    this.byWebContentsId = new Map()
    this.initialized = false
    this.disposing = false
    this.restorePromise = null
    this.rendererRecoveryAttempts = new Map()
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
        if (error instanceof StickyCreationError) {
          console.warn(`[sticky] 创建便利贴被拒绝 (noteId=${payload?.noteId}):`, error.message)
        } else {
          console.error(`[sticky] 创建便利贴失败 (noteId=${payload?.noteId}):`, error)
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
    if (this.getOccupiedSlotCount() >= MAX_STICKY_WINDOWS) {
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
    const id = `sticky-${randomUUID()}`
    return this.openEntry({
      id,
      noteId: normalizedNoteId,
      content,
      bounds,
      displayId: display.id,
      workArea: { ...display.workArea },
      fontSize,
      backgroundColor,
      cornerRadius,
      pinned,
      createdAt: Date.now(),
      persisted: false
    })
  }

  async openEntry({
    id,
    noteId,
    content,
    bounds,
    displayId,
    workArea,
    fontSize,
    backgroundColor,
    cornerRadius,
    pinned,
    createdAt,
    persisted
  }) {
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
    setWindowLogContext(win, { role: 'sticky', stickyId: id, noteId })

    const entry = {
      id,
      noteId,
      content,
      preview: createStickyPreview(content, this.registry.size),
      window: win,
      webContentsId: win.webContents.id,
      bounds,
      displayId,
      workArea,
      fontSize,
      backgroundColor,
      textColor: getContrastTextColor(backgroundColor),
      cornerRadius,
      transparent: true,
      pinned,
      ready: false,
      finishReadyWait: null,
      readyTimer: null,
      boundsPersistTimer: null,
      createdAt,
      lastFocusedAt: Date.now(),
      persisted
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
      let restorationCancelled = false
      if (persisted) {
        try {
          restorationCancelled = !this.repository.exists(id)
        } catch {
          // 继续记录原始页面加载错误。
        }
      }
      this.destroyEntry(entry)
      if (restorationCancelled) throw new StickyCreationError('便利贴恢复已取消')
      console.error(`[sticky] 页面加载失败 (${this.rendererUrl || this.rendererFile}):`, error)
      throw new StickyCreationError('便利贴页面加载失败')
    }

    if (!(await readyPromise)) {
      this.destroyEntry(entry)
      throw new StickyCreationError('便利贴初始化失败，请重试')
    }

    return { id, count: this.registry.size, limit: MAX_STICKY_WINDOWS }
  }

  /**
   * 数据库记录包含已恢复窗口，registry 还包含尚未完成 ready、因而尚未写入
   * 数据库的新窗口。按 ID 并集计数，既不重复计算已恢复记录，也不给并发创建
   * 留出超过上限的空档。create() 在第一次 await 前会把新 ID 放入 registry。
   */
  getOccupiedSlotCount() {
    const occupiedIds = new Set(this.registry.keys())
    for (const record of this.repository.list()) occupiedIds.add(String(record.id))
    return occupiedIds.size
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

  getRecoverableCount() {
    if (!this.initialized || this.disposing) return 0
    try {
      return this.repository.list().filter((record) => !this.registry.has(record.id)).length
    } catch (error) {
      console.error('[sticky] 读取可恢复便利贴数量失败:', error)
      return 0
    }
  }

  restoreMissing({ source = 'manual' } = {}) {
    if (!this.initialized || this.disposing) return Promise.resolve(0)
    if (this.restorePromise) return this.restorePromise
    this.restorePromise = this.restoreMissingInternal(source)
      .catch((error) => {
        console.error(`[sticky] 恢复便利贴失败 (source=${source}):`, error)
        this.onError?.('恢复便利贴失败，请重试')
        return 0
      })
      .finally(() => {
        this.restorePromise = null
        this.onRegistryChanged?.()
      })
    return this.restorePromise
  }

  async restoreMissingInternal(source) {
    const records = this.repository.list()
    let restored = 0
    let failed = 0
    for (const record of records) {
      if (this.disposing || this.registry.size >= MAX_STICKY_WINDOWS) break
      if (this.registry.has(record.id)) continue
      const recordId = String(record.id)
      try {
        if (!this.repository.exists(recordId)) continue
        const normalized = this.normalizeRestoredRecord(record)
        await this.openEntry({ ...normalized, persisted: true })
        const entry = this.registry.get(recordId)
        if (!entry?.ready || entry.window.isDestroyed() || !this.repository.exists(recordId)) {
          if (entry) this.destroyEntry(entry)
          continue
        }
        restored += 1
      } catch (error) {
        const entry = this.registry.get(recordId)
        if (entry) this.destroyEntry(entry)
        try {
          if (!this.repository.exists(recordId)) continue
        } catch {
          // 数据库读取失败仍按恢复失败报告，保留原始错误供日志定位。
        }
        failed += 1
        console.error(`[sticky] 恢复便利贴失败 (${record.id}, source=${source}):`, error)
      }
    }
    if (failed > 0) this.onError?.(`${failed} 张便利贴恢复失败，请稍后通过托盘重试`)
    console.log(`[sticky] 恢复便利贴完成 (source=${source}, restored=${restored})`)
    return restored
  }

  normalizeRestoredRecord(record) {
    const displays = screen.getAllDisplays()
    if (!displays.length) throw new Error('当前没有可用显示器')
    const content = normalizeStickyContent(record.content)
    const fontSize = normalizeFontSize(record.fontSize)
    const backgroundColor = normalizeBackgroundColor(record.backgroundColor)
    const cornerRadius = normalizeCornerRadius(record.cornerRadius)
    const savedBounds = {
      x: Math.round(Number(record.bounds?.x)),
      y: Math.round(Number(record.bounds?.y)),
      width: Math.max(MIN_STICKY_WIDTH, Math.round(Number(record.bounds?.width))),
      height: Math.max(MIN_STICKY_HEIGHT, Math.round(Number(record.bounds?.height)))
    }
    if (Object.values(savedBounds).some((value) => !Number.isFinite(value))) {
      throw new Error('便利贴位置记录无效')
    }
    const matchingDisplay = displays.find(
      (display) => String(display.id) === String(record.displayId)
    )
    const center = {
      x: savedBounds.x + Math.round(savedBounds.width / 2),
      y: savedBounds.y + Math.round(savedBounds.height / 2)
    }
    const target =
      matchingDisplay || screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay()
    const bounds =
      !matchingDisplay && record.workArea
        ? mapBoundsBetweenWorkAreas(savedBounds, record.workArea, target.workArea)
        : constrainBoundsToWorkArea(savedBounds, target.workArea)
    return {
      id: String(record.id),
      noteId: normalizeNoteId(record.noteId),
      content,
      bounds,
      displayId: target.id,
      workArea: { ...target.workArea },
      fontSize,
      backgroundColor,
      cornerRadius,
      pinned: record.pinned === true,
      createdAt: Number(record.createdAt) || Date.now()
    }
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
      const display = screen.getDisplayNearestPoint(center)
      entry.displayId = display.id
      entry.workArea = { ...display.workArea }
      this.scheduleBoundsPersistence(entry)
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
      if (details.reason !== 'clean-exit') this.scheduleRendererRecovery(entry.id)
    })
  }

  scheduleBoundsPersistence(entry) {
    if (!entry.ready || !entry.persisted || this.disposing) return
    if (entry.boundsPersistTimer) clearTimeout(entry.boundsPersistTimer)
    entry.boundsPersistTimer = setTimeout(() => {
      entry.boundsPersistTimer = null
      this.persistBounds(entry)
    }, STICKY_BOUNDS_PERSIST_DELAY_MS)
    entry.boundsPersistTimer.unref?.()
  }

  persistBounds(entry) {
    if (!entry?.persisted) return false
    try {
      return this.repository.update(entry.id, {
        boundsX: entry.bounds.x,
        boundsY: entry.bounds.y,
        boundsWidth: entry.bounds.width,
        boundsHeight: entry.bounds.height,
        displayId: entry.displayId == null ? null : String(entry.displayId),
        workAreaX: entry.workArea?.x ?? null,
        workAreaY: entry.workArea?.y ?? null,
        workAreaWidth: entry.workArea?.width ?? null,
        workAreaHeight: entry.workArea?.height ?? null,
        updatedAt: Date.now()
      })
    } catch (error) {
      console.error(`[sticky] 保存便利贴位置失败 (${entry.id}):`, error)
      return false
    }
  }

  scheduleRendererRecovery(id) {
    if (this.disposing || (this.rendererRecoveryAttempts.get(id) || 0) >= 1) return
    this.rendererRecoveryAttempts.set(id, 1)
    const timer = setTimeout(() => {
      if (!this.disposing) void this.restoreMissing({ source: 'renderer-gone' })
    }, 500)
    timer.unref?.()
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
      if (entry.persisted) {
        let recordExists
        try {
          recordExists = this.repository.exists(entry.id)
        } catch (error) {
          entry.finishReadyWait?.(false)
          this.destroyEntry(entry)
          console.error(`[sticky] 验证便利贴记录失败 (${entry.id}):`, error)
          throw new Error('便利贴记录验证失败，已停止恢复')
        }
        if (!recordExists) {
          entry.finishReadyWait?.(false)
          this.destroyEntry(entry)
          throw new Error('便利贴记录已被删除，已停止恢复')
        }
      } else {
        try {
          this.repository.insert(this.toPersistentRecord(entry))
          entry.persisted = true
          console.log(`[sticky] 便利贴已持久化 (${entry.id})`)
        } catch (error) {
          entry.finishReadyWait?.(false)
          this.destroyEntry(entry)
          console.error(`[sticky] 保存新便利贴失败 (${entry.id}):`, error)
          throw new Error('便利贴保存失败，未显示到桌面')
        }
      }
      entry.ready = true
      this.persistBounds(entry)
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
    if (!this.close(entry.id)) throw new Error('便利贴关闭失败，请重试')
    return true
  }

  togglePinForSender(webContentsId) {
    const entry = this.requireEntryForSender(webContentsId)
    const pinned = !entry.pinned
    if (
      !this.repository.update(entry.id, {
        alwaysOnTop: pinned,
        updatedAt: Date.now()
      })
    ) {
      throw new Error('便利贴记录不存在')
    }
    entry.pinned = pinned
    entry.window.setAlwaysOnTop(pinned)
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
    if (Object.keys(payload).length === 0) return this.serializeAppearance(entry)

    const nextFontSize =
      payload.fontSize === undefined ? entry.fontSize : normalizeFontSize(payload.fontSize)
    let nextBackgroundColor = entry.backgroundColor
    if (payload.backgroundColor !== undefined) {
      nextBackgroundColor = normalizeBackgroundColor(payload.backgroundColor)
    }
    const patch = { updatedAt: Date.now() }
    if (payload.fontSize !== undefined) patch.fontSize = nextFontSize
    if (payload.backgroundColor !== undefined) patch.backgroundColor = nextBackgroundColor
    if (!this.repository.update(entry.id, patch)) throw new Error('便利贴记录不存在')
    entry.fontSize = nextFontSize
    entry.backgroundColor = nextBackgroundColor
    entry.textColor = getContrastTextColor(entry.backgroundColor)
    return this.serializeAppearance(entry)
  }

  toPersistentRecord(entry) {
    const timestamp = Date.now()
    return {
      id: entry.id,
      noteId: entry.noteId,
      content: entry.content,
      bounds: { ...entry.bounds },
      displayId: entry.displayId,
      workArea: entry.workArea ? { ...entry.workArea } : null,
      fontSize: entry.fontSize,
      backgroundColor: entry.backgroundColor,
      cornerRadius: entry.cornerRadius,
      pinned: entry.pinned,
      createdAt: entry.createdAt,
      updatedAt: timestamp
    }
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
    if (!entry) {
      try {
        const deleted = this.repository.delete(id)
        if (deleted) this.onRegistryChanged?.()
        return deleted
      } catch (error) {
        console.error(`[sticky] 删除便利贴记录失败 (${id}):`, error)
        return false
      }
    }
    try {
      this.destroyEntry(entry)
      if (entry.persisted) this.repository.delete(id)
      entry.persisted = false
      this.onRegistryChanged?.()
      console.log(`[sticky] 用户已关闭便利贴 (${id})`)
      return true
    } catch (error) {
      console.error(`[sticky] 关闭便利贴失败 (${id}):`, error)
      this.onError?.('便利贴关闭失败，请重试')
      return false
    }
  }

  closeAll() {
    const entries = [...this.registry.values()]
    try {
      for (const entry of entries) this.destroyEntry(entry)
      this.repository.deleteAll()
      for (const entry of entries) entry.persisted = false
      this.onRegistryChanged?.()
      console.log('[sticky] 用户已关闭全部便利贴')
      return true
    } catch (error) {
      console.error('[sticky] 关闭全部便利贴失败:', error)
      this.onError?.('关闭全部便利贴失败，请重试')
      return false
    }
  }

  discardByNoteId(noteId) {
    const parsedNoteId = Number(noteId)
    for (const entry of [...this.registry.values()]) {
      if (entry.noteId !== parsedNoteId) continue
      try {
        entry.persisted = false
        this.destroyEntry(entry)
      } catch (error) {
        console.error(`[sticky] 彻底删除来源便签后关闭便利贴失败 (${entry.id}):`, error)
      }
    }
  }

  discardAllRuntime() {
    for (const entry of [...this.registry.values()]) {
      try {
        entry.persisted = false
        this.destroyEntry(entry)
      } catch (error) {
        console.error(`[sticky] 清空数据后关闭便利贴失败 (${entry.id}):`, error)
      }
    }
  }

  destroyEntry(entry) {
    if (!entry) return
    if (entry.boundsPersistTimer) {
      clearTimeout(entry.boundsPersistTimer)
      entry.boundsPersistTimer = null
    }
    if (!entry.window.isDestroyed()) {
      entry.window.destroy()
    } else {
      this.removeEntry(entry)
    }
  }

  removeEntry(entry) {
    if (this.registry.get(entry.id) !== entry) return
    if (entry.boundsPersistTimer) clearTimeout(entry.boundsPersistTimer)
    entry.boundsPersistTimer = null
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
        entry.workArea = { ...target.workArea }
        this.scheduleBoundsPersistence(entry)
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
        entry.workArea = { ...target.workArea }
        this.scheduleBoundsPersistence(entry)
      }
    }
  }

  dispose() {
    if (!this.initialized) return
    this.disposing = true
    for (const entry of [...this.registry.values()]) {
      if (entry.boundsPersistTimer) {
        clearTimeout(entry.boundsPersistTimer)
        entry.boundsPersistTimer = null
      }
      this.persistBounds(entry)
      this.destroyEntry(entry)
    }
    this.displayManager.stop()
    for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel)
    this.initialized = false
  }
}
