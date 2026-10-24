export const EDITING_DRAFT_PREFIX = 'abandon:editing-draft:'
export const EDITING_DRAFT_VERSION = 3

const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value) => typeof value === 'string' && value.length > 0
const forbidden = new Set([
  'base64',
  'dataUrl',
  'filePath',
  'file_path',
  'path',
  'capability',
  'bytes'
])

export function draftError(message, code = 'DRAFT_JOURNAL_INVALID') {
  return Object.assign(new Error(message), { code })
}

/** Journal metadata never contains promises, credentials or original-image payloads. */
export function cloneDraftMetadata(value) {
  const ancestors = new Set()
  function visit(item) {
    if (item === undefined) return undefined
    if (item === null || ['string', 'boolean'].includes(typeof item)) return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (!record(item) && !Array.isArray(item)) throw draftError('草稿包含不能暂存的内容')
    if (typeof item.then === 'function' || ancestors.has(item))
      throw draftError('草稿包含尚未完成的异步操作')
    ancestors.add(item)
    let result
    if (Array.isArray(item)) result = item.map(visit)
    else {
      result = {}
      for (const [key, entry] of Object.entries(item)) {
        if (forbidden.has(key)) throw draftError('图片原始内容不能写入草稿日志')
        const copied = visit(entry)
        if (copied !== undefined) result[key] = copied
      }
    }
    ancestors.delete(item)
    return result
  }
  return visit(value)
}

export function isDraftOwner(owner, sessionId, key) {
  return (
    record(owner) &&
    owner.sessionId === sessionId &&
    owner.key === key &&
    text(owner.ownerId) &&
    Number.isSafeInteger(owner.generation) &&
    owner.generation > 0 &&
    !Object.hasOwn(owner, 'capability')
  )
}

export function parseDraftJournal(raw, sessionId, key) {
  const value = JSON.parse(raw)
  if (
    !record(value) ||
    value.version !== EDITING_DRAFT_VERSION ||
    value.sessionId !== sessionId ||
    value.key !== key ||
    !isDraftOwner(value.owner, sessionId, key) ||
    !record(value.data)
  )
    throw draftError('草稿格式或归属无法确认，原始记录仍保留')
  const handoff = value.handoff
  if (
    handoff != null &&
    (!record(handoff) ||
      !text(handoff.requestId) ||
      !['create', 'save'].includes(handoff.kind) ||
      !record(handoff.payload) ||
      !record(handoff.submittedData))
  )
    throw draftError('草稿提交记录无法确认，原始记录仍保留')
  const migration = value.migration
  if (
    migration != null &&
    (!record(migration) ||
      migration.version !== 2 ||
      migration.sourceKey !== `${EDITING_DRAFT_PREFIX}v2:${sessionId}:${key}` ||
      typeof migration.sourceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(migration.sourceHash) ||
      !['staging', 'complete'].includes(migration.phase) ||
      Object.keys(migration).some(
        (name) => !['version', 'sourceKey', 'sourceHash', 'phase', 'capture'].includes(name)
      ) ||
      (migration.phase === 'staging' && (Object.keys(value.data).length > 0 || handoff)) ||
      (migration.capture != null &&
        (key !== 'capture:pending-delivery' ||
          !record(migration.capture) ||
          Object.keys(migration.capture).some(
            (name) => !['sessionId', 'deliveryId', 'action'].includes(name)
          ) ||
          !text(migration.capture.sessionId) ||
          !text(migration.capture.deliveryId) ||
          !['note', 'background'].includes(migration.capture.action))))
  )
    throw draftError('旧草稿迁移凭据无法确认，原始记录仍保留')
  return cloneDraftMetadata(value)
}

export function sameDraftMetadata(left, right) {
  const ordered = (value) => {
    if (Array.isArray(value)) return value.map(ordered)
    if (!record(value)) return value
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])])
    )
  }
  return (
    JSON.stringify(ordered(cloneDraftMetadata(left))) ===
    JSON.stringify(ordered(cloneDraftMetadata(right)))
  )
}

/** Only recognized v3 records from previous launches belong to automatic cleanup. */
export function removePreviousDraftSessions(storage, sessionId) {
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(`${EDITING_DRAFT_PREFIX}v3:`)) continue
    try {
      const value = JSON.parse(storage.getItem(key))
      if (!text(value?.sessionId) || value.sessionId === sessionId || !text(value?.key)) continue
      parseDraftJournal(JSON.stringify(value), value.sessionId, value.key)
      if (key === `${EDITING_DRAFT_PREFIX}v3:${value.sessionId}:${value.key}`)
        storage.removeItem(key)
    } catch {
      // Unrecognized or inaccessible records must remain untouched.
    }
  }
}
