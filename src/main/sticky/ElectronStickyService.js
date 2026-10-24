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
  STICKY_ALWAYS_ON_TOP_LEVEL,
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

class StickyCreationError extends Error {
  constructor(message, { cause, committed = false, stickyId } = {}) {
    super(message, { cause })
    this.committed = committed
    this.stickyId = stickyId
  }
}

export class ElectronStickyService extends StickyService {
  constructor({
    getMainWindow,
    getNoteById,
    getDefaultAppearance,
    preloadPath,
    rendererFile,
    rendererUrl,
    stickyRepository,
    saveContent,
    runMutation = (operation) => operation(),
    bindMutationContinuation = (operation) => operation,
    logger = null,
    isDevelopment = false,
    onRegistryChanged,
    onNoteChanged,
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
    this.saveContent = saveContent
    this.runMutation = runMutation
    this.bindMutationContinuation = bindMutationContinuation
    this.logger = logger
    this.onNoteChanged = onNoteChanged
    this.onError = onError
    this.registry = new Map()
    this.byWebContentsId = new Map()
    this.initialized = false
    this.initializationsStopped = false
    this.registeredChannels = []
    this.disposing = false
    this.lifecycleGeneration = 0
    this.restorePromise = null
    this.rendererRecoveryAttempts = new Map()
    this.rendererRecoveryTimers = new Map()
    this.displayManager = new StickyDisplayManager(screen, (change) =>
      this.handleDisplayTopologyChange(change)
    )
  }

  initialize() {
    if (this.initialized || this.initializationsStopped) return
    this.lifecycleGeneration += 1
    this.initialized = true
    this.disposing = false
    const handle = (channel, handler) => {
      ipcMain.handle(channel, handler)
      this.registeredChannels.push(channel)
    }
    try {
      this.displayManager.start()

      handle('sticky:create', async (event, payload) => {
        const mainWindow = this.getMainWindow()
        if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
          return { ok: false, message: '无法创建便利贴' }
        }
        try {
          const sticky = await this.runMutation(() => this.create({ noteId: payload?.noteId }))
          return { ok: true, sticky }
        } catch (error) {
          if (error instanceof StickyCreationError) {
            console.warn(`[sticky] 创建便利贴被拒绝 (noteId=${payload?.noteId}):`, error.message)
          } else {
            console.error(`[sticky] 创建便利贴失败 (noteId=${payload?.noteId}):`, error)
          }
          return {
            ok: false,
            message:
              error instanceof StickyCreationError ? error.message : '无法创建便利贴，请重试',
            ...(error?.committed ? { committed: true, stickyId: error.stickyId } : {}),
            ...(error?.cleanupError ? { cleanupIncomplete: true } : {})
          }
        }
      })
      handle('sticky:get-state', (event) => this.getStateForSender(event.sender.id))
      handle('sticky:ready', (event) => this.markReady(event.sender.id))
      handle('sticky:close', (event) =>
        this.runMutation(() => this.closeForSender(event.sender.id))
      )
      handle('sticky:toggle-pin', (event) =>
        this.runMutation(() => this.togglePinForSender(event.sender.id))
      )
      handle('sticky:update-content', (event, content) =>
        this.runMutation(() => this.updateContentForSender(event.sender.id, content))
      )
      handle('sticky:update-appearance', (event, payload) =>
        this.runMutation(() => this.updateAppearanceForSender(event.sender.id, payload))
      )
    } catch (error) {
      try {
        this.dispose()
      } catch (cleanupError) {
        console.error('[sticky] 部分初始化资源清理失败:', cleanupError)
      }
      throw error
    }
  }

