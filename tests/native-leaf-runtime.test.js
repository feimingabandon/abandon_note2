import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'

const native = vi.hoisted(() => ({
  detectCapabilities: vi.fn(() => ({ supported: true, strategy: 'windows' })),
  initialize: vi.fn(() => ({ success: true, strategy: 'windows' })),
  setConfig: vi.fn(() => true),
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
vi.mock('../src/main/logging/operation-context.js', () => ({ checkpoint: vi.fn() }))
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

function fixture({
  visualWindowAvailable = true,
  windowVisible = true,
  applicationCompletion
} = {}) {
  const window = new EventEmitter()
  let topmost = false
  Object.assign(window, {
    isDestroyed: () => false,
    isVisible: () => windowVisible,
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
    getActiveVisualWindow: () => (visualWindowAvailable ? window : null),
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
    readBlurState: () => ({
      initialized: blur.initialized,
      config: blur.config,
      error: blur.error
    }),
    readDockState: () => ({ isSliding: false, isDockHidden: false }),
    isWindowLocked: () => false,
    runBlurRuntimeOperation: blur.runBlurRuntimeOperation,
    getResolvedSettingsSnapshot: () => ({ values }),
    completeCommittedSettings: applicationCompletion,
    sendAppMessage: vi.fn()
  })
  zOrder.syncResolved()
  return { window, values, ports, blur, zOrder }
}

function acceptSafetyDisable({ values, ports, blur }) {
  persistence.setSettingsBatch.mockImplementationOnce((_scope, entries) => {
    const row = entries.find((entry) => entry.key === 'blur_enabled')
    if (row) values.blur.enabled = row.value === 'true'
  })
  ports.refreshResolvedSettings.mockImplementationOnce(() => blur.syncBlurConfigFromResolved())
}

function shutdownSnapshot(overrides = {}) {
  return {
    generation: 1,
    status: 'completed',
    threadExitConfirmed: true,
    waitResult: 0,
    nativeCode: 0,
    abandoned: false,
    modulePinned: false,
    pinNativeCode: 0,
    ...overrides
  }
}

const bridgeSource = readFileSync(
  new URL('../src/main/bridge/blur_bridge.js', import.meta.url),
  'utf8'
)
function bridgeFixture(shutdown = shutdownSnapshot()) {
  const calls = []
  const ffi = {
    AbandonNative_GetAbiVersion: vi.fn(() => NATIVE_ABI_VERSION),
    Blur_IsSupported: vi.fn(() => 1),
    Blur_IsInitialized: vi.fn(() => 1),
    Blur_IsHealthy: vi.fn(() => 1),
    Blur_IsZOrderSynchronized: vi.fn(() => 1),
    Blur_Init: vi.fn(() => 1),
    Blur_GetLastErrorCode: vi.fn(() => 8),
    Blur_GetLastErrorMessage: vi.fn(() => 'controlled-native-failure'),
    WindowMotion_DisarmEdgeMonitor: vi.fn(() => {
      calls.push('disarm')
      return 1
    }),
    Blur_Destroy: vi.fn(() => calls.push('destroy')),
    Blur_GetLastFailureJson: vi.fn(() => {
      calls.push('observe')
      return JSON.stringify({ stage: 'original-failure', nativeCode: 7, shutdown })
    })
  }
  const loaded = { func: vi.fn((name) => ffi[name] || vi.fn()) }
  // Execute the production module with only its imports/FFI ports substituted;
  // lib and initialized remain the real module's private ownership state.
  const bridge = new Function(
    'ports',
    `const { measureSyncPerformance, registerNativeMotionDiagnostics, join, app,
      NATIVE_ABI_VERSION, getWindowsPlatformCompatibility, process, require } = ports;
    ${bridgeSource.replace(/^import .+$/gm, '').replace(/^export /gm, '')}
    return { initialize, destroy, getRuntimeHealth, getNativeRuntimeCompatibility };`
  )({
    measureSyncPerformance: (_scope, _operation, work) => work(),
    registerNativeMotionDiagnostics: () => {},
    join,
    app: { getAppPath: () => 'test-app' },
    NATIVE_ABI_VERSION,
    getWindowsPlatformCompatibility: () => ({ success: true }),
    process: { platform: 'win32', resourcesPath: 'test-resources', env: {} },
    require(name) {
      if (name === 'fs') return { accessSync: () => {} }
      if (name === 'koffi') return { load: () => loaded }
      throw new Error(`Unexpected bridge dependency: ${name}`)
    }
  })
  const window = { getNativeWindowHandle: () => Buffer.alloc(8, 1) }
  return { bridge, ffi, calls, window }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  native.setConfig.mockReset().mockReturnValue(true)
  native.initialize.mockReset().mockReturnValue({ success: true, strategy: 'windows' })
  native.reSyncZOrder.mockReset()
  native.destroy.mockReset()
  persistence.setSettingsBatch.mockReset()
  native.getRuntimeHealth.mockReturnValue({ healthy: true, zOrderSynchronized: true })
})

describe('native blur shutdown ownership', () => {
  it('does not infer native exit or load a DLL merely because the JS state was never initialized', () => {
    const { bridge, ffi } = bridgeFixture()
    expect(bridge.destroy()).toMatchObject({
      outcome: 'degraded',
      nativeShutdown: null,
      error: { phase: 'observe-shutdown' }
    })
    expect(ffi.AbandonNative_GetAbiVersion).not.toHaveBeenCalled()
    expect(ffi.Blur_Destroy).not.toHaveBeenCalled()
  })

  it('observes a loaded but never-created owner without claiming a thread join', () => {
    const initial = shutdownSnapshot({
      generation: 0,
      status: 'not-created',
      threadExitConfirmed: false,
      waitResult: null
    })
    const { bridge, calls } = bridgeFixture(initial)
    expect(bridge.getNativeRuntimeCompatibility().success).toBe(true)
    expect(bridge.destroy()).toEqual({ outcome: 'completed', nativeShutdown: initial })
    expect(calls).toEqual(['disarm', 'destroy', 'observe'])
  })

  it('destroys a partial initialization despite its false JS flag and preserves abandoned timeout on reentry', () => {
    const abandoned = shutdownSnapshot({
      status: 'timed-out',
      threadExitConfirmed: false,
      waitResult: 258,
      abandoned: true,
      modulePinned: true
    })
    const { bridge, ffi, calls, window } = bridgeFixture(abandoned)
    ffi.Blur_Init.mockReturnValueOnce(0)
    expect(bridge.initialize(window).success).toBe(false)
    calls.length = 0
    expect(bridge.destroy()).toEqual({ outcome: 'timed-out', nativeShutdown: abandoned })
    expect(bridge.destroy()).toEqual({ outcome: 'timed-out', nativeShutdown: abandoned })
    expect(calls).toEqual(['disarm', 'destroy', 'observe', 'disarm', 'destroy', 'observe'])
    expect(ffi.Blur_Destroy).toHaveBeenCalledTimes(2)
    expect(bridge.getRuntimeHealth().initialized).toBe(false)
  })

  it('returns the native joined result and still observes a repeated destroy after its JS flag was reset', () => {
    const joined = shutdownSnapshot()
    const { bridge, ffi, window } = bridgeFixture(joined)
    expect(bridge.initialize(window).success).toBe(true)
    expect(bridge.destroy()).toEqual({ outcome: 'completed', nativeShutdown: joined })
    expect(bridge.destroy()).toEqual({ outcome: 'completed', nativeShutdown: joined })
    expect(ffi.Blur_Destroy).toHaveBeenCalledTimes(2)
    expect(bridge.getRuntimeHealth().initialized).toBe(false)
  })

  it.each([
    ['old DLL without the JSON extension', null],
    ['missing required evidence', { status: 'completed', threadExitConfirmed: true }],
    ['unconfirmed completed status', shutdownSnapshot({ threadExitConfirmed: false })],
    ['abandoned completed status', shutdownSnapshot({ abandoned: true })],
    ['non-signaled completed wait', shutdownSnapshot({ waitResult: 258 })]
  ])('keeps %s unconfirmed without rejecting DLL compatibility', (_label, snapshot) => {
    const { bridge, ffi } = bridgeFixture(snapshot)
    expect(bridge.getNativeRuntimeCompatibility().success).toBe(true)
    expect(bridge.destroy()).toMatchObject({ outcome: 'degraded', nativeShutdown: snapshot })
    expect(ffi.Blur_Destroy).toHaveBeenCalledOnce()
  })

  it('returns a native wait failure with its original numeric diagnostics', () => {
    const failed = shutdownSnapshot({
      status: 'failed',
      threadExitConfirmed: false,
      waitResult: 4294967295,
      nativeCode: 6,
      abandoned: true,
      modulePinned: false,
      pinNativeCode: 5
    })
    const { bridge } = bridgeFixture(failed)
    bridge.getNativeRuntimeCompatibility()
    expect(bridge.destroy()).toEqual({ outcome: 'failed', nativeShutdown: failed })
  })

  it('preserves a real negative edge-monitor result even when the blur STA exit is confirmed', () => {
    const { bridge, ffi, calls, window } = bridgeFixture()
    bridge.initialize(window)
    ffi.WindowMotion_DisarmEdgeMonitor.mockImplementationOnce(() => {
      calls.push('disarm')
      return -9
    })
    expect(bridge.destroy()).toEqual({
      outcome: 'failed',
      nativeShutdown: shutdownSnapshot(),
      error: {
        phase: 'edge-monitor-disarm',
        code: -9,
        message: '停止原生边缘监视线程超时'
      }
    })
    expect(calls).toEqual(['disarm', 'destroy', 'observe'])
    expect(ffi.Blur_Destroy).toHaveBeenCalledOnce()
    expect(bridge.getRuntimeHealth().initialized).toBe(false)
  })

  it('continues Destroy and observation after disarm fails, preserving the first error and resetting its flag', () => {
    const { bridge, ffi, calls, window } = bridgeFixture()
    bridge.initialize(window)
    ffi.WindowMotion_DisarmEdgeMonitor.mockImplementationOnce(() => {
      throw Object.assign(new Error('disarm failed'), { code: 'DISARM_FAILED' })
    })
    ffi.Blur_Destroy.mockImplementationOnce(() => {
      calls.push('destroy')
      throw Object.assign(new Error('destroy failed'), { code: 'DESTROY_FAILED' })
    })
    expect(bridge.destroy()).toMatchObject({
      outcome: 'failed',
      nativeShutdown: shutdownSnapshot(),
      error: { phase: 'edge-monitor-disarm', code: 'DISARM_FAILED' },
      additionalErrors: [{ phase: 'native-destroy', code: 'DESTROY_FAILED' }]
    })
    expect(calls).toEqual(['destroy', 'observe'])
    expect(bridge.getRuntimeHealth().initialized).toBe(false)
  })

  it('does not turn a Destroy exception into success even if a diagnostic claims a completed join', () => {
    const { bridge, ffi } = bridgeFixture()
    bridge.getNativeRuntimeCompatibility()
    ffi.Blur_Destroy.mockImplementationOnce(() => {
      throw new Error('Destroy call failed')
    })
    expect(bridge.destroy()).toMatchObject({
      outcome: 'failed',
      nativeShutdown: shutdownSnapshot(),
      error: { phase: 'native-destroy', message: 'Destroy call failed' }
    })
    expect(ffi.Blur_GetLastFailureJson).toHaveBeenCalledOnce()
  })

  it('retains a diagnostic read failure without claiming that resetting JS state released the thread', () => {
    const { bridge, ffi, window } = bridgeFixture()
    bridge.initialize(window)
    ffi.Blur_GetLastFailureJson.mockImplementationOnce(() => {
      throw new Error('diagnostic unavailable')
    })
    expect(bridge.destroy()).toMatchObject({
      outcome: 'degraded',
      nativeShutdown: null,
      error: { phase: 'observe-shutdown', message: 'diagnostic unavailable' }
    })
    expect(ffi.Blur_Destroy).toHaveBeenCalledOnce()
    expect(bridge.getRuntimeHealth().initialized).toBe(false)
  })
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

  it.each(['completed', 'degraded', 'timed-out', 'failed'])(
    'returns the bridge %s result after releasing its listeners',
    (outcome) => {
      const { blur, window } = fixture()
      blur.initializeBlurRuntime()
      const result = { outcome, nativeShutdown: { status: outcome, threadExitConfirmed: false } }
      native.destroy.mockImplementationOnce(() => {
        expect(window.listenerCount('move')).toBe(0)
        expect(window.listenerCount('resize')).toBe(0)
        expect(window.listenerCount('focus')).toBe(0)
        return result
      })
      expect(blur.destroy()).toBe(result)
      expect(blur.initialized).toBe(false)
    }
  )

  it('clears its initialized state even when bridge teardown throws', () => {
    const { blur, window } = fixture()
    blur.initializeBlurRuntime()
    const failure = new Error('bridge destroy failed')
    native.destroy.mockImplementationOnce(() => {
      throw failure
    })
    expect(() => blur.destroy()).toThrow(failure)
    expect(blur.initialized).toBe(false)
    expect(window.listenerCount('move')).toBe(0)
    expect(window.listenerCount('resize')).toBe(0)
  })

  it.each(['initialization-rollback', 'runtime-failure', 'presentation-rebuild'])(
    'keeps failed teardown observable to the existing %s consumer',
    (path) => {
      const f = fixture()
      const shutdown = {
        outcome: 'failed',
        nativeShutdown: shutdownSnapshot(),
        error: { phase: 'native-destroy', code: 'CONTROLLED_DESTROY', message: 'Destroy failed' }
      }
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        if (path === 'initialization-rollback') {
          native.setConfig.mockReturnValueOnce(false)
          native.destroy.mockReturnValueOnce(shutdown)
          expect(f.blur.initializeBlurRuntime().success).toBe(false)
          expect(f.blur.initialized).toBe(false)
          expect(f.blur.error).toBe('原生毛玻璃首次配置未确认执行')
        } else {
          f.blur.initializeBlurRuntime()
          native.destroy.mockReturnValueOnce(shutdown)
          if (path === 'runtime-failure') {
            acceptSafetyDisable(f)
            expect(
              f.blur.runBlurRuntimeOperation(() => {
                throw new Error('original runtime failure')
              }, 'test operation')
            ).toBe(false)
            expect(f.blur.initialized).toBe(false)
            expect(f.blur.config.enabled).toBe(false)
            expect(f.blur.error).toContain('original runtime failure')
          } else {
            native.syncGeometryAndWait.mockImplementationOnce(() => {
              throw new Error('first synchronization failed')
            })
            expect(f.blur.synchronizePresentationBlur(f.window, 'test-rebuild')).toBe(true)
            expect(f.blur.initialized).toBe(true)
            expect(native.initialize).toHaveBeenCalledTimes(2)
          }
        }
        const logged =
          path === 'presentation-rebuild'
            ? f.ports.logger.error.mock.calls.find(
                ([scope]) => scope === 'presentation-mode.blur-rebuild-destroy'
              )
            : consoleError.mock.calls.find(([, error]) => error?.code === 'CONTROLLED_DESTROY')
        expect(logged?.[1]).toMatchObject({
          message: 'Destroy failed',
          code: 'CONTROLLED_DESTROY',
          phase: 'native-destroy',
          nativeShutdown: shutdown.nativeShutdown,
          shutdownResult: shutdown
        })
        expect(persistence.setSettingsBatch).toHaveBeenCalledTimes(
          path === 'runtime-failure' ? 1 : 0
        )
      } finally {
        consoleError.mockRestore()
      }
    }
  )

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

  it.each(['false', 'throw'])(
    'treats an explicit native %s as failure and keeps disabled compensation with its owner',
    (failureMode) => {
      const f = fixture()
      f.blur.initializeBlurRuntime()
      acceptSafetyDisable(f)
      const operation = () => {
        if (failureMode === 'throw') throw new Error('native rejected')
        return false
      }
      expect(f.blur.runBlurRuntimeOperation(operation, 'test operation')).toBe(false)
      expect(f.blur.failed).toBe(true)
      expect(f.blur.initialized).toBe(false)
      expect(f.blur.config.enabled).toBe(false)
      expect(f.values.blur.enabled).toBe(false)
      expect(native.destroy).toHaveBeenCalledOnce()
      expect(persistence.setSettingsBatch).toHaveBeenCalledExactlyOnceWith('main', [
        expect.objectContaining({ key: 'blur_enabled', value: 'false' })
      ])
      expect(f.ports.refreshResolvedSettings).toHaveBeenCalledExactlyOnceWith({
        incrementRevision: true
      })
      expect(f.ports.broadcastSettingsChanged).toHaveBeenCalledOnce()
      expect(f.blur.diagnostic.status).toBe('error')
    }
  )

  it('preserves void geometry/order operations as successful requests without running compensation', () => {
    const { blur } = fixture()
    blur.initializeBlurRuntime()
    expect(blur.runBlurRuntimeOperation(() => undefined, 'void operation')).toBe(true)
    expect(blur.failed).toBe(false)
    expect(persistence.setSettingsBatch).not.toHaveBeenCalled()
    expect(native.destroy).not.toHaveBeenCalled()
  })

  it('does not turn a failed safety-disable SQL into a resolved false or application result', () => {
    const { blur, ports } = fixture()
    blur.initializeBlurRuntime()
    const sqlFailure = new Error('safety disable SQL failed')
    persistence.setSettingsBatch.mockImplementationOnce(() => {
      throw sqlFailure
    })
    native.setConfig.mockReturnValueOnce(false)
    expect(() => blur.applyResolvedBlurRuntime()).toThrow(sqlFailure)
    expect(blur.failed).toBe(true)
    expect(blur.initialized).toBe(false)
    expect(native.destroy).toHaveBeenCalledOnce()
    expect(ports.refreshResolvedSettings).not.toHaveBeenCalled()
    expect(ports.broadcastSettingsChanged).not.toHaveBeenCalled()
  })

  it.each(['false', 'throw'])(
    'fully rolls back initialization after its first configuration returns %s',
    (failureMode) => {
      const { blur, window } = fixture()
      native.setConfig.mockImplementationOnce(() => {
        if (failureMode === 'throw') throw new Error('first config rejected')
        return false
      })
      expect(blur.initializeBlurRuntime()).toMatchObject({ success: false })
      expect(native.destroy).toHaveBeenCalledOnce()
      expect(blur.initialized).toBe(false)
      expect(blur.failed).toBe(true)
      expect(window.listenerCount('move')).toBe(0)
      expect(window.listenerCount('resize')).toBe(0)
      expect(persistence.setSettingsBatch).not.toHaveBeenCalled()
      expect(blur.initializeBlurRuntime()).toMatchObject({ success: true })
      expect(native.initialize).toHaveBeenCalledTimes(2)
      expect(blur.initialized).toBe(true)
      expect(window.listenerCount('move')).toBe(1)
    }
  )

  it('defers an enabled uninitialized target and does not infer application from missing acknowledgement', () => {
    const { blur } = fixture()
    expect(blur.applyResolvedBlurRuntime()).toMatchObject({ status: 'deferred', retryable: true })
    expect(native.initialize).not.toHaveBeenCalled()
    expect(native.setConfig).not.toHaveBeenCalled()
    blur.initializeBlurRuntime()
    native.setConfig.mockReturnValueOnce(undefined)
    expect(blur.applyResolvedBlurRuntime()).toMatchObject({
      status: 'unconfirmed',
      retryable: true
    })
    expect(persistence.setSettingsBatch).not.toHaveBeenCalled()
  })

  it('retries the current saved disabled target without starting the engine or clearing diagnostic facts', () => {
    const { blur, values } = fixture()
    blur.restoreFailure({
      failed: true,
      error: 'prior failure',
      nativeError: { code: 7 },
      diagnostic: { status: 'error' }
    })
    values.blur.enabled = false
    expect(blur.retryResolvedBlurRuntime()).toEqual({
      status: 'applied',
      error: 'prior failure',
      retryable: false
    })
    expect(blur.config.enabled).toBe(false)
    expect(blur.failed).toBe(true)
    expect(blur.nativeError).toEqual({ code: 7 })
    expect(blur.diagnostic.status).toBe('error')
    expect(native.initialize).not.toHaveBeenCalled()
    expect(native.setConfig).not.toHaveBeenCalled()
    expect(persistence.setSettingsBatch).not.toHaveBeenCalled()
  })

  it('uses current saved fields for an enabled retry and does not repeat the original SQL', () => {
    const { blur, values } = fixture()
    blur.setRequestedConfig({ enabled: false, radius: 3 })
    Object.assign(values.blur, { enabled: true, radius: 33, saturation: 1.8, cornerRadius: 5 })
    expect(blur.retryResolvedBlurRuntime()).toEqual({
      status: 'applied',
      error: null,
      retryable: false
    })
    expect(native.initialize).toHaveBeenCalledOnce()
    expect(native.setConfig).toHaveBeenCalled()
    for (const [config] of native.setConfig.mock.calls) {
      expect(config).toMatchObject({ enabled: true, radius: 33, saturation: 1.8, cornerRadius: 5 })
    }
    expect(persistence.setSettingsBatch).not.toHaveBeenCalled()
  })

  it('keeps initialization retry compensation disabled and does not resurrect it on another retry', () => {
    const f = fixture()
    acceptSafetyDisable(f)
    native.initialize.mockReturnValueOnce({ success: false, error: 'init unavailable' })
    expect(f.blur.retryResolvedBlurRuntime()).toMatchObject({ status: 'failed', retryable: false })
    expect(f.values.blur.enabled).toBe(false)
    expect(f.blur.config.enabled).toBe(false)
    const failure = f.blur.error
    expect(f.blur.retryResolvedBlurRuntime()).toEqual({
      status: 'applied',
      error: failure,
      retryable: false
    })
    expect(native.initialize).toHaveBeenCalledOnce()
    expect(native.setConfig).not.toHaveBeenCalled()
    expect(persistence.setSettingsBatch).toHaveBeenCalledOnce()
  })

  it('propagates failed initialization retry compensation and defers retry without a visual window', () => {
    const f = fixture()
    native.initialize.mockReturnValueOnce({ success: false, error: 'init unavailable' })
    const sqlFailure = new Error('retry compensation SQL failed')
    persistence.setSettingsBatch.mockImplementationOnce(() => {
      throw sqlFailure
    })
    expect(() => f.blur.retryResolvedBlurRuntime()).toThrow(sqlFailure)
    const withoutWindow = fixture({ visualWindowAvailable: false })
    const initializations = native.initialize.mock.calls.length
    expect(withoutWindow.blur.retryResolvedBlurRuntime()).toEqual({
      status: 'deferred',
      error: '主窗口尚未就绪',
      retryable: true
    })
    expect(native.initialize).toHaveBeenCalledTimes(initializations)
  })

  it.each([false, true])(
    'defers an enabled retry while its visual window is hidden (initialized=%s)',
    (initialized) => {
      const { blur } = fixture({ windowVisible: false })
      if (initialized) blur.initializeBlurRuntime()
      const initializations = native.initialize.mock.calls.length
      const configurations = native.setConfig.mock.calls.length
      expect(blur.retryResolvedBlurRuntime()).toEqual({
        status: 'deferred',
        error: '主窗口当前不可见',
        retryable: true
      })
      expect(native.initialize).toHaveBeenCalledTimes(initializations)
      expect(native.setConfig).toHaveBeenCalledTimes(configurations)
      expect(persistence.setSettingsBatch).not.toHaveBeenCalled()
    }
  )

  it('still applies the current disabled target to an initialized hidden window', () => {
    const { blur, values } = fixture({ windowVisible: false })
    blur.initializeBlurRuntime()
    values.blur.enabled = false
    expect(blur.retryResolvedBlurRuntime()).toEqual({
      status: 'applied',
      error: null,
      retryable: false
    })
    expect(native.initialize).toHaveBeenCalledOnce()
    expect(native.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
    expect(persistence.setSettingsBatch).not.toHaveBeenCalled()
  })

  it('keeps window z-order success independent from a failed blur synchronization and preserves it through no-op reassert', () => {
    const f = fixture()
    f.blur.initializeBlurRuntime()
    acceptSafetyDisable(f)
    native.reSyncZOrder.mockImplementationOnce(() => {
      throw new Error('blur order rejected')
    })
    const result = f.zOrder.applyWindowZOrder('normal')
    expect(result).toMatchObject({
      success: true,
      code: 1,
      mode: 'normal',
      blurSynchronization: { status: 'failed' }
    })
    expect(f.zOrder.snapshot().blurSynchronization).toEqual(result.blurSynchronization)
    expect(f.zOrder.reassertBottomWindowZOrder('not-bottom')).toBe(true)
    expect(f.zOrder.snapshot().blurSynchronization).toEqual(result.blurSynchronization)
    expect(f.zOrder.applyWindowZOrder('normal').blurSynchronization).toEqual(
      result.blurSynchronization
    )
    expect(native.reSyncZOrder).toHaveBeenCalledOnce()
  })

  it('records a queued void blur synchronization as unconfirmed without implicit health polling', () => {
    const { blur, zOrder, values } = fixture()
    blur.initializeBlurRuntime()
    expect(zOrder.applyWindowZOrder('normal')).toMatchObject({
      success: true,
      blurSynchronization: { status: 'unconfirmed' }
    })
    values.window.zOrderMode = 'bottom'
    zOrder.syncResolved()
    expect(zOrder.reassertBottomWindowZOrder('test')).toBe(true)
    expect(zOrder.snapshot().blurSynchronization.status).toBe('unconfirmed')
    expect(native.reSyncZOrder).toHaveBeenCalledTimes(2)
    expect(native.getRuntimeHealth).not.toHaveBeenCalled()
  })

  it('does not attempt blur synchronization when the actual window layer application fails', () => {
    const { blur, zOrder } = fixture()
    blur.initializeBlurRuntime()
    native.setWindowAlwaysOnBottom.mockReturnValueOnce({
      success: false,
      code: -5,
      error: 'window layer rejected'
    })
    expect(zOrder.applyWindowZOrder('normal')).toMatchObject({
      success: false,
      code: -5,
      error: 'window layer rejected',
      blurSynchronization: { status: 'deferred' }
    })
    expect(native.reSyncZOrder).not.toHaveBeenCalled()
    expect(blur.failed).toBe(false)
    expect(persistence.setSettingsBatch).not.toHaveBeenCalled()
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
    // Immediate apply rejection now captures its scene, before the existing rollback.
    expect(diagnostics.captureWindowLayerDiagnostic).toHaveBeenCalledOnce()
  })

  it('keeps committed z-order and returns its saved receipt when post-commit resolution fails', async () => {
    const receipt = {
      kind: 'settings-saved',
      source: { token: 'document', scope: 'main' },
      persistence: { status: 'saved', commitId: 'layer-1' },
      snapshot: null,
      application: { status: 'failed' }
    }
    const completion = vi.fn(async () => receipt)
    const { zOrder, values } = fixture({ applicationCompletion: completion })
    persistence.writeApplicationSetting.mockImplementation((_id, value) => {
      values.window.zOrderMode = value
    })
    const result = await zOrder.persistWindowZOrderMode('top')
    expect(result).toMatchObject({ mode: 'top', changed: true, snapshot: receipt })
    expect(values.window.zOrderMode).toBe('top')
    expect(zOrder.mode).toBe('top')
    expect(zOrder.snapshot().pendingMode).toBeNull()
    expect(persistence.writeApplicationSetting).toHaveBeenCalledExactlyOnceWith(
      'window.zOrderMode',
      'top'
    )
    expect(native.setWindowAlwaysOnBottom).toHaveBeenCalledOnce()
  })

  it('rejects a replaced document after native confirmation without saving into its successor', async () => {
    const { zOrder } = fixture()
    let current = true
    const changing = zOrder.persistWindowZOrderMode('top', {
      context: { scope: 'main', source: { token: 'old-document', scope: 'main' } },
      isCurrent: () => current
    })
    current = false
    await expect(changing).rejects.toMatchObject({ code: 'SETTINGS_SOURCE_EXPIRED' })
    expect(persistence.writeApplicationSetting).not.toHaveBeenCalled()
    expect(native.setWindowAlwaysOnBottom).toHaveBeenCalledOnce()
    expect(zOrder.snapshot().pendingMode).toBeNull()
  })

  it('does not compensate committed SQL or native state when legacy post-commit delivery throws', async () => {
    const { zOrder, values, ports } = fixture()
    persistence.writeApplicationSetting.mockImplementation((_id, value) => {
      values.window.zOrderMode = value
    })
    ports.broadcastSettingsChanged.mockImplementation(() => {
      throw Error('delivery unavailable')
    })
    await expect(zOrder.persistWindowZOrderMode('top')).rejects.toThrow('delivery unavailable')
    expect(values.window.zOrderMode).toBe('top')
    expect(zOrder.mode).toBe('top')
    expect(zOrder.snapshot().pendingMode).toBeNull()
    expect(persistence.writeApplicationSetting).toHaveBeenCalledOnce()
    expect(native.setWindowAlwaysOnBottom).toHaveBeenCalledOnce()
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
