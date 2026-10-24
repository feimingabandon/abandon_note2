import { describe, expect, it, vi } from 'vitest'
import {
  createSettingsApplicationStateStore,
  getSettingsApplicationStateStore
} from '../src/renderer/src/utils/settingsApplicationState.js'
import { createSettingsSnapshotStore } from '../src/renderer/src/utils/settingsSnapshots.js'

const source = { token: 'application-document', scope: 'main' }
function envelope(revision, status = 'unconfirmed') {
  return {
    source,
    ledgerRevision: revision,
    ledger: {
      scope: 'main',
      commitId: 'saved-once',
      current: {
        attempt: revision,
        reason: 'commit',
        phase: 'settled',
        targets: { domains: [], dependencies: ['theme'] },
        resolve: { status: 'applied', error: null },
        snapshot: { status: 'available', error: null },
        verification: { status: 'skipped', error: null },
        delivery: { status: 'completed', error: null, confirmation: 'invocation-only' },
        superseded: false
      },
      domains: {},
      dependencies: { theme: { attempt: revision, status, error: null, retryable: true } },
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
function fixture() {
  let receive
  const stop = vi.fn()
  const api = {
    getSettingsApplicationState: vi.fn(),
    onSettingsApplicationChanged: vi.fn((callback) => {
      receive = callback
      return stop
    }),
    retrySettingsApplication: vi.fn(),
    setSettingValue: vi.fn(),
    getSettingsSnapshot: vi.fn()
  }
  const store = createSettingsApplicationStateStore(api)
  store.bindSource(source)
  return { api, store, stop, broadcast: (value) => receive(value) }
}

describe('settings application observation store', () => {
  it('subscribes before reading and keeps the newer event when the delayed read resolves', async () => {
    const f = fixture(),
      firstRead = deferred()
    const receive = vi.fn()
    const unsubscribe = f.store.subscribe(receive)
    f.api.getSettingsApplicationState.mockReturnValueOnce(firstRead.promise)
    const loading = f.store.read()
    f.broadcast(envelope(8, 'applied'))
    firstRead.resolve(envelope(7, 'failed'))
    expect((await loading).ledgerRevision).toBe(8)
    expect(f.store.latest().ledger.dependencies.theme.status).toBe('applied')
    expect(f.api.onSettingsApplicationChanged.mock.invocationCallOrder[0]).toBeLessThan(
      f.api.getSettingsApplicationState.mock.invocationCallOrder[0]
    )
    unsubscribe()
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('does not replace equal-revision observations or accept a foreign document', () => {
    const f = fixture()
    f.store.accept(envelope(4, 'applied'))
    f.store.accept(envelope(4, 'failed'))
    expect(f.store.latest().ledger.dependencies.theme.status).toBe('applied')
    expect(f.store.accept({ ...envelope(999), source: { token: 'old', scope: 'main' } })).toBe(
      false
    )
    expect(f.store.bindSource({ token: source.token, scope: 'week' })).toBe(false)
    expect(f.store.latest().ledgerRevision).toBe(4)
  })

  it('allows application revisions to advance independently of setting values and their revision', async () => {
    const f = fixture()
    const values = createSettingsSnapshotStore(f.api)
    values.acceptCommitted({ source, revision: 2, values: { css: { fontSizeBase: 17 } } })
    const release = values.protectSetting({}, 'css.fontSizeBase', 22)
    values.settleWrite(release, {
      source,
      persistence: { status: 'saved', commitId: 'saved-once' },
      snapshot: null
    })
    const before = values.latest()
    const receipt = {
      source,
      persistence: { status: 'unchanged', commitId: 'saved-once' },
      snapshot: null,
      applicationState: envelope(9, 'applied')
    }
    f.api.retrySettingsApplication.mockResolvedValueOnce(receipt)
    expect(await f.store.retry({ domains: [], dependencies: ['theme'] })).toBe(receipt)
    expect(f.store.latest().ledgerRevision).toBe(9)
    expect(values.latest()).toEqual(before)
    expect(values.status().awaitingCanonical).toBe(true)
    expect(f.api.getSettingsSnapshot).not.toHaveBeenCalled()
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
  })

  it('keeps the accepted observation on query failure and reports unavailable separately', async () => {
    const f = fixture()
    f.store.accept(envelope(3, 'failed'))
    f.api.getSettingsApplicationState.mockRejectedValueOnce(new Error('status transport failed'))
    await expect(f.store.read()).rejects.toThrow('status transport failed')
    expect(f.store.latest().ledgerRevision).toBe(3)
    expect(f.store.status()).toEqual({
      availability: 'unavailable',
      error: { message: 'status transport failed' },
      reading: false
    })
    f.api.getSettingsApplicationState.mockResolvedValueOnce(envelope(3, 'applied'))
    await f.store.read()
    expect(f.store.status().availability).toBe('available')
    expect(f.store.latest().ledger.dependencies.theme.status).toBe('failed')
  })

  it('does not let an older failed query mark a newly published observation unavailable', async () => {
    const f = fixture(),
      held = deferred()
    f.store.subscribe(() => {})
    f.api.getSettingsApplicationState.mockReturnValueOnce(held.promise)
    const rejected = expect(f.store.read()).rejects.toThrow('older query failed')
    f.broadcast(envelope(5, 'unconfirmed'))
    held.reject(new Error('older query failed'))
    await rejected
    expect(f.store.status().availability).toBe('available')
    expect(f.store.latest().ledgerRevision).toBe(5)
  })

  it('isolates snapshots returned to consumers from the authoritative accepted metadata', () => {
    const f = fixture()
    const value = envelope(2)
    f.store.accept(value)
    value.ledger.dependencies.theme.status = 'failed'
    const received = f.store.latest()
    received.ledger.dependencies.theme.status = 'applied'
    expect(f.store.latest().ledger.dependencies.theme.status).toBe('unconfirmed')
  })

  it('releases the shared transport after its last subscriber and invalidates late results', async () => {
    const f = fixture(),
      held = deferred()
    const first = vi.fn(),
      second = vi.fn()
    const stopFirst = f.store.subscribe(first)
    const stopSecond = f.store.subscribe(second)
    f.api.getSettingsApplicationState.mockReturnValueOnce(held.promise)
    const reading = f.store.read()
    stopFirst()
    expect(f.stop).not.toHaveBeenCalled()
    stopSecond()
    stopSecond()
    const calls = second.mock.calls.length
    f.broadcast(envelope(100, 'failed'))
    held.resolve(envelope(101, 'failed'))
    expect(await reading).toBeNull()
    expect(f.store.latest()).toBeNull()
    expect(second).toHaveBeenCalledTimes(calls)
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('passes only exact targets and preserves unavailable or unconfirmed retry outcomes', async () => {
    const f = fixture()
    const result = {
      source,
      persistence: { status: 'unchanged' },
      snapshot: null,
      applicationState: envelope(6)
    }
    f.api.retrySettingsApplication.mockResolvedValueOnce(result)
    await f.store.retry({ domains: ['blur'], dependencies: ['theme'] })
    expect(f.api.retrySettingsApplication).toHaveBeenCalledExactlyOnceWith({
      domains: ['blur'],
      dependencies: ['theme']
    })
    expect(f.store.latest().ledger.dependencies.theme.status).toBe('unconfirmed')
    await expect(
      f.store.retry({ domains: [], dependencies: [], value: 'old-payload' })
    ).rejects.toThrow('只接受明确的领域和依赖名单')
    expect(f.api.retrySettingsApplication).toHaveBeenCalledOnce()
  })

  it('ignores a retry result after its reset or disposal owner has invalidated it', async () => {
    const f = fixture(),
      held = deferred()
    let current = true
    f.store.accept(envelope(2, 'failed'))
    f.api.retrySettingsApplication.mockReturnValueOnce(held.promise)
    const retry = f.store.retry(
      { domains: [], dependencies: ['theme'] },
      { isCurrent: () => current }
    )
    current = false
    const receipt = { applicationState: envelope(99, 'applied') }
    held.resolve(receipt)
    expect(await retry).toBe(receipt)
    expect(f.store.latest().ledgerRevision).toBe(2)
  })

  it('shares state only for the same preload API lifetime', () => {
    const first = {},
      second = {}
    expect(getSettingsApplicationStateStore(first)).toBe(getSettingsApplicationStateStore(first))
    expect(getSettingsApplicationStateStore(first)).not.toBe(
      getSettingsApplicationStateStore(second)
    )
  })

  it('observes async subscriber failures and retains separately registered identical listeners', async () => {
    const f = fixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const receive = vi.fn(async () => {
        throw new Error('consumer failed')
      })
      const stopFirst = f.store.subscribe(receive)
      const stopSecond = f.store.subscribe(receive)
      stopFirst()
      f.broadcast(envelope(2))
      await Promise.resolve()
      await Promise.resolve()
      expect(receive).toHaveBeenCalledTimes(3)
      expect(warning).toHaveBeenCalledWith(
        '[SettingsApplication] 同步应用状态失败:',
        expect.any(Error)
      )
      expect(f.stop).not.toHaveBeenCalled()
      stopSecond()
      expect(f.stop).toHaveBeenCalledOnce()
    } finally {
      warning.mockRestore()
    }
  })

  it('rejects a retry reply that claims another save even when it contains valid application metadata', async () => {
    const f = fixture()
    f.store.accept(envelope(2, 'failed'))
    f.api.retrySettingsApplication.mockResolvedValueOnce({
      source,
      persistence: { status: 'saved', commitId: 'unexpected-second-save' },
      snapshot: null,
      applicationState: envelope(3, 'applied')
    })
    await expect(f.store.retry({ domains: [], dependencies: ['theme'] })).rejects.toThrow(
      '未返回有效的无需再次保存回执'
    )
    expect(f.store.latest().ledgerRevision).toBe(2)
    expect(f.store.status().availability).toBe('unavailable')
  })
})
