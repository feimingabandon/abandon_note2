import {
  createDefaultSettings,
  DOCK_REVEAL_HANDLE_MODES,
  WINDOW_Z_ORDER_MODES
} from '../../shared/settings-schema.js'
import {
  updateGeometry as blurUpdateGeometry,
  reSyncZOrder as blurReSyncZOrder
} from '../bridge/blur_bridge.js'
import { createWindowMotionBackend } from './index.js'
import { DockTransitionState } from './dock-transition-state.js'
import {
  resolveFullscreenRebuildHandlePosition,
  stopEdgeMonitorForFullscreenRebuild
} from './dock-display-rebuild.js'
import {
  dockRuntimeConfigEqual,
  isCurrentDockMonitorEvent,
  normalizeDockRuntimeConfig,
  selectNearestDockSide
} from './dock-config.js'
import { inspectDockHealth } from './dock-health.js'
import { DockNativeStatusObserver } from '../logging/dock-native-status-observer.js'
import { diagnosticState, isDeepDiagnosticMode } from '../logging/diagnostic-state.js'
import { measureSyncPerformance } from '../logging/operation-performance.js'
import {
  createWindowMotionRecorder,
  flushNativeMotionDiagnostics
} from '../logging/window-motion-diagnostics.js'
import { constrainMainWindowBounds, getWindowBoundsUpdate } from '../window-bounds.js'

