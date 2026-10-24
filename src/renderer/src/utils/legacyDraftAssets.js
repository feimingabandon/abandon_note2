import {
  cloneDraftMetadata,
  draftError,
  EDITING_DRAFT_PREFIX,
  parseDraftJournal
} from './draftAssets.js'

const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value) => typeof value === 'string' && value.length > 0
const legacyFailure = () => draftError('旧版草稿格式或来源无法确认，原始记录仍保留')
// Exact fields emitted by the verified v2 producers. Unknown data must stay in
// its original journal instead of being dropped by a current form's next flush.
const producerFields = {
  newNote: new Set(
    'content remark contentColorRanges effectiveAt statusChoice finishedAt cleanEffectiveAt cleanFinishedAt durationKind durationDays reminderChannels isPinned tagIds attachments'.split(
      ' '
    )
  ),
  note: new Set(
    'content remark contentColorRanges statusChoice effectiveAt finishedAt durationKind durationDays reminderChannels pendingReminderTime pendingReminderCancelled isPinned tagIds initialVersion attachments'.split(
      ' '
    )
  ),
  month: new Set(
    'content remark contentColorRanges time timeDirty immediateIntent statusChoice finishedAt durationKind durationDays reminderChannels isPinned tagIds attachments'.split(
      ' '
    )
  ),
  quick: new Set('draft remarkDraft originalContent originalRemark'.split(' ')),
  template: new Set(
    'content frequency interval weekdays monthDays quarterMonth quarterDays yearDates timeOfDay startAt endAt reminderChannels isPinned tagIds'.split(
      ' '
    )
  ),
  calendar: new Set(['drafts']),
  capture: new Set(['pendingAsset'])
}
function fieldsForProducer(key) {
  if (key === 'new:list' || key === 'new:capture') return producerFields.newNote
  if (key.startsWith('new:calendar:')) return producerFields.month
  return producerFields[key.split(':')[0]]
}
export const LEGACY_CAPTURE_CONFLICT =
  '检测到两份旧截图草稿，无法确认是否已交接，原始记录已保留，暂不能重复加载。'

export function isKnownLegacyDraftKey(key) {
  if (typeof key !== 'string') return false
  const numeric = /^(?:note|quick|template):([1-9]\d*)$/.exec(key)
  const date = /^new:calendar:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1]
  const parsedDate = date ? new Date(`${date}T00:00:00Z`) : null
  return (
    [
      'new:list',
      'new:capture',
      'template:new',
      'calendar:quick',
      'capture:pending-delivery'
    ].includes(key) ||
    Boolean(numeric && Number.isSafeInteger(Number(numeric[1]))) ||
    Boolean(
      parsedDate &&
      Number.isFinite(parsedDate.getTime()) &&
      parsedDate.toISOString().slice(0, 10) === date
    )
  )
}

export const legacyDraftKey = (sessionId, key) => `${EDITING_DRAFT_PREFIX}v2:${sessionId}:${key}`

function pendingIdentity(pending) {
  return record(pending) && text(pending.sessionId) && text(pending.deliveryId)
    ? { sessionId: pending.sessionId, deliveryId: pending.deliveryId, action: pending.action }
    : null
}

