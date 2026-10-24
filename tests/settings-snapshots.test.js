import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import {
  createSettingsSnapshotStore,
  getSettingsSnapshotStore
} from '../src/renderer/src/utils/settingsSnapshots.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
function snapshot(revision, values = {}, runtime = {}, token = 'document', scope = 'main') {
  return { source: { token, scope }, revision, values, runtime }
}
function fixture() {
  let transport
  const stop = vi.fn()
  const api = {
    getSettingsSnapshot: vi.fn(),
    onSettingsChanged: vi.fn((callback) => {
      transport = callback
      return stop
    })
  }
  const store = createSettingsSnapshotStore(api)
  return { api, store, stop, broadcast: (value) => transport(value) }
}

describe('settings continuations preserve the original reset boundary', () => {
  it('revokes an old derived write while retaining a real choice after the checkpoint', () => {
    const { store } = fixture()
    store.acceptCommitted(
      snapshot(1, { listFilter: { listMode: 'timeline' }, css: { fontSizeBase: 12 } })
    )
    const presentation = store.protectDomain({}, 'mode-presentation')
    const checkpoint = store.captureIntentCheckpoint()
    const writing = store.protectSetting(
      {},
      'listFilter',
      { listMode: 'custom' },
      {
        continuationOf: presentation
      }
    )
    const later = store.protectSetting({}, 'css.fontSizeBase', 18)
    presentation()
    expect(writing.isActive()).toBe(true)
    store.acceptReset(
      snapshot(2, { listFilter: { listMode: 'timeline' }, css: { fontSizeBase: 12 } }),
      { checkpoint }
    )
    expect(writing.isActive()).toBe(false)
    expect(later.isActive()).toBe(true)
    expect(store.latest().values.listFilter.listMode).toBe('timeline')
    expect(store.latest().values.css.fontSizeBase).toBe(18)
    expect(
      store.settleWrite(writing, snapshot(1, { listFilter: { listMode: 'custom' } })).settled
    ).toBe(false)
    expect(store.latest().values.listFilter.listMode).toBe('timeline')
  })

  it('keeps a derived write valid after its presentation naturally releases', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1, { listFilter: { listMode: 'timeline' } }))
    const presentation = store.protectDomain({}, 'mode-presentation')
    const writing = store.protectSetting(
      {},
      'listFilter',
      { listMode: 'custom' },
      {
        continuationOf: presentation
      }
    )
    presentation()
    expect(writing.isActive()).toBe(true)
    expect(
      store.settleWrite(writing, snapshot(2, { listFilter: { listMode: 'custom' } })).settled
    ).toBe(true)
    expect(store.latest().values.listFilter.listMode).toBe('custom')
    expect(store.protectedCount).toBe(0)
  })

  it.each(['foreign', 'released'])(
    'rejects a %s continuation without creating a new intent',
    (kind) => {
      const { store } = fixture()
      const parentStore = kind === 'foreign' ? fixture().store : store
      const parent = parentStore.protectDomain({}, 'mode-presentation')
      if (kind === 'released') parent()
      const checkpoint = store.captureIntentCheckpoint()
      const lease = store.protectSetting(
        {},
        'listFilter',
        { listMode: 'custom' },
        { continuationOf: parent }
      )
      expect(lease.isActive()).toBe(false)
      expect(store.captureIntentCheckpoint()).toBe(checkpoint)
      expect(store.protectedCount).toBe(0)
    }
  )
})

