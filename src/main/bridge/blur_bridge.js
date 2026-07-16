/**
 * blur_bridge.js — Node.js 到 C++ DLL 的 koffi FFI 桥接层
 */

import { join } from 'path'

let koffi = null
let lib = null
let initialized = false

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
    const [, , build] = require('os').release().split('.').map(Number)
    if (build < 18362) {
      return { supported: false, platform: 'Windows', reason: '需要 Win10 1903+' }
    }
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

  const devs = [
    join(__dirname, '..', '..', 'native_blur', 'build', 'bin', 'Release', 'blur_engine.dll'),
    join(__dirname, '..', '..', 'native_blur', 'build', 'bin', 'blur_engine.dll'),
    join(__dirname, '..', '..', 'native_blur', 'build', 'bin', 'Debug', 'blur_engine.dll')
  ]
  for (const p of devs) {
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
    lib.Blur_IsSupported = lib.func('Blur_IsSupported', 'int', [])
    lib.Blur_GetLastErrorCode = lib.func('Blur_GetLastErrorCode', 'int', [])
    lib.Blur_GetLastErrorMessage = lib.func('Blur_GetLastErrorMessage', 'str', [])
    return true
  } catch (e) {
    console.warn('[blur] DLL 加载失败:', e.message)
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

  const hwndBuf = mainWindow.getNativeWindowHandle()
  // HWND 在 x64 上是 8 字节，读取为整数传给 DLL
  const hwndVal = hwndBuf.length >= 8 ? Number(hwndBuf.readBigUInt64LE()) : hwndBuf.readUInt32LE()

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

export function destroy() {
  if (lib && initialized) {
    lib.Blur_Destroy()
    initialized = false
  }
}
