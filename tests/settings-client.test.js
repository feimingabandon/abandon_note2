import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createSettingsClient } from '../src/preload/settings-client.js'

const snapshotFor = (source, revision = 0) => ({ source, revision, values: {} })
const applicationStateFor = (source, ledgerRevision = 0) => ({
  source,
  ledgerRevision,
  ledger: {
    scope: source.scope,
    ledgerRevision,
    current: null,
    commitId: null,
    domains: {},
    dependencies: {},
    errors: []
  }
})

describe('preload settings application channel', () => {
  it('uses the same document lease for application reads and unchanged retries', async () => {
    const source = { token: 'current', scope: 'month' }
    const state = applicationStateFor(source, 3)
    const receipt = {
      ...snapshotFor(source),
      persistence: { status: 'unchanged', commitId: null },
      applicationState: state
    }
    const ipc = {
      invoke: vi.fn(async (channel) =>
        channel === 'settings:write-context'
          ? source
          : channel === 'settings:application-state'
            ? state
            : receipt
      )
    }
    const client = createSettingsClient(ipc)
    expect(await client.getApplicationState()).toBe(state)
    expect(await client.retryApplication({ domains: [], dependencies: ['theme'] })).toBe(receipt)
    expect(ipc.invoke.mock.calls).toEqual([
      ['settings:write-context'],
      ['settings:application-state', source],
      ['settings:retry-application', { domains: [], dependencies: ['theme'] }, source]
    ])
  })

  it('drops foreign or unsubscribed application events after the source handshake', async () => {
    let resolve
    const handshake = new Promise((done) => {
      resolve = done
    })
    const source = { token: 'current', scope: 'week' }
    const ipc = new EventEmitter()
    ipc.invoke = vi.fn(() => handshake)
    const client = createSettingsClient(ipc)
    const callback = vi.fn()
    const stop = client.subscribeApplication(callback)
    ipc.emit(
      'settings:application-changed',
      {},
      applicationStateFor({ ...source, token: 'old' }, 999)
    )
    ipc.emit('settings:application-changed', {}, applicationStateFor(source, 3))
    resolve(source)
    await handshake
    await Promise.resolve()
    expect(callback).toHaveBeenCalledExactlyOnceWith(applicationStateFor(source, 3))
    stop()
    stop()
    ipc.emit('settings:application-changed', {}, applicationStateFor(source, 4))
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(ipc.listenerCount('settings:application-changed')).toBe(0)
  })

  it('rejects foreign metadata, saved-again retry replies and arbitrary target payloads', async () => {
    const source = { token: 'current', scope: 'main' }
    const foreign = applicationStateFor({ ...source, token: 'old' }, 99)
    const ipc = {
      invoke: vi.fn(async (channel) => (channel === 'settings:write-context' ? source : foreign))
    }
    const client = createSettingsClient(ipc)
    await expect(client.getApplicationState()).rejects.toMatchObject({
      code: 'SETTINGS_APPLICATION_STATE_INVALID'
    })
    const count = ipc.invoke.mock.calls.length
    await expect(
      client.retryApplication({ domains: [], dependencies: [], values: {} })
    ).rejects.toThrow()
    expect(ipc.invoke).toHaveBeenCalledTimes(count)
    ipc.invoke.mockImplementation(async () => ({
      ...snapshotFor(source),
      persistence: { status: 'saved', commitId: 'unexpected' },
      applicationState: applicationStateFor(source)
    }))
    await expect(client.retryApplication({ domains: [], dependencies: [] })).rejects.toMatchObject({
      code: 'SETTINGS_APPLICATION_RETRY_INVALID'
    })
  })
})