  async create({ noteId }) {
    if (this.initializationsStopped) throw new StickyCreationError('便利贴初始化已停止')
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
    if (this.initializationsStopped) throw new StickyCreationError('便利贴初始化已停止')
    const deadline = Date.now() + STICKY_READY_TIMEOUT_MS
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
      readyTimer: null,
      boundsPersistTimer: null,
      createdAt,
      lastFocusedAt: Date.now(),
      persisted
    }
    const initialization = {
      state: 'pending',
      generation: this.lifecycleGeneration,
      deadline,
      error: null,
      continueReady: null,
      commitInProgress: false,
      stopAfterCommit: false,
      stopCleanupInProgress: false,
      resolve: null,
      promise: null
    }
    initialization.promise = new Promise((resolve) => {
      initialization.resolve = resolve
    })
    entry.initialization = initialization
    // Check before entering the retained mutation scope. This wrapper exists as
    // soon as ownership is registered, including constructor-stop cleanup failure.
    entry.completeReady = () =>
      initialization.state === 'pending' && initialization.continueReady
        ? initialization.continueReady()
        : false
    this.registry.set(id, entry)
    this.byWebContentsId.set(entry.webContentsId, id)
    // BrowserWindow construction emits synchronous app callbacks before returning.
    // If one stopped initialization, own the new window before cancelling it so
    // a failed destroy still remains available to the normal disposal retry.
    if (this.initializationsStopped) {
      try {
        this.destroyEntry(entry)
      } catch (error) {
        this.logInitializationError(
          'sticky.stop-initialization',
          `[sticky] 构造期间停止初始化后关闭窗口失败 (${entry.id}):`,
          error,
          entry
        )
      }
    } else {
      try {
        initialization.continueReady = this.bindMutationContinuation(() =>
          this.completeReady(entry)
        )
        if (this.initializationsStopped || initialization.state !== 'pending') {
          // bindMutationContinuation itself may synchronously trigger shutdown.
          initialization.continueReady = null
        } else {
          entry.readyTimer = setTimeout(
            () =>
              this.failInitialization(entry, new StickyCreationError('便利贴初始化失败，请重试')),
            Math.max(0, deadline - Date.now())
          )
          this.attachWindowListeners(entry)
          if (pinned) this.applyAlwaysOnTop(win, true)
          setWindowLogContext(win, { role: 'sticky', stickyId: id, noteId })
          this.notifyRegistryChanged()
          // Notification callbacks may also stop this entry. Never load its page
          // after cancellation, even when the cancelled window failed to close.
          if (!this.initializationsStopped && initialization.state === 'pending') {
            // The renderer sends ready after applying its content and appearance;
            // browser load completion is observed, not another business gate.
            try {
              const loading = this.rendererUrl
                ? win.loadURL(this.rendererUrl)
                : win.loadFile(this.rendererFile)
              void Promise.resolve(loading).catch((error) =>
                this.handleEntryLoadFailure(entry, error)
              )
            } catch (error) {
              this.handleEntryLoadFailure(entry, error)
            }
          }
        }
      } catch (error) {
        this.failInitialization(
          entry,
          new StickyCreationError(error?.message || '便利贴初始化失败，请重试', { cause: error })
        )
      }
    }

