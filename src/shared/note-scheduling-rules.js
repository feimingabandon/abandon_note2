export const MIN_SCHEDULE_LEAD_TIME_MINUTES = 2
export const MIN_SCHEDULE_LEAD_TIME_MS = MIN_SCHEDULE_LEAD_TIME_MINUTES * 60 * 1000
export const SCHEDULE_SHORTCUT_SAFETY_MARGIN_MS = 60 * 1000
export const DEFAULT_NEW_NOTE_SCHEDULE_TIME = '00:01'

function padClockPart(value) {
  return String(value).padStart(2, '0')
}

export function defaultMonthNoteEffectiveTime(dateKey, todayKey, currentTime = Date.now()) {
  const now = currentTime instanceof Date ? currentTime : new Date(Number(currentTime))
  if (Number.isNaN(now.getTime())) throw new Error('当前时间无效')
  if (String(dateKey) !== String(todayKey)) {
    const [year, month, day] = String(dateKey).split('-').map(Number)
    const [hour, minute] = DEFAULT_NEW_NOTE_SCHEDULE_TIME.split(':').map(Number)
    const defaultTimestamp = new Date(year, month - 1, day, hour, minute).getTime()
    if (String(dateKey) < String(todayKey)) return DEFAULT_NEW_NOTE_SCHEDULE_TIME
    const safeTimestamp = createSafeScheduleShortcutTimestamp(now.getTime())
    const selectedTimestamp = Math.max(defaultTimestamp, safeTimestamp)
    const selected = new Date(selectedTimestamp)
    return `${padClockPart(selected.getHours())}:${padClockPart(selected.getMinutes())}`
  }
  return `${padClockPart(now.getHours())}:${padClockPart(now.getMinutes())}`
}

export function createSafeScheduleShortcutTimestamp(currentTime = Date.now()) {
  const timestamp = Number(currentTime)
  if (!Number.isFinite(timestamp)) throw new Error('当前时间无效')
  return (
    Math.ceil(
      (timestamp + MIN_SCHEDULE_LEAD_TIME_MS + SCHEDULE_SHORTCUT_SAFETY_MARGIN_MS) / 60_000
    ) * 60_000
  )
}

export function assertMinimumScheduleLeadTime(value, currentTime = Date.now()) {
  const effectiveAt = Number(value)
  const timestamp = Number(currentTime)
  if (!Number.isFinite(effectiveAt) || !Number.isFinite(timestamp)) {
    throw new Error('生效时间无效')
  }
  if (effectiveAt - timestamp < MIN_SCHEDULE_LEAD_TIME_MS) {
    throw new Error(`生效时间需在当前时间 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟之后`)
  }
  return effectiveAt
}

/**
 * 校验用户显式填写的便签生效时间。
 *
 * 当前或过去时间表示历史补录，可以直接进入进行中；真正的未来预约仍需保留
 * 最小提前量，避免保存和调度竞态。
 */
export function assertCreatableNoteEffectiveTime(value, currentTime = Date.now()) {
  const effectiveAt = Number(value)
  const timestamp = Number(currentTime)
  if (!Number.isFinite(effectiveAt) || effectiveAt <= 0 || !Number.isFinite(timestamp)) {
    throw new Error('生效时间无效')
  }
  if (effectiveAt <= timestamp) return effectiveAt
  return assertMinimumScheduleLeadTime(effectiveAt, timestamp)
}

export function canScheduleNoteNotification(value, currentTime = Date.now()) {
  const effectiveAt = Number(value)
  const timestamp = Number(currentTime)
  return (
    Number.isFinite(effectiveAt) &&
    effectiveAt > 0 &&
    Number.isFinite(timestamp) &&
    effectiveAt - timestamp >= MIN_SCHEDULE_LEAD_TIME_MS
  )
}

export function sameTimestampSecond(left, right) {
  return Math.floor(Number(left) / 1000) === Math.floor(Number(right) / 1000)
}

export const NOTE_STATUSES = Object.freeze({
  PENDING: 'initialized',
  PROGRESS: 'in_progress',
  COMPLETED: 'completed'
})

function assertCurrentTime(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('当前时间无效')
  return timestamp
}

function isNowTime(value) {
  return value === null || value === undefined || value === '' || value === 'now'
}

function resolveEffectiveTime(value, timestamp) {
  if (isNowTime(value)) return timestamp
  const effectiveAt = Number(value)
  if (
    !Number.isFinite(effectiveAt) ||
    effectiveAt <= 0 ||
    !Number.isFinite(new Date(effectiveAt).getTime())
  ) {
    throw new Error('请选择有效的生效时间')
  }
  return effectiveAt
}

/** UI availability follows time; it never changes the user's remembered choice. */
export function getAllowedNoteStatuses(effectiveAt = null, currentTime = Date.now()) {
  const effective = isNowTime(effectiveAt) ? Number(currentTime) : Number(effectiveAt)
  if (!Number.isFinite(effective) || effective <= 0) return []
  return effective > Number(currentTime)
    ? [NOTE_STATUSES.PENDING]
    : [NOTE_STATUSES.PROGRESS, NOTE_STATUSES.COMPLETED]
}

