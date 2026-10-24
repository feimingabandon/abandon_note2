import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeDiagnosticValue } from '../src/shared/diagnostic-sanitize.js'
import { encodeLogRecord } from '../src/main/logging/log-store.mjs'

const native = vi.hoisted(() => ({
  getWindowZOrderStatus: vi.fn(),
  reassertWindowZOrder: vi.fn(),
  setWindowAlwaysOnBottom: vi.fn(),
  reSyncZOrder: vi.fn(),
  getRuntimeHealth: vi.fn()
}))
const observation = vi.hoisted(() => ({
  checkpoint: vi.fn(),
  captureWindowLayerDiagnostic: vi.fn()
}))
const writeApplicationSetting = vi.hoisted(() => vi.fn())
vi.mock('../src/main/bridge/blur_bridge.js', () => native)
vi.mock('../src/main/bridge/window-layer-diagnostics.js', () => ({
  captureWindowLayerDiagnostic: observation.captureWindowLayerDiagnostic
}))
vi.mock('../src/main/logging/operation-context.js', () => ({ checkpoint: observation.checkpoint }))
vi.mock('../src/main/settings/application-settings.js', () => ({ writeApplicationSetting }))
import { createZOrderRuntime } from '../src/main/windows/z-order-runtime.js'

function failure(sequence, stage = 'anchor-main-set-window-pos', win32Error = 1400) {
  const window = (index) => ({
    hwnd: '0x' + index.toString(16),
    kind: 'window',
    valid: true,
    className: 'ExampleWindow',
    processId: 1234,
    threadId: 5678,
    visible: true,
    topmost: false,
    owner: '0x0'
  })
  return {
    sequence,
    tickMs: 5000 + sequence,
    operation: 'set-bottom',
    stage,
    resultCode: -5,
    win32Error,
    win32ErrorSource: win32Error === null ? 'not-applicable' : 'GetLastError',
    currentThreadId: 5678,
    ownerThreadId: 5678,
    controllerEnabled: true,
    applying: true,
    mainMoveAttempted: true,
    mainMoved: false,
    overlayMoveAttempted: false,
    overlayMoved: null,
    windows: Object.fromEntries(
      ['requested', 'target', 'overlay', 'desktop', 'insertionAfter'].map((name, index) => [
        name,
        window(index + 1)
      ])
    )
  }
}