    const outcome = await initialization.promise
    if (outcome.error) throw outcome.error
    return outcome.value
  }

  notifyRegistryChanged() {
    try {
      this.onRegistryChanged?.()
    } catch (error) {
      console.error('[sticky] 刷新便利贴注册表通知失败:', error)
    }
  }

  logInitializationError(event, message, error, entry, details = {}) {
    try {
      console.error(message, error)
    } catch {
      // Diagnostic sink failure must never replace the operation's terminal result.
    }
    try {
      this.logger?.error?.(event, error, { stickyId: entry.id, ...details })
    } catch {
      // The original creation result retains the error even if both sinks fail.
    }
  }

  settleInitialization(entry, state, error = null) {
    const initialization = entry.initialization
    if (!['pending', 'committing', 'cancelling'].includes(initialization?.state)) return false
    initialization.state = state
    initialization.error = error
    initialization.continueReady = null
    if (entry.readyTimer) clearTimeout(entry.readyTimer)
    entry.readyTimer = null
    initialization.resolve({
      error,
      value: error ? null : { id: entry.id, count: this.registry.size, limit: MAX_STICKY_WINDOWS }
    })
    initialization.resolve = null
    return true
  }

  cancelInitialization(entry) {
    const committed = entry.persisted
    return this.settleInitialization(
      entry,
      'cancelled',
      new StickyCreationError(
        committed ? '便利贴初始化已取消，已保存记录保留供下次恢复' : '便利贴初始化已取消',
        { committed, stickyId: entry.id, cause: entry.initialization?.cancellationCause }
      )
    )
  }

  stopInitializations() {
    const report = {
      stopped: true,
      alreadyStopped: this.initializationsStopped,
      cancelled: [],
      preserved: [],
      pendingCommit: [],
      cleanupErrors: []
    }
    // Seal every entry point before destruction can invoke user callbacks. An
    // admitted restore scope may outlive admission shutdown, so invalidate it too.
    this.initializationsStopped = true
    this.lifecycleGeneration += 1
    this.restorePromise = null
    this.clearAllRendererRecovery()
    const entries = [...this.registry.values()]
    for (const entry of entries) {
      if (entry.boundsPersistTimer) clearTimeout(entry.boundsPersistTimer)
      entry.boundsPersistTimer = null
      const initialization = entry.initialization
      if (entry.ready && initialization?.state === 'succeeded') {
        report.preserved.push(entry.id)
        continue
      }
      if (['pending', 'committing', 'cancelling'].includes(initialization?.state)) {
        initialization.state = 'cancelling'
        initialization.continueReady = null
        if (entry.readyTimer) clearTimeout(entry.readyTimer)
        entry.readyTimer = null
        if (initialization.commitInProgress) {
          // insert may not have returned yet. Its synchronous stack must publish
          // the real persisted result before cancellation constructs its error.
          initialization.stopAfterCommit = true
          report.pendingCommit.push(entry.id)
        }
      }
    }
    for (const entry of entries) {
      const initialization = entry.initialization
      if (entry.ready || initialization?.commitInProgress || initialization?.stopCleanupInProgress)
        continue
      initialization.stopCleanupInProgress = true
      try {
        this.destroyEntry(entry)
      } catch (error) {
        report.cleanupErrors.push({ stickyId: entry.id, error })
      } finally {
        initialization.stopCleanupInProgress = false
      }
      if (entry.initialization?.state === 'cancelled') report.cancelled.push(entry.id)
    }
    // This is a synchronous snapshot. Deferred committing cleanup reports through
    // the original creation outcome and logger, never by mutating this report.
    return report
  }

  failInitialization(entry, error) {
    // A close request already owns cancellation; stopping the browser load while
    // it closes cannot replace that intent with a competing load/timeout failure.
    if (entry.initialization?.state === 'cancelling') return false
    if (!this.settleInitialization(entry, 'failed', error)) return false
    // Invalidate first, then destroy. A failing destroy retains the registry entry
    // for the normal shutdown cleanup retry, but can never revive initialization.
    try {
      this.destroyEntry(entry)
    } catch (cleanupError) {
      console.error(`[sticky] 初始化失败后关闭窗口失败 (${entry.id}):`, cleanupError)
    }
    return true
  }

  handleInitializationClose(entry, event) {
    const initialization = entry.initialization
    if (!['pending', 'committing', 'cancelling'].includes(initialization?.state)) return
    // The service owns close requests for its not-yet-ready window, including a
    // request another close listener prevents. Completed windows keep native close.
    event.preventDefault()
    if (initialization.state === 'cancelling') return
    initialization.state = 'cancelling'
    initialization.continueReady = null
    // Revoke ready synchronously, but let the close dispatch unwind before destroy.
    // destroyEntry settles cancellation and attempts cleanup in the same microtask,
    // before observers can see the resulting creation rejection.
    queueMicrotask(() => {
      try {
        this.destroyEntry(entry)
      } catch (error) {
        console.error(`[sticky] 初始化关闭请求清理失败 (${entry.id}):`, error)
      }
    })
  }

  markInitializationRecordRemoved(entry) {
    // close/closeAll remove records only after window destruction succeeded.
    // Until the SQL deletion succeeds, a cancelled restoration retains its row.
    const initialization = entry.initialization
    if (initialization?.state === 'cancelled' && initialization.error?.committed) {
      initialization.error.committed = false
      initialization.error.message = '便利贴初始化已取消'
    }
  }

  handleEntryLoadFailure(entry, error) {
    if (['pending', 'committing'].includes(entry.initialization.state)) {
      let restorationCancelled = false
      if (entry.persisted) {
        try {
          restorationCancelled = !this.repository.exists(entry.id)
        } catch {
          // Preserve the original load failure when the repository cannot be read.
        }
      }
      this.failInitialization(
        entry,
        new StickyCreationError(restorationCancelled ? '便利贴恢复已取消' : '便利贴页面加载失败', {
          cause: error
        })
      )
    }
    // A late load rejection does not undo an already committed and shown sticky.
    console.error(`[sticky] 页面加载失败 (${this.rendererUrl || this.rendererFile}):`, error)
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
    if (!this.initialized || this.disposing || this.initializationsStopped) return 0
    try {
      return this.repository.list().filter((record) => !this.registry.has(record.id)).length
    } catch (error) {
      console.error('[sticky] 读取可恢复便利贴数量失败:', error)
      return 0
    }
  }

  restoreMissing({ source = 'manual' } = {}) {
    if (!this.initialized || this.disposing || this.initializationsStopped)
      return Promise.resolve(0)
    if (this.restorePromise) return this.restorePromise
    const restoration = this.restoreMissingInternal(source, this.lifecycleGeneration)
      .catch((error) => {
        console.error(`[sticky] 恢复便利贴失败 (source=${source}):`, error)
        this.onError?.('恢复便利贴失败，请重试')
        return 0
      })
      .finally(() => {
        if (this.restorePromise === restoration) {
          this.restorePromise = null
          this.notifyRegistryChanged()
        }
      })
    this.restorePromise = restoration
    return restoration
  }

  async restoreMissingInternal(source, generation) {
    const records = this.repository.list()
    let restored = 0
    let failed = 0
    for (const record of records) {
      if (
        generation !== this.lifecycleGeneration ||
        this.disposing ||
        this.initializationsStopped ||
        this.registry.size >= MAX_STICKY_WINDOWS
      )
        break
      if (this.registry.has(record.id)) continue
      const recordId = String(record.id)
      try {
        if (!this.repository.exists(recordId)) continue
        const normalized = this.normalizeRestoredRecord(record)
        await this.openEntry({ ...normalized, persisted: true })
        if (generation !== this.lifecycleGeneration) return 0
        const entry = this.registry.get(recordId)
        if (!entry?.ready || entry.window.isDestroyed() || !this.repository.exists(recordId)) {
          if (entry) this.destroyEntry(entry)
          continue
        }
        restored += 1
      } catch (error) {
        if (generation !== this.lifecycleGeneration) return 0
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
    win.on('close', (event) => this.handleInitializationClose(entry, event))
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
    if (!entry.ready || !entry.persisted || this.disposing || this.initializationsStopped) return
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
    if (
      !this.initialized ||
      this.disposing ||
      this.initializationsStopped ||
      this.rendererRecoveryAttempts.has(id)
    )
      return
    try {
      if (!this.repository.exists(id)) return
    } catch (error) {
      console.warn('[sticky] 无法确认异常便利贴的恢复记录:', error)
      return
    }
    this.rendererRecoveryAttempts.set(id, 1)
    const generation = this.lifecycleGeneration
    const timer = setTimeout(() => {
      this.rendererRecoveryTimers.delete(id)
      void Promise.resolve()
        .then(() => {
          if (
            generation !== this.lifecycleGeneration ||
            !this.initialized ||
            this.disposing ||
            this.initializationsStopped ||
            !this.rendererRecoveryAttempts.has(id)
          )
            return
          return this.runMutation(() => this.restoreMissing({ source: 'renderer-gone' }))
        })
        .catch((error) => console.warn('[sticky] 便利贴恢复未准入:', error.message))
    }, 500)
    this.rendererRecoveryTimers.set(id, timer)
    timer.unref?.()
  }

  clearRendererRecovery(id) {
    clearTimeout(this.rendererRecoveryTimers.get(id))
    this.rendererRecoveryTimers.delete(id)
    this.rendererRecoveryAttempts.delete(id)
  }

  clearAllRendererRecovery() {
    for (const timer of this.rendererRecoveryTimers.values()) clearTimeout(timer)
    this.rendererRecoveryTimers.clear()
    this.rendererRecoveryAttempts.clear()
  }

  pruneRendererRecovery() {
    // Keep the retry guard while the persisted sticky exists, even without a window.
    // A deleted source note may have already removed a crashed sticky via SQL cascade.
    try {
      for (const id of this.rendererRecoveryAttempts.keys()) {
        if (!this.repository.exists(id)) this.clearRendererRecovery(id)
      }
    } catch (error) {
      console.warn('[sticky] 清理异常恢复记录失败:', error)
    }
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
    if (entry.ready) return true
    return entry.completeReady()
  }

  completeReady(entry) {
    const initialization = entry.initialization
    if (initialization?.state !== 'pending') return false
    if (
      !this.initialized ||
      this.disposing ||
      this.initializationsStopped ||
      initialization.generation !== this.lifecycleGeneration ||
      this.registry.get(entry.id) !== entry ||
      entry.window.isDestroyed()
    ) {
      this.cancelInitialization(entry)
      return false
    }
    if (Date.now() >= initialization.deadline) {
      this.failInitialization(entry, new StickyCreationError('便利贴初始化失败，请重试'))
      return false
    }
    initialization.state = 'committing'
    initialization.commitInProgress = true
    let phase = entry.persisted ? 'verify' : 'insert'
    try {
      if (entry.persisted) {
        if (!this.repository.exists(entry.id)) {
          throw new Error('便利贴记录已被删除，已停止恢复')
        }
      } else {
        this.repository.insert(this.toPersistentRecord(entry))
        entry.persisted = true
        console.log(`[sticky] 便利贴已持久化 (${entry.id})`)
      }
      phase = 'show'
      if (initialization.state !== 'committing') return false
      this.persistBounds(entry)
      if (initialization.state !== 'committing') return false
      if (entry.window.isDestroyed()) {
        this.removeEntry(entry)
        return false
      }
      entry.window.showInactive()
      if (initialization.state !== 'committing') return false
      if (entry.window.isDestroyed()) {
        this.removeEntry(entry)
        return false
      }
      if (!entry.window.isVisible()) throw new Error('便利贴窗口未能显示')
      entry.ready = true
      this.settleInitialization(entry, 'succeeded')
      this.notifyRegistryChanged()
      return true
    } catch (cause) {
      if (initialization.stopAfterCommit) {
        initialization.cancellationCause = cause
        this.logInitializationError(
          'sticky.stop-initialization-operation',
          `[sticky] 停止初始化时同步操作失败 (${entry.id}, phase=${phase}):`,
          cause,
          entry,
          { phase }
        )
        return false
      }
      const error = new StickyCreationError(
        phase === 'show'
          ? '便利贴已保存，但窗口显示失败，请通过托盘重试恢复'
          : phase === 'insert'
            ? '便利贴保存失败，未显示到桌面'
            : cause?.message === '便利贴记录已被删除，已停止恢复'
              ? cause.message
              : '便利贴记录验证失败，已停止恢复',
        { cause, committed: phase === 'show' && entry.persisted, stickyId: entry.id }
      )
      this.failInitialization(entry, error)
      throw error
    } finally {
      initialization.commitInProgress = false
      if (initialization.stopAfterCommit) {
        initialization.stopAfterCommit = false
        initialization.stopCleanupInProgress = true
        try {
          this.destroyEntry(entry)
        } catch (error) {
          this.logInitializationError(
            'sticky.stop-initialization',
            `[sticky] 停止初始化后关闭窗口失败 (${entry.id}):`,
            error,
            entry
          )
        } finally {
          initialization.stopCleanupInProgress = false
        }
      }
    }
  }

  closeForSender(webContentsId) {
    const entry = this.requireEntryForSender(webContentsId)
    if (!this.close(entry.id)) throw new Error('便利贴关闭失败，请重试')
    return true
  }

  togglePinForSender(webContentsId) {
    const entry = this.requireEntryForSender(webContentsId)
    const pinned = !entry.pinned
    this.applyAlwaysOnTop(entry.window, pinned)
    try {
      if (
        !this.repository.update(entry.id, {
          alwaysOnTop: pinned,
          updatedAt: Date.now()
        })
      ) {
        throw new Error('便利贴记录不存在')
      }
    } catch (error) {
      try {
        this.applyAlwaysOnTop(entry.window, entry.pinned)
      } catch (rollbackError) {
        console.error(`[sticky] 回滚便利贴置顶层级失败 (${entry.id}):`, rollbackError)
      }
      throw error
    }
    entry.pinned = pinned
    return { pinned: entry.pinned }
  }

  applyAlwaysOnTop(window, pinned) {
    window.setAlwaysOnTop(pinned, STICKY_ALWAYS_ON_TOP_LEVEL)
    if (window.isAlwaysOnTop() !== pinned) throw new Error('便利贴窗口层级切换失败')
  }

  updateContentForSender(webContentsId, value) {
    const entry = this.requireEntryForSender(webContentsId)
    const payload = value && typeof value === 'object' ? value : { content: value }
    const content = normalizeStickyContent(payload.content)
    const expectedContent =
      payload.expectedContent === undefined ? entry.content : String(payload.expectedContent)
    if (content === expectedContent && expectedContent === entry.content) {
      return { content: entry.content, conflict: false }
    }
    if (typeof this.saveContent !== 'function') throw new Error('便利贴编辑服务尚未就绪')
    const updatedAt = Date.now()
    const saveResult = this.saveContent({
      stickyId: entry.id,
      noteId: entry.noteId,
      content,
      expectedContent,
      updatedAt
    })
    if (saveResult?.conflict) {
      const currentContent = String(saveResult.content ?? entry.content)
      const otherOpenStickyCount = [...this.registry.values()].filter(
        (candidate) => candidate.noteId === entry.noteId && candidate.id !== entry.id
      ).length
      this.logger?.warn?.('sticky.content-conflict', '便利贴正文写入因版本冲突被拒绝', {
        stickyId: entry.id,
        noteId: entry.noteId,
        expectedLength: expectedContent.length,
        currentLength: currentContent.length,
        submittedLength: content.length,
        updatedAt,
        synchronizedOtherStickies: otherOpenStickyCount > 0,
        otherOpenStickyCount
      })
      this.syncOpenStickyContents(entry.noteId, currentContent, entry.id)
      try {
        this.onRegistryChanged?.()
      } catch (error) {
        console.error(`[sticky] 刷新便利贴托盘预览失败 (${entry.id}):`, error)
      }
      return {
        content: currentContent,
        conflict: true
      }
    }
    const updatedNote = saveResult?.note || saveResult
    if (!updatedNote) throw new Error('来源便签不存在或已被删除')
    this.syncOpenStickyContents(entry.noteId, content, entry.id)
    try {
      this.onRegistryChanged?.()
    } catch (error) {
      console.error(`[sticky] 刷新便利贴托盘预览失败 (${entry.id}):`, error)
    }
    try {
      this.onNoteChanged?.(updatedNote)
    } catch (error) {
      console.error(`[sticky] 广播来源便签更新失败 (${entry.id}):`, error)
    }
    console.log(`[sticky] 便利贴正文已保存 (${entry.id}, noteId=${entry.noteId})`)
    return { content, conflict: false }
  }

  syncOpenStickyContents(noteId, content, sourceStickyId) {
    for (const entry of this.registry.values()) {
      if (entry.noteId !== noteId) continue
      entry.content = content
      entry.preview = createStickyPreview(content, this.registry.size)
      if (
        entry.id !== sourceStickyId &&
        entry.ready &&
        !entry.window.isDestroyed() &&
        !entry.window.webContents.isDestroyed()
      ) {
        entry.window.webContents.send('sticky:content-changed', { content })
      }
    }
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
        this.clearRendererRecovery(id)
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
      this.markInitializationRecordRemoved(entry)
      this.clearRendererRecovery(id)
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
      this.clearAllRendererRecovery()
      for (const entry of entries) {
        entry.persisted = false
        this.markInitializationRecordRemoved(entry)
      }
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
    this.pruneRendererRecovery()
  }

  discardAllRuntime() {
    this.clearAllRendererRecovery()
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
    this.cancelInitialization(entry)
    if (entry.boundsPersistTimer) {
      clearTimeout(entry.boundsPersistTimer)
      entry.boundsPersistTimer = null
    }
    if (!entry.window.isDestroyed()) {
      try {
        entry.window.destroy()
        if (!entry.window.isDestroyed()) throw new Error('便利贴窗口未能关闭')
        // Setup can fail before the closed listener was installed. Do not rely on
        // that listener alone to release this operation's registered ownership.
        this.removeEntry(entry)
      } catch (error) {
        const initializationError = entry.initialization?.error
        if (initializationError && !initializationError.cleanupError) {
          initializationError.cleanupError = error?.message || String(error)
          initializationError.message += '；窗口清理失败，请正常退出应用以重试释放'
        }
        throw error
      }
    } else {
      this.removeEntry(entry)
    }
  }

  removeEntry(entry) {
    if (this.registry.get(entry.id) !== entry) return
    this.cancelInitialization(entry)
    if (entry.boundsPersistTimer) clearTimeout(entry.boundsPersistTimer)
    entry.boundsPersistTimer = null
    this.byWebContentsId.delete(entry.webContentsId)
    this.registry.delete(entry.id)
    this.notifyRegistryChanged()
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
    this.lifecycleGeneration += 1
    this.restorePromise = null
    this.clearAllRendererRecovery()
    if (!this.initialized && !this.registry.size) return
    this.disposing = true
    const failures = []
    for (const entry of [...this.registry.values()]) {
      if (entry.boundsPersistTimer) {
        clearTimeout(entry.boundsPersistTimer)
        entry.boundsPersistTimer = null
      }
      this.persistBounds(entry)
      try {
        this.destroyEntry(entry)
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      this.displayManager.stop()
    } catch (error) {
      failures.push(error)
    }
    for (const channel of this.registeredChannels.splice(0)) {
      try {
        ipcMain.removeHandler(channel)
      } catch (error) {
        failures.push(error)
      }
    }
    this.initialized = false
    if (failures.length) throw new AggregateError(failures, '便利贴资源释放失败')
  }
}
