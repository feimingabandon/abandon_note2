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
  if (String(dateKey) > String(todayKey)) {
    const [year, month, day] = String(dateKey).split('-').map(Number)
    const [hour, minute] = DEFAULT_NEW_NOTE_SCHEDULE_TIME.split(':').map(Number)
    const defaultTimestamp = new Date(year, month - 1, day, hour, minute).getTime()
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
