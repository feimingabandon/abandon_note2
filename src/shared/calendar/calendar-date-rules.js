export const MIN_CALENDAR_YEAR = 1900
export const MAX_CALENDAR_YEAR = 2100
export const MIN_CALENDAR_DATE = `${MIN_CALENDAR_YEAR}-01-01`
export const MAX_CALENDAR_DATE = `${MAX_CALENDAR_YEAR}-12-31`
export const CALENDAR_COLUMN_COUNT = 7
export const CALENDAR_ROW_COUNT = 6
export const CALENDAR_CELL_COUNT = CALENDAR_COLUMN_COUNT * CALENDAR_ROW_COUNT
export const WEEK_CALENDAR_CELL_COUNT = CALENDAR_COLUMN_COUNT

function pad(value) {
  return String(value).padStart(2, '0')
}

export function assertCalendarYearMonth(year, month) {
  const normalizedYear = Number(year)
  const normalizedMonth = Number(month)
  if (
    !Number.isInteger(normalizedYear) ||
    normalizedYear < MIN_CALENDAR_YEAR ||
    normalizedYear > MAX_CALENDAR_YEAR
  ) {
    throw new Error(`年份必须在 ${MIN_CALENDAR_YEAR}~${MAX_CALENDAR_YEAR} 之间`)
  }
  if (!Number.isInteger(normalizedMonth) || normalizedMonth < 1 || normalizedMonth > 12) {
    throw new Error('月份必须在 1~12 之间')
  }
  return { year: normalizedYear, month: normalizedMonth }
}

export function dateKeyFromParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
}

export function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''))
  if (!match) throw new Error('日期格式必须为 YYYY-MM-DD')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error('日期不存在')
  }
  return { year, month, day }
}

export function dateOrdinalFromParts(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

export function dateOrdinal(dateKey) {
  const { year, month, day } = parseDateKey(dateKey)
  return dateOrdinalFromParts(year, month, day)
}

export function dateKeyFromOrdinal(ordinal) {
  const date = new Date(Number(ordinal) * 86_400_000)
  return dateKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

export function addCalendarDays(dateKey, amount) {
  return dateKeyFromOrdinal(dateOrdinal(dateKey) + Math.trunc(Number(amount) || 0))
}

export function localDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(Number(value))
  if (Number.isNaN(date.getTime())) throw new Error('无效时间')
  return dateKeyFromParts(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

export function localMidnightTimestamp(dateKey) {
  const { year, month, day } = parseDateKey(dateKey)
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
}

export function combineLocalDateAndTime(dateKey, timeValue) {
  const { year, month, day } = parseDateKey(dateKey)
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeValue || ''))
  if (!match) throw new Error('时间格式必须为 HH:mm')
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] || 0)
  if (hour > 23 || minute > 59 || second > 59) throw new Error('时间超出有效范围')
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

function buildCalendarRangeDays(startKey, count, isInCurrentMonth = () => true) {
  return Array.from({ length: count }, (_, index) => {
    const key = addCalendarDays(startKey, index)
    const { year, month, day } = parseDateKey(key)
    const weekday = index % CALENDAR_COLUMN_COUNT
    return {
      key,
      year,
      month,
      day,
      weekday,
      weekIndex: Math.floor(index / CALENDAR_COLUMN_COUNT),
      columnIndex: weekday,
      inCurrentMonth: isInCurrentMonth({ year, month, day, key }),
      metadata: {}
    }
  })
}

export function buildMonthGrid(year, month) {
  const normalized = assertCalendarYearMonth(year, month)
  const first = new Date(normalized.year, normalized.month - 1, 1)
  const last = new Date(normalized.year, normalized.month, 0)
  const mondayOffset = (first.getDay() + 6) % 7
  const visibleStartDate = new Date(normalized.year, normalized.month - 1, 1 - mondayOffset)
  const visibleStart = dateKeyFromParts(
    visibleStartDate.getFullYear(),
    visibleStartDate.getMonth() + 1,
    visibleStartDate.getDate()
  )
  const days = buildCalendarRangeDays(
    visibleStart,
    CALENDAR_CELL_COUNT,
    ({ year: dayYear, month: dayMonth }) =>
      dayYear === normalized.year && dayMonth === normalized.month
  )
  days.forEach((day) => {
    day.isActive = day.inCurrentMonth
  })
  return {
    ...normalized,
    monthStart: dateKeyFromParts(normalized.year, normalized.month, 1),
    monthEnd: dateKeyFromParts(normalized.year, normalized.month, last.getDate()),
    visibleStart: days[0].key,
    visibleEnd: days[days.length - 1].key,
    days
  }
}

/** 根据锚点日期生成周一至周日的完整周历网格。 */
export function buildWeekGrid(anchorDate) {
  const parsedAnchor = parseDateKey(anchorDate)
  const normalizedAnchor = dateKeyFromParts(parsedAnchor.year, parsedAnchor.month, parsedAnchor.day)
  const anchorOrdinal = dateOrdinal(normalizedAnchor)
  // 1970-01-01 为周四；+3 后取模可得到周一为 0 的列序号。
  const mondayOffset = (((anchorOrdinal + 3) % CALENDAR_COLUMN_COUNT) + CALENDAR_COLUMN_COUNT) % 7
  const weekStart = dateKeyFromOrdinal(anchorOrdinal - mondayOffset)
  const weekEnd = addCalendarDays(weekStart, WEEK_CALENDAR_CELL_COUNT - 1)
  if (weekEnd < MIN_CALENDAR_DATE || weekStart > MAX_CALENDAR_DATE) {
    throw new Error(`周范围必须与 ${MIN_CALENDAR_DATE}~${MAX_CALENDAR_DATE} 相交`)
  }
  const days = buildCalendarRangeDays(weekStart, WEEK_CALENDAR_CELL_COUNT).map((day) => ({
    ...day,
    // 周视图跨月日期也属于当前有效范围；保留该字段以兼容共用日期格。
    inCurrentMonth: true,
    isActive: true
  }))

  return {
    anchorDate: normalizedAnchor,
    weekStart,
    weekEnd,
    visibleStart: weekStart,
    visibleEnd: weekEnd,
    days
  }
}

export function noteDateRange(note) {
  const startKey = localDateKey(note?.effective_at)
  const durationDays = Math.min(365, Math.max(1, Math.trunc(Number(note?.duration_days) || 1)))
  return {
    startKey,
    endKey: addCalendarDays(startKey, durationDays - 1),
    startOrdinal: dateOrdinal(startKey),
    endOrdinal: dateOrdinal(startKey) + durationDays - 1,
    durationDays
  }
}
