import { describe, expect, it, vi } from 'vitest'
import { createDraftAssetsClient } from '../src/preload/draft-assets-client.js'
import { createSettingsClient } from '../src/preload/settings-client.js'

const lease = {
  sessionId: 'session',
  ownerId: 'owner',
  generation: 1,
  capability: 'private-capability'
}
const asset = {
  assetId: 'asset',
  ext: 'png',
  name: 'original.png',
  size: 3,
  sha256: 'a'.repeat(64)
}
function fixture() {
  const source = { token: 'fixed-document', scope: 'main' }
  const replies = new Map([
    ['open-owner', { ...lease }],
    ['stage', { ...asset, path: 'main-only' }],
    [
      'preview',
      {
        bytes: Buffer.from([1, 2, 3]),
        ext: 'png',
        size: 3,
        sha256: asset.sha256,
        path: 'main-only'
      }
    ],
    ['release', true],
    ['cancel-owner', true],
    ['operation-state', { operationId: 'op', status: 'pending' }],
    ['wait-handoff', { committed: true }]
  ])
  const ipc = {
    invoke: vi.fn(async (channel) =>
      channel === 'settings:write-context'
        ? source
        : { ok: true, value: replies.get(channel.slice('draft-assets:'.length)) }
    )
  }
  const settings = createSettingsClient(ipc)
  const client = createDraftAssetsClient({ invoke: settings.invoke.bind(settings) })
  return { client, ipc, replies, source }
}