export function deriveNoteStatusForTime({
  effectiveAt = null,
  requestedStatus = NOTE_STATUSES.PROGRESS,
  currentTime = Date.now()
} = {}) {
  if (getAllowedNoteStatuses(effectiveAt, currentTime).includes(NOTE_STATUSES.PENDING)) {
    return NOTE_STATUSES.PENDING
  }
  return requestedStatus === NOTE_STATUSES.COMPLETED
    ? NOTE_STATUSES.COMPLETED
    : NOTE_STATUSES.PROGRESS
}

function resolveRequestedStatus(requestedStatus, effectiveAt, timestamp) {
  if (requestedStatus !== undefined && !Object.values(NOTE_STATUSES).includes(requestedStatus)) {
    throw new Error(`不支持的便签状态：${requestedStatus}`)
  }
  if (effectiveAt > timestamp) {
    if (requestedStatus !== undefined && requestedStatus !== NOTE_STATUSES.PENDING) {
      throw new Error('未来生效的便签只能设置为未开始')
    }
    return NOTE_STATUSES.PENDING
  }
  // An appointment can become due while the user is editing or attaching files.
  return requestedStatus === NOTE_STATUSES.COMPLETED
    ? NOTE_STATUSES.COMPLETED
    : NOTE_STATUSES.PROGRESS
}

function resolveCompletionTime(value, effectiveAt, timestamp) {
  const finishedAt = isNowTime(value) ? timestamp : Number(value)
  if (
    !Number.isFinite(finishedAt) ||
    finishedAt <= 0 ||
    !Number.isFinite(new Date(finishedAt).getTime())
  ) {
    throw new Error('请选择有效的完成时间')
  }
  if (finishedAt < effectiveAt) throw new Error('完成时间不能早于生效时间')
  if (finishedAt > timestamp) throw new Error('完成时间不能晚于当前时间')
  return finishedAt
}

/** Resolve immediate start and completion against one commit timestamp. */
export function resolveNoteCreateSchedule({
  requestedEffectiveAt = null,
  requestedStatus,
  requestedFinishedAt,
  requestedNotifyEnabled = false,
  currentTime = Date.now()
} = {}) {
  const timestamp = assertCurrentTime(currentTime)
  const effectiveAt = resolveEffectiveTime(requestedEffectiveAt, timestamp)
  assertCreatableNoteEffectiveTime(effectiveAt, timestamp)
  const status = resolveRequestedStatus(requestedStatus, effectiveAt, timestamp)
  return {
    status,
    effectiveAt,
    notifyEnabled: status === NOTE_STATUSES.PENDING && requestedNotifyEnabled ? 1 : 0,
    finishedAt:
      status === NOTE_STATUSES.COMPLETED
        ? resolveCompletionTime(requestedFinishedAt, effectiveAt, timestamp)
        : timestamp
  }
}

/**
 * Validate one edit intention. Content-only edits preserve business times;
 * scheduling and completion changes are resolved together before persistence.
 */
export function resolveNoteDraftSchedule({
  status,
  currentEffectiveAt,
  currentNotifyEnabled = 0,
  currentFinishedAt,
  requestedEffectiveAt,
  requestedStatus,
  requestedFinishedAt,
  requestedNotifyEnabled = false,
  currentTime = Date.now()
}) {
  const timestamp = assertCurrentTime(currentTime)
  const current = Number(currentEffectiveAt)
  if (!Object.values(NOTE_STATUSES).includes(status)) {
    throw new Error(`不支持的便签状态：${status}`)
  }
  if (!Number.isFinite(current) || current <= 0) {
    throw new Error('生效时间无效')
  }
  const requested =
    requestedEffectiveAt === undefined
      ? current
      : resolveEffectiveTime(requestedEffectiveAt, timestamp)
  const changed =
    (requestedEffectiveAt !== undefined && isNowTime(requestedEffectiveAt)) ||
    !sameTimestampSecond(requested, current)
  const effectiveAt = changed ? assertCreatableNoteEffectiveTime(requested, timestamp) : current
  if (
    status === NOTE_STATUSES.COMPLETED &&
    effectiveAt > timestamp &&
    requestedStatus !== NOTE_STATUSES.PENDING
  ) {
    throw new Error('改为未来预约需明确取消完成并选择未开始')
  }
  const nextStatus = resolveRequestedStatus(
    requestedStatus === undefined && effectiveAt <= timestamp ? status : requestedStatus,
    effectiveAt,
    timestamp
  )
  if (
    nextStatus === NOTE_STATUSES.COMPLETED &&
    status === NOTE_STATUSES.COMPLETED &&
    requestedFinishedAt === undefined &&
    isNowTime(currentFinishedAt)
  ) {
    throw new Error('这条已完成便签缺少完成时间，请明确设置完成时间')
  }
  const finishedAt =
    nextStatus === NOTE_STATUSES.COMPLETED
      ? resolveCompletionTime(
          requestedFinishedAt === undefined && status === NOTE_STATUSES.COMPLETED
            ? currentFinishedAt
            : requestedFinishedAt,
          effectiveAt,
          timestamp
        )
      : status === NOTE_STATUSES.COMPLETED
        ? null
        : status !== nextStatus
          ? timestamp
          : currentFinishedAt
  return {
    status: nextStatus,
    effectiveAt,
    notifyEnabled:
      nextStatus === NOTE_STATUSES.PENDING &&
      (requestedNotifyEnabled ?? Boolean(currentNotifyEnabled))
        ? 1
        : 0,
    finishedAt
  }
}
