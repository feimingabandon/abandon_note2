const failure = (code = 'DRAFT_IPC_INVALID', message = '草稿资产响应无效，请保留草稿后重试') =>
  Object.assign(new Error(message), { code })
const text = (value) => typeof value === 'string' && value.length > 0
const generation = (value) => Number.isSafeInteger(value) && value > 0
const object = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
function publicError(value) {
  if (!object(value) || !text(value.code) || !text(value.message)) throw failure()
  return { code: value.code, message: value.message }
}
function assetMetadata(value) {
  if (
    !object(value) ||
    !text(value.assetId) ||
    !text(value.ext) ||
    typeof value.name !== 'string' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    !digest(value.sha256)
  )
    throw failure()
  return {
    assetId: value.assetId,
    ext: value.ext,
    name: value.name,
    size: value.size,
    sha256: value.sha256
  }
}
function noteState(value, requestId) {
  if (
    !object(value) ||
    value.requestId !== requestId ||
    !['pending', 'committed', 'failed', 'rejected', 'unknown'].includes(value.status) ||
    (value.status === 'committed' &&
      (!object(value.result) || !Number.isInteger(value.result.id))) ||
    (['failed', 'rejected'].includes(value.status) && !object(value.error)) ||
    (value.cleanupErrors !== undefined && !Array.isArray(value.cleanupErrors))
  )
    throw failure()
  return {
    requestId,
    status: value.status,
    ...(value.status === 'committed' ? { result: value.result } : {}),
    ...(['failed', 'rejected'].includes(value.status) ? { error: publicError(value.error) } : {}),
    ...(value.cleanupErrors === undefined
      ? {}
      : { cleanupErrors: value.cleanupErrors.map(publicError) })
  }
}

/** Private preload factory. Pass settingsClient.invoke.bind(settingsClient), never
 * expose this transport or its capabilities through the renderer API surface.
 */
