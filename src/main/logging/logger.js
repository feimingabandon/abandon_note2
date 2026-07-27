import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import {
  appendFile as appendFileAsync,
  readFile as readFileAsync,
  writeFile as writeFileAsync
} from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, join, resolve } from 'path'
import { app } from 'electron'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_RECORD_BYTES = 512 * 1024
const MAX_VALUE_PREVIEW_BYTES = 160 * 1024
const MAX_PENDING_BYTES = 2 * 1024 * 1024
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const MAX_RENDERER_FIELD_LENGTH = 200_000
const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal'])
const LOG_FILE_PATTERN = /^app-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/

const originalConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}

let initialized = false
let consoleInstalled = false
let logDirectory = ''
let activeDate = ''
let activeFile = ''
let activePart = 0
let activeBytes = 0
let sequence = 0
let sessionId = randomUUID()
let flushHandle = null
let exitHookInstalled = false
let pendingWrites = []
let pendingBytes = 0
const recentFingerprints = new Map()

function localDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function serializeUnknown(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value === 'symbol') return String(value)
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (value instanceof Error) {
    const result = {
      name: value.name,
      message: value.message,
      stack: value.stack
    }
    if (value.code !== undefined) result.code = value.code
    if (value.cause !== undefined) result.cause = serializeUnknown(value.cause, seen)
    for (const key of Object.keys(value)) {
      if (!(key in result)) result[key] = serializeUnknown(value[key], seen)
    }
    return result
  }
  if (Array.isArray(value)) return value.map((item) => serializeUnknown(item, seen))
  const result = {}
  for (const [key, item] of Object.entries(value)) result[key] = serializeUnknown(item, seen)
  return result
}

function displayValue(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  try {
    return JSON.stringify(serializeUnknown(value))
  } catch {
    return String(value)
  }
}

function normalizeMessage(message, args) {
  return [message, ...args].map(displayValue).join(' ')
}

