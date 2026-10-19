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

  function captureTitlebarZOrderStatus() {
    if (!getMainWindow() || getMainWindow().isDestroyed()) return null
    try {
      return getWindowZOrderStatus(getMainWindow())
    } catch (error) {
      return { error: error?.message || String(error) }
    }
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
      return { success: false, code: null, error: '应用窗口尚未创建' }
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
        if (!result.success) return result
        cancelBottomWindowZOrderRetry()
      } else {
        const result = setWindowAlwaysOnBottom(visualWindow, false)
        if (!result.success) return result
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
        return { success: false, code: null, error: '系统未能应用窗口层级，请重新选择后重试' }
      }
    } catch (error) {
      return {
        success: false,
        code: error?.nativeCode ?? null,
        error: error?.message || String(error)
      }
    }

    runBlurRuntimeOperation(blurReSyncZOrder, '同步毛玻璃窗口层级')
    return { success: true, code: 1, mode: normalized }
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
        result = setWindowAlwaysOnBottom(visualWindow, true)
      }
      if (!result.success) {
        logger.error('window.z-order-reassert', new Error(result.error), {
          source,
          code: result.code
        })
        scheduleBottomWindowZOrderRetry(source, result)
        return false
      }
    } catch (error) {
      logger.error('window.z-order-reassert-exception', error, { source })
      scheduleBottomWindowZOrderRetry(source, error)
      return false
    }
    cancelBottomWindowZOrderRetry()
    runBlurRuntimeOperation(blurReSyncZOrder, '重同步置底窗口毛玻璃层级')
    return true
  }

  async function confirmWindowZOrder(mode, window) {
    // 毛玻璃在独立 STA 线程处理排层消息。先等待实际 HWND 和 Overlay 一致，
    // 必要时受限地重发同步；队列接收成功不能代替可见层级已经生效。
    let lastCheck = null
    const confirmationChecks = []
    const confirmationStartedAt = Date.now()
    for (const delay of [0, 40, 120, 240]) {
      if (delay) await new Promise((resolveWait) => setTimeout(resolveWait, delay))
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
      const result = applyWindowZOrder(mode)
      if (!result.success) throw new Error(result.error)
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

  async function persistWindowZOrderMode(mode) {
    const normalized = normalizeWindowZOrderMode(mode)
    const previousMode = zOrderMode

    let persistenceUpdated = false
    try {
      // 原生排层期间可能同步触发 show 等回调；这些回调必须看到目标模式，
      // 不能在退出置底时重新装回旧的置底拦截器。失败时在下方恢复原模式。
      pendingWindowZOrderMode = normalized
      zOrderMode = normalized
      const runtimeResult = applyWindowZOrder(normalized)
      if (!runtimeResult.success) {
        const error = new Error(runtimeResult.error || '切换窗口层级失败')
        error.code = 'WINDOW_Z_ORDER_APPLY_FAILED'
        error.nativeCode = runtimeResult.code
        throw error
      }
      await confirmWindowZOrder(normalized, getActiveVisualWindow())
      // 保存模式相同也必须重应用真实窗口状态，允许用户修复系统重排后的层级漂移。
      if (normalized === previousMode) {
        return { mode: previousMode, changed: false, throttled: false }
      }
      writeApplicationSetting('window.zOrderMode', normalized)
      persistenceUpdated = true
      refreshResolvedSettings({ incrementRevision: true })
      zOrderMode = getSettings().window.zOrderMode
      const snapshot = getResolvedSettingsSnapshot()
      broadcastSettingsChanged(snapshot)
      return { mode: zOrderMode, changed: true, throttled: false }
    } catch (error) {
      pendingWindowZOrderMode = previousMode
      zOrderMode = previousMode
      const rollbackResult = applyWindowZOrder(previousMode)
      if (!rollbackResult.success) {
        logger.error('window.z-order-rollback', new Error(rollbackResult.error), {
          requestedMode: normalized,
          previousMode,
          code: rollbackResult.code
        })
      }
      if (persistenceUpdated) {
        try {
          writeApplicationSetting('window.zOrderMode', previousMode)
          refreshResolvedSettings({ incrementRevision: true })
          zOrderMode = getSettings().window.zOrderMode
          broadcastSettingsChanged(getResolvedSettingsSnapshot())
        } catch (persistenceRollbackError) {
          logger.error('window.z-order-persistence-rollback', persistenceRollbackError, {
            requestedMode: normalized,
            previousMode
          })
        }
      }
      throw error
    } finally {
      pendingWindowZOrderMode = null
    }
  }
  async function setWindowZOrderMode(requestedMode) {
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
      const result = await persistWindowZOrderMode(requested)
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
      if (result.changed) {
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
      logger.error('window.z-order-change', error, { requestedMode: requested })
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
        retryAttempt: bottomZOrderRetryAttempt
      }
    }
  }
}
