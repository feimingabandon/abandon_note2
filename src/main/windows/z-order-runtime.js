import {
  DEFAULT_SETTINGS,
  WINDOW_Z_ORDER_MODES,
  normalizeWindowZOrderMode
} from '../../shared/settings-schema.js'
import {
  getWindowZOrderStatus,
  reassertWindowZOrder,
  setWindowAlwaysOnBottom,
  reSyncZOrder as blurReSyncZOrder,
  getRuntimeHealth as getBlurRuntimeHealth
} from '../bridge/blur_bridge.js'
import { writeApplicationSetting } from '../settings/application-settings.js'
import { captureWindowLayerDiagnostic } from '../bridge/window-layer-diagnostics.js'
import { randomUUID } from 'node:crypto'
import { checkpoint } from '../logging/operation-context.js'

export function createZOrderRuntime({
  getMainWindow,
  getActiveVisualWindow,
  getApplicationWindows,
  getSettings,
  readBlurState,
  readDockState,
  isWindowLocked,
  runBlurRuntimeOperation,
  refreshResolvedSettings,
  getResolvedSettingsSnapshot,
  broadcastSettingsChanged,
  completeCommittedSettings,
  sendAppMessage,
  logger
}) {
  const WINDOW_CONTROL_GUARD_MS = 500
  let zOrderMode = DEFAULT_SETTINGS.window.zOrderMode

  const WINDOW_Z_ORDER_NOT_ENABLED_CODE = -6

  const BOTTOM_Z_ORDER_RETRY_DELAYS_MS = Object.freeze([160, 480, 1200])

  let lastZOrderChangeAt = 0

  let zOrderChangeInFlight = false

  let pendingWindowZOrderMode = null

  let bottomZOrderRetryTimer = null

  let bottomZOrderRetryAttempt = 0

  let bottomZOrderRetryExhaustedNotified = false
  let firstNativeFailureRecorded = false
  let lastBlurSynchronization = null

  function synchronizeBlurOrder(label) {
    const blur = readBlurState()
    if (!blur.initialized) {
      // No native request or observation occurred. Preserve the last unresolved
      // attempt rather than replacing it with a successful no-op.
      return {
        ...(lastBlurSynchronization || {
          status: 'deferred',
          error: '系统毛玻璃尚未初始化，未请求层级同步',
          retryable: Boolean(blur.config.enabled)
        })
      }
    }
    const requested = runBlurRuntimeOperation(blurReSyncZOrder, label)
    lastBlurSynchronization = requested
      ? {
          // The bridge queues a void request; it does not acknowledge actual
          // HWND/Overlay convergence. Only a separate health check can prove it.
          status: 'unconfirmed',
          error: lastBlurSynchronization?.error ?? null,
          retryable: true
        }
      : {
          status: 'failed',
          error: readBlurState().error || '毛玻璃窗口层级同步失败',
          retryable: Boolean(readBlurState().config.enabled)
        }
    return { ...lastBlurSynchronization }
  }

  function captureTitlebarZOrderStatus() {
    try {
      if (!getMainWindow() || getMainWindow().isDestroyed()) return null
      return getWindowZOrderStatus(getMainWindow())
    } catch (error) {
      return { error: error?.message || String(error) }
    }
  }

  function observeFailure(stage, mode, result, window = getActiveVisualWindow()) {
    const diagnosticId = randomUUID()
    // Failure-only, bounded records bypass stack-based error aggregation. checkpoint also
    // carries the IPC actionId; startup failures have their own diagnosticId instead.
    try {
      const { isSliding, isDockHidden } = readDockState()
      // An earlier hook/message failure may precede the direct call's latest failure.
      // Write it separately so it survives both rollback and the per-record size budget.
      if (result.nativeFirstFailure && !firstNativeFailureRecorded) {
        if (result.nativeFirstFailure.sequence !== result.nativeFailure?.sequence) {
          checkpoint(
            'window.z-order.first-native-failure',
            { diagnosticId, nativeFailure: result.nativeFirstFailure },
            {
              scope: 'window.z-order-first-native-failure',
              kind: 'event',
              level: 'warn',
              stage,
              outcome: 'failure'
            }
          )
        }
        firstNativeFailureRecorded = true
      }
      checkpoint(
        'window.z-order.failure',
        {
          diagnosticId,
          mode,
          nativeCode: result.code ?? result.nativeCode ?? null,
          nativeFailureCount: result.nativeFailureCount ?? null,
          nativeFailure: result.nativeFailure ?? null,
          nativeFailureCaptureError: result.nativeFailureCaptureError ?? null,
          nativeZOrder: captureTitlebarZOrderStatus(),
          isSliding,
          isDockHidden
        },
        { scope: 'window.z-order-failure', kind: 'event', level: 'warn', stage, outcome: 'failure' }
      )
      checkpoint(
        'window.z-order.layers',
        { diagnosticId, mode, windowLayers: captureWindowLayerDiagnostic(window) },
        { scope: 'window.z-order-layers', kind: 'event', level: 'warn', stage, outcome: 'failure' }
      )
    } catch {
      // Observation cannot change the original failure or prevent its rollback.
    }
    return {
      ...result,
      diagnosticId,
      blurSynchronization: lastBlurSynchronization
        ? { ...lastBlurSynchronization }
        : { status: 'deferred', error: '窗口层级未应用，未请求毛玻璃同步', retryable: true }
    }
  }

  function observeRollback(stage, metadata) {
    try {
      checkpoint(
        'window.z-order.rollback',
        { ...metadata, nativeZOrder: captureTitlebarZOrderStatus() },
        { scope: 'window.z-order-rollback-state', kind: 'event', level: 'warn', stage }
      )
    } catch {
      // Failed diagnostics cannot prevent restoring the previous layer.
    }
  }

  function applicationError(result, fallback = '切换窗口层级失败') {
    const error = new Error(result.error || fallback)
    error.code = 'WINDOW_Z_ORDER_APPLY_FAILED'
    error.nativeCode = result.code
    error.diagnosticId = result.diagnosticId
    if (result.nativeFailure) {
      const { sequence, operation, stage, resultCode, win32Error, win32ErrorSource } =
        result.nativeFailure
      error.nativeFailure = { sequence, operation, stage, resultCode, win32Error, win32ErrorSource }
    }
    return error
  }

  function cancelBottomWindowZOrderRetry() {
    if (bottomZOrderRetryTimer) clearTimeout(bottomZOrderRetryTimer)
    bottomZOrderRetryTimer = null
    bottomZOrderRetryAttempt = 0
    bottomZOrderRetryExhaustedNotified = false
  }

  function scheduleBottomWindowZOrderRetry(source, failure = null) {
    const visualWindow = getActiveVisualWindow()
    if (zOrderMode !== WINDOW_Z_ORDER_MODES.BOTTOM || !visualWindow || visualWindow.isDestroyed()) {
      cancelBottomWindowZOrderRetry()
      return false
    }
    if (bottomZOrderRetryTimer) return true

    if (bottomZOrderRetryAttempt >= BOTTOM_Z_ORDER_RETRY_DELAYS_MS.length) {
      if (!bottomZOrderRetryExhaustedNotified) {
        bottomZOrderRetryExhaustedNotified = true
        const message = failure?.error || failure?.message || 'Windows 桌面层暂时不可用'
        logger.error('window.z-order-retry-exhausted', new Error(message), {
          source,
          attempts: bottomZOrderRetryAttempt,
          code: failure?.code ?? null
        })
        sendAppMessage('error', '始终置底暂时无法恢复，请稍后重新切换窗口层级')
      }
      return false
    }

    const targetWindow = visualWindow
    const delay = BOTTOM_Z_ORDER_RETRY_DELAYS_MS[bottomZOrderRetryAttempt]
    bottomZOrderRetryAttempt += 1
    logger.warn('window.z-order-retry', '始终置底将在 Windows 桌面层就绪后重试', {
      source,
      attempt: bottomZOrderRetryAttempt,
      delay,
      code: failure?.code ?? null
    })
    bottomZOrderRetryTimer = setTimeout(() => {
      bottomZOrderRetryTimer = null
      if (
        zOrderMode !== WINDOW_Z_ORDER_MODES.BOTTOM ||
        getActiveVisualWindow() !== targetWindow ||
        targetWindow.isDestroyed()
      ) {
        cancelBottomWindowZOrderRetry()
        return
      }
      reassertBottomWindowZOrder(`retry:${source}`)
    }, delay)
    bottomZOrderRetryTimer.unref?.()
    return true
  }

  function applyWindowZOrder(mode = zOrderMode) {
    const visualWindow = getActiveVisualWindow()
    if (!visualWindow || visualWindow.isDestroyed()) {
      return observeFailure(
        'window-unavailable',
        mode,
        {
          success: false,
          code: null,
          error: '应用窗口尚未创建'
        },
        visualWindow
      )
    }
    const normalized = normalizeWindowZOrderMode(mode)
    if (normalized !== WINDOW_Z_ORDER_MODES.BOTTOM) cancelBottomWindowZOrderRetry()

    try {
      // 置底拦截器必须只绑定当前可视 HWND；两个稳定窗口不能同时占据桌面层。
      for (const window of getApplicationWindows()) {
        if (window === visualWindow) continue
        window.setAlwaysOnTop(false)
      }
      if (normalized === WINDOW_Z_ORDER_MODES.BOTTOM) {
        visualWindow.setAlwaysOnTop(false)
        const result = setWindowAlwaysOnBottom(visualWindow, true)
        if (!result.success)
          return observeFailure('enable-bottom', normalized, result, visualWindow)
        cancelBottomWindowZOrderRetry()
      } else {
        const result = setWindowAlwaysOnBottom(visualWindow, false)
        if (!result.success)
          return observeFailure('disable-bottom', normalized, result, visualWindow)
        visualWindow.setAlwaysOnTop(normalized === WINDOW_Z_ORDER_MODES.TOP, 'pop-up-menu')
      }

      // Electron 的置顶事件不保证 HWND 已进入对应层级。原生置底解除或系统重排后，
      // 若实际状态没有跟上，先清除置顶再重试一次；禁止把未生效的请求保存为成功。
      const expectedTopmost = normalized === WINDOW_Z_ORDER_MODES.TOP
      if (
        normalized !== WINDOW_Z_ORDER_MODES.BOTTOM &&
        visualWindow.isAlwaysOnTop() !== expectedTopmost
      ) {
        visualWindow.setAlwaysOnTop(false, 'pop-up-menu')
        if (expectedTopmost) visualWindow.setAlwaysOnTop(true, 'pop-up-menu')
      }
      if (visualWindow.isAlwaysOnTop() !== expectedTopmost) {
        return observeFailure(
          'topmost-mismatch',
          normalized,
          {
            success: false,
            code: null,
            error: '系统未能应用窗口层级，请重新选择后重试'
          },
          visualWindow
        )
      }
    } catch (error) {
      return observeFailure(
        'apply-exception',
        normalized,
        {
          success: false,
          code: error?.nativeCode ?? null,
          error: error?.message || String(error),
          nativeFailure: error?.nativeFailure ?? null
        },
        visualWindow
      )
    }

    const blurSynchronization = synchronizeBlurOrder('同步毛玻璃窗口层级')
    return { success: true, code: 1, mode: normalized, blurSynchronization }
  }

  function reassertBottomWindowZOrder(source) {
    const visualWindow = getActiveVisualWindow()
    if (zOrderMode !== WINDOW_Z_ORDER_MODES.BOTTOM || !visualWindow || visualWindow.isDestroyed()) {
      return true
    }
    try {
      let result = reassertWindowZOrder(visualWindow)
      // 启动或视图切换若正好撞上 Explorer 重建，首次安装可能尚未完成。
      // 桌面宿主恢复后重新执行 SetBottom，而不只是反复 Reassert 一个空控制器。
      if (
        !result.success &&
        (result.code === WINDOW_Z_ORDER_NOT_ENABLED_CODE || result.code == null)
      ) {
        observeFailure('reassert-before-reinstall', zOrderMode, result, visualWindow)
        result = setWindowAlwaysOnBottom(visualWindow, true)
      }
      if (!result.success) {
        result = observeFailure('reassert', zOrderMode, result, visualWindow)
        logger.error('window.z-order-reassert', new Error(result.error), {
          source,
          code: result.code,
          diagnosticId: result.diagnosticId
        })
        scheduleBottomWindowZOrderRetry(source, result)
        return false
      }
    } catch (error) {
      observeFailure('reassert-exception', zOrderMode, error, visualWindow)
      logger.error('window.z-order-reassert-exception', error, { source })
      scheduleBottomWindowZOrderRetry(source, error)
      return false
    }
    cancelBottomWindowZOrderRetry()
    synchronizeBlurOrder('重同步置底窗口毛玻璃层级')
    return true
  }

  function assertCurrentOperation(operation) {
    if (operation.isCurrent && !operation.isCurrent())
      throw Object.assign(new Error('设置请求所属页面已失效，请在当前页面重试'), {
        code: 'SETTINGS_SOURCE_EXPIRED'
      })
  }

  async function confirmWindowZOrder(mode, window, operation = {}) {
    // 毛玻璃在独立 STA 线程处理排层消息。先等待实际 HWND 和 Overlay 一致，
    // 必要时受限地重发同步；队列接收成功不能代替可见层级已经生效。
    let lastCheck = null
    const confirmationChecks = []
    const confirmationStartedAt = Date.now()
    for (const delay of [0, 40, 120, 240]) {
      if (delay) await new Promise((resolveWait) => setTimeout(resolveWait, delay))
      assertCurrentOperation(operation)
      if (window.isDestroyed() || window !== getActiveVisualWindow()) {
        throw new Error('窗口已切换，请在当前窗口重新选择层级')
      }
      const topmostMatches = window.isAlwaysOnTop() === (mode === WINDOW_Z_ORDER_MODES.TOP)
      const nativeZOrder = process.platform === 'win32' ? getWindowZOrderStatus(window) : null
      const bottomMatches =
        mode === WINDOW_Z_ORDER_MODES.BOTTOM
          ? Boolean(nativeZOrder?.enabled && nativeZOrder.requestedMatches && nativeZOrder.anchored)
          : !nativeZOrder?.enabled
      const blurHealth =
        process.platform === 'win32' &&
        readBlurState().initialized &&
        readBlurState().config.enabled
          ? getBlurRuntimeHealth()
          : null
      lastCheck = { mode, topmostMatches, bottomMatches, nativeZOrder, blurHealth }
      confirmationChecks.push({
        checkedAt: new Date().toISOString(),
        delayMs: delay,
        elapsedMs: Date.now() - confirmationStartedAt,
        topmostMatches,
        bottomMatches,
        blurHealthy: blurHealth?.healthy ?? null,
        blurZOrderSynchronized: blurHealth?.zOrderSynchronized ?? null
      })
      if (
        topmostMatches &&
        bottomMatches &&
        (!blurHealth || (blurHealth.healthy && blurHealth.zOrderSynchronized))
      ) {
        return
      }
      if (delay === 240) break
      assertCurrentOperation(operation)
      const result = applyWindowZOrder(mode)
      if (!result.success) throw applicationError(result)
    }
    logger.warn('window.z-order-confirm', '窗口层级核验未收敛', {
      ...lastCheck,
      confirmationChecks,
      isSliding: readDockState().isSliding,
      isDockHidden: readDockState().isDockHidden
    })
    // Separate bounded records keep the HWND evidence inside the existing logger budget.
    logger.warn('window.z-order-layers', '窗口层级核验失败时的只读窗口观察', {
      mode,
      lastCheckedAt: confirmationChecks.at(-1).checkedAt,
      windowLayers: captureWindowLayerDiagnostic(window)
    })
    throw new Error('窗口层级未能同步，请重新选择后重试')
  }

  async function persistWindowZOrderMode(mode, operation = {}) {
    const normalized = normalizeWindowZOrderMode(mode)
    const previousMode = zOrderMode

    try {
      assertCurrentOperation(operation)
      // 原生排层期间可能同步触发 show 等回调；这些回调必须看到目标模式，
      // 不能在退出置底时重新装回旧的置底拦截器。失败时在下方恢复原模式。
      pendingWindowZOrderMode = normalized
      zOrderMode = normalized
      const runtimeResult = applyWindowZOrder(normalized)
      if (!runtimeResult.success) {
        throw applicationError(runtimeResult)
      }
      await confirmWindowZOrder(normalized, getActiveVisualWindow(), operation)
      assertCurrentOperation(operation)
      // 保存模式相同也必须重应用真实窗口状态，允许用户修复系统重排后的层级漂移。
      if (normalized === previousMode) {
        pendingWindowZOrderMode = null
        return { mode: previousMode, changed: false, throttled: false }
      }
      writeApplicationSetting('window.zOrderMode', normalized)
    } catch (error) {
      if (operation.isCurrent && !operation.isCurrent()) {
        pendingWindowZOrderMode = null
        zOrderMode = getSettings().window.zOrderMode
        throw error
      }
      // Record the failed state before rollback can move the windows or replace native lastFailure.
      const failureDiagnosticId = error.diagnosticId ?? randomUUID()
      observeRollback('before-rollback', {
        diagnosticId: failureDiagnosticId,
        requestedMode: normalized,
        previousMode
      })
      pendingWindowZOrderMode = previousMode
      zOrderMode = previousMode
      const rollbackResult = applyWindowZOrder(previousMode)
      observeRollback('after-rollback', {
        diagnosticId: failureDiagnosticId,
        rollbackDiagnosticId: rollbackResult.diagnosticId ?? null,
        requestedMode: normalized,
        previousMode,
        success: rollbackResult.success,
        code: rollbackResult.code ?? null
      })
      if (!rollbackResult.success) {
        logger.error('window.z-order-rollback', new Error(rollbackResult.error), {
          requestedMode: normalized,
          previousMode,
          code: rollbackResult.code
        })
      }
      pendingWindowZOrderMode = null
      throw error
    }
    // SQL has committed. Reading, application and delivery cannot roll this write
    // back or re-enter the pre-commit native compensation above.
    try {
      let receipt
      if (completeCommittedSettings) {
        receipt = await completeCommittedSettings({
          ids: ['window.zOrderMode'],
          context: operation.context
        })
      } else {
        refreshResolvedSettings({ incrementRevision: true })
        zOrderMode = getSettings().window.zOrderMode
        receipt = getResolvedSettingsSnapshot()
        broadcastSettingsChanged(receipt)
      }
      return { mode: normalized, changed: true, throttled: false, snapshot: receipt }
    } finally {
      pendingWindowZOrderMode = null
    }
  }
  async function setWindowZOrderMode(requestedMode, operation = {}) {
    const requested = normalizeWindowZOrderMode(requestedMode, null)
    if (!requested) throw new Error('无效的窗口层级')

    const now = Date.now()
    const before = {
      isLocked: isWindowLocked(),
      zOrderMode,
      alwaysOnTop:
        getMainWindow() && !getMainWindow().isDestroyed() ? getMainWindow().isAlwaysOnTop() : null,
      nativeZOrder: captureTitlebarZOrderStatus()
    }
    if (zOrderChangeInFlight || now - lastZOrderChangeAt < WINDOW_CONTROL_GUARD_MS) {
      logger.info('window.control-change', '窗口层级切换请求被节流', {
        control: 'z-order',
        requested,
        before,
        zOrderChangeInFlight,
        elapsedSinceLastChangeMs: now - lastZOrderChangeAt
      })
      return { mode: zOrderMode, changed: false, throttled: true }
    }
    zOrderChangeInFlight = true
    try {
      const result = await persistWindowZOrderMode(requested, operation)
      logger.info('window.control-change', '窗口层级状态已核验', {
        control: 'z-order',
        requested,
        result,
        before,
        after: {
          isLocked: isWindowLocked(),
          zOrderMode,
          alwaysOnTop:
            getMainWindow() && !getMainWindow().isDestroyed()
              ? getMainWindow().isAlwaysOnTop()
              : null,
          nativeZOrder: captureTitlebarZOrderStatus()
        }
      })
      if (
        result.changed &&
        (!operation.isCurrent || operation.isCurrent()) &&
        (!completeCommittedSettings ||
          result.snapshot?.application?.domains?.window?.status === 'applied')
      ) {
        const message =
          result.mode === WINDOW_Z_ORDER_MODES.TOP
            ? '主窗口已切换为始终置顶'
            : result.mode === WINDOW_Z_ORDER_MODES.BOTTOM
              ? '主窗口已切换为始终置底'
              : '主窗口已切换为正常层级'
        sendAppMessage('success', message)
      }
      return result
    } catch (error) {
      logger.error('window.z-order-change', error, {
        requestedMode: requested,
        diagnosticId: error.diagnosticId ?? null,
        before,
        after: { zOrderMode, nativeZOrder: captureTitlebarZOrderStatus() }
      })
      if (!operation.isCurrent || operation.isCurrent())
        sendAppMessage('error', `切换窗口层级失败：${error.message}`)
      throw error
    } finally {
      lastZOrderChangeAt = Date.now()
      zOrderChangeInFlight = false
    }
  }
  return {
    captureTitlebarZOrderStatus,
    cancelBottomWindowZOrderRetry,
    scheduleBottomWindowZOrderRetry,
    applyWindowZOrder,
    reassertBottomWindowZOrder,
    confirmWindowZOrder,
    persistWindowZOrderMode,
    setWindowZOrderMode,
    get mode() {
      return zOrderMode
    },
    syncResolved() {
      zOrderMode = pendingWindowZOrderMode ?? getSettings().window.zOrderMode
    },
    snapshot() {
      return {
        mode: zOrderMode,
        pendingMode: pendingWindowZOrderMode,
        changing: zOrderChangeInFlight,
        retryPending: Boolean(bottomZOrderRetryTimer),
        retryAttempt: bottomZOrderRetryAttempt,
        blurSynchronization: lastBlurSynchronization ? { ...lastBlurSynchronization } : null
      }
    }
  }
}
