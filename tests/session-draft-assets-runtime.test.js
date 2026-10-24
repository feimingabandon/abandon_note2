import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createSettingsWriteSource } from '../src/main/settings/settings-write-source.js'
import { registerDraftAssetsIpc } from '../src/main/ipc/register-draft-assets-ipc.js'
import { sanitizeDiagnosticValue } from '../src/shared/diagnostic-sanitize.js'
import { DIAGNOSTIC_LIMITS } from '../src/shared/diagnostic-policy.js'
const factory = vi.hoisted(() => vi.fn())
vi.mock('../src/main/drafts/session-draft-assets.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createSessionDraftAssetStore: factory
}))
import { createSessionDraftAssetsRuntime } from '../src/main/drafts/session-draft-assets-runtime.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture(options = {}) {
  const contents = new EventEmitter()
  const frame = { url: 'http://127.0.0.1:32100/controlled.html', isDestroyed: () => false }
  Object.assign(contents, { mainFrame: frame, isDestroyed: () => false, isCrashed: () => false })
  const event = { sender: contents, senderFrame: frame }
  const settingsGate = vi.fn(() => {
    throw new Error('settings writes sealed')
  })
  const source = createSettingsWriteSource({
    getMainWindow: () => ({ webContents: contents, isDestroyed: () => false }),
    getActiveWindowName: () => 'main',
    getActiveRendererLocation: () => ({ type: 'url', value: frame.url }),
    assertCanWrite: settingsGate
  })
  const initial = source.issue(event)
  const store = {
    initialize: vi.fn(async () => true),
    openOwner: vi.fn(() => ({
      sessionId: 's',
      ownerId: 'o',
      generation: 1,
      capability: 'private'
    })),
    stage: vi.fn(async () => ({ assetId: 'asset' })),
    preview: vi.fn(async () => ({ bytes: Buffer.from('original') })),
    captureRead: vi.fn(() =>
      Object.freeze({
        sessionId: 's',
        documentId: 'document',
        ownerId: 'owner',
        generation: 1,
        assetId: 'asset',
        ext: 'png',
        size: 8,
        sha256: 'a'.repeat(64)
      })
    ),
    isReadCurrent: vi.fn(() => true),
    startRead: vi.fn((captured, reader) =>
      reader({
        path: 'main-only',
        sessionId: 's',
        assetId: captured.assetId,
        ext: captured.ext,
        size: captured.size,
        sha256: captured.sha256
      })
    ),
    release: vi.fn(async () => true),
    cancelOwner: vi.fn(async () => true),
    beginHandoff: vi.fn(() => 'operation'),
    waitHandoff: vi.fn(async () => ({ committed: true })),
    operationState: vi.fn(() => ({ operationId: 'operation', status: 'pending' })),
    drain: vi.fn(async () => true),
    clear: vi.fn(async () => true),
    dispose: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ assetCount: 1, assets: [{ assetId: 'original', path: 'main-only' }] }))
  }
  let coreOptions
  factory.mockImplementationOnce((value) => {
    coreOptions = value
    return store
  })
  const runtime = createSessionDraftAssetsRuntime({
    root: 'unused',
    sessionId: 's',
    settingsWriteSource: source,
    ...options
  })
  const document = runtime.captureDocument(event, initial)
  return {
    runtime,
    store,
    document,
    source,
    initial,
    event,
    contents,
    settingsGate,
    get coreOptions() {
      return coreOptions
    },
    reload() {
      contents.emit('did-navigate')
      return source.issue(event)
    }
  }
}