describe('document settings snapshot store', () => {
  it('rejects an older initial read before it can notify CSS or providers', async () => {
    const { api, store, broadcast } = fixture()
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValue(read.promise)
    const apply = vi.fn()
    store.subscribe(apply)
    const loading = store.read()
    broadcast(snapshot(12, { css: { fontSizeBase: 18 } }))
    read.resolve(snapshot(11, { css: { fontSizeBase: 12 } }))
    expect((await loading).values.css.fontSizeBase).toBe(18)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][1]).toEqual({ origin: 'broadcast' })
  })

  it('retains an accepted broadcast when initial reading fails', async () => {
    const { api, store, broadcast } = fixture()
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValue(read.promise)
    const apply = vi.fn()
    store.subscribe(apply)
    const loading = store.read()
    broadcast(snapshot(3, { weather: { enabled: false } }))
    read.reject(new Error('disk unavailable'))
    expect(await loading).toEqual(store.latest())
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it.each([
    snapshot(999, {}, {}, 'old-document'),
    snapshot(999, {}, {}, 'document', 'week'),
    snapshot(0),
    { source: { token: 'document', scope: 'main' }, revision: 8, values: [] },
    { source: { token: 'document', scope: 'main' }, revision: -1, values: {} }
  ])('rejects a foreign document, lower revision or invalid envelope %#', (invalid) => {
    const { store, broadcast } = fixture()
    const apply = vi.fn()
    store.subscribe(apply)
    broadcast(snapshot(2, { css: { fontSizeBase: 17 } }))
    broadcast(invalid)
    expect(store.acceptCommitted(invalid)).toBe(false)
    expect(store.latest().revision).toBe(2)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('accepts same-revision OS observations but rejects a read overtaken by a broadcast', async () => {
    const { api, store, broadcast } = fixture()
    store.subscribe(() => {})
    broadcast(snapshot(2, {}, { autoStart: false }))
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(2, {}, { autoStart: true }))
    expect((await store.read()).runtime.autoStart).toBe(true)
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const pending = store.read()
    broadcast(snapshot(2, {}, { autoStart: false }))
    read.resolve(snapshot(2, {}, { autoStart: true }))
    expect((await pending).runtime.autoStart).toBe(false)
    broadcast(snapshot(2, {}, { autoStart: true }))
    expect(store.latest().runtime.autoStart).toBe(true)
  })

  it('lets a newer read own equal-revision data even when it resolves first', async () => {
    const { api, store } = fixture()
    const first = deferred(),
      second = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    store.acceptCommitted(snapshot(5))
    const older = store.read(),
      newer = store.read()
    second.resolve(snapshot(5, {}, { state: 'new' }))
    await newer
    first.resolve(snapshot(5, {}, { state: 'old' }))
    expect((await older).runtime.state).toBe('new')
  })

  it.each([null, snapshot(0)])(
    'keeps the newer equal-revision read when the older request resolves first, base %#',
    async (base) => {
      const { api, store } = fixture()
      if (base) store.acceptCommitted(base)
      const first = deferred(),
        second = deferred()
      api.getSettingsSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      const older = store.read(),
        newer = store.read()
      first.resolve(snapshot(1, {}, { state: 'old' }))
      await older
      second.resolve(snapshot(1, {}, { state: 'new' }))
      expect((await newer).runtime.state).toBe('new')
    }
  )

  it('uses one transport, replays synchronously and reconnects after the last consumer leaves', async () => {
    const { api, store, stop, broadcast } = fixture()
    const first = vi.fn(),
      second = vi.fn()
    const offFirst = store.subscribe(first)
    broadcast(snapshot(1))
    const offSecond = store.subscribe(second)
    expect(second).toHaveBeenCalledWith(snapshot(1), { origin: 'replay' })
    expect(api.onSettingsChanged).toHaveBeenCalledTimes(1)
    offFirst()
    expect(stop).not.toHaveBeenCalled()
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const pending = store.read()
    offSecond()
    offSecond()
    expect(stop).toHaveBeenCalledTimes(1)
    read.resolve(snapshot(2))
    await pending
    expect(second).toHaveBeenCalledTimes(1)
    const third = vi.fn()
    store.subscribe(third)
    expect(api.onSettingsChanged).toHaveBeenCalledTimes(2)
    expect(third.mock.calls[0][0].revision).toBe(2)
  })

  it('does not double replay when the transport immediately emits during subscription', () => {
    const api = {
      onSettingsChanged: (callback) => {
        callback(snapshot(1))
        return () => {}
      }
    }
    const store = createSettingsSnapshotStore(api)
    const apply = vi.fn()
    store.subscribe(apply)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][1].origin).toBe('broadcast')
  })

  it('protects queued/in-flight/failed values while accepting unrelated data and real runtime', () => {
    const { store, broadcast } = fixture()
    const apply = vi.fn()
    store.subscribe(apply)
    broadcast(snapshot(1, { css: { fontSizeBase: 12 }, blur: { radius: 10 } }))
    const owner = {}
    const release = store.protectSetting(owner, 'css.fontSizeBase', 19)
    const releaseBlur = store.protectDomain(owner, 'blur', { blur: { radius: 21 } })
    for (const revision of [2, 3, 4]) {
      broadcast(
        snapshot(
          revision,
          { css: { fontSizeBase: 12 }, blur: { radius: 10 }, weather: { enabled: false } },
          { blur: { effectiveEnabled: false, error: 'native-failure' } }
        )
      )
      const latest = apply.mock.calls.at(-1)[0]
      expect(latest.values.css.fontSizeBase).toBe(19)
      expect(latest.values.blur.radius).toBe(21)
      expect(latest.values.weather.enabled).toBe(false)
      expect(latest.runtime.blur.effectiveEnabled).toBe(false)
    }
    expect(store.protectedCount).toBe(2)
    release()
    releaseBlur()
    expect(apply).toHaveBeenCalledTimes(4)
    store.acceptCommitted(snapshot(5, { css: { fontSizeBase: 18 } }))
    expect(apply.mock.calls.at(-1)[0].values.css.fontSizeBase).toBe(18)
  })

  it('an old release cannot remove a replacement and owners only clear their own previews', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12, noteRemarkFontSize: 10 } }))
    const first = {},
      second = {}
    const stale = store.protectSetting(first, 'css.fontSizeBase', 15)
    store.protectSetting(first, 'css.fontSizeBase', 17)
    store.protectSetting(second, 'css.noteRemarkFontSize', 14)
    stale()
    stale()
    expect(store.latest().values.css.fontSizeBase).toBe(17)
    store.clearOwner(first)
    expect(store.latest().values.css.fontSizeBase).toBe(12)
    expect(store.latest().values.css.noteRemarkFontSize).toBe(14)
    expect(store.protectedCount).toBe(1)
  })

  it('settles a released preview against an already newer canonical broadcast', () => {
    const { store, broadcast } = fixture()
    const apply = vi.fn()
    store.subscribe(apply)
    broadcast(snapshot(1, { css: { fontSizeBase: 12 } }))
    const release = store.protectSetting({}, 'css.fontSizeBase', 19)
    broadcast(snapshot(3, { css: { fontSizeBase: 18 } }))
    expect(apply.mock.calls.at(-1)[0].values.css.fontSizeBase).toBe(19)
    release()
    expect(
      store.acceptCommitted(snapshot(2, { css: { fontSizeBase: 18 } }), { reconcile: true })
    ).toBe(false)
    expect(apply.mock.calls.at(-1)[0]).toEqual(snapshot(3, { css: { fontSizeBase: 18 } }))
    expect(apply).toHaveBeenCalledTimes(3)
    store.acceptCommitted(snapshot(999, {}, {}, 'old-document'), { reconcile: true })
    expect(apply).toHaveBeenCalledTimes(3)
  })

  it('a confirmed reset discards failed intents across owners and cancels their undispatched leases', () => {
    const { store, broadcast } = fixture()
    const apply = vi.fn()
    store.subscribe(apply)
    broadcast(snapshot(1, { wallpaper: { blurRadius: 8 }, weather: { enabled: false } }))
    const wallpaper = store.protectSetting({}, 'wallpaper.blurRadius', 20)
    const weather = store.protectSetting({}, 'weather.enabled', true)
    const checkpoint = store.captureIntentCheckpoint()
    broadcast(snapshot(2, { wallpaper: { blurRadius: 8 }, weather: { enabled: false } }))
    expect(apply.mock.calls.at(-1)[0].values.wallpaper.blurRadius).toBe(20)
    expect(
      store.acceptReset(
        snapshot(2, { wallpaper: { blurRadius: 8 }, weather: { enabled: false } }),
        { checkpoint }
      )
    ).toBe(true)
    expect(wallpaper.isActive()).toBe(false)
    expect(weather.isActive()).toBe(false)
    expect(store.protectedCount).toBe(0)
    expect(apply.mock.calls.at(-1)).toEqual([
      snapshot(2, { wallpaper: { blurRadius: 8 }, weather: { enabled: false } }),
      { origin: 'reset' }
    ])
  })

  it('reset confirmation preserves later intent and never replaces a newer accepted base', () => {
    const { store, broadcast } = fixture()
    store.subscribe(() => {})
    broadcast(snapshot(1, { css: { fontSizeBase: 12 }, weather: { enabled: false } }))
    const owner = {}
    const old = store.protectSetting(owner, 'css.fontSizeBase', 18)
    const checkpoint = store.captureIntentCheckpoint()
    const newer = store.protectSetting(owner, 'css.fontSizeBase', 19)
    broadcast(snapshot(4, { css: { fontSizeBase: 17 }, weather: { enabled: true } }))
    store.acceptReset(snapshot(3, { css: { fontSizeBase: 12 }, weather: { enabled: false } }), {
      checkpoint
    })
    expect(old.isActive()).toBe(false)
    expect(newer.isActive()).toBe(true)
    expect(store.latest()).toEqual(
      snapshot(4, { css: { fontSizeBase: 19 }, weather: { enabled: true } })
    )
    newer()
    expect(newer.isActive()).toBe(false)
    expect(store.latest().values.css.fontSizeBase).toBe(17)
  })

  it('invalid or foreign reset confirmation cannot discard any local intent', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1))
    const release = store.protectSetting({}, 'css.fontSizeBase', 18)
    const checkpoint = store.captureIntentCheckpoint()
    expect(store.acceptReset(snapshot(999, {}, {}, 'foreign'), { checkpoint })).toBe(false)
    expect(store.acceptReset({ values: {} }, { checkpoint })).toBe(false)
    expect(release.isActive()).toBe(true)
    expect(store.protectedCount).toBe(1)
  })

  it('clearing an owner invalidates old lease closures even when the same owner returns', () => {
    const { store } = fixture()
    const owner = {}
    const release = store.protectSetting(owner, 'css.fontSizeBase', 18)
    store.clearOwner(owner)
    const replacement = store.protectSetting(owner, 'css.fontSizeBase', 19)
    expect(release.isActive()).toBe(false)
    release()
    expect(replacement.isActive()).toBe(true)
    expect(store.protectedCount).toBe(1)
  })

  it('strict recovery returns actual values, rejects errors and foreign replies without using cache', async () => {
    const { api, store } = fixture()
    store.acceptCommitted(snapshot(3, { css: { fontSizeBase: 12 } }))
    store.protectSetting({}, 'css.fontSizeBase', 19)
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(4, { css: { fontSizeBase: 13 } }))
    const options = { allowCachedOnError: false, protectIntents: false }
    expect((await store.read(options)).values.css.fontSizeBase).toBe(13)
    expect(store.latest().values.css.fontSizeBase).toBe(19)
    api.getSettingsSnapshot.mockRejectedValueOnce(new Error('offline'))
    await expect(store.read(options)).rejects.toThrow('offline')
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(999, {}, {}, 'old-document'))
    await expect(store.read(options)).rejects.toMatchObject({ code: 'SETTINGS_SNAPSHOT_INVALID' })
    expect(store.latest().revision).toBe(4)
  })

  it('copies Vue proxies and isolates returned values and different consumers', () => {
    const { store, broadcast } = fixture()
    store.subscribe((value) => {
      value.values.css.fontSizeBase = 999
    })
    const second = vi.fn()
    store.subscribe(second)
    broadcast(snapshot(1, { css: { fontSizeBase: 12 } }))
    store.protectDomain({}, 'dock', reactive({ dock: { enabledEdges: ['left'] } }))
    const projected = store.latest()
    projected.values.dock.enabledEdges.push('right')
    expect(store.latest().values.dock.enabledEdges).toEqual(['left'])
    expect(second.mock.calls[0][0].values.css.fontSizeBase).toBe(12)
  })

  it('isolates a failing consumer so accepted settings still reach other providers', () => {
    const { store, broadcast } = fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      store.subscribe(() => {
        throw new Error('consumer failure')
      })
      const apply = vi.fn()
      store.subscribe(apply)
      broadcast(snapshot(1))
      expect(apply).toHaveBeenCalledTimes(1)
      expect(store.latest().revision).toBe(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it.each(['broadcast', 'replay'])(
    'observes asynchronous consumer rejection during %s',
    async (origin) => {
      const { store, broadcast } = fixture()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const rejected = Promise.reject(new Error('async consumer failure'))
      // Keep the regression probe bounded even before the store observes returned promises.
      void rejected.catch(() => {})
      try {
        if (origin === 'replay') store.acceptCommitted(snapshot(1))
        store.subscribe(() => rejected)
        const apply = vi.fn()
        store.subscribe(apply)
        if (origin === 'broadcast') broadcast(snapshot(1))
        await Promise.resolve()
        await Promise.resolve()
        expect(apply).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          '[SettingsSnapshot] 同步设置消费者失败:',
          expect.any(Error)
        )
      } finally {
        warn.mockRestore()
      }
    }
  )

  it('rejects invalid first reads and shares a store only for the same bridge object', async () => {
    const { api, store } = fixture()
    api.getSettingsSnapshot.mockResolvedValueOnce({ revision: 1, values: {} })
    await expect(store.read()).rejects.toMatchObject({ code: 'SETTINGS_SNAPSHOT_INVALID' })
    expect(store.latest()).toBeNull()
    expect(getSettingsSnapshotStore(api)).toBe(getSettingsSnapshotStore(api))
    expect(getSettingsSnapshotStore({ ...api })).not.toBe(getSettingsSnapshotStore(api))
  })
})

