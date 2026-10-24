import { describe, expect, it, vi } from 'vitest'
import { registerDraftAssetsIpc } from '../src/main/ipc/register-draft-assets-ipc.js'

const lease = {
  sessionId: 'session',
  ownerId: 'owner',
  generation: 1,
  capability: 'preload-private'
}
function fixture() {
  const handlers = new Map([['unrelated', () => true]])
  const event = { sender: {}, senderFrame: {} },
    source = { token: 'document', scope: 'main' },
    document = {}
  let current = true
  const expired = Object.assign(new Error('original SETTINGS_SOURCE_EXPIRED diagnostic'), {
    code: 'SETTINGS_SOURCE_EXPIRED'
  })
  const runtime = {
    captureDocument: vi.fn((actualEvent, actualSource) => {
      if (
        !current ||
        actualEvent !== event ||
        actualSource?.token !== source.token ||
        actualSource?.scope !== source.scope
      )
        throw expired
      return document
    }),
    assertDocument: vi.fn((actual) => {
      if (!current || actual !== document) throw expired
    }),
    openOwner: vi.fn(() => lease),
    stage: vi.fn(async () => ({ assetId: 'asset' })),
    preview: vi.fn(async () => ({ bytes: Buffer.from('asset') })),
    thumbnail: vi.fn(async () => ({ data: 'data:image/png;base64,YQ==', width: 1, height: 1 })),
    release: vi.fn(async () => true),
    cancelOwner: vi.fn(async () => true),
    operationState: vi.fn(() => ({ operationId: 'op', status: 'pending' })),
    waitHandoff: vi.fn(async () => ({ committed: true }))
  }
  const ipcMain = {
    handle: vi.fn((channel, listener) => {
      if (handlers.has(channel)) throw new Error('duplicate')
      handlers.set(channel, listener)
    }),
    removeHandler: vi.fn((channel) => handlers.delete(channel))
  }
  const logger = { error: vi.fn() }
  const register = () => registerDraftAssetsIpc({ ipcMain, runtime, logger })
  return {
    handlers,
    event,
    source,
    document,
    runtime,
    ipcMain,
    logger,
    register,
    expired,
    expire: () => {
      current = false
    },
    call: (name, payload) => handlers.get('draft-assets:' + name)(event, payload, source)
  }
}