describe('session draft asset runtime document lifetime', () => {
  it('caches a stable core document while keeping settings write admission independent', async () => {
    const f = fixture({ sessionByteLimit: 123456 })
    await f.runtime.initialize()
    expect(f.runtime.captureDocument(f.event, { ...f.initial })).toBe(f.document)
    const lease = f.runtime.openOwner(f.document, 'editor')
    await f.runtime.stage(f.document, lease, { base64: 'YQ==', ext: 'png' })
    expect(f.store.openOwner).toHaveBeenCalledWith(f.document, 'editor', null)
    expect(f.store.stage.mock.calls[0][0]).toBe(f.document)
    expect(f.coreOptions.sessionByteLimit).toBe(123456)
    expect(f.coreOptions.isDocumentCurrent(f.document)).toBe(true)
    expect(f.settingsGate).not.toHaveBeenCalled()
    expect(() => f.source.assert(f.event, f.initial)).toThrow('settings writes sealed')
    expect(f.coreOptions.isDocumentCurrent(f.document)).toBe(true)
  })

  it('rejects late old-document work with the original source error after same-URL reload', async () => {
    const f = fixture()
    const held = deferred()
    f.store.stage.mockReturnValueOnce(held.promise)
    const pending = f.runtime.stage(f.document, {}, {})
    const failure = pending.catch((error) => error)
    const next = f.reload()
    const replacement = f.runtime.captureDocument(f.event, next)
    expect(replacement).not.toBe(f.document)
    expect(f.runtime.captureDocument(f.event, next)).toBe(replacement)
    expect(f.coreOptions.isDocumentCurrent(f.document)).toBe(false)
    held.resolve({ assetId: 'late' })
    expect(await failure).toMatchObject({ code: 'SETTINGS_SOURCE_EXPIRED' })
    expect(() => f.runtime.captureDocument(f.event, f.initial)).toThrow('页面已失效')
    expect(f.runtime.snapshot().runtime.pending).toBe(0)
  })

  it.each([
    ['stage', 'stage', 'EIO'],
    ['waitHandoff', 'wait-handoff', 'SQLITE_CONSTRAINT_TRIGGER']
  ])(
    'retains a held %s rejection as the main expiry error cause while public metadata stays fixed',
    async (method, channel, code) => {
      const f = fixture(),
        held = deferred()
      const lease = f.runtime.openOwner(f.document, 'editor')
      const original = Object.assign(new Error('original held operation failure'), { code })
      // Node 24 exposes Error.stack as an accessor even after assignment. Keep
      // this controlled fixture within the logger's data-descriptor-only contract.
      Object.defineProperty(original, 'stack', {
        configurable: true,
        writable: true,
        value: 'Error: original held operation failure\n    at controlled-' + method
      })
      f.store[method].mockReturnValueOnce(held.promise)
      const handlers = new Map(),
        logger = { error: vi.fn() }
      const unregister = registerDraftAssetsIpc({
        ipcMain: {
          handle: (name, handler) => handlers.set(name, handler),
          removeHandler: (name) => handlers.delete(name)
        },
        runtime: f.runtime,
        logger
      })
      try {
        const payload =
          method === 'stage'
            ? { lease, image: { base64: 'YQ==', ext: 'png' } }
            : { lease, operationId: 'operation' }
        const pending = handlers.get('draft-assets:' + channel)(f.event, payload, f.initial)
        f.reload()
        held.reject(original)
        expect(await pending).toEqual({
          ok: false,
          error: { code: 'DRAFT_DOCUMENT_EXPIRED', message: '草稿资产请求所属文档已失效' }
        })
        const logged = logger.error.mock.calls[0][1]
        expect(logged).toMatchObject({ code: 'SETTINGS_SOURCE_EXPIRED' })
        expect(logged.cause).toBe(original)
        expect(logged.cause.code).toBe(code)
        expect(logged.cause.stack).toBe(original.stack)
        // Match logger.js's actual error-record serializer and its half-record budget.
        const serialized = sanitizeDiagnosticValue(logged, {
          maxBytes: DIAGNOSTIC_LIMITS.errorBytes / 2
        })
        expect(serialized.cause).toMatchObject({
          code,
          message: original.message,
          stack: original.stack
        })
        expect(f.runtime.snapshot().runtime.pending).toBe(0)
      } finally {
        unregister()
      }
    }
  )

  it('seals immediately, drains admitted stage without invalidating it and resumes after failed SQL', async () => {
    const f = fixture()
    const held = deferred(),
      owner = Symbol('clear')
    const lease = f.runtime.openOwner(f.document, 'editor')
    f.store.stage.mockReturnValueOnce(held.promise)
    const admitted = f.runtime.stage(f.document, lease, {})
    let drained = false
    const sealing = f.runtime.sealAndDrain(owner).then(() => {
      drained = true
    })
    expect(f.runtime.snapshot().runtime.sealed).toBe(true)
    expect(() => f.runtime.stage(f.document, lease, {})).toThrow('DRAFT_RUNTIME_SEALED')
    expect(f.coreOptions.isDocumentCurrent(f.document)).toBe(true)
    expect(drained).toBe(false)
    expect(f.runtime.resume(Symbol('foreign'))).toBe(false)
    held.resolve({ assetId: 'admitted' })
    await expect(admitted).resolves.toEqual({ assetId: 'admitted' })
    await sealing
    expect(drained).toBe(true)
    expect(f.store.clear).not.toHaveBeenCalled()
    // Business SQL failed, so no clearAfterCommit call is made.
    expect(f.runtime.resume(owner)).toBe(true)
    await f.runtime.preview(f.document, lease, 'admitted')
    expect(f.store.preview).toHaveBeenCalledWith(f.document, lease, 'admitted')
  })

  it('only clears for the matching sealed SQL owner and stays sealed until explicit resume', async () => {
    const f = fixture(),
      owner = Symbol('committed-clear')
    await expect(f.runtime.clearAfterCommit(owner)).rejects.toMatchObject({
      code: 'DRAFT_RUNTIME_OWNER_INVALID'
    })
    await f.runtime.sealAndDrain(owner)
    expect(() => f.runtime.sealAndDrain(Symbol('foreign'))).toThrow('DRAFT_RUNTIME_OWNER_INVALID')
    const held = deferred()
    f.store.clear.mockReturnValueOnce(held.promise)
    const clearing = f.runtime.clearAfterCommit(owner)
    await Promise.resolve()
    expect(f.runtime.resume(owner)).toBe(false)
    held.resolve(true)
    await expect(clearing).resolves.toBe(true)
    expect(f.store.clear).toHaveBeenCalledOnce()
    expect(f.runtime.snapshot().runtime.sealed).toBe(true)
    expect(f.runtime.resume(owner)).toBe(true)
  })

  it('retains the seal after failed committed cleanup for an explicit cleanup retry', async () => {
    const f = fixture(),
      owner = Symbol('clear')
    await f.runtime.sealAndDrain(owner)
    const error = Object.assign(new Error('owned unlink failed'), { code: 'EACCES' })
    f.store.clear.mockRejectedValueOnce(error)
    await expect(f.runtime.clearAfterCommit(owner)).rejects.toBe(error)
    expect(f.runtime.snapshot().runtime).toMatchObject({ sealed: true, clearing: false })
    await expect(f.runtime.clearAfterCommit(owner)).resolves.toBe(true)
    expect(f.store.clear).toHaveBeenCalledTimes(2)
  })

  it('uses only the fixed main consumer, drains the core pin once, then disposes idempotently', async () => {
    const pin = deferred(),
      consumer = vi.fn(() => pin.promise)
    const f = fixture({ consumeAssets: consumer })
    f.store.beginHandoff.mockImplementation((_document, _lease, _ids, actual) => {
      actual([{ assetId: 'asset' }])
      return 'operation'
    })
    f.store.drain.mockImplementation(() => pin.promise)
    const foreignConsumer = vi.fn()
    expect(f.runtime.beginHandoff(f.document, {}, ['asset'], foreignConsumer)).toBe('operation')
    expect(consumer).toHaveBeenCalledOnce()
    expect(foreignConsumer).not.toHaveBeenCalled()
    const disposal = f.runtime.dispose()
    expect(f.runtime.dispose()).toBe(disposal)
    expect(() => f.runtime.stage(f.document, {}, {})).toThrow('DRAFT_STORE_CLOSED')
    expect(f.store.dispose).not.toHaveBeenCalled()
    expect(f.coreOptions.isDocumentCurrent(f.document)).toBe(true)
    pin.resolve({ committed: true })
    await disposal
    expect(f.store.dispose).toHaveBeenCalledOnce()
    expect(consumer).toHaveBeenCalledOnce()
    expect(f.coreOptions.isDocumentCurrent(f.document)).toBe(false)
  })

  it('keeps metadata query available while sealed and rejects absent consumers before core handoff', async () => {
    const f = fixture(),
      owner = Symbol('leave')
    expect(() => f.runtime.beginHandoff(f.document, {}, [])).toThrow('DRAFT_HANDOFF_UNAVAILABLE')
    expect(f.store.beginHandoff).not.toHaveBeenCalled()
    await f.runtime.sealAndDrain(owner)
    expect(f.runtime.operationState(f.document, {}, 'operation').status).toBe('pending')
    await f.runtime.dispose()
    expect(() => f.runtime.initialize()).toThrow('DRAFT_STORE_CLOSED')
    expect(() => f.runtime.operationState(f.document, {}, 'operation')).toThrow(
      'DRAFT_STORE_CLOSED'
    )
    expect(f.runtime.resume(owner)).toBe(false)
  })

  it('requires the shared owner and fixed image reader together', () => {
    const f = fixture()
    expect(() =>
      createSessionDraftAssetsRuntime({
        root: 'unused',
        sessionId: 's',
        settingsWriteSource: f.source,
        imageReads: { createPort: vi.fn() }
      })
    ).toThrow('Draft image preparation requires the shared owner and fixed reader')
    expect(() =>
      createSessionDraftAssetsRuntime({
        root: 'unused',
        sessionId: 's',
        settingsWriteSource: f.source,
        startImageRead: vi.fn()
      })
    ).toThrow('Draft image preparation requires the shared owner and fixed reader')
    expect(() =>
      fixture({ imageReads: { createPort: () => undefined }, startImageRead: vi.fn() })
    ).toThrow('Shared draft image port requires request')
  })

  it('queues only captured metadata and takes its read pin through the fixed active start', async () => {
    const response = deferred(),
      ending = deferred()
    let port
    const request = vi.fn(() => response.promise)
    const startImageRead = vi.fn(() => ({
      result: Promise.resolve(null),
      closed: ending.promise,
      cancel: vi.fn()
    }))
    const f = fixture({
      imageReads: {
        createPort: vi.fn((options) => {
          port = options
          return { request }
        })
      },
      startImageRead
    })
    const pending = f.runtime.preview(f.document, {}, 'asset')
    const captured = f.store.captureRead.mock.results[0].value
    const metadata = request.mock.calls[0][1]
    expect(port.name).toBe('draft')
    expect(metadata).toEqual({ captured, purpose: 'original', size: 512 })
    expect(metadata).not.toHaveProperty('path')
    expect(metadata).not.toHaveProperty('bytes')
    expect(f.store.startRead).not.toHaveBeenCalled()
    expect(startImageRead).not.toHaveBeenCalled()
    expect(port.isCurrent(metadata)).toBe(true)
    expect(f.store.isReadCurrent).toHaveBeenCalledWith(captured)
    const active = port.start(metadata)
    expect(f.store.startRead).toHaveBeenCalledOnce()
    expect(startImageRead).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'draft', path: 'main-only', assetId: 'asset' }),
      { purpose: 'original', size: 512 }
    )
    ending.resolve()
    await active.closed
    const bytes = Buffer.from('original')
    response.resolve({ payload: bytes, bytes: 8, sha256: 'a'.repeat(64) })
    await expect(pending).resolves.toEqual({
      bytes,
      ext: 'png',
      size: 8,
      sha256: 'a'.repeat(64)
    })
    expect(f.store.preview).not.toHaveBeenCalled()
  })

  it('returns bounded thumbnail metadata through the same port and rejects a late document response', async () => {
    const requests = []
    const f = fixture({
      imageReads: {
        createPort: () => ({
          request: (_key, metadata) => {
            const response = deferred()
            requests.push({ metadata, response })
            return response.promise
          }
        })
      },
      startImageRead: vi.fn()
    })
    const first = f.runtime.thumbnail(f.document, {}, 'asset', 1000)
    expect(requests[0].metadata).toMatchObject({ purpose: 'thumbnail', size: 512 })
    requests[0].response.resolve({ data: 'data:image/png;base64,YQ==', width: 20, height: 10 })
    await expect(first).resolves.toEqual({
      data: 'data:image/png;base64,YQ==',
      width: 20,
      height: 10
    })
    const tooLarge = f.runtime.thumbnail(f.document, {}, 'asset').catch((error) => error)
    requests[1].response.resolve({
      data: 'data:image/png;base64,' + 'a'.repeat(2 * 1024 * 1024),
      width: 20,
      height: 10
    })
    expect(await tooLarge).toMatchObject({ code: 'DRAFT_ASSET_INVALID' })
    const late = f.runtime.preview(f.document, {}, 'asset').catch((error) => error)
    f.reload()
    requests[2].response.resolve({
      payload: Buffer.from('original'),
      bytes: 8,
      sha256: 'a'.repeat(64)
    })
    expect(await late).toMatchObject({ code: 'SETTINGS_SOURCE_EXPIRED' })
  })
})