describe('preload settings source lifetime', () => {
  it('preserves a source-bound saved receipt without canonical data across ordinary and native replies', async () => {
    const context = { token: 'saved-document', scope: 'main' }
    const receipt = {
      kind: 'settings-saved',
      source: context,
      persistence: { status: 'saved', commitId: 'opaque-1' },
      snapshot: null,
      snapshotError: { message: 'read unavailable' },
      application: { status: 'failed' }
    }
    const ipc = {
      invoke: vi.fn((channel) =>
        Promise.resolve(
          channel === 'settings:write-context'
            ? context
            : channel === 'set-blur-config'
              ? { success: false, snapshot: receipt }
              : receipt
        )
      )
    }
    const client = createSettingsClient(ipc)
    expect(await client.invoke('set-setting-value', 'css.fontSizeBase', 18)).toBe(receipt)
    expect(await client.invoke('set-blur-config', { enabled: true })).toEqual({
      success: false,
      snapshot: receipt
    })
  })

  it('rejects a foreign saved envelope rather than admitting a result from a replaced document', async () => {
    const context = { token: 'current-document', scope: 'main' }
    const ipc = {
      invoke: vi.fn((channel) =>
        Promise.resolve(
          channel === 'settings:write-context'
            ? context
            : {
                kind: 'settings-saved',
                source: { token: 'old-document', scope: 'main' },
                persistence: { status: 'saved', commitId: 'old-commit' },
                snapshot: null
              }
        )
      )
    }
    await expect(
      createSettingsClient(ipc).invoke('set-setting-value', 'css.fontSizeBase', 18)
    ).rejects.toMatchObject({ code: 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH' })
  })

  it('waits for the shared document handshake before sending lifecycle ready with its original context', async () => {
    let resolveSource
    const pending = new Promise((resolve) => {
      resolveSource = resolve
    })
    const context = { token: 'original-document', scope: 'month' }
    const ipc = {
      invoke: vi.fn((channel) =>
        channel === 'settings:write-context' ? pending : Promise.resolve(snapshotFor(context))
      ),
      send: vi.fn()
    }
    const client = createSettingsClient(ipc)
    const snapshot = client.getSnapshot()
    const ready = client.send('renderer-ready', { viewMode: 'month' })
    const write = client.invoke('set-setting-value', 'css.fontSizeBase', 18)
    expect(ipc.invoke.mock.calls).toEqual([['settings:write-context']])
    expect(ipc.send).not.toHaveBeenCalled()
    resolveSource(context)
    await Promise.all([snapshot, ready, write])
    expect(ipc.send).toHaveBeenCalledExactlyOnceWith(
      'renderer-ready',
      { viewMode: 'month' },
      context
    )
    expect(ipc.invoke.mock.calls).toEqual([
      ['settings:write-context'],
      ['get-settings-snapshot', context],
      ['set-setting-value', 'css.fontSizeBase', 18, context]
    ])
    await client.send('renderer-ready', { viewMode: 'month' })
    expect(ipc.send).toHaveBeenCalledTimes(2)
    expect(ipc.send).toHaveBeenLastCalledWith('renderer-ready', { viewMode: 'month' }, context)
    expect(
      ipc.invoke.mock.calls.filter(([channel]) => channel === 'settings:write-context')
    ).toHaveLength(1)
  })

  it('keeps a delayed ready bound to its old source instead of leasing the replacement document', async () => {
    let activeContext = { token: 'old-document', scope: 'main' }
    const old = activeContext
    const ipc = {
      invoke: vi.fn(async (channel) =>
        channel === 'settings:write-context' ? activeContext : snapshotFor(activeContext)
      ),
      send: vi.fn()
    }
    const client = createSettingsClient(ipc)
    await client.getSnapshot()
    activeContext = { token: 'replacement-document', scope: 'main' }
    await client.send('renderer-ready', { viewMode: 'list' })
    expect(ipc.send).toHaveBeenCalledExactlyOnceWith('renderer-ready', { viewMode: 'list' }, old)
    expect(
      ipc.invoke.mock.calls.filter(([channel]) => channel === 'settings:write-context')
    ).toHaveLength(1)
  })

  it('does not renew an established context after a send throws', async () => {
    const old = { token: 'old-document', scope: 'main' }
    const ipc = {
      invoke: vi.fn(async () => old),
      send: vi.fn().mockImplementationOnce(() => {
        throw new Error('send failed')
      })
    }
    const client = createSettingsClient(ipc)
    await expect(client.send('renderer-ready', { viewMode: 'list' })).rejects.toThrow('send failed')
    await client.send('renderer-ready', { viewMode: 'list' })
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('settings:write-context')
    expect(ipc.send.mock.calls).toEqual([
      ['renderer-ready', { viewMode: 'list' }, old],
      ['renderer-ready', { viewMode: 'list' }, old]
    ])
  })

  it('does not send an unbound ready after an initial handshake failure and permits a new handshake', async () => {
    const context = { token: 'document-after-initial-failure', scope: 'week' }
    const ipc = {
      invoke: vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue(context),
      send: vi.fn()
    }
    const client = createSettingsClient(ipc)
    await expect(client.send('renderer-ready', { viewMode: 'week' })).rejects.toThrow('not ready')
    expect(ipc.send).not.toHaveBeenCalled()
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('settings:write-context')
    await client.send('renderer-ready', { viewMode: 'week' })
    expect(ipc.invoke.mock.calls).toEqual([['settings:write-context'], ['settings:write-context']])
    expect(ipc.send).toHaveBeenCalledExactlyOnceWith(
      'renderer-ready',
      { viewMode: 'week' },
      context
    )
  })

  it('establishes source before snapshot and shares it across queued setting domains', async () => {
    let resolveSource
    const pending = new Promise((resolve) => {
      resolveSource = resolve
    })
    const context = { token: 'original-document', scope: 'main' }
    const ipc = {
      invoke: vi.fn((channel) =>
        channel === 'settings:write-context' ? pending : Promise.resolve(snapshotFor(context))
      )
    }
    const client = createSettingsClient(ipc)
    const snapshot = client.getSnapshot()
    const save = client.invoke('set-setting-value', 'css.fontSizeBase', 18)
    expect(ipc.invoke.mock.calls).toEqual([['settings:write-context']])
    resolveSource(context)
    await Promise.all([snapshot, save])
    await client.invoke('set-blur-config', { radius: 7 })
    await client.invoke('reset-settings')
    expect(ipc.invoke.mock.calls).toEqual([
      ['settings:write-context'],
      ['get-settings-snapshot', context],
      ['set-setting-value', 'css.fontSizeBase', 18, context],
      ['set-blur-config', { radius: 7 }, context],
      ['reset-settings', context]
    ])
  })

  it('does not renew an expired source for a delayed write from the old document', async () => {
    const old = { token: 'old', scope: 'main' }
    const ipc = {
      invoke: vi.fn(async (channel) => {
        if (channel === 'settings:write-context') return old
        if (channel === 'set-setting-value') throw new Error('source expired')
        return snapshotFor(old)
      })
    }
    const client = createSettingsClient(ipc)
    await client.getSnapshot()
    await expect(client.invoke('set-setting-value', 'css.fontSizeBase', 18)).rejects.toThrow(
      'expired'
    )
    await client.getSnapshot()
    expect(
      ipc.invoke.mock.calls.filter(([channel]) => channel === 'settings:write-context')
    ).toHaveLength(1)
    expect(ipc.invoke).toHaveBeenCalledWith('set-setting-value', 'css.fontSizeBase', 18, old)
  })

  it('allows a failed initial handshake to be retried, without sending an unbound write', async () => {
    const context = { token: 'new', scope: 'main' }
    const ipc = {
      invoke: vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue(context)
    }
    const client = createSettingsClient(ipc)
    await expect(client.invoke('set-setting-value', 'css.fontSizeBase', 18)).rejects.toThrow(
      'not ready'
    )
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('settings:write-context')
    await client.invoke('set-setting-value', 'css.fontSizeBase', 19)
    expect(ipc.invoke.mock.calls).toEqual([
      ['settings:write-context'],
      ['settings:write-context'],
      ['set-setting-value', 'css.fontSizeBase', 19, context]
    ])
  })

  it('subscribes before its handshake and rejects a replacement document even with a higher revision', async () => {
    let resolveSource
    const source = new Promise((resolve) => {
      resolveSource = resolve
    })
    const context = { token: 'current', scope: 'main' }
    const ipc = new EventEmitter()
    ipc.invoke = vi.fn(() => source)
    const client = createSettingsClient(ipc)
    const callback = vi.fn()
    const stop = client.subscribe(callback)
    expect(ipc.listenerCount('settings:changed')).toBe(1)
    ipc.emit('settings:changed', {}, snapshotFor({ ...context, token: 'old' }, 999))
    ipc.emit('settings:changed', {}, snapshotFor(context, 12))
    resolveSource(context)
    await source
    await Promise.resolve()
    expect(callback).toHaveBeenCalledExactlyOnceWith(snapshotFor(context, 12))
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('settings:write-context')
    stop()
    stop()
    expect(ipc.listenerCount('settings:changed')).toBe(0)
  })

  it('does not deliver a handshake-delayed broadcast after unsubscription', async () => {
    let resolveSource
    const source = new Promise((resolve) => {
      resolveSource = resolve
    })
    const context = { token: 'current', scope: 'week' }
    const ipc = new EventEmitter()
    ipc.invoke = vi.fn(() => source)
    const callback = vi.fn()
    const stop = createSettingsClient(ipc).subscribe(callback)
    ipc.emit('settings:changed', {}, snapshotFor(context))
    stop()
    resolveSource(context)
    await source
    await Promise.resolve()
    expect(callback).not.toHaveBeenCalled()
    expect(ipc.listenerCount('settings:changed')).toBe(0)
  })

  it('rejects read and write replies from another document without leasing it', async () => {
    const context = { token: 'current', scope: 'main' }
    const ipc = {
      invoke: vi.fn(async (channel) =>
        channel === 'settings:write-context'
          ? context
          : snapshotFor({ token: 'replacement', scope: 'main' }, 999)
      )
    }
    const client = createSettingsClient(ipc)
    await expect(client.getSnapshot()).rejects.toMatchObject({
      code: 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH'
    })
    await expect(client.invoke('set-setting-value', 'css.fontSizeBase', 18)).rejects.toMatchObject({
      code: 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH'
    })
    expect(
      ipc.invoke.mock.calls.filter(([channel]) => channel === 'settings:write-context')
    ).toHaveLength(1)
    expect(ipc.invoke).toHaveBeenCalledWith('get-settings-snapshot', context)
  })

  it('validates an additive native snapshot while preserving its domain runtime result', async () => {
    const context = { token: 'current', scope: 'main' }
    const native = {
      success: true,
      config: { radius: 12 },
      runtime: { effectiveEnabled: true },
      snapshot: snapshotFor(context, 3)
    }
    const ipc = {
      invoke: vi.fn(async (channel) => (channel === 'settings:write-context' ? context : native))
    }
    const client = createSettingsClient(ipc)
    expect(await client.invoke('set-blur-config', { radius: 12 })).toBe(native)
    native.snapshot = snapshotFor({ token: 'old', scope: 'main' }, 999)
    await expect(client.invoke('set-blur-config', { radius: 12 })).rejects.toMatchObject({
      code: 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH'
    })
    expect(
      ipc.invoke.mock.calls.filter(([channel]) => channel === 'settings:write-context')
    ).toHaveLength(1)
  })
})