function cleanupLogs() {
  if (!logDirectory || !existsSync(logDirectory)) return
  const now = Date.now()
  const files = readdirSync(logDirectory)
    .filter((name) => LOG_FILE_PATTERN.test(name))
    .map((name) => {
      const path = join(logDirectory, name)
      const stat = statSync(path)
      return { name, path, size: stat.size, mtimeMs: stat.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  let total = 0
  for (const file of files) {
    total += file.size
    if (now - file.mtimeMs > RETENTION_MS || total > MAX_TOTAL_BYTES) {
      try {
        unlinkSync(file.path)
      } catch (error) {
        originalConsole.warn('[logging] 无法清理旧日志:', file.path, error)
      }
    }
  }
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0
}

function selectActiveFile(nextBytes) {
  const dateKey = localDateKey()
  if (dateKey !== activeDate) {
    activeDate = dateKey
    activePart = 0
    activeFile = join(logDirectory, `app-${dateKey}.jsonl`)
    activeBytes = fileSize(activeFile)
  }
  while (activeBytes > 0 && activeBytes + nextBytes > MAX_FILE_BYTES) {
    activePart += 1
    activeFile = join(logDirectory, `app-${dateKey}-${activePart}.jsonl`)
    activeBytes = fileSize(activeFile)
  }
  activeBytes += nextBytes
  return activeFile
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '')
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return `${buffer.subarray(0, maxBytes).toString('utf8')}…`
}

function compactValue(value, maxBytes = MAX_VALUE_PREVIEW_BYTES) {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  const bytes = Buffer.byteLength(serialized)
  if (bytes <= maxBytes) return value
  return {
    truncated: true,
    originalBytes: bytes,
    preview: truncateUtf8(serialized, maxBytes)
  }
}

function createBoundedLine(record) {
  const originalLine = `${JSON.stringify(record)}\n`
  const originalBytes = Buffer.byteLength(originalLine)
  if (originalBytes <= MAX_RECORD_BYTES) return originalLine

  const compacted = {
    ...record,
    message: truncateUtf8(record.message, 64 * 1024),
    error: compactValue(record.error),
    metadata: compactValue(record.metadata),
    truncation: { originalBytes }
  }
  const compactedLine = `${JSON.stringify(compacted)}\n`
  if (Buffer.byteLength(compactedLine) <= MAX_RECORD_BYTES) return compactedLine

  const fallback = {
    id: record.id,
    time: record.time,
    level: record.level,
    process: record.process,
    scope: truncateUtf8(record.scope, 16 * 1024),
    message: truncateUtf8(record.message, 64 * 1024),
    sessionId: truncateUtf8(record.sessionId, 4 * 1024),
    pid: Number.isSafeInteger(record.pid) ? record.pid : undefined,
    appVersion: truncateUtf8(record.appVersion, 1024),
    platform: truncateUtf8(record.platform, 128),
    arch: truncateUtf8(record.arch, 128),
    versions: {
      electron: truncateUtf8(record.versions?.electron, 1024),
      chrome: truncateUtf8(record.versions?.chrome, 1024),
      node: truncateUtf8(record.versions?.node, 1024)
    },
    windowRole: truncateUtf8(record.windowRole, 4 * 1024),
    webContentsId: Number.isSafeInteger(record.webContentsId) ? record.webContentsId : undefined,
    truncation: {
      originalBytes,
      payloadPreview: '',
      previewTruncated: true
    }
  }

  // JSON escaping can expand a string by several times, so a character or UTF-8
  // slice alone cannot guarantee the final JSONL record size. Find the largest
  // preview that keeps the complete encoded line inside the hard limit.
  let low = 0
  let high = originalLine.length
  let bestLine = `${JSON.stringify(fallback)}\n`
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    fallback.truncation.payloadPreview = originalLine.slice(0, middle)
    const candidate = `${JSON.stringify(fallback)}\n`
    if (Buffer.byteLength(candidate) <= MAX_RECORD_BYTES) {
      bestLine = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return bestLine
}

function scheduleFlush() {
  if (flushHandle) return
  flushHandle = setImmediate(() => {
    flushHandle = null
    flushLogs()
  })
}

export function flushLogs() {
  if (flushHandle) {
    clearImmediate(flushHandle)
    flushHandle = null
  }
  if (!pendingWrites.length) return
  const batch = pendingWrites
  pendingWrites = []
  pendingBytes = 0
  const writeBatches = []
  for (const item of batch) {
    const current = writeBatches.at(-1)
    if (current?.path === item.path) current.lines.push(item.line)
    else writeBatches.push({ path: item.path, lines: [item.line] })
  }
  for (const { path, lines } of writeBatches) {
    try {
      appendFileSync(path, lines.join(''), 'utf8')
    } catch (error) {
      originalConsole.error('[logging] 批量写入日志失败:', path, error)
    }
  }
}

function shouldSkipDuplicate(record, dedupeKey) {
  if (!dedupeKey) return false
  const now = Date.now()
  const fingerprint = `${record.level}|${record.process}|${record.scope}|${dedupeKey}`
  const previous = recentFingerprints.get(fingerprint)
  recentFingerprints.set(fingerprint, now)
  if (recentFingerprints.size > 500) {
    for (const [key, time] of recentFingerprints) {
      if (now - time > 10_000) recentFingerprints.delete(key)
    }
  }
  return previous !== undefined && now - previous < 300
}

export function initializeLogger() {
  if (initialized) return
  logDirectory = join(app.getPath('userData'), 'logs')
  mkdirSync(logDirectory, { recursive: true })
  cleanupLogs()
  initialized = true
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', flushLogs)
  }
}

export function getLogDirectory() {
  initializeLogger()
  return logDirectory
}

export function writeLog({
  level = 'info',
  process: processType = 'main',
  scope = 'application',
  message = '',
  error,
  metadata,
  windowRole,
  webContentsId,
  dedupeKey
}) {
  try {
    initializeLogger()
    const normalizedLevel = LEVELS.has(level) ? level : 'info'
    const normalizedError = error === undefined ? undefined : serializeUnknown(error)
    const record = {
      id: `${sessionId}-${++sequence}`,
      time: new Date().toISOString(),
      level: normalizedLevel,
      process: processType,
      scope,
      message: String(message || normalizedError?.message || ''),
      sessionId,
      pid: process.pid,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      }
    }
    if (windowRole) record.windowRole = windowRole
    if (webContentsId !== undefined) record.webContentsId = webContentsId
    if (normalizedError !== undefined) record.error = normalizedError
    if (metadata !== undefined) record.metadata = serializeUnknown(metadata)
    if (shouldSkipDuplicate(record, dedupeKey)) return null

    const line = createBoundedLine(record)
    const lineBytes = Buffer.byteLength(line)
    const path = selectActiveFile(lineBytes)
    pendingWrites.push({ path, line })
    pendingBytes += lineBytes
    if (normalizedLevel === 'fatal' || pendingBytes >= MAX_PENDING_BYTES) flushLogs()
    else scheduleFlush()
    return record.id
  } catch (writeError) {
    originalConsole.error('[logging] 写入日志失败:', writeError)
    return null
  }
}

function logAt(level, scope, message, metadata) {
  return writeLog({ level, scope, message, metadata })
}

export const logger = {
  debug: (scope, message, metadata) => logAt('debug', scope, message, metadata),
  info: (scope, message, metadata) => logAt('info', scope, message, metadata),
  warn: (scope, message, metadata) => logAt('warn', scope, message, metadata),
  error: (scope, error, metadata) =>
    writeLog({
      level: 'error',
      scope,
      message: error instanceof Error ? error.message : String(error),
      error,
      metadata
    }),
  fatal: (scope, error, metadata) =>
    writeLog({
      level: 'fatal',
      scope,
      message: error instanceof Error ? error.message : String(error),
      error,
      metadata
    })
}

export function installConsoleCapture() {
  if (consoleInstalled) return
  consoleInstalled = true
  for (const [method, level] of [
    ['debug', 'debug'],
    ['info', 'info'],
    ['log', 'info'],
    ['warn', 'warn'],
    ['error', 'error']
  ]) {
    console[method] = (message, ...args) => {
      originalConsole[method](message, ...args)
      writeLog({
        level,
        scope: 'console',
        message: normalizeMessage(message, args),
        error: [message, ...args].find((item) => item instanceof Error)
      })
    }
  }
}

function listLogFilesNewestFirst() {
  initializeLogger()
  return readdirSync(logDirectory)
    .filter((name) => LOG_FILE_PATTERN.test(name))
    .map((name) => {
      const path = join(logDirectory, name)
      const stat = statSync(path)
      return { name, path, size: stat.size, mtimeMs: stat.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
}

function recordMatches(record, query) {
  const levels = Array.isArray(query.levels) ? new Set(query.levels) : null
  const processes = Array.isArray(query.processes) ? new Set(query.processes) : null
  if (levels?.size && !levels.has(record.level)) return false
  if (processes?.size && !processes.has(record.process)) return false
  const search = String(query.search || '')
    .trim()
    .toLocaleLowerCase()
  if (!search) return true
  return JSON.stringify(record).toLocaleLowerCase().includes(search)
}

function encodeCursor(snapshot, offset) {
  return Buffer.from(JSON.stringify({ version: 1, snapshot, offset }), 'utf8').toString('base64url')
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (decoded?.version !== 1 || !Array.isArray(decoded.snapshot)) return null
    if (decoded.snapshot.length > 100) return null
    let totalSize = 0
    const snapshot = decoded.snapshot.map((file) => {
      if (!LOG_FILE_PATTERN.test(file?.name)) throw new Error('非法日志文件名')
      const size = Number(file.size)
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TOTAL_BYTES) {
        throw new Error('非法日志快照大小')
      }
      totalSize += size
      if (totalSize > MAX_TOTAL_BYTES) throw new Error('日志快照总量过大')
      return { name: file.name, size }
    })
    const offset = Number(decoded.offset)
    if (!Number.isSafeInteger(offset) || offset < 0) return null
    return { snapshot, offset }
  } catch {
    return null
  }
}

function createSnapshot() {
  flushLogs()
  cleanupLogs()
  return listLogFilesNewestFirst().map((file) => ({ name: file.name, size: file.size }))
}

export async function queryLogs(query = {}) {
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 200))
  const decodedCursor = decodeCursor(query.cursor)
  const snapshot = decodedCursor?.snapshot || createSnapshot()
  const offset = decodedCursor?.offset || 0
  const results = []
  let matched = 0
  let hasMore = false

  outer: for (const file of snapshot) {
    const path = join(logDirectory, file.name)
    let contents
    try {
      const buffer = await readFileAsync(path)
      contents = buffer.subarray(0, Math.min(file.size, buffer.length)).toString('utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const lines = contents.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index]) continue
      try {
        const record = JSON.parse(lines[index])
        if (!recordMatches(record, query)) continue
        if (matched++ < offset) continue
        if (results.length >= limit) {
          hasMore = true
          break outer
        }
        results.push(record)
      } catch {
        // A process may have terminated mid-write. Keep the remaining valid lines readable.
      }
    }
  }
  return {
    items: results,
    nextCursor: hasMore ? encodeCursor(snapshot, offset + results.length) : null,
    hasMore
  }
}

export function getLogFiles() {
  flushLogs()
  return listLogFilesNewestFirst().map((file) => {
    const stat = statSync(file.path)
    return {
      name: basename(file.name),
      path: file.path,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    }
  })
}

export async function exportLogs(targetPath, metadata = {}) {
  flushLogs()
  const files = listLogFilesNewestFirst().reverse()
  const resolvedTarget = resolve(targetPath)
  const normalizedTarget =
    process.platform === 'win32' ? resolvedTarget.toLocaleLowerCase() : resolvedTarget
  const overwritesSource = files.some((file) => {
    const source = resolve(file.path)
    return (process.platform === 'win32' ? source.toLocaleLowerCase() : source) === normalizedTarget
  })
  if (overwritesSource) throw new Error('导出目标不能覆盖现有日志文件')
  const header = {
    type: 'diagnostic-export',
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    metadata
  }
  await writeFileAsync(resolvedTarget, `${JSON.stringify(header)}\n`, 'utf8')
  for (const file of files) {
    await appendFileAsync(resolvedTarget, await readFileAsync(file.path))
    await appendFileAsync(resolvedTarget, '\n')
  }
  return resolvedTarget
}

export function normalizeRendererLog(payload = {}) {
  const level = LEVELS.has(payload.level) ? payload.level : 'error'
  const truncate = (value) => {
    const text = String(value ?? '')
    return text.length > MAX_RENDERER_FIELD_LENGTH
      ? `${text.slice(0, MAX_RENDERER_FIELD_LENGTH)}…`
      : text
  }
  return {
    level,
    process: 'renderer',
    scope: truncate(payload.scope || 'renderer'),
    message: truncate(payload.message || ''),
    error: payload.error ? serializeUnknown(payload.error) : undefined,
    metadata: payload.metadata ? serializeUnknown(payload.metadata) : undefined,
    dedupeKey: truncate(payload.dedupeKey || '')
  }
}

export const loggingInternals = {
  serializeUnknown,
  localDateKey,
  recordMatches,
  createBoundedLine,
  encodeCursor,
  decodeCursor
}
