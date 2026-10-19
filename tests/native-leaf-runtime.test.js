import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '../src/shared/settings-schema.js'

const native = vi.hoisted(() => ({
  detectCapabilities: vi.fn(() => ({ supported: true, strategy: 'windows' })),
  initialize: vi.fn(() => ({ success: true, strategy: 'windows' })),
  setConfig: vi.fn(),
  updateGeometry: vi.fn(),
  syncGeometryAndWait: vi.fn(),
  destroy: vi.fn(),
  reSyncZOrder: vi.fn(),
  getRuntimeHealth: vi.fn(() => ({ healthy: true, zOrderSynchronized: true })),
  getWindowZOrderStatus: vi.fn(() => ({ enabled: false })),
  reassertWindowZOrder: vi.fn(() => ({ success: true })),
  setWindowAlwaysOnBottom: vi.fn(() => ({ success: true }))
}))
vi.mock('../src/main/bridge/blur_bridge.js', () => native)
const diagnostics = vi.hoisted(() => ({ captureWindowLayerDiagnostic: vi.fn() }))
vi.mock('../src/main/bridge/window-layer-diagnostics.js', () => diagnostics)
const persistence = vi.hoisted(() => ({
  setSettingsBatch: vi.fn(),
  writeApplicationSetting: vi.fn()
}))
vi.mock('../src/main/db/db-settings-repository.js', () => ({
  setSettingsBatch: persistence.setSettingsBatch
}))
vi.mock('../src/main/settings/application-settings.js', () => ({
  writeApplicationSetting: persistence.writeApplicationSetting
}))
import { createBlurRuntime } from '../src/main/windows/blur-runtime.js'
import { createZOrderRuntime } from '../src/main/windows/z-order-runtime.js'

function fixture() {
  const window = new EventEmitter()
  let topmost = false
  Object.assign(window, {
    isDestroyed: () => false,
    isVisible: () => true,
    isAlwaysOnTop: () => topmost,
    setAlwaysOnTop: vi.fn((value) => (topmost = value)),
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      isLoadingMainFrame: () => false,
      send: vi.fn()
    }
  })
  const values = createDefaultSettings()
  values.blur.enabled = true
  values.window.zOrderMode = 'normal'
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const ports = {
    getMainWindow: () => window,
    getActiveVisualWindow: () => window,
    getApplicationWindows: () => [window],
    getSettings: () => values,
    isWindowMoving: () => false,
    getActiveWindowName: () => 'main',
    refreshResolvedSettings: vi.fn(),
    broadcastSettingsChanged: vi.fn(),
    logger
  }
  const blur = createBlurRuntime(ports)
  blur.syncBlurConfigFromResolved()
  const zOrder = createZOrderRuntime({
    ...ports,
    readBlurState: () => ({ initialized: blur.initialized, config: blur.config }),
    readDockState: () => ({ isSliding: false, isDockHidden: false }),
    isWindowLocked: () => false,
    runBlurRuntimeOperation: blur.runBlurRuntimeOperation,
    getResolvedSettingsSnapshot: () => ({ values }),
    sendAppMessage: vi.fn()
  })
  zOrder.syncResolved()
  return { window, values, ports, blur, zOrder }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  native.getRuntimeHealth.mockReturnValue({ healthy: true, zOrderSynchronized: true })
})

