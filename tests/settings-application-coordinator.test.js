import { describe, expect, it, vi } from 'vitest'
import { createSettingsApplicationCoordinator } from '../src/main/settings/settings-application-coordinator.js'

const applied = () => ({ status: 'applied', error: null, retryable: false })
function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}
function fixture(ownerOptions = {}) {
  const calls = []
  let context = { scope: 'main', source: { token: 'application-document', scope: 'main' } }
  const ports = {
    getCurrentContext: vi.fn(() => context),
    isContextCurrent: vi.fn(
      (candidate) =>
        candidate.scope === context.scope &&
        candidate.source.token === context.source.token &&
        candidate.source.scope === context.source.scope
    ),
    refreshResolvedSettings: vi.fn(() => {
      calls.push('resolve')
      return false
    }),
    dependencies: {
      blurConfig: vi.fn(() => {
        calls.push('blurConfig')
        return applied()
      }),
      theme: vi.fn(() => {
        calls.push('theme')
        return applied()
      })
    },
    applyDomains: Object.fromEntries(
      ['window', 'blur', 'dock'].map((name) => [
        name,
        vi.fn(() => {
          calls.push(name)
          return applied()
        })
      ])
    ),
    retryDomains: Object.fromEntries(
      ['window', 'blur', 'dock'].map((name) => [
        name,
        vi.fn(() => {
          calls.push(`retry:${name}`)
          return applied()
        })
      ])
    ),
    getResolvedSettingsSnapshot: vi.fn(() => {
      calls.push('snapshot')
      return {
        source: context.source,
        revision: 7,
        values: { marker: 'saved-values' },
        runtime: {}
      }
    }),
    broadcastSettingsChanged: vi.fn(() => {
      calls.push('delivery')
    })
  }
  const verify = vi.fn(() => {
    calls.push('verification')
    return { status: 'completed' }
  })
  return {
    owner: createSettingsApplicationCoordinator({ ...ports, ...ownerOptions }),
    ports,
    calls,
    verify,
    context: () => context,
    setContext: (next) => {
      context = next
    }
  }
}
function complete(f, overrides = {}) {
  return f.owner.completeCommittedSettings({
    scope: 'main',
    ids: ['window.lockState', 'blur.radius', 'dock.enabledEdges'],
    verify: f.verify,
    ...overrides
  })
}

