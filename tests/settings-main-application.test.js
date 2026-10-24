import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createSettingsApplicationCoordinator } from '../src/main/settings/settings-application-coordinator.js'
import { unavailableShortcuts } from '../src/shared/shortcut-status.js'

const mainSource = readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8')

// Exercise the production adapters without starting Electron or substituting
// copies of their bodies. All platform effects remain explicit injected ports.
function mainAdapters(ports) {
  const start = mainSource.indexOf('function applyResetSettingsGeometry(')
  const end = mainSource.indexOf('function applyResolvedWindowRuntime(', start)
  if (start < 0 || end <= start) throw new Error('Main settings adapters were not found')
  return new Function(
    ...Object.keys(ports),
    mainSource.slice(start, end) +
      '\nreturn { applyResetSettingsGeometry, applyResetShortcutBindings, observeAppliedBlurRuntime, applyCommittedBlurRuntime };'
  )(...Object.values(ports))
}

const applied = () => ({ status: 'applied', error: null, retryable: false })

function fixture() {
  const context = { scope: 'main', source: { token: 'main-application-document', scope: 'main' } }
  const settingsRuntime = {
    values: {
      shortcuts: { enabled: true, viewVisibility: 'F9' },
      geometry: { width: 900, height: 650, widthRatio: 0.6, heightRatio: 0.7 },
      blur: { enabled: true, radius: 18 }
    }
  }
  const bounds = { x: 10, y: 20, width: 900, height: 650 }
  const window = {
    isDestroyed: vi.fn(() => false),
    getBounds: vi.fn(() => ({ ...bounds })),
    setSize: vi.fn((width, height) => Object.assign(bounds, { width, height }))
  }
  const blurRuntime = {
    config: { enabled: true },
    initialized: true,
    failed: false,
    error: null,
    diagnostic: { status: 'healthy', message: '' }
  }
  const ports = {
    getMainWindow: vi.fn(() => window),
    screen: { getDisplayMatching: vi.fn(() => ({ workAreaSize: { width: 1000, height: 800 } })) },
    settingsRuntime,
    geometryPersistence: { suppressUntil: vi.fn() },
    blurRuntime,
    runBlurRuntimeDiagnostic: vi.fn(),
    applyResolvedBlurRuntime: vi.fn(applied),
    viewVisibilityShortcutService: {
      initialize: vi.fn(),
      snapshot: vi.fn(() => ({ enabled: true, configured: 'F9', registered: true }))
    },
    captureShortcutService: { initialize: vi.fn(), snapshot: vi.fn(() => ({})) },
    rebuildTrayMenu: vi.fn(),
    unavailableShortcuts
  }
  const adapters = mainAdapters(ports)
  let owner
  const refreshResolvedSettings = vi.fn()
  owner = createSettingsApplicationCoordinator({
    getCurrentContext: () => context,
    isContextCurrent: (candidate) => candidate.source?.token === context.source.token,
    refreshResolvedSettings,
    dependencies: { resetGeometry: adapters.applyResetSettingsGeometry },
    dependencyApplies: (_name, request) =>
      request.reset ||
      (request.reason === 'retry' &&
        ['failed', 'deferred', 'unconfirmed'].includes(
          owner.snapshotLedger(request.scope).dependencies.resetGeometry?.status
        )),
    afterDomainDependencies: ['resetGeometry'],
    domainDependencies: {},
    applyDomains: { window: applied, blur: adapters.applyCommittedBlurRuntime },
    retryDomains: { window: applied, blur: adapters.applyCommittedBlurRuntime },
    getResolvedSettingsSnapshot: () => ({
      source: context.source,
      revision: 2,
      values: structuredClone(settingsRuntime.values)
    }),
    broadcastSettingsChanged: vi.fn()
  })
  return {
    context,
    settingsRuntime,
    bounds,
    window,
    blurRuntime,
    ports,
    adapters,
    owner,
    refreshResolvedSettings
  }
}

function commitBlur(f, options = {}) {
  return f.owner.completeCommittedSettings({ scope: 'main', ids: ['blur.radius'], ...options })
}

