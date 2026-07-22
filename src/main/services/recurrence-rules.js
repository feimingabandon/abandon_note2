/** 纯函数循环规则计算器；全部按系统本地日历计算，不依赖数据库或 Electron。 */

const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly'])
const DAY_MS = 86_400_000
export const MAX_DAILY_INTERVAL = 3650

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
}

function parseTimeOfDay(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''))
  if (!match) throw new Error('time_of_day 必须使用 HH:mm 格式')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error('time_of_day 必须是有效时间')
  return {
    hour,
    minute,
    value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }
}

function normalizeIntegerArray(value, min, max, fieldName) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${fieldName} 至少需要一项`)
  const normalized = value.map(Number)
  if (normalized.some((item) => !Number.isInteger(item) || item < min || item > max)) {
    throw new Error(`${fieldName} 包含无效值`)
  }
  return [...new Set(normalized)].sort((a, b) => a - b)
}

/** 严格校验并规范化循环规则。 */
export function normalizeRecurrenceRule(input) {
  let rule = input
  if (typeof input === 'string') {
    try {
      rule = JSON.parse(input)
    } catch {
      throw new Error('recurrenceRule 必须是合法 JSON')
    }
  }
  assertObject(rule, 'recurrenceRule 必须是对象')
  if (!FREQUENCIES.has(rule.frequency))
    throw new Error('frequency 必须是 daily、weekly、monthly 或 yearly')

  const time = parseTimeOfDay(rule.time_of_day)
  const normalized = {
    frequency: rule.frequency,
    interval: 1,
    days_of_week: [],
    days_of_month: [],
    dates_of_year: [],
    time_of_day: time.value
  }

  if (rule.frequency === 'daily') {
    const interval = Number(rule.interval ?? 1)
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_DAILY_INTERVAL) {
      throw new Error(`interval 必须是 1 到 ${MAX_DAILY_INTERVAL} 之间的整数`)
    }
    normalized.interval = interval
  } else if (rule.frequency === 'weekly') {
    normalized.days_of_week = normalizeIntegerArray(rule.days_of_week, 1, 7, 'days_of_week')
  } else if (rule.frequency === 'monthly') {
    normalized.days_of_month = normalizeIntegerArray(rule.days_of_month, 1, 31, 'days_of_month')
  } else {
    if (!Array.isArray(rule.dates_of_year) || rule.dates_of_year.length === 0) {
      throw new Error('dates_of_year 至少需要一项')
    }
    const keyed = new Map()
    for (const date of rule.dates_of_year) {
      assertObject(date, 'dates_of_year 包含无效日期')
      const month = Number(date.month)
      const day = Number(date.day)
      if (
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12 ||
        !Number.isInteger(day) ||
        day < 1 ||
        day > daysInMonth(2024, month)
      ) {
        throw new Error('dates_of_year 包含无效日期')
      }
      keyed.set(`${month}-${day}`, { month, day })
    }
    normalized.dates_of_year = [...keyed.values()].sort(
      (a, b) => a.month - b.month || a.day - b.day
    )
  }

  return normalized
}

export function serializeRecurrenceRule(rule) {
  return JSON.stringify(normalizeRecurrenceRule(rule))
}

export function isLeapYear(year) {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
}

export function daysInMonth(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('年份或月份无效')
  }
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function localDayNumber(date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

function atLocalTime(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function dailyNext(rule, after, anchor, hour, minute) {
  const elapsedDays = Math.max(0, localDayNumber(after) - localDayNumber(anchor))
  let offset = Math.floor(elapsedDays / rule.interval) * rule.interval
  while (true) {
    const candidateDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
    candidateDate.setDate(candidateDate.getDate() + offset)
    const candidate = atLocalTime(
      candidateDate.getFullYear(),
      candidateDate.getMonth() + 1,
      candidateDate.getDate(),
      hour,
      minute
    )
    if (!Number.isFinite(candidate)) throw new Error('无法计算下一次每日生成时间')
    if (candidate > after.getTime()) return candidate
    offset += rule.interval
  }
}

function weeklyNext(rule, after, hour, minute) {
  for (let offset = 0; offset <= 14; offset += 1) {
    const date = new Date(after.getFullYear(), after.getMonth(), after.getDate())
    date.setDate(date.getDate() + offset)
    const weekday = date.getDay() === 0 ? 7 : date.getDay()
    if (!rule.days_of_week.includes(weekday)) continue
    const candidate = atLocalTime(
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      hour,
      minute
    )
    if (candidate > after.getTime()) return candidate
  }
  throw new Error('无法计算下一次每周生成时间')
}

function monthlyNext(rule, after, hour, minute) {
  for (let monthOffset = 0; monthOffset <= 24; monthOffset += 1) {
    const monthBase = new Date(after.getFullYear(), after.getMonth() + monthOffset, 1)
    const year = monthBase.getFullYear()
    const month = monthBase.getMonth() + 1
    const maxDay = daysInMonth(year, month)
    const candidates = new Set(
      rule.days_of_month.map((configuredDay) =>
        atLocalTime(year, month, Math.min(configuredDay, maxDay), hour, minute)
      )
    )
    const next = [...candidates]
      .sort((a, b) => a - b)
      .find((candidate) => candidate > after.getTime())
    if (next !== undefined) return next
  }
  throw new Error('无法计算下一次每月生成时间')
}

function yearlyNext(rule, after, hour, minute) {
  for (let yearOffset = 0; yearOffset <= 12; yearOffset += 1) {
    const year = after.getFullYear() + yearOffset
    const candidates = new Set(
      rule.dates_of_year.map(({ month, day }) =>
        atLocalTime(year, month, Math.min(day, daysInMonth(year, month)), hour, minute)
      )
    )
    const next = [...candidates]
      .sort((a, b) => a - b)
      .find((candidate) => candidate > after.getTime())
    if (next !== undefined) return next
  }
  throw new Error('无法计算下一次每年生成时间')
}

/**
 * 计算 afterTimestamp 之后的第一个规则节点（严格大于）。
 * 日间隔以 anchorTimestamp 的本地日历日为锚点；暂停/恢复时传入新的锚点即可重新起算。
 */
export function calculateNextRun(ruleInput, afterTimestamp, anchorTimestamp = afterTimestamp) {
  const rule = normalizeRecurrenceRule(ruleInput)
  const after = new Date(Number(afterTimestamp))
  const anchor = new Date(Number(anchorTimestamp))
  if (Number.isNaN(after.getTime()) || Number.isNaN(anchor.getTime()))
    throw new Error('时间锚点无效')
  const { hour, minute } = parseTimeOfDay(rule.time_of_day)

  if (rule.frequency === 'daily') return dailyNext(rule, after, anchor, hour, minute)
  if (rule.frequency === 'weekly') return weeklyNext(rule, after, hour, minute)
  if (rule.frequency === 'monthly') return monthlyNext(rule, after, hour, minute)
  return yearlyNext(rule, after, hour, minute)
}