export function createDraftAssetsClient({ invoke }) {
  if (typeof invoke !== 'function')
    throw new TypeError('Draft assets require the private source-bound invoke port')
  const owners = new Map()
  let disposed = false
  function assertOpen() {
    if (disposed) throw failure('DRAFT_STORE_CLOSED', '草稿资产会话已结束')
  }
  async function request(channel, payload) {
    assertOpen()
    let result
    try {
      result = await invoke('draft-assets:' + channel, payload)
    } catch {
      assertOpen()
      throw failure('DRAFT_ASSET_OPERATION_FAILED', '草稿资产操作失败，请保留草稿后重试')
    }
    assertOpen()
    if (!object(result) || typeof result.ok !== 'boolean') throw failure()
    if (!result.ok) {
      const error = publicError(result.error)
      throw failure(error.code, error.message)
    }
    return result.value
  }
  function privateLease(owner) {
    assertOpen()
    const stored = owners.get(owner?.ownerId)
    if (
      !stored ||
      owner.sessionId !== stored.lease.sessionId ||
      owner.generation !== stored.lease.generation ||
      owner.key !== stored.key
    )
      throw failure('DRAFT_LEASE_INVALID', '草稿资产访问凭据已失效')
    return { ...stored.lease }
  }
  async function openOwner(key, resume = null) {
    if (!text(key)) throw failure()
    if (
      resume !== null &&
      (!object(resume) ||
        !text(resume.sessionId) ||
        !text(resume.key) ||
        !text(resume.ownerId) ||
        !generation(resume.generation))
    )
      throw failure()
    const value = await request('open-owner', {
      key,
      resume:
        resume === null
          ? null
          : {
              sessionId: resume.sessionId,
              key: resume.key,
              ownerId: resume.ownerId,
              generation: resume.generation
            }
    })
    if (
      !object(value) ||
      !text(value.sessionId) ||
      !text(value.ownerId) ||
      !text(value.capability) ||
      !generation(value.generation)
    )
      throw failure()
    if (
      resume !== null &&
      (resume.key !== key ||
        value.sessionId !== resume.sessionId ||
        value.ownerId !== resume.ownerId ||
        value.generation !== resume.generation)
    )
      throw failure('DRAFT_OWNER_RESUME_INVALID', '草稿归属信息不匹配，请保留原草稿')
    const lease = {
      sessionId: value.sessionId,
      ownerId: value.ownerId,
      generation: value.generation,
      capability: value.capability
    }
    owners.set(lease.ownerId, { key, lease })
    return Object.freeze({
      sessionId: lease.sessionId,
      key,
      ownerId: lease.ownerId,
      generation: lease.generation
    })
  }
  return Object.freeze({
    openOwner,
    async stage(owner, image) {
      const lease = privateLease(owner)
      if (!object(image)) throw failure()
      const value = await request('stage', {
        lease,
        image: {
          base64: image.base64,
          ext: image.ext,
          ...(image.name === undefined ? {} : { name: image.name }),
          ...(image.size === undefined ? {} : { size: image.size })
        }
      })
      return assetMetadata(value)
    },
    async preview(owner, assetId) {
      const value = await request('preview', { lease: privateLease(owner), assetId })
      if (
        !object(value) ||
        !text(value.ext) ||
        !Number.isSafeInteger(value.size) ||
        value.size < 1 ||
        !digest(value.sha256)
      )
        throw failure()
      const bytes =
        value.bytes instanceof Uint8Array
          ? new Uint8Array(value.bytes)
          : value.bytes instanceof ArrayBuffer
            ? new Uint8Array(value.bytes.slice(0))
            : null
      if (!bytes || bytes.byteLength !== value.size) throw failure()
      return { bytes, ext: value.ext, size: value.size, sha256: value.sha256 }
    },
    async thumbnail(owner, assetId, size = 512) {
      if (!text(assetId) || !Number.isInteger(size) || size < 32 || size > 512) throw failure()
      const value = await request('thumbnail', { lease: privateLease(owner), assetId, size })
      if (value === null) return null
      if (
        !object(value) ||
        typeof value.data !== 'string' ||
        value.data.length > 2 * 1024 * 1024 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.data) ||
        !Number.isSafeInteger(value.width) ||
        value.width < 1 ||
        value.width > 16384 ||
        !Number.isSafeInteger(value.height) ||
        value.height < 1 ||
        value.height > 16384
      )
        throw failure()
      return { data: value.data, width: value.width, height: value.height }
    },
    async release(owner, assetIds) {
      if (!Array.isArray(assetIds) || !assetIds.every(text)) throw failure()
      const result = await request('release', {
        lease: privateLease(owner),
        assetIds: [...assetIds]
      })
      if (result !== true) throw failure()
      return true
    },
    async cancelOwner(owner) {
      const lease = privateLease(owner)
      const result = await request('cancel-owner', { lease })
      if (result !== true) throw failure()
      owners.delete(lease.ownerId)
      return result
    },
    async discardOwner(owner) {
      const lease = privateLease(owner)
      const result = await request('discard-owner', { lease })
      if (!object(result) || result.cancelled !== true || !Array.isArray(result.cleanupErrors))
        throw failure()
      const cleanupErrors = result.cleanupErrors.map(publicError)
      owners.delete(lease.ownerId)
      return { cancelled: true, cleanupErrors }
    },
    async submitNote(owner, requestId, kind, payload) {
      if (!text(requestId) || !['create', 'save'].includes(kind) || !object(payload))
        throw failure()
      return noteState(
        await request('submit-note', {
          lease: privateLease(owner),
          requestId,
          kind,
          payload
        }),
        requestId
      )
    },
    async noteState(owner, requestId) {
      if (!text(requestId)) throw failure()
      return noteState(
        await request('note-state', { lease: privateLease(owner), requestId }),
        requestId
      )
    },
    async waitNote(owner, requestId) {
      if (!text(requestId)) throw failure()
      return noteState(
        await request('wait-note', { lease: privateLease(owner), requestId }),
        requestId
      )
    },
    async operationState(owner, operationId) {
      const value = await request('operation-state', { lease: privateLease(owner), operationId })
      if (
        !object(value) ||
        value.operationId !== operationId ||
        !['pending', 'committed', 'failed'].includes(value.status)
      )
        throw failure()
      if (value.status === 'failed' && value.error === undefined) throw failure()
      if (value.cleanupErrors !== undefined && !Array.isArray(value.cleanupErrors)) throw failure()
      return {
        operationId: value.operationId,
        status: value.status,
        ...(value.error === undefined ? {} : { error: publicError(value.error) }),
        ...(value.cleanupErrors === undefined
          ? {}
          : { cleanupErrors: value.cleanupErrors.map(publicError) })
      }
    },
    async waitHandoff(owner, operationId) {
      return request('wait-handoff', { lease: privateLease(owner), operationId })
    },
    dispose() {
      disposed = true
      owners.clear()
    }
  })
}
