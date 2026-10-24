import { describe, expect, it, vi } from 'vitest'
import { createMainWindowIpc } from '../src/main/ipc/ipc-authorization.js'
import { registerSettingsApplicationIpc } from '../src/main/ipc/register-settings-application-ipc.js'
import { createSettingsOperationAdmission } from '../src/main/settings/settings-operation-admission.js'
import { createSettingsApplicationCoordinator } from '../src/main/settings/settings-application-coordinator.js'
import { isSettingsApplicationState } from '../src/shared/settings-application-state.js'

function fixture() {
  const handlers = new Map([['unrelated', () => true]])
  const source = { token: 'document', scope: 'main' }
  let active = source
  const window = { webContents: {}, isDestroyed: () => false }
  const event = { sender: window.webContents }
  const ipc = {
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error('duplicate')
      handlers.set(channel, listener)
    },
    removeHandler: vi.fn((channel) => handlers.delete(channel))
  }
  const operations = createSettingsOperationAdmission()
  const assertDocument = vi.fn((_event, context) => {
    if (context.token !== active.token || context.scope !== active.scope)
      throw new Error('expired document')
    return { scope: context.scope }
  })
  const writeSource = {
    assertDocument,
    assert: vi.fn((...args) => {
      assertDocument(...args)
      operations.assertOpen()
      return source.scope
    })
  }
  const ledger = {
    scope: 'main',
    ledgerRevision: 4,
    current: null,
    commitId: 'one',
    domains: {},
    dependencies: {},
    errors: []
  }
  const receipt = {
    source,
    revision: 0,
    values: {},
    persistence: { status: 'unchanged', commitId: 'one' }
  }
  const coordinator = {
    snapshotLedger: vi.fn(() => structuredClone(ledger)),
    retryAppliedSettings: vi.fn(async () => receipt)
  }
  const register = () =>
    registerSettingsApplicationIpc({
      mainWindowIpc: createMainWindowIpc(ipc, () => window),
      removeHandler: ipc.removeHandler,
      settingsWriteSource: writeSource,
      settingsOperations: operations,
      coordinator
    })
  return {
    handlers,
    source,
    event,
    operations,
    writeSource,
    coordinator,
    receipt,
    register,
    replace: () => {
      active = { ...source, token: 'replacement' }
    }
  }
}

