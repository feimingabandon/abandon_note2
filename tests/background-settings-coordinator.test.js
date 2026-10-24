import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultSettings,
  resolveSettingsRows,
  serializeSetting
} from '../src/shared/settings-schema.js'
const repository = vi.hoisted(() => ({
  write: vi.fn(),
  used: vi.fn((id) => ({ id })),
  remove: vi.fn(),
  save: vi.fn(),
  list: vi.fn(() => [])
}))
vi.mock('../src/main/db/db-settings-repository.js', () => ({ setSettingsBatch: repository.write }))
vi.mock('../src/main/db/db-wallpapers.js', () => ({
  markWallpaperUsed: repository.used,
  deleteWallpaperVersion: repository.remove,
  saveWallpaperVersion: repository.save,
  listWallpaperRecords: repository.list
}))
vi.mock('../src/main/settings/application-settings.js', () => ({
  getViewSettingsScope: (mode) => (mode === 'list' ? 'main' : mode)
}))
import { createBackgroundSettingsCoordinator } from '../src/main/settings/background-settings-coordinator.js'
import { parseSettingsReceipt } from '../src/shared/settings-receipt.js'

function fixture({ initialized = true, holdRetirement = false } = {}) {
  const values = createDefaultSettings()
  values.wallpaper.enabled = true
  values.wallpaper.activeId = 42
  values.blur.enabled = false
  const config = { ...values.blur }
  const failure = { failed: false, error: null, nativeError: null, diagnostic: {} }
  let revision = 0
  const retirements = []
  let activeRetirement = null
  const finishRetirement = (result) => activeRetirement?.finish(result)
  const snapshot = () => ({
    source: { token: 'background-document', scope: 'main' },
    revision,
    values: structuredClone(values),
    runtime: {
      blur: {
        effectiveEnabled: config.enabled,
        error: failure.error,
        nativeError: failure.nativeError,
        diagnostic: { ...failure.diagnostic }
      }
    }
  })
  const ports = {
    getMainWindow: () => null,
    getSettings: () => values,
    getViewMode: () => 'list',
    getViewSettings: () => values,
    getActiveWindowName: () => 'main',
    refreshResolvedSettings: () => {
      revision++
      Object.assign(config, values.blur)
    },
    getResolvedSettingsSnapshot: snapshot,
    broadcastSettingsChanged: vi.fn(),
    beginWallpaperRetirement: vi.fn(() => {
      if (activeRetirement) return activeRetirement.handle
      const id = `retirement-${retirements.length + 1}`
      let resolve
      const finished = new Promise((done) => {
        resolve = done
      })
      const record = {
        finished: false,
        finish: (result) => {
          if (record.finished) return
          record.finished = true
          if (activeRetirement === record) activeRetirement = null
          resolve({ id, ...result })
        }
      }
      record.handle = {
        id,
        finished,
        cancel: vi.fn((reason) => record.finish({ status: 'cancelled', reason }))
      }
      retirements.push(record)
      activeRetirement = record
      if (!holdRetirement) record.finish({ status: 'completed', outcome: 'absent' })
      return record.handle
    }),
    persistSettingValues: vi.fn((entries) => {
      const normalized = resolveSettingsRows(
        entries.map(({ id, value }) => serializeSetting(id, value))
      )
      for (const { id } of entries) {
        const [group, key] = id.split('.')
        values[group][key] = normalized[group][key]
      }
      Object.assign(config, values.blur)
      revision++
      return snapshot()
    }),
    readBlurState: () => ({
      ...failure,
      config: { ...config },
      caps: { supported: true },
      initialized
    }),
    setRequestedConfig: (value) => Object.assign(config, value),
    clearFailure: () => {
      failure.failed = false
      failure.error = null
      failure.nativeError = null
    },
    disableConfig: () => {
      config.enabled = false
    },
    restoreFailure: (value) => Object.assign(failure, value),
    initializeBlurRuntime: vi.fn(),
    updateBlurDiagnostic: vi.fn(),
    runBlurRuntimeDiagnostic: vi.fn(),
    notifySettled: vi.fn()
  }
  repository.write.mockImplementation((_scope, entries) => {
    if (entries.some((entry) => entry.value === 'false')) values.wallpaper.enabled = false
  })
  return {
    coordinator: createBackgroundSettingsCoordinator(ports),
    ports,
    values,
    failure,
    retirements,
    finishRetirement
  }
}
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})
describe('background request ownership', () => {
  it('does not write or compensate through a successor document after the suspension wait', async () => {
    const { coordinator, ports, finishRetirement } = fixture({ holdRetirement: true })
    let current = true
    const operation = {
      context: { scope: 'main', source: { token: 'old-document', scope: 'main' } },
      isCurrent: () => current
    }
    const saving = coordinator.setBlur({ enabled: true }, operation).catch((error) => error)
    current = false
    finishRetirement({ status: 'completed', outcome: 'left' })
    expect(await saving).toMatchObject({
      success: false,
      source: operation.context.source,
      persistence: { status: 'unchanged' },
      snapshot: null
    })
    expect(await saving).not.toHaveProperty('config')
    expect(ports.persistSettingValues).not.toHaveBeenCalled()
    expect(ports.initializeBlurRuntime).not.toHaveBeenCalled()
    expect(coordinator.snapshot().pendingRequests).toBe(0)
  })

  it('keeps a saved restoration envelope separate from the blur receipt when actual state is unavailable', async () => {
    const { coordinator, ports } = fixture({ holdRetirement: true })
    const enabling = coordinator.setBlur({ enabled: true })
    const receipt = {
      kind: 'settings-saved',
      source: { token: 'background-document', scope: 'main' },
      persistence: { status: 'saved', commitId: 'restore-1' },
      snapshot: null,
      snapshotError: { message: 'resolve unavailable' }
    }
    const persist = ports.persistSettingValues.getMockImplementation()
    ports.persistSettingValues.mockImplementationOnce(persist).mockResolvedValueOnce(receipt)
    const disabled = await coordinator.setBlur({ enabled: false })
    expect(disabled.success).toBe(false)
    expect(disabled.backgroundEffects.compensation).toBe(receipt)
    expect(disabled.snapshot.snapshot).toBeNull()
    expect((await enabling).persistence.status).toBe('unchanged')
    expect(coordinator.snapshot().pendingRequests).toBe(0)
  })
  it('awaits a committed saved envelope without reading missing runtime or restoring old wallpaper', async () => {
    const { coordinator, ports, values } = fixture()
    values.wallpaper.enabled = false
    const receipt = {
      kind: 'settings-saved',
      source: { token: 'background-document', scope: 'main' },
      persistence: { status: 'saved', commitId: 'blur-1' },
      snapshot: null,
      snapshotError: { message: 'resolve unavailable' }
    }
    ports.persistSettingValues.mockResolvedValueOnce(receipt)
    const result = await coordinator.setBlur({ enabled: true })
    expect(result.success).toBe(false)
    expect(result.snapshot).toBe(receipt)
    expect(ports.persistSettingValues).toHaveBeenCalledOnce()
    expect(ports.runBlurRuntimeDiagnostic).not.toHaveBeenCalled()
    expect(coordinator.snapshot().pendingRequests).toBe(0)
  })

  it('keeps wallpaper activation settlement pending until its full post-commit receipt is ready', async () => {
    const { coordinator, ports } = fixture()
    let finish
    const pending = new Promise((resolve) => {
      finish = resolve
    })
    ports.persistSettingValues.mockReturnValueOnce(pending)
    const saving = coordinator.activateWallpaper({ id: 99 })
    expect(coordinator.snapshot().pendingRequests).toBe(1)
    coordinator.preventNewRequests()
    const drained = vi.fn()
    const drain = coordinator.settled().then(drained)
    await Promise.resolve()
    expect(drained).not.toHaveBeenCalled()
    const receipt = {
      kind: 'settings-saved',
      source: { token: 'background-document', scope: 'main' },
      persistence: { status: 'saved', commitId: 'wallpaper-1' },
      snapshot: null
    }
    finish(receipt)
    expect(await saving).toEqual({ record: { id: 99 }, snapshot: receipt })
    await drain
    expect(drained).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().wallpaperRevision).toBe(1)
  })
  it('lets a later disable supersede a waiting enable and restores its suspended wallpaper', async () => {
    const { coordinator, ports, values } = fixture()
    const enable = coordinator.setBlur({ enabled: true })
    expect(coordinator.isInFlight()).toBe(true)
    const disabled = await coordinator.setBlur({ enabled: false })
    expect(disabled.success).toBe(true)
    const superseded = await enable
    expect(values.blur.enabled).toBe(false)
    expect(values.wallpaper).toMatchObject({ enabled: true, activeId: 42 })
    expect(disabled.snapshot).toEqual(ports.getResolvedSettingsSnapshot())
    expect(superseded).toMatchObject({ persistence: { status: 'unchanged' }, snapshot: null })
    expect(coordinator.snapshot()).toMatchObject({ pendingRequests: 0, blurInFlight: 0 })
    expect(ports.notifySettled).toHaveBeenCalledOnce()
  })
  it('preserves the latest wallpaper activation instead of restoring an old suspended selection', async () => {
    const { coordinator, ports, values } = fixture()
    const enable = coordinator.setBlur({ enabled: true })
    const result = coordinator.activateWallpaper({ id: 99 })
    expect(result.record.id).toBe(99)
    const superseded = await enable
    expect(values.wallpaper).toMatchObject({ enabled: true, activeId: 99 })
    expect(values.blur.enabled).toBe(false)
    expect(superseded).toMatchObject({ persistence: { status: 'unchanged' }, snapshot: null })
    expect(ports.getResolvedSettingsSnapshot().values.wallpaper).toMatchObject({
      enabled: true,
      activeId: 99
    })
  })
  it('returns the final canonical snapshot and all normalized blur fields after a clamped save', async () => {
    const { coordinator, ports } = fixture()
    const result = await coordinator.setBlur({
      enabled: false,
      radius: 99,
      saturation: 9,
      cornerRadius: 99
    })
    expect(result.success).toBe(true)
    expect(result.config).toEqual({ enabled: false, radius: 40, saturation: 2, cornerRadius: 30 })
    expect(result.snapshot).toEqual(ports.getResolvedSettingsSnapshot())
    expect(result.snapshot.values.blur).toEqual(result.config)
    expect(result.snapshot.runtime.blur).toEqual(result.runtime)
    expect(result.snapshot.source).toEqual({ token: 'background-document', scope: 'main' })
  })
  it('includes the snapshot captured after the immediate native diagnostic', async () => {
    const { coordinator, ports, values, failure } = fixture()
    values.wallpaper.enabled = false
    ports.runBlurRuntimeDiagnostic.mockImplementation(() => {
      failure.diagnostic = { status: 'healthy', marker: 'after-diagnostic' }
    })
    const result = await coordinator.setBlur({ enabled: true, radius: 24 })
    expect(ports.runBlurRuntimeDiagnostic).toHaveBeenCalledOnce()
    expect(result.snapshot.runtime.blur.diagnostic).toEqual({
      status: 'healthy',
      marker: 'after-diagnostic'
    })
    expect(result.snapshot).toEqual(ports.getResolvedSettingsSnapshot())
    expect(result.runtime).toEqual(result.snapshot.runtime.blur)
  })
  it('includes the compensated wallpaper snapshot after confirmed native initialization failure', async () => {
    const { coordinator, ports, failure } = fixture({ initialized: false })
    ports.initializeBlurRuntime.mockImplementation(() => {
      failure.error = 'native unavailable'
      failure.nativeError = { code: 4 }
      return { success: false, error: failure.error, nativeError: failure.nativeError }
    })
    const saving = coordinator.setBlur({
      enabled: true,
      radius: 99,
      saturation: 9,
      cornerRadius: 99
    })
    const result = await saving
    expect(result.success).toBe(false)
    expect(result.config).toEqual({ enabled: false, radius: 40, saturation: 2, cornerRadius: 30 })
    expect(result.runtime.effectiveEnabled).toBe(false)
    expect(result.error).toBe('native unavailable')
    expect(result.nativeError).toEqual({ code: 4 })
    expect(result.snapshot.values.wallpaper).toMatchObject({ enabled: true, activeId: 42 })
    expect(result.snapshot).toEqual(ports.getResolvedSettingsSnapshot())
    expect(result.snapshot.runtime.blur).toEqual(result.runtime)
    expect(coordinator.isInFlight()).toBe(false)
  })
  it('restores failure and request revisions if the atomic wallpaper group fails', () => {
    const { coordinator, ports, failure } = fixture()
    Object.assign(failure, { failed: true, error: 'native failure', nativeError: { code: 4 } })
    ports.persistSettingValues.mockImplementationOnce(() => {
      throw Error('SQL failed')
    })
    expect(() => coordinator.activateWallpaper({ id: 99 })).toThrow('SQL failed')
    expect(failure).toMatchObject({
      failed: true,
      error: 'native failure',
      nativeError: { code: 4 }
    })
    expect(coordinator.snapshot()).toMatchObject({ blurRevision: 0, wallpaperRevision: 0 })
  })
  it('seals new requests and waits for the full accepted background write before the database can close', async () => {
    const { coordinator, ports } = fixture({ holdRetirement: true })
    const enable = coordinator.setBlur({ enabled: true })
    coordinator.preventNewRequests()
    let settled = false
    const drain = coordinator.settled().then(() => {
      settled = true
    })
    expect(() => coordinator.setBlur({ enabled: false })).toThrow('退出')
    await Promise.resolve()
    expect(settled).toBe(false)
    await Promise.all([enable, drain])
    expect(settled).toBe(true)
    expect(ports.persistSettingValues).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toMatchObject({
      stopped: true,
      pendingRequests: 0,
      blurInFlight: 0
    })
  })

  it('sends the visual ticket before suspension broadcast and waits beyond the old fixed delay', async () => {
    vi.useFakeTimers()
    const f = fixture({ initialized: false, holdRetirement: true })
    const saving = f.coordinator.setBlur({ enabled: true, radius: 24 })
    expect(f.ports.beginWallpaperRetirement.mock.invocationCallOrder[0]).toBeLessThan(
      f.ports.broadcastSettingsChanged.mock.invocationCallOrder[0]
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.ports.initializeBlurRuntime).not.toHaveBeenCalled()
    expect(f.ports.persistSettingValues).not.toHaveBeenCalled()
    f.finishRetirement({ status: 'completed', outcome: 'left' })
    expect((await saving).success).toBe(true)
    expect(f.ports.initializeBlurRuntime).toHaveBeenCalledOnce()
    expect(f.values.blur.radius).toBe(24)
  })

  it('requires an actual DOM answer even when SQL already says the wallpaper is disabled', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    f.values.wallpaper.enabled = false
    const saving = f.coordinator.setBlur({ enabled: true })
    expect(f.ports.beginWallpaperRetirement).toHaveBeenCalledOnce()
    expect(repository.write).not.toHaveBeenCalled()
    expect(f.ports.initializeBlurRuntime).not.toHaveBeenCalled()
    f.finishRetirement({ status: 'completed', outcome: 'absent' })
    expect((await saving).success).toBe(true)
  })

  it('shares real retirement across two enables and applies only the latest captured configuration', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    const first = f.coordinator.setBlur({ enabled: true, radius: 12 })
    const second = f.coordinator.setBlur({ enabled: true, radius: 31 })
    expect(f.retirements).toHaveLength(1)
    expect(repository.write).toHaveBeenCalledOnce()
    expect(f.ports.initializeBlurRuntime).not.toHaveBeenCalled()
    f.finishRetirement({ status: 'completed', outcome: 'left' })
    expect(await first).toMatchObject({
      success: false,
      persistence: { status: 'unchanged' },
      snapshot: null
    })
    expect((await second).success).toBe(true)
    expect(f.values.blur.radius).toBe(31)
    expect(f.ports.persistSettingValues).toHaveBeenCalledOnce()
    expect(f.ports.initializeBlurRuntime).toHaveBeenCalledOnce()
  })

  it('transfers suspension restoration to the latest enable when its native initialization fails', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    f.ports.initializeBlurRuntime.mockReturnValue({ success: false, error: 'native unavailable' })
    const first = f.coordinator.setBlur({ enabled: true, radius: 12 })
    const second = f.coordinator.setBlur({ enabled: true, radius: 31 })
    f.finishRetirement({ status: 'completed', outcome: 'left' })
    const [old, latest] = await Promise.all([first, second])
    expect(old.persistence.status).toBe('unchanged')
    expect(latest.success).toBe(false)
    expect(f.values.wallpaper).toMatchObject({ enabled: true, activeId: 42 })
    expect(latest.backgroundEffects.suspension.persistence.status).toBe('saved')
    expect(latest.backgroundEffects.compensation.values.wallpaper.enabled).toBe(true)
    expect(f.ports.persistSettingValues).toHaveBeenCalledTimes(2)
  })

  it('does not restore old wallpaper over a committed blur while its earlier application receipt is pending', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    const persist = f.ports.persistSettingValues.getMockImplementation()
    let completeApplication
    let committed
    f.ports.persistSettingValues.mockImplementationOnce((entries) => {
      committed = persist(entries)
      return new Promise((resolve) => {
        completeApplication = resolve
      })
    })
    const first = f.coordinator.setBlur({ enabled: true, radius: 12 })
    f.finishRetirement({ status: 'completed', outcome: 'left' })
    await Promise.resolve()
    await Promise.resolve()
    expect(f.values.blur.enabled).toBe(true)
    const second = f.coordinator.setBlur({ enabled: true, radius: 31 })
    f.finishRetirement({ status: 'failed', reason: 'timeout' })
    const failed = await second
    expect(failed.persistence.status).toBe('unchanged')
    expect(failed.backgroundEffects.compensation).toEqual({
      status: 'skipped',
      reason: 'blur-already-enabled'
    })
    expect(f.values.wallpaper.enabled).toBe(false)
    expect(f.ports.persistSettingValues).toHaveBeenCalledOnce()
    completeApplication(committed)
    expect((await first).success).toBe(false)
    expect(f.coordinator.snapshot()).toMatchObject({ pendingRequests: 0, blurInFlight: 0 })
  })

  it('returns an unchanged blur receipt and independent saved effects after a retirement timeout', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    const saving = f.coordinator.setBlur({ enabled: true, radius: 31 })
    f.finishRetirement({ status: 'failed', reason: 'timeout' })
    const result = await saving
    expect(result).toMatchObject({
      success: false,
      persistence: { status: 'unchanged', commitId: null },
      retirement: { status: 'failed', reason: 'timeout' },
      config: { enabled: false, radius: 12 },
      runtime: { effectiveEnabled: false }
    })
    expect(result.snapshot).not.toHaveProperty('persistence')
    expect(parseSettingsReceipt(result)).toMatchObject({ valid: true, saved: false })
    expect(result.backgroundEffects.suspension.persistence.status).toBe('saved')
    expect(result.backgroundEffects.compensation.values.wallpaper.enabled).toBe(true)
    expect(f.ports.initializeBlurRuntime).not.toHaveBeenCalled()
    expect(f.ports.persistSettingValues).toHaveBeenCalledOnce()
  })

  it('reports a failed compensation without calling the blur intent saved or enabling native', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    const saving = f.coordinator.setBlur({ enabled: true })
    f.ports.persistSettingValues.mockImplementationOnce(() => {
      throw new Error('restore SQL failed')
    })
    f.finishRetirement({ status: 'cancelled', reason: 'hidden' })
    const result = await saving
    expect(result.persistence.status).toBe('unchanged')
    expect(result.backgroundEffects.compensation).toMatchObject({
      status: 'failed',
      error: { message: 'restore SQL failed' }
    })
    expect(result.snapshot.values.wallpaper.enabled).toBe(false)
    expect(f.ports.initializeBlurRuntime).not.toHaveBeenCalled()
  })

  it('does not restore a suspension after a later explicit wallpaper disable or its late ACK', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    const saving = f.coordinator.setBlur({ enabled: true })
    await f.coordinator.disableWallpaper()
    f.retirements[0].finish({ status: 'completed', outcome: 'left' })
    const result = await saving
    expect(result.persistence.status).toBe('unchanged')
    expect(f.values.wallpaper.enabled).toBe(false)
    expect(f.ports.persistSettingValues).toHaveBeenCalledOnce()
    expect(f.ports.initializeBlurRuntime).not.toHaveBeenCalled()
    expect(f.retirements[0].handle.cancel).toHaveBeenCalledWith('wallpaper-disabled')
  })

  it('invalidates only a successfully deleted suspended selection before old completion can restore it', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    const saving = f.coordinator.setBlur({ enabled: true })
    repository.remove.mockImplementationOnce(async () => {
      f.values.wallpaper.activeId = null
      return true
    })
    expect(await f.coordinator.deleteWallpaper({ id: 42 })).toBe(true)
    f.retirements[0].finish({ status: 'completed', outcome: 'left' })
    expect((await saving).persistence.status).toBe('unchanged')
    expect(f.values.wallpaper).toMatchObject({ enabled: false, activeId: null })
    expect(f.ports.persistSettingValues).not.toHaveBeenCalled()
    expect(f.ports.initializeBlurRuntime).not.toHaveBeenCalled()
    expect(f.retirements[0].handle.cancel).toHaveBeenCalledWith('wallpaper-deleted')
  })

  it('keeps the pending retirement when deleting another wallpaper or deletion did not succeed', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    const saving = f.coordinator.setBlur({ enabled: true })
    repository.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await f.coordinator.deleteWallpaper({ id: 99 })).toBe(true)
    expect(await f.coordinator.deleteWallpaper({ id: 42 })).toBe(false)
    expect(f.retirements[0].handle.cancel).not.toHaveBeenCalled()
    f.finishRetirement({ status: 'completed', outcome: 'left' })
    expect((await saving).success).toBe(true)
  })

  it('cancels the issued visual ticket when suspension SQL fails without reporting a saved side effect', async () => {
    const f = fixture({ initialized: false, holdRetirement: true })
    repository.write.mockImplementationOnce(() => {
      throw new Error('suspension SQL failed')
    })
    await expect(f.coordinator.setBlur({ enabled: true })).rejects.toThrow('suspension SQL failed')
    expect(f.retirements[0].handle.cancel).toHaveBeenCalledWith('suspension-failed')
    expect(f.values.wallpaper.enabled).toBe(true)
    expect(f.ports.persistSettingValues).not.toHaveBeenCalled()
    expect(f.ports.initializeBlurRuntime).not.toHaveBeenCalled()
  })
})
