import { createHash } from 'node:crypto'
import {
  readSessionDraftAssetPayload,
  publicSessionDraftAssetError
} from './session-draft-assets.js'

const fail = (code = 'DRAFT_IPC_INVALID') => Object.assign(new Error(code), { code })
const object = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const requestKey = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
function copyPayload(kind, payload) {
  if (!['create', 'save'].includes(kind) || !object(payload)) throw fail()
  const images = kind === 'create' ? payload.images : payload.addedImages
  if (!Array.isArray(images) || images.length > 50) throw fail()
  for (const image of images) {
    if (
      !object(image) ||
      typeof image.assetId !== 'string' ||
      !image.assetId ||
      Object.keys(image).some((key) => !['assetId', 'ext', 'name', 'size', 'sha256'].includes(key))
    )
      throw fail()
  }
  const allowed =
    kind === 'create'
      ? ['options', 'images', 'tagIds']
      : ['id', 'expectedVersion', 'fields', 'tagIds', 'addedImages', 'deletedImageIds']
  if (Object.keys(payload).some((key) => !allowed.includes(key))) throw fail()
  if (!object(kind === 'create' ? payload.options : payload.fields)) throw fail()
  const serialized = JSON.stringify({ kind, payload })
  return {
    payload: JSON.parse(serialized).payload,
    digest: createHash('sha256').update(serialized).digest('hex'),
    ids: images.map((image) => image.assetId)
  }
}

/** One launch owns idempotent, fixed note submissions. A journalled request ID
 * survives a lost IPC response; forgetting a terminal ID never permits replay.
 */
