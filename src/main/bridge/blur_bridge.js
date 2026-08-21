/**
 * blur_bridge.js — Node.js 到 C++ DLL 的 koffi FFI 桥接层
 */

import { join } from 'path'
import { app } from 'electron'

let koffi = null
let lib = null
let initialized = false

function getWindowHandleValue(window) {
  const hwndBuffer = window.getNativeWindowHandle()
  return hwndBuffer.length >= 8 ? Number(hwndBuffer.readBigUInt64LE()) : hwndBuffer.readUInt32LE()
}

const NATIVE_ERROR_MESSAGES = {
  1: '当前 Windows 版本不支持原生模糊',
  2: 'Electron 父窗口句柄无效',
  3: '原生模糊线程 COM 初始化失败',
  4: 'DispatcherQueue 创建失败',
  5: '原生模糊 Overlay 窗口创建失败',
  6: 'Windows Composition Target 创建失败',
  7: '系统不支持当前模糊 Effect Graph',
  8: '原生模糊初始化超时',
  9: '原生模糊发生未知错误'
}

const EDGE_MONITOR_RESULT_MESSAGES = Object.freeze({
  1: '原生边缘监视器已启动',
  [-1]: '主窗口句柄无效',
  [-2]: '贴边方向无效',
  [-3]: '目标边缘不是可触达的真实屏幕外边缘',
  [-4]: '无法生成有效的边缘触发区域',
  [-5]: '当前输入桌面无法读取鼠标位置',
  [-6]: '创建原生边缘监视停止事件失败',
  [-7]: '创建原生边缘监视线程失败',
  [-8]: '已经存在活动的原生边缘监视器',
  [-9]: '停止原生边缘监视线程超时',
  [-10]: '注册 Windows 边缘通知消息失败',
  [-11]: '贴边会话代次无效',
  [-12]: '原生小黑条显示模式无效',
  [-13]: '注册原生小黑条窗口类失败',
  [-14]: '创建原生小黑条窗口失败',
  [-15]: '原生边缘监视线程初始化超时',
  [-16]: '原生边缘监视线程尚未准备好接收常显命令'
})

const NATIVE_REVEAL_HANDLE_MODES = Object.freeze({
  direct: 0,
  'on-touch': 1,
  persistent: 2
})

function getNativeDockSide(side) {
  return side === 'left'
    ? -1
    : side === 'right'
      ? 1
      : side === 'top'
        ? -2
        : side === 'bottom'
          ? 2
          : 0
}

function getDockSideName(side) {
  return side === -1
    ? 'left'
    : side === 1
      ? 'right'
      : side === -2
        ? 'top'
        : side === 2
          ? 'bottom'
          : null
}

function getNativeError(fallback) {
  if (!lib) return { code: null, key: null, message: fallback }
  const code = lib.Blur_GetLastErrorCode()
  const key = lib.Blur_GetLastErrorMessage()
  return { code, key, message: NATIVE_ERROR_MESSAGES[code] || fallback }
}

export function detectCapabilities() {
  const { platform } = process

  if (platform === 'darwin') {
    return { supported: true, platform: 'macOS', strategy: 'vibrancy' }
  }

  if (platform === 'win32') {
    // 不在 JavaScript 中用 os.release() 拦截旧版本：Windows 兼容模式可能把
    // 已支持的 Win10 1909 等系统报告成较早版本。原生 DLL 使用 RtlGetVersion()
    // 获取真实 build，并在初始化时给出最终的“支持 / 不支持”结论。
    return { supported: true, platform: 'Windows', strategy: 'dcomp' }
  }

  return { supported: false, platform, reason: '不支持' }
}

