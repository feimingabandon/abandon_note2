import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSessionDraftAssetFiles,
  readSessionDraftAssetPayload,
  SESSION_DRAFT_ASSET_HEADER_BYTES
} from '../src/main/drafts/session-draft-files.js'

const fixtures = []
async function fixture() {
  const base = await fs.mkdtemp(join(tmpdir(), 'abandon-draft-files-unit-'))
  const root = join(base, 'assets')
  await fs.mkdir(root)
  fixtures.push(base)
  return { base, root }
}
async function owned(root, sessionId, text = 'image', partial = false) {
  const files = createSessionDraftAssetFiles({ root, sessionId })
  await files.initialize()
  const bytes = Buffer.from(text)
  const asset = {
    id: randomUUID(),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  const path = files.pathFor(asset.id)
  const handle = await fs.open(path, 'wx')
  try {
    await files.writeHeader(handle, asset)
    await fs.writeFile(handle, partial ? bytes.subarray(0, 1) : bytes)
  } finally {
    await handle.close()
  }
  return { ...asset, assetId: asset.id, path, sessionId }
}
afterEach(async ({ task }) => {
  for (const base of fixtures.splice(0)) {
    if (task.result?.state === 'fail') {
      console.error('Preserved failed session-draft-files unit fixture:', base)
      continue
    }
    const suffix = relative(resolve(tmpdir()), resolve(base))
    if (
      !suffix ||
      suffix === '..' ||
      suffix.startsWith('..' + sep) ||
      isAbsolute(suffix) ||
      !basename(base).startsWith('abandon-draft-files-unit-')
    )
      throw new Error('Refusing unowned cleanup')
    await fs.rm(base, { recursive: true, force: true })
  }
})

describe('session draft owned files', () => {
  it('refuses a pathname replaced while the read handle closes before publishing its payload', async () => {
    const f = await fixture()
    const asset = await owned(f.root, 'current', 'image bytes')
    const bytes = await fs.readFile(asset.path)
    await expect(
      readSessionDraftAssetPayload(asset, {
        io: {
          open: async (...args) => {
            const handle = await fs.open(...args)
            return {
              stat: (...options) => handle.stat(...options),
              read: (...options) => handle.read(...options),
              close: async () => {
                await handle.close()
                await fs.rename(asset.path, asset.path + '.retained')
                await fs.writeFile(asset.path, bytes)
              }
            }
          }
        }
      })
    ).rejects.toMatchObject({ code: 'DRAFT_ASSET_PATH_INVALID' })
    expect(await fs.readFile(asset.path + '.retained')).toEqual(bytes)
  })

  it('reclaims only validated prior-session files, including interrupted payload writes', async () => {
    const f = await fixture()
    const complete = await owned(f.root, 'previous')
    const partial = await owned(f.root, 'previous', 'partial image', true)
    const current = await owned(f.root, 'current')
    // The current helper's initialization already reclaimed previous files.
    // Add both prior payload states after that startup to exercise one scan.
    const oldWriter = createSessionDraftAssetFiles({ root: f.root, sessionId: 'previous' })
    for (const asset of [complete, partial]) {
      const handle = await fs.open(asset.path, 'wx')
      try {
        await oldWriter.writeHeader(handle, asset)
        await fs.writeFile(handle, Buffer.from(asset === partial ? 'p' : 'image'))
      } finally {
        await handle.close()
      }
    }
    const unknown = join(f.root, `${randomUUID()}.asset`)
    await fs.writeFile(unknown, 'foreign')
    const nested = join(f.root, 'unknown-directory')
    await fs.mkdir(nested)
    const nestedFile = join(nested, `${randomUUID()}.asset`)
    await fs.copyFile(complete.path, nestedFile)
    const formal = join(f.base, 'formal.png')
    await fs.writeFile(formal, 'formal')
    const files = createSessionDraftAssetFiles({ root: f.root, sessionId: 'current' })
    await files.initialize()
    await expect(fs.stat(complete.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(partial.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readSessionDraftAssetPayload(current)).toString()).toBe('image')
    expect(await fs.readFile(unknown, 'utf8')).toBe('foreign')
    expect(await fs.readFile(formal, 'utf8')).toBe('formal')
    expect((await fs.stat(nestedFile)).isFile()).toBe(true)
    expect(
      files.snapshot().filter((entry) => entry.action === 'reclaimed-prior-session')
    ).toHaveLength(2)
    expect(files.snapshot()).toContainEqual({
      action: 'preserved-current-session',
      assetId: current.assetId
    })
  })

  it('preserves incomplete, mismatched and oversized headers instead of guessing ownership', async () => {
    const f = await fixture()
    const source = await owned(f.root, 'old')
    const bytes = await fs.readFile(source.path)
    const partial = join(f.root, `${randomUUID()}.asset`)
    await fs.writeFile(partial, bytes.subarray(0, 30))
    const mismatch = join(f.root, `${randomUUID()}.asset`)
    await fs.writeFile(mismatch, bytes)
    await fs.appendFile(source.path, 'unexpected')
    const files = createSessionDraftAssetFiles({ root: f.root, sessionId: 'new' })
    await files.initialize()
    for (const path of [partial, mismatch, source.path])
      expect((await fs.stat(path)).isFile()).toBe(true)
    expect(files.snapshot().filter((entry) => entry.action === 'failed-preserved')).toHaveLength(3)
    expect((await fs.stat(partial)).size).toBe(30)
  })

  it('retains the original cleanup error and the self-contained receipt for the next startup', async () => {
    const f = await fixture()
    const asset = await owned(f.root, 'old')
    const original = Object.assign(new Error(`EACCES: unlink '${asset.path}'`), {
      code: 'EACCES',
      path: asset.path
    })
    const files = createSessionDraftAssetFiles({
      root: f.root,
      sessionId: 'new',
      io: {
        unlink: async () => {
          throw original
        }
      }
    })
    await files.initialize()
    expect(files.snapshot()[0]).toMatchObject({ action: 'failed-preserved', path: asset.path })
    expect(files.snapshot()[0].error).toBe(original)
    expect((await readSessionDraftAssetPayload(asset)).toString()).toBe('image')
    const retry = createSessionDraftAssetFiles({ root: f.root, sessionId: 'newer' })
    await retry.initialize()
    expect(retry.snapshot()[0].action).toBe('reclaimed-prior-session')
    await expect(fs.stat(asset.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('validates consumer identity, exact payload length and hash while hiding the header', async () => {
    const f = await fixture()
    const asset = await owned(f.root, 'current', 'image bytes')
    expect((await fs.stat(asset.path)).size).toBe(SESSION_DRAFT_ASSET_HEADER_BYTES + asset.size)
    for (const patch of [
      { sessionId: 'other' },
      { assetId: randomUUID() },
      { size: asset.size + 1 },
      { sha256: '0'.repeat(64) }
    ])
      await expect(readSessionDraftAssetPayload({ ...asset, ...patch })).rejects.toMatchObject({
        code: 'DRAFT_ASSET_PATH_INVALID'
      })
    expect((await readSessionDraftAssetPayload(asset)).toString()).toBe('image bytes')
    const handle = await fs.open(asset.path, 'r+')
    try {
      await handle.write(Buffer.from('!'), 0, 1, SESSION_DRAFT_ASSET_HEADER_BYTES)
    } finally {
      await handle.close()
    }
    await expect(readSessionDraftAssetPayload(asset)).rejects.toMatchObject({
      code: 'DRAFT_ASSET_PATH_INVALID'
    })
  })

  it('rejects a redirected root and preserves nested junctions and their target files', async () => {
    const f = await fixture()
    const target = join(f.base, 'outside')
    await fs.mkdir(target)
    const asset = await owned(target, 'old')
    const redirect = join(f.base, 'redirect')
    await fs.symlink(target, redirect, 'junction')
    const redirected = createSessionDraftAssetFiles({ root: redirect, sessionId: 'new' })
    await expect(redirected.initialize()).rejects.toMatchObject({
      code: 'DRAFT_ASSET_PATH_INVALID'
    })
    const nested = join(f.root, 'nested-junction')
    await fs.symlink(target, nested, 'junction')
    const files = createSessionDraftAssetFiles({ root: f.root, sessionId: 'new' })
    await files.initialize()
    expect((await readSessionDraftAssetPayload(asset)).toString()).toBe('image')
    expect(files.snapshot()).toContainEqual({
      action: 'preserved-unknown',
      name: 'nested-junction'
    })
  })

  it('returns a stable content version through one bounded handle and rejects a changed expected version', async () => {
    const f = await fixture()
    const asset = await owned(f.root, 'current', 'x'.repeat(128 * 1024 + 3))
    const reads = []
    let closes = 0,
      opens = 0
    const io = {
      async open(path, flags) {
        opens++
        const handle = await fs.open(path, flags)
        const read = handle.read.bind(handle),
          close = handle.close.bind(handle)
        handle.read = (...args) => {
          reads.push({ length: args[2], position: args[3] })
          return read(...args)
        }
        handle.close = async () => {
          closes++
          await close()
        }
        return handle
      },
      readFile() {
        throw new Error('Unbounded path read must not be used')
      }
    }
    const first = await readSessionDraftAssetPayload(asset, { io, withVersion: true })
    expect(first.payload.length).toBe(asset.size)
    expect(first.version.split(':')).toHaveLength(6)
    expect(opens).toBe(1)
    expect(closes).toBe(1)
    expect(reads[0]).toEqual({ length: SESSION_DRAFT_ASSET_HEADER_BYTES, position: 0 })
    expect(reads.every(({ length }) => length <= 64 * 1024)).toBe(true)
    const second = await readSessionDraftAssetPayload(asset, { expectedVersion: first.version })
    expect(second.equals(first.payload)).toBe(true)
    await expect(
      readSessionDraftAssetPayload(asset, { expectedVersion: first.version + ':changed' })
    ).rejects.toMatchObject({ code: 'DRAFT_ASSET_PATH_INVALID' })
  })

  it.each(['cancel', 'growth'])(
    'closes the fixed read handle after %s without claiming a resource failure',
    async (kind) => {
      const f = await fixture()
      const asset = await owned(f.root, 'current', 'original payload')
      let continuing = true,
        closed = false,
        changed = false
      const result = readSessionDraftAssetPayload(asset, {
        shouldContinue: () => continuing,
        io: {
          async open(path, flags) {
            const handle = await fs.open(path, flags)
            const read = handle.read.bind(handle),
              close = handle.close.bind(handle)
            handle.read = async (...args) => {
              const value = await read(...args)
              if (!changed && args[3] >= SESSION_DRAFT_ASSET_HEADER_BYTES) {
                changed = true
                if (kind === 'cancel') continuing = false
                else await fs.appendFile(path, 'changed')
              }
              return value
            }
            handle.close = async () => {
              await close()
              closed = true
            }
            return handle
          }
        }
      }).catch((error) => error)
      const error = await result
      expect(error.code).toBe(
        kind === 'cancel' ? 'DRAFT_ASSET_READ_CANCELLED' : 'DRAFT_ASSET_PATH_INVALID'
      )
      expect(error.resourceClosed).not.toBe(false)
      expect(closed).toBe(true)
    }
  )

  it('marks an unconfirmed close separately while preserving the original read failure as cause', async () => {
    const f = await fixture()
    const asset = await owned(f.root, 'current', 'image')
    const original = Object.assign(new Error('controlled handle read failed'), { code: 'EIO' })
    const closeError = Object.assign(new Error('controlled close failed'), { code: 'EBUSY' })
    const error = await readSessionDraftAssetPayload(asset, {
      io: {
        async open(path, flags) {
          const handle = await fs.open(path, flags)
          const close = handle.close.bind(handle)
          handle.read = async () => {
            throw original
          }
          handle.close = async () => {
            await close()
            throw closeError
          }
          return handle
        }
      }
    }).catch((failure) => failure)
    expect(error).toMatchObject({ resourceClosed: false, code: 'EBUSY' })
    expect(error.cause).toBe(original)
    expect(error.closeError).toBe(closeError)
  })
})