/** Owns the complete Dock session, motion backend, timers and native/display/power resources. */
export function createDockRuntime({
  getMainWindow,
  screen,
  powerMonitor,
  getViewMode,
  getActiveWindowProfile,
  getSettings,
  isWindowLocked,
  isQuitting,
  isCompactPresentationActive,
  reconcilePresentationDisplayGeometry,
  geometryPersistence,
  persistSettingValues,
  readBlurState,
  getZOrderMode,
  runBlurRuntimeOperation,
  applyWindowZOrder,
  reassertBottomWindowZOrder,
  logger,
  createMotionBackend = createWindowMotionBackend,
  subscribeDiagnosticPolicy = (listener) => diagnosticState.subscribe(listener)
}) {
  let attachedWindow = null
  let slideDiagnostics = null
  let stopping = false
  let disposed = false
  const SNAP_THRESHOLD = 20

  const EDGE_TRIGGER_THICKNESS_DIP = 2

  const EDGE_MONITOR_POLL_INTERVAL_MS = 50

  const MAX_EDGE_MONITOR_POLL_AGE_MS = 1000

  const SLIDE_DURATION = 200

  const SLIDE_INTERVAL = 16

  const HIDE_DELAY = 200

  const HIDE_OVERSHOOT = 4

  const DOCK_GEOMETRY_SUPPRESSION_MS = 1000

  const MAX_DOCK_SLIDE_AGE_MS = 5000

  const NATIVE_EDGE_CLEANUP_INITIAL_RETRY_MS = 1000

  const NATIVE_EDGE_CLEANUP_MAX_RETRY_MS = 30_000

  const DOCK_NATIVE_STATUS_OBSERVER_INTERVAL_MS = 250

  let dockSide = null

  let isDockHidden = false

  let cachedWorkArea = null

  let slideAnimTimer = null

  let hideTimer = null

  let pendingDockHideRequestedAt = null

  let isSliding = false

  let dockSlideStartedAt = null

  let pendingSlideCallback = null

  let dockMotionSession = null

  let dockSessionSequence = 0

  let edgeMonitorMessageId = null

  const dockTransitionState = new DockTransitionState()

  let windowMotionBackend = null

  let nativeEdgeCleanupPending = null

  let nativeEdgeCleanupTimer = null

  let dockInteractionSuspendCount = 0

  const dockNativeStatusObserver = new DockNativeStatusObserver({
    getStatus: () => windowMotionBackend?.getEdgeMonitorStatus() || {},
    getContext: getDockNativeObserverContext,
    logger,
    intervalMs: 2000
  })

  let dockGeometryReconcileTimer = null

  let dockDisplayChangeTimer = null

  const pendingDockDisplayChanges = []

  const dockDisplayListeners = []

  const dockPowerListeners = []

  let suppressDockGeometryPersistenceUntil = 0

  const unsubscribeDiagnosticPolicy = subscribeDiagnosticPolicy((policy) => {
    dockNativeStatusObserver.setInterval(
      policy.mode === 'deep' ? DOCK_NATIVE_STATUS_OBSERVER_INTERVAL_MS : 2000
    )
  })

  function getDockRuntimeConfig() {
    const profile = getActiveWindowProfile()
    // dockEdges 是开发期间的向后兼容；最终 profile 以 supportedDockEdges
    // 表达能力上限，用户设置不能越过该上限。
    const supportedEdges = profile.supportedDockEdges || profile.dockEdges || []
    const configuredDock = getSettings()?.dock ||
      createDefaultSettings(getViewMode()).dock || {
        revealHandleMode: DOCK_REVEAL_HANDLE_MODES.DIRECT,
        enabledEdges: supportedEdges
      }
    return normalizeDockRuntimeConfig(configuredDock, supportedEdges)
  }

  function getDockRuntimeCapability() {
    if (process.platform !== 'win32') {
      return {
        supported: false,
        reason: '当前平台没有原生边缘监视器'
      }
    }
    if (!windowMotionBackend) {
      return {
        supported: true,
        reason: null
      }
    }

    try {
      const status = windowMotionBackend.getEdgeMonitorStatus()
      if (status?.supported === false) {
        return {
          supported: false,
          reason: status.error || 'Windows 原生边缘监视器不可用'
        }
      }
      return {
        supported: true,
        reason: null
      }
    } catch (error) {
      return {
        supported: false,
        reason: error?.message || '读取 Windows 原生边缘监视器能力失败'
      }
    }
  }

  function reconcileDockRuntimeConfig(previousConfig, source = 'settings') {
    const nextConfig = getDockRuntimeConfig()
    if (dockRuntimeConfigEqual(previousConfig, nextConfig)) return nextConfig

    cancelPendingDockHide(`dock-config:${source}`)

    logger.info('dock.config', '贴边隐藏配置已更新', {
      source,
      previous: previousConfig,
      next: nextConfig,
      isDockHidden,
      isSliding,
      hasSession: Boolean(dockMotionSession)
    })

    if (isDockTransitionActive()) {
      emergencyRestoreDock(
        'dock-config-changed',
        new Error('贴边隐藏会话期间配置发生变化，已恢复窗口可见')
      )
    }

    if (!getMainWindow() || getMainWindow().isDestroyed() || !getMainWindow().isVisible()) {
      dockSide = null
      return nextConfig
    }

    syncVisibleDockSide({ source: `dock-config:${source}`, snap: true })
    return nextConfig
  }

  function scheduleNativeEdgeCleanup() {
    if (!nativeEdgeCleanupPending || nativeEdgeCleanupTimer || stopping || isQuitting()) return
    const exponent = Math.min(nativeEdgeCleanupPending.attempts, 5)
    const delay = Math.min(
      NATIVE_EDGE_CLEANUP_INITIAL_RETRY_MS * 2 ** exponent,
      NATIVE_EDGE_CLEANUP_MAX_RETRY_MS
    )
    nativeEdgeCleanupTimer = setTimeout(() => {
      nativeEdgeCleanupTimer = null
      attemptNativeEdgeCleanup('retry-timer')
    }, delay)
  }

  function beginNativeEdgeCleanup(generation, backend, source) {
    if (!generation || !backend) return
    if (!nativeEdgeCleanupPending || nativeEdgeCleanupPending.generation !== generation) {
      nativeEdgeCleanupPending = {
        generation,
        backend,
        source,
        attempts: 0,
        startedAt: Date.now()
      }
    } else {
      nativeEdgeCleanupPending.backend = backend
      nativeEdgeCleanupPending.source = source
    }
    scheduleNativeEdgeCleanup()
  }

  function finishNativeEdgeCleanup(source) {
    const pending = nativeEdgeCleanupPending
    if (!pending) return
    if (nativeEdgeCleanupTimer) {
      clearTimeout(nativeEdgeCleanupTimer)
      nativeEdgeCleanupTimer = null
    }
    nativeEdgeCleanupPending = null
    logger.info('dock.native-edge-cleanup', '原生边缘监视器延迟清理完成', {
      source,
      generation: pending.generation,
      attempts: pending.attempts,
      elapsedMs: Date.now() - pending.startedAt
    })
    setImmediate(() => {
      if (
        !stopping &&
        !isQuitting() &&
        getMainWindow() &&
        !getMainWindow().isDestroyed() &&
        getMainWindow().isVisible()
      ) {
        syncVisibleDockSide({ source: 'native-edge-cleanup-complete', snap: true })
      }
    })
  }

  function attemptNativeEdgeCleanup(source = 'unknown') {
    const pending = nativeEdgeCleanupPending
    if (!pending) return true
    pending.attempts += 1
    try {
      if (pending.backend.disarmEdgeMonitor(pending.generation)) {
        finishNativeEdgeCleanup(source)
        return true
      }
      logger.warn('dock.native-edge-cleanup', '原生边缘监视器仍未停止，将继续重试', {
        source,
        generation: pending.generation,
        attempts: pending.attempts
      })
    } catch (error) {
      logger.error('dock.native-edge-cleanup', error, {
        source,
        generation: pending.generation,
        attempts: pending.attempts
      })
    }
    scheduleNativeEdgeCleanup()
    return false
  }

  function beginDockInteractionSuspension(source) {
    dockInteractionSuspendCount += 1
    cancelPendingDockHide(`suspend:${source}`)
    if (isSliding || isDockHidden || dockMotionSession) {
      emergencyRestoreDock(`suspend:${source}`, new Error(`${source} 会话期间暂停贴边隐藏`))
    }
  }

  function endDockInteractionSuspension(source) {
    dockInteractionSuspendCount = Math.max(0, dockInteractionSuspendCount - 1)
    if (dockInteractionSuspendCount !== 0) return
    if (getMainWindow() && !getMainWindow().isDestroyed() && getMainWindow().isVisible()) {
      syncVisibleDockSide({ source: `resume:${source}`, snap: true })
    }
  }

  function cancelPendingDockHide(source = 'unknown') {
    if (!hideTimer) return false
    const elapsedMs = pendingDockHideRequestedAt ? Date.now() - pendingDockHideRequestedAt : null
    clearTimeout(hideTimer)
    hideTimer = null
    pendingDockHideRequestedAt = null
    logger.info('dock.hide-timer', '已取消待执行的贴边隐藏', { source, elapsedMs })
    return true
  }

  function detachNativeEdgeMonitorMessageHook(window = getMainWindow()) {
    if (!edgeMonitorMessageId) return
    if (!window || window.isDestroyed()) {
      edgeMonitorMessageId = null
      return
    }
    try {
      window.unhookWindowMessage(edgeMonitorMessageId)
    } catch (error) {
      logger.warn('dock.native-edge-unhook', '解除原生边缘消息监听失败', {
        messageId: edgeMonitorMessageId,
        error: error?.message || String(error)
      })
    }
    edgeMonitorMessageId = null
  }

  function handleNativeEdgeMonitorMessage(window) {
    if (stopping) return
    if (window !== getMainWindow() || window.isDestroyed() || !windowMotionBackend) return
    let event
    try {
      event = windowMotionBackend.consumeEdgeMonitorEvent()
    } catch (error) {
      emergencyRestoreDock('native-edge-consume-failed', error)
      return
    }
    if (!event) return

    const currentGeneration = dockMotionSession?.generation || 0
    const accepted = isCurrentDockMonitorEvent(event, dockMotionSession)
    if (event.kind !== 'handle-moved') {
      dockNativeStatusObserver.capture('native-event-received', { force: true })
      logger.info('dock.native-edge-event', '收到 Windows 原生边缘监视事件', {
        event,
        accepted,
        currentGeneration,
        isDockHidden,
        isSliding,
        edgeMonitor: getDockDiagnosticSnapshot().edgeMonitor
      })
    }
    if (!accepted) {
      try {
        if (!windowMotionBackend.disarmEdgeMonitor(event.generation)) {
          beginNativeEdgeCleanup(event.generation, windowMotionBackend, 'native-edge-stale-stop')
        }
      } catch (error) {
        logger.error('dock.native-edge-stale-stop', error, { event })
        beginNativeEdgeCleanup(event.generation, windowMotionBackend, 'native-edge-stale-stop')
      }
      return
    }
    if (event.kind === 'handle-moved') {
      const positionPermille = Number(event.positionPermille)
      if (
        dockMotionSession?.revealHandleMode !== DOCK_REVEAL_HANDLE_MODES.PERSISTENT ||
        !Number.isInteger(positionPermille) ||
        positionPermille < 0 ||
        positionPermille > 1000
      ) {
        logger.warn('dock.handle-position', '忽略无效的小黑条拖动位置事件', { event })
        return
      }
      dockMotionSession.handlePositionPermille = positionPermille
      logger.info('dock.handle-position', '常显小黑条已在当前隐藏会话内移动', {
        side: event.side,
        positionPermille,
        persisted: false
      })
      return
    }
    if (event.kind === 'trigger') {
      if (isDockHidden) {
        try {
          doShow('native-edge')
        } catch (error) {
          emergencyRestoreDock('native-edge-show-failed', error)
        }
      }
      return
    }
    emergencyRestoreDock('native-edge-fault', new Error(`原生边缘监视器故障：${event.error}`))
  }

  function applyDockPersistentHandlePosition(session, source) {
    if (
      session?.revealHandleMode !== DOCK_REVEAL_HANDLE_MODES.PERSISTENT ||
      !Number.isInteger(session.handlePositionPermille)
    ) {
      return
    }
    const result = windowMotionBackend.setPersistentHandlePosition(
      session.handlePositionPermille,
      session.generation
    )
    if (result.success) return
    throw new Error(`${result.error || '设置常显小黑条位置失败'}（${source}）`)
  }

  function attachNativeEdgeMonitorMessageHook(window) {
    edgeMonitorMessageId = windowMotionBackend?.getEdgeMonitorMessageId() || null
    if (!edgeMonitorMessageId) return
    window.hookWindowMessage(edgeMonitorMessageId, () => {
      setImmediate(() => handleNativeEdgeMonitorMessage(window))
    })
  }

  function suppressDockGeometryPersistence() {
    suppressDockGeometryPersistenceUntil = Math.max(
      suppressDockGeometryPersistenceUntil,
      Date.now() + DOCK_GEOMETRY_SUPPRESSION_MS
    )
    scheduleDockGeometryReconciliation()
  }

  function isDockGeometryPersistenceSuppressed() {
    return (
      isCompactPresentationActive() ||
      isSliding ||
      isDockHidden ||
      Boolean(dockMotionSession) ||
      Date.now() < suppressDockGeometryPersistenceUntil
    )
  }

  function isDockTransitionActive() {
    return (
      isSliding || isDockHidden || Boolean(dockMotionSession) || Boolean(nativeEdgeCleanupPending)
    )
  }

  function boundsEqual(first, second) {
    return (
      first &&
      second &&
      first.x === second.x &&
      first.y === second.y &&
      first.width === second.width &&
      first.height === second.height
    )
  }

  function scheduleDockGeometryReconciliation() {
    if (stopping) return
    if (dockGeometryReconcileTimer) clearTimeout(dockGeometryReconcileTimer)
    const delay = Math.max(0, suppressDockGeometryPersistenceUntil - Date.now()) + 50
    dockGeometryReconcileTimer = setTimeout(() => {
      dockGeometryReconcileTimer = null
      if (stopping) return
      // 灵动岛拖动复用原生窗口移动后端，也会触发这条贴边补偿链路。
      // 此时真实窗口边界属于灵动岛，绝不能写入主视图 geometry。
      if (isCompactPresentationActive()) return
      if (!getMainWindow() || getMainWindow().isDestroyed() || !getMainWindow().isVisible()) return
      if (isSliding || isDockHidden || dockMotionSession) return
      if (
        Date.now() < suppressDockGeometryPersistenceUntil ||
        Date.now() < geometryPersistence.getSuppressionDeadline()
      ) {
        scheduleDockGeometryReconciliation()
        return
      }

      const bounds = getMainWindow().getBounds()
      if (boundsEqual(bounds, geometryPersistence.getStableBounds())) return
      geometryPersistence.setStableBounds({ ...bounds })
      geometryPersistence.markDirty()
      try {
        persistSettingValues([
          { id: 'geometry.posX', value: bounds.x },
          { id: 'geometry.posY', value: bounds.y },
          { id: 'geometry.width', value: bounds.width },
          { id: 'geometry.height', value: bounds.height }
        ])
        geometryPersistence.markSaved()
      } catch (error) {
        console.warn('[settings] 补偿保存窗口位置失败:', error)
      }
    }, delay)
    dockGeometryReconcileTimer.unref?.()
  }

  function createStableDockBounds(bounds, side, workArea) {
    const width = Math.round(bounds.width)
    const height = Math.round(bounds.height)
    const visibleX =
      side === 'left'
        ? workArea.x
        : side === 'right'
          ? workArea.x + workArea.width - width
          : bounds.x
    const visibleY =
      side === 'top'
        ? workArea.y
        : side === 'bottom'
          ? workArea.y + workArea.height - height
          : bounds.y
    const x = Math.round(visibleX)
    const y = Math.round(visibleY)

    return { x, y, width, height }
  }

  function updateWorkArea() {
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
      const display = screen.getDisplayMatching(getMainWindow().getBounds())
      if (display) cachedWorkArea = display.workArea
    }
  }

  function setDockPosition(position, motionPlan) {
    return measureSyncPerformance('native', 'motion.moveAndContentValidation', () => {
      if (stopping) return null
      if (!getMainWindow() || getMainWindow().isDestroyed() || !windowMotionBackend) return null
      const requestedX = Math.round(position.x)
      const requestedY = Math.round(position.y)
      suppressDockGeometryPersistence()
      const after = windowMotionBackend.moveTo(requestedX, requestedY, motionPlan.expectedSize)
      const contentAfter = getMainWindow().getContentBounds()
      if (
        motionPlan.expectedElectronContentSize &&
        (contentAfter.width !== motionPlan.expectedElectronContentSize.width ||
          contentAfter.height !== motionPlan.expectedElectronContentSize.height)
      ) {
        throw new Error(
          `Electron 内容区破坏尺寸不变量：` +
            `${motionPlan.expectedElectronContentSize.width}x${motionPlan.expectedElectronContentSize.height} -> ` +
            `${contentAfter.width}x${contentAfter.height}`
        )
      }
      return after
    })
  }

  function getDockDiagnosticSnapshot({ edgeMonitorOverride } = {}) {
    const mainWindowExists = Boolean(getMainWindow() && !getMainWindow().isDestroyed())
    const mainWindowMinimized = mainWindowExists ? getMainWindow().isMinimized() : false
    let mainElectronBounds = null
    let mainContentBounds = null
    let mainWindowVisible = false
    let mainWindowFocused = false
    let mainWindowOpacity = null
    let rendererZoomFactor = null
    let mainMotionBounds = null
    let mainAtHiddenTarget = null
    let edgeMonitor = {
      supported: false,
      state: 'unavailable',
      workerAlive: false,
      generation: 0,
      side: null,
      lastPollAgeMs: 0
    }

    if (edgeMonitorOverride !== undefined) {
      edgeMonitor = edgeMonitorOverride || edgeMonitor
    } else {
      try {
        if (windowMotionBackend) edgeMonitor = windowMotionBackend.getEdgeMonitorStatus()
      } catch (error) {
        logger.error('dock.health-snapshot', error, { stage: 'capture-edge-monitor' })
      }
    }

    if (mainWindowExists) {
      try {
        mainElectronBounds = getMainWindow().getBounds()
        mainContentBounds = getMainWindow().getContentBounds()
        mainWindowVisible = getMainWindow().isVisible()
        mainWindowFocused = getMainWindow().isFocused()
        mainWindowOpacity = getMainWindow().getOpacity()
        rendererZoomFactor = getMainWindow().webContents.getZoomFactor()
      } catch (error) {
        logger.error('dock.health-snapshot', error, { stage: 'capture-electron-window' })
      }
    }

    if (!mainWindowMinimized && mainWindowExists && windowMotionBackend) {
      try {
        mainMotionBounds = windowMotionBackend.capture()
      } catch (error) {
        logger.error('dock.health-snapshot', error, { stage: 'capture-main-window' })
      }
    }

    if (isDockHidden && !isSliding && dockMotionSession?.motionPlan && mainMotionBounds) {
      try {
        mainAtHiddenTarget =
          Math.abs(mainMotionBounds.x - dockMotionSession.motionPlan.hiddenX) <= 1 &&
          Math.abs(mainMotionBounds.y - dockMotionSession.motionPlan.hiddenY) <= 1
      } catch (error) {
        logger.error('dock.health-snapshot', error, { stage: 'compare-hidden-target' })
      }
    }

    let matchedDisplay = null
    try {
      const allDisplays = screen.getAllDisplays()
      matchedDisplay =
        allDisplays.find(
          (display) =>
            dockMotionSession?.displayId != null &&
            String(display.id) === String(dockMotionSession.displayId)
        ) || (mainElectronBounds ? screen.getDisplayMatching(mainElectronBounds) : null)
    } catch (error) {
      logger.error('dock.health-snapshot', error, { stage: 'capture-display' })
    }

    const display = matchedDisplay
      ? {
          id: matchedDisplay.id,
          label: matchedDisplay.label || null,
          scaleFactor: matchedDisplay.scaleFactor,
          scalePercent: Number.isFinite(matchedDisplay.scaleFactor)
            ? matchedDisplay.scaleFactor * 100
            : null,
          bounds: matchedDisplay.bounds,
          workArea: matchedDisplay.workArea,
          rotation: matchedDisplay.rotation,
          displayFrequency: matchedDisplay.displayFrequency
        }
      : null
    const session = dockMotionSession
      ? {
          generation: dockMotionSession.generation,
          side: dockMotionSession.side,
          revealHandleMode: dockMotionSession.revealHandleMode,
          handlePositionPermille: dockMotionSession.handlePositionPermille,
          displayId: dockMotionSession.displayId,
          stableBounds: dockMotionSession.stableBounds,
          workArea: dockMotionSession.workArea,
          motionPlan: dockMotionSession.motionPlan
            ? {
                coordinateSpace: dockMotionSession.motionPlan.coordinateSpace,
                initial: dockMotionSession.motionPlan.initial,
                expectedSize: dockMotionSession.motionPlan.expectedSize,
                expectedElectronContentSize:
                  dockMotionSession.motionPlan.expectedElectronContentSize,
                visibleTarget: {
                  x: dockMotionSession.motionPlan.visibleX,
                  y: dockMotionSession.motionPlan.visibleY
                },
                hiddenTarget: {
                  x: dockMotionSession.motionPlan.hiddenX,
                  y: dockMotionSession.motionPlan.hiddenY
                },
                workArea: dockMotionSession.motionPlan.workArea,
                overshoot: dockMotionSession.motionPlan.overshoot
              }
            : null
        }
      : null

    const dockConfig = getDockRuntimeConfig()
    return structuredClone({
      mainWindowExists,
      mainWindowMinimized,
      mainElectronBounds,
      mainContentBounds,
      mainWindowVisible,
      mainWindowFocused,
      mainWindowOpacity,
      rendererZoomFactor,
      coordinateSpaces: {
        electronBounds: 'DIP',
        motionBounds:
          mainMotionBounds?.coordinateSpace || session?.motionPlan?.coordinateSpace || null,
        nativeHandleBounds: edgeMonitor?.supported ? 'physical-pixel' : null
      },
      display,
      viewMode: getViewMode(),
      supportedDockEdges: dockConfig.supportedEdges,
      enabledDockEdges: dockConfig.enabledEdges,
      activeDockEdges: dockConfig.activeEdges,
      revealHandleMode: dockConfig.revealHandleMode,
      isDockHidden,
      dockSide,
      hasDockMotionSession: Boolean(dockMotionSession),
      sessionSide: dockMotionSession?.side || null,
      sessionGeneration: dockMotionSession?.generation || 0,
      sessionRevealHandleMode: dockMotionSession?.revealHandleMode ?? null,
      session,
      mainMotionBounds,
      mainAtHiddenTarget,
      isSliding,
      slideAgeMs: isSliding && dockSlideStartedAt ? Date.now() - dockSlideStartedAt : 0,
      maxSlideAgeMs: MAX_DOCK_SLIDE_AGE_MS,
      maxMonitorPollAgeMs: MAX_EDGE_MONITOR_POLL_AGE_MS,
      blur: {
        configuredEnabled: readBlurState().config.enabled,
        initialized: readBlurState().initialized,
        runtimeFailed: readBlurState().failed,
        diagnostic: { ...readBlurState().diagnostic }
      },
      edgeMonitor
    })
  }

  function getDockNativeObserverContext(status) {
    if (!isDeepDiagnosticMode()) {
      return {
        dock: {
          isDockHidden,
          isSliding,
          dockSide,
          sessionGeneration: dockMotionSession?.generation || 0
        }
      }
    }
    const dock = getDockDiagnosticSnapshot({
      edgeMonitorOverride: status
    })
    delete dock.edgeMonitor
    return { dock }
  }

  function runDockHealthCheck() {
    if (stopping) return
    if (nativeEdgeCleanupPending) {
      attemptNativeEdgeCleanup('dock-health')
      return
    }
    const snapshot = getDockDiagnosticSnapshot()
    const issues = inspectDockHealth(snapshot)
    if (issues.length === 0) return

    const error = new Error(`贴边隐藏状态异常：${issues.join('；')}`)
    logger.error('dock.health', error, { issues, snapshot })
    // dock.health 已包含完整快照；恢复入口不再重复写一条相同 error。
    emergencyRestoreDock('dock-health', error, { skipRecoveryLog: true })
  }

  function resetDockState({ source = 'reset-dock-state', skipNativeDisarm = false } = {}) {
    slideDiagnostics?.finish(source)
    slideDiagnostics = null
    const generation = dockMotionSession?.generation || nativeEdgeCleanupPending?.generation || 0
    const cleanupBackend = nativeEdgeCleanupPending?.backend || windowMotionBackend
    dockNativeStatusObserver.capture(`${source}:before-disarm`, { force: true })
    if (cleanupBackend && !skipNativeDisarm) {
      try {
        if (!cleanupBackend.disarmEdgeMonitor(generation)) {
          logger.warn('dock.native-edge-stop', '停止原生边缘监视器超时', { generation })
          beginNativeEdgeCleanup(generation, cleanupBackend, source)
        } else if (nativeEdgeCleanupPending) {
          finishNativeEdgeCleanup(source)
        }
      } catch (error) {
        logger.error('dock.native-edge-stop', error, { generation })
        beginNativeEdgeCleanup(generation, cleanupBackend, source)
      }
    }
    dockNativeStatusObserver.stop(`${source}:after-disarm`)
    // 非隐藏可见态没有原生会话。此处只清理由启动超时显式登记的资源，绝不把
    // generation=0 的普通 reset 误登记成 cleanup-pending。
    if (slideAnimTimer) {
      clearInterval(slideAnimTimer)
      slideAnimTimer = null
    }
    if (hideTimer) {
      cancelPendingDockHide('reset-dock-state')
    }
    pendingSlideCallback = null
    isSliding = false
    dockSlideStartedAt = null
    dockSide = null
    isDockHidden = false
    dockMotionSession = null
    // 显示动画会临时提升层级；动画被托盘隐藏等操作中断时也必须恢复用户设置。
    const { restoreAlwaysOnTop } = dockTransitionState.reset()
    if (restoreAlwaysOnTop) applyWindowZOrder()
  }

  function restoreDockWindowToVisiblePosition() {
    if (!getMainWindow() || getMainWindow().isDestroyed() || !dockMotionSession) return
    const { stableBounds, motionPlan } = dockMotionSession

    try {
      if (windowMotionBackend && motionPlan) {
        windowMotionBackend.moveTo(
          motionPlan.visibleX,
          motionPlan.visibleY,
          motionPlan.expectedSize
        )
      } else {
        getMainWindow().setPosition(stableBounds.x, stableBounds.y)
      }
    } catch (error) {
      console.warn('[dock] 原生恢复可见位置失败，改用 Electron 位置保底:', error)
      try {
        getMainWindow().setPosition(stableBounds.x, stableBounds.y)
      } catch (fallbackError) {
        console.error('[dock] 恢复可见位置失败:', fallbackError)
      }
    }

    const current = getMainWindow().getBounds()
    geometryPersistence.setStableBounds({
      ...stableBounds,
      x: current.x,
      y: current.y
    })
  }

  function runPendingSlideCallback() {
    const callback = pendingSlideCallback
    pendingSlideCallback = null
    if (!callback) return true

    try {
      callback()
      return true
    } catch (error) {
      emergencyRestoreDock('slide-callback-failed', error)
      return false
    }
  }

  function emergencyRestoreDock(
    source,
    cause = null,
    { skipNativeDisarm = false, skipRecoveryLog = false, recoveryLogLevel = 'error' } = {}
  ) {
    const session = dockMotionSession
    const recoveryCause = cause || new Error('贴边隐藏进入故障开放恢复')
    const recoveryMetadata = { source, session, isDockHidden, isSliding }
    if (!skipRecoveryLog) {
      if (recoveryLogLevel === 'info') {
        logger.info('dock.emergency-restore', recoveryCause.message, recoveryMetadata)
      } else if (recoveryLogLevel === 'warn') {
        logger.warn('dock.emergency-restore', recoveryCause.message, recoveryMetadata)
      } else {
        logger.error('dock.emergency-restore', recoveryCause, recoveryMetadata)
      }
    }

    if (getMainWindow() && !getMainWindow().isDestroyed() && session) {
      try {
        restoreDockWindowToVisiblePosition()
      } catch (error) {
        logger.error('dock.emergency-position', error, { source })
      }
      try {
        if (!getMainWindow().isVisible()) getMainWindow().showInactive()
      } catch (error) {
        logger.error('dock.emergency-show', error, { source })
      }
    }

    resetDockState({ source, skipNativeDisarm })
    try {
      applyWindowZOrder()
      if (readBlurState().initialized) {
        runBlurRuntimeOperation(blurUpdateGeometry, '贴边故障恢复毛玻璃位置')
        runBlurRuntimeOperation(blurReSyncZOrder, '贴边故障恢复毛玻璃层级')
      }
    } catch (error) {
      logger.error('dock.emergency-runtime-sync', error, { source })
    }
  }

  function rebuildFullscreenDockSessionAfterDisplayChange(change) {
    const previousSession = dockMotionSession
    if (
      !getMainWindow() ||
      getMainWindow().isDestroyed() ||
      !windowMotionBackend ||
      !isDockHidden ||
      isSliding ||
      !previousSession
    ) {
      return false
    }

    let monitorStatus
    try {
      monitorStatus = windowMotionBackend.getEdgeMonitorStatus()
    } catch (error) {
      logger.warn('dock.display-rebuild', '读取全屏状态失败，改用安全可见恢复', {
        change,
        error: error?.message
      })
      return false
    }
    if (monitorStatus?.fullscreenActive !== true) return false

    // 原生线程在发布 handle-moved 前已经提交最终位置。这里必须在 disarm 清空
    // 事件队列之前采纳同代次快照，避免显示参数重建抢先时丢失本次会话的拖动。
    const handlePositionPermille = resolveFullscreenRebuildHandlePosition(
      previousSession,
      monitorStatus
    )

    const center = {
      x: previousSession.stableBounds.x + Math.round(previousSession.stableBounds.width / 2),
      y: previousSession.stableBounds.y + Math.round(previousSession.stableBounds.height / 2)
    }
    const display = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay()
    if (
      change?.displayId != null &&
      previousSession.displayId != null &&
      String(change.displayId) !== String(previousSession.displayId)
    ) {
      return false
    }

    dockNativeStatusObserver.capture('fullscreen-display-rebuild:before-disarm', { force: true })
    if (
      !stopEdgeMonitorForFullscreenRebuild({
        backend: windowMotionBackend,
        generation: previousSession.generation,
        beginNativeEdgeCleanup,
        emergencyRestoreDock
      })
    ) {
      return true
    }
    dockNativeStatusObserver.stop('fullscreen-display-rebuild:after-disarm')

    try {
      cachedWorkArea = { ...display.workArea }
      const stableBounds = constrainMainWindowBounds(previousSession.stableBounds, display.workArea)
      const motionPlan = windowMotionBackend.createDockPlan(previousSession.side, HIDE_OVERSHOOT)
      const electronContentBounds = getMainWindow().getContentBounds()
      motionPlan.expectedElectronContentSize = {
        width: electronContentBounds.width,
        height: electronContentBounds.height
      }
      setDockPosition({ x: motionPlan.hiddenX, y: motionPlan.hiddenY }, motionPlan)
      const terminal = windowMotionBackend.capture()
      const rebuiltPlan = {
        ...motionPlan,
        initial: terminal,
        expectedSize: { width: terminal.width, height: terminal.height }
      }
      const generation = ++dockSessionSequence
      dockMotionSession = {
        ...previousSession,
        generation,
        handlePositionPermille,
        stableBounds,
        motionPlan: rebuiltPlan,
        workArea: { ...display.workArea },
        displayId: display.id
      }
      geometryPersistence.setStableBounds({ ...stableBounds })

      const armResult = windowMotionBackend.armEdgeMonitor(previousSession.side, generation, {
        thicknessDip: EDGE_TRIGGER_THICKNESS_DIP,
        pollIntervalMs: EDGE_MONITOR_POLL_INTERVAL_MS,
        revealHandleMode: previousSession.revealHandleMode
      })
      if (!armResult.success) {
        if (armResult.cleanupRequired) {
          beginNativeEdgeCleanup(generation, windowMotionBackend, 'fullscreen-display-rebuild-arm')
        }
        throw new Error(armResult.error || '重新启动边缘监视器失败')
      }
      dockNativeStatusObserver.start(generation, 'fullscreen-display-rebuild:arm-succeeded')
      applyDockPersistentHandlePosition(dockMotionSession, 'fullscreen-display-rebuild')
      if (previousSession.revealHandleMode === DOCK_REVEAL_HANDLE_MODES.PERSISTENT) {
        const revealResult = windowMotionBackend.showPersistentHandle(generation)
        if (!revealResult.success) throw new Error(revealResult.error || '恢复常显小黑条意图失败')
      }
      logger.info('dock.display-rebuild', '全屏显示参数变化后已在屏外重建贴边会话', {
        change,
        previousGeneration: previousSession.generation,
        generation,
        side: previousSession.side,
        displayId: display.id,
        handlePositionPermille,
        snapshot: getDockDiagnosticSnapshot()
      })
      return true
    } catch (error) {
      emergencyRestoreDock('fullscreen-display-rebuild-failed', error)
      return true
    }
  }

  function handleDockDisplayTopologyChange(change = null) {
    if (stopping) return
    if (!getMainWindow() || getMainWindow().isDestroyed()) return
    if (isCompactPresentationActive()) {
      reconcilePresentationDisplayGeometry(change)
      return
    }
    if (
      isDockHidden &&
      dockMotionSession &&
      change?.displayId != null &&
      dockMotionSession.displayId != null &&
      String(change.displayId) !== String(dockMotionSession.displayId)
    ) {
      return
    }
    if (
      change?.eventName === 'display-metrics-changed' &&
      rebuildFullscreenDockSessionAfterDisplayChange(change)
    ) {
      return
    }
    const sourceBounds =
      dockMotionSession?.stableBounds ||
      geometryPersistence.getStableBounds() ||
      getMainWindow().getBounds()
    const center = {
      x: sourceBounds.x + Math.round(sourceBounds.width / 2),
      y: sourceBounds.y + Math.round(sourceBounds.height / 2)
    }
    const display = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay()
    const safeBounds = constrainMainWindowBounds(sourceBounds, display.workArea)
    const currentBounds = getMainWindow().getBounds()
    const update = getWindowBoundsUpdate(currentBounds, safeBounds)

    suppressDockGeometryPersistence()
    resetDockState()
    cachedWorkArea = { ...display.workArea }
    if (update.mode === 'position') {
      getMainWindow().setPosition(update.x, update.y)
    } else if (update.mode === 'bounds') {
      getMainWindow().setBounds(update.bounds)
    }
    if (!boundsEqual(safeBounds, geometryPersistence.getStableBounds())) {
      geometryPersistence.setStableBounds({ ...safeBounds })
      geometryPersistence.markDirty()
      try {
        persistSettingValues([
          { id: 'geometry.posX', value: safeBounds.x },
          { id: 'geometry.posY', value: safeBounds.y },
          { id: 'geometry.width', value: safeBounds.width },
          { id: 'geometry.height', value: safeBounds.height }
        ])
        geometryPersistence.markSaved()
      } catch (error) {
        console.warn('[settings] 保存显示器变化后的窗口位置失败:', error)
      }
    }
    // resetDockState() 会清空 dockSide。窗口约束回可见工作区后，必须根据
    // 新显示器几何重建方向，否则解锁、DPI/分辨率变化后只能靠再次拖动恢复。
    syncVisibleDockSide({ source: 'display-topology-change', snap: true })
    reassertBottomWindowZOrder('display-topology-change')
  }

  function attachDockDisplayListeners() {
    if (stopping) return
    if (dockDisplayListeners.length > 0) return
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      const listener = (_event, display, changedMetrics = []) => {
        pendingDockDisplayChanges.push({
          eventName,
          displayId: display?.id ?? null,
          changedMetrics: Array.isArray(changedMetrics) ? [...changedMetrics] : []
        })
        if (dockDisplayChangeTimer) clearTimeout(dockDisplayChangeTimer)
        dockDisplayChangeTimer = setTimeout(() => {
          dockDisplayChangeTimer = null
          const changes = pendingDockDisplayChanges.splice(0)
          const sessionDisplayId = dockMotionSession?.displayId
          const relevantChanges = changes.filter(
            (change) =>
              sessionDisplayId == null ||
              change.displayId == null ||
              String(change.displayId) === String(sessionDisplayId)
          )
          const candidates = relevantChanges.length ? relevantChanges : changes
          const change =
            [...candidates].reverse().find((item) => item.eventName === 'display-removed') ||
            [...candidates]
              .reverse()
              .find((item) => item.eventName === 'display-metrics-changed') ||
            candidates.at(-1) ||
            null
          logger.info('window.display-topology', '开始处理显示器参数变化', {
            changes,
            selectedChange: change,
            before: getDockDiagnosticSnapshot()
          })
          handleDockDisplayTopologyChange(change)
          setImmediate(() => {
            if (!getMainWindow() || getMainWindow().isDestroyed()) return
            logger.info('window.display-topology', '显示器参数变化处理完成', {
              selectedChange: change,
              after: getDockDiagnosticSnapshot()
            })
          })
        }, 250)
        dockDisplayChangeTimer.unref?.()
      }
      screen.on(eventName, listener)
      dockDisplayListeners.push([eventName, listener])
    }
  }

  function detachDockDisplayListeners() {
    if (dockDisplayChangeTimer) {
      clearTimeout(dockDisplayChangeTimer)
      dockDisplayChangeTimer = null
    }
    pendingDockDisplayChanges.length = 0
    for (const [eventName, listener] of dockDisplayListeners) {
      screen.removeListener(eventName, listener)
    }
    dockDisplayListeners.length = 0
  }

  function handleDockPowerBoundary(source) {
    if (!isDockHidden && !isSliding && !dockMotionSession) return
    emergencyRestoreDock(source, new Error(`系统电源/桌面状态发生变化：${source}`), {
      recoveryLogLevel: 'info'
    })
  }

  function attachDockPowerListeners() {
    if (stopping) return
    if (dockPowerListeners.length > 0) return
    for (const [eventName, listener] of [
      ['suspend', () => handleDockPowerBoundary('system-suspend')],
      ['lock-screen', () => handleDockPowerBoundary('screen-lock')],
      ['resume', () => handleDockDisplayTopologyChange()],
      ['unlock-screen', () => handleDockDisplayTopologyChange()]
    ]) {
      powerMonitor.on(eventName, listener)
      dockPowerListeners.push([eventName, listener])
    }
  }

  function detachDockPowerListeners() {
    for (const [eventName, listener] of dockPowerListeners) {
      powerMonitor.removeListener(eventName, listener)
    }
    dockPowerListeners.length = 0
  }

  function detectDockSide() {
    if (!getMainWindow() || getMainWindow().isDestroyed()) return null
    if (getMainWindow().isMaximized() || getMainWindow().isMinimized()) return null

    updateWorkArea()
    if (!cachedWorkArea) return null

    const b = getMainWindow().getBounds()
    const wa = cachedWorkArea

    return selectNearestDockSide({
      bounds: b,
      workArea: wa,
      activeEdges: getDockRuntimeConfig().activeEdges,
      threshold: SNAP_THRESHOLD,
      isExposed: (side) => Boolean(windowMotionBackend?.isDockEdgeExposed(side))
    })
  }

  function syncVisibleDockSide({ source = 'unknown', snap = false, forceSnap = false } = {}) {
    if (isCompactPresentationActive()) return null
    if (
      !getMainWindow() ||
      getMainWindow().isDestroyed() ||
      !getMainWindow().isVisible() ||
      isDockTransitionActive()
    ) {
      return dockSide
    }

    const previousSide = dockSide
    let nextSide = null
    try {
      nextSide = detectDockSide()
    } catch (error) {
      dockSide = null
      logger.error('dock.side-sync', error, { source, previousSide })
      return null
    }

    dockSide = nextSide
    if (nextSide && snap && (forceSnap || nextSide !== previousSide)) snapToEdge(nextSide)

    if (dockSide !== previousSide) {
      logger.info('dock.side-sync', '可见窗口贴边方向已同步', {
        source,
        previousSide,
        dockSide
      })
    }
    return dockSide
  }

  function snapToEdge(side) {
    updateWorkArea()
    if (!cachedWorkArea || !windowMotionBackend) return
    try {
      const motionPlan = windowMotionBackend.createDockPlan(side, HIDE_OVERSHOOT)
      const alreadySnapped =
        Math.abs(motionPlan.initial.x - motionPlan.visibleX) <= 1 &&
        Math.abs(motionPlan.initial.y - motionPlan.visibleY) <= 1
      if (alreadySnapped) return
      const electronContentBounds = getMainWindow().getContentBounds()
      motionPlan.expectedElectronContentSize = {
        width: electronContentBounds.width,
        height: electronContentBounds.height
      }
      setDockPosition({ x: motionPlan.visibleX, y: motionPlan.visibleY }, motionPlan)
    } catch (error) {
      console.error('[dock] 吸附窗口失败:', error)
      resetDockState()
    }
  }

  function slideTo(target, motionPlan, onFinish) {
    slideDiagnostics?.finish('interrupted')
    slideDiagnostics = null
    // 中断前一个动画时，先执行其回调以恢复状态（如置顶级别）
    if (slideAnimTimer) {
      clearInterval(slideAnimTimer)
      slideAnimTimer = null
    }
    if (pendingSlideCallback) {
      if (!runPendingSlideCallback()) return
    }

    isSliding = true
    dockSlideStartedAt = Date.now()
    pendingSlideCallback = onFinish || null

    // 记录动画起始位置和总帧数
    let from
    try {
      from = windowMotionBackend.capture()
    } catch (error) {
      emergencyRestoreDock('slide-capture-failed', error)
      return
    }
    const totalFrames = Math.ceil(SLIDE_DURATION / SLIDE_INTERVAL)
    let frame = 0
    const observer = createWindowMotionRecorder({
      scope: 'performance.window-dock-animation',
      context: {
        generation: dockMotionSession?.generation || 0,
        coordinateSpace: motionPlan.initial.coordinateSpace,
        side: motionPlan.side || dockSide,
        expectedDurationMs: SLIDE_DURATION,
        requestedIntervalMs: SLIDE_INTERVAL,
        plannedCallbacks: totalFrames
      }
    })
    slideDiagnostics = observer
    let previousObservedAt = observer.stamp()
    const animationObservedAt = previousObservedAt

    slideAnimTimer = setInterval(() => {
      if (!getMainWindow() || getMainWindow().isDestroyed()) {
        clearInterval(slideAnimTimer)
        slideAnimTimer = null
        resetDockState()
        return
      }

      frame++
      const observedAt = observer.stamp()
      let callbackIntervalMs = null
      if (observedAt !== null) {
        if (previousObservedAt !== null) {
          callbackIntervalMs = observedAt - previousObservedAt
          observer.add('callbackInterval', callbackIntervalMs)
          observer.add('callbackLateBy', Math.max(0, callbackIntervalMs - SLIDE_INTERVAL))
        }
        previousObservedAt = observedAt
        observer.count('callbacks')
      }
      const progress = Math.min(frame / totalFrames, 1)
      // easeInOutQuad：前半段加速，后半段减速
      const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2

      try {
        const after = setDockPosition(
          {
            x: from.x + (target.x - from.x) * ease,
            y: from.y + (target.y - from.y) * ease
          },
          motionPlan
        )
        const movedAt = observedAt === null ? null : observer.stamp()
        if (movedAt !== null) {
          const moveMs = movedAt - observedAt
          const requestedX = Math.round(from.x + (target.x - from.x) * ease)
          const requestedY = Math.round(from.y + (target.y - from.y) * ease)
          const errorPx =
            Number.isFinite(after?.x) && Number.isFinite(after?.y)
              ? Math.hypot(after.x - requestedX, after.y - requestedY)
              : null
          observer.add('moveAndValidation', moveMs)
          if (errorPx !== null) {
            if (errorPx > 0) observer.count('actualPositionMismatch')
          } else observer.count('actualPositionUnavailable')
          observer.sample(moveMs + (callbackIntervalMs || 0), {
            callback: frame,
            progress,
            callbackIntervalMs,
            moveMs,
            actualPositionErrorPx: errorPx,
            targetX: requestedX,
            targetY: requestedY
          })
        }
      } catch (error) {
        observer.count('moveFailures')
        emergencyRestoreDock('slide-move-failed', error)
        return
      }

      if (progress >= 1) {
        clearInterval(slideAnimTimer)
        slideAnimTimer = null
        isSliding = false
        dockSlideStartedAt = null
        const completedAt = observer.stamp()
        if (animationObservedAt !== null && completedAt !== null)
          observer.add('animationElapsed', completedAt - animationObservedAt)
        observer.finish('complete')
        slideDiagnostics = null
        flushNativeMotionDiagnostics('dock-animation-end')
        runPendingSlideCallback()
      }
    }, SLIDE_INTERVAL)
  }

  function doHide() {
    if (stopping) return
    if (isCompactPresentationActive()) return
    if (!getMainWindow() || getMainWindow().isDestroyed() || isDockHidden || !dockSide) return
    if (isSliding || nativeEdgeCleanupPending || dockInteractionSuspendCount > 0) return
    const hideRequestedAt = pendingDockHideRequestedAt
    pendingDockHideRequestedAt = null
    const hideStartedAt = Date.now()

    const dockConfig = getDockRuntimeConfig()
    if (!dockConfig.activeEdges.includes(dockSide)) {
      // 延迟隐藏定时器可能晚于设置更新执行；执行时必须以最新配置为准。
      syncVisibleDockSide({ source: 'hide-revalidate', snap: false })
      return
    }

    updateWorkArea()
    if (!cachedWorkArea) return

    let motionPlan
    try {
      motionPlan = windowMotionBackend.createDockPlan(dockSide, HIDE_OVERSHOOT)
      const electronContentBefore = getMainWindow().getContentBounds()
      motionPlan.expectedElectronContentSize = {
        width: electronContentBefore.width,
        height: electronContentBefore.height
      }
      suppressDockGeometryPersistence()
      setDockPosition({ x: motionPlan.visibleX, y: motionPlan.visibleY }, motionPlan)
      const snapped = windowMotionBackend.capture()
      motionPlan = {
        ...motionPlan,
        initial: snapped,
        expectedSize: { width: snapped.width, height: snapped.height },
        visibleX: motionPlan.visibleX,
        visibleY: motionPlan.visibleY
      }
    } catch (error) {
      console.error('[dock] 创建隐藏动画计划失败:', error)
      resetDockState()
      return
    }
    const stableBounds = createStableDockBounds(
      getMainWindow().getBounds(),
      dockSide,
      cachedWorkArea
    )
    const generation = ++dockSessionSequence
    dockMotionSession = {
      generation,
      side: dockSide,
      revealHandleMode: dockConfig.revealHandleMode,
      // 拖动只影响当前隐藏会话；每次重新贴边都从对应窗口边缘的中点开始。
      handlePositionPermille: null,
      stableBounds,
      motionPlan,
      workArea: { ...cachedWorkArea },
      displayId: screen.getDisplayMatching(stableBounds)?.id ?? null
    }
    geometryPersistence.setStableBounds({ ...stableBounds })
    let armResult
    try {
      armResult = windowMotionBackend.armEdgeMonitor(dockSide, generation, {
        thicknessDip: EDGE_TRIGGER_THICKNESS_DIP,
        pollIntervalMs: EDGE_MONITOR_POLL_INTERVAL_MS,
        revealHandleMode: dockMotionSession.revealHandleMode
      })
    } catch (error) {
      logger.error('dock.native-edge-arm', error, { generation, side: dockSide })
      dockMotionSession = null
      return
    }
    if (!armResult.success) {
      logger.error('dock.native-edge-arm', new Error(armResult.error), {
        code: armResult.code,
        generation,
        side: dockSide
      })
      if (armResult.cleanupRequired) {
        beginNativeEdgeCleanup(generation, windowMotionBackend, 'native-edge-start-timeout')
      }
      dockMotionSession = null
      return
    }
    isDockHidden = true
    dockNativeStatusObserver.start(generation, 'arm-succeeded')
    logger.info('dock.lifecycle', '开始贴边隐藏', {
      generation,
      side: dockSide,
      revealHandleMode: dockMotionSession.revealHandleMode,
      stableBounds,
      requestDelayMs: hideRequestedAt ? hideStartedAt - hideRequestedAt : null,
      preparationMs: Date.now() - hideStartedAt,
      snapshot: isDeepDiagnosticMode() ? getDockDiagnosticSnapshot() : undefined
    })

    const target = { x: motionPlan.hiddenX, y: motionPlan.hiddenY }
    const hideAnimationStartedAt = Date.now()

    slideTo(target, motionPlan, () => {
      try {
        const terminal = windowMotionBackend.capture()
        const crossedBoundary =
          dockSide === 'left'
            ? terminal.x + terminal.width <= motionPlan.workArea.left
            : dockSide === 'right'
              ? terminal.x >= motionPlan.workArea.right
              : dockSide === 'top'
                ? terminal.y + terminal.height <= motionPlan.workArea.top
                : terminal.y >= motionPlan.workArea.bottom
        if (!crossedBoundary) {
          throw new Error('隐藏终点未越过工作区边界')
        }
      } catch (error) {
        emergencyRestoreDock('hidden-terminal-invalid', error)
        return
      }
      logger.info('dock.lifecycle', '贴边隐藏动画完成', {
        generation,
        side: dockSide,
        animationMs: Date.now() - hideAnimationStartedAt,
        totalElapsedMs: Date.now() - (hideRequestedAt || hideStartedAt),
        persistentHandlePending:
          dockMotionSession?.revealHandleMode === DOCK_REVEAL_HANDLE_MODES.PERSISTENT,
        snapshot: isDeepDiagnosticMode() ? getDockDiagnosticSnapshot() : undefined
      })
      if (dockTransitionState.consumeQueuedShow()) {
        doShow('queued-during-hide')
        return
      }
      if (
        isDockHidden &&
        dockMotionSession?.generation === generation &&
        dockMotionSession.revealHandleMode === DOCK_REVEAL_HANDLE_MODES.PERSISTENT
      ) {
        let revealResult
        try {
          revealResult = windowMotionBackend.showPersistentHandle(generation)
        } catch (error) {
          emergencyRestoreDock('persistent-handle-show-failed', error)
          return
        }
        if (!revealResult.success) {
          emergencyRestoreDock(
            'persistent-handle-show-failed',
            new Error(revealResult.error || '常显小黑条激活失败')
          )
          return
        }
        logger.info('dock.lifecycle', '常显小黑条已在隐藏终点激活', {
          generation,
          side: dockSide,
          snapshot: isDeepDiagnosticMode() ? getDockDiagnosticSnapshot() : undefined
        })
        dockNativeStatusObserver.capture('persistent-handle-activated', { force: true })
      }
    })
  }

  function doShow(source = 'unknown') {
    if (stopping) return
    const showStartedAt = Date.now()
    if (!getMainWindow() || getMainWindow().isDestroyed()) {
      logger.warn('dock.show', '显示请求被拒绝：主窗口不存在', { source })
      return
    }
    const showAction = dockTransitionState.requestShow({ hidden: isDockHidden, sliding: isSliding })
    logger.info('dock.show', '收到贴边显示请求', {
      source,
      action: showAction,
      isDockHidden,
      isSliding,
      hasDockMotionSession: Boolean(dockMotionSession),
      generation: dockMotionSession?.generation || 0,
      snapshot: isDeepDiagnosticMode() ? getDockDiagnosticSnapshot() : undefined
    })
    if (showAction !== 'start') return

    const session = dockMotionSession
    if (!session) {
      emergencyRestoreDock(
        'show-without-session',
        new Error('显示请求已进入执行状态，但缺少贴边运动会话')
      )
      return
    }

    suppressDockGeometryPersistence()
    isDockHidden = false

    let monitorStopped = false
    const monitorStopStartedAt = Date.now()
    dockNativeStatusObserver.capture('show-before-disarm', { force: true })
    try {
      monitorStopped = windowMotionBackend.disarmEdgeMonitor(session.generation)
    } catch (error) {
      beginNativeEdgeCleanup(session.generation, windowMotionBackend, 'native-edge-stop-failed')
      emergencyRestoreDock('native-edge-stop-failed', error, { skipNativeDisarm: true })
      return
    }
    if (!monitorStopped) {
      beginNativeEdgeCleanup(session.generation, windowMotionBackend, 'native-edge-stop-timeout')
      emergencyRestoreDock('native-edge-stop-timeout', new Error('停止原生边缘监视器超时'), {
        skipNativeDisarm: true
      })
      return
    }
    const monitorStopMs = Date.now() - monitorStopStartedAt
    dockNativeStatusObserver.stop('show-after-disarm')

    const { stableBounds, motionPlan } = session
    const target = { x: motionPlan.visibleX, y: motionPlan.visibleY }

    // 始终置底模式不允许贴边动画临时越过其他应用；其他模式继续保持动画可见性。
    const temporarilyRaiseWindow = getZOrderMode() !== WINDOW_Z_ORDER_MODES.BOTTOM
    if (temporarilyRaiseWindow) {
      dockTransitionState.beginTemporaryAlwaysOnTop()
      getMainWindow().setAlwaysOnTop(true, 'pop-up-menu')
    }
    const showAnimationStartedAt = Date.now()
    slideTo(target, motionPlan, () => {
      let terminal = null
      let terminalMatchesTarget = null
      try {
        suppressDockGeometryPersistence()
        const visibleElectronBounds = getMainWindow().getBounds()
        geometryPersistence.setStableBounds({
          ...stableBounds,
          x: visibleElectronBounds.x,
          y: visibleElectronBounds.y
        })
        dockMotionSession = null
        try {
          terminal = windowMotionBackend.capture()
          const expectedVisible = { x: motionPlan.visibleX, y: motionPlan.visibleY }
          terminalMatchesTarget =
            terminal.x === expectedVisible.x && terminal.y === expectedVisible.y
          if (!terminalMatchesTarget) {
            console.error('[dock] 显示终点未回到冻结位置:', {
              expectedVisible,
              terminal,
              motionPlan
            })
          }
        } catch (error) {
          console.error('[dock] 读取显示终点失败:', error)
        }
      } finally {
        // 动画完成或终点校验失败后都必须恢复用户设置的置顶状态。
        if (temporarilyRaiseWindow) dockTransitionState.finishTemporaryAlwaysOnTop()
        applyWindowZOrder()
        logger.info('dock.lifecycle', '贴边显示动画完成', {
          source,
          side: session.side,
          generation: session.generation,
          monitorStopMs,
          animationMs: Date.now() - showAnimationStartedAt,
          totalElapsedMs: Date.now() - showStartedAt,
          expectedVisible: target,
          terminal,
          terminalMatchesTarget,
          electronBounds:
            getMainWindow() && !getMainWindow().isDestroyed() ? getMainWindow().getBounds() : null,
          contentBounds:
            getMainWindow() && !getMainWindow().isDestroyed()
              ? getMainWindow().getContentBounds()
              : null,
          display: isDeepDiagnosticMode() ? getDockDiagnosticSnapshot().display : undefined,
          blur: {
            configuredEnabled: readBlurState().config.enabled,
            initialized: readBlurState().initialized,
            runtimeFailed: readBlurState().failed,
            diagnostic: { ...readBlurState().diagnostic }
          }
        })
      }
    })
  }

  function handleDockHover(isHovering) {
    if (stopping) return

    if (isCompactPresentationActive()) return
    if (isHovering) {
      // 鼠标进入窗口 —— 取消待执行的隐藏定时器
      cancelPendingDockHide('window-hover-enter')
    } else {
      // 鼠标离开窗口 —— 若已吸附边缘且未锁定，延迟后执行隐藏（锁定时窗口固定，不自动滑走）
      // 这也是最后一道自愈入口：即使某个系统显示/恢复事件没有重建 dockSide，
      // 真实的鼠标离开也会先根据当前几何补齐状态。
      if (!dockSide && !isDockHidden && !isSliding && dockInteractionSuspendCount === 0) {
        syncVisibleDockSide({ source: 'window-hover-leave', snap: true })
      }
      if (
        dockSide &&
        !isDockHidden &&
        !isSliding &&
        !isWindowLocked() &&
        dockInteractionSuspendCount === 0 &&
        !nativeEdgeCleanupPending
      ) {
        if (hideTimer) clearTimeout(hideTimer)
        pendingDockHideRequestedAt = Date.now()
        hideTimer = setTimeout(() => {
          const hideRequestedAt = pendingDockHideRequestedAt
          hideTimer = null
          // 计时期间窗口、显示器或设置都可能变化；执行前重新计算能力交集与
          // 最近边，绝不依赖 200ms 前捕获的 dockSide。
          syncVisibleDockSide({ source: 'hover-hide-timer', snap: true })
          if (
            !dockSide ||
            isDockHidden ||
            isSliding ||
            isWindowLocked() ||
            dockInteractionSuspendCount > 0 ||
            nativeEdgeCleanupPending
          ) {
            pendingDockHideRequestedAt = null
            logger.debug('dock.hide-request', '贴边隐藏请求在延迟结束后被状态变化取消', {
              elapsedMs: hideRequestedAt ? Date.now() - hideRequestedAt : null,
              dockSide,
              isDockHidden,
              isSliding,
              isLocked: isWindowLocked(),
              dockInteractionSuspendCount,
              nativeEdgeCleanupPending: Boolean(nativeEdgeCleanupPending)
            })
            return
          }
          // 透明窗口圆角区域会误触发 mouseleave，此处用光标位置二次确认
          if (getMainWindow() && !getMainWindow().isDestroyed()) {
            const b = getMainWindow().getBounds()
            const cursor = screen.getCursorScreenPoint()
            if (
              cursor.x >= b.x &&
              cursor.x <= b.x + b.width &&
              cursor.y >= b.y &&
              cursor.y <= b.y + b.height
            ) {
              pendingDockHideRequestedAt = null
              logger.debug('dock.hide-request', '忽略透明圆角造成的鼠标离开事件', {
                elapsedMs: hideRequestedAt ? Date.now() - hideRequestedAt : null,
                dockSide
              })
              return // 光标仍在窗口矩形内 → 误触发，不隐藏
            }
          }
          doHide()
        }, HIDE_DELAY)
      }
    }
  }
  function attachWindow(window) {
    if (stopping || !window || window.isDestroyed()) return false
    if (attachedWindow === window) return true
    if (attachedWindow) releaseWindow(attachedWindow)
    attachedWindow = window
    windowMotionBackend = createMotionBackend(window)
    attachNativeEdgeMonitorMessageHook(window)
    return true
  }
  function releaseWindow(window) {
    if (window !== attachedWindow) return false
    resetDockState({ source: 'window-closed' })
    detachNativeEdgeMonitorMessageHook(window)
    attachedWindow = null
    windowMotionBackend = null
    return true
  }
  function prepareShutdown() {
    if (stopping) return
    stopping = true
    resetDockState({ source: 'shutdown' })
    if (dockGeometryReconcileTimer) clearTimeout(dockGeometryReconcileTimer)
    dockGeometryReconcileTimer = null
    if (nativeEdgeCleanupTimer) clearTimeout(nativeEdgeCleanupTimer)
    nativeEdgeCleanupTimer = null
    detachDockDisplayListeners()
    detachDockPowerListeners()
    unsubscribeDiagnosticPolicy()
  }
  function dispose() {
    if (disposed) return
    prepareShutdown()
    disposed = true
    detachNativeEdgeMonitorMessageHook(attachedWindow)
    attachedWindow = null
    windowMotionBackend = null
  }
  return {
    getDockRuntimeConfig,
    getDockRuntimeCapability,
    reconcileDockRuntimeConfig,
    beginDockInteractionSuspension,
    endDockInteractionSuspension,
    cancelPendingDockHide,
    suppressDockGeometryPersistence,
    isDockGeometryPersistenceSuppressed,
    isDockTransitionActive,
    setDockPosition,
    getDockDiagnosticSnapshot,
    runDockHealthCheck,
    resetDockState,
    restoreDockWindowToVisiblePosition,
    emergencyRestoreDock,
    handleDockDisplayTopologyChange,
    attachDockDisplayListeners,
    attachDockPowerListeners,
    syncVisibleDockSide,
    doHide,
    doShow,
    attachWindow,
    releaseWindow,
    prepareShutdown,
    dispose,
    handleHover: handleDockHover,
    captureMotionBounds: () => windowMotionBackend?.capture(),
    isMoving: () => Boolean(windowMotionBackend?.isMoving()),
    readStableSessionBounds: () =>
      dockMotionSession?.stableBounds ? { ...dockMotionSession.stableBounds } : null,
    hasSession: () => Boolean(dockMotionSession),
    setWorkArea: (area) => {
      cachedWorkArea = area ? { ...area } : null
    },
    get side() {
      return dockSide
    },
    get hidden() {
      return isDockHidden
    },
    get sliding() {
      return isSliding
    },
    get suspendCount() {
      return dockInteractionSuspendCount
    },
    get cleanupStatus() {
      return nativeEdgeCleanupPending
        ? {
            generation: nativeEdgeCleanupPending.generation,
            attempts: nativeEdgeCleanupPending.attempts,
            source: nativeEdgeCleanupPending.source
          }
        : null
    },
    resourceSnapshot: () => ({
      stopping,
      disposed,
      attached: Boolean(attachedWindow),
      slideTimer: Boolean(slideAnimTimer),
      hideTimer: Boolean(hideTimer),
      geometryTimer: Boolean(dockGeometryReconcileTimer),
      cleanupTimer: Boolean(nativeEdgeCleanupTimer),
      displayListeners: dockDisplayListeners.length,
      powerListeners: dockPowerListeners.length,
      observer: dockNativeStatusObserver.isActive()
    })
  }
}
