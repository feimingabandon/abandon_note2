import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MAIN_PATH = new URL('../src/main/index.js', import.meta.url)

describe('main-window z-order transaction wiring', () => {
  it('keeps runtime application inside the rollback boundary', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const transition = source.slice(
      source.indexOf('function persistWindowZOrderMode(mode)'),
      source.indexOf('function openMainWindow()')
    )

    expect(transition.indexOf('try {')).toBeLessThan(
      transition.indexOf('const runtimeResult = applyWindowZOrder(normalized)')
    )
    expect(transition).toContain('const rollbackResult = applyWindowZOrder(previousMode)')
    expect(transition).toContain("writeApplicationSetting('window.zOrderMode', previousMode)")
    expect(transition).toContain("logger.error('window.z-order-rollback'")
    expect(transition).toContain("logger.error('window.z-order-persistence-rollback'")
    expect(transition).toContain('pendingWindowZOrderMode = normalized')
    expect(transition).toContain('pendingWindowZOrderMode = previousMode')
    expect(transition).toContain('pendingWindowZOrderMode = null')
  })

  it('preserves the pending layer across settings refreshes and verifies the bottom controller', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    expect(source).toContain('pendingWindowZOrderMode ?? resolvedSettings.window.zOrderMode')
    const confirm = source.slice(
      source.indexOf('async function confirmWindowZOrder('),
      source.indexOf('async function persistWindowZOrderMode(')
    )
    expect(confirm).toContain('getWindowZOrderStatus(window)')
    expect(confirm).toContain(
      'nativeZOrder?.enabled && nativeZOrder.requestedMatches && nativeZOrder.anchored'
    )
    expect(confirm).toContain("logger.warn('window.z-order-confirm'")
  })

  it('converts Electron or native bridge exceptions into a failed runtime result', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const apply = source.slice(
      source.indexOf('function applyWindowZOrder(mode = zOrderMode)'),
      source.indexOf('function reassertBottomWindowZOrder(source)')
    )

    expect(apply).toContain('try {')
    expect(apply).toContain('const visualWindow = getActiveVisualWindow()')
    expect(apply).toContain('setWindowAlwaysOnBottom(visualWindow, true)')
    expect(apply).toContain('setWindowAlwaysOnBottom(visualWindow, false)')
    expect(apply).toContain('success: false')
    expect(apply).toContain('error: error?.message || String(error)')
  })

  it('reinstalls a missing native controller with bounded retries and isolates async exceptions', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const recovery = source.slice(
      source.indexOf('function cancelBottomWindowZOrderRetry()'),
      source.indexOf('function persistWindowZOrderMode(mode)')
    )

    expect(source).toContain(
      'const BOTTOM_Z_ORDER_RETRY_DELAYS_MS = Object.freeze([160, 480, 1200])'
    )
    expect(recovery).toContain('bottomZOrderRetryAttempt >= BOTTOM_Z_ORDER_RETRY_DELAYS_MS.length')
    expect(recovery).toContain('result.code === WINDOW_Z_ORDER_NOT_ENABLED_CODE')
    expect(recovery).toContain('result = setWindowAlwaysOnBottom(visualWindow, true)')
    expect(recovery).toContain('getActiveVisualWindow() !== targetWindow')
    expect(recovery).toContain("logger.error('window.z-order-reassert-exception'")
    expect(recovery).toContain("sendAppMessage('error', '始终置底暂时无法恢复")
    expect(recovery).toContain('cancelBottomWindowZOrderRetry()')
  })
})