/** Validate only the two old image locations proved by the v2 producers. */
export function parseLegacyDraft(raw, key) {
  if (!isKnownLegacyDraftKey(key)) throw legacyFailure()
  const value = JSON.parse(raw)
  if (
    !record(value) ||
    Object.keys(value).some((name) => !['updatedAt', 'data'].includes(name)) ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt < 0 ||
    !record(value.data) ||
    Object.keys(value.data).some((name) => !fieldsForProducer(key).has(name))
  )
    throw legacyFailure()
  const data = structuredClone(value.data)
  if (Object.hasOwn(data, 'attachments') && data.attachments != null) {
    const attachments = data.attachments
    if (
      !record(attachments) ||
      Object.keys(attachments).some((name) => !['addedImages', 'deletedImageIds'].includes(name)) ||
      !Array.isArray(attachments.addedImages) ||
      !Array.isArray(attachments.deletedImageIds) ||
      !attachments.deletedImageIds.every((id) => Number.isSafeInteger(id) && id > 0)
    )
      throw legacyFailure()
    attachments.addedImages = attachments.addedImages.map((image) => {
      if (
        !record(image) ||
        Object.keys(image).some((name) => !['base64', 'ext', 'name', 'size'].includes(name)) ||
        !text(image.base64) ||
        !['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(image.ext) ||
        (image.name != null && typeof image.name !== 'string') ||
        (image.size != null && (!Number.isFinite(image.size) || image.size <= 0))
      )
        throw legacyFailure()
      return { ...image }
    })
  }
  if (Object.hasOwn(data, 'pendingAsset') && data.pendingAsset != null) {
    const pending = data.pendingAsset
    if (
      key !== 'capture:pending-delivery' ||
      !pendingIdentity(pending) ||
      !['note', 'background'].includes(pending.action) ||
      !text(pending.dataUrl) ||
      !/^data:image\/png;base64,/.test(pending.dataUrl) ||
      Object.keys(pending).some(
        (name) =>
          ![
            'width',
            'height',
            'size',
            'dataUrl',
            'token',
            'sessionId',
            'deliveryId',
            'action'
          ].includes(name)
      )
    )
      throw legacyFailure()
  }
  // Remove payloads from a separate copy before applying the v3 metadata rules.
  const metadata = structuredClone(data)
  if (metadata.attachments) metadata.attachments.addedImages = []
  if (metadata.pendingAsset) metadata.pendingAsset = pendingIdentity(metadata.pendingAsset)
  cloneDraftMetadata(metadata)
  return data
}

export async function hashLegacyDraft(raw) {
  const bytes = new TextEncoder().encode(raw)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('')
}

export function legacyMigrationReceipt(sessionId, key, sourceHash, data) {
  return {
    version: 2,
    sourceKey: legacyDraftKey(sessionId, key),
    sourceHash,
    phase: 'staging',
    ...(key === 'capture:pending-delivery' && data.pendingAsset
      ? { capture: pendingIdentity(data.pendingAsset) }
      : {})
  }
}

/** stage is deliberately sequential; the caller guards every awaited result. */
export async function convertLegacyDraft(data, stage) {
  const result = structuredClone(data)
  if (result.attachments) {
    const images = []
    for (const image of result.attachments.addedImages) images.push(await stage(image))
    result.attachments.addedImages = images
  }
  if (result.pendingAsset) {
    const pending = result.pendingAsset
    result.pendingAsset = {
      ...pendingIdentity(pending),
      image: await stage({ base64: pending.dataUrl, ext: 'png', size: pending.size })
    }
  }
  return cloneDraftMetadata(result)
}

/** No IO or mutation: provenance remains meaningful after the raw v2 key is removed. */
export function findLegacyCaptureConflict(storage, sessionId) {
  const read = (key) => {
    const raw = storage.getItem(legacyDraftKey(sessionId, key))
    let journal = null
    try {
      const current = storage.getItem(`${EDITING_DRAFT_PREFIX}v3:${sessionId}:${key}`)
      if (current !== null) journal = parseDraftJournal(current, sessionId, key)
    } catch {
      // An unknown target cannot prove that a handoff has happened.
    }
    let legacy = null
    try {
      if (raw !== null) legacy = parseLegacyDraft(raw, key)
    } catch {
      // Presence still establishes an ambiguous legacy source; never overwrite it.
    }
    return { raw, journal, legacy, provenance: raw !== null || Boolean(journal?.migration) }
  }
  const source = read('capture:pending-delivery'),
    target = read('new:capture')
  if (!source.provenance || !target.provenance) return null
  const pending =
    source.legacy?.pendingAsset ||
    source.journal?.data.pendingAsset ||
    source.journal?.migration?.capture
  if (pending?.action === 'background') return null
  const identity = pendingIdentity(pending)
  const images = target.journal?.data.attachments?.addedImages
  const receipts = target.journal?.data.captureReceipts
  if (
    identity &&
    Array.isArray(images) &&
    Array.isArray(receipts) &&
    receipts.some(
      (receipt) =>
        record(receipt) &&
        receipt.sessionId === identity.sessionId &&
        receipt.deliveryId === identity.deliveryId &&
        text(receipt.assetId) &&
        images.some((image) => record(image) && image.assetId === receipt.assetId)
    )
  )
    return null
  return LEGACY_CAPTURE_CONFLICT
}
