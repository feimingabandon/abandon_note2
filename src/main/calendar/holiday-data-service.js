import { app } from 'electron'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import {
  HOLIDAY_DATA_SCHEMA_VERSION,
  HOLIDAY_JSON_MAX_BYTES,
  holidayDataDownloadUrl,
  holidayMetadataForDate,
  normalizeHolidayDataset
} from '../../shared/calendar/holiday-data-rules.js'
import { assertCalendarYearMonth, parseDateKey } from '../../shared/calendar/calendar-date-rules.js'

const require = createRequire(import.meta.url)
const STORAGE_DIRECTORY = 'calendar-data'
const STORAGE_FILE = 'holiday-overrides.json'
const STORE_SCHEMA_VERSION = 1
const DOWNLOAD_TIMEOUT_MS = 12_000

let bundledDataCache = null
let customStoreCache = null
let mutationQueue = Promise.resolve()

function storageDirectory() {
  const userDataPath = app?.getPath?.('userData')
  return userDataPath ? join(userDataPath, STORAGE_DIRECTORY) : null
}

function storagePath() {
  const directory = storageDirectory()
  return directory ? join(directory, STORAGE_FILE) : null
}

function createEmptyStore() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    dismissedMissingYears: [],
    years: Object.create(null)
  }
}

function loadBundledData() {
  if (bundledDataCache) return bundledDataCache
  const jsonPath = require.resolve('chinese-days/dist/chinese-days.json')
  const normalized = normalizeHolidayDataset(readFileSync(jsonPath, 'utf8'))
  const packageInfo = require('chinese-days/package.json')
  bundledDataCache = {
    ...normalized,
    version: String(packageInfo.version || '未知')
  }
  return bundledDataCache
}

function sanitizeStoredRecord(year, record) {
  if (!record || typeof record !== 'object') return null
  try {
    const normalized = normalizeHolidayDataset(record.data, { expectedYear: year })
    return {
      source: record.source === 'download' ? 'download' : 'import',
      sourceName: String(record.sourceName || ''),
      sourceUrl: String(record.sourceUrl || ''),
      updatedAt: Number(record.updatedAt) || 0,
      data: normalized.dataByYear[String(year)]
    }
  } catch (error) {
    console.warn(`[calendar] 忽略损坏的 ${year} 年自定义节假日数据:`, error)
    return null
  }
}

function loadCustomStore() {
  if (customStoreCache) return customStoreCache
  const store = createEmptyStore()
  const path = storagePath()
  if (!path || !existsSync(path)) {
    customStoreCache = store
    return store
  }
  try {
    const payload = JSON.parse(readFileSync(path, 'utf8'))
    if (payload?.schemaVersion !== STORE_SCHEMA_VERSION) throw new Error('不支持的数据版本')
    store.dismissedMissingYears = Array.isArray(payload.dismissedMissingYears)
      ? [...new Set(payload.dismissedMissingYears.map(Number).filter(Number.isInteger))]
      : []
    for (const [yearKey, record] of Object.entries(payload.years || {})) {
      const year = Number(yearKey)
      if (!Number.isInteger(year)) continue
      const sanitized = sanitizeStoredRecord(year, record)
      if (sanitized) store.years[String(year)] = sanitized
    }
  } catch (error) {
    console.warn('[calendar] 自定义节假日数据损坏，已回退内置数据:', error)
  }
  customStoreCache = store
  return store
}

async function persistStore(store) {
  const directory = storageDirectory()
  if (!directory) throw new Error('当前运行环境无法访问用户数据目录')
  await mkdir(directory, { recursive: true })
  const targetPath = storagePath()
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, JSON.stringify(store), 'utf8')
  await rename(temporaryPath, targetPath)
  customStoreCache = store
}

function enqueueMutation(operation) {
  const result = mutationQueue.then(operation)
  mutationQueue = result.catch((error) => {
    console.error('[calendar] 节假日数据变更失败:', error)
  })
  return result
}

function recordForYear(year) {
  const normalizedYear = assertCalendarYearMonth(year, 1).year
  const custom = loadCustomStore().years[String(normalizedYear)]
  if (custom) return { ...custom, year: normalizedYear }
  const bundled = loadBundledData()
  const data = bundled.dataByYear[String(normalizedYear)]
  return data
    ? {
        year: normalizedYear,
        source: 'built-in',
        sourceName: `chinese-days ${bundled.version}`,
        sourceUrl: '',
        updatedAt: 0,
        data
      }
    : null
}

