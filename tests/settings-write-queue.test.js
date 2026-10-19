import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useSettingsWriteQueue } from '../src/renderer/src/composables/useSettingsWriteQueue.js'

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
const queues = []
function fixture() {
  const blur = {
    enabled: ref(false),
    radius: ref(8),
    saturation: ref(1.4),
    cornerRadius: ref(12),
    error: ref(null)
  }
  const autoStart = { enabled: ref(false), error: ref(null) }
  const api = {
    getSettingsSnapshot: vi.fn(async () => ({ values: { marker: 'initial' } })),
    setSettingValue: vi.fn(async () => {}),
    setBlurConfig: vi.fn(async (config) => ({ success: true, config, runtime: { error: null } })),
    setAutoStart: vi.fn(async (value) => value),
    verifyAutoStart: vi.fn(async () => ({ value: false })),
    setDockConfig: vi.fn(async (config) => ({ values: { dock: config } })),
    resetSettings: vi.fn(async () => ({ values: { marker: 'reset' } }))
  }
  const snapshot = { assign: vi.fn(), fallback: vi.fn(() => ({ values: { marker: 'fallback' } })) }
  const dock = { assign: vi.fn() }
  const showMessage = vi.fn(),
    warn = vi.fn()
  const queue = useSettingsWriteQueue({ api, blur, autoStart, dock, snapshot, showMessage, warn })
  queues.push(queue)
  return { queue, api, blur, autoStart, dock, snapshot, showMessage, warn }
}
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await Promise.allSettled(queues.splice(0).map((queue) => queue.dispose()))
  vi.useRealTimers()
})

describe('settings write lifecycle', () => {
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
    old.resolve()
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
    old.resolve()
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
    native.resolve({ success: true })
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
    first.resolve({ values: { dock: { enabledEdges: ['left'] } } })
    await older
    expect(f.dock.assign).not.toHaveBeenCalled()
    recovery.resolve({ values: { dock: { enabledEdges: ['top'] } } })
    await latest
    expect(f.dock.assign.mock.calls).toEqual([[{ enabledEdges: ['top'] }]])
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
    writes[0].resolve()
    writes[1].resolve({ config: { enabled: true }, runtime: { error: 'obsolete' } })
    writes[2].resolve(true)
    await settle()
    expect(f.api.resetSettings).not.toHaveBeenCalled()
    writes[3].resolve({ values: { dock: { enabledEdges: ['right'] } } })
    await reset
    expect(f.api.resetSettings).toHaveBeenCalledOnce()
    expect(f.snapshot.assign).toHaveBeenLastCalledWith({ values: { marker: 'reset' } })
    expect(f.dock.assign).not.toHaveBeenCalled()
    expect(f.blur.error.value).toBeNull()
    expect(f.queue.isResetting.value).toBe(false)
  })

  it('reloads the actual partial backend state after reset fails and permits a later retry', async () => {
    const f = fixture()
    await f.queue.loadSettingsSnapshot()
    f.api.resetSettings.mockRejectedValueOnce(new Error('second scope failed'))
    f.api.getSettingsSnapshot.mockResolvedValueOnce({
      values: { marker: 'application-reset-view-preserved' }
    })
    f.snapshot.assign.mockImplementation(() => {
      f.autoStart.enabled.value = true
      f.blur.enabled.value = true
    })
    await f.queue.resetSettings()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.snapshot.assign).toHaveBeenLastCalledWith({
      values: { marker: 'application-reset-view-preserved' }
    })
    expect(f.api.setBlurConfig).not.toHaveBeenCalled()
    expect(f.api.setAutoStart).not.toHaveBeenCalled()
    expect(f.queue.canWrite()).toBe(true)
    await f.queue.resetSettings()
    expect(f.api.resetSettings).toHaveBeenCalledTimes(2)
  })

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
    newer.resolve({ values: { marker: 'newer' } })
    await newLoad
    older.resolve({ values: { marker: 'older' } })
    await oldLoad
    expect(f.snapshot.assign.mock.calls).toEqual([[{ values: { marker: 'newer' } }]])
    const late = deferred()
    f.api.getSettingsSnapshot.mockReturnValueOnce(late.promise)
    const lateLoad = f.queue.loadSettingsSnapshot()
    await f.queue.dispose()
    late.resolve({ values: { marker: 'disposed' } })
    await lateLoad
    expect(f.snapshot.assign).toHaveBeenCalledOnce()
  })
})
