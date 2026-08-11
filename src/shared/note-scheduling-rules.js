export const MIN_SCHEDULE_LEAD_TIME_MINUTES = 2
export const MIN_SCHEDULE_LEAD_TIME_MS = MIN_SCHEDULE_LEAD_TIME_MINUTES * 60 * 1000
export const SCHEDULE_SHORTCUT_SAFETY_MARGIN_MS = 60 * 1000

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