describe('private preload session draft asset client', () => {
  it('projects bounded PNG thumbnails through the same private source without changing preview bytes', async () => {
    const f = fixture(),
      owner = await f.client.openOwner('editor')
    const expected = { data: 'data:image/png;base64,AQID', width: 120, height: 80 }
    f.replies.set('thumbnail', { ...expected, path: 'main-only', capability: 'private' })
    expect(await f.client.thumbnail(owner, 'asset')).toEqual(expected)
    expect(f.ipc.invoke.mock.calls.at(-1)).toEqual([
      'draft-assets:thumbnail',
      { lease, assetId: 'asset', size: 512 },
      f.source
    ])
    f.replies.set('thumbnail', null)
    expect(await f.client.thumbnail(owner, 'asset', 32)).toBeNull()
    for (const value of [
      { ...expected, data: 'data:image/svg+xml;base64,AQID' },
      { ...expected, data: 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024) },
      { ...expected, width: 0 },
      { ...expected, height: 16385 }
    ]) {
      f.replies.set('thumbnail', value)
      await expect(f.client.thumbnail(owner, 'asset')).rejects.toMatchObject({
        code: 'DRAFT_IPC_INVALID'
      })
    }
    const calls = f.ipc.invoke.mock.calls.length
    await expect(f.client.thumbnail(owner, 'asset', 513)).rejects.toMatchObject({
      code: 'DRAFT_IPC_INVALID'
    })
    expect(f.ipc.invoke).toHaveBeenCalledTimes(calls)
    expect((await f.client.preview(owner, 'asset')).bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('shares the original settings document source, retains capabilities privately and exposes only fixed methods', async () => {
    const f = fixture()
    const owner = await f.client.openOwner('editor')
    expect(owner).toEqual({ sessionId: 'session', key: 'editor', ownerId: 'owner', generation: 1 })
    expect(JSON.stringify(owner)).not.toContain('capability')
    expect(f.client.invoke).toBeUndefined()
    expect(f.client.beginHandoff).toBeUndefined()
    expect(f.client.snapshot).toBeUndefined()
    expect(
      await f.client.stage(owner, {
        base64: 'AQID',
        ext: 'png',
        name: 'original.png',
        path: 'renderer-attempt'
      })
    ).toEqual(asset)
    expect(f.ipc.invoke.mock.calls).toEqual([
      ['settings:write-context'],
      ['draft-assets:open-owner', { key: 'editor', resume: null }, f.source],
      [
        'draft-assets:stage',
        { lease, image: { base64: 'AQID', ext: 'png', name: 'original.png' } },
        f.source
      ]
    ])
    expect(
      f.ipc.invoke.mock.calls.filter(([channel]) => channel === 'settings:write-context')
    ).toHaveLength(1)
  })

  it('copies exact preview bytes rather than the underlying buffer span and strips main-only properties', async () => {
    const f = fixture(),
      owner = await f.client.openOwner('editor')
    const backing = Buffer.from([9, 1, 2, 3, 8])
    f.replies.set('preview', {
      bytes: backing.subarray(1, 4),
      ext: 'png',
      size: 3,
      sha256: asset.sha256,
      path: 'private',
      capability: 'private'
    })
    const preview = await f.client.preview(owner, 'asset')
    expect(preview.bytes).toBeInstanceOf(Uint8Array)
    expect([...preview.bytes]).toEqual([1, 2, 3])
    expect(Object.keys(preview)).toEqual(['bytes', 'ext', 'size', 'sha256'])
    backing[1] = 77
    expect([...preview.bytes]).toEqual([1, 2, 3])
  })

  it('resumes only with public owner metadata and does not automatically upgrade an old private capability', async () => {
    const f = fixture(),
      oldOwner = await f.client.openOwner('editor')
    const replacement = createDraftAssetsClient({ invoke: createSettingsClient(f.ipc).invoke })
    f.replies.set('open-owner', { ...lease, capability: 'replacement-capability' })
    const resumed = await replacement.openOwner('editor', oldOwner)
    expect(resumed).toEqual(oldOwner)
    const resumeCall = f.ipc.invoke.mock.calls.filter(
      ([channel]) => channel === 'draft-assets:open-owner'
    )[1]
    expect(resumeCall[1]).toEqual({ key: 'editor', resume: oldOwner })
    await replacement.stage(resumed, { base64: 'AQID', ext: 'png' })
    await f.client.stage(oldOwner, { base64: 'AQID', ext: 'png' })
    const stageCalls = f.ipc.invoke.mock.calls.filter(
      ([channel]) => channel === 'draft-assets:stage'
    )
    expect(stageCalls.map((call) => call[1].lease.capability)).toEqual([
      'replacement-capability',
      'private-capability'
    ])
    expect(JSON.stringify(resumed)).not.toContain('replacement-capability')
    f.replies.set('open-owner', { ...lease, generation: lease.generation + 1 })
    await expect(replacement.openOwner('editor', oldOwner)).rejects.toMatchObject({
      code: 'DRAFT_OWNER_RESUME_INVALID'
    })
  })

  it.each(['sessionId', 'ownerId', 'generation', 'key'])(
    'rejects altered %s owner metadata before invoking IPC',
    async (field) => {
      const f = fixture(),
        owner = await f.client.openOwner('editor')
      const count = f.ipc.invoke.mock.calls.length
      await expect(
        f.client.stage({ ...owner, [field]: field === 'generation' ? 2 : 'foreign' }, {})
      ).rejects.toMatchObject({ code: 'DRAFT_LEASE_INVALID' })
      expect(f.ipc.invoke).toHaveBeenCalledTimes(count)
    }
  )

  it('projects operation errors to public code/message and never copies a diagnostic path or stack', async () => {
    const f = fixture(),
      owner = await f.client.openOwner('editor')
    f.replies.set('operation-state', {
      operationId: 'op',
      status: 'failed',
      path: 'main-only',
      error: { code: 'EIO', message: 'fixed public failure', path: 'private', stack: 'private' },
      cleanupErrors: [{ code: 'EACCES', message: 'fixed cleanup failure', path: 'private' }]
    })
    expect(await f.client.operationState(owner, 'op')).toEqual({
      operationId: 'op',
      status: 'failed',
      error: { code: 'EIO', message: 'fixed public failure' },
      cleanupErrors: [{ code: 'EACCES', message: 'fixed cleanup failure' }]
    })
    await expect(f.client.waitHandoff(owner, 'op')).resolves.toEqual({ committed: true })
  })

  it('preserves an owner after failed cancellation and forgets it only after successful cancellation', async () => {
    const f = fixture(),
      owner = await f.client.openOwner('editor')
    const before = f.ipc.invoke.mock.calls.length
    await expect(f.client.release(owner, 'asset')).rejects.toMatchObject({
      code: 'DRAFT_IPC_INVALID'
    })
    expect(f.ipc.invoke).toHaveBeenCalledTimes(before)
    const originalInvoke = f.ipc.invoke.getMockImplementation()
    f.ipc.invoke.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'EACCES', message: 'fixed cancellation failure', path: 'private' }
    }))
    await expect(f.client.cancelOwner(owner)).rejects.toMatchObject({
      code: 'EACCES',
      message: 'fixed cancellation failure'
    })
    f.ipc.invoke.mockImplementation(originalInvoke)
    await expect(f.client.preview(owner, 'asset')).resolves.toMatchObject({ size: 3 })
    await expect(f.client.cancelOwner(owner)).resolves.toBe(true)
    await expect(f.client.preview(owner, 'asset')).rejects.toMatchObject({
      code: 'DRAFT_LEASE_INVALID'
    })
  })

  it('does not leak transport rejection details or accept malformed leases/preview data', async () => {
    const f = fixture()
    f.ipc.invoke.mockRejectedValueOnce(new Error('C:\\private\\source stack'))
    await expect(f.client.openOwner('editor')).rejects.toMatchObject({
      code: 'DRAFT_ASSET_OPERATION_FAILED',
      message: '草稿资产操作失败，请保留草稿后重试'
    })
    // A failed initial settings handshake may be retried by its existing client.
    const owner = await f.client.openOwner('editor')
    f.replies.set('preview', { bytes: Buffer.from([1]), ext: 'png', size: 3, sha256: asset.sha256 })
    await expect(f.client.preview(owner, 'asset')).rejects.toMatchObject({
      code: 'DRAFT_IPC_INVALID'
    })
    f.replies.set('open-owner', { ...lease, capability: null })
    await expect(f.client.openOwner('new')).rejects.toMatchObject({ code: 'DRAFT_IPC_INVALID' })
  })

  it('forgets an explicitly revoked owner even when physical cleanup remains incomplete', async () => {
    const f = fixture(),
      owner = await f.client.openOwner('editor')
    f.replies.set('discard-owner', {
      cancelled: true,
      path: 'private',
      cleanupErrors: [{ code: 'EACCES', message: 'fixed cleanup failure', stack: 'private' }]
    })
    expect(await f.client.discardOwner(owner)).toEqual({
      cancelled: true,
      cleanupErrors: [{ code: 'EACCES', message: 'fixed cleanup failure' }]
    })
    await expect(f.client.preview(owner, 'asset')).rejects.toMatchObject({
      code: 'DRAFT_LEASE_INVALID'
    })
  })

  it('projects fixed note submission results and keeps the capability in its source-bound request only', async () => {
    const f = fixture(),
      owner = await f.client.openOwner('editor')
    const payload = { options: { content: 'note' }, images: [asset], tagIds: [] }
    f.replies.set('submit-note', {
      requestId: 'stable',
      status: 'committed',
      result: { id: 1, content: 'note' },
      path: 'main-only',
      cleanupErrors: [{ code: 'EACCES', message: 'fixed cleanup', path: 'private' }]
    })
    expect(await f.client.submitNote(owner, 'stable', 'create', payload)).toEqual({
      requestId: 'stable',
      status: 'committed',
      result: { id: 1, content: 'note' },
      cleanupErrors: [{ code: 'EACCES', message: 'fixed cleanup' }]
    })
    expect(f.ipc.invoke.mock.calls.at(-1)).toEqual([
      'draft-assets:submit-note',
      { lease, requestId: 'stable', kind: 'create', payload },
      f.source
    ])
    f.replies.set('note-state', { requestId: 'stable', status: 'pending' })
    expect(await f.client.noteState(owner, 'stable')).toEqual({
      requestId: 'stable',
      status: 'pending'
    })
    f.replies.set('wait-note', {
      requestId: 'stable',
      status: 'failed',
      error: { code: 'SQLITE_BUSY', message: 'fixed failure', path: 'private' }
    })
    expect(await f.client.waitNote(owner, 'stable')).toEqual({
      requestId: 'stable',
      status: 'failed',
      error: { code: 'SQLITE_BUSY', message: 'fixed failure' }
    })
    f.replies.set('note-state', { requestId: 'different', status: 'committed', result: { id: 1 } })
    await expect(f.client.noteState(owner, 'stable')).rejects.toMatchObject({
      code: 'DRAFT_IPC_INVALID'
    })
    await expect(f.client.submitNote(owner, 'stable', 'delete', payload)).rejects.toMatchObject({
      code: 'DRAFT_IPC_INVALID'
    })
    f.replies.set('submit-note', {
      requestId: 'refused',
      status: 'rejected',
      error: { code: 'DRAFT_RUNTIME_SEALED', message: 'fixed refusal', path: 'private' }
    })
    expect(await f.client.submitNote(owner, 'refused', 'create', payload)).toEqual({
      requestId: 'refused',
      status: 'rejected',
      error: { code: 'DRAFT_RUNTIME_SEALED', message: 'fixed refusal' }
    })
  })

  it('disposes private state synchronously and refuses a late owner response after disposal', async () => {
    let release
    const invoke = vi.fn(
      () =>
        new Promise((done) => {
          release = done
        })
    )
    const client = createDraftAssetsClient({ invoke })
    const pending = client.openOwner('editor')
    const outcome = pending.catch((error) => error)
    client.dispose()
    client.dispose()
    release({ ok: true, value: lease })
    expect(await outcome).toMatchObject({ code: 'DRAFT_STORE_CLOSED' })
    await expect(client.openOwner('editor')).rejects.toMatchObject({ code: 'DRAFT_STORE_CLOSED' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
