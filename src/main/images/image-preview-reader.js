import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readSessionDraftAssetPayload } from '../drafts/session-draft-files.js'
import { assertImageDimensions, IMAGE_PREVIEW_LIMITS } from './image-decode-budget.js'
import { imageFileVersion, startImageDecodeChild } from './image-decode-child.js'

const fail = (code) => Object.assign(new Error(code), { code })
const formats = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml'
})
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function validateImagePreviewResult(value, purpose = 'original') {
  assertImageDimensions(value?.width, value?.height)
  if (
    !Object.hasOwn(formats, value.format) ||
    value.mime !== formats[value.format] ||
    typeof value.version !== 'string' ||
    value.version.length > 256 ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > IMAGE_PREVIEW_LIMITS.maxBytes ||
    (purpose === 'thumbnail' &&
      (typeof value.data !== 'string' ||
        !value.data.startsWith('data:image/png;base64,') ||
        value.data.length > 2 * 1024 * 1024))
  )
    throw fail('IMAGE_PREVIEW_INVALID_RESULT')
  return value
}

export function imagePreviewMime(format) {
  return formats[format]
}

/** Only an active owner calls this port. A draft .asset is never a raw image. */
export async function readImagePreviewSource(
  source,
  {
    expectedVersion,
    shouldContinue = () => true,
    openFile = open,
    lstatFile = lstat,
    readDraft = readSessionDraftAssetPayload
  } = {}
) {
  const check = () => {
    if (!shouldContinue()) throw fail('IMAGE_DECODE_CANCELLED')
  }
  check()
  if (
    !source ||
    !['stored', 'draft'].includes(source.kind) ||
    typeof source.path !== 'string' ||
    resolve(source.path) !== source.path
  )
    throw fail('IMAGE_PREVIEW_INVALID_SOURCE')
  if (source.kind === 'draft')
    return readDraft(source, { expectedVersion, shouldContinue, withVersion: true })

  const checkPath = async (version) => {
    check()
    const status = await lstatFile(source.path, { bigint: true })
    if (!status.isFile() || status.nlink !== 1n || imageFileVersion(status) !== version)
      throw fail('IMAGE_PREVIEW_SOURCE_CHANGED')
  }

  const handle = await openFile(source.path, 'r')
  let value, originalError
  try {
    check()
    const before = await handle.stat({ bigint: true })
    const version = imageFileVersion(before)
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > BigInt(IMAGE_PREVIEW_LIMITS.maxBytes) ||
      (expectedVersion !== undefined && expectedVersion !== version)
    )
      throw fail('IMAGE_PREVIEW_SOURCE_CHANGED')
    const payload = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < payload.length) {
      check()
      const { bytesRead } = await handle.read(
        payload,
        offset,
        Math.min(256 * 1024, payload.length - offset),
        offset
      )
      if (!bytesRead) throw fail('IMAGE_PREVIEW_SOURCE_CHANGED')
      offset += bytesRead
    }
    check()
    if (version !== imageFileVersion(await handle.stat({ bigint: true })))
      throw fail('IMAGE_PREVIEW_SOURCE_CHANGED')
    await checkPath(version)
    value = { payload, version }
  } catch (error) {
    originalError = error
  }
  try {
    await handle.close()
  } catch (error) {
    // Retain the first business error and separately refuse resource release.
    error.resourceClosed = false
    if (originalError) error.cause = originalError
    throw error
  }
  if (originalError) throw originalError
  // The fixed handle can still describe the old inode after its pathname was
  // replaced. Recheck the name after closing, immediately before publication.
  await checkPath(value.version)
  check()
  return value
}

/**
 * One runtime activity owns both the existing decoder Job and the main-side
 * original read handle. Large bytes never travel through the gate's JSON IPC.
 */
export function startImagePreviewRead(
  source,
  {
    app,
    purpose = 'original',
    size = 512,
    onDiagnostic = () => {},
    startChild = startImageDecodeChild,
    readSource = readImagePreviewSource
  } = {}
) {
  if (
    !['original', 'thumbnail'].includes(purpose) ||
    !Number.isInteger(size) ||
    size < 32 ||
    size > 512
  )
    throw fail('IMAGE_PREVIEW_INVALID_REQUEST')
  // This is a main-owned bounded descriptor, not a renderer request or image data.
  const descriptor = Object.freeze({
    kind: source.kind,
    path: source.path,
    ...(source.kind === 'draft'
      ? {
          sessionId: source.sessionId,
          assetId: source.assetId,
          ext: source.ext,
          size: source.size,
          sha256: source.sha256
        }
      : {})
  })
  let cancelled = false
  let resolveClosed, rejectClosed
  const closed = new Promise((accept, refuse) => {
    resolveClosed = accept
    rejectClosed = refuse
  })
  const operation = startChild(
    { mode: 'preview', source: descriptor, purpose, size },
    { app, onDiagnostic, validateResult: (value) => validateImagePreviewResult(value, purpose) }
  )
  const result = (async () => {
    // An early business failure is not an execution-resource terminal state.
    const [response, terminal] = await Promise.allSettled([operation.result, operation.closed])
    if (terminal.status === 'rejected') {
      rejectClosed(terminal.reason)
      throw terminal.reason
    }
    let closeFailure
    try {
      if (terminal.value?.cleanupError) throw terminal.value.cleanupError
      if (response.status === 'rejected') throw response.reason
      if (cancelled) throw fail('IMAGE_DECODE_CANCELLED')
      if (!response.value) return null
      const metadata = validateImagePreviewResult(response.value, purpose)
      if (purpose === 'thumbnail') return metadata
      const { payload, version } = await readSource(descriptor, {
        expectedVersion: metadata.version,
        shouldContinue: () => !cancelled
      })
      if (cancelled) throw fail('IMAGE_DECODE_CANCELLED')
      if (
        version !== metadata.version ||
        payload.length !== metadata.bytes ||
        digest(payload) !== metadata.sha256
      )
        throw fail('IMAGE_PREVIEW_SOURCE_CHANGED')
      return { ...metadata, payload }
    } catch (error) {
      if (error.resourceClosed === false) closeFailure = error
      throw error
    } finally {
      if (closeFailure) rejectClosed(closeFailure)
      else resolveClosed(terminal.value)
    }
  })()
  return {
    result,
    closed,
    cancel() {
      cancelled = true
      operation.cancel()
    }
  }
}