function fixture() {
  let topmost = false
  const window = {
    isDestroyed: () => false,
    isAlwaysOnTop: () => topmost,
    setAlwaysOnTop: (value) => (topmost = value)
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const runtime = createZOrderRuntime({
    getMainWindow: () => window,
    getActiveVisualWindow: () => window,
    getApplicationWindows: () => [window],
    getSettings: () => ({ window: { zOrderMode: 'normal' } }),
    readBlurState: () => ({ initialized: false, config: { enabled: false } }),
    readDockState: () => ({ isSliding: false, isDockHidden: false }),
    isWindowLocked: () => false,
    runBlurRuntimeOperation: vi.fn(),
    refreshResolvedSettings: vi.fn(),
    getResolvedSettingsSnapshot: vi.fn(),
    broadcastSettingsChanged: vi.fn(),
    sendAppMessage: vi.fn(),
    logger
  })
  runtime.syncResolved()
  return { runtime, logger }
}

beforeEach(() => {
  vi.resetAllMocks()
  native.setWindowAlwaysOnBottom.mockReturnValue({ success: true, code: 1 })
  native.getWindowZOrderStatus.mockReturnValue({ enabled: false, scene: 'initial' })
  observation.captureWindowLayerDiagnostic.mockReturnValue({ classification: 'test-observation' })
})

describe('native z-order failure evidence', () => {
  it('captures an immediate startup apply failure without requiring confirmation or an IPC caller', () => {
    const { runtime } = fixture()
    const nativeFailure = failure(1)
    native.setWindowAlwaysOnBottom.mockReturnValueOnce({
      success: false,
      code: -5,
      error: 'original failure',
      nativeFailure
    })
    const result = runtime.applyWindowZOrder('bottom')
    expect(result).toMatchObject({ success: false, code: -5, nativeFailure })
    const [, metadata, options] = observation.checkpoint.mock.calls[0]
    expect(metadata).toMatchObject({
      diagnosticId: result.diagnosticId,
      mode: 'bottom',
      nativeCode: -5,
      nativeFailure,
      nativeZOrder: { enabled: false }
    })
    expect(options).toMatchObject({ kind: 'event', level: 'warn', stage: 'enable-bottom' })
    expect(options.detail).toBeUndefined()
    expect(observation.captureWindowLayerDiagnostic).toHaveBeenCalledOnce()
    expect(writeApplicationSetting).not.toHaveBeenCalled()
  })

  it('keeps the original failure and records distinct scenes before and after a failed rollback', async () => {
    const { runtime } = fixture()
    let scene = 'initial'
    native.getWindowZOrderStatus.mockImplementation(() => ({ scene, enabled: false }))
    native.setWindowAlwaysOnBottom
      .mockImplementationOnce(() => {
        scene = 'first-failure-reset'
        return { success: false, code: -5, error: 'first failure', nativeFailure: failure(1) }
      })
      .mockImplementationOnce(() => {
        scene = 'rollback-failed'
        return {
          success: false,
          code: -5,
          error: 'rollback failure',
          nativeFailure: failure(2, 'disable-overlay-set-window-pos', 5)
        }
      })
    const error = await runtime.persistWindowZOrderMode('bottom').catch((value) => value)
    expect(error).toMatchObject({
      message: 'first failure',
      code: 'WINDOW_Z_ORDER_APPLY_FAILED',
      nativeCode: -5,
      nativeFailure: { sequence: 1, win32Error: 1400 }
    })
    const failures = observation.checkpoint.mock.calls.filter(
      ([event]) => event === 'window.z-order.failure'
    )
    expect(failures).toHaveLength(2)
    expect(failures.map(([, metadata]) => metadata.nativeFailure.sequence)).toEqual([1, 2])
    expect(failures[0][1].diagnosticId).toBe(error.diagnosticId)
    expect(failures[1][1].diagnosticId).not.toBe(error.diagnosticId)
    const rollback = observation.checkpoint.mock.calls.filter(
      ([event]) => event === 'window.z-order.rollback'
    )
    expect(
      rollback.map(([, metadata, options]) => [options.stage, metadata.nativeZOrder.scene])
    ).toEqual([
      ['before-rollback', 'first-failure-reset'],
      ['after-rollback', 'rollback-failed']
    ])
    expect(rollback[1][1]).toMatchObject({
      diagnosticId: error.diagnosticId,
      rollbackDiagnosticId: failures[1][1].diagnosticId,
      success: false
    })
    expect(writeApplicationSetting).not.toHaveBeenCalled()
  })

  it('preserves the native code when a reapply fails during confirmation', async () => {
    const { runtime } = fixture()
    native.getWindowZOrderStatus.mockReturnValue({
      enabled: true,
      requestedMatches: true,
      anchored: false
    })
    native.setWindowAlwaysOnBottom
      .mockReturnValueOnce({ success: true, code: 1 })
      .mockReturnValueOnce({
        success: false,
        code: -5,
        error: 'reapply failure',
        nativeFailure: failure(4)
      })
    await expect(runtime.persistWindowZOrderMode('bottom')).rejects.toMatchObject({
      message: 'reapply failure',
      code: 'WINDOW_Z_ORDER_APPLY_FAILED',
      nativeCode: -5,
      nativeFailure: { sequence: 4, win32Error: 1400 }
    })
    expect(writeApplicationSetting).not.toHaveBeenCalled()
    expect(native.setWindowAlwaysOnBottom).toHaveBeenCalledTimes(3)
  })

  it('records an earlier native first failure separately from the current failure', () => {
    const { runtime } = fixture()
    const nativeFirstFailure = failure(1, 'foreground-hook-install', 5)
    native.setWindowAlwaysOnBottom.mockReturnValue({
      success: false,
      code: -5,
      error: 'latest failure',
      nativeFirstFailure,
      nativeFailure: failure(2),
      nativeFailureCount: 2
    })
    runtime.applyWindowZOrder('bottom')
    runtime.applyWindowZOrder('bottom')
    const first = observation.checkpoint.mock.calls.filter(
      ([event]) => event === 'window.z-order.first-native-failure'
    )
    const latest = observation.checkpoint.mock.calls.filter(
      ([event]) => event === 'window.z-order.failure'
    )
    expect(first).toHaveLength(1)
    expect(first[0][1].nativeFailure).toEqual(nativeFirstFailure)
    expect(latest).toHaveLength(2)
    expect(latest[0][1]).toMatchObject({ nativeFailureCount: 2, nativeFailure: { sequence: 2 } })
  })

  it('leaves the original result and rollback intact when diagnostic reads fail', async () => {
    const { runtime } = fixture()
    native.setWindowAlwaysOnBottom.mockReturnValueOnce({
      success: false,
      code: -5,
      error: 'native failure'
    })
    observation.checkpoint.mockImplementation(() => {
      throw new Error('diagnostic failure')
    })
    await expect(runtime.persistWindowZOrderMode('bottom')).rejects.toMatchObject({
      message: 'native failure',
      nativeCode: -5
    })
    expect(native.setWindowAlwaysOnBottom).toHaveBeenCalledTimes(2)
    expect(runtime.mode).toBe('normal')
  })

  it('keeps all five window observations within the existing daily warning record budget', () => {
    const nativeFailure = failure(10, 'desktop-not-found', null)
    for (const window of Object.values(nativeFailure.windows)) {
      Object.assign(window, {
        hwnd: '0x1234567890abcdef',
        owner: '0x1234567890abcdef',
        className: '窗'.repeat(63),
        classNameTruncated: true,
        processId: 4294967295,
        threadId: 4294967295
      })
    }
    const nativeZOrder = {
      supported: true,
      enabled: false,
      targetValid: false,
      requestedMatches: false,
      anchored: false,
      ordinaryWindowsBelow: 0,
      desktopBehind: false,
      desktopWindowsAbove: 0,
      desktopWindowsBelow: 0,
      overlayValid: true,
      overlayBehind: false,
      lastApplySucceeded: false,
      ownerThreadId: 4294967295,
      syncPending: false,
      syncRequestCount: 1234567890,
      syncPostCount: 1234567890,
      anchorCheckCount: 1234567890,
      anchorNoopCount: 1234567890,
      anchorApplyCount: 1234567890,
      lastSyncReason: 'window-pos-changed',
      lastAnchorApplyTickMs: 1234567890
    }
    const metadata = sanitizeDiagnosticValue(
      {
        diagnosticId: '11111111-2222-3333-4444-555555555555',
        mode: 'bottom',
        nativeCode: -5,
        nativeFailure,
        nativeZOrder,
        isSliding: false,
        isDockHidden: false
      },
      { maxBytes: 8192, maxDepth: 6, maxNodes: 256 }
    )
    const encoded = encodeLogRecord({
      level: 'warn',
      kind: 'event',
      scope: 'window.z-order-failure',
      metadata
    })
    const record = JSON.parse(encoded)
    expect(record.metadata.nativeFailure.windows).toEqual(nativeFailure.windows)
    expect(record.metadata.nativeZOrder).toEqual(nativeZOrder)
    expect(record.metadata.nativeFailure.win32Error).toBeNull()
    expect(record.metadata.truncated).toBeUndefined()
  })
})
