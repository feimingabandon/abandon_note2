import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { createLogWriterClient } from './log-writer-client.js'
import { diagnosticState, getDiagnosticPolicy } from './diagnostic-state.js'
import { beginPerformanceOperation, recordPerformanceOperation } from './operation-performance.js'
import {
  DIAGNOSTIC_LIMITS,
  diagnosticDestination,
  diagnosticRecordKind,
  diagnosticRecordLimit,
  diagnosticHash
} from '../../shared/diagnostic-policy.js'
import {
  diagnosticText,
  sanitizeDiagnosticValue,
  estimateDiagnosticBytes
} from '../../shared/diagnostic-sanitize.js'

const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal'])
const originals = Object.fromEntries(
  ['debug', 'info', 'log', 'warn', 'error'].map((key) => [key, console[key].bind(console)])
)
const guardedStreams = new WeakSet()
const unavailableStreams = new WeakSet()
let initialized = false
let consoleInstalled = false
let writer = null
let sequence = 0
const sessionId = randomUUID()
let logDirectory = ''
let applicationContext = {}
let unsubscribePolicy = null
let incident = null
let incidentTimer = null
let ringBytes = 0
const ring = []
const duplicates = new Map()
const recentIncidents = []
const healthListeners = new Set()
const health = {
  suppressedRecords: 0,
  ringOverwritten: 0,
  ringExpired: 0,
  rejectedRecords: 0,
  captureBytes: 0
}

export function isConsoleStreamAvailable(stream) {
  return Boolean(
    stream &&
    !unavailableStreams.has(stream) &&
    !stream.destroyed &&
    !stream.writableEnded &&
    stream.writable !== false
  )
}
export function installConsoleStreamGuard(stream) {
  if (!stream?.on || guardedStreams.has(stream)) return false
  guardedStreams.add(stream)
  stream.on('error', () => unavailableStreams.add(stream))
  return true
}
export function installConsoleStreamGuards() {
  installConsoleStreamGuard(process.stdout)
  installConsoleStreamGuard(process.stderr)
}
function forwardConsole(method, ...args) {
  const stream = ['warn', 'error'].includes(method) ? process.stderr : process.stdout
  if (!isConsoleStreamAvailable(stream)) return
  try {
    originals[method](...args)
  } catch {
    unavailableStreams.add(stream)
  }
}
function resolveWriterFile() {
  // 只在启动解析构建产物时检查文件，常规日志路径没有同步文件操作。
  const directory =
    typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
  const root = process.env.ABANDON_INTEGRATION_APP_ROOT || app.getAppPath?.()
  const candidates = [
    join(directory, 'log-writer.mjs'),
    join(directory, 'log-writer.js'),
    join(directory, '..', 'log-writer.js'),
    ...(root ? [join(root, 'out', 'main', 'log-writer.js')] : [])
  ]
  const path = candidates.find((candidate) => existsSync(candidate))
  if (!path) throw new Error('日志后台模块不存在')
  return path
}
export function initializeLogger() {
  if (initialized) return
  initialized = true
  logDirectory = join(app.getPath('userData'), 'logs')
  applicationContext = {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  }
  try {
    writer = createLogWriterClient({
      directory: logDirectory,
      workerFile: resolveWriterFile(),
      workerOptions: { crashDirectory: app.getPath('crashDumps') },
      onHealth(state) {
        if (['degraded', 'unavailable'].includes(state.status))
          diagnosticState.stop('writer-unavailable')
        for (const callback of healthListeners) {
          try {
            callback(state)
          } catch {
            /* 旁路。 */
          }
        }
      },
      onBatch(result) {
        recordPerformanceOperation('logging', 'flush', result.durationMs, {
          bytes: result.bytes,
          records: result.records,
          errors: result.errors,
          droppedRecords: result.droppedRecords
        })
      }
    })
  } catch (error) {
    forwardConsole('error', '[logging] 后台日志不可用', diagnosticText(error.message))
  }
  unsubscribePolicy = diagnosticState.subscribe((policy, reason) => {
    if (reason === 'started') {
      health.captureBytes = 0
      saveRecentDiagnostics('deep-start', policy.captureId)
    }
    writeLog({
      kind: 'event',
      scope: 'logging.mode',
      eventName: 'diagnostics.mode.changed',
      message: '诊断采集模式变化',
      metadata: { ...policy, reason }
    })
  })
  let closing = false
  app.on?.('will-quit', (event) => {
    if (closing) return
    closing = true
    event.preventDefault?.()
    // 等其它 will-quit 清理结束，收进最后的 shutdown-complete 再发写入屏障。
    setImmediate(async () => {
      await closeLogs(1000)
      app.exit?.(Number(process.exitCode) || 0)
    })
  })
}
export const getLogDirectory = () => {
  initializeLogger()
  return logDirectory
}
export const getCurrentSessionId = () => sessionId
export const subscribeLogHealth = (callback) => {
  healthListeners.add(callback)
  return () => healthListeners.delete(callback)
}