function getDllPath() {
  const prod = join(process.resourcesPath, 'native_blur', 'blur_engine.dll')
  try {
    require('fs').accessSync(prod)
    return prod
  } catch {
    // 生产路径不存在时继续尝试开发路径。
  }

  const integrationDll =
    process.env.ABANDON_INTEGRATION_TEST === '1' ? process.env.ABANDON_INTEGRATION_NATIVE_DLL : null
  const devs = [
    integrationDll,
    join(app.getAppPath(), 'native_blur', 'build', 'bin', 'blur_engine.dll'),
    join(app.getAppPath(), 'native_blur', 'build', 'bin', 'Release', 'blur_engine.dll'),
    join(app.getAppPath(), 'native_blur', 'build', 'bin', 'Debug', 'blur_engine.dll')
  ]
  for (const p of devs) {
    if (!p) continue
    try {
      require('fs').accessSync(p)
      return p
    } catch {
      // 当前候选不存在时继续尝试下一个路径。
    }
  }
  return null
}

function initNative() {
  if (process.platform !== 'win32' || lib) return !!lib
  const dllPath = getDllPath()
  if (!dllPath) {
    console.warn('[blur] DLL 未找到')
    return false
  }

  try {
    koffi = require('koffi')
    lib = koffi.load(dllPath)
    lib.Blur_Init = lib.func('Blur_Init', 'int', ['intptr_t'])
    lib.Blur_Destroy = lib.func('Blur_Destroy', 'void', [])
    lib.Blur_ApplyConfig = lib.func('Blur_ApplyConfig', 'void', ['int', 'float', 'float', 'float'])
    lib.Blur_UpdateGeometry = lib.func('Blur_UpdateGeometry', 'void', [])
    lib.Blur_ReSyncOrder = lib.func('Blur_ReSyncOrder', 'void', [])
    lib.Blur_IsInitialized = lib.func('Blur_IsInitialized', 'int', [])
    lib.Blur_IsHealthy = lib.func('Blur_IsHealthy', 'int', [])
    lib.Blur_IsZOrderSynchronized = lib.func('Blur_IsZOrderSynchronized', 'int', [])
    lib.Blur_IsSupported = lib.func('Blur_IsSupported', 'int', [])
    lib.Blur_GetLastErrorCode = lib.func('Blur_GetLastErrorCode', 'int', [])
    lib.Blur_GetLastErrorMessage = lib.func('Blur_GetLastErrorMessage', 'str', [])
    lib.WindowMotion_MoveWindow = lib.func('WindowMotion_MoveWindow', 'int', [
      'intptr_t',
      'int',
      'int'
    ])
    lib.WindowMotion_GetSnapshotJson = lib.func('WindowMotion_GetSnapshotJson', 'str', ['intptr_t'])
    lib.WindowMotion_IsEdgeExposed = lib.func('WindowMotion_IsEdgeExposed', 'int', [
      'intptr_t',
      'int'
    ])
    lib.WindowMotion_ArmEdgeMonitor = lib.func('WindowMotion_ArmEdgeMonitor', 'int', [
      'intptr_t',
      'int',
      'int',
      'int',
      'uint64_t'
    ])
    // Ex 是向后兼容的可选扩展；旧 DLL 仍可加载并继续使用触边即唤出的旧 ABI。
    try {
      lib.WindowMotion_ArmEdgeMonitorEx = lib.func('WindowMotion_ArmEdgeMonitorEx', 'int', [
        'intptr_t',
        'int',
        'int',
        'int',
        'uint64_t',
        'int'
      ])
    } catch {
      lib.WindowMotion_ArmEdgeMonitorEx = null
    }
    try {
      lib.WindowMotion_ShowPersistentHandle = lib.func('WindowMotion_ShowPersistentHandle', 'int', [
        'uint64_t'
      ])
    } catch {
      lib.WindowMotion_ShowPersistentHandle = null
    }
    lib.WindowMotion_DisarmEdgeMonitor = lib.func('WindowMotion_DisarmEdgeMonitor', 'int', [
      'uint64_t'
    ])
    lib.WindowMotion_GetEdgeMessageId = lib.func('WindowMotion_GetEdgeMessageId', 'uint', [])
    lib.WindowMotion_GetEdgeMonitorStatusJson = lib.func(
      'WindowMotion_GetEdgeMonitorStatusJson',
      'str',
      []
    )
    lib.WindowMotion_ConsumeEdgeEventJson = lib.func('WindowMotion_ConsumeEdgeEventJson', 'str', [])
    return true
  } catch (e) {
    console.warn('[blur] DLL 加载失败:', e)
    lib = null
    return false
  }
}

