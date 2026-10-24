import { createSessionDraftAssetStore } from './session-draft-assets.js'

export const DEFAULT_SESSION_DRAFT_ASSET_BYTE_LIMIT = 200 * 1024 * 1024
const failure = (code) => Object.assign(new Error(code), { code })
const validOwner = (owner) =>
  typeof owner === 'symbol' || Boolean(owner && typeof owner === 'object')

/** Main-only session lifetime and document admission. No renderer consumer is accepted. */
export function createSessionDraftAssetsRuntime({
  root,
  sessionId,
  settingsWriteSource,
  sessionByteLimit = DEFAULT_SESSION_DRAFT_ASSET_BYTE_LIMIT,
  io,
  consumeAssets,
  imageReads,
  startImageRead
}) {
  if (!settingsWriteSource?.assertDocument || !settingsWriteSource?.captureCurrent)
    throw new TypeError('Draft assets require the existing document source')
  if (consumeAssets !== undefined && typeof consumeAssets !== 'function')
    throw new TypeError('Draft handoff requires a fixed main consumer')
  if (
    (imageReads !== undefined || startImageRead !== undefined) &&
    (typeof imageReads?.createPort !== 'function' || typeof startImageRead !== 'function')
  )
    throw new TypeError('Draft image preparation requires the shared owner and fixed reader')
  let currentDocument = null
  let sealedOwner = null
  let disposed = false
  let clearing = false
  let disposal = null
  const pending = new Set()

  function assertCurrent(document) {
    if (!document) throw failure('DRAFT_DOCUMENT_EXPIRED')
    // Preserve the original source error for main diagnostics. This never calls
    // assert(), which also borrows the independent settings write admission gate.
    const validated = settingsWriteSource.assertDocument(
      { sender: document.sender, senderFrame: document.frame },
      document.source
    )
    const captured = settingsWriteSource.captureCurrent()
    if (
      document !== currentDocument ||
      !captured ||
      captured.token !== document.source.token ||
      captured.scope !== document.source.scope ||
      validated.generation !== document.generation ||
      validated.scope !== document.scope
    )
      throw failure('DRAFT_DOCUMENT_EXPIRED')
    return document
  }
  const store = createSessionDraftAssetStore({
    root,
    sessionId,
    sessionByteLimit,
    io,
    isDocumentCurrent(document) {
      try {
        assertCurrent(document)
        return true
      } catch {
        return false
      }
    }
  })
  const imagePort = imageReads?.createPort({
    name: 'draft',
    start({ captured, purpose, size }) {
      return store.startRead(captured, (descriptor) =>
        startImageRead({ ...descriptor, kind: 'draft' }, { purpose, size })
      )
    },
    isCurrent: ({ captured }) => store.isReadCurrent(captured)
  })
  if (imageReads !== undefined && typeof imagePort?.request !== 'function')
    throw new TypeError('Shared draft image port requires request')
  function assertAdmission() {
    if (disposed) throw failure('DRAFT_STORE_CLOSED')
    if (sealedOwner !== null) throw failure('DRAFT_RUNTIME_SEALED')
  }
  function captureDocument(event, source) {
    if (disposed) throw failure('DRAFT_STORE_CLOSED')
    const validated = settingsWriteSource.assertDocument(event, source)
    if (
      !currentDocument ||
      currentDocument.source.token !== source.token ||
      currentDocument.source.scope !== source.scope ||
      currentDocument.generation !== validated.generation ||
      currentDocument.sender !== event.sender ||
      currentDocument.frame !== event.senderFrame
    )
      currentDocument = Object.freeze({
        source: Object.freeze({ token: source.token, scope: source.scope }),
        scope: validated.scope,
        generation: validated.generation,
        sender: event.sender,
        frame: event.senderFrame
      })
    return assertCurrent(currentDocument)
  }
  function track(task) {
    const tracked = Promise.resolve(task)
    pending.add(tracked)
    void tracked.then(
      () => pending.delete(tracked),
      () => pending.delete(tracked)
    )
    return tracked
  }
  function perform(document, operation, { metadata = false } = {}) {
    if (metadata) {
      if (disposed) throw failure('DRAFT_STORE_CLOSED')
    } else assertAdmission()
    assertCurrent(document)
    const result = operation()
    if (!result || typeof result.then !== 'function') {
      assertCurrent(document)
      return result
    }
    return track(
      (async () => {
        let value
        try {
          value = await result
        } catch (error) {
          try {
            assertCurrent(document)
          } catch (sourceError) {
            // Expiry still controls the public response, but compensation may
            // already have forgotten this asset. Retain its original I/O or
            // consumer rejection for the main logger's bounded cause serializer.
            throw Object.assign(new Error(sourceError.message, { cause: error }), {
              name: sourceError.name,
              code: sourceError.code || 'DRAFT_DOCUMENT_EXPIRED'
            })
          }
          throw error
        }
        // Already-admitted work remains valid while sealed or disposing. Only
        // its original document identity is rechecked after asynchronous work.
        assertCurrent(document)
        return value
      })()
    )
  }
  async function drain() {
    for (;;) {
      await Promise.allSettled([...pending])
      await store.drain()
      if (!pending.size) return true
    }
  }
  function sealAndDrain(owner) {
    if (disposed) throw failure('DRAFT_STORE_CLOSED')
    if (!validOwner(owner) || (sealedOwner !== null && sealedOwner !== owner))
      throw failure('DRAFT_RUNTIME_OWNER_INVALID')
    sealedOwner = owner
    return drain()
  }
  function resume(owner) {
    if (disposed || clearing || sealedOwner === null || sealedOwner !== owner) return false
    sealedOwner = null
    return true
  }
  async function clearAfterCommit(owner) {
    if (disposed) throw failure('DRAFT_STORE_CLOSED')
    if (sealedOwner === null || sealedOwner !== owner || clearing)
      throw failure('DRAFT_RUNTIME_OWNER_INVALID')
    clearing = true
    try {
      await drain()
      // The caller invokes this only after the owning business SQL committed.
      // A failed SQL preparation must resume(owner), without calling core.clear.
      return await store.clear()
    } finally {
      clearing = false
    }
  }
  function dispose() {
    if (disposal) return disposal
    disposed = true
    sealedOwner ||= Symbol('draft-assets-dispose')
    disposal = (async () => {
      await drain()
      try {
        return await store.dispose()
      } finally {
        currentDocument = null
      }
    })()
    return disposal
  }
  function prepare(document, lease, id, purpose, requestedSize = 512) {
    return perform(document, () => {
      const captured = store.captureRead(document, lease, id)
      const size = Math.floor(Math.max(32, Math.min(512, Number(requestedSize) || 512)))
      const metadata = Object.freeze({ captured, purpose, size })
      const key = JSON.stringify([
        captured.sessionId,
        captured.documentId,
        captured.ownerId,
        captured.generation,
        captured.assetId,
        captured.sha256,
        purpose,
        size
      ])
      return Promise.resolve(imagePort.request(key, metadata)).then((value) => {
        if (!value) {
          if (purpose === 'original') throw failure('DRAFT_ASSET_INVALID')
          return null
        }
        if (purpose === 'original') {
          if (
            !(value.payload instanceof Uint8Array) ||
            value.payload.byteLength !== captured.size ||
            value.bytes !== captured.size ||
            value.sha256 !== captured.sha256
          )
            throw failure('DRAFT_ASSET_INVALID')
          return {
            bytes: value.payload,
            ext: captured.ext,
            size: captured.size,
            sha256: captured.sha256
          }
        }
        if (
          typeof value.data !== 'string' ||
          !value.data.startsWith('data:image/png;base64,') ||
          value.data.length > 2 * 1024 * 1024 ||
          !Number.isSafeInteger(value.width) ||
          !Number.isSafeInteger(value.height) ||
          value.width <= 0 ||
          value.height <= 0
        )
          throw failure('DRAFT_ASSET_INVALID')
        return { data: value.data, width: value.width, height: value.height }
      })
    })
  }
  return Object.freeze({
    initialize() {
      assertAdmission()
      return track(store.initialize())
    },
    captureDocument,
    assertDocument: assertCurrent,
    openOwner: (document, key, resume = null) =>
      perform(document, () => store.openOwner(document, key, resume)),
    stage: (document, lease, image) => perform(document, () => store.stage(document, lease, image)),
    preview: (document, lease, id) =>
      imagePort
        ? prepare(document, lease, id, 'original')
        : perform(document, () => store.preview(document, lease, id)),
    thumbnail: (document, lease, id, size = 512) =>
      imagePort ? prepare(document, lease, id, 'thumbnail', size) : perform(document, () => null),
    release: (document, lease, ids) => perform(document, () => store.release(document, lease, ids)),
    cancelOwner: (document, lease) => perform(document, () => store.cancelOwner(document, lease)),
    discardOwner: (document, lease) =>
      perform(document, () => store.cancelOwner(document, lease, { reportCleanup: true })),
    assertOwner: (document, lease) =>
      perform(document, () => store.assertOwner(document, lease), { metadata: true }),
    operationState: (document, lease, id) =>
      perform(document, () => store.operationState(document, lease, id), { metadata: true }),
    waitHandoff: (document, lease, id) =>
      perform(document, () => store.waitHandoff(document, lease, id), { metadata: true }),
    beginHandoff(document, lease, ids, context) {
      return perform(document, () => {
        if (!consumeAssets) throw failure('DRAFT_HANDOFF_UNAVAILABLE')
        return store.beginHandoff(document, lease, ids, (descriptors) =>
          consumeAssets(descriptors, context)
        )
      })
    },
    sealAndDrain,
    resume,
    clearAfterCommit,
    dispose,
    snapshot: () => ({
      ...store.snapshot(),
      runtime: { sealed: sealedOwner !== null, disposed, pending: pending.size, clearing }
    })
  })
}