describe('post-commit settings application ownership', () => {
  it('applies a trusted main-owned commit without inventing a renderer source or canonical', async () => {
    const f = fixture()
    const context = {
      scope: 'main',
      origin: 'main-runtime',
      source: null,
      runtimeToken: 'window-1'
    }
    f.setContext(context)
    f.ports.isContextCurrent.mockImplementation(
      (candidate) => candidate.runtimeToken === 'window-1'
    )
    const result = await complete(f)
    expect(result.persistence.status).toBe('saved')
    expect(result.source).toBeNull()
    expect(result.snapshot).toBeNull()
    expect(result.application.resolve.status).toBe('applied')
    expect(f.ports.applyDomains.window).toHaveBeenCalledOnce()
    expect(f.ports.broadcastSettingsChanged).not.toHaveBeenCalled()
    expect(f.owner.snapshotLedger('main').current).toMatchObject({
      phase: 'settled',
      snapshot: { status: 'not-required', error: null, reason: 'main-runtime' },
      delivery: { status: 'skipped' }
    })
    expect(JSON.stringify(f.owner.snapshotLedger())).not.toContain('window-1')
  })

  it('does not allow an internal main context to bypass document validation in a retry', async () => {
    const f = fixture()
    const result = await f.owner.retryAppliedSettings({
      domains: ['window'],
      context: { scope: 'main', origin: 'main-runtime', source: null, runtimeToken: 'window-1' }
    })
    expect(result.persistence.status).toBe('unchanged')
    expect(result.application.status).toBe('deferred')
    expect(f.ports.refreshResolvedSettings).not.toHaveBeenCalled()
    expect(f.ports.retryDomains.window).not.toHaveBeenCalled()
  })

  it('rejects a runtime-origin retry even when it supplies a document-shaped expired source', async () => {
    const f = fixture()
    f.ports.isContextCurrent.mockReturnValue(true)
    const result = await f.owner.retryAppliedSettings({
      domains: ['window'],
      context: {
        scope: 'main',
        origin: 'main-runtime',
        source: { token: 'expired', scope: 'main' },
        runtimeToken: 'window-1'
      }
    })
    expect(result.application.status).toBe('deferred')
    expect(f.ports.refreshResolvedSettings).not.toHaveBeenCalled()
    expect(f.ports.retryDomains.window).not.toHaveBeenCalled()
  })

  it('retains blur ownership when initialization already configured the native engine', async () => {
    const f = fixture()
    const result = await complete(f, { ids: ['blur.enabled'], applyBlurRuntime: false })
    expect(f.ports.applyDomains.blur).toHaveBeenCalledOnce()
    expect(f.ports.applyDomains.blur.mock.calls[0][0].applyBlurRuntime).toBe(false)
    expect(result.application.domains.blur.status).toBe('applied')
    expect(f.owner.snapshotLedger('main').domains.blur.status).toBe('applied')
  })

  it('retains an unresolved reset dependency across unrelated saves and runs it after domains when selected', async () => {
    const f = fixture()
    const calls = []
    const resetGeometry = vi.fn(() => {
      calls.push('geometry')
      return { status: 'failed', error: 'size not observed', retryable: true }
    })
    const owner = createSettingsApplicationCoordinator({
      ...f.ports,
      dependencies: { resetGeometry },
      dependencyApplies: (_name, request) => request.reset,
      afterDomainDependencies: ['resetGeometry'],
      applyDomains: {
        window: () => {
          calls.push('window')
          return applied()
        }
      }
    })
    const first = await owner.completeCommittedSettings({
      scope: 'main',
      ids: ['window.lockState'],
      reset: true
    })
    expect(calls).toEqual(['window', 'geometry'])
    expect(first.application.dependencies.resetGeometry.status).toBe('failed')
    await owner.completeCommittedSettings({ scope: 'main', ids: ['css.fontSizeBase'] })
    expect(resetGeometry).toHaveBeenCalledOnce()
    expect(owner.snapshotLedger('main').dependencies.resetGeometry.status).toBe('failed')
    expect(owner.snapshotLedger('main').dependencies.resetGeometry.error).toBe('size not observed')
  })

  it('resolves silently before dependencies and domains and returns the actual canonical envelope', async () => {
    const f = fixture()
    const result = await complete(f)
    expect(f.calls).toEqual([
      'verification',
      'resolve',
      'blurConfig',
      'theme',
      'window',
      'blur',
      'dock',
      'snapshot',
      'delivery'
    ])
    expect(f.ports.refreshResolvedSettings).toHaveBeenCalledExactlyOnceWith({
      incrementRevision: true,
      notifyResolved: false
    })
    expect(result).toMatchObject({
      source: f.context().source,
      revision: 7,
      values: { marker: 'saved-values' },
      persistence: { status: 'saved', commitId: 'settings-commit-1' },
      application: { status: 'applied', resolve: { status: 'applied' }, superseded: false },
      verification: { status: 'completed', error: null },
      delivery: { status: 'completed', error: null }
    })
    expect(result).not.toHaveProperty('snapshot')
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('retains the saved fact and successful domain results when verification rejects', async () => {
    const f = fixture()
    f.verify.mockRejectedValueOnce(
      Object.assign(new Error('verification unavailable'), { code: 'EVIDENCE_READ_FAILED' })
    )
    const result = await complete(f)
    expect(result.persistence.status).toBe('saved')
    expect(result.application.status).toBe('applied')
    expect(result.verification).toEqual({
      status: 'failed',
      error: { message: 'verification unavailable', code: 'EVIDENCE_READ_FAILED' }
    })
    expect(f.ports.applyDomains.dock).toHaveBeenCalledOnce()
  })

  it.each(['throw', 'reject'])(
    'does not apply old values after a fresh resolve %s',
    async (mode) => {
      const f = fixture()
      f.ports.refreshResolvedSettings.mockImplementationOnce(() => {
        if (mode === 'throw') throw new Error('fresh SQLite read failed')
        return Promise.reject(new Error('fresh SQLite read failed'))
      })
      const result = await complete(f)
      expect(result).toMatchObject({
        kind: 'settings-saved',
        source: f.context().source,
        persistence: { status: 'saved' },
        snapshot: null,
        snapshotError: { message: 'fresh SQLite read failed' },
        application: { status: 'failed', resolve: { status: 'failed' } }
      })
      expect(result).not.toHaveProperty('values')
      expect(f.ports.dependencies.blurConfig).not.toHaveBeenCalled()
      expect(f.owner.snapshotLedger('main').dependencies).toMatchObject({
        blurConfig: { status: 'deferred', error: 'fresh SQLite read failed', retryable: true },
        theme: { status: 'deferred', error: 'fresh SQLite read failed', retryable: true }
      })
      for (const port of Object.values(f.ports.applyDomains)) expect(port).not.toHaveBeenCalled()
      expect(f.ports.getResolvedSettingsSnapshot).not.toHaveBeenCalled()
      expect(f.ports.broadcastSettingsChanged).not.toHaveBeenCalled()
    }
  )

  it('isolates a failed blur configuration dependency and still applies independent window and dock domains', async () => {
    const f = fixture()
    f.ports.dependencies.blurConfig.mockRejectedValueOnce(
      new Error('private blur config sync failed')
    )
    const result = await complete(f)
    expect(result.application.dependencies.blurConfig).toMatchObject({
      status: 'failed',
      error: 'private blur config sync failed'
    })
    expect(result.application.dependencies.theme.status).toBe('applied')
    expect(result.application.domains.blur).toMatchObject({
      status: 'deferred',
      error: expect.stringContaining('blurConfig')
    })
    expect(f.ports.applyDomains.blur).not.toHaveBeenCalled()
    expect(f.ports.applyDomains.window).toHaveBeenCalledOnce()
    expect(f.ports.applyDomains.dock).toHaveBeenCalledOnce()
    expect(result.application.status).toBe('failed')
  })

  it.each([
    ['false', () => false, 'failed'],
    [
      'throw',
      () => {
        throw new Error('window apply threw')
      },
      'failed'
    ],
    ['reject', () => Promise.reject(new Error('window apply rejected')), 'failed'],
    ['void', () => undefined, 'unconfirmed'],
    ['true', () => true, 'unconfirmed']
  ])(
    'records %s without assuming application or blocking the other domains',
    async (_name, operation, status) => {
      const f = fixture()
      f.ports.applyDomains.window.mockImplementationOnce(operation)
      const result = await complete(f)
      expect(result.persistence.status).toBe('saved')
      expect(result.application.domains.window.status).toBe(status)
      expect(result.application.domains.blur.status).toBe('applied')
      expect(result.application.domains.dock.status).toBe('applied')
      expect(f.ports.broadcastSettingsChanged).toHaveBeenCalledOnce()
      expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    }
  )

  it('does not substitute an old snapshot when the final snapshot read fails', async () => {
    const f = fixture()
    f.ports.getResolvedSettingsSnapshot.mockRejectedValueOnce(
      new Error('runtime observation unavailable')
    )
    const result = await complete(f)
    expect(result).toMatchObject({
      kind: 'settings-saved',
      snapshot: null,
      snapshotError: { message: 'runtime observation unavailable' },
      persistence: { status: 'saved' }
    })
    expect(result.application.domains.blur.status).toBe('applied')
    expect(result).not.toHaveProperty('values')
    expect(f.ports.broadcastSettingsChanged).not.toHaveBeenCalled()
  })

  it('rejects a foreign snapshot even if the context callback still reports current', async () => {
    const f = fixture()
    f.ports.getResolvedSettingsSnapshot.mockResolvedValueOnce({
      source: { token: 'foreign', scope: 'main' },
      revision: 8,
      values: { marker: 'foreign' }
    })
    const result = await complete(f)
    expect(result).toMatchObject({
      kind: 'settings-saved',
      source: f.context().source,
      snapshot: null,
      snapshotError: { code: 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH' }
    })
    expect(f.ports.broadcastSettingsChanged).not.toHaveBeenCalled()
  })

  it('keeps delivery rejection separate from the saved fact and actual domain application', async () => {
    const f = fixture()
    f.ports.broadcastSettingsChanged.mockRejectedValueOnce(
      new Error('renderer delivery unavailable')
    )
    const result = await complete(f)
    expect(result.values.marker).toBe('saved-values')
    expect(result.persistence.status).toBe('saved')
    expect(result.application.status).toBe('applied')
    expect(result.delivery).toEqual({
      status: 'failed',
      error: { message: 'renderer delivery unavailable' }
    })
  })

  it('contains result normalization failures inside the corresponding post-commit stage', async () => {
    const f = fixture()
    const malformed = {
      get status() {
        throw new Error('malformed domain result')
      }
    }
    f.ports.applyDomains.window.mockReturnValueOnce(malformed)
    f.verify.mockReturnValueOnce({
      get status() {
        throw new Error('malformed verification result')
      }
    })
    f.ports.getResolvedSettingsSnapshot.mockReturnValueOnce({
      get source() {
        throw new Error('malformed snapshot result')
      }
    })
    const result = await complete(f)
    expect(result).toMatchObject({
      persistence: { status: 'saved' },
      snapshot: null,
      verification: { status: 'failed', error: { message: 'malformed verification result' } },
      application: {
        status: 'failed',
        domains: {
          window: { status: 'failed', error: 'malformed domain result' },
          blur: { status: 'applied' },
          dock: { status: 'applied' }
        }
      },
      snapshotError: { message: 'malformed snapshot result' }
    })
  })

  it('records explicit verification and delivery false independently while a false resolve remains valid', async () => {
    const f = fixture()
    f.verify.mockReturnValueOnce(false)
    f.ports.broadcastSettingsChanged.mockReturnValueOnce(false)
    const result = await complete(f)
    expect(result.persistence.status).toBe('saved')
    expect(result.application.status).toBe('applied')
    expect(result.application.resolve.status).toBe('applied')
    expect(result.verification).toMatchObject({
      status: 'failed',
      error: { code: 'SETTINGS_VERIFICATION_REJECTED' }
    })
    expect(result.delivery).toMatchObject({
      status: 'failed',
      error: { code: 'SETTINGS_DELIVERY_REJECTED' }
    })
  })

  it('preserves policy-skipped verification and does not turn a void verifier into completed verification', async () => {
    const f = fixture()
    f.verify.mockReturnValueOnce({ status: 'skipped', reason: 'disabled-policy' })
    expect((await complete(f)).verification).toEqual({
      status: 'skipped',
      reason: 'disabled-policy',
      error: null
    })
    f.verify.mockReturnValueOnce(undefined)
    const result = await complete(f)
    expect(result.verification).toEqual({ status: 'unconfirmed', error: null })
    expect(result.delivery).toEqual({
      status: 'completed',
      error: null,
      confirmation: 'invocation-only'
    })
  })

  it('does not apply or snapshot a new scope when the original context expires during resolve', async () => {
    const f = fixture(),
      reading = deferred()
    f.ports.refreshResolvedSettings.mockReturnValueOnce(reading.promise)
    const operation = complete(f)
    await settle()
    f.setContext({ scope: 'week', source: { token: 'new-week-document', scope: 'week' } })
    reading.resolve(false)
    const result = await operation
    expect(result).toMatchObject({
      kind: 'settings-saved',
      source: { token: 'application-document', scope: 'main' },
      snapshot: null,
      persistence: { status: 'saved' },
      application: { status: 'deferred', superseded: true }
    })
    for (const port of Object.values(f.ports.applyDomains)) expect(port).not.toHaveBeenCalled()
    expect(f.ports.getResolvedSettingsSnapshot).not.toHaveBeenCalled()
    expect(f.owner.snapshotLedger('main').dependencies.theme).toMatchObject({
      status: 'deferred',
      error: expect.any(String),
      retryable: true
    })
  })

  it('rechecks context after an asynchronous domain and stops later effects and snapshot publication', async () => {
    const f = fixture(),
      applying = deferred()
    f.ports.applyDomains.window.mockReturnValueOnce(applying.promise)
    const operation = complete(f)
    await settle()
    expect(f.ports.applyDomains.window).toHaveBeenCalledOnce()
    f.setContext({ scope: 'main', source: { token: 'replacement-document', scope: 'main' } })
    applying.resolve(applied())
    const result = await operation
    expect(result.application.status).toBe('deferred')
    expect(result.snapshot).toBeNull()
    expect(f.ports.applyDomains.blur).not.toHaveBeenCalled()
    expect(f.ports.applyDomains.dock).not.toHaveBeenCalled()
    expect(f.ports.getResolvedSettingsSnapshot).not.toHaveBeenCalled()
  })

  it('does not let an old same-domain reply overwrite a newer retry ledger or publish a snapshot', async () => {
    const f = fixture(),
      applying = deferred()
    f.ports.applyDomains.blur.mockReturnValueOnce(applying.promise)
    const first = complete(f, { ids: ['blur.radius'] })
    await settle()
    const retry = await f.owner.retryAppliedSettings({ domains: ['blur'], context: f.context() })
    const current = f.owner.snapshotLedger('main').domains.blur
    applying.resolve({ status: 'failed', error: 'late old failure', retryable: true })
    const old = await first
    expect(retry.persistence).toEqual({ status: 'unchanged', commitId: 'settings-commit-1' })
    expect(old).toMatchObject({
      kind: 'settings-saved',
      snapshot: null,
      application: { status: 'deferred', superseded: true }
    })
    expect(f.owner.snapshotLedger('main').domains.blur).toEqual(current)
    expect(current.status).toBe('applied')
    expect(f.ports.broadcastSettingsChanged).toHaveBeenCalledOnce()
  })

  it('gives an asynchronous domain a guard that stops post-await work after replacement and after completion', async () => {
    const f = fixture(),
      waiting = deferred(),
      effects = vi.fn()
    let oldGuard, currentGuard
    f.ports.applyDomains.blur.mockImplementationOnce(async (_request, guard) => {
      oldGuard = guard
      await waiting.promise
      if (guard.isCurrent()) effects('obsolete native work')
      return applied()
    })
    f.ports.retryDomains.blur.mockImplementationOnce((_request, guard) => {
      currentGuard = guard
      expect(guard.isCurrent()).toBe(true)
      effects('current native work')
      return applied()
    })
    const first = complete(f, { ids: ['blur.radius'] })
    await settle()
    await f.owner.retryAppliedSettings({ domains: ['blur'], context: f.context() })
    expect(oldGuard.isCurrent()).toBe(false)
    expect(currentGuard.isCurrent()).toBe(false)
    waiting.resolve()
    const old = await first
    expect(old.application.superseded).toBe(true)
    expect(effects.mock.calls).toEqual([['current native work']])
    expect(oldGuard.isCurrent()).toBe(false)
    expect(JSON.stringify(old)).not.toContain('isCurrent')
    expect(JSON.stringify(f.owner.snapshotLedger())).not.toContain('isCurrent')
  })

  it('preserves an unrelated in-flight blur attempt while a font/theme commit completes', async () => {
    const f = fixture(),
      applying = deferred()
    f.ports.applyDomains.blur.mockReturnValueOnce(applying.promise)
    const first = complete(f, { ids: ['blur.radius'] })
    await settle()
    const pendingBlur = f.owner.snapshotLedger('main').domains.blur
    const font = await complete(f, { ids: ['css.fontSizeBase'] })
    expect(font.application.status).toBe('applied')
    expect(f.owner.snapshotLedger('main').domains.blur).toEqual(pendingBlur)
    const fontStages = f.owner.snapshotLedger('main').current
    applying.resolve({ status: 'failed', error: 'real independent blur failure', retryable: true })
    const blur = await first
    expect(blur.application.superseded).toBe(false)
    expect(blur.application.domains.blur.status).toBe('failed')
    expect(f.owner.snapshotLedger('main').domains.blur.error).toBe('real independent blur failure')
    expect(f.owner.snapshotLedger('main').current).toEqual(fontStages)
  })

  it('guards asynchronous font dependencies without domains against replacement and closes completed guards', async () => {
    const f = fixture(),
      waiting = deferred(),
      effects = vi.fn()
    let oldGuard, currentGuard
    f.ports.dependencies.theme
      .mockImplementationOnce(async (_request, guard) => {
        oldGuard = guard
        await waiting.promise
        if (guard.isCurrent()) effects('obsolete theme')
        return applied()
      })
      .mockImplementationOnce((_request, guard) => {
        currentGuard = guard
        expect(guard.isCurrent()).toBe(true)
        effects('current theme')
        return applied()
      })
    const first = complete(f, { ids: ['css.fontSizeBase'] })
    await settle()
    expect(oldGuard.isCurrent()).toBe(true)
    const font = await complete(f, { ids: ['css.fontSizeBase'] })
    expect(font.application.domains).toEqual({})
    expect(font.application.status).toBe('applied')
    expect(currentGuard.isCurrent()).toBe(false)
    expect(oldGuard.isCurrent()).toBe(false)
    waiting.resolve()
    const old = await first
    expect(old).toMatchObject({
      persistence: { status: 'saved' },
      snapshot: null,
      application: {
        status: 'deferred',
        superseded: true,
        dependencies: { theme: { status: 'deferred' } }
      }
    })
    expect(effects.mock.calls).toEqual([['current theme']])
    expect(f.ports.broadcastSettingsChanged).toHaveBeenCalledOnce()
    expect(f.owner.snapshotLedger('main').dependencies.theme).toEqual({
      attempt: font.application.attempt,
      status: 'applied',
      error: null,
      retryable: false
    })
    expect(oldGuard.isCurrent()).toBe(false)
    expect(JSON.stringify(old)).not.toContain('isCurrent')
  })

  it('shares window ownership across views without allowing an older global window result to replace it', async () => {
    const f = fixture(),
      applying = deferred()
    // Two admitted contexts isolate the domain ownership rule from source expiry.
    f.ports.isContextCurrent.mockImplementation((candidate) =>
      ['application-document', 'month-document'].includes(candidate.source.token)
    )
    f.ports.applyDomains.window.mockReturnValueOnce(applying.promise)
    const main = complete(f, { ids: ['window.lockState'] })
    await settle()
    f.setContext({ scope: 'month', source: { token: 'month-document', scope: 'month' } })
    const month = await complete(f, { scope: 'month', ids: ['window.lockState'] })
    const shared = f.owner.snapshotLedger('month').domains.window
    applying.resolve({ status: 'failed', error: 'late main window error', retryable: true })
    const old = await main
    expect(month.application.domains.window.status).toBe('applied')
    expect(old.application).toMatchObject({ status: 'deferred', superseded: true })
    expect(old.snapshot).toBeNull()
    expect(f.owner.snapshotLedger('main').domains.window).toEqual(shared)
    expect(f.owner.snapshotLedger('week').domains.window).toEqual(shared)
    expect(shared.status).toBe('applied')
  })

  it.each(['blur', 'dock'])(
    'keeps %s ownership independent between view scopes',
    async (domain) => {
      const f = fixture(),
        applying = deferred(),
        mainContext = f.context()
      f.ports.isContextCurrent.mockImplementation((candidate) =>
        ['application-document', 'month-document'].includes(candidate.source.token)
      )
      f.ports.applyDomains[domain].mockReturnValueOnce(applying.promise)
      const ids = [domain === 'blur' ? 'blur.radius' : 'dock.enabledEdges']
      const main = complete(f, { ids })
      await settle()
      f.setContext({ scope: 'month', source: { token: 'month-document', scope: 'month' } })
      await complete(f, { scope: 'month', ids })
      const month = f.owner.snapshotLedger('month').domains[domain]
      f.setContext(mainContext)
      applying.resolve({ status: 'failed', error: 'main-only domain failure', retryable: true })
      const old = await main
      expect(old.application.superseded).toBe(false)
      expect(f.owner.snapshotLedger('main').domains[domain].status).toBe('failed')
      expect(f.owner.snapshotLedger('month').domains[domain]).toEqual(month)
      expect(month.status).toBe('applied')
    }
  )

  it('does not let an invalid old-token retry cancel a valid in-flight domain', async () => {
    const f = fixture(),
      applying = deferred()
    f.ports.applyDomains.blur.mockReturnValueOnce(applying.promise)
    const valid = complete(f, { ids: ['blur.radius'] })
    await settle()
    const before = f.owner.snapshotLedger('main')
    const invalid = await f.owner.retryAppliedSettings({
      domains: ['blur'],
      context: { scope: 'main', source: { token: 'expired-document', scope: 'main' } }
    })
    expect(invalid.application.superseded).toBe(true)
    expect(f.owner.snapshotLedger('main').domains.blur).toEqual(before.domains.blur)
    expect(f.owner.snapshotLedger('main').commitId).toBe(before.commitId)
    expect(f.ports.retryDomains.blur).not.toHaveBeenCalled()
    applying.resolve(applied())
    const result = await valid
    expect(result.application).toMatchObject({ status: 'applied', superseded: false })
    expect(f.owner.snapshotLedger('main').domains.blur.status).toBe('applied')
  })

  it('retains a committed saved receipt without taking ownership when its source is already expired', async () => {
    const f = fixture()
    await complete(f, { ids: ['blur.radius'] })
    const before = f.owner.snapshotLedger('main')
    f.ports.getCurrentContext.mockReturnValueOnce({
      scope: 'main',
      source: { token: 'expired-document', scope: 'main' }
    })
    const result = await complete(f, { ids: ['blur.radius'] })
    expect(result).toMatchObject({
      persistence: { status: 'saved' },
      snapshot: null,
      application: { status: 'deferred', superseded: true }
    })
    expect(f.owner.snapshotLedger('main').domains.blur).toEqual(before.domains.blur)
    expect(f.owner.snapshotLedger('main').commitId).toBe(before.commitId)
  })

  it('retries only selected domains from fresh saved state and leaves other unresolved ledger entries intact', async () => {
    const f = fixture()
    f.ports.applyDomains.blur.mockReturnValueOnce({
      status: 'unconfirmed',
      error: 'native acknowledgement pending',
      retryable: true
    })
    await complete(f, { ids: ['blur.radius'] })
    const blur = f.owner.snapshotLedger('main').domains.blur
    const result = await f.owner.retryAppliedSettings({ domains: ['window'], context: f.context() })
    expect(result.persistence.status).toBe('unchanged')
    expect(f.ports.refreshResolvedSettings).toHaveBeenLastCalledWith({
      incrementRevision: false,
      notifyResolved: false
    })
    expect(f.ports.retryDomains.window).toHaveBeenCalledOnce()
    expect(f.ports.retryDomains.blur).not.toHaveBeenCalled()
    expect(f.ports.retryDomains.dock).not.toHaveBeenCalled()
    expect(f.owner.snapshotLedger('main').domains.blur).toEqual(blur)
    expect(f.ports.retryDomains.window.mock.calls[0][0]).not.toHaveProperty('values')
  })

  it('does not retry a domain against stale saved state after fresh resolve rejects', async () => {
    const f = fixture()
    f.ports.refreshResolvedSettings.mockRejectedValueOnce(new Error('retry SQLite read failed'))
    const result = await f.owner.retryAppliedSettings({ domains: ['dock'], context: f.context() })
    expect(result).toMatchObject({
      persistence: { status: 'unchanged' },
      snapshot: null,
      application: { status: 'failed' }
    })
    expect(f.ports.retryDomains.dock).not.toHaveBeenCalled()
  })

  it.each([
    { domains: ['unknown'], context: { scope: 'main' } },
    { domains: ['blur'], context: { scope: 'main' }, values: { blur: { enabled: true } } },
    { domains: [], context: { scope: 'main' } }
  ])('rejects retry requests outside the explicit domain/context contract: %j', async (input) => {
    const f = fixture()
    await expect(f.owner.retryAppliedSettings(input)).rejects.toThrow('应用重试只接受')
    expect(f.ports.refreshResolvedSettings).not.toHaveBeenCalled()
  })

  it('observes an invalid asynchronous guard rejection and never revives the expired attempt', async () => {
    const f = fixture()
    f.ports.isContextCurrent.mockImplementationOnce(() =>
      Promise.reject(new Error('guard rejected'))
    )
    const result = await complete(f)
    expect(result.application.superseded).toBe(true)
    expect(result.snapshot).toBeNull()
    expect(f.ports.refreshResolvedSettings).not.toHaveBeenCalled()
    expect(f.owner.snapshotLedger('main').errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'context',
          error: { message: '设置上下文检查必须同步返回 boolean' }
        })
      ])
    )
  })

  it('returns detached pure metadata without retaining settings values in the ledger', async () => {
    const f = fixture()
    await complete(f)
    const ledger = f.owner.snapshotLedger('main')
    ledger.domains.blur.error = 'external mutation'
    ledger.dependencies.theme.error = 'external dependency mutation'
    expect(f.owner.snapshotLedger('main').domains.blur.error).toBeNull()
    expect(f.owner.snapshotLedger('main').dependencies.theme.error).toBeNull()
    expect(JSON.stringify(f.owner.snapshotLedger())).not.toContain('saved-values')
    expect(JSON.parse(JSON.stringify(ledger))).toEqual(ledger)
  })

  it('updates current named dependency metadata after recovery while retaining its error history', async () => {
    const f = fixture()
    f.ports.dependencies.theme.mockReturnValueOnce({
      status: 'failed',
      error: 'theme application failed',
      retryable: true
    })
    const first = await complete(f, { ids: ['css.fontSizeBase'] })
    expect(f.owner.snapshotLedger('main').dependencies.theme).toEqual({
      attempt: first.application.attempt,
      status: 'failed',
      error: 'theme application failed',
      retryable: true
    })
    const recovered = await complete(f, { ids: ['css.fontSizeBase'] })
    expect(f.owner.snapshotLedger('main').dependencies.theme).toEqual({
      attempt: recovered.application.attempt,
      status: 'applied',
      error: null,
      retryable: false
    })
    expect(f.owner.snapshotLedger('main').errors).toEqual([
      {
        attempt: first.application.attempt,
        stage: 'dependency:theme',
        error: { message: 'theme application failed' }
      }
    ])
  })

  it('bounds long-session error metadata to the most recent 64 errors per scope', async () => {
    const f = fixture()
    for (let index = 0; index < 70; index += 1) {
      f.ports.dependencies.theme.mockRejectedValueOnce(new Error(`theme ${index}`))
      await complete(f, { ids: ['css.fontSizeBase'] })
    }
    const errors = f.owner.snapshotLedger('main').errors
    expect(errors).toHaveLength(64)
    expect(errors[0].error.message).toBe('theme 6')
    expect(errors.at(-1).error.message).toBe('theme 69')
    await complete(f, { ids: ['css.fontSizeBase'] })
    expect(f.owner.snapshotLedger('main').errors).toEqual(errors)
    expect(f.owner.snapshotLedger('main').dependencies.theme).toMatchObject({
      status: 'applied',
      error: null,
      retryable: false
    })
  })

  it('reads detached stage metadata without creating state or advancing the ledger revision', async () => {
    const f = fixture()
    expect(f.owner.snapshotLedger('main')).toMatchObject({ ledgerRevision: 0, current: null })
    expect(f.owner.snapshotLedger()).toEqual([])
    expect(f.owner.snapshotLedger('unknown')).toBeNull()
    const result = await complete(f)
    const first = f.owner.snapshotLedger('main')
    expect(first.ledgerRevision).toBeGreaterThan(0)
    expect(first.current).toMatchObject({
      attempt: result.application.attempt,
      reason: 'commit',
      phase: 'settled',
      targets: { domains: ['window', 'blur', 'dock'], dependencies: ['blurConfig', 'theme'] },
      resolve: { status: 'applied', error: null },
      snapshot: { status: 'available', error: null },
      verification: { status: 'completed', error: null },
      delivery: { status: 'completed', confirmation: 'invocation-only' },
      superseded: false
    })
    const before = first.ledgerRevision
    first.current.snapshot.status = 'external mutation'
    first.current.targets.dependencies.push('external mutation')
    expect(f.owner.snapshotLedger('main').current.snapshot.status).toBe('available')
    expect(f.owner.snapshotLedger('main').current.targets.dependencies).toEqual([
      'blurConfig',
      'theme'
    ])
    expect(f.owner.snapshotLedger('week')).toMatchObject({ ledgerRevision: before, current: null })
    expect(f.owner.snapshotLedger().every((record) => record.ledgerRevision === before)).toBe(true)
    expect(f.owner.snapshotLedger('main').ledgerRevision).toBe(before)
    expect(JSON.stringify(f.owner.snapshotLedger())).not.toMatch(
      /"(?:values|runtime|source|context|runtimeToken)"\s*:/
    )
  })

  it('publishes running and settled stages independently from the fixed settings revision', async () => {
    const f = fixture()
    const verification = deferred(),
      resolving = deferred(),
      snapshot = deferred(),
      delivery = deferred()
    f.ports.refreshResolvedSettings.mockReturnValueOnce(resolving.promise)
    f.ports.getResolvedSettingsSnapshot.mockReturnValueOnce(snapshot.promise)
    f.ports.broadcastSettingsChanged.mockReturnValueOnce(delivery.promise)
    const pending = complete(f, { ids: ['css.fontSizeBase'], verify: () => verification.promise })
    const running = f.owner.snapshotLedger('main')
    expect(running.current).toMatchObject({
      phase: 'running',
      snapshot: { status: 'pending' },
      verification: { status: 'unconfirmed', reason: 'pending' }
    })
    verification.resolve({ status: 'completed' })
    await settle()
    expect(f.owner.snapshotLedger('main').current.verification.status).toBe('completed')
    resolving.resolve(false)
    await settle()
    expect(f.owner.snapshotLedger('main').current).toMatchObject({
      phase: 'running',
      resolve: { status: 'applied' },
      snapshot: { status: 'pending' }
    })
    snapshot.resolve({
      source: f.context().source,
      revision: 7,
      values: { marker: 'saved-values' }
    })
    await settle()
    expect(f.owner.snapshotLedger('main').current).toMatchObject({
      phase: 'running',
      snapshot: { status: 'available' },
      delivery: { status: 'unconfirmed', reason: 'pending' }
    })
    delivery.resolve(false)
    const result = await pending
    const finished = f.owner.snapshotLedger('main')
    expect(result.revision).toBe(7)
    expect(finished.ledgerRevision).toBeGreaterThan(running.ledgerRevision)
    expect(finished.current).toMatchObject({
      phase: 'settled',
      delivery: { status: 'failed', error: { code: 'SETTINGS_DELIVERY_REJECTED' } }
    })
    expect(finished.current.snapshot).not.toHaveProperty('values')
  })

  it('retries only a selected fixed dependency and retains its actual unconfirmed outcome', async () => {
    const f = fixture()
    const policy = vi.fn(() => false)
    const resetGeometry = vi.fn(applied)
    const owner = createSettingsApplicationCoordinator({
      ...f.ports,
      dependencies: { ...f.ports.dependencies, resetGeometry },
      dependencyApplies: policy,
      afterDomainDependencies: ['resetGeometry']
    })
    f.ports.dependencies.theme.mockImplementationOnce(() => {
      f.calls.push('theme')
      return {
        status: 'unconfirmed',
        error: 'host has no ACK',
        retryable: true
      }
    })
    const result = await owner.retryAppliedSettings({
      domains: [],
      dependencies: ['theme'],
      context: f.context()
    })
    expect(f.calls).toEqual(['resolve', 'theme', 'snapshot', 'delivery'])
    expect(f.ports.dependencies.theme).toHaveBeenCalledOnce()
    expect(policy).not.toHaveBeenCalled()
    expect(resetGeometry).not.toHaveBeenCalled()
    for (const port of Object.values(f.ports.retryDomains)) expect(port).not.toHaveBeenCalled()
    expect(result.persistence).toEqual({ status: 'unchanged', commitId: null })
    expect(result.application.status).toBe('unconfirmed')
    expect(owner.snapshotLedger('main').current).toMatchObject({
      reason: 'retry',
      phase: 'settled',
      targets: { domains: [], dependencies: ['theme'] },
      verification: { status: 'skipped' }
    })
    expect(owner.snapshotLedger('main').dependencies.theme.status).toBe('unconfirmed')
    expect(f.ports.dependencies.theme.mock.calls[0][0]).not.toHaveProperty('values')
  })

  it('adds only the selected domain prerequisites for an explicit retry', async () => {
    const f = fixture()
    await f.owner.retryAppliedSettings({
      domains: ['blur', 'blur'],
      dependencies: [],
      context: f.context()
    })
    expect(f.calls).toEqual(['resolve', 'blurConfig', 'retry:blur', 'snapshot', 'delivery'])
    expect(f.ports.dependencies.theme).not.toHaveBeenCalled()
    expect(f.owner.snapshotLedger('main').current.targets).toEqual({
      domains: ['blur'],
      dependencies: ['blurConfig']
    })
  })

  it('allows explicit empty targets to reread without replacing unresolved target ownership', async () => {
    const f = fixture()
    f.ports.applyDomains.blur.mockReturnValueOnce({
      status: 'failed',
      error: 'blur failed',
      retryable: true
    })
    f.ports.dependencies.theme.mockReturnValueOnce({
      status: 'unconfirmed',
      error: 'no ACK',
      retryable: true
    })
    const saved = await complete(f, { ids: ['blur.radius'] })
    const before = f.owner.snapshotLedger('main')
    f.calls.length = 0
    const result = await f.owner.retryAppliedSettings({
      domains: [],
      dependencies: [],
      context: f.context()
    })
    expect(f.calls).toEqual(['resolve', 'snapshot', 'delivery'])
    expect(result.persistence).toEqual({
      status: 'unchanged',
      commitId: saved.persistence.commitId
    })
    const after = f.owner.snapshotLedger('main')
    expect(after.current.targets).toEqual({ domains: [], dependencies: [] })
    expect(after.current.resolve.status).toBe('applied')
    expect(after.domains).toEqual(before.domains)
    expect(after.dependencies).toEqual(before.dependencies)
    expect(after.errors).toEqual(before.errors)
    expect(after.ledgerRevision).toBeGreaterThan(before.ledgerRevision)
  })

  it('retains the old fixed dependency policy only when dependencies is omitted', async () => {
    const f = fixture()
    const resetGeometry = vi.fn(() => {
      f.calls.push('resetGeometry')
      return applied()
    })
    const policy = vi.fn((_name, request) => request.reason === 'retry')
    const owner = createSettingsApplicationCoordinator({
      ...f.ports,
      dependencies: { ...f.ports.dependencies, resetGeometry },
      dependencyApplies: policy,
      afterDomainDependencies: ['resetGeometry']
    })
    await owner.retryAppliedSettings({ domains: ['window'], context: f.context() })
    expect(f.calls).toEqual([
      'resolve',
      'blurConfig',
      'theme',
      'retry:window',
      'resetGeometry',
      'snapshot',
      'delivery'
    ])
    expect(policy).toHaveBeenCalledTimes(3)
    f.calls.length = 0
    await owner.retryAppliedSettings({
      domains: ['window'],
      dependencies: [],
      context: f.context()
    })
    expect(f.calls).toEqual(['resolve', 'retry:window', 'snapshot', 'delivery'])
    expect(resetGeometry).toHaveBeenCalledOnce()
    expect(policy).toHaveBeenCalledTimes(3)
  })

  it.each([
    { domains: [], dependencies: ['unknown'] },
    { domains: [], dependencies: ['__proto__'] },
    { domains: [], dependencies: undefined },
    { domains: [], dependencies: 'theme' },
    { domains: Array(1), dependencies: [] },
    { domains: [], dependencies: Array(1) },
    { domains: ['unknown'], dependencies: [] },
    { domains: [], dependencies: ['theme'], values: { stale: true } },
    { domains: [], dependencies: [], payload: { stale: true } }
  ])('rejects invalid precise retry targets before acquiring ownership: %j', async (selection) => {
    const f = fixture()
    await expect(
      f.owner.retryAppliedSettings({ ...selection, context: f.context() })
    ).rejects.toThrow('应用重试只接受')
    expect(f.ports.refreshResolvedSettings).not.toHaveBeenCalled()
    expect(f.owner.snapshotLedger('main')).toMatchObject({ ledgerRevision: 0, current: null })
  })

  it('rejects an unregistered domain prerequisite without acquiring ownership', async () => {
    const f = fixture()
    const owner = createSettingsApplicationCoordinator({
      ...f.ports,
      dependencies: { theme: f.ports.dependencies.theme }
    })
    await expect(
      owner.retryAppliedSettings({ domains: ['blur'], dependencies: [], context: f.context() })
    ).rejects.toThrow('固定依赖')
    expect(owner.snapshotLedger('main')).toMatchObject({ ledgerRevision: 0, current: null })
  })

  it('does not let an invalid precise retry replace current stage metadata or an in-flight owner', async () => {
    const f = fixture(),
      applying = deferred()
    f.ports.applyDomains.blur.mockReturnValueOnce(applying.promise)
    const first = complete(f, { ids: ['blur.radius'] })
    await settle()
    const before = f.owner.snapshotLedger('main')
    const rejected = await f.owner.retryAppliedSettings({
      domains: ['blur'],
      dependencies: [],
      context: { scope: 'main', source: { scope: 'main', token: 'expired-document' } }
    })
    expect(rejected.application.superseded).toBe(true)
    expect(f.owner.snapshotLedger('main').current).toEqual(before.current)
    expect(f.owner.snapshotLedger('main').domains.blur).toEqual(before.domains.blur)
    applying.resolve(applied())
    await first
    expect(f.owner.snapshotLedger('main').domains.blur.status).toBe('applied')
  })

  it('keeps an explicitly selected dependency alive after another attempt replaces all its domains', async () => {
    const f = fixture(),
      resolving = deferred()
    f.ports.refreshResolvedSettings.mockReturnValueOnce(resolving.promise)
    const first = f.owner.retryAppliedSettings({
      domains: ['window'],
      dependencies: ['theme'],
      context: f.context()
    })
    await settle()
    const themeAttempt = f.owner.snapshotLedger('main').dependencies.theme.attempt
    const replacement = await f.owner.retryAppliedSettings({
      domains: ['window'],
      dependencies: [],
      context: f.context()
    })
    const before = f.owner.snapshotLedger('main')
    resolving.resolve(false)
    const old = await first
    expect(f.ports.dependencies.theme).toHaveBeenCalledOnce()
    expect(f.ports.retryDomains.window).toHaveBeenCalledOnce()
    expect(old.application).toMatchObject({
      superseded: true,
      domains: { window: { status: 'deferred' } },
      dependencies: { theme: { status: 'applied' } }
    })
    const after = f.owner.snapshotLedger('main')
    expect(after.dependencies.theme).toMatchObject({ attempt: themeAttempt, status: 'applied' })
    expect(after.domains.window).toEqual(before.domains.window)
    expect(after.domains.window.attempt).toBe(replacement.application.attempt)
    expect(after.current).toEqual(before.current)
  })

  it('coalesces detached revision notifications and permits observer reads without recursion', async () => {
    let f
    const delivered = []
    const observer = vi.fn((notification) => {
      delivered.push({
        notification: structuredClone(notification),
        snapshot: f.owner.snapshotLedger('main')
      })
      f.owner.snapshotLedger()
      f.owner.snapshotLedger('week')
      notification.scopes.push('external mutation')
    })
    f = fixture({ onLedgerChanged: observer })
    const pending = complete(f, { ids: ['window.lockState'] })
    expect(observer).not.toHaveBeenCalled()
    await pending
    await settle()
    expect(delivered.length).toBeGreaterThan(0)
    expect(delivered[0].notification.scopes).toEqual(['main', 'month', 'week'])
    for (let index = 0; index < delivered.length; index += 1) {
      const entry = delivered[index]
      expect(entry.notification.ledgerRevision).toBe(entry.snapshot.ledgerRevision)
      expect(entry.notification.scopes).not.toContain('external mutation')
      if (index)
        expect(entry.notification.ledgerRevision).toBeGreaterThan(
          delivered[index - 1].notification.ledgerRevision
        )
    }
    const count = observer.mock.calls.length
    const revision = f.owner.snapshotLedger('main').ledgerRevision
    f.owner.snapshotLedger()
    await settle()
    expect(observer).toHaveBeenCalledTimes(count)
    expect(f.owner.snapshotLedger('main').ledgerRevision).toBe(revision)
  })

  it.each(['throw', 'reject'])(
    'isolates an observer %s from application status and bounded error history',
    async (mode) => {
      const observer = vi.fn(() => {
        if (mode === 'throw') throw new Error('observer transport failed')
        return Promise.reject(new Error('observer transport rejected'))
      })
      const f = fixture({ onLedgerChanged: observer })
      const result = await complete(f)
      await settle()
      expect(observer).toHaveBeenCalled()
      expect(result.application.status).toBe('applied')
      expect(result.delivery.status).toBe('completed')
      expect(f.owner.snapshotLedger('main').errors).toEqual([])
      expect(f.owner.snapshotLedger('main').current.phase).toBe('settled')
    }
  )

  it('does not await a notification observer that never settles', async () => {
    const observer = vi.fn(() => new Promise(() => {}))
    const f = fixture({ onLedgerChanged: observer })
    const result = await complete(f)
    expect(observer).toHaveBeenCalled()
    expect(result.application.status).toBe('applied')
    expect(f.owner.snapshotLedger('main').current.phase).toBe('settled')
  })

  it.each(['resolve', 'snapshot', 'verification'])(
    'keeps current %s stage failure separate from saved data and history',
    async (stage) => {
      const f = fixture()
      const failure = new Error('current ' + stage + ' failed')
      const options = {}
      if (stage === 'resolve') f.ports.refreshResolvedSettings.mockRejectedValueOnce(failure)
      if (stage === 'snapshot') f.ports.getResolvedSettingsSnapshot.mockRejectedValueOnce(failure)
      if (stage === 'verification')
        options.verify = () => {
          throw failure
        }
      const result = await complete(f, options)
      const current = f.owner.snapshotLedger('main').current
      expect(result.persistence.status).toBe('saved')
      expect(current.phase).toBe('settled')
      if (stage === 'snapshot') {
        expect(current.snapshot).toEqual({
          status: 'unavailable',
          error: { message: failure.message }
        })
        expect(current.resolve.status).toBe('applied')
      } else expect(current[stage].status).toBe('failed')
      const errors = f.owner.snapshotLedger('main').errors
      expect(errors).toContainEqual(
        expect.objectContaining({ stage, error: { message: failure.message } })
      )
      await complete(f)
      const recovered = f.owner.snapshotLedger('main')
      expect(recovered.current.snapshot.status).toBe('available')
      expect(recovered.current.resolve.status).toBe('applied')
      expect(recovered.current.verification.status).toBe('completed')
      expect(recovered.errors).toEqual(errors)
    }
  )
})