describe('main settings application adapters', () => {
  it('reports a reset shortcut registration conflict as failed while retaining its domain evidence', () => {
    const f = fixture()
    f.ports.captureShortcutService.snapshot.mockReturnValue({
      screenshot: {
        enabled: true,
        configured: 'F1',
        registered: false,
        capturing: false,
        error: { message: 'accelerator in use' }
      }
    })
    expect(f.adapters.applyResetShortcutBindings()).toMatchObject({
      status: 'failed',
      error: 'accelerator in use',
      retryable: true,
      shortcuts: { screenshot: { registered: false } }
    })
  })

  it('keeps a reset shortcut awaiting registration during capture as deferred', () => {
    const f = fixture()
    f.ports.viewVisibilityShortcutService.snapshot.mockReturnValue({
      enabled: true,
      configured: 'F9',
      registered: false,
      capturing: true
    })
    expect(f.adapters.applyResetShortcutBindings().status).toBe('deferred')
  })

  it('does not claim a missing shortcut service has applied a reset', () => {
    const f = fixture()
    const ports = { ...f.ports, captureShortcutService: null }
    expect(mainAdapters(ports).applyResetShortcutBindings().status).toBe('deferred')
    expect(f.ports.viewVisibilityShortcutService.initialize).not.toHaveBeenCalled()
  })
  it('records native diagnostic health failure in the saved receipt and blur ledger', async () => {
    const f = fixture()
    f.ports.runBlurRuntimeDiagnostic.mockImplementation(() => {
      f.blurRuntime.failed = true
      f.blurRuntime.config.enabled = false
      f.blurRuntime.error = 'native overlay failed health check'
      f.blurRuntime.diagnostic = { status: 'error', message: f.blurRuntime.error }
    })
    const result = await commitBlur(f)
    expect(f.ports.applyResolvedBlurRuntime).toHaveBeenCalledOnce()
    expect(f.ports.runBlurRuntimeDiagnostic).toHaveBeenCalledExactlyOnceWith({
      reason: 'settings-change',
      now: expect.any(Number)
    })
    expect(result.persistence.status).toBe('saved')
    expect(result.application.status).toBe('failed')
    expect(result.application.domains.blur).toMatchObject({
      status: 'failed',
      error: 'native overlay failed health check',
      retryable: true
    })
    expect(f.owner.snapshotLedger('main').domains.blur).toMatchObject({
      status: 'failed',
      error: 'native overlay failed health check',
      retryable: true
    })
  })

  it('keeps persistence saved when diagnostic compensation throws after the native operation', async () => {
    const f = fixture()
    const compensate = vi.fn(() => {
      throw new Error('disable compensation failed')
    })
    f.ports.runBlurRuntimeDiagnostic.mockImplementation(() => {
      f.blurRuntime.failed = true
      compensate()
    })
    const result = await commitBlur(f)
    expect(compensate).toHaveBeenCalledOnce()
    expect(result.persistence.status).toBe('saved')
    expect(result.application.domains.blur).toMatchObject({
      status: 'failed',
      error: 'disable compensation failed'
    })
    expect(f.owner.snapshotLedger('main').domains.blur).toMatchObject({
      status: 'failed',
      error: 'disable compensation failed'
    })
    expect(f.refreshResolvedSettings).toHaveBeenCalledOnce()
  })

  it('retains blur ownership without reconfiguring an initialized engine or inventing a new acknowledgement', async () => {
    const f = fixture()
    const result = await commitBlur(f, { applyBlurRuntime: false })
    expect(f.ports.applyResolvedBlurRuntime).not.toHaveBeenCalled()
    expect(f.ports.runBlurRuntimeDiagnostic).toHaveBeenCalledOnce()
    expect(result.persistence.status).toBe('saved')
    expect(result.application.domains.blur).toMatchObject({
      status: 'unconfirmed',
      retryable: true
    })
    expect(f.owner.snapshotLedger('main').domains.blur).toMatchObject({ status: 'unconfirmed' })
    expect(result.application.status).toBe('unconfirmed')
  })

  it.each([true, false])(
    'does not enter native configuration or diagnosis after guard invalidation, configure=%s',
    (applyBlurRuntime) => {
      const f = fixture()
      const guard = { isCurrent: () => false }
      expect(f.adapters.applyCommittedBlurRuntime({ applyBlurRuntime }, guard).status).toBe(
        'deferred'
      )
      expect(f.adapters.observeAppliedBlurRuntime(applied(), guard).status).toBe('deferred')
      expect(f.ports.applyResolvedBlurRuntime).not.toHaveBeenCalled()
      expect(f.ports.runBlurRuntimeDiagnostic).not.toHaveBeenCalled()
    }
  )

  it('chooses default display ratios for a newly committed reset', async () => {
    const f = fixture()
    const result = await f.owner.completeCommittedSettings({
      scope: 'main',
      ids: ['window.lockState'],
      reset: true
    })
    expect(f.window.setSize).toHaveBeenCalledExactlyOnceWith(600, 560)
    expect(result.persistence.status).toBe('saved')
    expect(result.application.dependencies.resetGeometry.status).toBe('applied')
    expect(f.ports.geometryPersistence.suppressUntil).toHaveBeenCalledWith(expect.any(Number))
  })

  it('retries unresolved reset geometry from the latest saved dimensions instead of replaying old ratios', async () => {
    const f = fixture()
    f.window.setSize.mockImplementationOnce(() => {})
    const resetting = await f.owner.completeCommittedSettings({
      scope: 'main',
      ids: ['window.lockState'],
      reset: true
    })
    expect(resetting.application.dependencies.resetGeometry.status).toBe('unconfirmed')
    expect(f.window.setSize).toHaveBeenLastCalledWith(600, 560)
    Object.assign(f.settingsRuntime.values.geometry, { width: 735, height: 455 })
    const retry = await f.owner.retryAppliedSettings({ domains: ['window'], context: f.context })
    expect(f.window.setSize).toHaveBeenLastCalledWith(735, 455)
    expect(f.window.setSize).toHaveBeenCalledTimes(2)
    expect(retry.persistence.status).toBe('unchanged')
    expect(retry.application.dependencies.resetGeometry.status).toBe('applied')
    expect(f.owner.snapshotLedger('main').dependencies.resetGeometry.status).toBe('applied')
  })
})
