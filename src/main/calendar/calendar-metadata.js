import chineseDays from 'chinese-days'
import { addCalendarDays } from '../../shared/calendar/calendar-date-rules.js'
import { getHolidayMetadata } from './holiday-data-service.js'
import { calendarFestivalsForDate } from './calendar-festivals.js'

function usableLunarDate(lunar) {
  return Boolean(
    lunar &&
    Number.isInteger(lunar.lunarYear) &&
    Number.isInteger(lunar.lunarMon) &&
    lunar.lunarMon >= 1 &&
    lunar.lunarMon <= 12 &&
    Number.isInteger(lunar.lunarDay) &&
    lunar.lunarDay >= 1 &&
    lunar.lunarDay <= 30 &&
    typeof lunar.lunarMonCN === 'string' &&
    !lunar.lunarMonCN.includes('undefined') &&
    typeof lunar.lunarDayCN === 'string' &&
    !lunar.lunarDayCN.includes('undefined')
  )
}

/** 使用 chinese-days 为指定连续日期范围生成农历、节气、节日与法定休假元数据。 */
export function buildCalendarDayMetadata(monthStart, monthEnd) {
  const lunarByDate = new Map(
    chineseDays.getLunarDatesInRange(monthStart, monthEnd).map((item) => [item.date, item])
  )
  const solarTermByDate = new Map(
    chineseDays.getSolarTerms(monthStart, monthEnd).map((item) => [item.date, item.name])
  )
  const coldFoodDates = new Set(
    [...solarTermByDate].flatMap(([dateKey, name]) =>
      name === '清明' ? [addCalendarDays(dateKey, -1)] : []
    )
  )
  const result = new Map()
  for (let dateKey = monthStart; dateKey <= monthEnd; dateKey = addCalendarDays(dateKey, 1)) {
    const rawLunar = lunarByDate.get(dateKey)
    const lunar = usableLunarDate(rawLunar) ? rawLunar : null
    const solarTerm = solarTermByDate.get(dateKey) || null
    const festivals = calendarFestivalsForDate({
      dateKey,
      lunar: lunar
        ? {
            ...lunar,
            daysInMonth: chineseDays.monthDays(lunar.lunarYear, lunar.lunarMon)
          }
        : null,
      solarTerm,
      isColdFoodDay: coldFoodDates.has(dateKey)
    })
    const festival = festivals[0]?.label || null
    const festivalLabel = festivals
      .slice(0, 2)
      .map((item) => item.label)
      .join('/')
    const lunarLabel = lunar ? (lunar.lunarDay === 1 ? lunar.lunarMonCN : lunar.lunarDayCN) : null
    const detailParts = [festivals.map((item) => item.name).join('、')]
    if (
      solarTerm &&
      !festivals.some((item) => item.label === solarTerm || item.name.startsWith(solarTerm))
    ) {
      detailParts.push(solarTerm)
    }
    if (lunar) detailParts.push(`农历${lunar.lunarMonCN}${lunar.lunarDayCN}`)
    result.set(dateKey, {
      lunar: lunar
        ? {
            year: lunar.lunarYear,
            month: lunar.lunarMon,
            day: lunar.lunarDay,
            isLeap: lunar.isLeap,
            monthText: lunar.lunarMonCN,
            dayText: lunar.lunarDayCN
          }
        : null,
      solarTerm,
      festival,
      festivalType: festivals[0]?.category || null,
      festivals,
      hasPublicHolidayFestival: festivals.some((item) => item.isPublicHoliday),
      displayLabel: festivalLabel || solarTerm || lunarLabel,
      detailLabel: detailParts.filter(Boolean).join(' · '),
      holiday: getHolidayMetadata(dateKey)
    })
  }
  return result
}