describe('controlled session draft asset IPC', () => {
  it('registers only eight fixed channels, forwards source-bound operations and removes only its handlers', async () => {
    const f = fixture(),
      dispose = f.register()
    expect(f.handlers.size).toBe(9)
    for (const name of ['begin-handoff', 'snapshot', 'clear', 'dispose', 'invoke'])
      expect(f.handlers.has('draft-assets:' + name)).toBe(false)
    await expect(f.call('open-owner', { key: 'editor' })).resolves.toEqual({
      ok: true,
      value: lease
    })
    await expect(
      f.call('stage', { lease, image: { base64: 'YQ==', ext: 'png' } })
    ).resolves.toEqual({ ok: true, value: { assetId: 'asset' } })
    expect(f.runtime.stage).toHaveBeenCalledWith(f.document, lease, { base64: 'YQ==', ext: 'png' })
    expect((await f.call('preview', { lease, assetId: 'asset' })).ok).toBe(true)
    expect((await f.call('thumbnail', { lease, assetId: 'asset', size: 512 })).value).toEqual({
      data: 'data:image/png;base64,YQ==',
      width: 1,
      height: 1
    })
    expect(f.runtime.thumbnail).toHaveBeenCalledWith(f.document, lease, 'asset', 512)
    expect((await f.call('release', { lease, assetIds: ['asset'] })).value).toBe(true)
    expect((await f.call('cancel-owner', { lease })).value).toBe(true)
    expect((await f.call('operation-state', { lease, operationId: 'op' })).value.status).toBe(
      'pending'
    )
    expect((await f.call('wait-handoff', { lease, operationId: 'op' })).value).toEqual({
      committed: true
    })
    dispose()
    dispose()
    expect([...f.handlers.keys()]).toEqual(['unrelated'])
    expect(f.ipcMain.removeHandler).toHaveBeenCalledTimes(8)
  })

  it('rejects invalid thumbnail sizes before dispatching any image work', async () => {
    const f = fixture()
    f.register()
    for (const size of [0, 31, 513, 32.5, '512', null]) {
      expect(await f.call('thumbnail', { lease, assetId: 'asset', size })).toMatchObject({
        ok: false,
        error: { code: 'DRAFT_IPC_INVALID' }
      })
    }
    expect(f.runtime.thumbnail).not.toHaveBeenCalled()
  })

  it('refuses foreign/missing sources before invoking an owner and preserves the original error in main logging', async () => {
    const f = fixture()
    f.register()
    const handle = f.handlers.get('draft-assets:open-owner')
    for (const [event, source] of [
      [{}, f.source],
      [f.event, null],
      [f.event, { ...f.source, token: 'foreign' }]
    ]) {
      expect(await handle(event, { key: 'editor' }, source)).toEqual({
        ok: false,
        error: { code: 'DRAFT_DOCUMENT_EXPIRED', message: '草稿资产请求所属文档已失效' }
      })
    }
    expect(f.runtime.openOwner).not.toHaveBeenCalled()
    expect(f.logger.error.mock.calls[0][1]).toBe(f.expired)
  })

  it('rejects a late response against its original document without recapturing a replacement', async () => {
    const f = fixture()
    f.register()
    let release
    f.runtime.stage.mockReturnValueOnce(
      new Promise((done) => {
        release = done
      })
    )
    const pending = f.call('stage', { lease, image: { base64: 'YQ==', ext: 'png' } })
    f.expire()
    release({ assetId: 'late' })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'DRAFT_DOCUMENT_EXPIRED' } })
    expect(f.runtime.captureDocument).toHaveBeenCalledTimes(1)
    expect(f.logger.error.mock.calls[0][1]).toBe(f.expired)
  })

  it.each([
    ['open-owner', { key: 'editor', path: 'C:\\private' }],
    [
      'open-owner',
      {
        key: 'editor',
        resume: {
          sessionId: 's',
          key: 'editor',
          ownerId: 'o',
          generation: 1,
          capability: 'persisted'
        }
      }
    ],
    ['stage', { lease, image: { path: 'C:\\private', ext: 'png', base64: 'YQ==' } }],
    ['stage', { lease, image: { base64: 'YQ==', ext: 'png' }, consumer: () => {} }],
    ['preview', { lease: { ...lease, path: 'private' }, assetId: 'asset' }],
    ['release', { lease, assetIds: 'asset' }],
    ['operation-state', { lease, operationId: 1 }]
  ])('rejects malformed %s payload before the business port', async (name, payload) => {
    const f = fixture()
    f.register()
    expect(await f.call(name, payload)).toMatchObject({
      ok: false,
      error: { code: 'DRAFT_IPC_INVALID' }
    })
    for (const key of ['openOwner', 'stage', 'preview', 'release', 'operationState'])
      expect(f.runtime[key]).not.toHaveBeenCalled()
  })

  it('returns only fixed public filesystem failure metadata even when logging itself fails', async () => {
    const f = fixture()
    f.register()
    const error = Object.assign(new Error('secret C:\\Users\\private\\asset'), {
      code: 'EACCES',
      path: 'secret',
      stack: 'secret stack'
    })
    f.runtime.preview.mockRejectedValueOnce(error)
    f.logger.error.mockImplementationOnce(() => {
      throw new Error('logger unavailable')
    })
    expect(await f.call('preview', { lease, assetId: 'asset' })).toEqual({
      ok: false,
      error: { code: 'EACCES', message: '草稿资产文件访问被拒绝，请保留草稿后重试' }
    })
    expect(f.logger.error.mock.calls[0][1]).toBe(error)
  })

  it('rolls back only channels registered by this call after a partial registration collision', () => {
    const f = fixture(),
      existing = () => true
    f.handlers.set('draft-assets:preview', existing)
    expect(() => f.register()).toThrow('duplicate')
    expect([...f.handlers.keys()]).toEqual(['unrelated', 'draft-assets:preview'])
    expect(f.handlers.get('draft-assets:preview')).toBe(existing)
  })
})