describe('native leaf state owners', () => {
  it('owns read-only configuration and installs/removes exactly its listeners', () => {
    const { blur, window } = fixture()
    expect(Object.isFrozen(blur.config)).toBe(true)
    blur.initializeBlurRuntime()
    blur.initializeBlurRuntime()
    blur.attachBlurWindowSyncListeners(window)
    expect(window.listenerCount('move')).toBe(1)
    window.emit('move')
    expect(native.updateGeometry).toHaveBeenCalledOnce()
    blur.destroy()
    expect(window.listenerCount('move')).toBe(0)
    expect(window.listenerCount('resize')).toBe(0)
    expect(blur.initialized).toBe(false)
  })

  it('preserves controlled failure save/restore while material requests remain owned', () => {
    const { blur } = fixture()
    const state = {
      failed: true,
      error: 'failure',
      nativeError: { code: 7 },
      diagnostic: { status: 'error' }
    }
    blur.restoreFailure(state)
    blur.setRequestedConfig({ enabled: false, radius: 12 })
    expect(blur.failed).toBe(true)
    expect(blur.error).toBe('failure')
    expect(blur.config).toMatchObject({ enabled: false, radius: 12 })
    blur.clearFailure()
    expect(blur.failed).toBe(false)
    expect(blur.nativeError).toBe(null)
  })

  it('keeps the pending z-order intent through a settings refresh and persists only after confirmation', async () => {
    const { zOrder, values, ports } = fixture()
    const order = []
    native.getWindowZOrderStatus.mockImplementation(() => {
      order.push('confirm')
      return { enabled: false }
    })
    persistence.writeApplicationSetting.mockImplementation((_name, value) => {
      order.push('persist')
      values.window.zOrderMode = value
    })
    ports.refreshResolvedSettings.mockImplementation(() => zOrder.syncResolved())
    const changing = zOrder.persistWindowZOrderMode('top')
    zOrder.syncResolved()
    expect(zOrder.mode).toBe('top')
    expect(zOrder.snapshot().pendingMode).toBe('top')
    expect(await changing).toMatchObject({ mode: 'top', changed: true })
    expect(order).toEqual(['confirm', 'persist'])
    expect(zOrder.snapshot().pendingMode).toBe(null)
    expect(diagnostics.captureWindowLayerDiagnostic).not.toHaveBeenCalled()
  })

  it('rolls back the actual layer and leaves persistence unchanged on native apply failure', async () => {
    const { zOrder } = fixture()
    native.setWindowAlwaysOnBottom.mockReturnValueOnce({ success: false, error: 'native failure' })
    await expect(zOrder.persistWindowZOrderMode('top')).rejects.toThrow('native failure')
    expect(zOrder.mode).toBe('normal')
    expect(zOrder.snapshot().pendingMode).toBe(null)
    expect(persistence.writeApplicationSetting).not.toHaveBeenCalled()
    expect(native.setWindowAlwaysOnBottom).toHaveBeenCalledTimes(2)
    expect(diagnostics.captureWindowLayerDiagnostic).not.toHaveBeenCalled()
  })

  it('owns bounded retry timers and cancels a retry after the user changes the layer', async () => {
    vi.useFakeTimers()
    const { zOrder, values } = fixture()
    values.window.zOrderMode = 'bottom'
    zOrder.syncResolved()
    zOrder.scheduleBottomWindowZOrderRetry('test')
    expect(zOrder.snapshot()).toMatchObject({ retryPending: true, retryAttempt: 1 })
    values.window.zOrderMode = 'normal'
    zOrder.syncResolved()
    await vi.advanceTimersByTimeAsync(160)
    expect(native.reassertWindowZOrder).not.toHaveBeenCalled()
    expect(zOrder.snapshot()).toMatchObject({ retryPending: false, retryAttempt: 0 })
  })

  it('logs four unsuccessful confirmations before rollback without saving or changing the product error', async () => {
    vi.useFakeTimers()
    const { zOrder, blur, window, ports } = fixture()
    blur.initializeBlurRuntime()
    native.getRuntimeHealth.mockReturnValue({ healthy: true, zOrderSynchronized: false })
    diagnostics.captureWindowLayerDiagnostic.mockImplementation(() => {
      expect(window.isAlwaysOnTop()).toBe(true)
      return { classification: 'observation-failed', error: 'diagnostic read failed' }
    })
    let rejection
    const changing = zOrder.persistWindowZOrderMode('top').catch((error) => {
      rejection = error
    })
    await vi.advanceTimersByTimeAsync(399)
    expect(diagnostics.captureWindowLayerDiagnostic).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await changing
    expect(rejection.message).toBe('窗口层级未能同步，请重新选择后重试')
    const details = ports.logger.warn.mock.calls.find(
      ([scope]) => scope === 'window.z-order-confirm'
    )[2]
    expect(details.confirmationChecks.map((check) => check.delayMs)).toEqual([0, 40, 120, 240])
    expect(details.confirmationChecks.map((check) => check.elapsedMs)).toEqual([0, 40, 160, 400])
    expect(
      details.confirmationChecks.every(
        (check) => check.topmostMatches && !check.blurZOrderSynchronized
      )
    ).toBe(true)
    const layerDetails = ports.logger.warn.mock.calls.find(
      ([scope]) => scope === 'window.z-order-layers'
    )[2]
    expect(layerDetails.windowLayers.classification).toBe('observation-failed')
    expect(diagnostics.captureWindowLayerDiagnostic).toHaveBeenCalledOnce()
    expect(window.isAlwaysOnTop()).toBe(false)
    expect(persistence.writeApplicationSetting).not.toHaveBeenCalled()
    expect(zOrder.mode).toBe('normal')
  })
})
