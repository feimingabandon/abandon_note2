import * as filesystem from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import {
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENTS_PER_NOTE,
  MAX_IMAGE_BYTES,
  getBase64DecodedSize
} from '../../shared/attachment-rules.js'
import {
  createSessionDraftAssetFiles,
  SESSION_DRAFT_ASSET_HEADER_BYTES
} from './session-draft-files.js'
export { readSessionDraftAssetPayload } from './session-draft-files.js'

// A technical session reservation, independent of each owner's attachment rules.
// Budgets count payload bytes; every owned file adds a fixed 512-byte header.
export const DEFAULT_SESSION_DRAFT_BYTES = 200 * 1024 * 1024

const extensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
const terminalLimit = 16
const failure = (code, message) => Object.assign(new Error(message), { code })
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
const diagnosticErrorMetadata = (error) => ({
  message: error?.message || String(error),
  ...Object.fromEntries(
    ['name', 'code', 'errno', 'syscall', 'path', 'dest', 'stack']
      .filter((key) => error?.[key] !== undefined)
      .map((key) => [key, error[key]])
  )
})
const publicErrors = Object.freeze({
  DRAFT_DOCUMENT_EXPIRED: '草稿资产请求所属文档已失效',
  DRAFT_LEASE_INVALID: '草稿资产访问凭据已失效',
  DRAFT_OWNER_RESUME_INVALID: '草稿归属信息不匹配，请保留原草稿',
  DRAFT_ASSET_INVALID: '草稿资产无效或暂不可用',
  DRAFT_ASSET_LIMIT: '草稿资产大小、数量或会话预算已达上限',
  DRAFT_ASSET_PATH_INVALID: '草稿资产归属校验失败',
  DRAFT_OPERATION_INVALID: '草稿交接操作不存在或已失效',
  DRAFT_STORE_CLEARING: '草稿资产正在清空',
  DRAFT_STORE_CLOSED: '草稿资产会话已结束',
  DRAFT_RUNTIME_SEALED: '草稿资产正在准备离开，请稍后重试',
  DRAFT_RUNTIME_OWNER_INVALID: '草稿资产准备操作已失效',
  DRAFT_HANDOFF_UNAVAILABLE: '草稿附件提交尚不可用，请保留草稿',
  DRAFT_IPC_INVALID: '草稿资产请求格式无效',
  DRAFT_REQUEST_MISMATCH: '保存请求与原草稿不一致，请保留草稿并重新核对',
  DRAFT_REQUEST_LIMIT: '当前草稿保存尝试已达上限，请保留内容后重新打开',
  DRAFT_NOTE_CONFLICT: '便签已发生变化，当前草稿尚未保存；请保留草稿后重新打开编辑器',
  EACCES: '草稿资产文件访问被拒绝，请保留草稿后重试',
  EPERM: '草稿资产文件访问被拒绝，请保留草稿后重试',
  EIO: '草稿资产读写失败，请保留草稿后重试',
  ENOSPC: '草稿资产存储空间不足，请保留草稿后重试',
  EDQUOT: '草稿资产存储配额不足，请保留草稿后重试',
  ENOENT: '草稿资产文件不可用，请保留草稿后重试',
  EBUSY: '草稿资产文件正在使用，请稍后重试',
  EEXIST: '草稿资产暂存未完成，请保留草稿后重试',
  SQLITE_CONSTRAINT: '草稿附件提交未完成，请保留草稿后重试',
  SQLITE_CONSTRAINT_TRIGGER: '草稿附件提交未完成，请保留草稿后重试',
  SQLITE_CONSTRAINT_FOREIGNKEY: '草稿附件提交未完成，请保留草稿后重试',
  SQLITE_BUSY: '草稿附件存储正在使用，请稍后重试',
  SQLITE_READONLY: '草稿附件存储暂不可写，请保留草稿后重试',
  SQLITE_IOERR: '草稿附件存储读写失败，请保留草稿后重试',
  SQLITE_FULL: '草稿附件存储空间不足，请保留草稿后重试',
  DRAFT_ASSET_OPERATION_FAILED: '草稿资产操作失败，请保留草稿后重试'
})

