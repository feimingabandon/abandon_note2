import {
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
  assertCalendarYearMonth,
  parseDateKey
} from './calendar-date-rules.js'

export const HOLIDAY_DATA_SCHEMA_VERSION = 1
export const HOLIDAY_JSON_MAX_BYTES = 2 * 1024 * 1024
export const HOLIDAY_DOWNLOAD_BASE_URL = 'https://cdn.jsdelivr.net/npm/chinese-days/dist/years'

const COLLECTION_NAMES = Object.freeze(['holidays', 'workdays', 'inLieuDays'])
const MAX_DESCRIPTION_LENGTH = 300
const MAX_ENTRY_COUNT = 50_000

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function createEmptyYearData() {
  return {
    holidays: Object.create(null),
    workdays: Object.create(null),
    inLieuDays: Object.create(null)
  }
}

function assertPayloadSize(text) {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes > HOLIDAY_JSON_MAX_BYTES) throw new Error('节假日 JSON 不能超过 2MB')
}

/** 返回官方按年份 JSON 地址；renderer 无权传入任意网址。 */
export function holidayDataDownloadUrl(year) {
  const normalizedYear = assertCalendarYearMonth(year, 1).year
  return `${HOLIDAY_DOWNLOAD_BASE_URL}/${normalizedYear}.json`
}

/**
 * 校验 chinese-days 完整或按年 JSON，并拆成相互独立的年份数据。
 * expectedYear 用于在线下载：响应中必须且只能包含请求的年份。
 */
export function normalizeHolidayDataset(input, { expectedYear = null } = {}) {
  let payload = input
  if (typeof input === 'string') {
    assertPayloadSize(input)
    try {
      payload = JSON.parse(input)
    } catch {
      throw new Error('无法解析节假日 JSON')
    }
  }
  if (!isPlainRecord(payload)) throw new Error('节假日 JSON 顶层必须是对象')

  const dataByYear = Object.create(null)
  let entryCount = 0
  for (const collectionName of COLLECTION_NAMES) {
    const collection = payload[collectionName]
    if (!isPlainRecord(collection)) {
      throw new Error(`节假日 JSON 缺少 ${collectionName} 对象`)
    }
    for (const [dateKey, rawDescription] of Object.entries(collection)) {
      entryCount += 1
      if (entryCount > MAX_ENTRY_COUNT) throw new Error('节假日 JSON 包含过多日期记录')
      const { year } = parseDateKey(dateKey)
      if (year < MIN_CALENDAR_YEAR || year > MAX_CALENDAR_YEAR) {
        throw new Error(`节假日日期年份必须在 ${MIN_CALENDAR_YEAR}~${MAX_CALENDAR_YEAR} 之间`)
      }
      if (typeof rawDescription !== 'string') throw new Error(`${dateKey} 的节假日说明必须是文字`)
      const description = rawDescription.trim()
      if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
        throw new Error(`${dateKey} 的节假日说明为空或过长`)
      }
      const yearKey = String(year)
      dataByYear[yearKey] ||= createEmptyYearData()
      dataByYear[yearKey][collectionName][dateKey] = description
    }
  }

  const years = Object.keys(dataByYear)
    .map(Number)
    .sort((left, right) => left - right)
  if (!years.length) throw new Error('节假日 JSON 中没有可用年份')
  for (const year of years) {
    const yearData = dataByYear[String(year)]
    if (!Object.keys(yearData.holidays).length) {
      throw new Error(`${year} 年没有法定节假日记录`)
    }
    for (const dateKey of Object.keys(yearData.workdays)) {
      if (yearData.holidays[dateKey]) throw new Error(`${dateKey} 不能同时是休息日和调班工作日`)
    }
    for (const dateKey of Object.keys(yearData.inLieuDays)) {
      if (!yearData.holidays[dateKey]) throw new Error(`${dateKey} 的调休日没有对应休息日记录`)
    }
  }

  if (expectedYear !== null) {
    const normalizedExpectedYear = assertCalendarYearMonth(expectedYear, 1).year
    if (years.length !== 1 || years[0] !== normalizedExpectedYear) {
      throw new Error(`下载内容不是 ${normalizedExpectedYear} 年节假日数据`)
    }
  }

  return { years, dataByYear }
}

export function holidayNameFromDescription(description) {
  const parts = String(description || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts[1] || parts[0] || '节假日'
}

/** 数据存在才返回休/班元数据；缺失年份自然返回 null，供月视图静默兜底。 */
export function holidayMetadataForDate(yearData, dateKey) {
  if (!yearData) return null
  if (yearData.workdays?.[dateKey]) {
    return {
      type: 'work',
      name: holidayNameFromDescription(yearData.workdays[dateKey]),
      inLieu: false
    }
  }
  if (yearData.holidays?.[dateKey]) {
    return {
      type: 'off',
      name: holidayNameFromDescription(yearData.holidays[dateKey]),
      inLieu: Boolean(yearData.inLieuDays?.[dateKey])
    }
  }
  return null
}
