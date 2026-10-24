import { publicSessionDraftAssetError } from '../drafts/session-draft-assets.js'

const invalid = () => {
  throw Object.assign(new Error('Invalid draft asset request'), { code: 'DRAFT_IPC_INVALID' })
}
const object = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function shape(value, required, optional = []) {
  if (
    !object(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid()
}
function lease(value) {
  shape(value, ['sessionId', 'ownerId', 'generation', 'capability'])
  if (
    !['sessionId', 'ownerId', 'capability'].every(
      (key) => typeof value[key] === 'string' && value[key]
    ) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  )
    invalid()
}

/** Fixed document-bound transport. Store snapshots, paths and consumers stay in main. */
export function registerDraftAssetsIpc({
  ipcMain,
  runtime,
  noteCommands = null,
  logger = console
}) {
  const channels = []
  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
  function handle(name, required, optional, operation) {
    const channel = 'draft-assets:' + name
    ipcMain.handle(channel, async (event, payload, source) => {
      try {
        const document = runtime.captureDocument(event, source)
        shape(payload, required, optional)
        if (Object.hasOwn(payload, 'lease')) lease(payload.lease)
        const value = await operation(document, payload)
        // Recheck only the original document, independently of admission. Work
        // already accepted before a shutdown seal may still finish normally.
        runtime.assertDocument(document)
        return { ok: true, value }
      } catch (error) {
        try {
          logger.error('draft-assets.ipc-failed', error, { channel })
        } catch {
          /* Logging cannot replace the original business failure. */
        }
        const publicError = publicSessionDraftAssetError(
          error.code === 'SETTINGS_SOURCE_EXPIRED' ? { code: 'DRAFT_DOCUMENT_EXPIRED' } : error
        )
        return { ok: false, error: publicError }
      }
    })
    channels.push(channel)
  }
  try {
    handle('open-owner', ['key'], ['resume'], (document, payload) => {
      if (typeof payload.key !== 'string') invalid()
      if (payload.resume != null) {
        shape(payload.resume, ['sessionId', 'key', 'ownerId', 'generation'])
        if (
          !['sessionId', 'key', 'ownerId'].every(
            (key) => typeof payload.resume[key] === 'string'
          ) ||
          !Number.isSafeInteger(payload.resume.generation) ||
          payload.resume.generation < 1
        )
          invalid()
      }
      return runtime.openOwner(document, payload.key, payload.resume ?? null)
    })
    handle('stage', ['lease', 'image'], [], (document, payload) => {
      shape(payload.image, ['base64', 'ext'], ['name', 'size'])
      if (
        typeof payload.image.base64 !== 'string' ||
        typeof payload.image.ext !== 'string' ||
        (payload.image.name !== undefined && typeof payload.image.name !== 'string') ||
        (payload.image.size !== undefined &&
          (!Number.isSafeInteger(payload.image.size) || payload.image.size < 0))
      )
        invalid()
      return runtime.stage(document, payload.lease, payload.image)
    })
    handle('preview', ['lease', 'assetId'], [], (document, payload) => {
      if (typeof payload.assetId !== 'string') invalid()
      return runtime.preview(document, payload.lease, payload.assetId)
    })
    handle('thumbnail', ['lease', 'assetId', 'size'], [], (document, payload) => {
      if (
        typeof payload.assetId !== 'string' ||
        !Number.isInteger(payload.size) ||
        payload.size < 32 ||
        payload.size > 512
      )
        invalid()
      return runtime.thumbnail(document, payload.lease, payload.assetId, payload.size)
    })
    handle('release', ['lease', 'assetIds'], [], (document, payload) => {
      if (
        !Array.isArray(payload.assetIds) ||
        !payload.assetIds.every((id) => typeof id === 'string')
      )
        invalid()
      return runtime.release(document, payload.lease, payload.assetIds)
    })
    handle('cancel-owner', ['lease'], [], (document, payload) =>
      runtime.cancelOwner(document, payload.lease)
    )
    handle('operation-state', ['lease', 'operationId'], [], (document, payload) => {
      if (typeof payload.operationId !== 'string') invalid()
      return runtime.operationState(document, payload.lease, payload.operationId)
    })
    handle('wait-handoff', ['lease', 'operationId'], [], (document, payload) => {
      if (typeof payload.operationId !== 'string') invalid()
      return runtime.waitHandoff(document, payload.lease, payload.operationId)
    })
    if (noteCommands) {
      handle('discard-owner', ['lease'], [], async (document, payload) => {
        const result = await runtime.discardOwner(document, payload.lease)
        const cleanupErrors = result.cleanupErrors.map((error) => {
          try {
            logger.error('draft-assets.discard-cleanup', error)
          } catch {
            /* Retain revocation. */
          }
          return publicSessionDraftAssetError(error)
        })
        noteCommands.forgetOwner(payload.lease.ownerId)
        return { cancelled: true, cleanupErrors }
      })
      handle('submit-note', ['lease', 'requestId', 'kind', 'payload'], [], (document, payload) =>
        noteCommands.submit(
          document,
          payload.lease,
          payload.requestId,
          payload.kind,
          payload.payload
        )
      )
      handle('note-state', ['lease', 'requestId'], [], (document, payload) =>
        noteCommands.state(document, payload.lease, payload.requestId)
      )
      handle('wait-note', ['lease', 'requestId'], [], (document, payload) =>
        noteCommands.wait(document, payload.lease, payload.requestId)
      )
    }
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
