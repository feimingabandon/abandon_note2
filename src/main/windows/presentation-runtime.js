import { PRESENTATION_MODES, PresentationModeController } from './presentation-mode-controller.js'
import {
  COMPACT_WINDOW_LIMITS,
  compactBoundsFromAnchor
} from '../../shared/window-compact-geometry.js'
import { WINDOW_Z_ORDER_MODES } from '../../shared/settings-schema.js'
import { setConfig as blurSetConfig } from '../bridge/blur_bridge.js'
import { constrainMainWindowBounds, getWindowBoundsUpdate } from '../window-bounds.js'

/** Complete Electron/native/renderer adaptation around one PresentationModeController. */
export function createPresentationRuntime({
  getMainWindow,
  screen,
  getSettings,
  isWindowLocked,
  getUserHideGeneration = () => 0,
  geometryPersistence,
  resolveActiveViewWindowBounds,
  restoreDockWindowToVisiblePosition,
  resetDockState,
  endTitlebarWindowDrag,
  beginDockInteractionSuspension,
  endDockInteractionSuspension,
  captureMotionBounds,
  setDockPosition,
  dipBoundsToPhysical,
  resolvedDragPoint,
  readBlurState,
  synchronizePresentationBlur,
  getZOrderMode,
  applyWindowZOrder,
  reassertBottomWindowZOrder,
  applyResolvedWindowRuntime,
  reconcileExpandedDisplayGeometry,
  persistSettingValues,
  logger
}) {
  const MAIN_WINDOW_MIN_SIZE = 240
  let attachedWindow = null
  let stopping = false
  const cancellation = (message) =>
    Object.assign(new Error(message), { code: 'PRESENTATION_CANCELLED' })
  const PRESENTATION_RENDERER_READY_TIMEOUT_MS = 3000

  let compactExpandedBounds = null

  let stableCompactBounds = null

  let compactDragSession = null

  let compactDockSuspended = false

  const presentationRendererWaiters = new Map()

  const acknowledgedPresentationOperations = new Set()

  const presentationModeController = new PresentationModeController({
    onStateChanged: () => broadcastPresentationModeState(),
    onError: (error, context) => {
      if (stopping) logger.info('presentation-mode.cancel', error.message, context)
      else logger.error('presentation-mode.controller', error, context)
    }
  })

  let compactResizePersistenceTimer = null

  let pendingCompactResizeBounds = null
  let pendingDisplayRecovery = null
  let displayRecoveryWait = null
  let automaticCompactTarget = null
  let automaticCompactDepth = 0

  function clearDisplayRecovery() {
    pendingDisplayRecovery = null
    displayRecoveryWait = null
    automaticCompactTarget = null
  }

  function drainDisplayRecovery() {
    const ticket = pendingDisplayRecovery
    if (!ticket) return
    if (stopping || ticket.window !== getMainWindow() || ticket.window.isDestroyed()) {
      clearDisplayRecovery()
      return
    }
    if (presentationModeController.isBusy()) {
      const active = presentationModeController.activePromise()
      // A synchronous window callback may arrive before request() assigns its promise.
      if (!active) {
        queueMicrotask(() => {
          if (pendingDisplayRecovery === ticket) safelyDrainDisplayRecovery()
        })
      } else if (displayRecoveryWait !== active) {
        displayRecoveryWait = active
        const finish = () => {
          if (displayRecoveryWait !== active) return
          displayRecoveryWait = null
          safelyDrainDisplayRecovery()
        }
        void active.then(finish, finish)
      }
      return
    }
    pendingDisplayRecovery = null
    if (!presentationModeController.isCompact()) {
      reconcileExpandedDisplayGeometry(ticket.change)
      return
    }
    const window = ticket.window
    flushCompactWindowSizePersistence('display-recovery-before')
    const current = window.getBounds()
    const center = { x: current.x + current.width / 2, y: current.y + current.height / 2 }
    const display = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay()
    const safe = compactBoundsFromAnchor({
      anchor: center,
      size: current,
      workArea: display.workArea
    })
    const update = getWindowBoundsUpdate(current, safe)
    automaticCompactTarget = { ...safe }
    automaticCompactDepth++
    try {
      window.setMinimumSize(
        Math.min(COMPACT_WINDOW_LIMITS.minWidth, safe.width),
        Math.min(COMPACT_WINDOW_LIMITS.minHeight, safe.height)
      )
      if (update.mode === 'position') window.setPosition(update.x, update.y)
      else if (update.mode === 'bounds') window.setBounds(update.bounds, false)
      stableCompactBounds = { ...window.getBounds() }
      automaticCompactTarget = { ...stableCompactBounds }
    } finally {
      automaticCompactDepth--
    }
    // Preserve hidden-to-tray state and durable user dimensions during automatic fitting.
    if (window.isVisible()) {
      synchronizePresentationBlur(window, 'presentation-display-recovery')
      if (getZOrderMode() === WINDOW_Z_ORDER_MODES.BOTTOM)
        reassertBottomWindowZOrder('presentation-display-recovery')
      else applyWindowZOrder()
    }
    broadcastPresentationModeState()
  }

  function safelyDrainDisplayRecovery() {
    try {
      drainDisplayRecovery()
      return true
    } catch (error) {
      clearDisplayRecovery()
      logger.error('presentation-mode.display-recovery', error)
      return false
    }
  }

  function reconcileDisplayGeometry(change = null) {
    const window = getMainWindow()
    if (stopping || !window || window.isDestroyed() || window !== attachedWindow) return false
    if (!isCompactPresentationActive()) return false
    pendingDisplayRecovery = { window, change }
    return safelyDrainDisplayRecovery()
  }

  function isCompactPresentationSupported() {
    return process.platform === 'win32'
  }

  function isCompactPresentationActive() {
    return presentationModeController.isCompact() || presentationModeController.isBusy()
  }

  function presentationModeSnapshot() {
    const window = getMainWindow()
    return {
      supported: isCompactPresentationSupported(),
      mode: presentationModeController.committedMode,
      desiredMode: presentationModeController.desiredMode,
      operation: presentationModeController.snapshot().operation,
      bounds: window && !window.isDestroyed() ? window.getBounds() : null
    }
  }

  function broadcastPresentationModeState() {
    // 当前事务收口后，迟到的 Renderer ACK 不得留在下一次事务之外。
    if (!presentationModeController.operation) acknowledgedPresentationOperations.clear()
    if (
      !getMainWindow() ||
      getMainWindow().isDestroyed() ||
      getMainWindow().webContents.isDestroyed() ||
      getMainWindow().webContents.isLoadingMainFrame()
    ) {
      return
    }
    getMainWindow().webContents.send('presentation-mode:state-changed', presentationModeSnapshot())
  }

  function acknowledgePresentationRenderer(operationId) {
    if (stopping) return false
    const normalized = Number(operationId)
    if (!Number.isInteger(normalized) || presentationModeController.operation?.id !== normalized) {
      return false
    }
    const waiter = presentationRendererWaiters.get(normalized)
    if (waiter) waiter.resolve()
    else acknowledgedPresentationOperations.add(normalized)
    return true
  }

  function waitForPresentationRenderer(operationId) {
    if (acknowledgedPresentationOperations.delete(operationId)) return Promise.resolve()
    return new Promise((resolveReady, rejectReady) => {
      const cleanup = () => {
        clearTimeout(timer)
        presentationRendererWaiters.delete(operationId)
        acknowledgedPresentationOperations.delete(operationId)
      }
      const timer = setTimeout(() => {
        cleanup()
        rejectReady(new Error(`等待窗口展示模式 ${operationId} 渲染就绪超时`))
      }, PRESENTATION_RENDERER_READY_TIMEOUT_MS)
      presentationRendererWaiters.set(operationId, {
        resolve: () => {
          cleanup()
          resolveReady()
        },
        reject: (error) => {
          cleanup()
          rejectReady(error)
        }
      })
    })
  }

  function persistStableExpandedBounds(bounds) {
    compactExpandedBounds = geometryPersistence.persistStableBounds(bounds)
  }

  function hideWindowForPresentationCommit(window, source) {
    if (!window || window.isDestroyed()) return
    if (readBlurState().initialized) {
      try {
        blurSetConfig({ ...readBlurState().config, enabled: false })
      } catch (error) {
        logger.error('presentation-mode.blur-hide', error, { source })
      }
    }
    window.hide()
  }

  function showCommittedPresentation(window, source, context) {
    if (stopping) return
    if (
      context?.showWhenDone === false ||
      context?.hideGeneration !== getUserHideGeneration() ||
      !window ||
      window.isDestroyed()
    )
      return
    window.show()
    synchronizePresentationBlur(window, source)
    if (getZOrderMode() === WINDOW_Z_ORDER_MODES.BOTTOM) reassertBottomWindowZOrder(source)
    else applyWindowZOrder()
    window.focus()
  }

  function resolveExpandedBoundsForRecovery() {
    const storedBounds =
      compactExpandedBounds ||
      (geometryPersistence.getStableBounds() && !presentationModeController.isCompact()
        ? geometryPersistence.getStableBounds()
        : resolveActiveViewWindowBounds().bounds)
    const display = screen.getDisplayMatching(storedBounds)
    return constrainMainWindowBounds(storedBounds, display.workArea)
  }

  async function performPresentationModeCommit({ window, operation }) {
    const assertCurrentWindow = () => {
      if (stopping) throw cancellation('应用正在退出，展示模式操作已取消')
      if (window !== getMainWindow() || window.isDestroyed())
        throw new Error('主窗口已变化，展示模式操作已取消')
    }
    assertCurrentWindow()
    if (!window || window.isDestroyed()) throw new Error('主窗口不可用')

    if (operation.to === PRESENTATION_MODES.COMPACT) {
      if (!isCompactPresentationSupported()) throw new Error('灵动岛目前仅支持 Windows 10/11')
      restoreDockWindowToVisiblePosition()
      resetDockState({ source: 'presentation-compact' })
      endTitlebarWindowDrag()
      const expandedBounds = getMainWindow().getBounds()
      persistStableExpandedBounds(expandedBounds)
      if (!compactDockSuspended) {
        beginDockInteractionSuspension('presentation-compact')
        compactDockSuspended = true
      }
      const anchor = resolvedDragPoint(operation.context?.anchor)
      const display = screen.getDisplayNearestPoint(anchor)
      stableCompactBounds = compactBoundsFromAnchor({
        anchor,
        size: {
          width: getSettings().window.compactWidth,
          height: getSettings().window.compactHeight
        },
        workArea: display.workArea
      })
      presentationModeController.setOperationTargetBounds(operation.id, stableCompactBounds)
      broadcastPresentationModeState()
      hideWindowForPresentationCommit(window, 'compact')
      await waitForPresentationRenderer(operation.id)
      assertCurrentWindow()
      window.setMinimumSize(COMPACT_WINDOW_LIMITS.minWidth, COMPACT_WINDOW_LIMITS.minHeight)
      window.setBounds(stableCompactBounds, false)
      stableCompactBounds = { ...window.getBounds() }
      showCommittedPresentation(window, 'presentation-compact', operation.context)
      return { bounds: { ...stableCompactBounds } }
    }

    const expandedBounds = resolveExpandedBoundsForRecovery()
    presentationModeController.setOperationTargetBounds(operation.id, expandedBounds)
    broadcastPresentationModeState()
    hideWindowForPresentationCommit(window, 'expanded')
    await waitForPresentationRenderer(operation.id)
    assertCurrentWindow()
    window.setBounds(expandedBounds, false)
    window.setMinimumSize(MAIN_WINDOW_MIN_SIZE, MAIN_WINDOW_MIN_SIZE)
    geometryPersistence.setStableBounds({ ...window.getBounds() })
    stableCompactBounds = null
    automaticCompactTarget = null
    if (compactDockSuspended) {
      compactDockSuspended = false
      endDockInteractionSuspension('presentation-expanded')
    }
    showCommittedPresentation(window, 'presentation-expanded', operation.context)
    return { bounds: { ...geometryPersistence.getStableBounds() } }
  }

  async function recoverExpandedPresentation({ window, operation, error }) {
    if (stopping || window !== getMainWindow()) return
    if (!window || window.isDestroyed()) return
    logger.warn('presentation-mode.recover', '展示模式切换失败，强制恢复主视图', {
      operationId: operation.id,
      from: operation.from,
      to: operation.to,
      error: error?.message
    })
    presentationRendererWaiters.get(operation.id)?.resolve()
    try {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send('presentation-mode:force-expanded', { operationId: operation.id })
      }
    } catch (rendererError) {
      logger.warn('presentation-mode.recover-renderer', '渲染进程恢复通知发送失败', {
        operationId: operation.id,
        error: rendererError?.message
      })
    }
    hideWindowForPresentationCommit(window, 'recovery')
    const expandedBounds = resolveExpandedBoundsForRecovery()
    window.setBounds(expandedBounds, false)
    window.setMinimumSize(MAIN_WINDOW_MIN_SIZE, MAIN_WINDOW_MIN_SIZE)
    geometryPersistence.setStableBounds({ ...window.getBounds() })
    stableCompactBounds = null
    automaticCompactTarget = null
    if (compactDockSuspended) {
      compactDockSuspended = false
      endDockInteractionSuspension('presentation-recovery')
    }
    applyResolvedWindowRuntime()
    showCommittedPresentation(window, 'presentation-recovery', operation.context)
  }

  function requestPresentationMode(mode, context = {}) {
    if (stopping)
      return Promise.resolve({ changed: false, mode: presentationModeController.committedMode })
    if (!getMainWindow() || getMainWindow().isDestroyed()) {
      return Promise.resolve({ changed: false, mode: PRESENTATION_MODES.EXPANDED })
    }
    return presentationModeController.request(
      getMainWindow(),
      mode,
      {
        ...context,
        hideGeneration: getUserHideGeneration()
      },
      {
        perform: performPresentationModeCommit,
        recover: recoverExpandedPresentation
      }
    )
  }

  function enterCompactPresentation(anchor) {
    if (isWindowLocked()) {
      return Promise.reject(new Error('窗口已锁定：切换为灵动岛会改变窗口位置和尺寸，请先解锁'))
    }
    return requestPresentationMode(PRESENTATION_MODES.COMPACT, {
      source: 'titlebar-double-click',
      anchor: resolvedDragPoint(anchor),
      showWhenDone: true
    })
  }

  function exitCompactPresentation({ source = 'compact-double-click', showWhenDone = true } = {}) {
    if (compactDragSession) endCompactWindowDrag()
    return requestPresentationMode(PRESENTATION_MODES.EXPANDED, {
      source,
      showWhenDone
    })
  }

  function beginCompactWindowDrag(pointerOrigin) {
    if (stopping) return false
    if (
      isWindowLocked() ||
      !presentationModeController.isCompact() ||
      presentationModeController.isBusy() ||
      compactDragSession ||
      !getMainWindow() ||
      getMainWindow().isDestroyed()
    ) {
      return false
    }
    let motionBounds
    try {
      motionBounds = captureMotionBounds()
    } catch (error) {
      logger.error('presentation-mode.drag-start', error)
      return false
    }
    if (!motionBounds) return false
    const bounds = getMainWindow().getBounds()
    const contentBounds = getMainWindow().getContentBounds()
    compactDragSession = {
      cursor: resolvedDragPoint(pointerOrigin),
      bounds,
      lastPosition: { x: bounds.x, y: bounds.y },
      moved: false,
      motionPlan: {
        initial: motionBounds,
        expectedSize: { width: motionBounds.width, height: motionBounds.height },
        expectedElectronContentSize: {
          width: contentBounds.width,
          height: contentBounds.height
        }
      }
    }
    return true
  }

  function updateCompactWindowDrag(pointerPosition) {
    if (stopping) return false
    if (!compactDragSession || !getMainWindow() || getMainWindow().isDestroyed()) return false
    const session = compactDragSession
    const cursor = resolvedDragPoint(pointerPosition)
    const position = {
      x: Math.round(session.bounds.x + cursor.x - session.cursor.x),
      y: Math.round(session.bounds.y + cursor.y - session.cursor.y)
    }
    if (position.x === session.lastPosition.x && position.y === session.lastPosition.y) return false
    const display = screen.getDisplayNearestPoint(cursor)
    const constrained = compactBoundsFromAnchor({
      anchor: {
        x: position.x + session.bounds.width / 2,
        y: position.y + session.bounds.height / 2
      },
      size: session.bounds,
      workArea: display.workArea
    })
    const motionPosition =
      session.motionPlan.initial.coordinateSpace === 'physical'
        ? dipBoundsToPhysical(getMainWindow(), { ...session.bounds, ...constrained })
        : constrained
    try {
      setDockPosition(motionPosition, session.motionPlan)
      session.lastPosition = { x: constrained.x, y: constrained.y }
      stableCompactBounds = { ...constrained }
      session.moved = true
      return true
    } catch (error) {
      logger.error('presentation-mode.drag-move', error, { position: constrained })
      return false
    }
  }

  function endCompactWindowDrag() {
    const session = compactDragSession
    if (!session) return false
    compactDragSession = null
    if (!stopping && session.moved && getMainWindow() && !getMainWindow().isDestroyed()) {
      stableCompactBounds = { ...getMainWindow().getBounds() }
      synchronizePresentationBlur(getMainWindow(), 'presentation-drag-end')
    }
    if (!stopping && getZOrderMode() === WINDOW_Z_ORDER_MODES.BOTTOM) {
      reassertBottomWindowZOrder('presentation-drag-end')
    }
    return session.moved
  }

  function persistCompactWindowSize(bounds, source) {
    const width = Math.round(Number(bounds?.width))
    const height = Math.round(Number(bounds?.height))
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false
    persistSettingValues([
      { id: 'window.compactWidth', value: width },
      { id: 'window.compactHeight', value: height }
    ])
    pendingCompactResizeBounds = null
    if (compactResizePersistenceTimer) {
      clearTimeout(compactResizePersistenceTimer)
      compactResizePersistenceTimer = null
    }
    logger.info('presentation-mode.resize-persist', '灵动岛尺寸已保存', {
      source,
      width: getSettings().window.compactWidth,
      height: getSettings().window.compactHeight
    })
    return true
  }

  function flushCompactWindowSizePersistence(source = 'resize-idle') {
    const bounds = pendingCompactResizeBounds
    if (!bounds) return false
    try {
      return persistCompactWindowSize(bounds, source)
    } catch (error) {
      logger.error('presentation-mode.resize-persist', error, { source, bounds })
      return false
    }
  }

  function scheduleCompactWindowSizePersistence(bounds) {
    pendingCompactResizeBounds = { ...bounds }
    if (compactResizePersistenceTimer) clearTimeout(compactResizePersistenceTimer)
    compactResizePersistenceTimer = setTimeout(() => {
      compactResizePersistenceTimer = null
      if (stopping) return
      flushCompactWindowSizePersistence('resize-idle')
    }, 300)
  }

  function finishCompactWindowResize() {
    if (
      !presentationModeController.isCompact() ||
      presentationModeController.isBusy() ||
      !getMainWindow() ||
      getMainWindow().isDestroyed()
    ) {
      return false
    }
    stableCompactBounds = { ...getMainWindow().getBounds() }
    automaticCompactTarget = null
    pendingCompactResizeBounds = { ...stableCompactBounds }
    flushCompactWindowSizePersistence('pointer-finish')
    synchronizePresentationBlur(getMainWindow(), 'presentation-resize-end')
    return true
  }
  function initialize(window, expandedBounds) {
    attachedWindow = window
    presentationModeController.initialize(window)
    compactExpandedBounds = { ...expandedBounds }
    stableCompactBounds = null
  }
  function handleResize(bounds) {
    if (stopping) return false
    if (!presentationModeController.isCompact() || presentationModeController.isBusy()) return false
    stableCompactBounds = { ...bounds }
    // Cover synchronous minimum/bounds changes and a delayed Electron resize echo.
    // A subsequent user resize with different bounds follows the normal persistence path.
    if (
      automaticCompactDepth > 0 ||
      (automaticCompactTarget &&
        ['x', 'y', 'width', 'height'].every((key) => bounds[key] === automaticCompactTarget[key]))
    )
      return true
    automaticCompactTarget = null
    scheduleCompactWindowSizePersistence(stableCompactBounds)
    return true
  }
  function releaseWindow(window) {
    if (window !== attachedWindow) return false
    clearDisplayRecovery()
    for (const waiter of presentationRendererWaiters.values())
      waiter.reject(new Error('主窗口已关闭，展示模式操作已取消'))
    presentationRendererWaiters.clear()
    acknowledgedPresentationOperations.clear()
    compactDragSession = null
    if (compactResizePersistenceTimer) clearTimeout(compactResizePersistenceTimer)
    compactResizePersistenceTimer = null
    if (compactDockSuspended) {
      compactDockSuspended = false
      endDockInteractionSuspension('presentation-window-closed')
    }
    attachedWindow = null
    return true
  }
  function prepareShutdown() {
    if (stopping) return
    stopping = true
    clearDisplayRecovery()
    for (const waiter of presentationRendererWaiters.values())
      waiter.reject(cancellation('应用正在退出，展示模式操作已取消'))
    presentationRendererWaiters.clear()
    acknowledgedPresentationOperations.clear()
    if (compactResizePersistenceTimer) clearTimeout(compactResizePersistenceTimer)
    compactResizePersistenceTimer = null
    flushCompactWindowSizePersistence('before-quit')
    if (compactDragSession) endCompactWindowDrag()
    if (compactDockSuspended) {
      compactDockSuspended = false
      endDockInteractionSuspension('presentation-shutdown')
    }
  }
  return {
    initialize,
    handleResize,
    reconcileDisplayGeometry,
    releaseWindow,
    prepareShutdown,
    isCompact: () => presentationModeController.isCompact(),
    isBusy: () => presentationModeController.isBusy(),
    settled: () => presentationModeController.activePromise() || Promise.resolve(),
    isCompactPresentationSupported,
    isCompactPresentationActive,
    presentationModeSnapshot,
    acknowledgePresentationRenderer,
    enterCompactPresentation,
    exitCompactPresentation,
    beginCompactWindowDrag,
    updateCompactWindowDrag,
    endCompactWindowDrag,
    finishCompactWindowResize,
    resourceSnapshot: () => ({
      attached: Boolean(attachedWindow),
      stopping,
      pendingRenderer: presentationRendererWaiters.size,
      acknowledged: acknowledgedPresentationOperations.size,
      resizeTimer: Boolean(compactResizePersistenceTimer),
      pendingSize: Boolean(pendingCompactResizeBounds),
      pendingDisplayRecovery: Boolean(pendingDisplayRecovery),
      dragging: Boolean(compactDragSession),
      suspended: compactDockSuspended
    })
  }
}