/** Public IPC metadata is selected only from constants; raw OS errors stay in main. */
export function publicSessionDraftAssetError(error) {
  const code =
    typeof error?.code === 'string' && Object.hasOwn(publicErrors, error.code)
      ? error.code
      : 'DRAFT_ASSET_OPERATION_FAILED'
  return { code, message: publicErrors[code] }
}

/** Main owns session files, leases, pending IO and fixed-consumer handoffs. */
export function createSessionDraftAssetStore({
  root,
  sessionId,
  isDocumentCurrent,
  sessionByteLimit = DEFAULT_SESSION_DRAFT_BYTES,
  io = {},
  onRecovery
}) {
  if (!isAbsolute(String(root || '')) || !String(sessionId || '').trim())
    throw new TypeError('草稿资产需要绝对根目录和启动 session')
  if (typeof isDocumentCurrent !== 'function') throw new TypeError('缺少当前文档校验端口')
  if (!Number.isSafeInteger(sessionByteLimit) || sessionByteLimit < 0)
    throw new TypeError('草稿资产会话预算必须是非负整数字节数')
  const directory = resolve(root)
  const files = { ...filesystem, ...io }
  const assetFiles = createSessionDraftAssetFiles({ root: directory, sessionId, io, onRecovery })
  const owners = new Map()
  const keys = new Map()
  const assets = new Map()
  const pending = new Map()
  const capturedReads = new WeakMap()
  const documentReadIds = new WeakMap()
  const readFailures = new Map()
  let rootReady,
    clearTask,
    disposeTask,
    clearing = false,
    disposed = false,
    reservedBytes = 0,
    cleanupSequence = 0

  function assertOpen() {
    if (disposed) throw failure('DRAFT_STORE_CLOSED', '草稿资产会话已结束')
    if (clearing) throw failure('DRAFT_STORE_CLEARING', '草稿资产正在清空')
  }
  function assertDocument(document) {
    if (!document || !isDocumentCurrent(document))
      throw failure('DRAFT_DOCUMENT_EXPIRED', '草稿资产请求所属文档已失效')
  }
  function leaseFor(owner) {
    return Object.freeze({
      sessionId,
      ownerId: owner.id,
      generation: owner.generation,
      capability: owner.capability
    })
  }
  function assertLease(document, lease) {
    assertDocument(document)
    assertOpen()
    const owner = owners.get(lease?.ownerId)
    if (
      !owner ||
      owner.state !== 'active' ||
      lease.sessionId !== sessionId ||
      lease.generation !== owner.generation ||
      lease.capability !== owner.capability ||
      document !== owner.document
    )
      throw failure('DRAFT_LEASE_INVALID', '草稿资产 owner、session、generation 或访问凭据已失效')
    return owner
  }
  function track(owner, operation) {
    // An empty owner can only be reclaimed after a lost opening receipt if it
    // has never accepted work. Released or failed work must not erase history.
    if (owner) owner.acceptedWork = true
    const task = Promise.resolve(operation)
    pending.set(task, owner)
    const release = () => pending.delete(task)
    void task.then(release, release)
    return task
  }
  async function ensureRoot() {
    if (!rootReady) rootReady = track(null, assetFiles.initialize())
    return rootReady
  }
  function assertOwnedPath(asset) {
    assetFiles.assertPath(asset)
  }
  function metadata(asset) {
    return {
      assetId: asset.id,
      ext: asset.ext,
      name: asset.name,
      size: asset.size,
      sha256: asset.sha256
    }
  }
  function selected(owner, ids) {
    if (!Array.isArray(ids)) throw failure('DRAFT_ASSET_INVALID', '资产 ID 列表无效')
    return [...new Set(ids)].map((id) => {
      const asset = assets.get(id)
      if (!asset || asset.owner !== owner || asset.generation !== owner.generation)
        throw failure('DRAFT_ASSET_INVALID', '草稿资产不存在或不属于当前 owner')
      return asset
    })
  }
  function forget(asset) {
    if (assets.get(asset.id) !== asset) return
    assets.delete(asset.id)
    asset.owner.assets.delete(asset.id)
    reservedBytes -= asset.size
  }
  async function cleanupAsset(asset, cycle) {
    if (assets.get(asset.id) !== asset) return null
    if (asset.pins)
      return asset.readFailure || failure('DRAFT_ASSET_INVALID', '草稿资产执行资源尚未结束')
    if (asset.cleanupTask) return asset.cleanupTask
    if (asset.cleanupError && asset.cleanupCycle === cycle) return asset.cleanupError
    // Revoke ready access before unlink can yield or call an injected IO port.
    // An inverse-order handoff must never pin a source already being removed.
    asset.status = 'cleaning'
    const task = (async () => {
      try {
        if (asset.owned) {
          assertOwnedPath(asset)
          await assetFiles.verifyOwned(asset)
          await files.unlink(asset.path)
        }
        forget(asset)
        return null
      } catch (error) {
        if (error?.code === 'ENOENT') {
          forget(asset)
          return null
        }
        asset.status = 'cleanup-failed'
        asset.cleanupError = error
        asset.cleanupCycle = cycle
        return error
      }
    })()
    asset.cleanupTask = task
    try {
      return await task
    } finally {
      asset.cleanupTask = null
    }
  }
  async function drain(owner = null) {
    for (;;) {
      const tasks = [...pending].filter(([, candidate]) => !owner || candidate === owner)
      if (!tasks.length) {
        const errors = [...readFailures]
          .filter(([asset]) => !owner || asset.owner === owner)
          .map(([, error]) => error)
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, '草稿资产读取资源收尾未完成')
        return
      }
      await Promise.allSettled(tasks.map(([task]) => task))
    }
  }
  async function cleanupOwner(owner) {
    const outcomes = await Promise.all(
      [...owner.assets].map((id) => cleanupAsset(assets.get(id), owner.cleanupCycle))
    )
    const errors = outcomes.filter(Boolean)
    if (!owner.assets.size) owners.delete(owner.id)
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, '草稿资产清理未完成')
  }
  function revoke(owner, state, cycle) {
    owner.state = state
    owner.generation += 1
    owner.capability = null
    owner.document = null
    owner.cleanupCycle = cycle
    if (keys.get(owner.key) === owner) keys.delete(owner.key)
  }
  function trimOperations(owner) {
    const terminal = [...owner.operations].filter(([, operation]) => operation.status !== 'pending')
    for (const [id] of terminal.slice(0, Math.max(0, terminal.length - terminalLimit)))
      owner.operations.delete(id)
  }
  function operationFor(owner, operationId) {
    const operation = owner.operations.get(operationId)
    if (!operation) throw failure('DRAFT_OPERATION_INVALID', '交接操作不存在或不属于当前 owner')
    return operation
  }
  function operationMetadata(operation, serializeError = publicSessionDraftAssetError) {
    return {
      operationId: operation.id,
      status: operation.status,
      ...(operation.status === 'failed' ? { error: serializeError(operation.error) } : {}),
      ...(operation.cleanupErrors.length
        ? { cleanupErrors: operation.cleanupErrors.map(serializeError) }
        : {})
    }
  }

  function openOwner(document, key, resume = null) {
    assertDocument(document)
    assertOpen()
    if (typeof key !== 'string' || !key.trim() || key.length > 256)
      throw failure('DRAFT_OWNER_RESUME_INVALID', '逻辑草稿 key 无效')
    let owner = keys.get(key)
    if (resume !== null) {
      if (
        !owner ||
        resume.sessionId !== sessionId ||
        resume.key !== key ||
        resume.ownerId !== owner.id ||
        resume.generation !== owner.generation ||
        owner.state !== 'active'
      )
        throw failure(
          'DRAFT_OWNER_RESUME_INVALID',
          '原草稿的 session、key、owner 或 generation 不匹配'
        )
    } else if (owner && owner.document !== document) {
      const unpublishedEmpty =
        owner.state === 'active' &&
        !owner.acceptedWork &&
        !owner.assets.size &&
        !owner.operations.size &&
        ![...pending.values()].includes(owner) &&
        !isDocumentCurrent(owner.document)
      if (!unpublishedEmpty)
        throw failure('DRAFT_OWNER_RESUME_INVALID', '新文档必须使用原记录重新绑定已有草稿 owner')
    }
    if (!owner) {
      owner = {
        id: randomUUID(),
        key,
        generation: 1,
        state: 'active',
        document: null,
        capability: null,
        cleanupCycle: 0,
        assets: new Set(),
        operations: new Map(),
        closingTask: null,
        acceptedWork: false
      }
      owners.set(owner.id, owner)
      keys.set(key, owner)
    }
    if (owner.document !== document || !owner.capability) {
      owner.document = document
      owner.capability = randomUUID()
    }
    return leaseFor(owner)
  }

  function stage(document, lease, image) {
    let owner
    const task = (async () => {
      owner = assertLease(document, lease)
      const ext = String(image?.ext || '').toLowerCase()
      if (!extensions.has(ext)) throw failure('DRAFT_ASSET_INVALID', '不支持的图片格式')
      const encoded = String(image?.base64 || '').trim()
      const base64 = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded
      const estimated = getBase64DecodedSize(base64)
      if (!estimated || estimated > MAX_IMAGE_BYTES)
        throw failure('DRAFT_ASSET_LIMIT', '单张草稿图片须大于零且不能超过 50MiB')
      const bytes = Buffer.from(base64, 'base64')
      if (!bytes.length || bytes.length !== estimated || bytes.length > MAX_IMAGE_BYTES)
        throw failure('DRAFT_ASSET_LIMIT', '草稿图片实际字节无效或超过 50MiB')
      if (
        owner.assets.size >= MAX_ATTACHMENTS_PER_NOTE ||
        [...owner.assets].reduce((total, id) => total + (assets.get(id)?.size || 0), 0) +
          bytes.length >
          MAX_ATTACHMENT_BATCH_BYTES ||
        reservedBytes + bytes.length > sessionByteLimit
      )
        throw failure('DRAFT_ASSET_LIMIT', '草稿资产数量、归属附件总量或会话预算已满')
      const asset = {
        id: randomUUID(),
        owner,
        generation: owner.generation,
        ext,
        name: String(image?.name || ''),
        size: bytes.length,
        sha256: digest(bytes),
        status: 'staging',
        path: null,
        owned: false,
        pins: 0,
        unpinned: null,
        readPins: 0,
        readersDrained: null,
        handoffReservation: null,
        retiringReservation: null,
        readFailure: null,
        cleanupTask: null,
        cleanupCycle: null,
        cleanupError: null
      }
      assets.set(asset.id, asset)
      owner.assets.add(asset.id)
      reservedBytes += asset.size
      let handle, originalError
      try {
        await ensureRoot()
        assertLease(document, lease)
        await assetFiles.assertRoot()
        assertLease(document, lease)
        asset.path = assetFiles.pathFor(asset.id)
        handle = await files.open(asset.path, 'wx')
        asset.owned = true
        asset.fileIdentity = await handle.stat()
        await assetFiles.verifyOwned(asset)
        assertLease(document, lease)
        await assetFiles.writeHeader(handle, asset)
        assertLease(document, lease)
        await files.writeFile(handle, bytes)
        assertLease(document, lease)
        const status = await files.stat(asset.path)
        assertLease(document, lease)
        if (!status.isFile() || status.size !== SESSION_DRAFT_ASSET_HEADER_BYTES + asset.size)
          throw failure('DRAFT_ASSET_INVALID', '草稿资产落盘字节与原始图片不一致')
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
      if (!originalError) {
        try {
          assertLease(document, lease)
        } catch (error) {
          originalError = error
        }
      }
      if (originalError) {
        asset.failure = originalError
        await cleanupAsset(asset, owner.cleanupCycle)
        throw originalError
      }
      asset.status = 'ready'
      return metadata(asset)
    })()
    return track(owner, task)
  }

  function captureRead(document, lease, id) {
    const owner = assertLease(document, lease)
    const [asset] = selected(owner, [id])
    if (
      asset.status !== 'ready' ||
      asset.handoffReservation ||
      asset.retiringReservation ||
      asset.readFailure
    )
      throw failure('DRAFT_ASSET_INVALID', '草稿资产尚不可读取')
    if (!documentReadIds.has(document)) documentReadIds.set(document, randomUUID())
    const captured = Object.freeze({
      sessionId,
      documentId: documentReadIds.get(document),
      ownerId: owner.id,
      generation: owner.generation,
      assetId: asset.id,
      ext: asset.ext,
      size: asset.size,
      sha256: asset.sha256
    })
    capturedReads.set(captured, { document, lease: Object.freeze({ ...lease }), asset })
    return captured
  }
  function isReadCurrent(captured) {
    try {
      const original = capturedReads.get(captured)
      if (!original) return false
      const owner = assertLease(original.document, original.lease)
      const asset = original.asset
      return Boolean(
        assets.get(asset.id) === asset &&
        asset.owner === owner &&
        asset.generation === owner.generation &&
        asset.status === 'ready' &&
        !asset.handoffReservation &&
        !asset.retiringReservation &&
        !asset.readFailure
      )
    } catch {
      return false
    }
  }
  function pin(asset, { read = false } = {}) {
    if (!asset.pins) asset.unpinned = deferred()
    asset.pins++
    if (read) {
      if (!asset.readPins) asset.readersDrained = deferred()
      asset.readPins++
    }
  }
  function unpin(asset, { read = false } = {}) {
    if (read) {
      asset.readPins--
      if (!asset.readPins) asset.readersDrained.resolve()
    }
    asset.pins--
    if (!asset.pins) asset.unpinned.resolve()
  }
  function failReadClosure(asset, error) {
    asset.readFailure ||= error
    readFailures.set(asset, asset.readFailure)
    asset.readersDrained.reject(asset.readFailure)
    asset.unpinned.reject(asset.readFailure)
  }
  function failedReadOperation(asset, error, cancel = () => {}) {
    failReadClosure(asset, error)
    const result = Promise.reject(error)
    void result.catch(() => {})
    return Object.freeze({ result, closed: track(asset.owner, Promise.reject(error)), cancel })
  }
  function startRead(captured, reader) {
    if (typeof reader !== 'function') throw new TypeError('草稿读取只允许主进程可信 reader')
    if (!isReadCurrent(captured)) throw failure('DRAFT_ASSET_INVALID', '草稿读取来源已失效')
    const { asset } = capturedReads.get(captured)
    assertOwnedPath(asset)
    pin(asset, { read: true })
    let operation
    try {
      operation = reader(
        Object.freeze({
          path: asset.path,
          sessionId,
          assetId: asset.id,
          ext: asset.ext,
          size: asset.size,
          sha256: asset.sha256
        })
      )
    } catch (error) {
      // The fixed reader must not leave a resource behind on synchronous refusal.
      if (error?.resourceClosed === false) return failedReadOperation(asset, error)
      unpin(asset, { read: true })
      throw error
    }
    let result, closed, cancel
    try {
      result = operation?.result
      closed = operation?.closed
      cancel = operation?.cancel
      if (
        typeof result?.then !== 'function' ||
        typeof closed?.then !== 'function' ||
        typeof cancel !== 'function'
      )
        throw new TypeError('草稿 reader 必须返回 result、closed 和 cancel')
    } catch (error) {
      // An invalid ownership contract cannot prove that the resource ended.
      if (typeof result?.then === 'function') void Promise.resolve(result).catch(() => {})
      if (typeof closed?.then === 'function') void Promise.resolve(closed).catch(() => {})
      if (typeof cancel === 'function') {
        try {
          cancel.call(operation, 'invalid-operation')
        } catch {
          // Preserve the first contract failure and its pin.
        }
      }
      // Return a rejected close contract so the shared runtime seals capacity;
      // throwing here would falsely classify the start as resource-free.
      return failedReadOperation(
        asset,
        error,
        typeof cancel === 'function' ? (reason) => cancel.call(operation, reason) : () => {}
      )
    }
    const ownedClosed = track(
      asset.owner,
      Promise.resolve(closed).then(
        (status) => {
          unpin(asset, { read: true })
          if (status?.cleanupError !== undefined) readFailures.set(asset, status.cleanupError)
          return status
        },
        (error) => {
          failReadClosure(asset, error)
          throw error
        }
      )
    )
    return Object.freeze({
      result: Promise.resolve(result),
      closed: ownedClosed,
      cancel: (reason) => cancel.call(operation, reason)
    })
  }
  function preview(document, lease, id) {
    let owner
    const task = (async () => {
      owner = assertLease(document, lease)
      const captured = captureRead(document, lease, id)
      const { asset } = capturedReads.get(captured)
      const operation = startRead(captured, () => {
        const result = assetFiles.read(asset)
        return {
          result,
          closed: result.then(
            () => undefined,
            (error) => {
              if (error?.resourceClosed === false) throw error
            }
          ),
          cancel() {}
        }
      })
      const bytes = await operation.result
      await operation.closed
      assertLease(document, lease)
      if (assets.get(id) !== asset || asset.status !== 'ready' || bytes.length !== asset.size)
        throw failure('DRAFT_ASSET_INVALID', '草稿资产内容已变化')
      return { bytes, ext: asset.ext, size: asset.size, sha256: asset.sha256 }
    })()
    return track(owner, task)
  }

  function release(document, lease, ids) {
    let owner
    const task = (async () => {
      owner = assertLease(document, lease)
      const chosen = selected(owner, ids)
      const cycle = ++cleanupSequence
      const reservation = Symbol('draft-asset-release')
      for (const asset of chosen)
        if (asset.status === 'staging' || asset.retiringReservation)
          throw failure('DRAFT_ASSET_INVALID', '资产暂存或释放尚未结束')
      for (const asset of chosen) asset.retiringReservation = reservation
      try {
        for (const asset of chosen) {
          if (asset.pins) await asset.unpinned.promise
          assertLease(document, lease)
          const error = await cleanupAsset(asset, cycle)
          assertLease(document, lease)
          if (error) throw error
        }
      } finally {
        for (const asset of chosen)
          if (asset.retiringReservation === reservation) asset.retiringReservation = null
      }
      return true
    })()
    return track(owner, task)
  }

  function beginHandoff(document, lease, ids, consumer) {
    const owner = assertLease(document, lease)
    if (typeof consumer !== 'function') throw new TypeError('交接只允许主进程可信 consumer')
    const chosen = selected(owner, ids)
    for (const asset of chosen) {
      if (
        asset.status !== 'ready' ||
        asset.handoffReservation ||
        asset.retiringReservation ||
        asset.readFailure
      )
        throw failure('DRAFT_ASSET_INVALID', '草稿资产尚不可交接或正在交接')
      assertOwnedPath(asset)
    }
    const reservation = Symbol('draft-asset-handoff')
    for (const asset of chosen) {
      asset.handoffReservation = reservation
      pin(asset)
    }
    const operation = {
      id: randomUUID(),
      status: 'pending',
      error: null,
      cleanupErrors: [],
      result: undefined,
      task: null
    }
    owner.operations.set(operation.id, operation)
    operation.task = track(
      owner,
      Promise.resolve().then(async () => {
        try {
          await Promise.all(
            chosen.filter((asset) => asset.readPins).map((asset) => asset.readersDrained.promise)
          )
          // Acceptance owns this consumer even after reload, cancel or clear.
          // Waiting for earlier readers must never add a new lease admission.
          const descriptors = chosen.map((asset) =>
            Object.freeze({ ...metadata(asset), path: asset.path, sessionId })
          )
          operation.result = await consumer(descriptors)
          operation.status = 'committed'
        } catch (error) {
          operation.error = error
          operation.status = 'failed'
        } finally {
          for (const asset of chosen) {
            if (asset.handoffReservation === reservation) asset.handoffReservation = null
            unpin(asset)
          }
        }
        if (operation.status === 'committed') {
          operation.cleanupErrors = (
            await Promise.all(chosen.map((asset) => cleanupAsset(asset, owner.cleanupCycle)))
          ).filter(Boolean)
        }
        trimOperations(owner)
        if (operation.status === 'failed') throw operation.error
        return operation.result
      })
    )
    return operation.id
  }

  async function waitHandoff(document, lease, operationId) {
    const owner = assertLease(document, lease)
    const operation = operationFor(owner, operationId)
    let result,
      rejected = false,
      originalError
    try {
      result = await operation.task
    } catch (error) {
      rejected = true
      originalError = error
    }
    assertLease(document, lease)
    if (rejected) throw originalError
    return result
  }
  function operationState(document, lease, operationId) {
    const owner = assertLease(document, lease)
    return operationMetadata(operationFor(owner, operationId))
  }
  function cancelOwner(document, lease, { reportCleanup = false } = {}) {
    let owner
    try {
      owner = assertLease(document, lease)
    } catch (error) {
      return Promise.reject(error)
    }
    revoke(owner, 'cancelled', ++cleanupSequence)
    owner.closingTask = (async () => {
      await drain(owner)
      try {
        await cleanupOwner(owner)
        return reportCleanup ? { cancelled: true, cleanupErrors: [] } : true
      } catch (error) {
        if (!reportCleanup) throw error
        // Revocation already happened synchronously. A failed unlink must not
        // advertise a usable lease or invite the renderer to restore it.
        return { cancelled: true, cleanupErrors: [error] }
      }
    })()
    return owner.closingTask
  }

  function startClear() {
    clearing = true
    const cycle = ++cleanupSequence
    for (const owner of owners.values()) revoke(owner, 'cleared', cycle)
    const task = (async () => {
      try {
        await drain()
        await Promise.allSettled(
          [...owners.values()].map((owner) => owner.closingTask).filter(Boolean)
        )
        const outcomes = await Promise.allSettled([...owners.values()].map(cleanupOwner))
        const errors = outcomes.filter((outcome) => outcome.status === 'rejected')
        if (errors.length === 1) throw errors[0].reason
        if (errors.length)
          throw new AggregateError(
            errors.map((outcome) => outcome.reason),
            '草稿资产清空未完成'
          )
        return true
      } finally {
        clearing = false
        clearTask = null
      }
    })()
    clearTask = task
    return task
  }
  function clear() {
    if (disposed) return Promise.reject(failure('DRAFT_STORE_CLOSED', '草稿资产会话已结束'))
    return clearTask || startClear()
  }
  function dispose() {
    if (disposeTask) return disposeTask
    disposed = true
    disposeTask = clearTask || startClear()
    return disposeTask
  }
  function snapshot() {
    return {
      sessionId,
      clearing,
      disposed,
      pending: pending.size,
      reservedBytes,
      sessionByteLimit,
      ownerByteLimit: MAX_ATTACHMENT_BATCH_BYTES,
      storageRecovery: assetFiles.snapshot().map(({ error, ...entry }) => ({
        ...entry,
        ...(error ? { error: diagnosticErrorMetadata(error) } : {})
      })),
      assetCount: assets.size,
      assets: [...assets.values()].map((asset) => ({
        assetId: asset.id,
        ownerId: asset.owner.id,
        generation: asset.generation,
        status: asset.status,
        path: asset.path,
        size: asset.size,
        pins: asset.pins,
        readPins: asset.readPins,
        handoffReserved: Boolean(asset.handoffReservation),
        retiring: Boolean(asset.retiringReservation),
        sha256: asset.sha256,
        ...(asset.failure ? { failure: diagnosticErrorMetadata(asset.failure) } : {}),
        ...(asset.readFailure ? { readFailure: diagnosticErrorMetadata(asset.readFailure) } : {}),
        ...(asset.cleanupError ? { cleanupError: diagnosticErrorMetadata(asset.cleanupError) } : {})
      })),
      owners: [...owners.values()].map((owner) => ({
        key: owner.key,
        ownerId: owner.id,
        generation: owner.generation,
        state: owner.state
      })),
      operations: [...owners.values()].flatMap((owner) =>
        [...owner.operations.values()].map((operation) => ({
          ownerId: owner.id,
          ...operationMetadata(operation, diagnosticErrorMetadata)
        }))
      )
    }
  }

  return Object.freeze({
    initialize: () => {
      assertOpen()
      return ensureRoot()
    },
    drain: async () => {
      await drain()
      await Promise.allSettled(
        [...owners.values()].map((owner) => owner.closingTask).filter(Boolean)
      )
    },
    openOwner,
    assertOwner(document, lease) {
      assertLease(document, lease)
      return true
    },
    stage,
    preview,
    captureRead,
    isReadCurrent,
    startRead,
    release,
    beginHandoff,
    waitHandoff,
    operationState,
    cancelOwner,
    clear,
    dispose,
    snapshot
  })
}
