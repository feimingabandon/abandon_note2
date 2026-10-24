import * as filesystem from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'

// V1 is a main-owned temporary file, never a formal attachment. The complete
// header is flushed before any payload bytes are written. A crash during the
// header can leave at most 512 unknown bytes, which recovery preserves.
export const SESSION_DRAFT_ASSET_HEADER_BYTES = 512
const magic = Buffer.from('ABANDON_NOTE_SESSION_DRAFT_ASSET/1\n')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const session = /^[A-Za-z0-9_-]{1,128}$/
const sha256 = /^[0-9a-f]{64}$/
const maximumPayloadBytes = 50 * 1024 * 1024
const invalid = () =>
  Object.assign(new Error('草稿资产文件归属或内容无效'), { code: 'DRAFT_ASSET_PATH_INVALID' })
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function headerFor({ sessionId, assetId, size, sha256: hash }) {
  if (
    typeof sessionId !== 'string' ||
    !session.test(sessionId) ||
    !uuid.test(assetId) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > maximumPayloadBytes ||
    !sha256.test(hash)
  )
    throw invalid()
  const value = Buffer.from(JSON.stringify({ version: 1, sessionId, assetId, size, sha256: hash }))
  if (magic.length + 4 + value.length > SESSION_DRAFT_ASSET_HEADER_BYTES) throw invalid()
  const bytes = Buffer.alloc(SESSION_DRAFT_ASSET_HEADER_BYTES)
  magic.copy(bytes)
  bytes.writeUInt32BE(value.length, magic.length)
  value.copy(bytes, magic.length + 4)
  return bytes
}

function parseHeader(bytes) {
  if (
    bytes.length < SESSION_DRAFT_ASSET_HEADER_BYTES ||
    !bytes.subarray(0, magic.length).equals(magic)
  )
    throw invalid()
  const length = bytes.readUInt32BE(magic.length)
  if (!length || length > SESSION_DRAFT_ASSET_HEADER_BYTES - magic.length - 4) throw invalid()
  let value
  try {
    value = JSON.parse(bytes.subarray(magic.length + 4, magic.length + 4 + length).toString('utf8'))
  } catch {
    throw invalid()
  }
  if (
    value?.version !== 1 ||
    !headerFor(value).equals(bytes.subarray(0, SESSION_DRAFT_ASSET_HEADER_BYTES))
  )
    throw invalid()
  return value
}

function assertFileName(path, assetId) {
  if (
    !isAbsolute(String(path || '')) ||
    !uuid.test(assetId) ||
    basename(path) !== `${assetId}.asset`
  )
    throw invalid()
}

async function inspectPath(files, path, { bigint = false } = {}) {
  const status = await files.lstat(path, { bigint })
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    resolve(await files.realpath(path)) !== resolve(path)
  )
    throw invalid()
  return status
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
}

/** Main-only consumer port. Metadata and hashes describe the image, excluding its header. */
export async function readSessionDraftAssetPayload(
  descriptor,
  { io = {}, expectedVersion, shouldContinue = () => true, withVersion = false } = {}
) {
  const files = { ...filesystem, ...io }
  const { path, assetId, sessionId, size, sha256: hash } = descriptor
  assertFileName(path, assetId)
  if (!Number.isSafeInteger(size) || size <= 0 || size > maximumPayloadBytes || !sha256.test(hash))
    throw invalid()
  if (typeof shouldContinue !== 'function') throw new TypeError('草稿读取缺少同步取消检查')
  const versionOf = (status) =>
    ['dev', 'ino', 'size', 'nlink', 'mtimeNs', 'ctimeNs']
      .map((key) => String(status[key]))
      .join(':')
  const current = () => {
    if (shouldContinue() !== true)
      throw Object.assign(new Error('草稿资产读取已取消'), { code: 'DRAFT_ASSET_READ_CANCELLED' })
  }
  let handle, originalError, payload, version
  try {
    current()
    const before = await inspectPath(files, path, { bigint: true })
    if (before.nlink !== 1n || before.size !== BigInt(SESSION_DRAFT_ASSET_HEADER_BYTES + size))
      throw invalid()
    version = versionOf(before)
    if (expectedVersion !== undefined && expectedVersion !== version) throw invalid()
    current()
    handle = await files.open(path, 'r')
    if (versionOf(await handle.stat({ bigint: true })) !== version) throw invalid()
    const readExactly = async (bytes, position) => {
      let offset = 0
      while (offset < bytes.length) {
        current()
        const length = Math.min(64 * 1024, bytes.length - offset)
        const { bytesRead } = await handle.read(bytes, offset, length, position + offset)
        if (!bytesRead) throw invalid()
        offset += bytesRead
      }
      current()
    }
    const headerBytes = Buffer.alloc(SESSION_DRAFT_ASSET_HEADER_BYTES)
    await readExactly(headerBytes, 0)
    const header = parseHeader(headerBytes)
    if (
      header.assetId !== assetId ||
      header.sessionId !== sessionId ||
      header.size !== size ||
      header.sha256 !== hash
    )
      throw invalid()
    payload = Buffer.alloc(size)
    await readExactly(payload, SESSION_DRAFT_ASSET_HEADER_BYTES)
    if (
      versionOf(await handle.stat({ bigint: true })) !== version ||
      versionOf(await inspectPath(files, path, { bigint: true })) !== version ||
      digest(payload) !== hash
    )
      throw invalid()
    current()
  } catch (error) {
    originalError = error
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch (error) {
        originalError = Object.assign(
          new Error('草稿资产读取句柄关闭未确认', { cause: originalError || error }),
          {
            code: error?.code || 'DRAFT_ASSET_CLOSE_FAILED',
            resourceClosed: false,
            closeError: error
          }
        )
      }
    }
  }
  if (originalError) throw originalError
  current()
  if (versionOf(await inspectPath(files, path, { bigint: true })) !== version) throw invalid()
  current()
  return withVersion ? { payload, version } : payload
}

