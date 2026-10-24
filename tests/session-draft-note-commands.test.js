import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionDraftAssetsRuntime } from '../src/main/drafts/session-draft-assets-runtime.js'
import { createSessionDraftNoteCommands } from '../src/main/drafts/session-draft-note-commands.js'
import { registerDraftAssetsIpc } from '../src/main/ipc/register-draft-assets-ipc.js'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function held() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function fixture({ limit = 32, imageReads, startImageRead } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'abandon-draft-note-unit-'))
  roots.push(root)
  const sender = {},
    frame = {},
    event = { sender, senderFrame: frame }
  let token = 'original',
    generation = 1,
    denyUnlink = false
  const source = {
    captureCurrent: () => ({ token, scope: 'main' }),
    assertDocument(actual, actualSource) {
      if (actual.sender !== sender || actual.senderFrame !== frame || actualSource.token !== token)
        throw Object.assign(new Error('expired document'), { code: 'SETTINGS_SOURCE_EXPIRED' })
      return { scope: 'main', generation }
    }
  }
  let commands
  const runtime = createSessionDraftAssetsRuntime({
    root,
    sessionId: 'launch',
    settingsWriteSource: source,
    imageReads,
    startImageRead,
    io: {
      async unlink(path) {
        if (denyUnlink)
          throw Object.assign(new Error('EACCES C:\\private\\draft'), { code: 'EACCES' })
        const { unlink } = await import('node:fs/promises')
        return unlink(path)
      }
    },
    consumeAssets: (descriptors, request) => commands.consumeAssets(descriptors, request)
  })
  const create = vi.fn(async () => ({ id: 1, content: 'saved' }))
  const save = vi.fn(async (payload) => ({ id: payload.id, content: 'updated' }))
  const presented = vi.fn(),
    logger = { error: vi.fn() },
    admission = vi.fn((operation) => operation())
  commands = createSessionDraftNoteCommands({
    runtime,
    createNoteWithAssets: create,
    saveNoteDraft: save,
    runMutation: admission,
    onCommitted: presented,
    logger,
    maxRequestsPerOwner: limit
  })
  await runtime.initialize()
  let document = runtime.captureDocument(event, source.captureCurrent())
  let lease = runtime.openOwner(document, 'new:main')
  const asset = await runtime.stage(document, lease, {
    base64: Buffer.from('original image').toString('base64'),
    ext: 'png',
    name: 'image.png'
  })
  const payload = { options: { content: 'saved' }, images: [asset], tagIds: [] }
  const handlers = new Map()
  registerDraftAssetsIpc({
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      removeHandler: (name) => handlers.delete(name)
    },
    runtime,
    noteCommands: commands,
    logger
  })
  return {
    runtime,
    commands,
    create,
    save,
    presented,
    logger,
    admission,
    asset,
    payload,
    get document() {
      return document
    },
    get lease() {
      return lease
    },
    denyCleanup() {
      denyUnlink = true
    },
    allowCleanup() {
      denyUnlink = false
    },
    call(name, body) {
      return handlers.get('draft-assets:' + name)(event, body, source.captureCurrent())
    },
    reload() {
      token = 'replacement'
      generation++
      document = runtime.captureDocument(event, source.captureCurrent())
      lease = runtime.openOwner(document, 'new:main', {
        sessionId: lease.sessionId,
        key: 'new:main',
        ownerId: lease.ownerId,
        generation: lease.generation
      })
    }
  }
}

