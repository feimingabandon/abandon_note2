import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useHolidayDataSettings } from '../src/renderer/src/composables/useHolidayDataSettings.js'
import { useSettingsDiagnostics } from '../src/renderer/src/composables/useSettingsDiagnostics.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const scopes = []
const flush = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}
function scoped(use) {
  const scope = effectScope()
  scopes.push(scope)
  return { model: scope.run(use), scope }
}
function holidayFixture() {
  const listeners = {}
  const stop = vi.fn()
  const api = {
    onHolidayDataChanged: vi.fn((fn) => {
      listeners.changed = fn
      return stop
    }),
    getHolidayDataStatus: vi.fn().mockResolvedValue({ available: false }),
    importHolidayData: vi.fn().mockResolvedValue({ canceled: true }),
    downloadHolidayData: vi
      .fn()
      .mockResolvedValue({ status: { available: true, source: 'download' } }),
    openHolidayDataLink: vi.fn().mockResolvedValue(true)
  }
  const message = vi.fn()
  return {
    api,
    listeners,
    stop,
    message,
    ...scoped(() => useHolidayDataSettings({ api, showMessage: message, year: 2026 }))
  }
}
function diagnosticsFixture() {
  vi.useFakeTimers()
  const listeners = {}
  const stops = { blur: vi.fn(), remote: vi.fn() }
  const api = {
    onBlurDiagnosticChanged: vi.fn((fn) => {
      listeners.blur = fn
      return stops.blur
    }),
    onRemoteHealthChanged: vi.fn((fn) => {
      listeners.remote = fn
      return stops.remote
    }),
    getRemoteHealth: vi.fn().mockResolvedValue({ skipped: true }),
    getSchedulerHealth: vi.fn().mockResolvedValue({ status: 'running' }),
    retryScheduler: vi.fn().mockResolvedValue({ status: 'running', retried: true })
  }
  const message = vi.fn()
  return {
    api,
    listeners,
    stops,
    message,
    ...scoped(() => useSettingsDiagnostics({ api, showMessage: message }))
  }
}
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('settings holiday data owner', () => {
  it('subscribes before reading, coalesces changes and rejects the older local result', async () => {
    const f = holidayFixture()
    const first = deferred(),
      second = deferred()
    f.api.getHolidayDataStatus
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const ready = f.model.start()
    await flush()
    expect(f.api.onHolidayDataChanged.mock.invocationCallOrder[0]).toBeLessThan(
      f.api.getHolidayDataStatus.mock.invocationCallOrder[0]
    )
    for (let event = 0; event < 20; event++) f.listeners.changed()
    expect(f.api.getHolidayDataStatus).toHaveBeenCalledTimes(1)
    first.resolve({ available: false, old: true })
    await flush()
    expect(f.api.getHolidayDataStatus).toHaveBeenCalledTimes(2)
    expect(f.model.holidayDataStatus.value).toBeNull()
    second.resolve({ available: true, coveredYears: [2024, 2025, 2026, 2028], source: 'import' })
    await ready
    expect(f.model.holidayDataStatusLabel.value).toBe('● 数据可用')
    expect(f.model.holidayCoveredYearsLabel.value).toBe('2024–2026、2028')
    expect(f.model.holidayDataSourceLabel.value).toBe('手动导入')
    expect(f.api.getHolidayDataStatus).toHaveBeenLastCalledWith(2026)
  })
  it('retains one user action and clears busy after cancellation without a success toast', async () => {
    const f = holidayFixture(),
      pending = deferred()
    await f.model.start()
    f.api.importHolidayData.mockReturnValue(pending.promise)
    const action = f.model.importHolidayData()
    await f.model.downloadCurrentHolidayData()
    expect(f.model.holidayDataBusy.value).toBe('import')
    expect(f.api.downloadHolidayData).not.toHaveBeenCalled()
    pending.resolve({ canceled: true })
    await action
    expect(f.model.holidayDataBusy.value).toBe('')
    expect(f.model.holidayDataStatus.value).toEqual({ available: false })
    expect(f.message).not.toHaveBeenCalled()
  })
  it('preserves the pending initial local read when import is canceled', async () => {
    const f = holidayFixture(),
      initial = deferred()
    f.api.getHolidayDataStatus.mockReturnValueOnce(initial.promise)
    const ready = f.model.start()
    await flush()
    await f.model.importHolidayData()
    initial.resolve({ available: false, current: true })
    await ready
    expect(f.api.getHolidayDataStatus).toHaveBeenCalledTimes(1)
    expect(f.model.holidayDataStatus.value).toEqual({ available: false, current: true })
  })
  it('keeps the latest broadcast read when an older import response arrives later', async () => {
    const f = holidayFixture(),
      imported = deferred()
    await f.model.start()
    f.api.importHolidayData.mockReturnValue(imported.promise)
    const action = f.model.importHolidayData()
    f.api.getHolidayDataStatus.mockResolvedValue({ available: true, source: 'download' })
    f.listeners.changed()
    await flush()
    imported.resolve({ status: { available: true, source: 'import' }, importedYears: [2026] })
    await action
    expect(f.model.holidayDataStatus.value.source).toBe('download')
    expect(f.message).toHaveBeenCalledWith('success', '已导入 2026 年节假日数据')
  })
  it('preserves failure feedback and allows the next user action', async () => {
    const f = holidayFixture()
    await f.model.start()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.api.downloadHolidayData.mockRejectedValueOnce(new Error('offline'))
    await f.model.downloadCurrentHolidayData()
    expect(f.model.holidayDataError.value).toBe('offline')
    expect(f.model.holidayDataBusy.value).toBe('')
    expect(f.message).toHaveBeenCalledWith('error', 'offline', 4000)
    await f.model.downloadCurrentHolidayData()
    expect(f.model.holidayDataStatus.value.source).toBe('download')
    expect(f.model.holidayDataError.value).toBe('')
  })
  it('disposes once and ignores pending reads, mutations, link failures and retained callbacks', async () => {
    const f = holidayFixture(),
      initial = deferred(),
      imported = deferred(),
      link = deferred()
    f.api.getHolidayDataStatus.mockReturnValue(initial.promise)
    f.api.importHolidayData.mockReturnValue(imported.promise)
    f.api.openHolidayDataLink.mockReturnValue(link.promise)
    const ready = f.model.start()
    await flush()
    const action = f.model.importHolidayData(),
      open = f.model.openHolidayDataLink()
    const state = { busy: f.model.holidayDataBusy.value, error: f.model.holidayDataError.value }
    f.scope.stop()
    f.model.dispose()
    f.listeners.changed()
    initial.resolve({ available: true })
    imported.reject(new Error('late import'))
    link.reject(new Error('late open'))
    await Promise.all([ready, action, open])
    expect(f.model.holidayDataStatus.value).toBeNull()
    expect(f.model.holidayDataBusy.value).toBe(state.busy)
    expect(f.model.holidayDataError.value).toBe(state.error)
    expect(f.message).not.toHaveBeenCalled()
    expect(f.stop).toHaveBeenCalledTimes(1)
    await f.model.start()
    await f.model.downloadCurrentHolidayData()
    expect(f.api.getHolidayDataStatus).toHaveBeenCalledTimes(1)
    expect(f.api.downloadHolidayData).not.toHaveBeenCalled()
  })
})

