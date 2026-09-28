import { randomUUID } from 'node:crypto'
import { diagnosticState } from './diagnostic-state.js'
import {
  getLoggingHealth,
  flushLogs,
  normalizeRendererLog,
  saveRecentDiagnostics,
  writeLog
} from './logger.js'
import {
  getWindowLogContext,
  getWindowDiagnosticContext,
  noteStructuredRendererConsole
} from './window-capture.js'
import {
  sanitizeDiagnosticValue,
  estimateDiagnosticBytes
} from '../../shared/diagnostic-sanitize.js'
import { diagnosticRecordLimit } from '../../shared/diagnostic-policy.js'

// 所有注册 producer 的授权额度合计不超过 1 MiB；主线程/Worker 另有 3 MiB。
const MAX_PRODUCERS = 32
const PRODUCER_BYTES = 32768

export function registerDiagnosticController({
  ipcMain,
  controls,
  BrowserWindow,
  observeRenderer = () => {},
  flushPerformance = () => {}
}) {
  const producers = new Map()
  const freezes = new Map()
  const recentFreezes = new Set()
  const retired = []
  const watched = new WeakSet()
  let changing = false
  let lastFreeze = null
  const counts = {
    batches: 0,
    rejectedBatches: 0,
    rejectedRecords: 0,
    retiredOmitted: 0,
    retiredIncompleteOmitted: 0
  }
  function retire(entry, reason) {
    if (!entry || producers.get(entry.sender.id) !== entry) return
    producers.delete(entry.sender.id)
    const complete =
      entry.ending?.complete === true &&
      entry.ending.sequence === entry.lastSeq &&
      Date.now() - entry.ending.at < 5000
    const ended = {
      producerId: entry.id,
      webContentsId: entry.sender.id,
      windowRole: entry.role,
      status: complete ? 'complete' : 'partial',
      lifecycle: reason,
      endedAt: Date.now(),
      receivedSequence: entry.lastSeq,
      reason: complete ? 'final-sequence-received' : 'final-sequence-unconfirmed',
      health: entry.health,
      ending: entry.ending || null
    }
    retired.push(ended)
    if (retired.length > 64) {
      const omitted = retired.shift()
      counts.retiredOmitted++
      if (omitted.status !== 'complete') counts.retiredIncompleteOmitted++
    }
    writeLog({
      kind: 'event',
      scope: 'logging.producer-ended',
      level: complete ? 'info' : 'warn',
      message: complete ? '页面诊断提交完成' : '页面结束时诊断提交未确认',
      metadata: ended
    })
  }
  function senderWindow(event) {
    const win = BrowserWindow.fromWebContents(event?.sender)
    if (
      !win ||
      win.isDestroyed() ||
      (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame)
    )
      throw new Error('无权访问诊断入口')
    return win
  }
  const reply = (sender, channel, payload) => {
    try {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    } catch {
      /* 窗口销毁。 */
    }
  }
  function policy(entry) {
    return { ...diagnosticState.get(), transportBytes: entry?.quota || PRODUCER_BYTES }
  }
  function producerStates() {
    return [...producers.values()].map((entry) => ({
      webContentsId: entry.sender.id,
      producerId: entry.id,
      windowRole: entry.role,
      appliedEpoch: entry.appliedEpoch,
      capabilities: entry.capabilities,
      receivedSequence: entry.lastSeq,
      health: entry.health,
      quota: entry.quota
    }))
  }
  function state() {
    return {
      ...diagnosticState.get(),
      phase: changing ? 'changing' : diagnosticState.get().mode,
      diagnostics: getLoggingHealth(),
      producers: producerStates(),
      retiredProducers: retired.slice(),
      transport: { ...counts },
      lastFreeze
    }
  }
  function broadcast() {
    for (const entry of producers.values()) {
      if (entry.sender.isDestroyed()) retire(entry, 'destroyed')
      else reply(entry.sender, 'logs:policy', policy(entry))
    }
  }
  const unsubscribe = diagnosticState.subscribe(broadcast)
  ipcMain.handle('logs:policy-get', (event, payload = {}) => {
    const win = senderWindow(event)
    if (!/^[\w-]{1,128}$/.test(payload.producerId || '')) throw new Error('无效诊断 producer')
    if (!producers.has(event.sender.id) && producers.size >= MAX_PRODUCERS)
      throw new Error('诊断窗口数量已达上限')
    const previous = producers.get(event.sender.id)
    if (previous?.id !== payload.producerId) {
      const role = getWindowLogContext(win).role
      const used =
        [...producers.values()].reduce((sum, item) => sum + item.quota, 0) - (previous?.quota || 0)
      const preferred = ['main', 'month', 'week'].includes(role) ? 256 * 1024 : PRODUCER_BYTES
      const quota = Math.min(preferred, 1024 * 1024 - used)
      if (quota < 8192) throw new Error('诊断运输额度已用满')
      retire(previous, 'reloaded')
      producers.set(event.sender.id, {
        id: payload.producerId,
        sender: event.sender,
        role,
        quota,
        lastSeq: 0,
        appliedEpoch: null,
        capabilities: ['transport'],
        health: {},
        context: {
          windowContext: getWindowLogContext(win),
          browserWindowId: win.id,
          rendererProcessId: event.sender.getOSProcessId?.()
        }
      })
      if (!watched.has(event.sender)) {
        watched.add(event.sender)
        event.sender.once('destroyed', () => retire(producers.get(event.sender.id), 'destroyed'))
        event.sender.on('render-process-gone', () =>
          retire(producers.get(event.sender.id), 'render-process-gone')
        )
      }
    }
    return policy(producers.get(event.sender.id))
  })
  ipcMain.on('logs:ending', (event, payload = {}) => {
    const entry = producers.get(event.sender.id)
    if (!entry || entry.id !== payload.producerId) return
    entry.ending = {
      at: Date.now(),
      sequence: payload.producerSeq,
      reported: sanitizeDiagnosticValue(payload),
      complete:
        Number.isSafeInteger(payload.producerSeq) &&
        payload.producerSeq === entry.lastSeq &&
        payload.queuedRecords === 0 &&
        !payload.incomplete &&
        payload.droppedRecords === 0 &&
        payload.policyFailures === 0
    }
  })
  ipcMain.on('logs:continuing', (event, payload = {}) => {
    const entry = producers.get(event.sender.id)
    if (entry?.id === payload.producerId) entry.ending = null
  })
  ipcMain.on('logs:policy-applied', (event, payload = {}) => {
    const entry = producers.get(event.sender.id)
    if (!entry || entry.id !== payload.producerId) return
    entry.appliedEpoch = Number(payload.policyEpoch)
    entry.capabilities = Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((item) => /^[a-z-]{1,40}$/.test(item)).slice(0, 16)
      : []
    entry.health = sanitizeDiagnosticValue(payload.health)
  })
  ipcMain.on('logs:batch', (event, payload = {}) => {
    let accepted = false
    let rejected = 0
    try {
      const win = senderWindow(event)
      const entry = producers.get(event.sender.id)
      if (
        !entry ||
        entry.id !== payload.producerId ||
        !Array.isArray(payload.records) ||
        payload.records.length > 64
      )
        throw new Error('无效诊断批次')
      let bytes = 0
      for (const raw of payload.records) {
        const safe = sanitizeDiagnosticValue(raw, {
          maxBytes: diagnosticRecordLimit(raw),
          maxDepth: 10,
          maxArray: 128,
          maxNodes: 4096
        })
        bytes += estimateDiagnosticBytes(safe)
        if (bytes > PRODUCER_BYTES * 2) {
          rejected++
          continue
        }
        const record = normalizeRendererLog(safe)
        if (!Number.isSafeInteger(record.producerSeq) || record.producerSeq <= entry.lastSeq)
          continue
        entry.lastSeq = record.producerSeq
        if (entry.ending && entry.lastSeq > entry.ending.sequence) entry.ending = null
        if (record.exportRequestId && !recentFreezes.has(record.exportRequestId))
          delete record.exportRequestId
        const detailed = ['warn', 'error', 'fatal'].includes(record.level)
        const context = detailed ? getWindowDiagnosticContext(win, event.sender) : entry.context
        noteStructuredRendererConsole(win, record)
        observeRenderer(record, event.sender.id)
        if (record.scope === 'performance.render-work') {
          entry.slowCollections =
            record.metadata?.collectionDurationMs >= 20 ? (entry.slowCollections || 0) + 1 : 0
          if (entry.slowCollections >= 3) diagnosticState.stop('collector-cost')
        }
        const history = diagnosticState.snapshot().history
        const collectionPolicy = history.find(
          (item) =>
            item.policyEpoch === record.producerPolicyEpoch &&
            item.mode === record.producerMode &&
            item.captureId === (record.producerCaptureId || null)
        )
        writeLog({
          ...record,
          collectionPolicy,
          windowRole: entry.role,
          webContentsId: event.sender.id,
          metadata: { ...(record.metadata || {}), ...context }
        })
      }
      const nextHealth = sanitizeDiagnosticValue(payload.health) || {}
      entry.pressuredBatches =
        Number(nextHealth.droppedRecords) > Number(entry.health?.droppedRecords || 0)
          ? (entry.pressuredBatches || 0) + 1
          : 0
      entry.health = nextHealth
      if (entry.pressuredBatches >= 3) diagnosticState.stop('queue-budget')
      counts.batches++
      counts.rejectedRecords += rejected
      accepted = true
    } catch {
      counts.rejectedBatches++
    }
    reply(event.sender, 'logs:ack', {
      batchId: String(payload.batchId || '').slice(0, 180),
      accepted,
      droppedRecords: rejected
    })
  })
  ipcMain.on('logs:frozen', (event, payload = {}) => {
    const waiting = freezes.get(payload.requestId)
    const entry = producers.get(event.sender.id)
    if (
      !waiting ||
      !entry ||
      entry.id !== payload.producerId ||
      waiting.expected.get(event.sender.id)?.id !== payload.producerId ||
      !waiting.pending.has(event.sender.id)
    )
      return
    waiting.pending.delete(event.sender.id)
    waiting.results.set(event.sender.id, {
      webContentsId: event.sender.id,
      windowRole: entry.role,
      status: payload.incomplete ? 'partial' : 'complete',
      producerId: entry.id,
      reported: sanitizeDiagnosticValue(payload),
      receivedSequence: entry.lastSeq
    })
    if (!waiting.pending.size) waiting.finish()
  })
  async function freeze(reason = 'export', cutoff = Date.now()) {
    const requestId = randomUUID()
    recentFreezes.add(requestId)
    if (recentFreezes.size > 32) recentFreezes.delete(recentFreezes.values().next().value)
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
    const pending = new Set()
    const expected = new Map()
    const results = new Map()
    for (const win of windows) {
      const entry = producers.get(win.webContents.id)
      if (entry) {
        pending.add(win.webContents.id)
        expected.set(win.webContents.id, entry)
      } else
        results.set(win.webContents.id, {
          webContentsId: win.webContents.id,
          windowRole: getWindowLogContext(win).role,
          status: 'unsupported'
        })
    }
    await new Promise((resolve) => {
      let timeout
      const finish = () => {
        clearTimeout(timeout)
        freezes.delete(requestId)
        resolve()
      }
      freezes.set(requestId, { pending, expected, results, finish })
      timeout = setTimeout(finish, 1000)
      for (const id of pending)
        reply(producers.get(id).sender, 'logs:freeze', { requestId, cutoff, reason })
      if (!pending.size) finish()
    })
    for (const id of pending)
      results.set(id, {
        webContentsId: id,
        producerId: expected.get(id)?.id,
        status: producers.get(id)?.sender.isDestroyed() === false ? 'timeout' : 'closed'
      })
    flushPerformance(requestId)
    const ring = saveRecentDiagnostics(
      reason,
      diagnosticState.get().captureId,
      reason === 'export' ? requestId : null
    )
    const writer = await flushLogs(1000)
    const retiredIds = new Set(retired.map((item) => item.producerId))
    const capturedWindows = [
      ...[...results.values()].filter((item) => !retiredIds.has(item.producerId)),
      ...retired
    ]
    lastFreeze = {
      requestId,
      reason,
      cutoff,
      capturedAt: Date.now(),
      windows: capturedWindows,
      retiredOmitted: counts.retiredOmitted,
      retiredIncompleteOmitted: counts.retiredIncompleteOmitted,
      ring,
      writer,
      complete:
        capturedWindows.every((item) => item.status === 'complete') &&
        counts.retiredIncompleteOmitted === 0 &&
        !ring.incomplete &&
        !writer.incomplete
    }
    return lastFreeze
  }
  controls.handle('logs:state', () => state())
  controls.handle('logs:mode-start', async () => {
    if (changing) throw new Error('诊断模式正在切换')
    changing = true
    try {
      await flushLogs()
      if (getLoggingHealth().writer.status !== 'ready')
        throw new Error('日志写入暂不可用，无法开始深度排查')
      await freeze('deep-start')
      diagnosticState.start(10)
      return state()
    } finally {
      changing = false
    }
  })
  controls.handle('logs:mode-extend', () => {
    if (diagnosticState.get().mode !== 'deep') throw new Error('当前未开启深度排查')
    diagnosticState.start(10)
    return state()
  })
  controls.handle('logs:mode-stop', async () => {
    if (changing) throw new Error('诊断模式正在切换')
    changing = true
    try {
      await freeze('deep-stop')
      diagnosticState.stop('user')
      return state()
    } finally {
      changing = false
    }
  })
  return {
    freeze,
    state,
    dispose() {
      unsubscribe()
      producers.clear()
      for (const waiting of freezes.values()) waiting.finish()
    }
  }
}
