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

function sameTimestampSecond(left, right) {
  return Math.floor(Number(left) / 1000) === Math.floor(Number(right) / 1000)
}

/**
 * 派生统一保存所需的时间、状态和提醒字段。
 * renderer 只提交草稿，状态变化始终由主进程按时间关系决定。
 */
export function resolveNoteDraftSchedule({
  status,
  currentEffectiveAt,
  currentNotifyEnabled = 0,
  currentFinishedAt,
  requestedEffectiveAt,
  requestedNotifyEnabled = false,
  currentTime = Date.now()
}) {
  const timestamp = Number(currentTime)
  const current = Number(currentEffectiveAt)
  const requested = Number(requestedEffectiveAt)
  if (!Number.isFinite(timestamp) || !Number.isFinite(current) || current <= 0) {
    throw new Error('生效时间无效')
  }
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error('请选择有效的生效时间')
  }

  const changed = !sameTimestampSecond(requested, current)
  if (status === 'completed') {
    if (changed) throw new Error('已完成便签的生效时间不可修改')
    return {
      status,
      effectiveAt: current,
      notifyEnabled: currentNotifyEnabled ? 1 : 0,
      finishedAt: currentFinishedAt
    }
  }

  if (status === 'in_progress') {
    if (changed && requested > timestamp) {
      throw new Error('进行中便签的生效时间只能修正为当前或过去时间')
    }
    return {
      status,
      effectiveAt: changed ? requested : current,
      notifyEnabled: 0,
      finishedAt: currentFinishedAt
    }
  }

  if (status !== 'initialized') throw new Error(`不支持的便签状态：${status}`)

  const effectiveAt = changed ? assertCreatableNoteEffectiveTime(requested, timestamp) : current
  if (effectiveAt <= timestamp) {
    return {
      status: 'in_progress',
      effectiveAt,
      notifyEnabled: 0,
      finishedAt: timestamp
    }
  }

  return {
    status,
    effectiveAt,
    notifyEnabled: requestedNotifyEnabled ? 1 : 0,
    finishedAt: currentFinishedAt
  }
}
