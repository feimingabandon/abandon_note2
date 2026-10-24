import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { imageFileVersion } from '../src/main/images/image-decode-child.js'
import {
  readImagePreviewSource,
  startImagePreviewRead
} from '../src/main/images/image-preview-reader.js'

const directories = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

const deferred = () => {
  let resolve, reject
  const promise = new Promise((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}
const payload = Buffer.from('fixed owned image snapshot')
const metadata = {
  width: 8,
  height: 4,
  format: 'png',
  mime: 'image/png',
  version: '1:2:26:1:4:5',
  bytes: payload.length,
  sha256: createHash('sha256').update(payload).digest('hex')
}
const stored = { kind: 'stored', path: resolve('test-owned.png') }
const terminal = { code: 0, processTree: { activeProcesses: 0, jobClosed: true } }
function child() {
  const result = deferred(),
    closed = deferred()
  return {
    result: result.promise,
    closed: closed.promise,
    cancel: vi.fn(),
    respond: result.resolve,
    close: closed.resolve,
    failClose: closed.reject
  }
}
function fixture(options = {}) {
  const owned = child()
  const readSource = vi.fn(async () => ({ payload, version: metadata.version }))
  const startChild = vi.fn(() => owned)
  const reader = startImagePreviewRead(stored, { startChild, readSource, ...options })
  return { reader, owned, readSource, startChild }
}

function sourceIO() {
  const status = {
    dev: 1n,
    ino: 2n,
    size: BigInt(payload.length),
    nlink: 1n,
    mtimeNs: 4n,
    ctimeNs: 5n,
    isFile: () => true
  }
  const handle = {
    stat: vi.fn(async () => status),
    read: vi.fn(async (target, offset, length, position) => ({
      bytesRead: payload.copy(target, offset, position, position + length)
    })),
    close: vi.fn(async () => {})
  }
  const lstatFile = vi.fn(async () => status)
  return { status, handle, lstatFile, openFile: vi.fn(async () => handle) }
}

describe('preview original and thumbnail ownership', () => {
  it('sends only metadata and holds the main read until the real child terminal state', async () => {
    const { reader, owned, readSource, startChild } = fixture()
    owned.respond(metadata)
    await flush()
    expect(readSource).not.toHaveBeenCalled()
    expect(startChild.mock.calls[0][0]).toEqual({
      mode: 'preview',
      source: stored,
      purpose: 'original',
      size: 512
    })
    owned.close(terminal)
    await expect(reader.result).resolves.toEqual({ ...metadata, payload })
    expect(readSource).toHaveBeenCalledWith(stored, {
      expectedVersion: metadata.version,
      shouldContinue: expect.any(Function)
    })
    await expect(reader.closed).resolves.toBe(terminal)
  })

  it('refuses changed content even when length and version are unchanged', async () => {
    const changed = Buffer.from(payload)
    changed[0] ^= 1
    const { reader, owned } = fixture({
      readSource: async () => ({ payload: changed, version: metadata.version })
    })
    owned.respond(metadata)
    owned.close(terminal)
    await expect(reader.result).rejects.toMatchObject({ code: 'IMAGE_PREVIEW_SOURCE_CHANGED' })
    await expect(reader.closed).resolves.toBe(terminal)
  })

  it('cancels the child and never opens the main source for a late result', async () => {
    const { reader, owned, readSource } = fixture()
    reader.cancel()
    expect(owned.cancel).toHaveBeenCalledOnce()
    owned.respond(metadata)
    owned.close(terminal)
    await expect(reader.result).rejects.toMatchObject({ code: 'IMAGE_DECODE_CANCELLED' })
    expect(readSource).not.toHaveBeenCalled()
    await expect(reader.closed).resolves.toBe(terminal)
  })

  it('keeps capacity until the main handle closes after cancellation', async () => {
    const started = deferred(),
      mainClosed = deferred()
    const { reader, owned } = fixture({
      readSource: async (_source, { shouldContinue }) => {
        started.resolve()
        await mainClosed.promise
        if (!shouldContinue()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' })
        return { payload, version: metadata.version }
      }
    })
    owned.respond(metadata)
    owned.close(terminal)
    await started.promise
    const closed = vi.fn()
    void reader.closed.then(closed)
    reader.cancel()
    await flush()
    expect(closed).not.toHaveBeenCalled()
    mainClosed.resolve()
    await expect(reader.result).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(reader.closed).resolves.toBe(terminal)
  })

  it('rejects closed when a main handle close is unconfirmed', async () => {
    const error = Object.assign(new Error('close failed'), { resourceClosed: false })
    const { reader, owned } = fixture({
      readSource: async () => {
        throw error
      }
    })
    const resultCheck = expect(reader.result).rejects.toBe(error)
    const closedCheck = expect(reader.closed).rejects.toBe(error)
    owned.respond(metadata)
    owned.close(terminal)
    await Promise.all([resultCheck, closedCheck])
  })

  it('an ordinary IO failure can release confirmed resources', async () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const { reader, owned } = fixture({
      readSource: async () => {
        throw error
      }
    })
    owned.respond(metadata)
    owned.close(terminal)
    await expect(reader.result).rejects.toBe(error)
    await expect(reader.closed).resolves.toBe(terminal)
  })

  it('retains a child cleanup failure instead of publishing its prior success', async () => {
    const cleanupError = new Error('profile cleanup failed')
    const { reader, owned, readSource } = fixture()
    owned.respond(metadata)
    owned.close({ ...terminal, cleanupError })
    await expect(reader.result).rejects.toBe(cleanupError)
    await expect(reader.closed).resolves.toMatchObject({ cleanupError })
    expect(readSource).not.toHaveBeenCalled()
  })

  it('never claims closure when the underlying Job termination is unconfirmed', async () => {
    const error = new Error('Job still active')
    const { reader, owned, readSource } = fixture()
    const resultCheck = expect(reader.result).rejects.toBe(error)
    const closedCheck = expect(reader.closed).rejects.toBe(error)
    owned.respond(metadata)
    owned.failClose(error)
    await Promise.all([resultCheck, closedCheck])
    expect(readSource).not.toHaveBeenCalled()
  })

  it('returns bounded thumbnail output without a second main file read', async () => {
    const { reader, owned, readSource } = fixture({ purpose: 'thumbnail', size: 240 })
    const thumbnail = { ...metadata, data: 'data:image/png;base64,AAAA' }
    owned.respond(thumbnail)
    owned.close(terminal)
    await expect(reader.result).resolves.toEqual(thumbnail)
    await expect(reader.closed).resolves.toBe(terminal)
    expect(readSource).not.toHaveBeenCalled()
  })

  it('rejects a mismatched MIME before opening the main file', async () => {
    const { reader, owned, readSource } = fixture()
    owned.respond({ ...metadata, mime: 'image/svg+xml' })
    owned.close(terminal)
    await expect(reader.result).rejects.toMatchObject({ code: 'IMAGE_PREVIEW_INVALID_RESULT' })
    await expect(reader.closed).resolves.toBe(terminal)
    expect(readSource).not.toHaveBeenCalled()
  })
})

describe('fixed-handle preview source reads', () => {
  it('checks the same path version after reading and after closing', async () => {
    const io = sourceIO()
    const ordering = []
    io.handle.close.mockImplementation(async () => {
      ordering.push('closed')
    })
    io.lstatFile.mockImplementation(async () => {
      ordering.push('path')
      return io.status
    })
    const version = imageFileVersion(io.status)
    await expect(
      readImagePreviewSource(stored, { ...io, expectedVersion: version })
    ).resolves.toEqual({ payload, version })
    expect(ordering).toEqual(['path', 'closed', 'path'])
    expect(io.lstatFile).toHaveBeenNthCalledWith(1, stored.path, { bigint: true })
    expect(io.lstatFile).toHaveBeenNthCalledWith(2, stored.path, { bigint: true })
  })

  it('rejects a path replaced while the original handle remained stable', async () => {
    const io = sourceIO()
    io.lstatFile.mockResolvedValue({ ...io.status, ino: 3n })
    await expect(readImagePreviewSource(stored, io)).rejects.toMatchObject({
      code: 'IMAGE_PREVIEW_SOURCE_CHANGED'
    })
    expect(io.handle.close).toHaveBeenCalledOnce()
  })

  it('rejects a path replaced during close but releases the confirmed resources', async () => {
    const io = sourceIO()
    io.lstatFile.mockResolvedValueOnce(io.status).mockResolvedValueOnce({ ...io.status, ino: 3n })
    const { reader, owned } = fixture({
      readSource: (source, options) => readImagePreviewSource(source, { ...options, ...io })
    })
    owned.respond(metadata)
    owned.close(terminal)
    await expect(reader.result).rejects.toMatchObject({ code: 'IMAGE_PREVIEW_SOURCE_CHANGED' })
    await expect(reader.closed).resolves.toBe(terminal)
    expect(io.handle.close).toHaveBeenCalledOnce()
  })

  it('rejects a deleted path after close without claiming a handle leak', async () => {
    const io = sourceIO()
    const error = Object.assign(new Error('deleted'), { code: 'ENOENT' })
    io.lstatFile.mockResolvedValueOnce(io.status).mockRejectedValueOnce(error)
    const { reader, owned } = fixture({
      readSource: (source, options) => readImagePreviewSource(source, { ...options, ...io })
    })
    owned.respond(metadata)
    owned.close(terminal)
    await expect(reader.result).rejects.toBe(error)
    await expect(reader.closed).resolves.toBe(terminal)
    expect(io.handle.close).toHaveBeenCalledOnce()
  })

  it('keeps the close failure when replacement was already detected', async () => {
    const io = sourceIO()
    io.lstatFile.mockResolvedValue({ ...io.status, ino: 3n })
    io.handle.close.mockRejectedValue(new Error('close failed'))
    await expect(readImagePreviewSource(stored, io)).rejects.toMatchObject({
      resourceClosed: false,
      cause: { code: 'IMAGE_PREVIEW_SOURCE_CHANGED' }
    })
  })

  it('reads one real stored file and closes it before returning the snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'abandon-preview-reader-'))
    directories.push(directory)
    const path = join(directory, 'image.png')
    await writeFile(path, payload)
    const version = imageFileVersion(await stat(path, { bigint: true }))
    let closed = false
    const openFile = vi.fn(async (...args) => {
      const handle = await open(...args)
      return {
        stat: (...values) => handle.stat(...values),
        read: (...values) => handle.read(...values),
        close: async () => {
          await handle.close()
          closed = true
        }
      }
    })
    await expect(
      readImagePreviewSource({ kind: 'stored', path }, { expectedVersion: version, openFile })
    ).resolves.toEqual({ payload, version })
    expect(openFile).toHaveBeenCalledOnce()
    expect(closed).toBe(true)
  })

  it('uses the draft header/hash owner and the same version contract', async () => {
    const source = {
      kind: 'draft',
      path: stored.path,
      assetId: 'id',
      sessionId: 'session',
      size: 26
    }
    const readDraft = vi.fn(async () => ({ payload, version: metadata.version }))
    const openFile = vi.fn()
    const shouldContinue = () => true
    await expect(
      readImagePreviewSource(source, {
        expectedVersion: metadata.version,
        shouldContinue,
        readDraft,
        openFile
      })
    ).resolves.toEqual({ payload, version: metadata.version })
    expect(readDraft).toHaveBeenCalledWith(source, {
      expectedVersion: metadata.version,
      shouldContinue,
      withVersion: true
    })
    expect(openFile).not.toHaveBeenCalled()
  })

  it('stops a real multi-chunk read on cancellation and still closes its handle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'abandon-preview-reader-'))
    directories.push(directory)
    const path = join(directory, 'image.png')
    await writeFile(path, Buffer.alloc(512 * 1024, 7))
    let current = true,
      closed = false,
      reads = 0
    const openFile = async (...args) => {
      const handle = await open(...args)
      return {
        stat: (...values) => handle.stat(...values),
        read: async (...values) => {
          expect(values[2]).toBeLessThanOrEqual(256 * 1024)
          const value = await handle.read(...values)
          reads++
          current = false
          return value
        },
        close: async () => {
          await handle.close()
          closed = true
        }
      }
    }
    await expect(
      readImagePreviewSource({ kind: 'stored', path }, { openFile, shouldContinue: () => current })
    ).rejects.toMatchObject({ code: 'IMAGE_DECODE_CANCELLED' })
    expect(reads).toBe(1)
    expect(closed).toBe(true)
  })

  it('closes the handle when the expected file version changed before reading', async () => {
    const handle = {
      stat: vi.fn(async () => ({
        dev: 1n,
        ino: 2n,
        size: 26n,
        nlink: 1n,
        mtimeNs: 4n,
        ctimeNs: 5n,
        isFile: () => true
      })),
      read: vi.fn(),
      close: vi.fn(async () => {})
    }
    await expect(
      readImagePreviewSource(stored, {
        expectedVersion: 'changed',
        openFile: async () => handle,
        lstatFile: vi.fn()
      })
    ).rejects.toMatchObject({ code: 'IMAGE_PREVIEW_SOURCE_CHANGED' })
    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('retains both source and close failure while refusing resource release', async () => {
    const closeError = new Error('handle close failed')
    const handle = {
      stat: async () => ({
        dev: 1n,
        ino: 2n,
        size: 0n,
        nlink: 1n,
        mtimeNs: 4n,
        ctimeNs: 5n,
        isFile: () => true
      }),
      close: async () => {
        throw closeError
      }
    }
    await expect(
      readImagePreviewSource(stored, { openFile: async () => handle, lstatFile: vi.fn() })
    ).rejects.toMatchObject({
      resourceClosed: false,
      cause: { code: 'IMAGE_PREVIEW_SOURCE_CHANGED' }
    })
  })
})