function coveredYears() {
  const bundledYears = loadBundledData().years
  const customYears = Object.keys(loadCustomStore().years).map(Number)
  return [...new Set([...bundledYears, ...customYears])].sort((left, right) => left - right)
}

export function getHolidayDataStatus(year = new Date().getFullYear()) {
  const normalizedYear = assertCalendarYearMonth(year, 1).year
  const record = recordForYear(normalizedYear)
  const customYears = Object.keys(loadCustomStore().years)
    .map(Number)
    .sort((left, right) => left - right)
  return {
    schemaVersion: HOLIDAY_DATA_SCHEMA_VERSION,
    year: normalizedYear,
    available: Boolean(record),
    source: record?.source || null,
    sourceName: record?.sourceName || '',
    updatedAt: record?.updatedAt || null,
    coveredYears: coveredYears(),
    customYears,
    downloadUrl: holidayDataDownloadUrl(normalizedYear)
  }
}

export function getHolidayMetadata(dateKey) {
  const { year } = parseDateKey(dateKey)
  return holidayMetadataForDate(recordForYear(year)?.data, dateKey)
}

async function saveNormalizedDataset(normalized, { source, sourceName = '', sourceUrl = '' }) {
  const store = loadCustomStore()
  const nextStore = {
    schemaVersion: STORE_SCHEMA_VERSION,
    dismissedMissingYears: [...store.dismissedMissingYears],
    years: { ...store.years }
  }
  const updatedAt = Date.now()
  for (const year of normalized.years) {
    nextStore.years[String(year)] = {
      source,
      sourceName,
      sourceUrl,
      updatedAt,
      data: normalized.dataByYear[String(year)]
    }
    nextStore.dismissedMissingYears = nextStore.dismissedMissingYears.filter(
      (dismissedYear) => dismissedYear !== year
    )
  }
  await persistStore(nextStore)
  return {
    importedYears: normalized.years,
    status: getHolidayDataStatus(new Date().getFullYear())
  }
}

export function importHolidayDataFile(filePath) {
  return enqueueMutation(async () => {
    const fileInfo = await stat(filePath)
    if (!fileInfo.isFile()) throw new Error('请选择一个 JSON 文件')
    if (fileInfo.size > HOLIDAY_JSON_MAX_BYTES) throw new Error('节假日 JSON 不能超过 2MB')
    const text = await readFile(filePath, 'utf8')
    const normalized = normalizeHolidayDataset(text)
    return saveNormalizedDataset(normalized, {
      source: 'import',
      sourceName: basename(filePath)
    })
  })
}

export function downloadHolidayData(year = new Date().getFullYear(), fetchImpl = globalThis.fetch) {
  return enqueueMutation(async () => {
    const normalizedYear = assertCalendarYearMonth(year, 1).year
    const url = holidayDataDownloadUrl(normalizedYear)
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `Abandon-Note/${app?.getVersion?.() || 'unknown'}`
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > HOLIDAY_JSON_MAX_BYTES) {
      throw new Error('下载的节假日 JSON 超过 2MB')
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > HOLIDAY_JSON_MAX_BYTES) throw new Error('下载的节假日 JSON 超过 2MB')
    const normalized = normalizeHolidayDataset(buffer.toString('utf8'), {
      expectedYear: normalizedYear
    })
    return saveNormalizedDataset(normalized, {
      source: 'download',
      sourceName: `${normalizedYear}.json`,
      sourceUrl: url
    })
  })
}

export function getMissingHolidayDataNotice(year = new Date().getFullYear()) {
  const status = getHolidayDataStatus(year)
  const dismissed = loadCustomStore().dismissedMissingYears.includes(status.year)
  return {
    required: !status.available && !dismissed,
    year: status.year,
    status
  }
}

export function dismissMissingHolidayDataNotice(year) {
  return enqueueMutation(async () => {
    const normalizedYear = assertCalendarYearMonth(year, 1).year
    const store = loadCustomStore()
    if (store.dismissedMissingYears.includes(normalizedYear)) return true
    await persistStore({
      schemaVersion: STORE_SCHEMA_VERSION,
      dismissedMissingYears: [...store.dismissedMissingYears, normalizedYear].sort(
        (left, right) => left - right
      ),
      years: { ...store.years }
    })
    return true
  })
}

/** 仅供单元测试在切换 Electron userData 后清理进程内缓存。 */
export function resetHolidayDataCachesForTests() {
  bundledDataCache = null
  customStoreCache = null
  mutationQueue = Promise.resolve()
}
