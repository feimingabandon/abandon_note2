/**
 * blur_bridge.js — Node.js 到 C++ DLL 的 koffi FFI 桥接层
 */

import { join } from 'path'
import { app } from 'electron'

let koffi = null
let lib = null
let initialized = false

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
  try { require('fs').accessSync(prod); return prod } catch (_) {}

  const devs = [
    join(__dirname, '..', '..', 'native_blur', 'build', 'bin', 'Release', 'blur_engine.dll'),
    join(__dirname, '..', '..', 'native_blur', 'build', 'bin', 'blur_engine.dll'),
    join(__dirname, '..', '..', 'native_blur', 'build', 'bin', 'Debug', 'blur_engine.dll'),
  ]
  for (const p of devs) {
    try { require('fs').accessSync(p); return p } catch (_) {}
  }
  return null
}

function initNative() {
  if (process.platform !== 'win32' || lib) return !!lib
  const dllPath = getDllPath()
  if (!dllPath) { console.warn('[blur] DLL 未找到'); return false }

  try {
    koffi = require('koffi')
    lib = koffi.load(dllPath)
    lib.Blur_Init = lib.func('Blur_Init', 'int', ['intptr_t'])
    lib.Blur_Destroy = lib.func('Blur_Destroy', 'void', [])
    lib.Blur_SetRadius = lib.func('Blur_SetRadius', 'void', ['float'])
    lib.Blur_SetTint = lib.func('Blur_SetTint', 'void', ['int', 'int', 'int'])
    lib.Blur_SetEnabled = lib.func('Blur_SetEnabled', 'void', ['int'])
    lib.Blur_SetSaturation = lib.func('Blur_SetSaturation', 'void', ['float'])
    lib.Blur_SetCornerRadius = lib.func('Blur_SetCornerRadius', 'void', ['float'])
    lib.Blur_UpdateGeometry = lib.func('Blur_UpdateGeometry', 'void', ['int', 'int', 'int', 'int'])
    lib.Blur_IsInitialized = lib.func('Blur_IsInitialized', 'int', [])
    lib.Blur_IsSupported = lib.func('Blur_IsSupported', 'int', [])
    return true
  } catch (e) {
    console.warn('[blur] DLL 加载失败:', e.message)
    lib = null; return false
  }
}

export function initialize(mainWindow) {
  const caps = detectCapabilities()
  if (!caps.supported) return { success: false, error: caps.reason }
  if (caps.platform === 'macOS') return { success: true, strategy: 'vibrancy' }

  if (!initNative()) return { success: false, error: 'DLL 加载失败' }

  const hwndBuf = mainWindow.getNativeWindowHandle()
  // HWND 在 x64 上是 8 字节，读取为整数传给 DLL
  const hwndVal = hwndBuf.length >= 8
    ? Number(hwndBuf.readBigUInt64LE())
    : hwndBuf.readUInt32LE()

  if (!lib.Blur_Init(hwndVal)) return { success: false, error: '引擎初始化失败' }

  initialized = true
  const b = mainWindow.getBounds()
  lib.Blur_UpdateGeometry(b.x, b.y, b.width, b.height)
  return { success: true, strategy: 'dcomp' }
}

export function setConfig(config) {
  if (!initialized) return false
  if (config.enabled !== undefined) lib.Blur_SetEnabled(config.enabled ? 1 : 0)
  if (config.saturation !== undefined) lib.Blur_SetSaturation(config.saturation)
  if (config.cornerRadius !== undefined) lib.Blur_SetCornerRadius(config.cornerRadius)
  if (config.radius !== undefined) lib.Blur_SetRadius(config.radius)
  if (config.tint) lib.Blur_SetTint(config.tint.r, config.tint.g, config.tint.b)
  return true
}

export function updateGeometry(mainWindow) {
  if (!initialized) return
  const b = mainWindow.getBounds()
  lib.Blur_UpdateGeometry(b.x, b.y, b.width, b.height)
}

export function destroy() {
  if (lib && initialized) { lib.Blur_Destroy(); initialized = false }
}
