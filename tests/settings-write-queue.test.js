import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, watch } from 'vue'
import { useSettingsWriteQueue } from '../src/renderer/src/composables/useSettingsWriteQueue.js'
import { getSettingsSnapshotStore } from '../src/renderer/src/utils/settingsSnapshots.js'

function documentSnapshot(values, revision = 0, runtime) {
  return {
    source: { token: 'queue-document', scope: 'main' },
    revision,
    values,
    ...(runtime === undefined ? {} : { runtime })
  }
}

function savedReceipt(overrides = {}) {
  return {
    kind: 'settings-saved',
    source: { token: 'queue-document', scope: 'main' },
    persistence: { status: 'saved', commitId: 'queue-commit' },
    application: { status: 'failed' },
    snapshot: null,
    snapshotError: { message: '当前快照暂不可用' },
    ...overrides
  }
}

function retirementFailure(snapshot, overrides = {}) {
  return {
    success: false,
    source: { token: 'queue-document', scope: 'main' },
    persistence: { status: 'unchanged', commitId: null },
    snapshot,
    config: snapshot?.values?.blur,
    runtime: snapshot?.runtime?.blur,
    retirement: { id: 'retirement-1', status: 'failed', reason: 'timeout' },
    backgroundEffects: { suspension: savedReceipt(), compensation: { status: 'skipped' } },
    error: '壁纸退场未确认，未应用本次毛玻璃设置',
    nativeError: null,
    ...overrides
  }
}