/** A narrow file owner; callers must hold the application's single-instance lock. */
export function createSessionDraftAssetFiles({ root, sessionId, io = {}, onRecovery = () => {} }) {
  if (!isAbsolute(String(root || '')) || typeof sessionId !== 'string' || !session.test(sessionId))
    throw invalid()
  const directory = resolve(root)
  const files = { ...filesystem, ...io }
  let initialization
  const recovery = []
  function report(value) {
    recovery.push(value)
    onRecovery(value)
  }
  function pathFor(assetId) {
    if (!uuid.test(assetId)) throw invalid()
    return join(directory, `${assetId}.asset`)
  }
  function assertPath(asset) {
    if (asset.path !== pathFor(asset.id)) throw invalid()
  }
  async function assertRoot() {
    const status = await files.lstat(directory)
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      resolve(await files.realpath(directory)) !== directory
    )
      throw invalid()
  }
  async function verifyOwned(asset) {
    assertPath(asset)
    const status = await inspectPath(files, asset.path)
    if (
      asset.fileIdentity &&
      (asset.fileIdentity.dev !== status.dev || asset.fileIdentity.ino !== status.ino)
    )
      throw invalid()
  }
  async function recover() {
    for (const entry of await files.readdir(directory, { withFileTypes: true })) {
      const match = /^([0-9a-f-]{36})\.asset$/.exec(entry.name)
      if (!entry.isFile() || !match || !uuid.test(match[1])) {
        report({ action: 'preserved-unknown', name: entry.name })
        continue
      }
      const path = pathFor(match[1])
      let handle, originalError
      try {
        const before = await inspectPath(files, path)
        handle = await files.open(path, 'r')
        if (!sameFile(before, await handle.stat())) throw invalid()
        const bytes = Buffer.alloc(SESSION_DRAFT_ASSET_HEADER_BYTES)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (!bytesRead) throw invalid()
          offset += bytesRead
        }
        const header = parseHeader(bytes)
        if (
          header.assetId !== match[1] ||
          before.size < SESSION_DRAFT_ASSET_HEADER_BYTES ||
          before.size > SESSION_DRAFT_ASSET_HEADER_BYTES + header.size
        )
          throw invalid()
        await handle.close()
        handle = null
        if (header.sessionId === sessionId) {
          report({ action: 'preserved-current-session', assetId: header.assetId })
          continue
        }
        if (!sameFile(before, await inspectPath(files, path))) throw invalid()
        await files.unlink(path)
        report({
          action: 'reclaimed-prior-session',
          assetId: header.assetId,
          sessionId: header.sessionId
        })
      } catch (error) {
        originalError = error
      } finally {
        if (handle) {
          try {
            await handle.close()
          } catch (error) {
            originalError ||= error
          }
        }
      }
      if (originalError)
        report({ action: 'failed-preserved', name: entry.name, path, error: originalError })
    }
  }
  function initialize() {
    if (!initialization)
      initialization = (async () => {
        await files.mkdir(directory, { recursive: true })
        await assertRoot()
        await recover()
        return true
      })()
    return initialization
  }
  async function writeHeader(handle, asset) {
    // The exclusive wx handle has already established current-process ownership.
    // No image bytes may be written before the entire ownership header is durable.
    await handle.writeFile(headerFor({ ...asset, assetId: asset.id, sessionId }))
    await handle.sync()
  }
  return Object.freeze({
    initialize,
    pathFor,
    assertPath,
    assertRoot,
    verifyOwned,
    writeHeader,
    read: (asset) =>
      readSessionDraftAssetPayload({ ...asset, assetId: asset.id, sessionId }, { io: files }),
    snapshot: () => recovery.map((entry) => ({ ...entry }))
  })
}