describe('settings diagnostics owner', () => {
  it('keeps newer remote events over the pending initial read and owns delayed blur observation', async () => {
    const f = diagnosticsFixture(),
      remote = deferred()
    f.api.getRemoteHealth.mockReturnValue(remote.promise)
    const ready = f.model.start()
    await flush()
    expect(f.api.onRemoteHealthChanged.mock.invocationCallOrder[0]).toBeLessThan(
      f.api.getRemoteHealth.mock.invocationCallOrder[0]
    )
    expect(f.api.onBlurDiagnosticChanged).not.toHaveBeenCalled()
    f.listeners.remote({ available: true })
    f.model.acceptBlurSnapshot({ status: 'error' })
    remote.resolve({ available: false, error: 'old result' })
    await ready
    f.model.startBlurDiagnostics()
    f.model.startBlurDiagnostics()
    f.listeners.blur({ status: 'healthy', lastCheckedAt: 5 })
    expect(f.api.onBlurDiagnosticChanged).toHaveBeenCalledTimes(1)
    expect(f.model.remoteHealthStatus.value).toBe('available')
    expect(f.model.remoteHealthError.value).toBe('')
    expect(f.model.blurDiagnostic.value.status).toBe('healthy')
    expect(f.model.blurDiagnosticMeta.value.label).toBe('● 正常')
    expect(f.api.getRemoteHealth).toHaveBeenCalledTimes(1)
  })
  it('shares polls and manual refreshes, retaining one retry without overlapping IPC work', async () => {
    const f = diagnosticsFixture(),
      health = deferred(),
      retry = deferred()
    f.api.getSchedulerHealth.mockReturnValue(health.promise)
    f.api.retryScheduler.mockReturnValue(retry.promise)
    await f.model.start()
    vi.advanceTimersByTime(30000)
    const refresh = f.model.loadSchedulerHealth(),
      retried = f.model.retryScheduler()
    f.model.retryScheduler()
    expect(f.api.getSchedulerHealth).toHaveBeenCalledTimes(1)
    expect(f.api.retryScheduler).not.toHaveBeenCalled()
    health.resolve({ status: 'running' })
    await flush()
    expect(f.api.retryScheduler).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(20000)
    f.model.retryScheduler()
    expect(f.api.getSchedulerHealth).toHaveBeenCalledTimes(1)
    retry.resolve({ status: 'running', retried: true })
    await Promise.all([refresh, retried])
    expect(f.api.retryScheduler).toHaveBeenCalledTimes(1)
    expect(f.model.schedulerHealth.value.retried).toBe(true)
    expect(f.message).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10000)
    await flush()
    expect(f.api.getSchedulerHealth).toHaveBeenCalledTimes(2)
  })
  it('releases its one timer and both listeners and suppresses queued retry and late failures', async () => {
    const f = diagnosticsFixture(),
      health = deferred(),
      remote = deferred()
    f.api.getSchedulerHealth.mockReturnValue(health.promise)
    f.api.getRemoteHealth.mockReturnValue(remote.promise)
    const ready = f.model.start()
    f.model.startBlurDiagnostics()
    await flush()
    const retry = f.model.retryScheduler()
    expect(vi.getTimerCount()).toBe(1)
    f.scope.stop()
    f.model.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.stops.blur).toHaveBeenCalledTimes(1)
    expect(f.stops.remote).toHaveBeenCalledTimes(1)
    health.reject(new Error('late health'))
    remote.reject(new Error('late remote'))
    f.listeners.blur({ status: 'healthy' })
    f.listeners.remote({ available: true })
    await Promise.all([ready, retry])
    expect(f.api.retryScheduler).not.toHaveBeenCalled()
    expect(f.model.schedulerHealth.value).toBeNull()
    expect(f.model.remoteHealthStatus.value).toBe('checking')
    expect(f.model.blurDiagnostic.value.status).toBe('pending')
    expect(f.message).not.toHaveBeenCalled()
    await f.model.start()
    await f.model.retryScheduler()
    expect(f.api.onRemoteHealthChanged).toHaveBeenCalledTimes(1)
  })
  it('starts once, handles health/read and retry failures, and remains usable', async () => {
    const f = diagnosticsFixture()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.api.getSchedulerHealth.mockImplementationOnce(() => {
      throw new Error('health failed')
    })
    f.api.getRemoteHealth.mockRejectedValueOnce(new Error('remote failed'))
    await f.model.start()
    await f.model.start()
    expect(f.model.schedulerHealth.value).toBeNull()
    expect(f.model.remoteHealthError.value).toBe('remote failed')
    expect(vi.getTimerCount()).toBe(1)
    f.api.retryScheduler.mockRejectedValueOnce(new Error('retry failed'))
    await f.model.retryScheduler()
    expect(f.message).toHaveBeenCalledWith('error', 'retry failed')
    await f.model.retryScheduler()
    expect(f.model.schedulerHealth.value.retried).toBe(true)
    await f.model.loadRemoteHealth()
    expect(f.model.remoteHealthStatus.value).toBe('skipped')
  })
})
