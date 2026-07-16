/** 纯函数循环规则计算器；不依赖 Electron 或数据库，便于独立验证。 */
export function shouldGenerate(rule, lastGeneratedAt, now) {
  if (!rule || typeof rule !== 'object') return { should: false, effectiveAt: null }
  const parsedInterval = Number(rule.interval)
  const interval =
    rule.frequency === 'every_other_day'
      ? 2
      : Number.isInteger(parsedInterval) && parsedInterval > 0
        ? parsedInterval
        : 1
  if (
    (rule.frequency === 'daily' || rule.frequency === 'every_other_day') &&
    interval > 1 &&
    lastGeneratedAt !== null &&
    lastGeneratedAt !== undefined &&
    Number.isFinite(Number(lastGeneratedAt))
  ) {
    const scheduledAt = calcIntervalFromAnchor(rule, Number(lastGeneratedAt), now, interval)
    return {
      should: scheduledAt !== null && scheduledAt > Number(lastGeneratedAt),
      effectiveAt: scheduledAt
    }
  }

  const scheduledAt = calcMostRecentScheduledTime(rule, now)
  if (scheduledAt === null) return { should: false, effectiveAt: null }
  if (lastGeneratedAt === null) return { should: true, effectiveAt: scheduledAt }
  return { should: scheduledAt > lastGeneratedAt, effectiveAt: scheduledAt }
}

function calcIntervalFromAnchor(rule, anchorTimestamp, now, interval) {
  const anchor = new Date(anchorTimestamp)
  const current = new Date(now)
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(current.getTime())) return null

  const [hour, minute] = String(rule.time_of_day || '00:00').split(':').map(Number)
  if (!validTime(hour, minute)) return null

  const anchorDay = Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
  const currentDay = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate())
  const elapsedDays = Math.floor((currentDay - anchorDay) / 86_400_000)
  if (elapsedDays < interval) return anchorTimestamp

  let completedIntervals = Math.floor(elapsedDays / interval)
  const candidate = new Date(anchor)
  setIntervalCandidate(candidate, anchor, completedIntervals, interval, hour, minute)
  if (candidate.getTime() > now) {
    completedIntervals -= 1
    if (completedIntervals < 1) return anchorTimestamp
    setIntervalCandidate(candidate, anchor, completedIntervals, interval, hour, minute)
  }
  return candidate.getTime()
}

function setIntervalCandidate(candidate, anchor, completedIntervals, interval, hour, minute) {
  candidate.setTime(anchor.getTime())
  candidate.setDate(anchor.getDate() + completedIntervals * interval)
  candidate.setHours(hour, minute, 0, 0)
}

function validTime(hour, minute) {
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59
}

export function calcMostRecentScheduledTime(rule, now) {
  if (!rule || typeof rule !== 'object' || !Number.isFinite(Number(now))) return null
  const [hour, minute] = String(rule.time_of_day || '00:00').split(':').map(Number)
  if (!validTime(hour, minute)) return null
  switch (rule.frequency) {
    case 'daily':
    case 'every_other_day':
      return calcDaily(now, hour, minute)
    case 'weekly':
      return calcWeekly(now, hour, minute, rule.days_of_week || [])
    case 'monthly':
      return calcMonthly(now, hour, minute, rule.days_of_month || [])
    default:
      return null
  }
}

function calcDaily(now, hour, minute) {
  const candidate = new Date(now)
  candidate.setHours(hour, minute, 0, 0)
  if (candidate.getTime() > now) candidate.setDate(candidate.getDate() - 1)
  return candidate.getTime()
}

function calcWeekly(now, hour, minute, daysOfWeek) {
  const validDays = daysOfWeek.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  if (!validDays.length) return null
  const candidate = new Date(now)
  candidate.setHours(hour, minute, 0, 0)
  for (let offset = 0; offset < 7; offset += 1) {
    const day = candidate.getDay() === 0 ? 7 : candidate.getDay()
    if (validDays.includes(day) && candidate.getTime() <= now) return candidate.getTime()
    candidate.setDate(candidate.getDate() - 1)
  }
  return null
}

function calcMonthly(now, hour, minute, daysOfMonth) {
  const validDays = daysOfMonth.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 31)
  if (!validDays.length) return null
  const current = new Date(now)
  current.setHours(hour, minute, 0, 0)
  for (let monthOffset = 0; monthOffset < 2; monthOffset += 1) {
    const year = current.getFullYear()
    const month = current.getMonth()
    for (const day of [...validDays].sort((a, b) => b - a)) {
      const maxDay = new Date(year, month + 1, 0).getDate()
      const candidate = new Date(year, month, Math.min(day, maxDay), hour, minute, 0, 0)
      if (candidate.getTime() <= now) return candidate.getTime()
    }
    current.setDate(1)
    current.setMonth(current.getMonth() - 1)
  }
  return null
}