export function createSessionDraftNoteCommands({
  runtime,
  createNoteWithAssets,
  saveNoteDraft,
  runMutation = (operation) => operation(),
  onCommitted = () => {},
  logger = console,
  readPayload = readSessionDraftAssetPayload,
  maxRequestsPerOwner = 32
}) {
  if (!runtime || typeof createNoteWithAssets !== 'function' || typeof saveNoteDraft !== 'function')
    throw new TypeError('Fixed note commands and draft runtime required')
  if (!Number.isSafeInteger(maxRequestsPerOwner) || maxRequestsPerOwner < 1)
    throw new TypeError('Request retention must be bounded and positive')
  const owners = new Map()
  const ownedRecords = new WeakSet()
  function log(scope, error, metadata) {
    try {
      logger.error(scope, error, metadata)
    } catch {
      /* Preserve the operation result. */
    }
  }
  function authorize(document, lease, requestId) {
    runtime.assertOwner(document, lease)
    if (!requestKey(requestId)) throw fail()
    return owners.get(lease.ownerId)?.get(requestId)
  }
  function result(record, requestId = record?.requestId) {
    if (!record) return { requestId, status: 'unknown' }
    return {
      requestId,
      status: record.status,
      ...(record.status === 'committed' ? { result: record.result } : {}),
      ...(record.status === 'failed' ? { error: record.error } : {}),
      ...(record.cleanupErrors.length ? { cleanupErrors: record.cleanupErrors } : {})
    }
  }
  async function consumeAssets(descriptors, record) {
    if (!ownedRecords.has(record) || record.status !== 'pending') throw fail()
    try {
      if (
        descriptors.length !== record.ids.length ||
        descriptors.some((descriptor, index) => descriptor.assetId !== record.ids[index])
      )
        throw fail()
      const images = []
      for (const descriptor of descriptors) {
        // Validate and strip the ownership container before encoding once for
        // the existing complete transaction command. Paths never leave main.
        const bytes = await readPayload(descriptor)
        images.push({ base64: bytes.toString('base64'), ext: descriptor.ext })
      }
      record.result = await (record.kind === 'create'
        ? createNoteWithAssets({ ...record.payload, images })
        : saveNoteDraft({ ...record.payload, addedImages: images }))
      record.status = 'committed'
    } catch (error) {
      record.status = 'failed'
      record.error = publicSessionDraftAssetError(
        String(error?.message || '').includes('便签已发生变化')
          ? { code: 'DRAFT_NOTE_CONFLICT' }
          : error
      )
      log('draft-assets.note-commit-failed', error, {
        kind: record.kind,
        requestId: record.requestId
      })
      throw error
    }
    try {
      await onCommitted(record.result, record.kind)
    } catch (error) {
      log('draft-assets.note-presentation-failed', error, { requestId: record.requestId })
      // Presentation failure cannot revoke a successful SQL transaction.
    }
    return record.result
  }
  function submit(document, lease, requestId, kind, payload) {
    const previous = authorize(document, lease, requestId)
    const rejected = (error) =>
      Promise.resolve({
        requestId,
        status: 'rejected',
        error: publicSessionDraftAssetError(error)
      })
    let copied
    try {
      copied = copyPayload(kind, payload)
    } catch (error) {
      // An accepted identity can never be relabelled as unaccepted by sending
      // a malformed replacement payload for it.
      if (previous) throw fail('DRAFT_REQUEST_MISMATCH')
      return rejected(error)
    }
    if (previous) {
      if (previous.digest !== copied.digest) throw fail('DRAFT_REQUEST_MISMATCH')
      return previous.completion.then(() => result(previous))
    }
    let requests = owners.get(lease.ownerId)
    if (!requests) requests = new Map()
    if (requests.size >= maxRequestsPerOwner) return rejected(fail('DRAFT_REQUEST_LIMIT'))
    const record = {
      requestId,
      kind,
      ...copied,
      status: 'pending',
      result: undefined,
      error: null,
      cleanupErrors: [],
      operationId: null,
      completion: null
    }
    // Install identity before admission can schedule its asynchronous consumer.
    // A synchronous refusal removes this unaccepted identity and never starts SQL.
    requests.set(requestId, record)
    owners.set(lease.ownerId, requests)
    ownedRecords.add(record)
    try {
      record.completion = runMutation(() => {
        record.operationId = runtime.beginHandoff(document, lease, record.ids, record)
        return Promise.resolve(runtime.waitHandoff(document, lease, record.operationId))
          .catch((error) => {
            // Reload can expire this waiter after SQL completed. The fixed
            // consumer owns the business outcome, never this document's reply.
            if (record.status === 'pending') {
              record.status = 'failed'
              record.error = publicSessionDraftAssetError(error)
              log('draft-assets.note-handoff-failed', error, { requestId })
            }
          })
          .then(() => {
            try {
              const state = runtime.operationState(document, lease, record.operationId)
              record.cleanupErrors = state.cleanupErrors || []
            } catch {
              // Current-document queries collect cleanup metadata after reload.
            }
          })
      })
    } catch (error) {
      if (record.operationId !== null) {
        // Defensive: if a future waiter setup fails after acceptance, retain
        // identity and let current-document state resolve its original outcome.
        record.completion = Promise.resolve()
        throw error
      }
      requests.delete(requestId)
      if (!requests.size) owners.delete(lease.ownerId)
      ownedRecords.delete(record)
      return rejected(error)
    }
    record.completion = Promise.resolve(record.completion)
    return record.completion.then(() => result(record))
  }
  function state(document, lease, requestId) {
    const record = authorize(document, lease, requestId)
    if (record?.operationId) {
      try {
        record.cleanupErrors =
          runtime.operationState(document, lease, record.operationId).cleanupErrors || []
      } catch (error) {
        if (error.code !== 'DRAFT_OPERATION_INVALID') throw error
      }
    }
    return result(record, requestId)
  }
  async function wait(document, lease, requestId) {
    const record = authorize(document, lease, requestId)
    if (!record) return result(null, requestId)
    await record.completion
    return state(document, lease, requestId)
  }
  return Object.freeze({
    consumeAssets,
    submit,
    state,
    wait,
    forgetOwner(ownerId) {
      owners.delete(ownerId)
    },
    clear() {
      owners.clear()
    }
  })
}
