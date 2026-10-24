import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Scale only the imported limits for bounded unit fixtures. Actual file bytes,
// reservations, ownership and asynchronous filesystem operations remain real.
// The Electron prototype uses the original 50MiB / 50 / 200MiB shared limits.
vi.mock('../src/shared/attachment-rules.js', async (importOriginal) => ({
  ...(await importOriginal()),
  MAX_IMAGE_BYTES: 8,
  MAX_ATTACHMENTS_PER_NOTE: 3,
  MAX_ATTACHMENT_BATCH_BYTES: 12
}))

import {
  createSessionDraftAssetStore,
  publicSessionDraftAssetError,
  readSessionDraftAssetPayload
} from '../src/main/drafts/session-draft-assets.js'
import { SESSION_DRAFT_ASSET_HEADER_BYTES } from '../src/main/drafts/session-draft-files.js'
import { createOwnedDraftAssetIo } from './helpers/owned-draft-asset-io.mjs'

const fixtures = []
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const image = (value, patch = {}) => ({
  base64: Buffer.from(value).toString('base64'),
  ext: 'png',
  name: 'fixture.png',
  size: 0,
  ...patch
})
const resume = (lease, key = 'new:prototype') => ({
  sessionId: lease.sessionId,
  key,
  ownerId: lease.ownerId,
  generation: lease.generation
})
function deferred() {
  let resolvePromise, rejectPromise
  const promise = new Promise((done, fail) => {
    resolvePromise = done
    rejectPromise = fail
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}
const payloadOnDisk = async (path) =>
  (await fs.readFile(path)).subarray(SESSION_DRAFT_ASSET_HEADER_BYTES).toString()
async function fixture(io = {}, options = {}) {
  const base = await fs.mkdtemp(join(tmpdir(), 'abandon-draft-assets-unit-'))
  let document = { epoch: 1 }
  const store = createSessionDraftAssetStore({
    root: join(base, 'assets'),
    sessionId: 'prototype-session',
    isDocumentCurrent: (candidate) => candidate === document,
    sessionByteLimit: 12,
    io,
    ...options
  })
  const value = {
    base,
    store,
    document,
    lease: store.openOwner(document, 'new:prototype'),
    replaceDocument() {
      document = { epoch: document.epoch + 1 }
      return document
    }
  }
  fixtures.push(value)
  return value
}
async function tick() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}
afterEach(async ({ task }) => {
  for (const entry of fixtures.splice(0)) {
    if (task.result?.state === 'fail') {
      console.error(
        'Preserved failed draft-assets unit fixture:',
        entry.base,
        entry.store.snapshot()
      )
      continue
    }
    try {
      await entry.store.dispose()
    } catch (error) {
      if (error !== entry.expectedDisposalFailure) {
        console.error('Preserved draft-assets cleanup failure:', entry.base, entry.store.snapshot())
        throw error
      }
      // This fixture injected a rejected close Promise without creating a real
      // resource. Its source-retention assertions precede harness-only removal.
    }
    const suffix = relative(resolve(tmpdir()), resolve(entry.base))
    if (
      !suffix ||
      suffix === '..' ||
      suffix.startsWith('..' + sep) ||
      isAbsolute(suffix) ||
      !basename(entry.base).startsWith('abandon-draft-assets-unit-')
    )
      throw new Error('Refusing cleanup outside the owned unit fixture')
    await fs.rm(entry.base, { recursive: true, force: true })
  }
})

describe('main-owned session draft assets', () => {
  it('holds the real owned FileHandle write and counts payload reads without touching foreign IO', async () => {
    const f = await fixture()
    const entered = deferred(),
      release = deferred()
    const metrics = { writes: 0, reads: 0, deniedUnlinks: 0 }
    let deny = false
    const { io } = createOwnedDraftAssetIo({
      filesystem: fs,
      assetRoot: join(f.base, 'assets'),
      metrics,
      beforeWrite: () => {
        entered.resolve()
        return release.promise
      },
      denyUnlink: () => deny
    })
    await f.store.dispose()
    f.store = createSessionDraftAssetStore({
      root: join(f.base, 'assets'),
      sessionId: 'io-probe-session',
      isDocumentCurrent: (document) => document === f.document,
      io
    })
    f.lease = f.store.openOwner(f.document, 'io:probe')
    const staged = f.store.stage(f.document, f.lease, image('abc'))
    let completed = false
    void staged.then(() => {
      completed = true
    })
    try {
      await entered.promise
      expect(metrics.writes).toBe(1)
      expect(completed).toBe(false)
      release.resolve()
      const metadata = await staged
      expect((await f.store.preview(f.document, f.lease, metadata.assetId)).bytes.toString()).toBe(
        'abc'
      )
      expect(metrics.reads).toBeGreaterThan(0)
      const beforeForeign = { ...metrics }
      const foreign = join(f.base, '00000000-0000-4000-8000-000000000001.asset')
      await io.writeFile(foreign, 'foreign')
      expect((await io.readFile(foreign)).toString()).toBe('foreign')
      deny = true
      await io.unlink(foreign)
      expect(metrics).toEqual(beforeForeign)
      const owned = f.store.snapshot().assets[0].path
      await expect(io.unlink(owned)).rejects.toMatchObject({ code: 'EACCES' })
      expect(metrics.deniedUnlinks).toBe(1)
      expect((await fs.stat(owned)).size).toBe(SESSION_DRAFT_ASSET_HEADER_BYTES + 3)
    } finally {
      deny = false
      release.resolve()
      await staged
    }
  })

  it('stages actual bytes behind an opaque ID and deletes only its recorded file', async () => {
    const f = await fixture()
    const metadata = await f.store.stage(f.document, f.lease, image('abc', { size: 999999 }))
    expect(metadata).toEqual({
      assetId: expect.any(String),
      ext: 'png',
      name: 'fixture.png',
      size: 3,
      sha256: hash(Buffer.from('abc'))
    })
    expect(metadata).not.toHaveProperty('path')
    const ownPath = f.store.snapshot().assets[0].path
    const foreign = join(f.base, 'assets', 'unknown-file.txt')
    await fs.writeFile(foreign, 'leave me')
    expect(await payloadOnDisk(ownPath)).toBe('abc')
    expect((await fs.stat(ownPath)).size).toBe(SESSION_DRAFT_ASSET_HEADER_BYTES + 3)
    const preview = await f.store.preview(f.document, f.lease, metadata.assetId)
    expect(preview.bytes).toEqual(Buffer.from('abc'))
    expect(preview.sha256).toBe(metadata.sha256)
    await f.store.release(f.document, f.lease, [metadata.assetId])
    expect(f.store.snapshot()).toMatchObject({ assetCount: 0, reservedBytes: 0 })
    await expect(fs.stat(ownPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.store.clear()
    expect(await fs.readFile(foreign, 'utf8')).toBe('leave me')
  })

  it('rejects wrong session, owner, generation, capability and document without releasing assets', async () => {
    const f = await fixture()
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    for (const patch of [
      { sessionId: 'foreign-session' },
      { ownerId: 'foreign-owner' },
      { generation: f.lease.generation + 1 },
      { capability: 'foreign-capability' }
    ]) {
      const lease = { ...f.lease, ...patch }
      await expect(f.store.preview(f.document, lease, metadata.assetId)).rejects.toMatchObject({
        code: 'DRAFT_LEASE_INVALID'
      })
      await expect(f.store.release(f.document, lease, [metadata.assetId])).rejects.toMatchObject({
        code: 'DRAFT_LEASE_INVALID'
      })
      await expect(f.store.cancelOwner(f.document, lease)).rejects.toMatchObject({
        code: 'DRAFT_LEASE_INVALID'
      })
    }
    const other = f.store.openOwner(f.document, 'new:other')
    await expect(f.store.preview(f.document, other, metadata.assetId)).rejects.toMatchObject({
      code: 'DRAFT_ASSET_INVALID'
    })
    await expect(f.store.stage({ epoch: 99 }, f.lease, image('x'))).rejects.toMatchObject({
      code: 'DRAFT_DOCUMENT_EXPIRED'
    })
    expect(f.store.snapshot().assetCount).toBe(1)
    expect((await f.store.preview(f.document, f.lease, metadata.assetId)).bytes.toString()).toBe(
      'abc'
    )
  })

  it('recovers only an unused owner after its opening receipt is lost across reload', async () => {
    const f = await fixture()
    expect(f.store.openOwner(f.document, 'new:prototype')).toEqual(f.lease)
    const next = f.replaceDocument()
    const recovered = f.store.openOwner(next, 'new:prototype')
    expect(recovered.ownerId).toBe(f.lease.ownerId)
    expect(recovered.capability).not.toBe(f.lease.capability)
    expect(f.store.snapshot().owners).toHaveLength(1)
    expect(f.store.openOwner(next, 'new:prototype')).toEqual(recovered)
    await expect(f.store.stage(next, f.lease, image('x'))).rejects.toMatchObject({
      code: 'DRAFT_LEASE_INVALID'
    })
    const metadata = await f.store.stage(next, recovered, image('abc'))
    expect((await f.store.preview(next, recovered, metadata.assetId)).bytes.toString()).toBe('abc')
  })

  it('does not let another live document claim an unused owner by key', async () => {
    const other = { epoch: 2 }
    const f = await fixture(
      {},
      { isDocumentCurrent: (candidate) => candidate.epoch === 1 || candidate === other }
    )
    expect(() => f.store.openOwner(other, 'new:prototype')).toThrow()
    expect(f.store.openOwner(f.document, 'new:prototype')).toEqual(f.lease)
  })

  it('requires the original receipt after all previously staged assets are released', async () => {
    const f = await fixture()
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    await f.store.release(f.document, f.lease, [metadata.assetId])
    expect(f.store.snapshot().assetCount).toBe(0)
    const next = f.replaceDocument()
    expect(() => f.store.openOwner(next, 'new:prototype')).toThrow()
    expect(f.store.openOwner(next, 'new:prototype', resume(f.lease)).ownerId).toBe(f.lease.ownerId)
  })

  it('requires the original receipt after a failed stage cleans its partial file', async () => {
    const f = await fixture({
      async writeFile() {
        throw Object.assign(new Error('Controlled payload write failure'), { code: 'EIO' })
      }
    })
    await expect(f.store.stage(f.document, f.lease, image('abc'))).rejects.toMatchObject({
      code: 'EIO'
    })
    expect(f.store.snapshot().assetCount).toBe(0)
    const next = f.replaceDocument()
    expect(() => f.store.openOwner(next, 'new:prototype')).toThrow()
    expect(f.store.openOwner(next, 'new:prototype', resume(f.lease)).ownerId).toBe(f.lease.ownerId)
  })

  it('requires the original receipt while an empty handoff is pending and after it completes', async () => {
    const f = await fixture()
    const entered = deferred(),
      finish = deferred()
    const operation = f.store.beginHandoff(f.document, f.lease, [], async () => {
      entered.resolve()
      await finish.promise
      return 'committed'
    })
    try {
      await entered.promise
      const next = f.replaceDocument()
      expect(() => f.store.openOwner(next, 'new:prototype')).toThrow()
      const rebound = f.store.openOwner(next, 'new:prototype', resume(f.lease))
      finish.resolve()
      expect(await f.store.waitHandoff(next, rebound, operation)).toBe('committed')
      const last = f.replaceDocument()
      expect(() => f.store.openOwner(last, 'new:prototype')).toThrow()
    } finally {
      finish.resolve()
    }
  })

  it('resumes the same owner after a real document replacement while revoking the previous capability', async () => {
    const f = await fixture()
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    const next = f.replaceDocument()
    expect(() => f.store.openOwner(next, 'new:prototype')).toThrow()
    for (const patch of [
      { sessionId: 'old-launch' },
      { key: 'wrong-key' },
      { ownerId: 'wrong-owner' },
      { generation: f.lease.generation + 1 }
    ])
      expect(() =>
        f.store.openOwner(next, 'new:prototype', { ...resume(f.lease), ...patch })
      ).toThrow()
    const rebound = f.store.openOwner(next, 'new:prototype', resume(f.lease))
    expect(rebound.ownerId).toBe(f.lease.ownerId)
    expect(rebound.generation).toBe(f.lease.generation)
    expect(rebound.capability).not.toBe(f.lease.capability)
    await expect(f.store.preview(f.document, f.lease, metadata.assetId)).rejects.toMatchObject({
      code: 'DRAFT_DOCUMENT_EXPIRED'
    })
    await expect(f.store.preview(next, f.lease, metadata.assetId)).rejects.toMatchObject({
      code: 'DRAFT_LEASE_INVALID'
    })
    expect((await f.store.preview(next, rebound, metadata.assetId)).bytes.toString()).toBe('abc')
  })

  it('cleans an unpublished late stage after reload without deleting the rebound owner assets', async () => {
    const entered = deferred(),
      finish = deferred()
    let hold = false
    const f = await fixture({
      async writeFile(...args) {
        await fs.writeFile(...args)
        if (hold) {
          entered.resolve()
          await finish.promise
        }
      }
    })
    const first = await f.store.stage(f.document, f.lease, image('abc'))
    hold = true
    const late = f.store.stage(f.document, f.lease, image('de')).catch((error) => error)
    try {
      await entered.promise
      const next = f.replaceDocument()
      const rebound = f.store.openOwner(next, 'new:prototype', resume(f.lease))
      finish.resolve()
      expect(await late).toMatchObject({ code: 'DRAFT_DOCUMENT_EXPIRED' })
      expect(f.store.snapshot().assetCount).toBe(1)
      expect((await f.store.preview(next, rebound, first.assetId)).bytes.toString()).toBe('abc')
      expect((await fs.readdir(join(f.base, 'assets'))).length).toBe(1)
    } finally {
      finish.resolve()
      await late
    }
  })

  it.each(['cancel', 'clear'])(
    'invalidates before awaiting a late stage during %s',
    async (kind) => {
      const entered = deferred(),
        finish = deferred()
      const f = await fixture({
        async writeFile(...args) {
          await fs.writeFile(...args)
          entered.resolve()
          await finish.promise
        }
      })
      const late = f.store.stage(f.document, f.lease, image('abc')).catch((error) => error)
      let closing
      try {
        await entered.promise
        closing = kind === 'cancel' ? f.store.cancelOwner(f.document, f.lease) : f.store.clear()
        let complete = false
        void closing.then(() => {
          complete = true
        })
        await tick()
        expect(complete).toBe(false)
        expect(f.store.snapshot().assetCount).toBe(1)
        if (kind === 'clear') {
          expect(() => f.store.openOwner(f.document, 'new:blocked')).toThrow()
          await expect(f.store.stage(f.document, f.lease, image('x'))).rejects.toMatchObject({
            code: 'DRAFT_STORE_CLEARING'
          })
        }
        finish.resolve()
        expect((await late).code).toBe(
          kind === 'clear' ? 'DRAFT_STORE_CLEARING' : 'DRAFT_LEASE_INVALID'
        )
        await expect(closing).resolves.toBe(true)
        expect(f.store.snapshot()).toMatchObject({ assetCount: 0, reservedBytes: 0, pending: 0 })
        expect(await fs.readdir(join(f.base, 'assets'))).toEqual([])
        const next = f.store.openOwner(f.document, 'new:prototype')
        expect(next.ownerId).not.toBe(f.lease.ownerId)
      } finally {
        finish.resolve()
        await late
        await closing
      }
    }
  )

  it('rejects a late preview after rebinding and never releases its source asset', async () => {
    const entered = deferred(),
      finish = deferred()
    let hold = false
    const f = await fixture({
      async open(path, flags) {
        const handle = await fs.open(path, flags)
        if (flags === 'r') {
          const read = handle.read.bind(handle)
          handle.read = async (...args) => {
            const result = await read(...args)
            if (hold && args[3] >= SESSION_DRAFT_ASSET_HEADER_BYTES) {
              entered.resolve()
              await finish.promise
            }
            return result
          }
        }
        return handle
      }
    })
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    hold = true
    const late = f.store.preview(f.document, f.lease, metadata.assetId).catch((error) => error)
    try {
      await entered.promise
      const next = f.replaceDocument()
      const rebound = f.store.openOwner(next, 'new:prototype', resume(f.lease))
      finish.resolve()
      expect(await late).toMatchObject({ code: 'DRAFT_DOCUMENT_EXPIRED' })
      hold = false
      expect((await f.store.preview(next, rebound, metadata.assetId)).sha256).toBe(metadata.sha256)
      expect(f.store.snapshot().assetCount).toBe(1)
    } finally {
      finish.resolve()
      await late
    }
  })

  it('preserves the original write error and accounts for a partial file until cleanup succeeds', async () => {
    const original = Object.assign(new Error('original controlled write error'), { code: 'EIO' })
    const cleanup = Object.assign(new Error('controlled unlink error'), { code: 'EACCES' })
    let rejectUnlink = true
    const f = await fixture({
      async writeFile(handle, bytes) {
        await fs.writeFile(handle, bytes.subarray(0, 1))
        throw original
      },
      async unlink(path) {
        if (rejectUnlink) throw cleanup
        await fs.unlink(path)
      }
    })
    try {
      await expect(f.store.stage(f.document, f.lease, image('abc'))).rejects.toBe(original)
      const retained = f.store.snapshot()
      expect(retained).toMatchObject({ assetCount: 1, reservedBytes: 3 })
      expect(retained.assets[0]).toMatchObject({
        status: 'cleanup-failed',
        failure: { message: original.message, code: 'EIO' },
        cleanupError: { message: cleanup.message, code: 'EACCES' }
      })
      expect(await payloadOnDisk(retained.assets[0].path)).toBe('a')
      rejectUnlink = false
      await f.store.clear()
      expect(f.store.snapshot()).toMatchObject({ assetCount: 0, reservedBytes: 0 })
    } finally {
      rejectUnlink = false
    }
  })

  it('waits cleanup failures without retrying them inside the same clear operation', async () => {
    const entered = deferred(),
      finish = deferred()
    const cleanup = Object.assign(new Error('first unlink unavailable'), { code: 'EACCES' })
    let rejectUnlink = true,
      unlinkCalls = 0
    const f = await fixture({
      async writeFile(...args) {
        await fs.writeFile(...args)
        entered.resolve()
        await finish.promise
      },
      async unlink(path) {
        unlinkCalls += 1
        if (rejectUnlink) throw cleanup
        await fs.unlink(path)
      }
    })
    const stage = f.store.stage(f.document, f.lease, image('abc')).catch((error) => error)
    let cleared
    try {
      await entered.promise
      cleared = f.store.clear().catch((error) => error)
      finish.resolve()
      expect((await stage).code).toBe('DRAFT_STORE_CLEARING')
      expect(await cleared).toBe(cleanup)
      expect(unlinkCalls).toBe(1)
      expect(f.store.snapshot().assets[0].status).toBe('cleanup-failed')
      rejectUnlink = false
      await f.store.clear()
      expect(unlinkCalls).toBe(2)
    } finally {
      rejectUnlink = false
      finish.resolve()
      await stage
      await cleared
    }
  })

  it('retains a failed release file and permits one explicit cleanup recovery', async () => {
    let rejectUnlink = true
    const original = Object.assign(new Error('release unlink unavailable'), { code: 'EACCES' })
    const f = await fixture({
      async unlink(path) {
        if (rejectUnlink) throw original
        await fs.unlink(path)
      }
    })
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    try {
      await expect(f.store.release(f.document, f.lease, [metadata.assetId])).rejects.toBe(original)
      expect(f.store.snapshot()).toMatchObject({ assetCount: 1, reservedBytes: 3 })
      expect(await payloadOnDisk(f.store.snapshot().assets[0].path)).toBe('abc')
      rejectUnlink = false
      await f.store.release(f.document, f.lease, [metadata.assetId])
      expect(f.store.snapshot().assetCount).toBe(0)
    } finally {
      rejectUnlink = false
    }
  })

  it.each([false, true])(
    'rejects inverse-order handoff and preview while release unlink is held, failure=%s',
    async (fails) => {
      const entered = deferred(),
        finish = deferred(),
        previewEntered = deferred(),
        finishPreview = deferred()
      let rejectUnlink = fails,
        original
      const f = await fixture({
        async open(path, flags) {
          const handle = await fs.open(path, flags)
          if (flags === 'r') {
            const read = handle.read.bind(handle)
            handle.read = async (...args) => {
              const result = await read(...args)
              if (args[3] >= SESSION_DRAFT_ASSET_HEADER_BYTES) {
                previewEntered.resolve()
                await finishPreview.promise
              }
              return result
            }
          }
          return handle
        },
        async unlink(path) {
          entered.resolve()
          await finish.promise
          if (rejectUnlink) {
            original = Object.assign(new Error(`EACCES: unlink '${path}'`), {
              code: 'EACCES',
              syscall: 'unlink',
              path
            })
            throw original
          }
          await fs.unlink(path)
        }
      })
      const metadata = await f.store.stage(f.document, f.lease, image('abc'))
      const source = f.store.snapshot().assets[0].path
      const consumer = vi.fn(async () => 'must not run')
      const latePreview = f.store
        .preview(f.document, f.lease, metadata.assetId)
        .catch((error) => error)
      let releasing
      try {
        await previewEntered.promise
        releasing = f.store.release(f.document, f.lease, [metadata.assetId]).catch((error) => error)
        expect(f.store.snapshot().assets[0]).toMatchObject({
          status: 'ready',
          pins: 1,
          readPins: 1,
          retiring: true
        })
        expect(() => f.store.captureRead(f.document, f.lease, metadata.assetId)).toThrow()
        finishPreview.resolve()
        await entered.promise
        expect(f.store.snapshot().assets[0]).toMatchObject({ status: 'cleaning', pins: 0 })
        expect(f.store.snapshot()).toMatchObject({ assetCount: 1, reservedBytes: 3 })
        expect(() =>
          f.store.beginHandoff(f.document, f.lease, [metadata.assetId], consumer)
        ).toThrow()
        await expect(f.store.preview(f.document, f.lease, metadata.assetId)).rejects.toMatchObject({
          code: 'DRAFT_ASSET_INVALID'
        })
        finishPreview.resolve()
        expect(await latePreview).toMatchObject({ code: 'DRAFT_ASSET_INVALID' })
        expect(consumer).not.toHaveBeenCalled()
        expect(f.store.snapshot().operations).toEqual([])
        expect(await payloadOnDisk(source)).toBe('abc')
        finish.resolve()
        const outcome = await releasing
        if (fails) {
          expect(outcome).toBe(original)
          expect(f.store.snapshot()).toMatchObject({ assetCount: 1, reservedBytes: 3 })
          expect(f.store.snapshot().assets[0]).toMatchObject({
            status: 'cleanup-failed',
            cleanupError: { message: original.message, code: 'EACCES', path: source }
          })
          rejectUnlink = false
          await f.store.release(f.document, f.lease, [metadata.assetId])
        } else expect(outcome).toBe(true)
        expect(f.store.snapshot()).toMatchObject({ assetCount: 0, reservedBytes: 0 })
        await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        rejectUnlink = false
        finish.resolve()
        finishPreview.resolve()
        await latePreview
        await releasing
      }
    }
  )

  it('reserves actual pending bytes across owners and counts pending assets before IO completes', async () => {
    const entered = deferred(),
      finish = deferred()
    let writes = 0
    const f = await fixture({
      async writeFile(...args) {
        await fs.writeFile(...args)
        if (++writes === 2) entered.resolve()
        await finish.promise
      }
    })
    const other = f.store.openOwner(f.document, 'new:other')
    const first = f.store.stage(f.document, f.lease, image('12345678'))
    const second = f.store.stage(f.document, other, image('1234'))
    try {
      await entered.promise
      expect(f.store.snapshot()).toMatchObject({ reservedBytes: 12, assetCount: 2 })
      await expect(f.store.stage(f.document, other, image('x'))).rejects.toMatchObject({
        code: 'DRAFT_ASSET_LIMIT'
      })
      await expect(f.store.stage(f.document, other, image('123456789'))).rejects.toMatchObject({
        code: 'DRAFT_ASSET_LIMIT'
      })
      finish.resolve()
      await Promise.all([first, second])
    } finally {
      finish.resolve()
      await Promise.allSettled([first, second])
    }
  })

  it('reserves per-owner pending count even for tiny image payloads', async () => {
    const entered = deferred(),
      finish = deferred()
    let writes = 0
    const f = await fixture({
      async writeFile(...args) {
        await fs.writeFile(...args)
        if (++writes === 3) entered.resolve()
        await finish.promise
      }
    })
    const stages = Array.from({ length: 3 }, () => f.store.stage(f.document, f.lease, image('x')))
    try {
      await entered.promise
      await expect(f.store.stage(f.document, f.lease, image('y'))).rejects.toMatchObject({
        code: 'DRAFT_ASSET_LIMIT'
      })
      expect(f.store.snapshot()).toMatchObject({ assetCount: 3, reservedBytes: 3 })
      finish.resolve()
      await Promise.all(stages)
    } finally {
      finish.resolve()
      await Promise.allSettled(stages)
    }
  })

  it('keeps the owner byte rule independent of a larger technical session budget', async () => {
    const f = await fixture({}, { sessionByteLimit: 20 })
    await f.store.stage(f.document, f.lease, image('12345678'))
    await f.store.stage(f.document, f.lease, image('1234'))
    await expect(f.store.stage(f.document, f.lease, image('x'))).rejects.toMatchObject({
      code: 'DRAFT_ASSET_LIMIT'
    })
    const other = f.store.openOwner(f.document, 'new:other')
    await f.store.stage(f.document, other, image('12345678'))
    await expect(f.store.stage(f.document, other, image('x'))).rejects.toMatchObject({
      code: 'DRAFT_ASSET_LIMIT'
    })
    expect(f.store.snapshot()).toMatchObject({
      ownerByteLimit: 12,
      sessionByteLimit: 20,
      reservedBytes: 20
    })
  })

  it('drains admitted IO without revoking its lease or deleting its source', async () => {
    const entered = deferred(),
      finish = deferred()
    const f = await fixture({
      async writeFile(...args) {
        await fs.writeFile(...args)
        entered.resolve()
        await finish.promise
      }
    })
    const staging = f.store.stage(f.document, f.lease, image('abc'))
    let settled = false
    try {
      await entered.promise
      const draining = f.store.drain().then(() => {
        settled = true
      })
      await tick()
      expect(settled).toBe(false)
      finish.resolve()
      const metadata = await staging
      await draining
      expect((await f.store.preview(f.document, f.lease, metadata.assetId)).bytes.toString()).toBe(
        'abc'
      )
      expect(f.store.snapshot()).toMatchObject({ pending: 0, assetCount: 1, disposed: false })
    } finally {
      finish.resolve()
      await staging
    }
  })

  it('never claims or unlinks a preexisting file when exclusive creation fails', async () => {
    let collision
    const f = await fixture({
      async open(path, flags) {
        if (flags === 'wx') {
          collision = path
          await fs.writeFile(path, 'foreign collision')
        }
        return fs.open(path, flags)
      }
    })
    await expect(f.store.stage(f.document, f.lease, image('abc'))).rejects.toMatchObject({
      code: 'EEXIST'
    })
    expect(await fs.readFile(collision, 'utf8')).toBe('foreign collision')
    expect(f.store.snapshot()).toMatchObject({ assetCount: 0, reservedBytes: 0 })
    await f.store.clear()
    expect(await fs.readFile(collision, 'utf8')).toBe('foreign collision')
  })

  it.each(['header-write', 'header-sync'])(
    'preserves the original %s failure and writes no payload before ownership is durable',
    async (phase) => {
      const original = Object.assign(new Error(`controlled ${phase} error`), { code: 'EIO' })
      const cleanup = Object.assign(new Error('controlled owned cleanup error'), { code: 'EACCES' })
      let rejectUnlink = true
      const payloadWrite = vi.fn(async (...args) => fs.writeFile(...args))
      const f = await fixture({
        async open(path, flags) {
          const handle = await fs.open(path, flags)
          if (flags !== 'wx') return handle
          return {
            async writeFile(bytes) {
              await handle.writeFile(phase === 'header-write' ? bytes.subarray(0, 7) : bytes)
              if (phase === 'header-write') throw original
            },
            async sync() {
              throw original
            },
            stat: () => handle.stat(),
            close: () => handle.close()
          }
        },
        writeFile: payloadWrite,
        async unlink(path) {
          if (rejectUnlink) throw cleanup
          await fs.unlink(path)
        }
      })
      try {
        await expect(f.store.stage(f.document, f.lease, image('abc'))).rejects.toBe(original)
        expect(payloadWrite).not.toHaveBeenCalled()
        const diagnostics = f.store.snapshot()
        expect(diagnostics.assets[0]).toMatchObject({
          status: 'cleanup-failed',
          failure: { message: original.message, code: 'EIO' },
          cleanupError: { message: cleanup.message, code: 'EACCES' }
        })
        expect((await fs.stat(diagnostics.assets[0].path)).size).toBe(
          phase === 'header-write' ? 7 : SESSION_DRAFT_ASSET_HEADER_BYTES
        )
        rejectUnlink = false
        await f.store.clear()
        expect(f.store.snapshot().assetCount).toBe(0)
      } finally {
        rejectUnlink = false
      }
    }
  )

  it('pins synchronously, waits release, and never removes a consumer-owned committed file', async () => {
    const entered = deferred(),
      finish = deferred()
    const f = await fixture()
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    const source = f.store.snapshot().assets[0].path
    const final = join(f.base, 'formal-attachment.png')
    const result = { noteId: 17 }
    const operationId = f.store.beginHandoff(
      f.document,
      f.lease,
      [metadata.assetId],
      async ([asset]) => {
        expect(asset.path).toBe(source)
        expect(asset.sha256).toBe(metadata.sha256)
        const bytes = await readSessionDraftAssetPayload(asset)
        entered.resolve()
        await finish.promise
        await fs.writeFile(final, bytes)
        return result
      }
    )
    expect(f.store.snapshot().assets[0].pins).toBe(1)
    expect(f.store.operationState(f.document, f.lease, operationId).status).toBe('pending')
    const waiting = f.store.waitHandoff(f.document, f.lease, operationId)
    const releasing = f.store.release(f.document, f.lease, [metadata.assetId])
    try {
      await entered.promise
      expect(await payloadOnDisk(source)).toBe('abc')
      finish.resolve()
      expect(await waiting).toBe(result)
      await expect(releasing).resolves.toBe(true)
      expect(f.store.operationState(f.document, f.lease, operationId).status).toBe('committed')
      expect(f.store.snapshot().assetCount).toBe(0)
      await f.store.cancelOwner(f.document, f.lease)
      expect(await fs.readFile(final, 'utf8')).toBe('abc')
    } finally {
      finish.resolve()
      await Promise.allSettled([waiting, releasing])
    }
  })

  it('preserves a failed consumer source for a later explicit handoff', async () => {
    const f = await fixture()
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    const original = new Error('consumer transaction failed')
    const failed = f.store.beginHandoff(f.document, f.lease, [metadata.assetId], async () => {
      throw original
    })
    await expect(f.store.waitHandoff(f.document, f.lease, failed)).rejects.toBe(original)
    expect(f.store.operationState(f.document, f.lease, failed)).toMatchObject({
      status: 'failed',
      error: {
        code: 'DRAFT_ASSET_OPERATION_FAILED',
        message: '草稿资产操作失败，请保留草稿后重试'
      }
    })
    expect((await f.store.preview(f.document, f.lease, metadata.assetId)).bytes.toString()).toBe(
      'abc'
    )
    const succeeding = f.store.beginHandoff(f.document, f.lease, [metadata.assetId], async () => 23)
    await expect(f.store.waitHandoff(f.document, f.lease, succeeding)).resolves.toBe(23)
    expect(f.store.snapshot().assetCount).toBe(0)
  })

  it('publishes fixed errors while preserving an actual absolute-path IO error for main diagnostics', async () => {
    const f = await fixture()
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    const missing = join(f.base, 'assets', 'missing-source.asset')
    let original
    const id = f.store.beginHandoff(f.document, f.lease, [metadata.assetId], async () => {
      try {
        await fs.readFile(missing)
      } catch (error) {
        original = error
        throw error
      }
    })
    const outcome = await f.store.waitHandoff(f.document, f.lease, id).catch((error) => error)
    expect(outcome).toBe(original)
    expect(original).toMatchObject({ code: 'ENOENT', path: missing })
    expect(original.message).toContain(missing)
    const publicState = f.store.operationState(f.document, f.lease, id)
    expect(publicState.error).toEqual({
      code: 'ENOENT',
      message: '草稿资产文件不可用，请保留草稿后重试'
    })
    expect(JSON.stringify(publicState)).not.toContain(missing)
    expect(JSON.stringify(publicState)).not.toContain(f.base)
    expect(
      f.store.snapshot().operations.find((operation) => operation.operationId === id).error
    ).toMatchObject({
      message: original.message,
      code: 'ENOENT',
      path: missing,
      syscall: original.syscall
    })
    const unknown = { code: missing, message: missing, path: missing, stack: missing }
    expect(publicSessionDraftAssetError(unknown)).toEqual({
      code: 'DRAFT_ASSET_OPERATION_FAILED',
      message: '草稿资产操作失败，请保留草稿后重试'
    })
    expect(unknown).toEqual({ code: missing, message: missing, path: missing, stack: missing })
  })

  it('keeps a committed result after draft cleanup failure and reports the retained source separately', async () => {
    let rejectUnlink = true
    let cleanup
    const f = await fixture({
      async unlink(path) {
        if (rejectUnlink) {
          cleanup = Object.assign(new Error(`EACCES: unlink '${path}'`), {
            code: 'EACCES',
            syscall: 'unlink',
            path
          })
          throw cleanup
        }
        await fs.unlink(path)
      }
    })
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    try {
      const id = f.store.beginHandoff(
        f.document,
        f.lease,
        [metadata.assetId],
        async () => 'committed'
      )
      await expect(f.store.waitHandoff(f.document, f.lease, id)).resolves.toBe('committed')
      const publicState = f.store.operationState(f.document, f.lease, id)
      expect(publicState).toMatchObject({
        status: 'committed',
        cleanupErrors: [
          {
            code: 'EACCES',
            message: '草稿资产文件访问被拒绝，请保留草稿后重试'
          }
        ]
      })
      const diagnostics = f.store.snapshot()
      const source = diagnostics.assets[0].path
      expect(cleanup.message).toContain(source)
      expect(JSON.stringify(publicState)).not.toContain(source)
      expect(JSON.stringify(publicState)).not.toContain(f.base)
      expect(diagnostics.assets[0].cleanupError).toMatchObject({
        message: cleanup.message,
        code: 'EACCES',
        path: source,
        syscall: 'unlink'
      })
      expect(
        diagnostics.operations.find((operation) => operation.operationId === id).cleanupErrors
      ).toEqual([
        expect.objectContaining({ message: cleanup.message, code: 'EACCES', path: source })
      ])
      expect(f.store.snapshot().assetCount).toBe(1)
      rejectUnlink = false
      await f.store.release(f.document, f.lease, [metadata.assetId])
    } finally {
      rejectUnlink = false
    }
  })

  it('lets the rebound document query one admitted handoff while rejecting the old late wait', async () => {
    const entered = deferred(),
      finish = deferred()
    const f = await fixture()
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    let calls = 0
    const id = f.store.beginHandoff(f.document, f.lease, [metadata.assetId], async ([asset]) => {
      calls += 1
      await readSessionDraftAssetPayload(asset)
      entered.resolve()
      await finish.promise
      return { noteId: 27 }
    })
    const old = f.store.waitHandoff(f.document, f.lease, id).catch((error) => error)
    try {
      await entered.promise
      const next = f.replaceDocument()
      const rebound = f.store.openOwner(next, 'new:prototype', resume(f.lease))
      const current = f.store.waitHandoff(next, rebound, id)
      finish.resolve()
      expect(await current).toEqual({ noteId: 27 })
      expect(await old).toMatchObject({ code: 'DRAFT_DOCUMENT_EXPIRED' })
      expect(calls).toBe(1)
      expect(f.store.operationState(next, rebound, id).status).toBe('committed')
    } finally {
      finish.resolve()
      await old
    }
  })

  it('seals clear before waiting pinned IO and only clears the draft source after the consumer settles', async () => {
    const entered = deferred(),
      finish = deferred()
    const f = await fixture()
    const metadata = await f.store.stage(f.document, f.lease, image('abc'))
    const source = f.store.snapshot().assets[0].path
    const final = join(f.base, 'committed-after-clear.png')
    let committed = false
    f.store.beginHandoff(f.document, f.lease, [metadata.assetId], async ([asset]) => {
      const bytes = await readSessionDraftAssetPayload(asset)
      entered.resolve()
      await finish.promise
      await fs.writeFile(final, bytes)
      committed = true
    })
    let clearing
    try {
      await entered.promise
      clearing = f.store.clear()
      expect(f.store.snapshot().clearing).toBe(true)
      expect(f.store.snapshot().assets[0].pins).toBe(1)
      expect(await payloadOnDisk(source)).toBe('abc')
      expect(() => f.store.openOwner(f.document, 'new:blocked')).toThrow()
      finish.resolve()
      await expect(clearing).resolves.toBe(true)
      expect(committed).toBe(true)
      expect(f.store.snapshot()).toMatchObject({ assetCount: 0, reservedBytes: 0, pending: 0 })
      expect(await fs.readFile(final, 'utf8')).toBe('abc')
    } finally {
      finish.resolve()
      await clearing
    }
  })

  it('bounds terminal results to sixteen and never exposes another owner operation', async () => {
    const f = await fixture()
    const ids = []
    for (let index = 0; index < 19; index++) {
      const id = f.store.beginHandoff(f.document, f.lease, [], async () => index)
      ids.push(id)
      await expect(f.store.waitHandoff(f.document, f.lease, id)).resolves.toBe(index)
    }
    expect(f.store.snapshot().operations).toHaveLength(16)
    expect(() => f.store.operationState(f.document, f.lease, ids[0])).toThrow()
    const other = f.store.openOwner(f.document, 'new:other')
    expect(() => f.store.operationState(f.document, other, ids.at(-1))).toThrow()
    expect(f.store.operationState(f.document, f.lease, ids.at(-1)).status).toBe('committed')
  })

  it('captures bounded metadata without reading or pinning and rejects forged or expired captures', async () => {
    let reads = 0
    const f = await fixture({
      async open(path, flags) {
        if (flags === 'r') reads++
        return fs.open(path, flags)
      }
    })
    const asset = await f.store.stage(f.document, f.lease, image('abc', { name: 'x'.repeat(8192) }))
    const captured = f.store.captureRead(f.document, f.lease, asset.assetId)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.keys(captured).sort()).toEqual(
      [
        'sessionId',
        'documentId',
        'ownerId',
        'generation',
        'assetId',
        'ext',
        'size',
        'sha256'
      ].sort()
    )
    expect(reads).toBe(0)
    expect(f.store.snapshot().assets[0].pins).toBe(0)
    expect(f.store.isReadCurrent(captured)).toBe(true)
    const reader = vi.fn()
    expect(() => f.store.startRead({ ...captured }, reader)).toThrow()
    const next = f.replaceDocument()
    const rebound = f.store.openOwner(next, 'new:prototype', resume(f.lease))
    expect(f.store.isReadCurrent(captured)).toBe(false)
    expect(() => f.store.startRead(captured, reader)).toThrow()
    expect(reader).not.toHaveBeenCalled()
    const replacement = f.store.captureRead(next, rebound, asset.assetId)
    expect(f.store.isReadCurrent(replacement)).toBe(true)
    expect(replacement.documentId).not.toBe(captured.documentId)
  })

  it('keeps a non-consuming source pinned after its result until real closed and reserves release immediately', async () => {
    const f = await fixture()
    const asset = await f.store.stage(f.document, f.lease, image('abc'))
    const source = f.store.snapshot().assets[0].path
    const ending = deferred(),
      cancel = vi.fn()
    const operation = f.store.startRead(
      f.store.captureRead(f.document, f.lease, asset.assetId),
      (descriptor) => {
        expect(Object.isFrozen(descriptor)).toBe(true)
        expect(descriptor).toMatchObject({ path: source, assetId: asset.assetId, size: 3 })
        expect(descriptor).not.toHaveProperty('name')
        return { result: Promise.resolve('prepared'), closed: ending.promise, cancel }
      }
    )
    expect(await operation.result).toBe('prepared')
    operation.cancel('caller-left')
    expect(cancel).toHaveBeenCalledWith('caller-left')
    const releasing = f.store.release(f.document, f.lease, [asset.assetId])
    let released = false
    void releasing.then(() => {
      released = true
    })
    await tick()
    expect(released).toBe(false)
    expect(f.store.snapshot().assets[0]).toMatchObject({ pins: 1, readPins: 1, retiring: true })
    expect(() => f.store.captureRead(f.document, f.lease, asset.assetId)).toThrow()
    expect(await payloadOnDisk(source)).toBe('abc')
    ending.resolve()
    await operation.closed
    await releasing
    expect(f.store.snapshot().assetCount).toBe(0)
  })

  it.each(['reload', 'cancel', 'clear'])(
    'continues one accepted handoff waiting old readers through %s',
    async (kind) => {
      const f = await fixture()
      const asset = await f.store.stage(f.document, f.lease, image('abc'))
      const source = f.store.snapshot().assets[0].path
      const ending = deferred()
      const reading = f.store.startRead(
        f.store.captureRead(f.document, f.lease, asset.assetId),
        () => ({ result: Promise.resolve(null), closed: ending.promise, cancel() {} })
      )
      const consumer = vi.fn(async ([descriptor]) => {
        expect((await readSessionDraftAssetPayload(descriptor)).toString()).toBe('abc')
        return 'committed'
      })
      const id = f.store.beginHandoff(f.document, f.lease, [asset.assetId], consumer)
      const oldWait = f.store.waitHandoff(f.document, f.lease, id).catch((error) => error)
      let closing, reboundWait
      try {
        await tick()
        expect(consumer).not.toHaveBeenCalled()
        expect(f.store.snapshot().assets[0]).toMatchObject({
          pins: 2,
          readPins: 1,
          handoffReserved: true
        })
        expect(() => f.store.captureRead(f.document, f.lease, asset.assetId)).toThrow()
        if (kind === 'reload') {
          const next = f.replaceDocument()
          const rebound = f.store.openOwner(next, 'new:prototype', resume(f.lease))
          reboundWait = f.store.waitHandoff(next, rebound, id)
        } else {
          closing = kind === 'cancel' ? f.store.cancelOwner(f.document, f.lease) : f.store.clear()
        }
        expect(await payloadOnDisk(source)).toBe('abc')
        ending.resolve()
        await reading.closed
        if (reboundWait) expect(await reboundWait).toBe('committed')
        await closing
        expect(await oldWait).toMatchObject({
          code:
            kind === 'reload'
              ? 'DRAFT_DOCUMENT_EXPIRED'
              : kind === 'clear'
                ? 'DRAFT_STORE_CLEARING'
                : 'DRAFT_LEASE_INVALID'
        })
        expect(consumer).toHaveBeenCalledOnce()
        expect(f.store.snapshot().assetCount).toBe(0)
      } finally {
        ending.resolve()
        await Promise.allSettled([oldWait, reboundWait, closing])
      }
    }
  )

  it('withdraws only the expired release reservation so a rebound owner can read again', async () => {
    const f = await fixture()
    const asset = await f.store.stage(f.document, f.lease, image('abc'))
    const ending = deferred()
    const reading = f.store.startRead(
      f.store.captureRead(f.document, f.lease, asset.assetId),
      () => ({ result: Promise.resolve(null), closed: ending.promise, cancel() {} })
    )
    const releasing = f.store.release(f.document, f.lease, [asset.assetId]).catch((error) => error)
    const next = f.replaceDocument()
    const rebound = f.store.openOwner(next, 'new:prototype', resume(f.lease))
    expect(() => f.store.captureRead(next, rebound, asset.assetId)).toThrow()
    ending.resolve()
    await reading.closed
    expect(await releasing).toMatchObject({ code: 'DRAFT_DOCUMENT_EXPIRED' })
    expect(f.store.snapshot().assets[0]).toMatchObject({
      pins: 0,
      retiring: false,
      status: 'ready'
    })
    expect(f.store.isReadCurrent(f.store.captureRead(next, rebound, asset.assetId))).toBe(true)
  })

  it('retains an unconfirmed read source and rejects release, drain, clear and dispose without hanging', async () => {
    const f = await fixture()
    const asset = await f.store.stage(f.document, f.lease, image('abc'))
    const source = f.store.snapshot().assets[0].path
    const ending = deferred()
    const original = Object.assign(new Error('owned read close unconfirmed'), { code: 'EIO' })
    const reading = f.store.startRead(
      f.store.captureRead(f.document, f.lease, asset.assetId),
      () => ({ result: Promise.resolve(null), closed: ending.promise, cancel() {} })
    )
    ending.reject(original)
    await expect(reading.closed).rejects.toBe(original)
    expect(f.store.snapshot().assets[0]).toMatchObject({
      pins: 1,
      readPins: 1,
      readFailure: { code: 'EIO' }
    })
    await expect(f.store.release(f.document, f.lease, [asset.assetId])).rejects.toBe(original)
    await expect(f.store.drain()).rejects.toBe(original)
    await expect(f.store.clear()).rejects.toBe(original)
    await expect(f.store.dispose()).rejects.toBe(original)
    expect(await payloadOnDisk(source)).toBe('abc')
    f.expectedDisposalFailure = original
  })

  it('releases a resource-free start refusal but returns rejected closed for a malformed ownership contract', async () => {
    const f = await fixture()
    const asset = await f.store.stage(f.document, f.lease, image('abc'))
    const captured = f.store.captureRead(f.document, f.lease, asset.assetId)
    const refusal = new Error('reader refused before creating a resource')
    expect(() =>
      f.store.startRead(captured, () => {
        throw refusal
      })
    ).toThrow(refusal)
    expect(f.store.snapshot().assets[0]).toMatchObject({ pins: 0, readPins: 0 })
    const operation = f.store.startRead(captured, () => ({
      result: Promise.resolve(null),
      cancel() {}
    }))
    const error = await operation.closed.catch((failure) => failure)
    expect(error).toBeInstanceOf(TypeError)
    await expect(operation.result).rejects.toBe(error)
    await expect(f.store.drain()).rejects.toBe(error)
    expect(f.store.snapshot().assets[0]).toMatchObject({ pins: 1, readPins: 1 })
    f.expectedDisposalFailure = error
  })

  it('disposes permanently and never removes an unknown file in its root', async () => {
    const f = await fixture()
    await f.store.stage(f.document, f.lease, image('abc'))
    const unknown = join(f.base, 'assets', 'unowned.txt')
    await fs.writeFile(unknown, 'keep')
    await expect(f.store.dispose()).resolves.toBe(true)
    expect(f.store.snapshot()).toMatchObject({ disposed: true, assetCount: 0, pending: 0 })
    expect(await fs.readFile(unknown, 'utf8')).toBe('keep')
    expect(() => f.store.openOwner(f.document, 'new:closed')).toThrow()
    await expect(f.store.stage(f.document, f.lease, image('x'))).rejects.toMatchObject({
      code: 'DRAFT_STORE_CLOSED'
    })
  })
})