function applicationEnvelope(ledgerRevision, status = null) {
  return {
    source: { token: 'queue-document', scope: 'main' },
    ledgerRevision,
    ledger: {
      scope: 'main',
      commitId: status ? 'queue-commit' : null,
      current: status
        ? {
            attempt: ledgerRevision,
            reason: 'commit',
            phase: 'settled',
            targets: { domains: [], dependencies: ['theme'] },
            resolve: { status: 'applied', error: null },
            snapshot: { status: 'available', error: null },
            verification: { status: 'skipped', error: null },
            delivery: { status: 'completed', error: null },
            superseded: false
          }
        : null,
      domains: {},
      dependencies: status
        ? { theme: { status, error: null, retryable: status !== 'applied' } }
        : {},
      errors: []
    }
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
async function settle() {
  for (let index = 0; index < 8; index += 1) await nextTick()
}
const dockConfig = (enabledEdges, revealHandleMode = 'direct') => ({
  enabledEdges,
  revealHandleMode
})
const queues = []
function fixture(sharedApi) {
  const blur = {
    enabled: ref(false),
    radius: ref(8),
    saturation: ref(1.4),
    cornerRadius: ref(12),
    error: ref(null)
  }
  const autoStart = { enabled: ref(false), error: ref(null) }
  let receiveBroadcast = null
  let receiveApplicationBroadcast = null
  const stopTransport = vi.fn()
  const stopApplicationTransport = vi.fn()
  const api = sharedApi || {
    onSettingsApplicationChanged: vi.fn((receive) => {
      receiveApplicationBroadcast = receive
      return stopApplicationTransport
    }),
    getSettingsApplicationState: vi.fn(async () => applicationEnvelope(0)),
    retrySettingsApplication: vi.fn(async () => ({
      source: { token: 'queue-document', scope: 'main' },
      persistence: { status: 'unchanged', commitId: 'queue-commit' },
      snapshot: null,
      applicationState: applicationEnvelope(2, 'unconfirmed')
    })),
    onSettingsChanged: vi.fn((receive) => {
      receiveBroadcast = receive
      return stopTransport
    }),
    getSettingsSnapshot: vi.fn(async () => documentSnapshot({ marker: 'initial' })),
    setSettingValue: vi.fn(async () => savedReceipt()),
    setBlurConfig: vi.fn(async (config) => ({
      success: true,
      config,
      runtime: { error: null },
      snapshot: documentSnapshot({ blur: config }, 1)
    })),
    setAutoStart: vi.fn(async (value) => value),
    verifyAutoStart: vi.fn(async () => ({ value: false })),
    setDockConfig: vi.fn(async (config) =>
      documentSnapshot({ dock: { revealHandleMode: 'direct', ...config } }, 1)
    ),
    resetSettings: vi.fn(async () => documentSnapshot({ marker: 'reset' }, 1))
  }
  const snapshot = { assign: vi.fn(), fallback: vi.fn(() => ({ values: { marker: 'fallback' } })) }
  const dock = { assign: vi.fn() }
  const showMessage = vi.fn(),
    warn = vi.fn()
  const queue = useSettingsWriteQueue({ api, blur, autoStart, dock, snapshot, showMessage, warn })
  queues.push(queue)
  return {
    queue,
    api,
    blur,
    autoStart,
    dock,
    snapshot,
    showMessage,
    warn,
    snapshots: getSettingsSnapshotStore(api),
    broadcast: (value) => receiveBroadcast(value),
    broadcastApplication: (value) => receiveApplicationBroadcast(value),
    stopApplicationTransport,
    stopTransport
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await Promise.allSettled(queues.splice(0).map((queue) => queue.dispose()))
  vi.useRealTimers()
})

describe('settings write lifecycle', () => {
  it('exposes queued and saved-but-unconfirmed values without changing the saved shadow', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.queue.debouncedSave('css.fontSizeBase', 22)
    expect(f.queue.hasPendingWrites.value).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    await f.queue.waitForInFlightWrites()
    expect(f.queue.hasPendingWrites.value).toBe(false)
    expect(f.queue.awaitingCanonical.value).toBe(true)
    expect(f.snapshots.latest().values.css.fontSizeBase).toBe(22)
  })

  it('retries only application metadata after a saved failure without replaying SQL or confirming values', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockResolvedValueOnce(
      savedReceipt({
        applicationState: applicationEnvelope(1, 'failed')
      })
    )
    await f.queue.persistSetting({ id: 'css.fontSizeBase', value: 22 })
    expect(f.queue.applicationState.value.ledger.dependencies.theme.status).toBe('failed')
    const before = f.snapshots.latest()
    await f.queue.retrySettingsApplication({ domains: [], dependencies: ['theme'] })
    expect(f.api.retrySettingsApplication).toHaveBeenCalledExactlyOnceWith({
      domains: [],
      dependencies: ['theme']
    })
    expect(f.queue.applicationState.value.ledger.dependencies.theme.status).toBe('unconfirmed')
    expect(f.queue.failedSettings.value).toEqual([])
    expect(f.queue.awaitingCanonical.value).toBe(true)
    expect(f.snapshots.latest()).toEqual(before)
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('css.fontSizeBase', 22)
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledOnce()
  })

  it('waits for an admitted application retry during leave and seals further retry input', async () => {
    const f = fixture(),
      applying = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.retrySettingsApplication.mockReturnValueOnce(applying.promise)
    const retry = f.queue.retrySettingsApplication({ domains: [], dependencies: ['theme'] })
    let left = false
    const leaving = f.queue.prepareToLeave('application-retry').then((result) => {
      left = true
      return result
    })
    await settle()
    expect(left).toBe(false)
    await f.queue.retrySettingsApplication({ domains: ['blur'], dependencies: [] })
    expect(f.api.retrySettingsApplication).toHaveBeenCalledOnce()
    applying.resolve({
      source: { token: 'queue-document', scope: 'main' },
      persistence: { status: 'unchanged', commitId: 'queue-commit' },
      snapshot: null,
      applicationState: applicationEnvelope(2, 'failed')
    })
    await retry
    await expect(leaving).resolves.toEqual({ ready: true })
    expect(f.queue.applicationBusy.value).toBe(false)
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
    f.queue.resumeAfterLeave('application-retry')
    expect(f.queue.canWrite()).toBe(true)
  })

  it('does not turn an application retry transport failure into an unsaved leave blocker', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.retrySettingsApplication.mockRejectedValueOnce(new Error('application IPC failed'))
    await expect(
      f.queue.retrySettingsApplication({ domains: [], dependencies: ['theme'] })
    ).rejects.toThrow('application IPC failed')
    expect(f.queue.applicationAvailability.value).toBe('unavailable')
    expect(f.queue.failedSettings.value).toEqual([])
    await expect(f.queue.prepareToLeave('retry-transport-failed')).resolves.toEqual({ ready: true })
  })

  it('leaves application state failures independent of canonical setting availability', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    await settle()
    f.api.getSettingsApplicationState.mockRejectedValueOnce(new Error('ledger not available'))
    const before = f.snapshots.latest()
    await expect(f.queue.refreshSettingsApplicationState()).rejects.toThrow('ledger not available')
    expect(f.snapshots.latest()).toEqual(before)
    expect(f.queue.snapshotUnavailable.value).toBe(false)
    expect(f.queue.canWrite()).toBe(true)
  })

  it('waits for retry before reset but rejects its invalidated response from the panel', async () => {
    const f = fixture(),
      applying = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.retrySettingsApplication.mockReturnValueOnce(applying.promise)
    const retry = f.queue.retrySettingsApplication({ domains: [], dependencies: ['theme'] })
    f.api.resetSettings.mockResolvedValueOnce(
      savedReceipt({
        applicationState: applicationEnvelope(3, 'failed')
      })
    )
    const resetting = f.queue.resetSettings()
    await settle()
    expect(f.api.resetSettings).not.toHaveBeenCalled()
    applying.resolve({ applicationState: applicationEnvelope(99, 'applied') })
    await retry
    await resetting
    expect(f.queue.applicationState.value.ledgerRevision).toBe(3)
    expect(f.queue.snapshotUnavailable.value).toBe(true)
    expect(f.snapshots.status().resetPending).toBe(true)
    expect(f.api.resetSettings).toHaveBeenCalledOnce()
  })

  it('permits an independent application retry while saved reset values remain quarantined', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.resetSettings.mockResolvedValueOnce(
      savedReceipt({
        applicationState: applicationEnvelope(1, 'failed')
      })
    )
    await f.queue.resetSettings()
    expect(f.queue.canWrite()).toBe(false)
    const before = f.snapshots.status()
    await f.queue.retrySettingsApplication({ domains: [], dependencies: ['theme'] })
    expect(f.api.retrySettingsApplication).toHaveBeenCalledExactlyOnceWith({
      domains: [],
      dependencies: ['theme']
    })
    expect(f.snapshots.latest()).toBeNull()
    expect(f.snapshots.status()).toEqual(before)
    expect(f.queue.awaitingCanonical.value).toBe(true)
  })

  it('releases application listeners on disposal and ignores a late retry result', async () => {
    const f = fixture(),
      applying = deferred()
    await f.queue.loadSettingsSnapshot()
    await settle()
    f.broadcastApplication(applicationEnvelope(2, 'failed'))
    f.api.retrySettingsApplication.mockReturnValueOnce(applying.promise)
    const retry = f.queue.retrySettingsApplication({ domains: [], dependencies: ['theme'] })
    const disposed = f.queue.dispose()
    expect(f.stopApplicationTransport).toHaveBeenCalledOnce()
    applying.resolve({ applicationState: applicationEnvelope(99, 'applied') })
    await retry
    await disposed
    expect(f.queue.applicationState.value.ledgerRevision).toBe(2)
  })

  it('settles saved-without-canonical application failure without retrying SQL or blocking leave', async () => {
    const f = fixture()
    f.api.getSettingsSnapshot.mockResolvedValueOnce(documentSnapshot({ css: { fontSizeBase: 17 } }))
    await f.queue.loadSettingsSnapshot()
    await f.queue.persistSetting({ id: 'css.fontSizeBase', value: 22 })
    expect(f.queue.failedSettings.value).toEqual([])
    expect(f.snapshots.latest().values.css.fontSizeBase).toBe(22)
    expect(f.snapshots.status()).toMatchObject({
      awaitingCanonical: true,
      savedCount: 1,
      availability: 'available'
    })
    await f.queue.retryFailedSettingSaves()
    await expect(f.queue.prepareToLeave('saved-awaiting-canonical')).resolves.toEqual({
      ready: true
    })
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('css.fontSizeBase', 22)
    expect(f.showMessage).not.toHaveBeenCalled()
  })

  it('settles replaced A beneath failed B and retains A after the failed owner unmounts', async () => {
    const f = fixture(),
      writing = deferred()
    f.api.getSettingsSnapshot.mockResolvedValueOnce(documentSnapshot({ css: { fontSizeBase: 17 } }))
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue
      .mockReturnValueOnce(writing.promise)
      .mockRejectedValueOnce(new Error('B not saved'))
    const first = f.queue.persistSetting({ id: 'css.fontSizeBase', value: 18 })
    const second = f.queue.persistSetting({ id: 'css.fontSizeBase', value: 22 })
    const failed = expect(second).rejects.toThrow('B not saved')
    writing.resolve(savedReceipt())
    await first
    await failed
    expect(f.snapshots.latest().values.css.fontSizeBase).toBe(22)
    expect(f.queue.failedSettings.value).toEqual([{ id: 'css.fontSizeBase', error: 'B not saved' }])
    await expect(f.queue.flush()).rejects.toThrow('B not saved')
    await Promise.allSettled([f.queue.dispose()])
    expect(f.snapshots.latest().values.css.fontSizeBase).toBe(18)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(2)
  })

  it('keeps an explicit saved reset unavailable instead of publishing the old base as defaults', async () => {
    const f = fixture()
    f.api.getSettingsSnapshot.mockResolvedValueOnce(documentSnapshot({ css: { fontSizeBase: 25 } }))
    await f.queue.loadSettingsSnapshot()
    f.snapshot.assign.mockClear()
    f.api.resetSettings.mockResolvedValueOnce(savedReceipt())
    await f.queue.resetSettings()
    expect(f.snapshots.latest()).toBeNull()
    expect(f.queue.snapshotUnavailable.value).toBe(true)
    expect(f.queue.canWrite()).toBe(false)
    expect(f.snapshot.assign).not.toHaveBeenCalled()
    expect(f.showMessage).toHaveBeenCalledWith('warning', '默认设置已保存，当前值尚待确认', 4000)
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('current read unavailable'))
    await f.queue.loadSettingsSnapshot()
    expect(f.snapshot.fallback).not.toHaveBeenCalled()
    expect(f.queue.snapshotUnavailable.value).toBe(true)
    f.api.getSettingsSnapshot.mockResolvedValueOnce(
      documentSnapshot({ css: { fontSizeBase: 14 } }, 2)
    )
    await f.queue.loadSettingsSnapshot()
    expect(f.queue.snapshotUnavailable.value).toBe(false)
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(
      documentSnapshot({ css: { fontSizeBase: 14 } }, 2)
    )
    expect(f.api.resetSettings).toHaveBeenCalledOnce()
  })

  it('keeps confirmed native rollback refs when its saved receipt has no canonical values', async () => {
    const f = fixture()
    const requested = { enabled: true, radius: 24, saturation: 1.8, cornerRadius: 18 }
    const actual = { enabled: false, radius: 8, saturation: 1.4, cornerRadius: 12 }
    f.api.getSettingsSnapshot.mockResolvedValueOnce(documentSnapshot({ blur: actual }))
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockResolvedValueOnce({
      success: false,
      config: actual,
      runtime: { effectiveEnabled: false, error: 'native disabled' },
      snapshot: savedReceipt()
    })
    for (const [key, value] of Object.entries(requested)) f.blur[key].value = value
    await settle()
    await f.queue.flush()
    expect(Object.fromEntries(Object.keys(actual).map((key) => [key, f.blur[key].value]))).toEqual(
      actual
    )
    expect(f.blur.error.value).toBe('native disabled')
    expect(f.snapshots.latest().values.blur).toEqual(requested)
    expect(f.snapshots.status().awaitingCanonical).toBe(true)
    await expect(f.queue.prepareToLeave('native-saved-rollback')).resolves.toEqual({ ready: true })
    expect(f.api.setBlurConfig).toHaveBeenCalledOnce()
  })

  it('does not turn a saved dock receipt without a complete projection into an unsaved failure', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setDockConfig.mockResolvedValueOnce(savedReceipt())
    await f.queue.saveDockConfig({ enabledEdges: ['left'] })
    await expect(f.queue.prepareToLeave('dock-saved-without-canonical')).resolves.toEqual({
      ready: true
    })
    expect(f.api.setDockConfig).toHaveBeenCalledOnce()
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledOnce()
    expect(f.queue.isProtected('dock')).toBe(false)
    expect(f.showMessage).not.toHaveBeenCalled()
  })

  it('still initializes a participant mounted during leave so cancellation permits editing', async () => {
    const f = fixture(),
      initialSnapshot = deferred()
    f.api.getSettingsSnapshot.mockReturnValueOnce(initialSnapshot.promise)
    const preparing = f.queue.prepareToLeave('mounted-during-leave')
    const loading = f.queue.loadSettingsSnapshot()
    await expect(preparing).resolves.toEqual({ ready: true })
    expect(f.queue.canWrite()).toBe(false)
    f.queue.resumeAfterLeave('mounted-during-leave')
    expect(f.queue.canWrite()).toBe(false)
    initialSnapshot.resolve(documentSnapshot({ marker: 'actual' }))
    await loading
    expect(f.snapshot.assign).toHaveBeenCalledExactlyOnceWith(
      documentSnapshot({ marker: 'actual' })
    )
    await f.queue.persistSetting({ id: 'css.fontSizeBase', value: 22 })
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('css.fontSizeBase', 22)
  })

  it('captures the last post-watch value before sealing page leave and serializes the same ID', async () => {
    const f = fixture(),
      firstWrite = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockReturnValueOnce(firstWrite.promise)
    const first = f.queue.persistSetting({ id: 'css.fontSizeBase', value: 18 })
    const fontSize = ref(18)
    const stop = watch(fontSize, (value) => f.queue.debouncedSave('css.fontSizeBase', value), {
      flush: 'post'
    })
    fontSize.value = 22
    const preparing = f.queue.prepareToLeave('leave-font')
    await settle()
    expect(f.queue.isLeaving.value).toBe(true)
    expect(f.queue.canWrite()).toBe(false)
    expect(f.api.setSettingValue.mock.calls).toEqual([['css.fontSizeBase', 18]])
    f.queue.debouncedSave('css.fontSizeBase', 99)
    await f.queue.persistSetting({ id: 'css.bgColor', value: '1 2 3' })
    await f.queue.resetSettings()
    expect(f.api.resetSettings).not.toHaveBeenCalled()
    firstWrite.resolve(savedReceipt())
    await first
    await expect(preparing).resolves.toEqual({ ready: true })
    expect(f.api.setSettingValue.mock.calls).toEqual([
      ['css.fontSizeBase', 18],
      ['css.fontSizeBase', 22]
    ])
    f.queue.resumeAfterLeave('leave-font')
    expect(f.queue.canWrite()).toBe(true)
    stop()
  })

  it('flushes the pending 150ms blur intent and waits for all native write domains', async () => {
    const f = fixture(),
      blurWrite = deferred(),
      autoWrite = deferred(),
      dockWrite = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockReturnValueOnce(blurWrite.promise)
    f.api.setAutoStart.mockReturnValueOnce(autoWrite.promise)
    f.api.setDockConfig.mockReturnValueOnce(dockWrite.promise)
    f.blur.radius.value = 24
    f.autoStart.enabled.value = true
    void f.queue.saveDockConfig({ enabledEdges: ['left'] })
    let left = false
    const preparing = f.queue.prepareToLeave('leave-domains').then((result) => {
      left = true
      return result
    })
    await settle()
    expect(f.api.setBlurConfig).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ radius: 24 })
    )
    expect(f.api.setAutoStart).toHaveBeenCalledExactlyOnceWith(true)
    expect(left).toBe(false)
    await f.queue.syncBlurConfig()
    await f.queue.saveAutoStart(false)
    await f.queue.saveDockConfig({ enabledEdges: ['right'] })
    expect(f.api.setBlurConfig).toHaveBeenCalledTimes(1)
    expect(f.api.setAutoStart).toHaveBeenCalledTimes(1)
    expect(f.api.setDockConfig).toHaveBeenCalledTimes(1)
    blurWrite.resolve({ success: true, snapshot: savedReceipt() })
    autoWrite.resolve(true)
    await settle()
    expect(left).toBe(false)
    dockWrite.resolve(documentSnapshot({ dock: dockConfig(['left']) }, 1))
    await expect(preparing).resolves.toEqual({ ready: true })
    await vi.advanceTimersByTimeAsync(200)
    expect(f.api.setBlurConfig).toHaveBeenCalledTimes(1)
  })

  it('retains failed ordinary values and reopens editing when page preparation fails', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockRejectedValueOnce(new Error('disk-full'))
    f.queue.debouncedSave('css.fontSizeBase', 22)
    await expect(f.queue.prepareToLeave('failed-leave')).rejects.toThrow('disk-full')
    expect(f.queue.isLeaving.value).toBe(false)
    expect(f.queue.canWrite()).toBe(true)
    expect(f.queue.failedSettings.value).toEqual([{ id: 'css.fontSizeBase', error: 'disk-full' }])
    await expect(f.queue.prepareToLeave('still-failed')).rejects.toThrow('disk-full')
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
    await f.queue.retryFailedSettingSaves()
    await expect(f.queue.prepareToLeave('retried-leave')).resolves.toEqual({ ready: true })
    expect(f.api.setSettingValue).toHaveBeenLastCalledWith('css.fontSizeBase', 22)
  })

  it('does not let a cancelled initial tick reopen or seal a replacement using the same ID', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    const old = f.queue.prepareToLeave('same-id')
    expect(f.queue.prepareToLeave('same-id')).toBe(old)
    const cancelled = expect(old).rejects.toMatchObject({ code: 'PAGE_LEAVE_CANCELLED' })
    f.queue.resumeAfterLeave('same-id')
    const replacement = f.queue.prepareToLeave('same-id')
    expect(replacement).not.toBe(old)
    await cancelled
    await replacement
    expect(f.queue.isLeaving.value).toBe(true)
    f.queue.resumeAfterLeave('old-id')
    expect(f.queue.isLeaving.value).toBe(true)
    f.queue.resumeAfterLeave('same-id')
    expect(f.queue.canWrite()).toBe(true)
  })

  it('keeps the replacement leave sealed when an old cancelled flush fails late', async () => {
    const f = fixture(),
      oldWrite = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockReturnValueOnce(oldWrite.promise)
    f.queue.debouncedSave('css.fontSizeBase', 18)
    const old = f.queue.prepareToLeave('old-leave')
    const oldFailure = expect(old).rejects.toMatchObject({ code: 'PAGE_LEAVE_CANCELLED' })
    await settle()
    f.queue.resumeAfterLeave('old-leave')
    f.queue.debouncedSave('css.fontSizeBase', 22)
    const replacement = f.queue.prepareToLeave('new-leave')
    await settle()
    oldWrite.reject(new Error('old write failed'))
    await oldFailure
    await expect(replacement).resolves.toEqual({ ready: true })
    expect(f.queue.failedSettings.value).toEqual([])
    expect(f.queue.isLeaving.value).toBe(true)
    expect(f.api.setSettingValue.mock.calls).toEqual([
      ['css.fontSizeBase', 18],
      ['css.fontSizeBase', 22]
    ])
  })

  it('blocks page leave after an unconfirmed blur failure until a later successful write', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockRejectedValueOnce(new Error('blur IPC failed'))
    f.blur.radius.value = 24
    await expect(f.queue.prepareToLeave('blur-failure')).rejects.toThrow('blur IPC failed')
    expect(f.queue.canWrite('blur')).toBe(true)
    await expect(f.queue.prepareToLeave('blur-still-unknown')).rejects.toThrow('blur IPC failed')
    expect(f.api.setBlurConfig).toHaveBeenCalledTimes(1)
    await f.queue.syncBlurConfig()
    await expect(f.queue.prepareToLeave('blur-retried')).resolves.toEqual({ ready: true })
  })

  it('allows leave after a confirmed native blur rollback while retaining its error feedback', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockResolvedValueOnce({
      success: false,
      config: { enabled: false, radius: 8, saturation: 1.4, cornerRadius: 12 },
      runtime: { effectiveEnabled: false, error: 'DLL unavailable' }
    })
    f.blur.enabled.value = true
    f.blur.radius.value = 24
    f.blur.saturation.value = 1.8
    f.blur.cornerRadius.value = 18
    await expect(f.queue.prepareToLeave('blur-rolled-back')).resolves.toEqual({ ready: true })
    expect(f.blur.enabled.value).toBe(false)
    expect(f.blur.radius.value).toBe(8)
    expect(f.blur.saturation.value).toBe(1.4)
    expect(f.blur.cornerRadius.value).toBe(12)
    expect(f.blur.error.value).toBe('DLL unavailable')
    expect(f.showMessage).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('DLL unavailable'),
      5000
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(f.api.setBlurConfig).toHaveBeenCalledTimes(1)
  })

  it('does not mistake an incomplete blur error response for a confirmed rollback', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockResolvedValueOnce({ success: false, config: { enabled: false } })
    f.blur.enabled.value = true
    await expect(f.queue.prepareToLeave('blur-incomplete')).rejects.toThrow(
      '毛玻璃设置尚未确认保存'
    )
    expect(f.queue.canWrite()).toBe(true)
  })

  it.each(['autoStart', 'dock'])(
    'blocks leave when %s fails and its actual state cannot be read',
    async (domain) => {
      const f = fixture()
      await f.queue.loadSettingsSnapshot()
      if (domain === 'autoStart') {
        f.api.setAutoStart.mockRejectedValueOnce(new Error('auto write failed'))
        f.api.verifyAutoStart.mockRejectedValueOnce(new Error('auto read failed'))
        f.autoStart.enabled.value = true
      } else {
        f.api.setDockConfig.mockRejectedValueOnce(new Error('dock write failed'))
        f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('dock read failed'))
        void f.queue.saveDockConfig({ enabledEdges: ['left'] })
      }
      await expect(f.queue.prepareToLeave('unknown-native')).rejects.toThrow('write failed')
      expect(f.queue.canWrite(domain)).toBe(true)
      expect(f.queue.isLeaving.value).toBe(false)
    }
  )

  it.each(['autoStart', 'dock'])(
    'allows leave after %s failure is reconciled to actual state',
    async (domain) => {
      const f = fixture()
      await f.queue.loadSettingsSnapshot()
      if (domain === 'autoStart') {
        f.api.setAutoStart.mockRejectedValueOnce(new Error('denied'))
        f.api.verifyAutoStart.mockResolvedValueOnce({ value: false, error: null })
        f.autoStart.enabled.value = true
      } else {
        f.api.setDockConfig.mockRejectedValueOnce(new Error('denied'))
        f.api.getSettingsSnapshot.mockResolvedValueOnce(
          documentSnapshot({ dock: dockConfig(['right']) })
        )
        void f.queue.saveDockConfig({ enabledEdges: ['left'] })
      }
      await expect(f.queue.prepareToLeave('known-native')).resolves.toEqual({ ready: true })
      if (domain === 'autoStart') {
        expect(f.autoStart.enabled.value).toBe(false)
        expect(f.autoStart.error.value).toBe('设置失败，请重试')
      } else expect(f.dock.assign).toHaveBeenLastCalledWith(dockConfig(['right']))
    }
  )

  it.each([
    {},
    { enabledEdges: ['left'] },
    { enabledEdges: ['left'], revealHandleMode: 'unknown' },
    { enabledEdges: ['bottom'], revealHandleMode: 'direct' }
  ])(
    'does not treat incomplete or invalid dock readback as actual configuration: %j',
    async (config) => {
      const f = fixture()
      await f.queue.loadSettingsSnapshot()
      f.api.setDockConfig.mockResolvedValueOnce({ values: { dock: config } })
      f.api.getSettingsSnapshot.mockResolvedValueOnce(documentSnapshot({ dock: config }))
      void f.queue.saveDockConfig(dockConfig(['right'], 'persistent'))
      await expect(f.queue.prepareToLeave('dock-invalid')).rejects.toThrow('贴边隐藏设置回读无效')
      expect(f.dock.assign).not.toHaveBeenCalled()
      expect(f.queue.isLeaving.value).toBe(false)
      expect(f.showMessage).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('无法确认实际配置'),
        4000
      )
    }
  )

  it('does not write initial snapshot or programmatic native assignments back', async () => {
    const f = fixture()
    f.snapshot.assign.mockImplementation(() => {
      f.blur.enabled.value = true
      f.autoStart.enabled.value = true
    })
    f.queue.debouncedSave('css.bgColor', '0 0 0')
    await f.queue.persistSetting({ id: 'ui.settingsPanelSize', value: 72 })
    await f.queue.loadSettingsSnapshot()
    await vi.advanceTimersByTimeAsync(400)
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
    expect(f.api.setBlurConfig).not.toHaveBeenCalled()
    expect(f.api.setAutoStart).not.toHaveBeenCalled()
    expect(f.queue.canWrite()).toBe(true)
  })

  it('coalesces only the same setting id and flushes the final values once', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.queue.debouncedSave('css.fontSizeBase', 14)
    f.queue.debouncedSave('sticky.fontSize', 20)
    f.queue.debouncedSave('css.fontSizeBase', 18)
    await f.queue.flush()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.api.setSettingValue.mock.calls).toEqual([
      ['css.fontSizeBase', 18],
      ['sticky.fontSize', 20]
    ])
  })

  it('recovers from a rejected ordinary save without poisoning subsequent writes', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockRejectedValueOnce(new Error('disk-full'))
    f.queue.debouncedSave('css.fontSizeBase', 15)
    await expect(f.queue.flush()).rejects.toThrow('disk-full')
    expect(f.queue.isInFlight('setting')).toBe(false)
    f.queue.debouncedSave('css.fontSizeBase', 16)
    await f.queue.flush()
    expect(f.api.setSettingValue).toHaveBeenLastCalledWith('css.fontSizeBase', 16)
  })
  it('retains an automatic save failure for close and explicitly retries the same value', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockRejectedValueOnce(new Error('disk-full'))
    f.queue.debouncedSave('css.fontSizeBase', 20)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.queue.failedSettings.value).toEqual([{ id: 'css.fontSizeBase', error: 'disk-full' }])
    expect(f.showMessage).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('保存设置失败'),
      4000
    )
    await expect(f.queue.flush()).rejects.toThrow('disk-full')
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
    await f.queue.retryFailedSettingSaves()
    expect(f.api.setSettingValue.mock.calls).toEqual([
      ['css.fontSizeBase', 20],
      ['css.fontSizeBase', 20]
    ])
    expect(f.queue.failedSettings.value).toEqual([])
    await f.queue.flush()
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(2)
  })
  it('serializes writes of one setting and keeps the latest failed intent over an older success', async () => {
    const f = fixture(),
      old = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error('latest failed'))
    const first = f.queue.persistSetting({ id: 'css.fontSizeBase', value: 18 })
    const latest = f.queue.persistSetting({ id: 'css.fontSizeBase', value: 22 })
    const latestFailure = expect(latest).rejects.toThrow('latest failed')
    const initiallyDispatched = f.api.setSettingValue.mock.calls.length
    old.resolve(savedReceipt())
    await first
    await latestFailure
    expect(initiallyDispatched).toBe(1)
    expect(f.queue.failedSettings.value).toEqual([
      { id: 'css.fontSizeBase', error: 'latest failed' }
    ])
    await f.queue.retryFailedSettingSaves()
    expect(f.api.setSettingValue).toHaveBeenLastCalledWith('css.fontSizeBase', 22)
  })
  it('new values replace a failed intent while reset cancels failure and later old results', async () => {
    const f = fixture(),
      late = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockRejectedValueOnce(new Error('old failed'))
    f.queue.debouncedSave('css.fontSizeBase', 18)
    await vi.advanceTimersByTimeAsync(300)
    f.queue.debouncedSave('css.fontSizeBase', 22)
    expect(f.queue.failedSettings.value).toEqual([])
    f.api.setSettingValue.mockReturnValueOnce(late.promise)
    const flush = f.queue.flush()
    const reset = f.queue.resetSettings()
    late.reject(new Error('after reset failed'))
    await Promise.allSettled([flush, reset])
    expect(f.queue.failedSettings.value).toEqual([])
    const calls = f.api.setSettingValue.mock.calls.length
    await f.queue.retryFailedSettingSaves()
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(calls)
    expect(f.api.resetSettings).toHaveBeenCalledTimes(1)
    expect(f.showMessage.mock.calls.filter(([kind]) => kind === 'error')).toHaveLength(1)
  })
  it('does not publish a pending ordinary save failure after disposal', async () => {
    const f = fixture(),
      late = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockReturnValueOnce(late.promise)
    f.queue.debouncedSave('css.fontSizeBase', 20)
    const finished = f.queue.dispose()
    late.reject(new Error('after dispose failed'))
    await Promise.allSettled([finished])
    expect(f.queue.failedSettings.value).toEqual([])
    expect(f.showMessage).not.toHaveBeenCalled()
    expect(f.queue.canWrite()).toBe(false)
  })
  it('flushes the final same-id value on forced dispose after its earlier write settles', async () => {
    const f = fixture(),
      old = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockReturnValueOnce(old.promise)
    const first = f.queue.persistSetting({ id: 'css.fontSizeBase', value: 18 })
    f.queue.debouncedSave('css.fontSizeBase', 22)
    const finished = f.queue.dispose()
    const initiallyDispatched = f.api.setSettingValue.mock.calls.length
    old.resolve(savedReceipt())
    await Promise.all([first, finished])
    expect(initiallyDispatched).toBe(1)
    expect(f.api.setSettingValue.mock.calls).toEqual([
      ['css.fontSizeBase', 18],
      ['css.fontSizeBase', 22]
    ])
    expect(f.queue.failedSettings.value).toEqual([])
    expect(f.showMessage).not.toHaveBeenCalled()
  })
  it('does not publish an old failure or retry its value after a new debounced intent', async () => {
    const f = fixture(),
      old = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockReturnValueOnce(old.promise)
    const first = f.queue.persistSetting({ id: 'css.fontSizeBase', value: 18 })
    const failure = expect(first).rejects.toThrow('obsolete')
    f.queue.debouncedSave('css.fontSizeBase', 22)
    old.reject(new Error('obsolete'))
    await failure
    expect(f.queue.failedSettings.value).toEqual([])
    expect(f.showMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    await f.queue.flush()
    expect(f.api.setSettingValue).toHaveBeenLastCalledWith('css.fontSizeBase', 22)
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(2)
  })
  it('rejects a newer ordinary failure while flush is waiting for another domain', async () => {
    const f = fixture(),
      native = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockReturnValueOnce(native.promise)
    const nativeWrite = f.queue.syncBlurConfig()
    const closing = f.queue.flush()
    await settle()
    f.api.setSettingValue.mockRejectedValueOnce(new Error('save failed during close wait'))
    f.queue.debouncedSave('css.fontSizeBase', 22)
    await vi.advanceTimersByTimeAsync(300)
    native.resolve({ success: true, snapshot: savedReceipt() })
    await nativeWrite
    await expect(closing).rejects.toThrow('save failed during close wait')
  })

  it('rejects a stale blur response even while the newer intent is still debounced', async () => {
    const f = fixture(),
      old = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockReturnValueOnce(old.promise)
    f.blur.enabled.value = true
    await settle()
    await vi.advanceTimersByTimeAsync(150)
    f.blur.enabled.value = false
    await settle()
    old.resolve({ success: false, config: { enabled: true }, runtime: { error: 'old-error' } })
    await settle()
    expect(f.blur.enabled.value).toBe(false)
    expect(f.blur.error.value).toBeNull()
    expect(f.showMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.api.setBlurConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
  })

  it('reports current native enable failure and rolls back UI without a duplicate write', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockResolvedValueOnce({
      success: false,
      config: { enabled: false },
      runtime: { error: 'DLL unavailable' },
      nativeError: { code: 9 }
    })
    f.blur.enabled.value = true
    await settle()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.blur.enabled.value).toBe(false)
    expect(f.blur.error.value).toBe('DLL unavailable')
    expect(f.api.setBlurConfig).toHaveBeenCalledTimes(1)
    expect(f.showMessage).toHaveBeenCalledWith(
      'error',
      '毛玻璃启用失败：DLL unavailable（错误码 9）',
      5000
    )
    f.blur.enabled.value = true
    await settle()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.api.setBlurConfig).toHaveBeenCalledTimes(2)
  })

  it('keeps the latest auto-start intent when OS responses arrive in reverse order', async () => {
    const f = fixture(),
      first = deferred(),
      second = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setAutoStart.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    f.autoStart.enabled.value = true
    await settle()
    f.autoStart.enabled.value = false
    await settle()
    second.resolve(false)
    await settle()
    first.resolve(false)
    await settle()
    expect(f.autoStart.enabled.value).toBe(false)
    expect(f.autoStart.error.value).toBeNull()
    expect(f.showMessage.mock.calls).toEqual([['success', '开机自启已关闭']])
  })

  it('verifies failed OS writes without saving the verified value again', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.setAutoStart.mockRejectedValueOnce(new Error('denied'))
    f.autoStart.enabled.value = true
    await settle()
    expect(f.autoStart.enabled.value).toBe(false)
    expect(f.autoStart.error.value).toBe('设置失败，请重试')
    expect(f.api.verifyAutoStart).toHaveBeenCalledOnce()
    expect(f.api.setAutoStart).toHaveBeenCalledOnce()
  })

  it('applies only the newest dock snapshot and waits for failure recovery reads', async () => {
    const f = fixture(),
      first = deferred(),
      recovery = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setDockConfig
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('dock failed'))
    const older = f.queue.saveDockConfig({ enabledEdges: ['left'] })
    f.api.getSettingsSnapshot.mockReturnValueOnce(recovery.promise)
    const latest = f.queue.saveDockConfig({ enabledEdges: ['right'] })
    await settle()
    expect(f.queue.isInFlight('dock')).toBe(true)
    first.resolve(documentSnapshot({ dock: dockConfig(['left']) }, 1))
    await older
    expect(f.dock.assign).not.toHaveBeenCalled()
    expect(getSettingsSnapshotStore(f.api).latest().revision).toBe(1)
    // The older successful save is now a valid revision-1 receipt. Its later
    // recovery read must advance, rather than return the pre-save revision 0.
    recovery.resolve(documentSnapshot({ dock: dockConfig(['top']) }, 2))
    await latest
    expect(f.dock.assign.mock.calls).toEqual([[dockConfig(['top'])]])
    expect(f.queue.isInFlight('dock')).toBe(false)
  })

  it('discards pending edits, blocks resize at reset entry and waits for all four domains', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    const writes = [deferred(), deferred(), deferred(), deferred()]
    f.api.setSettingValue.mockReturnValueOnce(writes[0].promise)
    f.api.setBlurConfig.mockReturnValueOnce(writes[1].promise)
    f.api.setAutoStart.mockReturnValueOnce(writes[2].promise)
    f.api.setDockConfig.mockReturnValueOnce(writes[3].promise)
    void f.queue.persistSetting({ id: 'ui.settingsPanelSize', value: 73 })
    void f.queue.syncBlurConfig()
    void f.queue.saveAutoStart(true)
    void f.queue.saveDockConfig({ enabledEdges: ['left'] })
    f.queue.debouncedSave('css.fontSizeBase', 22)
    f.blur.radius.value = 20
    await settle()
    const reset = f.queue.resetSettings(
      () => void f.queue.persistSetting({ id: 'ui.settingsPanelSize', value: 80 })
    )
    await vi.advanceTimersByTimeAsync(500)
    expect(f.api.resetSettings).not.toHaveBeenCalled()
    expect(f.api.setSettingValue.mock.calls).toEqual([['ui.settingsPanelSize', 73]])
    writes[0].resolve(savedReceipt())
    writes[1].resolve({ config: { enabled: true }, runtime: { error: 'obsolete' } })
    writes[2].resolve(true)
    await settle()
    expect(f.api.resetSettings).not.toHaveBeenCalled()
    writes[3].resolve(documentSnapshot({ dock: dockConfig(['right']) }, 1))
    await reset
    expect(f.api.resetSettings).toHaveBeenCalledOnce()
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(documentSnapshot({ marker: 'reset' }, 1))
    expect(f.dock.assign).not.toHaveBeenCalled()
    expect(f.blur.error.value).toBeNull()
    expect(f.queue.isResetting.value).toBe(false)
  })

  it('reloads the actual partial backend state after reset fails and permits a later retry', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.resetSettings.mockRejectedValueOnce(new Error('second scope failed'))
    f.api.getSettingsSnapshot.mockResolvedValueOnce(
      documentSnapshot({ marker: 'application-reset-view-preserved' })
    )
    f.snapshot.assign.mockImplementation(() => {
      f.autoStart.enabled.value = true
      f.blur.enabled.value = true
    })
    await f.queue.resetSettings()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(
      documentSnapshot({ marker: 'application-reset-view-preserved' })
    )
    expect(f.api.setBlurConfig).not.toHaveBeenCalled()
    expect(f.api.setAutoStart).not.toHaveBeenCalled()
    expect(f.queue.canWrite()).toBe(true)
    await f.queue.resetSettings()
    expect(f.api.resetSettings).toHaveBeenCalledTimes(2)
  })

  it('clears another participant failed intent only after the reset is confirmed', async () => {
    const f = fixture(),
      other = fixture(f.api)
    await f.queue.loadSettingsSnapshot()
    await other.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockRejectedValueOnce(new Error('old disk failure'))
    await expect(other.queue.persistSetting({ id: 'css.fontSizeBase', value: 22 })).rejects.toThrow(
      'old disk failure'
    )
    expect(other.queue.failedSettings.value).toEqual([
      { id: 'css.fontSizeBase', error: 'old disk failure' }
    ])
    expect(f.snapshots.protectedCount).toBe(1)
    const actual = documentSnapshot({ css: { fontSizeBase: 14 } }, 1)
    f.api.resetSettings.mockResolvedValueOnce(actual)
    await f.queue.resetSettings()
    expect(other.queue.failedSettings.value).toEqual([])
    expect(other.queue.isProtected('setting', 'css.fontSizeBase')).toBe(false)
    expect(other.snapshot.assign).toHaveBeenLastCalledWith(actual)
    expect(f.snapshots.latest()).toEqual(actual)
    expect(f.snapshots.protectedCount).toBe(0)
    await expect(other.queue.flush()).resolves.toBeUndefined()
    await other.queue.retryFailedSettingSaves()
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('css.fontSizeBase', 22)
  })

  it('preserves another participant failed intent when reset rejects', async () => {
    const f = fixture(),
      other = fixture(f.api)
    await f.queue.loadSettingsSnapshot()
    await other.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockRejectedValueOnce(new Error('old disk failure'))
    await expect(other.queue.persistSetting({ id: 'css.fontSizeBase', value: 22 })).rejects.toThrow(
      'old disk failure'
    )
    f.api.resetSettings.mockRejectedValueOnce(new Error('reset rejected'))
    await f.queue.resetSettings()
    expect(other.queue.failedSettings.value).toEqual([
      { id: 'css.fontSizeBase', error: 'old disk failure' }
    ])
    expect(other.queue.isProtected('setting', 'css.fontSizeBase')).toBe(true)
    expect(f.snapshots.latest().values.css.fontSizeBase).toBe(22)
    expect(f.snapshots.protectedCount).toBe(1)
    await expect(other.queue.flush()).rejects.toThrow('old disk failure')
    expect(f.api.setSettingValue).toHaveBeenCalledTimes(1)
  })

  it('preserves a participant intent created after the reset checkpoint', async () => {
    const f = fixture(),
      other = fixture(f.api),
      resetReply = deferred()
    await f.queue.loadSettingsSnapshot()
    await other.queue.loadSettingsSnapshot()
    other.queue.debouncedSave('css.fontSizeBase', 18)
    f.api.resetSettings.mockReturnValueOnce(resetReply.promise)
    const resetting = f.queue.resetSettings()
    await settle()
    expect(f.api.resetSettings).toHaveBeenCalledOnce()
    other.queue.debouncedSave('css.fontSizeBase', 22)
    resetReply.resolve(documentSnapshot({ css: { fontSizeBase: 14 } }, 1))
    await resetting
    expect(f.snapshots.latest().values.css.fontSizeBase).toBe(22)
    expect(other.queue.isProtected('setting', 'css.fontSizeBase')).toBe(true)
    expect(f.snapshots.protectedCount).toBe(1)
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
    f.api.setSettingValue.mockResolvedValueOnce(documentSnapshot({ css: { fontSizeBase: 21 } }, 2))
    await other.queue.flush()
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('css.fontSizeBase', 22)
    expect(f.snapshots.latest().values.css.fontSizeBase).toBe(21)
    expect(f.snapshots.protectedCount).toBe(0)
  })

  it('does not dispatch a same-id intent revoked by reset after its earlier write settles or disposal starts', async () => {
    const f = fixture(),
      other = fixture(f.api),
      oldWrite = deferred()
    await f.queue.loadSettingsSnapshot()
    await other.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockReturnValueOnce(oldWrite.promise)
    const first = other.queue.persistSetting({ id: 'css.fontSizeBase', value: 18 })
    const waiting = other.queue.persistSetting({ id: 'css.fontSizeBase', value: 22 })
    const actual = documentSnapshot({ css: { fontSizeBase: 14 } }, 3)
    f.api.resetSettings.mockResolvedValueOnce(actual)
    await f.queue.resetSettings()
    expect(other.queue.isProtected('setting', 'css.fontSizeBase')).toBe(false)
    const disposed = other.queue.dispose()
    oldWrite.resolve(documentSnapshot({ css: { fontSizeBase: 18 } }, 2))
    await Promise.all([first, waiting, disposed])
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('css.fontSizeBase', 18)
    expect(f.snapshots.latest()).toEqual(actual)
    expect(other.queue.failedSettings.value).toEqual([])
    expect(f.snapshots.protectedCount).toBe(0)
  })

  it.each(['queued', 'in-flight'])(
    'invalidates another participant %s native blur intent after reset and keeps the default form',
    async (phase) => {
      const f = fixture(),
        other = fixture(f.api),
        nativeReply = deferred()
      const actualBlur = { enabled: false, radius: 8, saturation: 1.4, cornerRadius: 12 }
      const actual = documentSnapshot({ blur: actualBlur }, 2, {
        blur: { supported: true, effectiveEnabled: false, error: null }
      })
      other.snapshot.assign.mockImplementation((value) => {
        if (value.values.blur && !other.queue.isProtected('blur')) {
          for (const [key, field] of Object.entries(value.values.blur))
            other.blur[key].value = field
        }
      })
      await f.queue.loadSettingsSnapshot()
      await other.queue.loadSettingsSnapshot()
      f.api.setBlurConfig.mockReturnValueOnce(nativeReply.promise)
      other.blur.radius.value = 24
      await settle()
      if (phase === 'in-flight') await vi.advanceTimersByTimeAsync(150)
      f.api.resetSettings.mockResolvedValueOnce(actual)
      await f.queue.resetSettings()
      expect(other.queue.isProtected('blur')).toBe(false)
      expect(other.blur.radius.value).toBe(8)
      if (phase === 'in-flight') {
        nativeReply.resolve({
          success: true,
          config: { ...actualBlur, radius: 24 },
          runtime: actual.runtime.blur,
          snapshot: documentSnapshot({ blur: { ...actualBlur, radius: 24 } }, 1, actual.runtime)
        })
        await other.queue.waitForInFlightWrites()
      }
      await vi.advanceTimersByTimeAsync(300)
      expect(f.api.setBlurConfig).toHaveBeenCalledTimes(phase === 'in-flight' ? 1 : 0)
      expect(other.blur.radius.value).toBe(8)
      expect(other.snapshot.assign).toHaveBeenLastCalledWith(actual)
      expect(f.snapshots.latest()).toEqual(actual)
      expect(f.snapshots.protectedCount).toBe(0)
      await expect(other.queue.flush()).resolves.toBeUndefined()
    }
  )

  it('flushes final pending changes on dispose and suppresses late native UI feedback', async () => {
    const f = fixture(),
      blurResult = deferred()
    await f.queue.loadSettingsSnapshot()
    f.queue.debouncedSave('css.fontSizeBase', 19)
    f.api.setBlurConfig.mockReturnValueOnce(blurResult.promise)
    f.blur.enabled.value = true
    await settle()
    const finish = f.queue.dispose()
    expect(f.api.setSettingValue).toHaveBeenCalledWith('css.fontSizeBase', 19)
    expect(f.api.setBlurConfig).toHaveBeenCalledOnce()
    blurResult.resolve({ success: false, config: { enabled: false }, runtime: { error: 'late' } })
    await finish
    await vi.advanceTimersByTimeAsync(500)
    expect(f.blur.enabled.value).toBe(true)
    expect(f.showMessage).not.toHaveBeenCalled()
    expect(f.api.setSettingValue).toHaveBeenCalledOnce()
    expect(f.queue.canWrite()).toBe(false)
  })

  it('does not apply a load that completes after dispose or supersedes a newer snapshot', async () => {
    const f = fixture(),
      older = deferred(),
      newer = deferred()
    f.api.getSettingsSnapshot.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const oldLoad = f.queue.loadSettingsSnapshot()
    const newLoad = f.queue.loadSettingsSnapshot()
    newer.resolve(documentSnapshot({ marker: 'newer' }))
    await newLoad
    older.resolve(documentSnapshot({ marker: 'older' }))
    await oldLoad
    expect(f.snapshot.assign.mock.calls).toEqual([[documentSnapshot({ marker: 'newer' })]])
    const late = deferred()
    f.api.getSettingsSnapshot.mockReturnValueOnce(late.promise)
    const lateLoad = f.queue.loadSettingsSnapshot()
    await f.queue.dispose()
    late.resolve(documentSnapshot({ marker: 'disposed' }))
    await lateLoad
    expect(f.snapshot.assign).toHaveBeenCalledOnce()
  })

  it.each(['stale reply', 'read failure'])(
    'subscribes before the initial read and preserves a newer broadcast after %s',
    async (outcome) => {
      const f = fixture(),
        initial = deferred()
      f.api.getSettingsSnapshot.mockImplementationOnce(() => {
        expect(f.api.onSettingsChanged).toHaveBeenCalledOnce()
        return initial.promise
      })
      const loading = f.queue.loadSettingsSnapshot()
      const newest = documentSnapshot({ css: { fontSizeBase: 24 } }, 2)
      f.broadcast(newest)
      if (outcome === 'read failure') initial.reject(new Error('initial read failed'))
      else initial.resolve(documentSnapshot({ css: { fontSizeBase: 14 } }, 1))
      await loading
      expect(f.snapshot.assign.mock.calls).toEqual([[newest]])
      expect(f.snapshot.fallback).not.toHaveBeenCalled()
      expect(f.queue.canWrite()).toBe(true)
    }
  )

  it('masks queued and failed ordinary edits while unrelated broadcast fields keep updating', async () => {
    const f = fixture()
    f.api.getSettingsSnapshot.mockResolvedValueOnce(
      documentSnapshot({ css: { fontSizeBase: 17, bgColor: '255 255 255' } })
    )
    await f.queue.loadSettingsSnapshot()
    f.queue.debouncedSave('css.fontSizeBase', 22)
    expect(f.queue.isProtected('setting', 'css.fontSizeBase')).toBe(true)
    expect(f.queue.isInFlight('setting')).toBe(false)
    f.broadcast(documentSnapshot({ css: { fontSizeBase: 17, bgColor: '1 2 3' } }, 1))
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(
      documentSnapshot({ css: { fontSizeBase: 22, bgColor: '1 2 3' } }, 1)
    )
    f.api.setSettingValue.mockRejectedValueOnce(new Error('disk full'))
    await vi.advanceTimersByTimeAsync(300)
    expect(f.queue.failedSettings.value).toEqual([{ id: 'css.fontSizeBase', error: 'disk full' }])
    expect(f.snapshots.protectedCount).toBe(1)
    f.broadcast(documentSnapshot({ css: { fontSizeBase: 19, bgColor: '4 5 6' } }, 2))
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(
      documentSnapshot({ css: { fontSizeBase: 22, bgColor: '4 5 6' } }, 2)
    )
    await settle()
    f.api.setSettingValue.mockResolvedValueOnce(
      documentSnapshot({ css: { fontSizeBase: 21, bgColor: '4 5 6' } }, 3)
    )
    await f.queue.retryFailedSettingSaves()
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(
      documentSnapshot({ css: { fontSizeBase: 21, bgColor: '4 5 6' } }, 3)
    )
    expect(f.queue.isProtected('setting', 'css.fontSizeBase')).toBe(false)
    expect(f.snapshots.protectedCount).toBe(0)
  })

  it('records an older commit without releasing the replacement lease and accepts normalized latest values', async () => {
    const f = fixture(),
      older = deferred()
    f.api.getSettingsSnapshot.mockResolvedValueOnce(documentSnapshot({ css: { fontSizeBase: 17 } }))
    await f.queue.loadSettingsSnapshot()
    f.api.setSettingValue.mockReturnValueOnce(older.promise)
    const first = f.queue.persistSetting({ id: 'css.fontSizeBase', value: 18 })
    f.queue.debouncedSave('css.fontSizeBase', 22)
    older.resolve(documentSnapshot({ css: { fontSizeBase: 18 } }, 1))
    await first
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(
      documentSnapshot({ css: { fontSizeBase: 22 } }, 1)
    )
    expect(f.snapshots.protectedCount).toBe(1)
    expect(f.queue.isProtected('setting', 'css.fontSizeBase')).toBe(true)
    await settle()
    f.api.setSettingValue.mockResolvedValueOnce(documentSnapshot({ css: { fontSizeBase: 21 } }, 2))
    await f.queue.flush()
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(
      documentSnapshot({ css: { fontSizeBase: 21 } }, 2)
    )
    expect(f.api.setSettingValue.mock.calls).toEqual([
      ['css.fontSizeBase', 18],
      ['css.fontSizeBase', 22]
    ])
    expect(f.snapshots.protectedCount).toBe(0)
  })

  it('suppresses external form watchers without clearing the existing debounced intent', async () => {
    const f = fixture(),
      font = ref(17)
    const stop = watch(font, (value) => f.queue.debouncedSave('css.fontSizeBase', value))
    f.snapshot.assign.mockImplementation((value) => {
      if (value.values.css) font.value = value.values.css.fontSizeBase
      if (value.values.blur) f.blur.enabled.value = value.values.blur.enabled
      if (value.runtime?.autoStart) f.autoStart.enabled.value = value.runtime.autoStart.value
    })
    await f.queue.loadSettingsSnapshot()
    f.queue.debouncedSave('css.fontSizeBase', 22)
    f.broadcast(
      documentSnapshot({ css: { fontSizeBase: 17 }, blur: { enabled: true } }, 1, {
        autoStart: { value: true }
      })
    )
    await settle()
    expect(font.value).toBe(22)
    expect(f.queue.isProtected('setting', 'css.fontSizeBase')).toBe(true)
    expect(f.api.setAutoStart).not.toHaveBeenCalled()
    expect(f.api.setBlurConfig).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    await f.queue.flush()
    expect(f.api.setSettingValue.mock.calls).toEqual([['css.fontSizeBase', 22]])
    stop()
  })

  it('protects blur during its 150ms queue and in-flight phase without inventing native runtime', async () => {
    const f = fixture(),
      native = deferred()
    const actualBlur = { enabled: false, radius: 8, saturation: 1.4, cornerRadius: 12 }
    const runtime = { blur: { supported: true, effectiveEnabled: false, error: null } }
    f.api.getSettingsSnapshot.mockResolvedValueOnce(
      documentSnapshot({ blur: actualBlur }, 0, runtime)
    )
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockReturnValueOnce(native.promise)
    f.blur.enabled.value = true
    f.blur.radius.value = 24
    await settle()
    expect(f.queue.isProtected('blur')).toBe(true)
    expect(f.queue.isInFlight('blur')).toBe(false)
    f.broadcast(documentSnapshot({ blur: actualBlur }, 1, runtime))
    expect(f.snapshots.latest().values.blur).toEqual({ ...actualBlur, enabled: true, radius: 24 })
    expect(f.snapshots.latest().runtime.blur.effectiveEnabled).toBe(false)
    expect(f.api.setBlurConfig).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.queue.isProtected('blur')).toBe(true)
    expect(f.queue.isInFlight('blur')).toBe(true)
    native.resolve({
      success: true,
      config: { ...actualBlur, enabled: true, radius: 24 },
      snapshot: documentSnapshot({ blur: { ...actualBlur, enabled: true, radius: 24 } }, 2, runtime)
    })
    await f.queue.waitForInFlightWrites()
    expect(f.queue.isProtected('blur')).toBe(false)
    expect(f.snapshots.protectedCount).toBe(0)
  })

  it('keeps a failed dock intent protected when the fresh actual-state read fails despite a cached base', async () => {
    const f = fixture()
    f.api.getSettingsSnapshot.mockResolvedValueOnce(
      documentSnapshot({ dock: dockConfig(['left']) })
    )
    await f.queue.loadSettingsSnapshot()
    f.api.setDockConfig.mockRejectedValueOnce(new Error('dock write failed'))
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('fresh dock read failed'))
    await f.queue.saveDockConfig(dockConfig(['right'], 'persistent'))
    expect(f.dock.assign).not.toHaveBeenCalled()
    expect(f.queue.isProtected('dock')).toBe(true)
    expect(f.snapshots.latest().values.dock).toEqual(dockConfig(['right'], 'persistent'))
    await expect(f.queue.flush()).rejects.toThrow('dock write failed')
    expect(f.snapshots.protectedCount).toBe(1)
    await f.queue.saveDockConfig(dockConfig(['top']))
    expect(f.dock.assign).toHaveBeenLastCalledWith(dockConfig(['top']))
    expect(f.queue.isProtected('dock')).toBe(false)
    expect(f.snapshots.protectedCount).toBe(0)
  })

  it('releases only its own leases and subscription during forced disposal', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    const releaseOther = f.snapshots.protectSetting({}, 'css.bgColor', '1 2 3')
    f.queue.debouncedSave('css.fontSizeBase', 22)
    f.blur.radius.value = 24
    await settle()
    expect(f.snapshots.protectedCount).toBe(3)
    await f.queue.dispose()
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('css.fontSizeBase', 22)
    expect(f.api.setBlurConfig).toHaveBeenCalledOnce()
    expect(f.snapshots.protectedCount).toBe(1)
    expect(f.stopTransport).toHaveBeenCalledOnce()
    const assignments = f.snapshot.assign.mock.calls.length
    f.broadcast(documentSnapshot({ css: { fontSizeBase: 14 } }, 1))
    await settle()
    expect(f.snapshot.assign).toHaveBeenCalledTimes(assignments)
    releaseOther()
    expect(f.snapshots.protectedCount).toBe(0)
  })

  it('converges all four native blur fields to the normalized nested commit without rewriting', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    const actual = { enabled: false, radius: 40, saturation: 2, cornerRadius: 30 }
    const committed = documentSnapshot({ blur: actual }, 1, {
      blur: { supported: true, effectiveEnabled: false, error: null }
    })
    f.api.setBlurConfig.mockResolvedValueOnce({
      success: true,
      config: actual,
      runtime: committed.runtime.blur,
      snapshot: committed
    })
    f.blur.radius.value = 99
    f.blur.saturation.value = 9
    f.blur.cornerRadius.value = 99
    await settle()
    await vi.advanceTimersByTimeAsync(150)
    await f.queue.waitForInFlightWrites()
    expect({
      enabled: f.blur.enabled.value,
      radius: f.blur.radius.value,
      saturation: f.blur.saturation.value,
      cornerRadius: f.blur.cornerRadius.value
    }).toEqual(actual)
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(committed)
    expect(f.snapshots.latest()).toEqual(committed)
    expect(f.snapshots.protectedCount).toBe(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.api.setBlurConfig).toHaveBeenCalledExactlyOnceWith({
      enabled: false,
      radius: 99,
      saturation: 9,
      cornerRadius: 99
    })
    await expect(f.queue.flush()).resolves.toBeUndefined()
  })

  it('publishes the confirmed rollback snapshot and restores every native field without rewriting', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    const actual = { enabled: false, radius: 8, saturation: 1.4, cornerRadius: 12 }
    const committed = documentSnapshot({ blur: actual, wallpaper: { enabled: true } }, 1, {
      blur: { supported: true, effectiveEnabled: false, error: 'native unavailable' }
    })
    f.api.setBlurConfig.mockResolvedValueOnce({
      success: false,
      config: actual,
      runtime: committed.runtime.blur,
      snapshot: committed,
      error: 'native unavailable'
    })
    f.blur.enabled.value = true
    f.blur.radius.value = 24
    f.blur.saturation.value = 1.8
    f.blur.cornerRadius.value = 18
    await settle()
    await vi.advanceTimersByTimeAsync(150)
    await f.queue.waitForInFlightWrites()
    expect(f.blur.enabled.value).toBe(false)
    expect(f.blur.radius.value).toBe(8)
    expect(f.blur.saturation.value).toBe(1.4)
    expect(f.blur.cornerRadius.value).toBe(12)
    expect(f.blur.error.value).toBe('native unavailable')
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(committed)
    expect(f.snapshots.latest()).toEqual(committed)
    expect(f.snapshots.protectedCount).toBe(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.api.setBlurConfig).toHaveBeenCalledOnce()
    await expect(f.queue.flush()).resolves.toBeUndefined()
  })

  it('records a superseded native commit while its replacement lease and all new form fields remain intact', async () => {
    const f = fixture(),
      older = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockReturnValueOnce(older.promise)
    f.blur.enabled.value = true
    f.blur.radius.value = 99
    f.blur.saturation.value = 9
    f.blur.cornerRadius.value = 99
    await settle()
    await vi.advanceTimersByTimeAsync(150)
    const latest = { enabled: false, radius: 18, saturation: 1.2, cornerRadius: 6 }
    for (const [key, value] of Object.entries(latest)) f.blur[key].value = value
    await settle()
    const oldActual = { enabled: true, radius: 40, saturation: 2, cornerRadius: 30 }
    older.resolve({
      success: true,
      config: oldActual,
      runtime: { effectiveEnabled: true },
      snapshot: documentSnapshot({ blur: oldActual }, 1, { blur: { effectiveEnabled: true } })
    })
    await f.queue.waitForInFlightWrites()
    expect(f.blur.enabled.value).toBe(false)
    expect(f.blur.radius.value).toBe(18)
    expect(f.blur.saturation.value).toBe(1.2)
    expect(f.blur.cornerRadius.value).toBe(6)
    expect(f.snapshots.latest().revision).toBe(1)
    expect(f.snapshots.latest().values.blur).toEqual(latest)
    expect(f.snapshots.protectedCount).toBe(1)
    expect(f.queue.isProtected('blur')).toBe(true)
    expect(f.api.setBlurConfig).toHaveBeenCalledOnce()
    const committed = documentSnapshot({ blur: latest }, 2, { blur: { effectiveEnabled: false } })
    f.api.setBlurConfig.mockResolvedValueOnce({
      success: true,
      config: latest,
      runtime: committed.runtime.blur,
      snapshot: committed
    })
    await vi.advanceTimersByTimeAsync(150)
    await f.queue.waitForInFlightWrites()
    expect(f.snapshots.latest()).toEqual(committed)
    expect(f.snapshots.protectedCount).toBe(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.api.setBlurConfig).toHaveBeenCalledTimes(2)
  })

  it('converges native form refs and providers to a higher canonical revision after an older normalized reply', async () => {
    const f = fixture(),
      saving = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockReturnValueOnce(saving.promise)
    f.blur.enabled.value = true
    f.blur.radius.value = 99
    f.blur.saturation.value = 9
    f.blur.cornerRadius.value = 99
    await settle()
    await vi.advanceTimersByTimeAsync(150)
    const newer = { enabled: false, radius: 7, saturation: 1.1, cornerRadius: 3 }
    const canonical = documentSnapshot({ blur: newer }, 3, {
      blur: { supported: true, effectiveEnabled: false, error: null }
    })
    f.broadcast(canonical)
    expect(f.snapshots.latest().values.blur.radius).toBe(99)
    const olderActual = { enabled: true, radius: 40, saturation: 2, cornerRadius: 30 }
    saving.resolve({
      success: true,
      config: olderActual,
      runtime: { effectiveEnabled: true, error: null },
      snapshot: documentSnapshot({ blur: olderActual }, 2, { blur: { effectiveEnabled: true } })
    })
    await f.queue.waitForInFlightWrites()
    expect(f.blur.enabled.value).toBe(false)
    expect(f.blur.radius.value).toBe(7)
    expect(f.blur.saturation.value).toBe(1.1)
    expect(f.blur.cornerRadius.value).toBe(3)
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(canonical)
    expect(f.snapshots.latest()).toEqual(canonical)
    expect(f.snapshots.latest().runtime.blur.effectiveEnabled).toBe(false)
    expect(f.snapshots.protectedCount).toBe(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.api.setBlurConfig).toHaveBeenCalledOnce()
  })

  it('accepts a retirement failure actual snapshot without marking its unchanged blur intent saved', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    const actual = { enabled: false, radius: 8, saturation: 1.4, cornerRadius: 12 }
    const canonical = documentSnapshot({ blur: actual, wallpaper: { enabled: true } }, 2, {
      blur: { effectiveEnabled: false, error: null }
    })
    f.api.setBlurConfig.mockResolvedValueOnce(retirementFailure(canonical))
    f.blur.enabled.value = true
    f.blur.radius.value = 24
    await settle()
    await vi.advanceTimersByTimeAsync(150)
    await f.queue.waitForInFlightWrites()
    expect(f.snapshots.latest()).toEqual(canonical)
    expect(f.snapshot.assign).toHaveBeenLastCalledWith(canonical)
    expect(f.blur.enabled.value).toBe(false)
    expect(f.blur.radius.value).toBe(8)
    expect(f.blur.error.value).toContain('壁纸退场未确认')
    expect(f.queue.hasUnconfirmedWrites.value).toBe(false)
    expect(f.queue.awaitingCanonical.value).toBe(false)
    expect(f.snapshots.protectedCount).toBe(0)
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledOnce()
    await expect(f.queue.flush()).resolves.toBeUndefined()
    expect(f.api.setBlurConfig).toHaveBeenCalledOnce()
  })

  it('keeps a higher actual revision when an older unchanged retirement failure arrives', async () => {
    const f = fixture(),
      pending = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockReturnValueOnce(pending.promise)
    f.blur.enabled.value = true
    f.blur.radius.value = 24
    await settle()
    await vi.advanceTimersByTimeAsync(150)
    const newest = { enabled: false, radius: 18, saturation: 1.2, cornerRadius: 6 }
    const canonical = documentSnapshot({ blur: newest, wallpaper: { enabled: false } }, 4, {
      blur: { effectiveEnabled: false, error: null }
    })
    f.broadcast(canonical)
    const older = { enabled: false, radius: 8, saturation: 1.4, cornerRadius: 12 }
    pending.resolve(
      retirementFailure(
        documentSnapshot({ blur: older, wallpaper: { enabled: true } }, 3, {
          blur: { effectiveEnabled: false, error: null }
        })
      )
    )
    await f.queue.waitForInFlightWrites()
    expect(f.snapshots.latest()).toEqual(canonical)
    expect(f.blur.radius.value).toBe(18)
    expect(f.blur.saturation.value).toBe(1.2)
    expect(f.snapshots.protectedCount).toBe(0)
  })

  it('does not release a newer blur intent when an older retirement fails with a full actual snapshot', async () => {
    const f = fixture(),
      pending = deferred()
    await f.queue.loadSettingsSnapshot()
    f.api.setBlurConfig.mockReturnValueOnce(pending.promise)
    f.blur.enabled.value = true
    f.blur.radius.value = 24
    await settle()
    await vi.advanceTimersByTimeAsync(150)
    f.blur.radius.value = 31
    await settle()
    pending.resolve(
      retirementFailure(
        documentSnapshot(
          { blur: { enabled: false, radius: 8, saturation: 1.4, cornerRadius: 12 } },
          2,
          { blur: { effectiveEnabled: false } }
        )
      )
    )
    await f.queue.waitForInFlightWrites()
    expect(f.blur.enabled.value).toBe(true)
    expect(f.blur.radius.value).toBe(31)
    expect(f.queue.isProtected('blur')).toBe(true)
    expect(f.snapshots.latest().revision).toBe(0)
    await vi.advanceTimersByTimeAsync(150)
    await f.queue.waitForInFlightWrites()
    expect(f.api.setBlurConfig).toHaveBeenCalledTimes(2)
  })

  it.each(['missing', 'foreign-source', 'saved-snapshot', 'incomplete-config'])(
    'retains unconfirmed blur state for a retirement failure with %s actual evidence',
    async (problem) => {
      const f = fixture()
      await f.queue.loadSettingsSnapshot()
      const actual = { enabled: false, radius: 8, saturation: 1.4, cornerRadius: 12 }
      const canonical = documentSnapshot({ blur: actual }, 2, {
        blur: { effectiveEnabled: false }
      })
      const result = retirementFailure(canonical)
      if (problem === 'missing') {
        result.snapshot = null
        delete result.config
        delete result.runtime
      } else if (problem === 'foreign-source') {
        canonical.source = { token: 'successor-document', scope: 'month' }
      } else if (problem === 'saved-snapshot') {
        canonical.persistence = { status: 'saved', commitId: 'wallpaper-only' }
      } else {
        result.config = { enabled: false }
      }
      f.api.setBlurConfig.mockResolvedValueOnce(result)
      f.blur.enabled.value = true
      f.blur.radius.value = 24
      await settle()
      await vi.advanceTimersByTimeAsync(150)
      await f.queue.waitForInFlightWrites()
      expect(f.queue.hasUnconfirmedWrites.value).toBe(true)
      expect(f.queue.isProtected('blur')).toBe(true)
      expect(f.snapshots.latest().revision).toBe(0)
      expect(f.snapshots.latest().values.blur).toMatchObject({ enabled: true, radius: 24 })
      expect(f.queue.awaitingCanonical.value).toBe(false)
      expect(f.api.setBlurConfig).toHaveBeenCalledOnce()
    }
  )
})
