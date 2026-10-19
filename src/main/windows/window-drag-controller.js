import { WINDOW_Z_ORDER_MODES } from '../../shared/settings-schema.js'
import { diagnosticState } from '../logging/diagnostic-state.js'
import {
  createWindowMotionRecorder,
  flushNativeMotionDiagnostics
} from '../logging/window-motion-diagnostics.js'
import { isDeepDiagnostics } from '../../shared/diagnostic-policy.js'
import { estimateMotionDelivery } from '../../shared/window-motion-metrics.js'

/** Owns the titlebar drag ticket and exactly its Dock suspension until every end/cancel path settles. */
export function createWindowDragController({
  getMainWindow,
  isWindowLocked,
  isCompactPresentationActive,
  getPresentationMode,
  getZOrderMode,
  captureTitlebarZOrderStatus,
  captureMotionBounds,
  movePosition,
  suspendDock,
  resumeDock,
  scheduleGeometry,
  reassertBottomWindowZOrder,
  dipBoundsToPhysical,
  resolvedDragPoint,
  logger,
  motionDiagnosticState = diagnosticState,
  emitMotionDiagnostics,
  monotonic = () => performance.now(),
  epochNow = () => performance.timeOrigin + performance.now()
}) {
  let titlebarDragSession = null

  let titlebarDockSuspended = false
  const quietClock = (clock) => {
    try {
      const value = clock()
      return Number.isFinite(value) ? value : null
    } catch {
      return null
    }
  }
  const quietPolicy = () => {
    try {
      return motionDiagnosticState.get()
    } catch {
      return null
    }
  }

  function normalizeTitlebarDragDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== 'object') return {}
    return {
      dragId:
        typeof diagnostics.dragId === 'string' ? diagnostics.dragId.slice(0, 128) || null : null,
      reason: typeof diagnostics.reason === 'string' ? diagnostics.reason.slice(0, 128) : null,
      renderer:
        diagnostics.renderer && typeof diagnostics.renderer === 'object'
          ? diagnostics.renderer
          : null
    }
  }

  function beginTitlebarWindowDrag(pointerOrigin, diagnostics = {}) {
    const clockRequested =
      diagnostics?.motionClock?.version === 1 &&
      Number.isFinite(diagnostics.motionClock.sentAt) &&
      isDeepDiagnostics(quietPolicy())
    const mainReceivedAt = clockRequested ? quietClock(epochNow) : null
    const dragDiagnostics = normalizeTitlebarDragDiagnostics(diagnostics)
    const rejectionReason = isWindowLocked()
      ? 'locked'
      : isCompactPresentationActive()
        ? 'compact-presentation-active'
        : !getMainWindow() || getMainWindow().isDestroyed()
          ? 'main-window-unavailable'
          : titlebarDragSession
            ? 'drag-session-already-active'
            : null
    if (rejectionReason) {
      logger.info('titlebar.drag-lifecycle', '标题栏拖动开始请求被拒绝', {
        dragId: dragDiagnostics.dragId,
        rejectionReason,
        isLocked: isWindowLocked(),
        zOrderMode: getZOrderMode(),
        presentationMode: getPresentationMode(),
        nativeZOrder: captureTitlebarZOrderStatus()
      })
      return false
    }
    let motionBounds
    try {
      motionBounds = captureMotionBounds()
    } catch (error) {
      logger.error('titlebar.drag-start', error, {
        dragId: dragDiagnostics.dragId,
        pointerOrigin,
        electronBounds: getMainWindow().getBounds(),
        isLocked: isWindowLocked(),
        zOrderMode: getZOrderMode(),
        nativeZOrder: captureTitlebarZOrderStatus()
      })
      return false
    }
    if (!motionBounds) return false
    const electronBounds = getMainWindow().getBounds()
    const electronContentBounds = getMainWindow().getContentBounds()
    suspendDock('titlebar-drag')
    titlebarDockSuspended = true
    titlebarDragSession = {
      window: getMainWindow(),
      dragId: dragDiagnostics.dragId,
      startedAt: Date.now(),
      cursor: resolvedDragPoint(pointerOrigin),
      bounds: electronBounds,
      lastPosition: { x: electronBounds.x, y: electronBounds.y },
      motionPlan: {
        initial: motionBounds,
        expectedSize: { width: motionBounds.width, height: motionBounds.height },
        expectedElectronContentSize: {
          width: electronContentBounds.width,
          height: electronContentBounds.height
        }
      },
      moved: false,
      updateCount: 0,
      failureLogged: false,
      lastTelemetrySequence: 0,
      lastObservedUpdateAt: null,
      motionDiagnostics: createWindowMotionRecorder({
        scope: 'performance.window-drag-main',
        context: {
          dragId: dragDiagnostics.dragId,
          coordinateSpace: motionBounds.coordinateSpace
        },
        state: motionDiagnosticState,
        now: monotonic,
        emit: emitMotionDiagnostics
      })
    }
    logger.info('titlebar.drag-lifecycle', '标题栏拖动事务已开始', {
      dragId: titlebarDragSession.dragId,
      pointerOrigin: titlebarDragSession.cursor,
      electronStartBounds: electronBounds,
      motionStartBounds: motionBounds,
      isLocked: isWindowLocked(),
      zOrderMode: getZOrderMode(),
      nativeZOrder: captureTitlebarZOrderStatus()
    })
    return clockRequested && Number.isFinite(mainReceivedAt)
      ? {
          started: true,
          diagnosticClock: { version: 1, mainReceivedAt, mainSentAt: quietClock(epochNow) }
        }
      : true
  }

  function updateTitlebarWindowDrag(pointerPosition, telemetry) {
    if (
      !titlebarDragSession ||
      titlebarDragSession.window !== getMainWindow() ||
      !getMainWindow() ||
      getMainWindow().isDestroyed()
    )
      return false
    const session = titlebarDragSession
    const observer = session.motionDiagnostics
    const observedAt = observer.stamp()
    let sequence = null
    let delivery = null
    if (observedAt !== null) {
      observer.count('receivedUpdates')
      if (session.lastObservedUpdateAt !== null)
        observer.add('handlerUpdateInterval', observedAt - session.lastObservedUpdateAt)
      session.lastObservedUpdateAt = observedAt
      const policy = quietPolicy()
      if (
        telemetry?.version === 1 &&
        telemetry.dragId === session.dragId &&
        telemetry.captureId === policy?.captureId &&
        Number.isSafeInteger(telemetry.seq) &&
        telemetry.seq > 0
      ) {
        sequence = telemetry.seq
        if (sequence <= session.lastTelemetrySequence) observer.count('nonIncreasingSequence')
        else if (session.lastTelemetrySequence && sequence > session.lastTelemetrySequence + 1)
          observer.count('sequenceGaps', sequence - session.lastTelemetrySequence - 1)
        session.lastTelemetrySequence = sequence
        delivery = estimateMotionDelivery(telemetry, quietClock(epochNow))
        if (delivery.status === 'estimated') {
          observer.add('deliveryLowerBound', delivery.lowerMs)
          observer.add('deliveryUpperBound', delivery.upperMs)
          observer.add('clockUncertainty', delivery.uncertaintyMs)
        } else observer.count(delivery.status)
      } else observer.count('uncorrelatedUpdates')
    }
    const conversionStartedAt = observedAt === null ? null : quietClock(monotonic)
    if (conversionStartedAt !== null)
      observer.add('telemetryHandling', conversionStartedAt - observedAt)
    const cursor = resolvedDragPoint(pointerPosition)
    const position = {
      x: Math.round(session.bounds.x + cursor.x - session.cursor.x),
      y: Math.round(session.bounds.y + cursor.y - session.cursor.y)
    }
    if (position.x === session.lastPosition.x && position.y === session.lastPosition.y) {
      observer.count('duplicatePosition')
      return false
    }

    const motionPosition =
      session.motionPlan.initial.coordinateSpace === 'physical'
        ? dipBoundsToPhysical(getMainWindow(), { ...session.bounds, ...position })
        : position
    const convertedAt = observedAt === null ? null : quietClock(monotonic)
    if (convertedAt !== null && conversionStartedAt !== null)
      observer.add('coordinateConversion', convertedAt - conversionStartedAt)
    try {
      // 与贴边动画共用只移动、不提交宽高的原生链路，并抑制程序化移动期间产生的
      // 异步 resize/move 事件，避免高 DPI 换算后的中间尺寸被写入设置。
      const after = movePosition(motionPosition, session.motionPlan)
      const completedAt = convertedAt === null ? null : quietClock(monotonic)
      if (completedAt !== null) {
        const moveMs = completedAt - convertedAt
        const totalMs = completedAt - observedAt
        observer.add('moveAndValidation', moveMs)
        observer.add('handlerTotal', totalMs)
        const positionError =
          Number.isFinite(after?.x) && Number.isFinite(after?.y)
            ? Math.hypot(after.x - motionPosition.x, after.y - motionPosition.y)
            : null
        if (positionError !== null) {
          if (positionError > 0) observer.count('actualPositionMismatch')
        } else observer.count('actualPositionUnavailable')
        observer.sample(totalMs, {
          seq: sequence,
          receivedAt: observedAt,
          conversionMs: conversionStartedAt === null ? null : convertedAt - conversionStartedAt,
          moveMs,
          deliveryLowerMs: delivery?.lowerMs,
          deliveryUpperMs: delivery?.upperMs,
          positionErrorPx: positionError,
          targetX: motionPosition.x,
          targetY: motionPosition.y
        })
      }
      session.lastPosition = position
      session.moved = true
      session.updateCount += 1
      return true
    } catch (error) {
      if (observedAt !== null) {
        observer.count('moveFailures')
        const failedAt = quietClock(monotonic)
        if (failedAt !== null) observer.add('failedHandlerTotal', failedAt - observedAt)
      }
      if (!session.failureLogged) {
        session.failureLogged = true
        let actualMotionBounds = null
        try {
          actualMotionBounds = captureMotionBounds() || null
        } catch {
          // 原始移动错误优先，诊断快照读取失败不再制造第二条日志。
        }
        logger.error('titlebar.drag-move', error, {
          dragId: session.dragId,
          updateCount: session.updateCount,
          pointerOrigin: session.cursor,
          pointerPosition: cursor,
          electronStartBounds: session.bounds,
          electronTargetPosition: position,
          electronActualBounds: getMainWindow().getBounds(),
          motionStartBounds: session.motionPlan.initial,
          motionActualBounds: actualMotionBounds,
          isLocked: isWindowLocked(),
          zOrderMode: getZOrderMode(),
          nativeZOrder: captureTitlebarZOrderStatus()
        })
      }
      return false
    }
  }

  function endTitlebarWindowDrag(diagnostics = {}) {
    const dragDiagnostics = normalizeTitlebarDragDiagnostics(diagnostics)
    const session = titlebarDragSession
    if (!session && !titlebarDockSuspended) return false
    const nativeZOrderBeforeReassert = captureTitlebarZOrderStatus()
    const electronEndBounds =
      getMainWindow() && !getMainWindow().isDestroyed() ? getMainWindow().getBounds() : null
    titlebarDragSession = null
    if (titlebarDockSuspended) {
      titlebarDockSuspended = false
      resumeDock('titlebar-drag')
    }
    if (session?.moved) scheduleGeometry()
    const bottomReasserted =
      getZOrderMode() === WINDOW_Z_ORDER_MODES.BOTTOM
        ? reassertBottomWindowZOrder('titlebar-drag-end')
        : null
    logger.info('titlebar.drag-lifecycle', '标题栏拖动事务已结束', {
      dragId: session?.dragId || dragDiagnostics.dragId,
      rendererReason: dragDiagnostics.reason,
      durationMs: session?.startedAt ? Date.now() - session.startedAt : null,
      moved: Boolean(session?.moved),
      updateCount: session?.updateCount || 0,
      pointerOrigin: session?.cursor || null,
      electronStartBounds: session?.bounds || null,
      electronEndBounds,
      isLocked: isWindowLocked(),
      zOrderMode: getZOrderMode(),
      bottomReasserted,
      nativeZOrderBeforeReassert,
      nativeZOrderAfterReassert: captureTitlebarZOrderStatus(),
      renderer: dragDiagnostics.renderer
    })
    session?.motionDiagnostics.finish(dragDiagnostics.reason || 'end')
    flushNativeMotionDiagnostics('titlebar-drag-end')
    return true
  }
  return {
    begin: beginTitlebarWindowDrag,
    update: updateTitlebarWindowDrag,
    end: endTitlebarWindowDrag,
    isActive: () => Boolean(titlebarDragSession),
    releaseWindow(window) {
      if (titlebarDragSession?.window !== window) return false
      return endTitlebarWindowDrag({ reason: 'window-closed' })
    },
    snapshot: () => ({
      active: Boolean(titlebarDragSession),
      suspended: titlebarDockSuspended,
      dragId: titlebarDragSession?.dragId || null,
      moved: Boolean(titlebarDragSession?.moved),
      updateCount: titlebarDragSession?.updateCount || 0
    })
  }
}