function trimRing(now = Date.now()) {
  while (
    ring.length &&
    (ringBytes > DIAGNOSTIC_LIMITS.ringBytes || now - ring[0].at > DIAGNOSTIC_LIMITS.ringAgeMs)
  ) {
    const entry = ring.shift()
    ringBytes -= entry.bytes
    if (now - entry.at > DIAGNOSTIC_LIMITS.ringAgeMs) health.ringExpired++
    else health.ringOverwritten++
  }
}
function retain(record) {
  const bytes = estimateDiagnosticBytes(record)
  ring.push({ record, bytes, at: Date.now() })
  ringBytes += bytes
  trimRing()
}
function enqueue(record) {
  if (!writer) {
    health.rejectedRecords++
    return false
  }
  const priority = ['error', 'fatal'].includes(record.level)
    ? 3
    : record.level === 'warn' || record.kind === 'event'
      ? 2
      : record.kind === 'metric'
        ? 1
        : 0
  const accepted = writer.enqueue(record, priority)
  if (!accepted) {
    health.rejectedRecords++
    diagnosticState.stop('queue-budget')
  }
  return accepted
}
export function saveRecentDiagnostics(reason = 'export', captureId = null, exportRequestId = null) {
  initializeLogger()
  trimRing()
  const records = ring.splice(0)
  ringBytes = 0
  let saved = 0
  for (const entry of records)
    if (
      enqueue({
        ...entry.record,
        storage: 'detail',
        captureId: captureId || entry.record.captureId,
        ...(exportRequestId ? { exportRequestId } : {}),
        replayReason: reason
      })
    )
      saved++
  return {
    requested: records.length,
    saved,
    retainedFrom: records[0]?.record.time || null,
    retainedTo: records.at(-1)?.record.time || null,
    incomplete: saved !== records.length
  }
}
export function captureDiagnosticIncident(reason, actionId) {
  const now = Date.now()
  if (incident && now < incident.until) return incident.id
  while (recentIncidents.length && now - recentIncidents[0].at > 600000) recentIncidents.shift()
  if (
    recentIncidents.length >= 3 ||
    recentIncidents.some((item) => item.reason === reason && now - item.at < 60000)
  )
    return null
  const id = randomUUID()
  incident = { id, reason, actionId, until: now + 30000, bytes: 0 }
  recentIncidents.push({ id, reason, at: now })
  saveRecentDiagnostics('incident', id)
  writeLog({
    kind: 'event',
    scope: 'logging.incident',
    message: '保存近期诊断现场',
    metadata: { id, reason, actionId, until: incident.until }
  })
  clearTimeout(incidentTimer)
  incidentTimer = setTimeout(() => {
    const completed = incident
    incident = null
    writeLog({
      kind: 'event',
      scope: 'logging.incident',
      message: '诊断现场采集结束',
      metadata: completed
    })
  }, 30000)
  incidentTimer.unref?.()
  return id
}
function emitDuplicate(entry) {
  enqueue({
    ...entry.record,
    id: `${sessionId}-${++sequence}`,
    time: new Date().toISOString(),
    kind: 'event',
    scope: 'logging.repeated',
    message: '重复日志汇总',
    metadata: {
      originalId: entry.record.id,
      originalScope: entry.record.scope,
      count: entry.count - 1,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt
    }
  })
  entry.count = 1
}
function collectDuplicate(record, key) {
  if (!key) return false
  const now = Date.now()
  const previous = duplicates.get(key)
  if (previous && now - previous.firstAt < 30000) {
    previous.count++
    previous.lastAt = now
    health.suppressedRecords++
    return true
  }
  if (previous?.count > 1) emitDuplicate(previous)
  if (duplicates.size >= 512) {
    const oldest = duplicates.keys().next().value
    const entry = duplicates.get(oldest)
    if (entry.count > 1) emitDuplicate(entry)
    duplicates.delete(oldest)
  }
  duplicates.set(key, { record, count: 1, firstAt: now, lastAt: now })
  return false
}
export function writeLog(payload = {}) {
  let finish = () => {}
  try {
    const receiptPolicy = getDiagnosticPolicy()
    const policy = payload.collectionPolicy || receiptPolicy
    const destination = diagnosticDestination(
      payload,
      policy,
      payload.collectionPolicy ? Date.parse(payload.time) : Date.now()
    )
    if (destination === 'drop') return null
    initializeLogger()
    if (!String(payload.scope || '').startsWith('performance.'))
      finish = beginPerformanceOperation('logging', 'enqueue')
    const kind = diagnosticRecordKind(payload)
    const limit = diagnosticRecordLimit(payload)
    const metadata = typeof payload.metadata === 'function' ? payload.metadata() : payload.metadata
    const record = {
      schemaVersion: 3,
      id: `${sessionId}-${++sequence}`,
      time: payload.time || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      monotonicMs: performance.now(),
      level: LEVELS.has(payload.level) ? payload.level : 'info',
      process: payload.process || 'main',
      scope: diagnosticText(payload.scope || 'application', 128),
      message: diagnosticText(payload.message || '', 2048),
      kind,
      sessionId,
      pid: process.pid,
      ...applicationContext,
      mode: policy.mode,
      policyEpoch: policy.policyEpoch,
      receiptPolicyEpoch: receiptPolicy.policyEpoch,
      captureId: policy.captureId,
      storage: kind === 'trace' || (kind === 'metric' && policy.mode === 'deep') ? 'detail' : 'app'
    }
    for (const field of [
      'windowRole',
      'eventName',
      'phase',
      'actionId',
      'parentActionId',
      'outcome',
      'errorCode',
      'markerId',
      'stage',
      'producerId',
      'exportRequestId'
    ])
      if (payload[field] !== undefined) record[field] = diagnosticText(payload[field], 160)
    for (const field of ['webContentsId', 'durationMs', 'producerSeq', 'producerMonotonicMs'])
      if (Number.isFinite(payload[field])) record[field] = payload[field]
    if (payload.error !== undefined)
      record.error = sanitizeDiagnosticValue(payload.error, { maxBytes: Math.floor(limit / 2) })
    if (metadata !== undefined)
      record.metadata = sanitizeDiagnosticValue(metadata, {
        maxBytes: limit,
        maxDepth: kind === 'metric' ? 9 : 6,
        maxArray: kind === 'metric' ? 128 : 32,
        maxNodes: kind === 'metric' ? 4096 : 256
      })
    const duplicateKey = payload.dedupeKey
      ? `${record.scope}:${diagnosticHash(payload.dedupeKey)}`
      : ['error', 'fatal'].includes(record.level)
        ? `${record.scope}:${diagnosticHash(record.error?.stack || record.message)}`
        : null
    if (collectDuplicate(record, duplicateKey)) return null
    if (destination === 'ring' && !incident) retain(record)
    else {
      if (destination === 'ring' && incident) {
        record.captureId = incident.id
        record.storage = 'detail'
        incident.bytes += estimateDiagnosticBytes(record)
        if (incident.bytes > DIAGNOSTIC_LIMITS.captureBytes) {
          incident = null
          retain(record)
          return record.id
        }
      }
      if (policy.mode === 'deep' && record.storage === 'detail') {
        health.captureBytes += estimateDiagnosticBytes(record)
        if (health.captureBytes > DIAGNOSTIC_LIMITS.captureBytes) {
          diagnosticState.stop('capture-budget')
          retain(record)
          return record.id
        }
      }
      enqueue(record)
    }
    if (
      !record.scope.startsWith('logging.') &&
      (['error', 'fatal'].includes(record.level) ||
        record.outcome === 'mismatch' ||
        (record.level === 'warn' &&
          ['performance.main-stall', 'performance.renderer'].includes(record.scope)))
    )
      captureDiagnosticIncident(record.scope, record.actionId)
    finish({
      bytes: estimateDiagnosticBytes(record),
      queuedBytes: writer?.snapshot().queuedBytes || 0
    })
    return record.id
  } catch {
    health.rejectedRecords++
    return null
  } finally {
    finish()
  }
}
export const logger = {
  debug: (scope, message, metadata) => writeLog({ level: 'debug', scope, message, metadata }),
  info: (scope, message, metadata) => writeLog({ level: 'info', scope, message, metadata }),
  warn: (scope, message, metadata) => writeLog({ level: 'warn', scope, message, metadata }),
  error: (scope, error, metadata) =>
    writeLog({
      level: 'error',
      scope,
      message:
        error instanceof Error ? error.message : typeof error === 'string' ? error : '操作异常',
      error,
      metadata
    }),
  fatal: (scope, error, metadata) =>
    writeLog({
      level: 'fatal',
      scope,
      message:
        error instanceof Error ? error.message : typeof error === 'string' ? error : '严重异常',
      error,
      metadata
    })
}
export function installConsoleCapture() {
  if (consoleInstalled) return
  consoleInstalled = true
  installConsoleStreamGuards()
  for (const method of ['debug', 'info', 'log', 'warn', 'error']) {
    console[method] = (message, ...args) => {
      const level = method === 'log' ? 'info' : method
      const record = { level, scope: 'console' }
      if (diagnosticDestination(record, getDiagnosticPolicy()) !== 'drop')
        writeLog({
          ...record,
          message: typeof message === 'string' ? message : 'Console event',
          error: [message, ...args].find((item) => item instanceof Error),
          metadata: () => ({ arguments: sanitizeDiagnosticValue(args) })
        })
      if (!app.isPackaged) forwardConsole(method, message, ...args)
    }
  }
}
export function getLoggingHealth() {
  trimRing()
  return {
    ...health,
    ringBytes,
    ringRecords: ring.length,
    retainedFrom: ring[0]?.record.time || null,
    writer: writer?.snapshot() || { status: 'unavailable' },
    incidents: recentIncidents.slice(),
    ...diagnosticState.snapshot()
  }
}
export async function flushLogs(timeoutMs = 5000) {
  initializeLogger()
  for (const entry of duplicates.values()) if (entry.count > 1) emitDuplicate(entry)
  if (!writer) return { incomplete: true, reason: 'writer-unavailable' }
  const result = await writer.flush(timeoutMs)
  return {
    ...result,
    incomplete: Boolean(
      result.incomplete ||
      result.droppedRecords ||
      result.writeErrors ||
      health.rejectedRecords ||
      result.status !== 'ready'
    )
  }
}
export async function closeLogs(timeoutMs = 1000) {
  clearTimeout(incidentTimer)
  unsubscribePolicy?.()
  await flushLogs(timeoutMs)
  await writer?.close(0)
}
export async function queryLogs(query = {}) {
  initializeLogger()
  await flushLogs()
  if (!writer) throw new Error('日志后台不可用')
  return writer.request('query', query)
}
export async function getLogFiles() {
  initializeLogger()
  return writer ? writer.request('files') : []
}
export async function getCrashDumpIndex() {
  initializeLogger()
  return writer ? writer.request('crash-index') : { files: [], unavailable: true }
}
export async function freezeLogSnapshot() {
  initializeLogger()
  if (!writer) throw new Error('日志后台不可用')
  return writer.request('freeze-export')
}
export async function releaseLogSnapshot(id) {
  if (writer && id) await writer.request('release-snapshot', id).catch(() => {})
}
export async function exportLogs(
  targetPath,
  metadata = {},
  systemDiagnostics = null,
  selection = null,
  manifest = {}
) {
  initializeLogger()
  if (!selection?.snapshotId) saveRecentDiagnostics('export', null, selection?.requestId)
  await flushLogs()
  if (!writer) throw new Error('日志后台不可用')
  const header = {
    type: 'diagnostic-export',
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    ...applicationContext,
    metadata: sanitizeDiagnosticValue(metadata, { maxBytes: 16384 })
  }
  const snapshot =
    systemDiagnostics == null
      ? null
      : sanitizeDiagnosticValue(systemDiagnostics, {
          maxBytes: 128 * 1024,
          maxDepth: 10,
          maxArray: 128,
          maxNodes: 8192
        })
  await writer.request(
    'export',
    [targetPath, header, snapshot, selection, { ...manifest, diagnostics: getLoggingHealth() }],
    60000
  )
  return targetPath
}
export function normalizeRendererLog(payload = {}) {
  if (!payload || typeof payload !== 'object')
    return { level: 'warn', scope: 'renderer.invalid', message: '无效诊断记录' }
  const result = {}
  for (const key of [
    'level',
    'scope',
    'message',
    'kind',
    'eventName',
    'phase',
    'actionId',
    'parentActionId',
    'outcome',
    'errorCode',
    'dedupeKey',
    'stage',
    'producerId',
    'producerMode',
    'producerCaptureId',
    'exportRequestId',
    'time'
  ])
    if (typeof payload[key] === 'string')
      result[key] = diagnosticText(payload[key], key === 'message' ? 2048 : 160)
  for (const key of ['producerSeq', 'producerPolicyEpoch', 'producerMonotonicMs', 'durationMs'])
    if (Number.isFinite(payload[key])) result[key] = payload[key]
  result.level = LEVELS.has(result.level) ? result.level : 'error'
  result.process = 'renderer'
  if (payload.error !== undefined) result.error = payload.error
  if (payload.metadata !== undefined) result.metadata = payload.metadata
  return result
}
export const loggingInternals = {
  serializeUnknown: sanitizeDiagnosticValue,
  installConsoleStreamGuard,
  isConsoleStreamAvailable
}