describe('settings application state and retry transport', () => {
  it('projects actual owner stages through the transport without inventing host confirmation', async () => {
    const f = fixture()
    const refresh = vi.fn(() => false)
    const theme = vi.fn(() => undefined)
    const owner = createSettingsApplicationCoordinator({
      getCurrentContext: () => ({ scope: 'main', source: f.source }),
      isContextCurrent: (context) => context.source?.token === f.source.token,
      refreshResolvedSettings: refresh,
      dependencies: { theme },
      getResolvedSettingsSnapshot: () => ({
        source: f.source,
        revision: 1,
        values: { css: { fontSizeBase: 18 } }
      }),
      broadcastSettingsChanged: () => undefined
    })
    f.coordinator.snapshotLedger = owner.snapshotLedger
    f.coordinator.retryAppliedSettings = owner.retryAppliedSettings
    f.register()
    const initial = f.handlers.get('settings:application-state')(f.event, f.source)
    expect(isSettingsApplicationState(initial, { source: f.source })).toBe(true)
    expect(initial.ledger.current).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
    const result = await f.handlers.get('settings:retry-application')(
      f.event,
      { domains: [], dependencies: ['theme'] },
      f.source
    )
    expect(result.persistence.status).toBe('unchanged')
    expect(isSettingsApplicationState(result.applicationState, { source: f.source })).toBe(true)
    expect(result.applicationState.ledgerRevision).toBeGreaterThan(initial.ledgerRevision)
    expect(result.applicationState.ledger.current).toMatchObject({
      phase: 'settled',
      snapshot: { status: 'available' }
    })
    expect(result.applicationState.ledger.dependencies.theme.status).toBe('unconfirmed')
    expect(theme).toHaveBeenCalledOnce()
    expect(JSON.stringify(result.applicationState)).not.toContain('fontSizeBase')
    expect(JSON.stringify(result.applicationState)).not.toContain('values')
  })
  it('reads only detached metadata, even while mutation admission is sealed', async () => {
    const f = fixture()
    f.register()
    await f.operations.sealAndDrain({})
    const state = f.handlers.get('settings:application-state')(f.event, f.source)
    expect(state).toEqual({
      source: f.source,
      ledgerRevision: 4,
      ledger: expect.objectContaining({ current: null })
    })
    expect(f.coordinator.retryAppliedSettings).not.toHaveBeenCalled()
    expect(f.writeSource.assert).not.toHaveBeenCalled()
    state.source.token = 'changed'
    state.ledger.domains.window = { status: 'failed' }
    expect(f.source.token).toBe('document')
    expect(f.handlers.get('settings:application-state')(f.event, f.source).ledger.domains).toEqual(
      {}
    )
  })

  it('forwards explicit dependency-only and resolve-only targets without save values', async () => {
    const f = fixture()
    f.register()
    for (const targets of [
      { domains: [], dependencies: ['theme'] },
      { domains: [], dependencies: [] }
    ]) {
      const result = await f.handlers.get('settings:retry-application')(f.event, targets, f.source)
      expect(f.coordinator.retryAppliedSettings).toHaveBeenLastCalledWith({
        ...targets,
        context: { scope: 'main', source: f.source }
      })
      expect(result.persistence.status).toBe('unchanged')
      expect(result.applicationState.source).toEqual(f.source)
    }
    expect(f.operations.snapshot().pending).toBe(0)
  })

  it('rejects foreign windows, expired sources and arbitrary retry payloads before calling the owner', () => {
    const f = fixture()
    f.register()
    const retry = f.handlers.get('settings:retry-application')
    expect(() => retry({ sender: {} }, { domains: [], dependencies: [] }, f.source)).toThrow()
    expect(() => retry(f.event, { domains: [], dependencies: [], values: {} }, f.source)).toThrow()
    expect(() => retry(f.event, { domains: [], dependencies: ['unknown'] }, f.source)).toThrow()
    f.replace()
    expect(() => retry(f.event, { domains: [], dependencies: [] }, f.source)).toThrow('expired')
    expect(() => f.handlers.get('settings:application-state')(f.event, f.source)).toThrow('expired')
    expect(f.coordinator.retryAppliedSettings).not.toHaveBeenCalled()
  })

  it('tracks the full retry through leave while allowing metadata queries and rejecting new retries', async () => {
    const f = fixture()
    let finish
    f.coordinator.retryAppliedSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    f.register()
    const retry = f.handlers.get('settings:retry-application')
    const pending = retry(f.event, { domains: ['window'], dependencies: [] }, f.source)
    let drained = false
    const owner = {}
    const drain = f.operations.sealAndDrain(owner).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(f.operations.snapshot().pending).toBe(1)
    expect(() => retry(f.event, { domains: [], dependencies: [] }, f.source)).toThrow()
    expect(f.handlers.get('settings:application-state')(f.event, f.source).ledgerRevision).toBe(4)
    finish(f.receipt)
    await pending
    await drain
    expect(drained).toBe(true)
    expect(f.operations.resume(owner)).toBe(true)
  })

  it('does not attach replacement-document state to a late result and still releases admission', async () => {
    const f = fixture()
    let finish
    f.coordinator.retryAppliedSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    f.register()
    const pending = f.handlers.get('settings:retry-application')(
      f.event,
      { domains: [], dependencies: [] },
      f.source
    )
    f.replace()
    finish(f.receipt)
    await expect(pending).rejects.toThrow('expired')
    expect(f.coordinator.snapshotLedger).not.toHaveBeenCalled()
    expect(f.operations.snapshot().pending).toBe(0)
  })

  it('removes its two handlers idempotently without touching unrelated channels', () => {
    const f = fixture()
    const dispose = f.register()
    dispose()
    dispose()
    expect([...f.handlers.keys()]).toEqual(['unrelated'])
  })
})