describe('fixed session draft note submissions', () => {
  it('does not introduce a new note text length restriction at the draft transport', async () => {
    const f = await fixture()
    const content = 'x'.repeat(1024 * 1024 + 1)
    const payload = { options: { content }, images: [], tagIds: [] }
    expect(
      await f.commands.submit(f.document, f.lease, 'long-text', 'create', payload)
    ).toMatchObject({ status: 'committed' })
    expect(f.create.mock.calls[0][0].options.content).toBe(content)
    await f.runtime.dispose()
  })
  it('retains one accepted request through reload and a lost IPC response without repeating SQL', async () => {
    const f = await fixture(),
      gate = held(),
      entered = held()
    f.create.mockImplementationOnce(async ({ images }) => {
      expect(images).toEqual([
        { base64: Buffer.from('original image').toString('base64'), ext: 'png' }
      ])
      entered.resolve()
      return gate.promise
    })
    const first = f.call('submit-note', {
      lease: f.lease,
      requestId: 'stable-request',
      kind: 'create',
      payload: f.payload
    })
    await entered.promise
    f.reload()
    expect(f.commands.state(f.document, f.lease, 'stable-request').status).toBe('pending')
    const replay = f.commands.submit(f.document, f.lease, 'stable-request', 'create', f.payload)
    gate.resolve({ id: 1, content: 'saved' })
    expect(await first).toEqual({
      ok: false,
      error: {
        code: 'DRAFT_DOCUMENT_EXPIRED',
        message: '草稿资产请求所属文档已失效'
      }
    })
    expect(await replay).toMatchObject({
      requestId: 'stable-request',
      status: 'committed',
      result: { id: 1 }
    })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.presented).toHaveBeenCalledOnce()
    expect(f.admission).toHaveBeenCalledOnce()
    expect(f.runtime.snapshot().assetCount).toBe(0)
    await f.runtime.dispose()
  })

  it('retains an accepted request through reload while its consumer still waits for an old preview to close', async () => {
    const ending = held()
    const f = await fixture({
      imageReads: {
        createPort: ({ start }) => ({ request: (_key, metadata) => start(metadata).result })
      },
      startImageRead: (descriptor) => ({
        result: Promise.resolve({
          payload: Buffer.from('original image'),
          bytes: 14,
          sha256: descriptor.sha256
        }),
        closed: ending.promise,
        cancel() {}
      })
    })
    await f.runtime.preview(f.document, f.lease, f.asset.assetId)
    const first = f.call('submit-note', {
      lease: f.lease,
      requestId: 'waiting-old-preview',
      kind: 'create',
      payload: f.payload
    })
    const oldResponse = first.catch((error) => error)
    try {
      expect(f.runtime.snapshot().assets[0]).toMatchObject({
        pins: 2,
        readPins: 1,
        handoffReserved: true
      })
      expect(f.create).not.toHaveBeenCalled()
      f.reload()
      expect(f.commands.state(f.document, f.lease, 'waiting-old-preview').status).toBe('pending')
      const replay = f.commands.submit(
        f.document,
        f.lease,
        'waiting-old-preview',
        'create',
        f.payload
      )
      ending.resolve()
      expect(await oldResponse).toMatchObject({
        ok: false,
        error: { code: 'DRAFT_DOCUMENT_EXPIRED' }
      })
      expect(await replay).toMatchObject({ status: 'committed', result: { id: 1 } })
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.presented).toHaveBeenCalledOnce()
      expect(f.admission).toHaveBeenCalledOnce()
      expect(f.runtime.snapshot().assetCount).toBe(0)
    } finally {
      ending.resolve()
      await oldResponse
      await f.runtime.dispose()
    }
  })

  it('refuses changed payloads for an accepted ID and keeps terminal identity at its bound', async () => {
    const f = await fixture({ limit: 1 })
    await f.commands.submit(f.document, f.lease, 'one', 'create', f.payload)
    expect(() =>
      f.commands.submit(f.document, f.lease, 'one', 'create', {
        ...f.payload,
        options: { content: 'different' }
      })
    ).toThrow('DRAFT_REQUEST_MISMATCH')
    expect(await f.commands.submit(f.document, f.lease, 'two', 'create', f.payload)).toMatchObject({
      status: 'rejected',
      error: { code: 'DRAFT_REQUEST_LIMIT' }
    })
    expect(f.commands.state(f.document, f.lease, 'two').status).toBe('unknown')
    expect(() =>
      f.commands.submit(f.document, f.lease, 'one', 'create', {
        ...f.payload,
        images: [{ ...f.asset, base64: 'forged' }]
      })
    ).toThrow('DRAFT_REQUEST_MISMATCH')
    expect(await f.commands.submit(f.document, f.lease, 'one', 'create', f.payload)).toMatchObject({
      status: 'committed'
    })
    expect(f.create).toHaveBeenCalledOnce()
    await f.runtime.dispose()
  })

  it('keeps failed SQL source assets, preserves raw diagnostics and starts a new attempt only with a new ID', async () => {
    const f = await fixture()
    const original = Object.assign(new Error('SQLITE_CONSTRAINT_TRIGGER private-path'), {
      code: 'SQLITE_CONSTRAINT_TRIGGER'
    })
    f.create.mockRejectedValueOnce(original)
    const failed = await f.commands.submit(f.document, f.lease, 'failed', 'create', f.payload)
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'SQLITE_CONSTRAINT_TRIGGER' } })
    expect(JSON.stringify(failed)).not.toContain('private-path')
    expect(f.logger.error.mock.calls[0][1]).toBe(original)
    expect((await f.runtime.preview(f.document, f.lease, f.asset.assetId)).bytes.toString()).toBe(
      'original image'
    )
    await f.commands.submit(f.document, f.lease, 'failed', 'create', f.payload)
    expect(f.create).toHaveBeenCalledOnce()
    expect(
      await f.commands.submit(f.document, f.lease, 'retry', 'create', f.payload)
    ).toMatchObject({ status: 'committed' })
    expect(f.create).toHaveBeenCalledTimes(2)
    await f.runtime.dispose()
  })

  it('keeps a committed result when source cleanup and presentation fail', async () => {
    const f = await fixture()
    f.denyCleanup()
    f.presented.mockRejectedValueOnce(new Error('presentation failed'))
    const saved = await f.commands.submit(f.document, f.lease, 'committed', 'create', f.payload)
    expect(saved).toMatchObject({
      status: 'committed',
      result: { id: 1 },
      cleanupErrors: [{ code: 'EACCES' }]
    })
    expect(JSON.stringify(saved)).not.toContain('private')
    expect(await f.commands.wait(f.document, f.lease, 'committed')).toEqual(saved)
    expect(f.create).toHaveBeenCalledOnce()
    f.allowCleanup()
    await f.runtime.dispose()
  })

  it('returns explicit revocation despite unlink failure and refuses the revoked lease', async () => {
    const f = await fixture()
    f.denyCleanup()
    const cancelled = await f.call('discard-owner', { lease: f.lease })
    expect(cancelled).toMatchObject({
      ok: true,
      value: { cancelled: true, cleanupErrors: [{ code: 'EACCES' }] }
    })
    expect(JSON.stringify(cancelled)).not.toContain('private')
    await expect(f.runtime.preview(f.document, f.lease, f.asset.assetId)).rejects.toMatchObject({
      code: 'DRAFT_LEASE_INVALID'
    })
    f.allowCleanup()
    await f.runtime.dispose()
  })

  it('checks lease, fixed command and metadata boundary before any business mutation', async () => {
    const f = await fixture()
    for (const [kind, payload] of [
      ['delete', f.payload],
      ['create', { ...f.payload, images: [{ ...f.asset, base64: 'forged' }] }],
      ['create', { ...f.payload, images: [{ ...f.asset, path: 'C:\\private' }] }]
    ])
      expect(await f.commands.submit(f.document, f.lease, 'request', kind, payload)).toMatchObject({
        status: 'rejected',
        error: { code: 'DRAFT_IPC_INVALID' }
      })
    expect(() =>
      f.commands.state(f.document, { ...f.lease, capability: 'foreign' }, 'request')
    ).toThrow()
    expect(f.commands.state(f.document, f.lease, 'unknown')).toEqual({
      requestId: 'unknown',
      status: 'unknown'
    })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.admission).not.toHaveBeenCalled()
    await f.runtime.dispose()
  })

  it('uses the full save command with original version and deletion IDs, mapping conflicts without losing sources', async () => {
    const f = await fixture()
    const payload = {
      id: 9,
      expectedVersion: 'old',
      fields: { content: 'changed', remark: 'kept' },
      tagIds: [],
      addedImages: [f.asset],
      deletedImageIds: [12]
    }
    f.save.mockRejectedValueOnce(new Error('便签已发生变化，当前草稿尚未保存'))
    expect(await f.commands.submit(f.document, f.lease, 'edit', 'save', payload)).toMatchObject({
      status: 'failed',
      error: { code: 'DRAFT_NOTE_CONFLICT' }
    })
    expect(f.save).toHaveBeenCalledWith({
      ...payload,
      addedImages: [
        {
          base64: Buffer.from('original image').toString('base64'),
          ext: 'png'
        }
      ]
    })
    expect(f.runtime.snapshot().assetCount).toBe(1)
    expect(f.create).not.toHaveBeenCalled()
    await f.runtime.dispose()
  })

  it('does not record a refused admission as accepted and leaves the same request available after resume', async () => {
    const f = await fixture(),
      owner = Symbol('clear')
    await f.runtime.sealAndDrain(owner)
    expect(
      await f.commands.submit(f.document, f.lease, 'not-accepted', 'create', f.payload)
    ).toMatchObject({
      status: 'rejected',
      error: { code: 'DRAFT_RUNTIME_SEALED' }
    })
    expect(f.commands.state(f.document, f.lease, 'not-accepted').status).toBe('unknown')
    f.runtime.resume(owner)
    expect(
      await f.commands.submit(f.document, f.lease, 'not-accepted', 'create', f.payload)
    ).toMatchObject({ status: 'committed' })
    await f.runtime.dispose()
  })
})