function savedReply(commitId = 'commit-a', token = 'document', scope = 'main') {
  return {
    kind: 'settings-saved',
    source: { token, scope },
    persistence: { status: 'saved', commitId },
    application: { status: 'unconfirmed' },
    snapshot: null,
    snapshotError: { message: 'canonical unavailable' }
  }
}

describe('saved receipt settlement and canonical recovery', () => {
  it('atomically replaces a pending lease with a saved shadow without inventing canonical or runtime', () => {
    const { store, api } = fixture()
    store.acceptCommitted(
      snapshot(4, { css: { fontSizeBase: 12 } }, { blur: { effectiveEnabled: false } })
    )
    const lease = store.protectSetting({}, 'css.fontSizeBase', 19)
    const apply = vi.fn()
    store.subscribe(apply, { replay: false })
    const result = store.settleWrite(lease, savedReply())
    expect(result).toMatchObject({
      valid: true,
      saved: true,
      settled: true,
      current: true,
      canonical: null,
      unavailable: false
    })
    expect(result.projection.values.css.fontSizeBase).toBe(19)
    expect(result.projection.revision).toBe(4)
    expect(result.projection.runtime.blur.effectiveEnabled).toBe(false)
    expect(store.protectedCount).toBe(0)
    expect(store.status()).toEqual({
      availability: 'available',
      awaitingCanonical: true,
      savedCount: 1,
      resetPending: false
    })
    expect(lease.isActive()).toBe(false)
    expect(apply).toHaveBeenCalledOnce()
    expect(apply.mock.calls[0][0].values.css.fontSizeBase).toBe(19)
    expect(api.getSettingsSnapshot).not.toHaveBeenCalled()
  })

  it('retains saved A below a queued B even when replacing B already released A for display', () => {
    const { store, api } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    const apply = vi.fn()
    store.subscribe(apply, { replay: false })
    const owner = {}
    const first = store.protectSetting(owner, 'css.fontSizeBase', 17)
    const second = store.protectSetting(owner, 'css.fontSizeBase', 21)
    first()
    expect(first.isActive()).toBe(false)
    expect(store.settleWrite(first, savedReply())).toMatchObject({
      settled: true,
      current: false
    })
    expect(store.latest().values.css.fontSizeBase).toBe(21)
    expect(second.isActive()).toBe(true)
    expect(store.protectedCount).toBe(1)
    // A failed B may keep its existing unsaved preview. Discarding that preview
    // exposes the actual saved A shadow, not the pre-A canonical value.
    second()
    expect(store.latest().values.css.fontSizeBase).toBe(17)
    expect(apply.mock.calls.at(-1)[0].values.css.fontSizeBase).toBe(17)
    expect(apply.mock.calls.at(-1)[1].origin).toBe('release')
    store.clearOwner(owner)
    expect(store.latest().values.css.fontSizeBase).toBe(17)
    expect(store.status().savedCount).toBe(1)
    expect(api.getSettingsSnapshot).not.toHaveBeenCalled()
  })

  it('allows a dispatched save to settle after its component owner was cleared', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    const owner = {}
    const lease = store.protectSetting(owner, 'css.fontSizeBase', 18)
    store.clearOwner(owner)
    expect(lease.isActive()).toBe(false)
    expect(store.settleWrite(lease, savedReply()).settled).toBe(true)
    expect(store.protectedCount).toBe(0)
    expect(store.latest().values.css.fontSizeBase).toBe(18)
  })

  it('never resurrects late A after B already settled to a canonical value', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    const owner = {}
    const first = store.protectSetting(owner, 'css.fontSizeBase', 17)
    const second = store.protectSetting(owner, 'css.fontSizeBase', 21)
    first()
    store.settleWrite(second, snapshot(3, { css: { fontSizeBase: 20 } }))
    expect(store.latest().values.css.fontSizeBase).toBe(20)
    store.settleWrite(first, savedReply('late-a'))
    expect(store.latest().values.css.fontSizeBase).toBe(20)
    expect(store.status().savedCount).toBe(0)
  })

  it('does not leave an older owner preview over a later owner canonical settlement', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    const first = store.protectSetting({}, 'css.fontSizeBase', 17)
    const second = store.protectSetting({}, 'css.fontSizeBase', 21)
    expect(store.settleWrite(first, savedReply('saved-a')).current).toBe(false)
    expect(store.latest().values.css.fontSizeBase).toBe(21)
    store.settleWrite(second, snapshot(3, { css: { fontSizeBase: 20 } }))
    expect(store.latest().values.css.fontSizeBase).toBe(20)
    expect(store.status().savedCount).toBe(0)
    expect(store.protectedCount).toBe(0)
  })

  it('retires an older owner pending preview after a later overlapping save without revoking unrelated fields', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 }, weather: { enabled: false } }))
    const first = store.protectSetting({}, 'css.fontSizeBase', 17)
    const unrelated = store.protectSetting({}, 'weather.enabled', true)
    const second = store.protectSetting({}, 'css.fontSizeBase', 21)
    store.settleWrite(
      second,
      snapshot(3, { css: { fontSizeBase: 20 }, weather: { enabled: false } })
    )
    expect(first.isActive()).toBe(false)
    expect(unrelated.isActive()).toBe(true)
    expect(store.latest().values.css.fontSizeBase).toBe(20)
    expect(store.latest().values.weather.enabled).toBe(true)
    store.settleWrite(first, savedReply('late-a'))
    expect(store.latest().values.css.fontSizeBase).toBe(20)
    expect(store.protectedCount).toBe(1)
  })

  it('retains the per-field high water mark after B shadow was reconciled and removed', async () => {
    const { store, api } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    const owner = {}
    const first = store.protectSetting(owner, 'css.fontSizeBase', 17)
    const second = store.protectSetting(owner, 'css.fontSizeBase', 21)
    first()
    store.settleWrite(second, savedReply('saved-b'))
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(2, { css: { fontSizeBase: 20 } }))
    await store.read()
    expect(store.status().savedCount).toBe(0)
    store.settleWrite(first, savedReply('late-a'))
    expect(store.latest().values.css.fontSizeBase).toBe(20)
    expect(store.status().awaitingCanonical).toBe(false)
  })

  it('keeps a saved shadow over an unrelated higher-revision broadcast until a post-ack raw read', async () => {
    const { store, api, broadcast } = fixture()
    store.subscribe(() => {})
    broadcast(snapshot(2, { css: { fontSizeBase: 12 }, weather: { enabled: false } }))
    const lease = store.protectSetting({}, 'css.fontSizeBase', 19)
    store.settleWrite(lease, savedReply())
    const pendingWeather = store.protectSetting({}, 'weather.enabled', true)
    broadcast(
      snapshot(
        8,
        { css: { fontSizeBase: 12 }, weather: { enabled: false } },
        { blur: { effectiveEnabled: false, error: 'still unavailable' } }
      )
    )
    expect(store.latest().values.css.fontSizeBase).toBe(19)
    expect(store.latest().runtime.blur.error).toBe('still unavailable')
    expect(store.status().savedCount).toBe(1)
    api.getSettingsSnapshot.mockResolvedValueOnce(
      snapshot(8, { css: { fontSizeBase: 18 }, weather: { enabled: false } })
    )
    expect((await store.read()).values.css.fontSizeBase).toBe(18)
    expect(store.latest().values.weather.enabled).toBe(true)
    expect(pendingWeather.isActive()).toBe(true)
    expect(store.status().savedCount).toBe(0)
  })

  it('does not let a pre-ack read clear a shadow even when that delayed read has a larger revision', async () => {
    const { store, api } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    const old = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(old.promise)
    const reading = store.read()
    const lease = store.protectSetting({}, 'css.fontSizeBase', 19)
    store.settleWrite(lease, savedReply())
    old.resolve(snapshot(10, { css: { fontSizeBase: 12 } }))
    expect((await reading).values.css.fontSizeBase).toBe(19)
    expect(store.status().savedCount).toBe(1)
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(10, { css: { fontSizeBase: 18 } }))
    expect((await store.read()).values.css.fontSizeBase).toBe(18)
    expect(store.status().awaitingCanonical).toBe(false)
  })

  it('reconciles a same-value save from an equal-revision raw read', async () => {
    const { store, api } = fixture()
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 12 } }))
    const lease = store.protectSetting({}, 'css.fontSizeBase', 12)
    store.settleWrite(lease, savedReply())
    expect(store.status().awaitingCanonical).toBe(true)
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(4, { css: { fontSizeBase: 12 } }))
    expect((await store.read()).revision).toBe(4)
    expect(store.status().awaitingCanonical).toBe(false)
    expect(store.protectedCount).toBe(0)
  })

  it('confirms a post-ack raw read after its matching broadcast without replacing newer runtime', async () => {
    const { store, api, broadcast } = fixture()
    const apply = vi.fn()
    store.subscribe(apply, { availabilityEvents: true })
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 12 } }))
    store.settleWrite(store.protectSetting({}, 'css.fontSizeBase', 20), savedReply())
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const task = store.read()
    broadcast(snapshot(5, { css: { fontSizeBase: 20 } }, { autoStart: true }))
    const notifications = apply.mock.calls.length
    read.resolve(snapshot(5, { css: { fontSizeBase: 20 } }, { autoStart: false }))
    expect((await task).runtime.autoStart).toBe(true)
    expect(store.status().awaitingCanonical).toBe(false)
    expect(apply).toHaveBeenCalledTimes(notifications + 1)
    expect(apply.mock.calls.at(-1)[1]).toMatchObject({ origin: 'read', savedCount: 0 })
    expect(api.getSettingsSnapshot).toHaveBeenCalledOnce()
  })

  it('releases reset quarantine from a matching raw read while preserving later intent and runtime', async () => {
    const { store, api, broadcast } = fixture()
    const apply = vi.fn()
    store.subscribe(apply, { availabilityEvents: true })
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 19 }, weather: { enabled: true } }))
    store.settleReset(savedReply('reset-a'))
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const task = store.read()
    const later = store.protectSetting({}, 'css.fontSizeBase', 21)
    broadcast(
      snapshot(5, { css: { fontSizeBase: 12 }, weather: { enabled: false } }, { state: 'newer' })
    )
    expect(store.latest()).toBeNull()
    // Property order is not part of the values contract.
    read.resolve(
      snapshot(5, { weather: { enabled: false }, css: { fontSizeBase: 12 } }, { state: 'older' })
    )
    expect((await task).values.css.fontSizeBase).toBe(21)
    expect(store.status()).toMatchObject({ availability: 'available', resetPending: false })
    expect(store.latest().runtime.state).toBe('newer')
    expect(later.isActive()).toBe(true)
    expect(apply.mock.calls.at(-1)[1]).toMatchObject({ origin: 'read', awaitingCanonical: false })
    later()
    expect(store.latest().values.css.fontSizeBase).toBe(12)
  })

  it('confirms the saved underlay without releasing a newer pending lease', async () => {
    const { store, api, broadcast } = fixture()
    store.subscribe(() => {})
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 12 } }))
    store.settleWrite(store.protectSetting({}, 'css.fontSizeBase', 20), savedReply())
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const task = store.read({ protectIntents: false })
    const pending = store.protectSetting({}, 'css.fontSizeBase', 23)
    broadcast(snapshot(5, { css: { fontSizeBase: 20 } }, { state: 'newer' }))
    read.resolve(snapshot(5, { css: { fontSizeBase: 20 } }, { state: 'older' }))
    expect((await task).values.css.fontSizeBase).toBe(20)
    expect(store.status().savedCount).toBe(0)
    expect(store.latest().values.css.fontSizeBase).toBe(23)
    expect(pending.isActive()).toBe(true)
    expect(store.latest().runtime.state).toBe('newer')
  })

  it('only confirms shadows acknowledged before the raw read started', async () => {
    const { store, api, broadcast } = fixture()
    store.subscribe(() => {})
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 12 }, weather: { enabled: false } }))
    store.settleWrite(store.protectSetting({}, 'css.fontSizeBase', 20), savedReply('font-a'))
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const task = store.read()
    store.settleWrite(store.protectSetting({}, 'weather.enabled', true), savedReply('weather-b'))
    broadcast(snapshot(5, { css: { fontSizeBase: 20 }, weather: { enabled: false } }))
    read.resolve(snapshot(5, { css: { fontSizeBase: 20 }, weather: { enabled: false } }))
    await task
    expect(store.status().savedCount).toBe(1)
    expect(store.latest().values.weather.enabled).toBe(true)
    api.getSettingsSnapshot.mockResolvedValueOnce(
      snapshot(6, { css: { fontSizeBase: 20 }, weather: { enabled: false } })
    )
    expect((await store.read()).values.weather.enabled).toBe(false)
    expect(store.status().savedCount).toBe(0)
  })

  it('cannot confirm a reset acknowledged after the matching raw read started', async () => {
    const { store, api, broadcast } = fixture()
    store.subscribe(() => {})
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 12 } }))
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const task = store.read()
    store.settleReset(savedReply('reset-after-read'))
    broadcast(snapshot(5, { css: { fontSizeBase: 12 } }, { state: 'newer' }))
    read.resolve(snapshot(5, { css: { fontSizeBase: 12 } }, { state: 'older' }))
    await expect(task).rejects.toMatchObject({ code: 'SETTINGS_SNAPSHOT_INVALID' })
    expect(store.status().resetPending).toBe(true)
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(5, { css: { fontSizeBase: 12 } }))
    await store.read()
    expect(store.status().resetPending).toBe(false)
  })

  it('cannot use matching values to confirm a save acknowledged after the raw read started', async () => {
    const { store, api, broadcast } = fixture()
    const apply = vi.fn()
    store.subscribe(apply)
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 20 } }))
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const task = store.read()
    store.settleWrite(store.protectSetting({}, 'css.fontSizeBase', 20), savedReply())
    broadcast(snapshot(5, { css: { fontSizeBase: 20 } }, { state: 'newer' }))
    const notifications = apply.mock.calls.length
    read.resolve(snapshot(5, { css: { fontSizeBase: 20 } }, { state: 'older' }))
    await task
    expect(store.status().savedCount).toBe(1)
    expect(apply).toHaveBeenCalledTimes(notifications)
    expect(store.latest().runtime.state).toBe('newer')
  })

  it('retains protection when a higher-revision broadcast overtakes a raw read with different values', async () => {
    const { store, api, broadcast } = fixture()
    store.subscribe(() => {})
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 12 } }))
    store.settleWrite(store.protectSetting({}, 'css.fontSizeBase', 20), savedReply())
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const task = store.read()
    broadcast(snapshot(6, { css: { fontSizeBase: 22 } }, { state: 'newer' }))
    read.resolve(snapshot(5, { css: { fontSizeBase: 20 } }, { state: 'older' }))
    await task
    expect(store.status().savedCount).toBe(1)
    expect(store.latest().revision).toBe(6)
    expect(store.latest().runtime.state).toBe('newer')
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(6, { css: { fontSizeBase: 22 } }))
    expect((await store.read()).values.css.fontSizeBase).toBe(22)
    expect(store.status().savedCount).toBe(0)
  })

  it.each([
    ['different values', snapshot(5, { css: { fontSizeBase: 18 } })],
    ['older revision and different values', snapshot(4, { css: { fontSizeBase: 18 } })],
    ['foreign source', snapshot(5, { css: { fontSizeBase: 20 } }, {}, 'foreign')],
    [
      'different OS value projection',
      snapshot(5, { css: { fontSizeBase: 20 }, system: { autoStart: false } })
    ]
  ])('does not confirm an overtaken raw read with %s', async (_label, reply) => {
    const { store, api, broadcast } = fixture()
    store.subscribe(() => {})
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 12 } }))
    store.settleWrite(store.protectSetting({}, 'css.fontSizeBase', 20), savedReply())
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const task = store.read()
    broadcast(
      snapshot(5, { css: { fontSizeBase: 20 }, system: { autoStart: true } }, { state: 'newer' })
    )
    read.resolve(reply)
    await task
    expect(store.status().savedCount).toBe(1)
    expect(store.latest().runtime.state).toBe('newer')
    expect(store.latest().values.system.autoStart).toBe(true)
  })

  it('does not notify for an older equal-revision read after a newer raw confirmation', async () => {
    const { store, api, broadcast } = fixture()
    const apply = vi.fn()
    store.subscribe(apply)
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 12 } }))
    store.settleWrite(store.protectSetting({}, 'css.fontSizeBase', 20), savedReply())
    const first = deferred(),
      second = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const older = store.read(),
      newer = store.read()
    broadcast(snapshot(5, { css: { fontSizeBase: 20 } }, { state: 'broadcast' }))
    second.resolve(snapshot(5, { css: { fontSizeBase: 20 } }, { state: 'newer-read' }))
    await newer
    expect(store.status().savedCount).toBe(0)
    const notifications = apply.mock.calls.length
    first.resolve(snapshot(5, { css: { fontSizeBase: 20 } }, { state: 'older-read' }))
    await older
    expect(apply).toHaveBeenCalledTimes(notifications)
    expect(store.latest().runtime.state).toBe('broadcast')
  })

  it('keeps an empty overtaken raw read rejected without an extra notification', async () => {
    const { store, api, broadcast } = fixture()
    const apply = vi.fn()
    store.subscribe(apply)
    store.acceptCommitted(snapshot(4, { css: { fontSizeBase: 20 } }))
    const read = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(read.promise)
    const task = store.read()
    broadcast(snapshot(4, { css: { fontSizeBase: 20 } }, { state: 'newer' }))
    const notifications = apply.mock.calls.length
    read.resolve(snapshot(4, { css: { fontSizeBase: 20 } }, { state: 'older' }))
    await task
    expect(apply).toHaveBeenCalledTimes(notifications)
    expect(store.latest().runtime.state).toBe('newer')
  })

  it('does not use a failed cached recovery as proof and preserves pending values on strict raw recovery', async () => {
    const { store, api } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    store.settleWrite(store.protectSetting({}, 'css.fontSizeBase', 17), savedReply())
    api.getSettingsSnapshot.mockRejectedValueOnce(new Error('read failed'))
    expect((await store.read()).values.css.fontSizeBase).toBe(17)
    expect(store.status().savedCount).toBe(1)
    const newer = store.protectSetting({}, 'css.fontSizeBase', 21)
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(2, { css: { fontSizeBase: 18 } }))
    expect((await store.read({ protectIntents: false })).values.css.fontSizeBase).toBe(18)
    expect(store.latest().values.css.fontSizeBase).toBe(21)
    expect(newer.isActive()).toBe(true)
    expect(store.status().savedCount).toBe(0)
  })

  it('quarantines a saved reset with no canonical while preserving later intent and rejecting old A', async () => {
    const { store, api } = fixture()
    store.acceptCommitted(snapshot(2, { css: { fontSizeBase: 12 }, weather: { enabled: true } }))
    const first = store.protectSetting({}, 'css.fontSizeBase', 19)
    store.settleWrite(store.protectSetting({}, 'weather.enabled', false), savedReply('weather-a'))
    const checkpoint = store.captureIntentCheckpoint()
    const later = store.protectSetting({}, 'css.fontSizeBase', 21)
    const old = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(old.promise)
    const oldReading = store.read()
    const apply = vi.fn(),
      availability = vi.fn()
    store.subscribe(apply, { replay: false })
    store.subscribe(availability, { replay: false, availabilityEvents: true })
    const result = store.settleReset(savedReply('reset-a'), { checkpoint })
    expect(result).toMatchObject({
      saved: true,
      settled: true,
      projection: null,
      unavailable: true
    })
    expect(store.latest()).toBeNull()
    expect(store.status()).toEqual({
      availability: 'unavailable',
      awaitingCanonical: true,
      savedCount: 0,
      resetPending: true
    })
    expect(apply).not.toHaveBeenCalled()
    expect(availability).toHaveBeenCalledOnce()
    expect(availability.mock.calls[0][0]).toBeNull()
    expect(availability.mock.calls[0][1]).toMatchObject({ origin: 'reset', resetPending: true })
    expect(first.isActive()).toBe(false)
    expect(later.isActive()).toBe(true)
    expect(store.settleWrite(first, savedReply('late-old-a')).settled).toBe(false)
    old.resolve(snapshot(10, { css: { fontSizeBase: 19 }, weather: { enabled: true } }))
    await expect(oldReading).rejects.toMatchObject({ code: 'SETTINGS_SNAPSHOT_INVALID' })
    expect(store.latest()).toBeNull()
    api.getSettingsSnapshot.mockRejectedValueOnce(new Error('still unavailable'))
    await expect(store.read()).rejects.toThrow('still unavailable')
    api.getSettingsSnapshot.mockResolvedValueOnce(
      snapshot(10, { css: { fontSizeBase: 12 }, weather: { enabled: false } })
    )
    expect((await store.read()).values.css.fontSizeBase).toBe(21)
    expect(store.status().resetPending).toBe(false)
    expect(later.isActive()).toBe(true)
    later()
    expect(store.latest().values.css.fontSizeBase).toBe(12)
    expect(store.settleWrite(first, savedReply('even-later-old-a')).settled).toBe(false)
    expect(store.latest().values.css.fontSizeBase).toBe(12)
  })

  it('does not let duplicate reset acknowledgements move an established read fence', async () => {
    const { store, api } = fixture()
    store.acceptCommitted(snapshot(1))
    const receipt = savedReply('reset-once')
    const checkpoint = store.captureIntentCheckpoint()
    store.settleReset(receipt, { checkpoint })
    const reading = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(reading.promise)
    const task = store.read()
    store.settleReset(receipt, { checkpoint })
    reading.resolve(snapshot(2, { css: { fontSizeBase: 12 } }))
    await expect(task).resolves.toMatchObject({ revision: 2 })
    expect(store.status().resetPending).toBe(false)
  })

  it('does not let duplicate write acknowledgements move an established read fence', async () => {
    const { store, api } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    const lease = store.protectSetting({}, 'css.fontSizeBase', 19)
    const receipt = savedReply()
    store.settleWrite(lease, receipt)
    const reading = deferred()
    api.getSettingsSnapshot.mockReturnValueOnce(reading.promise)
    const task = store.read()
    store.settleWrite(lease, receipt)
    reading.resolve(snapshot(2, { css: { fontSizeBase: 18 } }))
    expect((await task).values.css.fontSizeBase).toBe(18)
    expect(store.status().savedCount).toBe(0)
  })

  it('can acknowledge a save before any base exists without manufacturing defaults', async () => {
    const { store, api } = fixture()
    const lease = store.protectSetting({}, 'css.fontSizeBase', 19)
    expect(store.settleWrite(lease, savedReply())).toMatchObject({
      saved: true,
      settled: true,
      canonical: null,
      projection: null,
      unavailable: true
    })
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(999, {}, {}, 'foreign'))
    await expect(store.read()).rejects.toMatchObject({ code: 'SETTINGS_SNAPSHOT_INVALID' })
    expect(store.latest()).toBeNull()
    api.getSettingsSnapshot.mockResolvedValueOnce(snapshot(3, { css: { fontSizeBase: 18 } }))
    expect((await store.read()).values.css.fontSizeBase).toBe(18)
    expect(store.status().availability).toBe('available')
  })

  it('rejects foreign source settlement and cannot transfer an old document lease to a new store', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    const lease = store.protectSetting({}, 'css.fontSizeBase', 19)
    expect(store.settleWrite(lease, savedReply('foreign', 'replacement')).valid).toBe(false)
    expect(lease.isActive()).toBe(true)
    const next = createSettingsSnapshotStore({})
    next.acceptCommitted(snapshot(1, { css: { fontSizeBase: 14 } }, {}, 'replacement'))
    expect(next.settleWrite(lease, savedReply()).settled).toBe(false)
    expect(next.latest().values.css.fontSizeBase).toBe(14)
    expect(next.status().savedCount).toBe(0)
  })

  it('rejects malformed results without releasing the intent and retains the unknown-ID rejection route', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1, { css: { fontSizeBase: 12 } }))
    const lease = store.protectSetting({}, 'css.fontSizeBase', 19)
    expect(store.settleWrite(lease, { success: true }).settled).toBe(false)
    expect(lease.isActive()).toBe(true)
    const unknown = store.protectSetting({}, 'not-a-setting', 42)
    expect(unknown.isActive()).toBe(true)
    expect(store.settleWrite(unknown, savedReply()).settled).toBe(false)
    expect(store.protectedCount).toBe(1)
    unknown()
    expect(unknown.isActive()).toBe(false)
  })

  it('uses a normalized nested canonical even when the native operation reports failure', () => {
    const { store } = fixture()
    store.acceptCommitted(snapshot(1, { blur: { enabled: false, radius: 8 } }))
    const lease = store.protectDomain({}, 'blur', { blur: { enabled: true, radius: 19 } })
    const result = store.settleWrite(lease, {
      success: false,
      snapshot: snapshot(2, { blur: { enabled: false, radius: 18 } }, { blur: { error: 'native' } })
    })
    expect(result).toMatchObject({ saved: true, settled: true, current: true })
    expect(store.latest().values.blur).toEqual({ enabled: false, radius: 18 })
    expect(store.latest().runtime.blur.error).toBe('native')
    expect(store.status().awaitingCanonical).toBe(false)
    expect(store.protectedCount).toBe(0)
  })

  it('treats an object-valued setting as one submitted value rather than inheriting stale region fields', () => {
    const { store } = fixture()
    store.acceptCommitted(
      snapshot(1, { weather: { location: { id: 'old-id', name: 'old', admin2: 'old district' } } })
    )
    const lease = store.protectSetting({}, 'weather.location', { name: 'new', countryCode: 'CN' })
    store.settleWrite(lease, savedReply())
    expect(store.latest().values.weather.location).toEqual({ name: 'new', countryCode: 'CN' })
  })
})
