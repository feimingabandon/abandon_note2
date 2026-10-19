import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
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

function fixture() {
  const values = createDefaultSettings()
  values.wallpaper.enabled = true
  values.wallpaper.activeId = 42
  values.blur.enabled = false
  const config = { ...values.blur }
  const failure = { failed: false, error: null, nativeError: null, diagnostic: {} }
  let revision = 0
  const snapshot = () => ({
    revision,
    values,
    runtime: {
      blur: {
        effectiveEnabled: config.enabled,
        error: failure.error,
        nativeError: failure.nativeError
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
    persistSettingValues: vi.fn((entries) => {
      for (const { id, value } of entries) {
        const [group, key] = id.split('.')
        values[group][key] = value
      }
      Object.assign(config, values.blur)
      revision++
      return snapshot()
    }),
    readBlurState: () => ({
      ...failure,
      config: { ...config },
      caps: { supported: true },
      initialized: true
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
  return { coordinator: createBackgroundSettingsCoordinator(ports), ports, values, failure }
}
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})
describe('background request ownership', () => {
  it('lets a later disable supersede a waiting enable and restores its suspended wallpaper', async () => {
    vi.useFakeTimers()
    const { coordinator, ports, values } = fixture()
    const enable = coordinator.setBlur({ enabled: true })
    expect(coordinator.isInFlight()).toBe(true)
    const disabled = await coordinator.setBlur({ enabled: false })
    expect(disabled.success).toBe(true)
    await vi.advanceTimersByTimeAsync(190)
    await enable
    expect(values.blur.enabled).toBe(false)
    expect(values.wallpaper).toMatchObject({ enabled: true, activeId: 42 })
    expect(coordinator.snapshot()).toMatchObject({ pendingRequests: 0, blurInFlight: 0 })
    expect(ports.notifySettled).toHaveBeenCalledOnce()
  })
  it('preserves the latest wallpaper activation instead of restoring an old suspended selection', async () => {
    vi.useFakeTimers()
    const { coordinator, values } = fixture()
    const enable = coordinator.setBlur({ enabled: true })
    const result = coordinator.activateWallpaper({ id: 99 })
    expect(result.record.id).toBe(99)
    await vi.advanceTimersByTimeAsync(190)
    await enable
    expect(values.wallpaper).toMatchObject({ enabled: true, activeId: 99 })
    expect(values.blur.enabled).toBe(false)
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
    vi.useFakeTimers()
    const { coordinator, ports } = fixture()
    const enable = coordinator.setBlur({ enabled: true })
    coordinator.preventNewRequests()
    let settled = false
    const drain = coordinator.settled().then(() => {
      settled = true
    })
    expect(() => coordinator.setBlur({ enabled: false })).toThrow('退出')
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(190)
    await Promise.all([enable, drain])
    expect(settled).toBe(true)
    expect(ports.persistSettingValues).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({
      stopped: true,
      pendingRequests: 0,
      blurInFlight: 0
    })
  })
})
