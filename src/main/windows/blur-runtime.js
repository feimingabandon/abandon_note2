import { DEFAULT_SETTINGS } from '../../shared/settings-schema.js'
import { setSettingsBatch } from '../db/db-settings-repository.js'
import { serializeSetting } from '../../shared/settings-schema.js'
import {
  detectCapabilities,
  initialize as blurInit,
  setConfig as blurSetConfig,
  updateGeometry as blurUpdateGeometry,
  syncGeometryAndWait as blurSyncGeometryAndWait,
  destroy as blurDestroy,
  reSyncZOrder as blurReSyncZOrder,
  getRuntimeHealth as getBlurRuntimeHealth
} from '../bridge/blur_bridge.js'

export function createBlurRuntime({
  getMainWindow,
  getActiveVisualWindow,
  getApplicationWindows,
  getSettings,
  isWindowMoving,
  getActiveWindowName,
  refreshResolvedSettings,
  broadcastSettingsChanged,
  logger
}) {
  const blurListeners = new Map()
  function detachWindow(window) {
    for (const [event, callback] of blurListeners.get(window) || [])
      window.removeListener(event, callback)
    blurListeners.delete(window)
  }
  const blurCaps = detectCapabilities()

  let blurInitialized = false

  let blurInitializationError = null

  let blurInitializationNativeError = null

  let blurRuntimeFailed = false

  const blurSyncWindows = new WeakSet()

  let blurRuntimeFailureHandling = false

  let blurDiagnostic = {
    status: blurCaps.supported ? 'pending' : 'unsupported',
    lastCheckedAt: null,
    message: blurCaps.supported
      ? '等待调度器执行首次诊断'
      : blurCaps.reason || '当前平台不支持系统毛玻璃'
  }

  const blurConfig = {
    ...DEFAULT_SETTINGS.blur
  }

  function syncBlurConfigFromResolved() {
    const next = getSettings().blur
    blurConfig.enabled = next.enabled
    blurConfig.radius = next.radius
    blurConfig.saturation = next.saturation
    blurConfig.cornerRadius = next.cornerRadius
    blurConfig.tint = getSettings().css.bgColor
    blurConfig.tintOpacity = getSettings().css.windowOpacity
  }

  function initializeBlurRuntime() {
    if (blurInitialized) return { success: true, strategy: blurCaps.strategy }
    const visualWindow = getActiveVisualWindow()
    if (!blurCaps.supported || !visualWindow || visualWindow.isDestroyed()) {
      const error = blurCaps.reason || '主窗口尚未就绪'
      blurInitializationError = error
      blurInitializationNativeError = null
      return { success: false, error, nativeError: null }
    }

    try {
      const result = blurInit(visualWindow)
      if (!result.success) {
        blurRuntimeFailed = true
        blurInitializationError = result.error
        blurInitializationNativeError = result.nativeError ?? null
        updateBlurDiagnostic(
          { status: 'error', lastCheckedAt: Date.now(), message: result.error },
          { notify: false }
        )
        return result
      }

      blurInitialized = true
      blurRuntimeFailed = false
      blurInitializationError = null
      blurInitializationNativeError = null
      if (process.platform === 'win32') blurSetConfig(blurConfig)
      updateBlurDiagnostic(
        {
          status: blurConfig.enabled ? 'pending' : 'disabled',
          lastCheckedAt: null,
          message: blurConfig.enabled ? '等待调度器执行诊断' : '系统毛玻璃未启用'
        },
        { notify: false }
      )
      attachBlurWindowSyncListeners()
      return result
    } catch (error) {
      logger.error('blur.initialize', error, { stage: 'initialize-or-first-config' })
      // blurInit 成功而首次配置失败时也必须完整回滚，否则 JS、bridge 和
      // native 三层会处于互相矛盾的初始化状态，后续重试还会被短路。
      try {
        blurDestroy()
      } catch (destroyError) {
        console.error('[blur] 初始化回滚时销毁原生资源失败:', destroyError)
      }
      blurInitialized = false
      blurRuntimeFailed = true
      blurInitializationError = error.message
      blurInitializationNativeError = {
        code: null,
        key: 'electron_initialization_exception',
        message: error.message
      }
      updateBlurDiagnostic(
        { status: 'error', lastCheckedAt: Date.now(), message: error.message },
        { notify: false }
      )
      return {
        success: false,
        error: error.message,
        nativeError: blurInitializationNativeError
      }
    }
  }

  function broadcastBlurDiagnosticChanged() {
    if (!getMainWindow() || getMainWindow().isDestroyed()) return
    const contents = getMainWindow().webContents
    if (contents.isDestroyed() || contents.isCrashed() || contents.isLoadingMainFrame()) return
    try {
      contents.send('blur:diagnostic-changed', { ...blurDiagnostic })
    } catch (error) {
      // 页面导航或 renderer 异常退出可能发生在状态检查与 send 之间。
      logger.debug('blur.diagnostic-broadcast-skipped', '渲染帧不可用，已跳过毛玻璃诊断广播', {
        error: error?.message
      })
    }
  }

  function updateBlurDiagnostic(next, { notify = true } = {}) {
    blurDiagnostic = { ...blurDiagnostic, ...next }
    if (notify) broadcastBlurDiagnosticChanged()
  }

  function handleBlurRuntimeFailure(error, { broadcast = true } = {}) {
    if (blurRuntimeFailureHandling) return
    blurRuntimeFailureHandling = true

    try {
      const nativeError = error?.nativeError ?? null
      const detail = nativeError?.message || error?.message || '原生模糊运行期失效'
      logger.error('blur.runtime-failure', error, { detail, nativeError })
      blurInitializationError = `系统毛玻璃运行中断：${detail}`
      blurInitializationNativeError = nativeError
      blurRuntimeFailed = true
      updateBlurDiagnostic(
        {
          status: 'error',
          lastCheckedAt: Date.now(),
          message: blurInitializationError
        },
        { notify: broadcast }
      )

      try {
        blurDestroy()
      } catch (destroyError) {
        console.error('[blur] 运行期失效后销毁原生资源失败:', destroyError)
      }
      blurInitialized = false

      if (blurConfig.enabled) {
        setSettingsBatch(getActiveWindowName(), [serializeSetting('blur.enabled', false)])
        refreshResolvedSettings({ incrementRevision: true })
      } else {
        blurConfig.enabled = false
      }

      console.error('[blur] 已检测到运行期失效并切换到透明背景回退:', detail, nativeError || '')
      if (broadcast) broadcastSettingsChanged()
    } finally {
      blurRuntimeFailureHandling = false
    }
  }

  function runBlurRuntimeDiagnostic(context = {}) {
    const checkedAt = context.now || Date.now()

    if (!blurCaps.supported) {
      updateBlurDiagnostic({
        status: 'unsupported',
        lastCheckedAt: checkedAt,
        message: blurCaps.reason || '当前平台不支持系统毛玻璃'
      })
      return
    }

    if (blurRuntimeFailed) {
      updateBlurDiagnostic({
        status: 'error',
        lastCheckedAt: checkedAt,
        message: blurInitializationError || '系统毛玻璃初始化或运行失败'
      })
      return
    }

    if (!blurConfig.enabled) {
      updateBlurDiagnostic({
        status: 'disabled',
        lastCheckedAt: checkedAt,
        message: '系统毛玻璃未启用'
      })
      return
    }

    if (!blurInitialized) {
      updateBlurDiagnostic({
        status: 'pending',
        lastCheckedAt: checkedAt,
        message: '系统毛玻璃尚未完成初始化'
      })
      return
    }

    if (process.platform === 'win32') {
      try {
        const health = getBlurRuntimeHealth()
        if (!health.healthy) {
          const error = new Error(health.nativeError?.message || '原生模糊运行期失效')
          error.nativeError = health.nativeError
          handleBlurRuntimeFailure(error, { broadcast: false })
          updateBlurDiagnostic({
            status: 'error',
            lastCheckedAt: checkedAt,
            message: blurInitializationError
          })
          broadcastSettingsChanged()
          return
        }
        // Overlay 与 Electron 是两个顶层 HWND。Win10 在焦点切换后可能把第三方
        // 窗口插到两者之间；这不是 Effect Graph 失效，重新排层即可恢复。
        if (getMainWindow()?.isVisible() && !health.zOrderSynchronized) {
          logger.warn('blur.z-order', '检测到毛玻璃层与主窗口不再相邻，正在自动修复')
          blurReSyncZOrder()
          updateBlurDiagnostic({
            status: 'pending',
            lastCheckedAt: checkedAt,
            message: '检测到窗口层级偏差，已请求自动修复'
          })
          return
        }
      } catch (error) {
        handleBlurRuntimeFailure(error, { broadcast: false })
        updateBlurDiagnostic({
          status: 'error',
          lastCheckedAt: checkedAt,
          message: blurInitializationError
        })
        broadcastSettingsChanged()
        return
      }
    }

    updateBlurDiagnostic({
      status: 'healthy',
      lastCheckedAt: checkedAt,
      message: '系统毛玻璃运行正常'
    })
  }

  function runBlurRuntimeOperation(operation, label) {
    if (process.platform !== 'win32' || !blurInitialized) return false
    try {
      operation()
      return true
    } catch (error) {
      const wrapped = new Error(`${label}失败：${error?.message || '原生接口调用异常'}`)
      wrapped.nativeError = error?.nativeError ?? null
      handleBlurRuntimeFailure(wrapped)
      return false
    }
  }

  function attachBlurWindowSyncListeners(window = null) {
    if (process.platform !== 'win32' || !blurInitialized) return
    const windows = window ? [window] : getApplicationWindows()
    for (const candidate of windows) {
      if (!candidate || candidate.isDestroyed() || blurSyncWindows.has(candidate)) continue
      blurSyncWindows.add(candidate)
      const listeners = []
      blurListeners.set(candidate, listeners)
      const register = (event, callback) => {
        listeners.push([event, callback])
        candidate.on(event, callback)
      }
      register('closed', () => detachWindow(candidate))
      register('resize', () => {
        if (candidate !== getActiveVisualWindow()) return
        if (candidate === getMainWindow() && isWindowMoving()) return
        runBlurRuntimeOperation(blurUpdateGeometry, '同步毛玻璃窗口尺寸')
      })
      register('move', () => {
        if (candidate !== getActiveVisualWindow()) return
        if (candidate === getMainWindow() && isWindowMoving()) return
        runBlurRuntimeOperation(blurUpdateGeometry, '同步毛玻璃窗口位置')
      })
      // WinEvent Hook 是主路径；Electron focus 是 Win10 漏报/过早上报重排事件时的
      // 低频兜底。两条路径最终都进入 C++ 去重队列。
      register('focus', () => {
        if (candidate !== getActiveVisualWindow()) return
        runBlurRuntimeOperation(blurReSyncZOrder, '同步毛玻璃窗口焦点层级')
      })
      register('always-on-top-changed', () => {
        if (candidate !== getActiveVisualWindow()) return
        runBlurRuntimeOperation(blurReSyncZOrder, '同步毛玻璃窗口层级')
      })
    }
  }

  function applyResolvedBlurRuntime() {
    if (blurInitialized && process.platform === 'win32') {
      runBlurRuntimeOperation(() => blurSetConfig(blurConfig), '更新毛玻璃配置')
    }
  }

  function restoreBlurForVisibleWindow(window, source) {
    if (
      !window ||
      window.isDestroyed() ||
      !window.isVisible() ||
      window !== getActiveVisualWindow() ||
      !blurConfig.enabled
    ) {
      return
    }
    if (!blurInitialized) {
      const result = initializeBlurRuntime()
      if (!result.success) {
        broadcastSettingsChanged()
        return
      }
    } else if (!runBlurRuntimeOperation(() => blurSetConfig(blurConfig), '恢复毛玻璃配置')) {
      return
    }
    runBlurRuntimeOperation(blurReSyncZOrder, `${source} 重同步毛玻璃窗口层级`)
  }

  function synchronizePresentationBlur(window, source) {
    if (!blurConfig.enabled || process.platform !== 'win32' || !window || window.isDestroyed()) {
      return true
    }

    const synchronize = () => {
      if (!blurInitialized) {
        const initialized = initializeBlurRuntime()
        if (!initialized.success) {
          const error = new Error(initialized.error || '原生毛玻璃重新初始化失败')
          error.nativeError = initialized.nativeError || null
          throw error
        }
      }
      blurSetConfig(blurConfig)
      blurSyncGeometryAndWait(800)
      blurReSyncZOrder()
    }

    try {
      synchronize()
      return true
    } catch (firstError) {
      logger.warn('presentation-mode.blur-rebuild', '最终几何同步失败，正在重建 Overlay', {
        source,
        error: firstError?.message
      })
      try {
        blurDestroy()
      } catch (destroyError) {
        logger.error('presentation-mode.blur-rebuild-destroy', destroyError, { source })
      }
      blurInitialized = false
      try {
        synchronize()
        return true
      } catch (secondError) {
        handleBlurRuntimeFailure(secondError)
        return false
      }
    }
  }
  return {
    syncBlurConfigFromResolved,
    initializeBlurRuntime,
    broadcastBlurDiagnosticChanged,
    updateBlurDiagnostic,
    handleBlurRuntimeFailure,
    runBlurRuntimeDiagnostic,
    runBlurRuntimeOperation,
    attachBlurWindowSyncListeners,
    applyResolvedBlurRuntime,
    restoreBlurForVisibleWindow,
    synchronizePresentationBlur,
    get config() {
      return Object.freeze({ ...blurConfig })
    },
    get caps() {
      return Object.freeze({ ...blurCaps })
    },
    get initialized() {
      return blurInitialized
    },
    get failed() {
      return blurRuntimeFailed
    },
    get error() {
      return blurInitializationError
    },
    get nativeError() {
      return blurInitializationNativeError
    },
    get diagnostic() {
      return Object.freeze({ ...blurDiagnostic })
    },
    setRequestedConfig(config) {
      Object.assign(blurConfig, config)
    },
    disableConfig() {
      blurConfig.enabled = false
    },
    clearFailure() {
      blurRuntimeFailed = false
      blurInitializationError = null
      blurInitializationNativeError = null
    },
    restoreFailure(state) {
      blurRuntimeFailed = state.failed
      blurInitializationError = state.error
      blurInitializationNativeError = state.nativeError
      blurDiagnostic = { ...state.diagnostic }
    },
    destroy() {
      for (const window of blurListeners.keys()) detachWindow(window)
      blurDestroy()
      blurInitialized = false
    }
  }
}