export function initialize(mainWindow) {
  const caps = detectCapabilities()
  if (!caps.supported) return { success: false, error: caps.reason }
  if (caps.platform === 'macOS') return { success: true, strategy: 'vibrancy' }

  if (!initNative()) return { success: false, error: 'DLL 加载失败' }
  if (!lib.Blur_IsSupported()) {
    const nativeError = getNativeError('当前 Windows 版本不支持原生模糊')
    return { success: false, error: nativeError.message, nativeError }
  }

  const hwndVal = getWindowHandleValue(mainWindow)

  if (!lib.Blur_Init(hwndVal)) {
    const nativeError = getNativeError('原生模糊引擎初始化失败')
    return { success: false, error: nativeError.message, nativeError }
  }

  initialized = true
  lib.Blur_UpdateGeometry()
  return { success: true, strategy: 'dcomp' }
}

export function setConfig(config) {
  if (!initialized) return false
  lib.Blur_ApplyConfig(
    config.enabled ? 1 : 0,
    config.radius,
    config.saturation,
    config.cornerRadius
  )
  return true
}

export function updateGeometry() {
  if (!initialized) return
  lib.Blur_UpdateGeometry()
}

export function reSyncZOrder() {
  if (!initialized || process.platform !== 'win32') return
  lib.Blur_ReSyncOrder()
}

/**
 * 查询原生线程在初始化后的实际健康状态。Effect Graph、Overlay、窗口同步或
 * 消息队列运行期失效时，DLL 会保留错误码，供主进程主动降级而不是静默失败。
 */
export function getRuntimeHealth() {
  if (!initialized || process.platform !== 'win32' || !lib) {
    return { healthy: false, initialized: false, nativeError: null }
  }

  const nativeInitialized = Boolean(lib.Blur_IsInitialized())
  const healthy = nativeInitialized && Boolean(lib.Blur_IsHealthy())
  return {
    healthy,
    initialized: nativeInitialized,
    zOrderSynchronized: nativeInitialized && Boolean(lib.Blur_IsZOrderSynchronized()),
    nativeError: healthy ? null : getNativeError('原生模糊运行期失效')
  }
}

export function getWindowMotionSnapshot(window) {
  if (process.platform !== 'win32' || !window || window.isDestroyed() || !initNative()) {
    return null
  }
  try {
    return JSON.parse(lib.WindowMotion_GetSnapshotJson(getWindowHandleValue(window)))
  } catch (error) {
    const wrapped = new Error(`读取 Windows 物理窗口边界失败：${error?.message || String(error)}`, {
      cause: error
    })
    wrapped.code = 'WINDOW_MOTION_SNAPSHOT_FAILED'
    throw wrapped
  }
}

export function moveWindowPhysical(window, physicalX, physicalY) {
  if (process.platform !== 'win32' || !window || window.isDestroyed() || !initNative()) {
    return false
  }
  return Boolean(
    lib.WindowMotion_MoveWindow(
      getWindowHandleValue(window),
      Math.round(physicalX),
      Math.round(physicalY)
    )
  )
}

export function isWindowDockEdgeExposed(window, side) {
  if (process.platform !== 'win32' || !window || window.isDestroyed() || !initNative()) {
    return false
  }
  const nativeSide = getNativeDockSide(side)
  if (!nativeSide) return false
  return Boolean(lib.WindowMotion_IsEdgeExposed(getWindowHandleValue(window), nativeSide))
}

