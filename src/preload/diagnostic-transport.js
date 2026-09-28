import {
  dailyDiagnosticPolicy,
  diagnosticDestination,
  diagnosticRecordKind,
  diagnosticRecordLimit
} from '../shared/diagnostic-policy.js'
import { sanitizeDiagnosticValue, estimateDiagnosticBytes } from '../shared/diagnostic-sanitize.js'

export function createDiagnosticTransport(
  raw,
  {
    now = Date.now,
    clock = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    eventTarget = globalThis.window,
    autoConnect = true
  } = {}
) {
  const producerId =
    globalThis.crypto?.randomUUID?.() || `renderer-${now()}-${Math.random().toString(16).slice(2)}`
  let policy = dailyDiagnosticPolicy()
  let expiresMono = Infinity
  let quota = 8192
  let timer = null
  let expiryTimer = null
  let disposed = false
  let sequence = 0
  let batchSequence = 0
  let bytes = 0
  let lastSent = -Infinity
  let flushContext = null
  let force = false
  let endingSent = false
  const queue = []
  const inFlight = new Map()
  const policyListeners = new Set()
  const flushListeners = new Set()
  const waiters = new Set()
  const capabilities = new Set(['transport'])
  const health = {
    droppedRecords: 0,
    droppedBytes: 0,
    ackTimeouts: 0,
    policyFailures: 0,
    peakBytes: 0
  }
  const send = (channel, payload) => {
    try {
      raw.send(channel, payload)
      return true
    } catch {
      return false
    }
  }
  function getPolicy() {
    if (policy.mode === 'deep' && (now() >= policy.expiresAt || clock() >= expiresMono))
      applyPolicy({ ...dailyDiagnosticPolicy(policy.policyEpoch), transportBytes: quota }, false)
    return { ...policy }
  }
  function completeWaiters() {
    for (const waiter of waiters) {
      if (
        !queue.some((entry) => entry.seq <= waiter.target) &&
        ![...inFlight.values()].some((batch) =>
          batch.entries.some((entry) => entry.seq <= waiter.target)
        )
      ) {
        clearTimer(waiter.timer)
        waiters.delete(waiter)
        waiter.resolve({
          ...health,
          incomplete: health.droppedRecords > 0 || health.policyFailures > 0,
          queuedBytes: bytes
        })
      }
    }
  }
  function schedule() {
    if (timer !== null || disposed || !queue.length) return
    const interval = getPolicy().mode === 'deep' ? 250 : 1000
    timer = setTimer(
      () => {
        timer = null
        pump()
      },
      Math.max(0, interval - (clock() - lastSent))
    )
    timer?.unref?.()
  }
  function pump() {
    if (disposed || inFlight.size >= 2 || !queue.length) {
      completeWaiters()
      return
    }
    const deep = getPolicy().mode === 'deep'
    if (!force && clock() - lastSent < (deep ? 250 : 1000)) {
      schedule()
      return
    }
    const entries = []
    let batchBytes = 0
    const limit = deep ? 32768 : 16384
    while (queue.length && entries.length < (deep ? 64 : 32)) {
      if (entries.length && batchBytes + queue[0].bytes > limit) break
      const entry = queue.shift()
      entries.push(entry)
      batchBytes += entry.bytes
    }
    const batchId = `${producerId}-${++batchSequence}`
    lastSent = clock()
    const batch = { entries, bytes: batchBytes, timer: null }
    inFlight.set(batchId, batch)
    batch.timer = setTimer(() => {
      if (!inFlight.delete(batchId)) return
      bytes -= batchBytes
      health.ackTimeouts++
      health.droppedRecords += entries.length
      health.droppedBytes += batchBytes
      completeWaiters()
      schedule()
    }, 5000)
    batch.timer?.unref?.()
    if (
      !send('logs:batch', {
        producerId,
        batchId,
        policyEpoch: policy.policyEpoch,
        records: entries.map((entry) => entry.record),
        health: { ...health }
      })
    ) {
      clearTimer(batch.timer)
      inFlight.delete(batchId)
      bytes -= batchBytes
      health.droppedRecords += entries.length
      health.droppedBytes += batchBytes
    }
    if (force && queue.length && inFlight.size < 2) pump()
    else schedule()
  }
  function applyPolicy(next, acknowledge = true) {
    if (disposed || !next || Number(next.policyEpoch) < policy.policyEpoch) return
    clearTimer(expiryTimer)
    policy =
      next.mode === 'deep' && next.expiresAt > now()
        ? { ...next }
        : dailyDiagnosticPolicy(Number(next.policyEpoch) || 0)
    quota = Math.min(256 * 1024, Math.max(0, Number(next.transportBytes) || 0))
    expiresMono = clock() + Math.max(0, Number(next.remainingMs) || next.expiresAt - now())
    for (const callback of policyListeners) {
      try {
        callback({ ...policy })
      } catch {
        health.policyFailures++
      }
    }
    if (policy.mode === 'deep') {
      expiryTimer = setTimer(
        () => getPolicy(),
        Math.max(1, Math.min(policy.expiresAt - now(), expiresMono - clock()))
      )
      expiryTimer?.unref?.()
    }
    if (acknowledge)
      send('logs:policy-applied', {
        producerId,
        policyEpoch: policy.policyEpoch,
        capabilities: [...capabilities],
        health: { ...health }
      })
    schedule()
  }
  function report(payload = {}) {
    try {
      if (disposed || diagnosticDestination(payload, getPolicy()) === 'drop') return false
      if (endingSent) {
        endingSent = false
        send('logs:continuing', { producerId })
      }
      const kind = diagnosticRecordKind(payload)
      const limit = diagnosticRecordLimit(payload)
      const record = sanitizeDiagnosticValue(
        { ...payload, kind },
        {
          maxBytes: Math.min(limit, Math.max(1024, quota / 2)),
          maxDepth: kind === 'metric' ? 10 : 7,
          maxArray: kind === 'metric' ? 128 : 32,
          maxNodes: kind === 'metric' ? 4096 : 256
        }
      )
      const seq = ++sequence
      Object.assign(record, {
        producerId,
        producerSeq: seq,
        producerMonotonicMs: clock(),
        producerMode: policy.mode,
        producerPolicyEpoch: policy.policyEpoch,
        producerCaptureId: policy.captureId,
        time: new Date(now()).toISOString(),
        ...(flushContext?.requestId ? { exportRequestId: flushContext.requestId } : {})
      })
      const size = estimateDiagnosticBytes(record)
      const priority = ['warn', 'error', 'fatal'].includes(record.level)
        ? 2
        : kind === 'event'
          ? 1
          : 0
      while (bytes + size > quota) {
        const index = queue.findIndex((entry) => entry.priority <= priority)
        if (index < 0) {
          health.droppedRecords++
          health.droppedBytes += size
          return false
        }
        const removed = queue.splice(index, 1)[0]
        bytes -= removed.bytes
        health.droppedRecords++
        health.droppedBytes += removed.bytes
      }
      queue.push({ record, bytes: size, seq, priority })
      bytes += size
      health.peakBytes = Math.max(health.peakBytes, bytes)
      // 错误仍经过同一频率/容量限制；首批可立即发送。
      pump()
      return true
    } catch {
      health.droppedRecords++
      return false
    }
  }
  function flush(timeoutMs = 1000) {
    if (disposed) return Promise.resolve({ incomplete: true, reason: 'disposed' })
    if (!queue.length && !inFlight.size)
      return Promise.resolve({
        ...health,
        incomplete: health.droppedRecords > 0 || health.policyFailures > 0,
        queuedBytes: bytes
      })
    force = true
    const target = sequence
    return new Promise((resolve) => {
      const waiter = { target, resolve, timer: null }
      waiter.timer = setTimer(() => {
        waiters.delete(waiter)
        resolve({ ...health, incomplete: true, reason: 'transport-timeout', queuedBytes: bytes })
      }, timeoutMs)
      waiters.add(waiter)
      pump()
    }).finally(() => {
      force = waiters.size > 0
    })
  }
  const onAck = (_event, message) => {
    const batch = inFlight.get(message?.batchId)
    if (!batch) return
    clearTimer(batch.timer)
    inFlight.delete(message.batchId)
    bytes -= batch.bytes
    if (message.accepted === false) {
      health.droppedRecords += batch.entries.length
      health.droppedBytes += batch.bytes
    } else health.droppedRecords += Math.max(0, Number(message.droppedRecords) || 0)
    completeWaiters()
    if (force) pump()
    else schedule()
  }
  const onPolicy = (_event, next) => applyPolicy(next)
  function collectForFlush(request) {
    for (const callback of flushListeners) {
      try {
        flushContext = request
        callback(request)
      } catch {
        health.policyFailures++
      } finally {
        flushContext = null
      }
    }
  }
  function reportEnding(reason, incomplete = false) {
    endingSent = true
    send('logs:ending', {
      producerId,
      producerSeq: sequence,
      reason,
      queuedRecords: queue.length,
      ...health,
      incomplete
    })
  }
  async function prepareForUnload(reason = 'closing', timeoutMs = 800) {
    collectForFlush({ reason })
    const result = await flush(timeoutMs)
    reportEnding(reason, result.incomplete)
    return result
  }
  const onFreeze = async (_event, request) => {
    if (!request?.requestId) return
    collectForFlush(request)
    const result = await flush(900)
    if (request.reason === 'shutdown') reportEnding('shutdown', result.incomplete)
    send('logs:frozen', {
      requestId: request.requestId,
      producerId,
      producerSeq: sequence,
      capabilities: [...capabilities],
      ...result
    })
  }
  function onPageHide() {
    if (disposed) return
    collectForFlush({ reason: 'pagehide' })
    // 卸载事件不能 await；尽力提交，主进程依据实际收到的序列判断完整性。
    force = true
    pump()
    reportEnding('pagehide')
    dispose()
  }
  raw.on?.('logs:ack', onAck)
  raw.on?.('logs:policy', onPolicy)
  raw.on?.('logs:freeze', onFreeze)
  eventTarget?.addEventListener?.('pagehide', onPageHide, { once: true })
  if (autoConnect) {
    try {
      Promise.resolve(raw.invoke('logs:policy-get', { producerId })).then(applyPolicy, () => {
        health.policyFailures++
        quota = 0
        health.droppedRecords += queue.length
        health.droppedBytes += bytes
        queue.length = 0
        bytes = [...inFlight.values()].reduce((sum, batch) => sum + batch.bytes, 0)
      })
    } catch {
      health.policyFailures++
    }
  }
  function dispose() {
    disposed = true
    clearTimer(timer)
    clearTimer(expiryTimer)
    for (const batch of inFlight.values()) clearTimer(batch.timer)
    for (const waiter of waiters) {
      clearTimer(waiter.timer)
      waiter.resolve({ incomplete: true, reason: 'disposed' })
    }
    waiters.clear()
    queue.length = 0
    inFlight.clear()
    bytes = 0
    policyListeners.clear()
    flushListeners.clear()
    raw.removeListener?.('logs:ack', onAck)
    raw.removeListener?.('logs:policy', onPolicy)
    raw.removeListener?.('logs:freeze', onFreeze)
    eventTarget?.removeEventListener?.('pagehide', onPageHide)
  }
  return {
    report,
    getPolicy,
    flush,
    prepareForUnload,
    producerId,
    subscribe(callback) {
      policyListeners.add(callback)
      callback(getPolicy())
      return () => policyListeners.delete(callback)
    },
    onFlush(callback) {
      flushListeners.add(callback)
      return () => flushListeners.delete(callback)
    },
    capability(name) {
      if (!/^[a-z-]{1,40}$/.test(name) || capabilities.size >= 16) return
      capabilities.add(name)
      send('logs:policy-applied', {
        producerId,
        policyEpoch: policy.policyEpoch,
        capabilities: [...capabilities],
        health: { ...health }
      })
    },
    health: () => ({ ...health, queuedBytes: bytes, inFlight: inFlight.size, quota }),
    applyPolicy,
    dispose
  }
}