export function armWindowEdgeMonitor(
  window,
  side,
  generation,
  { thicknessDip = 2, pollIntervalMs = 100, revealHandleMode = 'direct' } = {}
) {
  if (process.platform !== 'win32' || !window || window.isDestroyed() || !initNative()) {
    return { success: false, code: null, error: 'Windows 原生边缘监视器不可用' }
  }
  const nativeSide = getNativeDockSide(side)
  if (!nativeSide) return { success: false, code: -2, error: EDGE_MONITOR_RESULT_MESSAGES[-2] }
  const nativeRevealMode = NATIVE_REVEAL_HANDLE_MODES[revealHandleMode]
  if (!Number.isInteger(nativeRevealMode)) {
    return { success: false, code: -12, error: EDGE_MONITOR_RESULT_MESSAGES[-12] }
  }
  if (nativeRevealMode !== 0 && !lib.WindowMotion_ArmEdgeMonitorEx) {
    return { success: false, code: null, error: '当前原生 DLL 不支持小黑条模式' }
  }
  if (nativeRevealMode === 2 && !lib.WindowMotion_ShowPersistentHandle) {
    return { success: false, code: null, error: '当前原生 DLL 不支持小黑条常显模式' }
  }
  const args = [
    getWindowHandleValue(window),
    nativeSide,
    Math.max(1, Math.round(thicknessDip)),
    Math.max(25, Math.round(pollIntervalMs)),
    Number(generation)
  ]
  // 直接唤出模式继续调用旧导出，确保旧行为与 ABI 路径均保持不变。
  const code =
    nativeRevealMode !== 0
      ? lib.WindowMotion_ArmEdgeMonitorEx(...args, nativeRevealMode)
      : lib.WindowMotion_ArmEdgeMonitor(...args)
  return {
    success: code === 1,
    cleanupRequired: code === -15,
    code,
    error:
      code === 1 ? null : EDGE_MONITOR_RESULT_MESSAGES[code] || `原生边缘监视器启动失败 (${code})`
  }
}

export function showWindowPersistentHandle(generation) {
  if (process.platform !== 'win32' || !initNative() || !lib.WindowMotion_ShowPersistentHandle) {
    return { success: false, code: null, error: '当前原生 DLL 不支持小黑条常显模式' }
  }
  const code = lib.WindowMotion_ShowPersistentHandle(Number(generation))
  return {
    success: code === 1,
    code,
    error: code === 1 ? null : EDGE_MONITOR_RESULT_MESSAGES[code] || `常显小黑条激活失败 (${code})`
  }
}

export function disarmWindowEdgeMonitor(generation = 0) {
  if (process.platform !== 'win32' || !initNative()) return true
  return lib.WindowMotion_DisarmEdgeMonitor(Number(generation)) === 1
}

export function getWindowEdgeMonitorMessageId() {
  if (process.platform !== 'win32' || !initNative()) return null
  const messageId = lib.WindowMotion_GetEdgeMessageId()
  return Number.isInteger(messageId) && messageId > 0 ? messageId : null
}

export function getWindowEdgeMonitorStatus() {
  if (process.platform !== 'win32' || !initNative()) {
    return {
      supported: false,
      revealHandleSupported: false,
      persistentHandleSupported: false,
      state: 'unavailable',
      workerAlive: false,
      generation: 0,
      side: null
    }
  }
  const status = JSON.parse(lib.WindowMotion_GetEdgeMonitorStatusJson())
  return {
    ...status,
    // 上一版 DLL 的 mode 字段使用内部名称 click-handle；统一成设置枚举，
    // 避免仅替换应用代码、尚未替换 DLL 时被健康检查误判为会话不一致。
    mode: status.mode === 'click-handle' ? 'on-touch' : status.mode,
    supported: true,
    revealHandleSupported: Boolean(lib.WindowMotion_ArmEdgeMonitorEx),
    persistentHandleSupported: Boolean(
      lib.WindowMotion_ArmEdgeMonitorEx && lib.WindowMotion_ShowPersistentHandle
    ),
    side: getDockSideName(status.side)
  }
}

export function consumeWindowEdgeMonitorEvent() {
  if (process.platform !== 'win32' || !initNative()) return null
  const event = JSON.parse(lib.WindowMotion_ConsumeEdgeEventJson())
  if (!event || event.kind === 'none') return null
  return { ...event, side: getDockSideName(event.side) }
}

export function destroy() {
  if (!lib) return
  try {
    lib.WindowMotion_DisarmEdgeMonitor(0)
  } finally {
    if (initialized) lib.Blur_Destroy()
    initialized = false
  }
}
