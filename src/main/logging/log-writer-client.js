import { Worker } from 'node:worker_threads'
import { DIAGNOSTIC_LIMITS } from '../../shared/diagnostic-policy.js'
import { estimateDiagnosticBytes } from '../../shared/diagnostic-sanitize.js'

export function createLogWriterClient({
  directory,
  workerFile,
  workerOptions,
  createWorker = (file, options) => new Worker(file, options),
  onHealth = () => {},
  onBatch = () => {}
}) {
  let worker = null
  let ready = false
  let closed = false
  let stopping = false
  let requestId = 0
  let sequence = 0
  let queuedBytes = 0
  let inFlight = null
  let timer = null
  let restartTimer = null
  let closePromise = null
  let restartAt = -Infinity
  let forceThrough = 0
  let backoffUntil = 0
  const queue = []
  const requests = new Map()
  const flushes = new Set()
  const pendingTerminations = new Set()
  let terminationRequested = false
  let terminationFailures = 0
  let terminationError = null
  let terminationExitCode
  const health = {
    status: 'starting',
    queuedBytes: 0,
    peakBytes: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    writeErrors: 0,
    workerRestarts: 0,
    lastError: null,
    oldestAgeMs: 0
  }
  function snapshot() {
    return {
      ...health,
      queuedBytes,
      pendingRecords: queue.length + (inFlight?.entries.length || 0),
      oldestAgeMs: queue.length ? Date.now() - queue[0].at : 0
    }
  }
  function status(value, error = null) {
    if (!closed || value === 'closed' || value === 'closed-incomplete') health.status = value
    if (error)
      health.lastError = {
        code: error.code || 'LOG_WRITER_FAILED',
        message: String(error.message || error).slice(0, 240),
        at: Date.now()
      }
    try {
      onHealth(snapshot())
    } catch {
      /* 不递归写日志。 */
    }
  }
  function dropped(entry) {
    queuedBytes -= entry.bytes
    health.droppedRecords++
    health.droppedBytes += entry.bytes
  }
  function checkFlushes() {
    if (!ready) return
    for (const waiting of flushes) {
      if (
        !queue.some((entry) => entry.sequence <= waiting.target) &&
        !inFlight?.entries.some((entry) => entry.sequence <= waiting.target)
      ) {
        clearTimeout(waiting.timer)
        flushes.delete(waiting)
        waiting.resolve(snapshot())
      }
    }
    if (!requests.size) worker?.unref?.()
  }
  function rpc(operation, payload, timeoutMs = 10000) {
    if (!worker || !ready || closed) return Promise.reject(new Error('日志写入器不可用'))
    if (requests.size >= 32) return Promise.reject(new Error('日志请求过多'))
    return new Promise((resolve, reject) => {
      const id = ++requestId
      const timeout = setTimeout(() => {
        requests.delete(id)
        reject(Object.assign(new Error('日志后台操作超时'), { code: 'LOG_WRITER_TIMEOUT' }))
        checkFlushes()
      }, timeoutMs)
      worker.ref?.()
      requests.set(id, { resolve, reject, timeout })
      try {
        worker.postMessage({ id, operation, payload })
      } catch (error) {
        clearTimeout(timeout)
        requests.delete(id)
        reject(error)
      }
    })
  }
  function workerFailed(instance, error) {
    if (instance !== worker || closed) return
    ready = false
    worker = null
    for (const request of requests.values()) {
      clearTimeout(request.timeout)
      request.reject(
        Object.assign(new Error(error.message || '日志线程退出'), { code: 'LOG_WORKER_EXIT' })
      )
    }
    requests.clear()
    terminateWorker(instance)
    status('unavailable', error)
    scheduleRestart()
  }
  function terminateWorker(instance) {
    terminationRequested = true
    let termination
    try {
      termination = instance.terminate()
    } catch (error) {
      termination = Promise.reject(error)
    }
    const pending = Promise.resolve(termination).then(
      (exitCode) => {
        if (exitCode !== undefined) terminationExitCode = exitCode
      },
      (error) => {
        terminationFailures++
        terminationError ??= {
          code: error?.code || 'LOG_WORKER_TERMINATION_FAILED',
          message: String(error?.message || error).slice(0, 240)
        }
      }
    )
    pendingTerminations.add(pending)
    void pending.then(() => pendingTerminations.delete(pending))
  }
  async function finishTerminations(timeoutMs) {
    if (pendingTerminations.size) {
      let timeout
      try {
        // 当前和已失去 worker 字段归属的旧实例共用一份终止等待预算。
        await Promise.race([
          Promise.all([...pendingTerminations]),
          new Promise((resolve) => {
            timeout = setTimeout(resolve, Math.min(1000, Math.max(0, timeoutMs)))
          })
        ])
      } finally {
        clearTimeout(timeout)
      }
    }
    const confirmed = !terminationFailures && !pendingTerminations.size
    return {
      requested: terminationRequested,
      outcome: terminationFailures
        ? 'failed'
        : pendingTerminations.size
          ? 'timed-out'
          : terminationRequested
            ? 'completed'
            : 'not-created',
      confirmed,
      ...(terminationExitCode !== undefined ? { exitCode: terminationExitCode } : {}),
      ...(terminationError ? { error: terminationError } : {})
    }
  }
  function scheduleRestart() {
    if (closed || stopping || worker || restartTimer) return
    // 冷却限制重启频率，但不能让冷却期间的再次失败永久停止恢复。
    restartTimer = setTimeout(
      () => {
        restartTimer = null
        if (closed || stopping || worker) return
        restartAt = Date.now()
        health.workerRestarts++
        start()
      },
      Math.max(1000, 60000 - (Date.now() - restartAt))
    )
    restartTimer.unref?.()
  }
  function start() {
    if (closed || stopping || worker) return
    try {
      const instance = createWorker(workerFile, {
        workerData: { directory, options: workerOptions }
      })
      worker = instance
      instance.on('message', (message) => {
        if (instance !== worker || closed) return
        if (message.ready) {
          ready = true
          status(message.error ? 'degraded' : 'ready', message.error)
          pump()
          return
        }
        const request = requests.get(message.id)
        if (!request) return
        requests.delete(message.id)
        clearTimeout(request.timeout)
        if (message.error)
          request.reject(
            Object.assign(new Error(message.error.message), { code: message.error.code })
          )
        else request.resolve(message.result)
        if (!requests.size) worker?.unref?.()
      })
      instance.on('error', (error) => workerFailed(instance, error))
      instance.on('exit', (code) => workerFailed(instance, new Error(`日志线程退出 (${code})`)))
      instance.unref?.()
    } catch (error) {
      status('unavailable', error)
      scheduleRestart()
    }
  }
  function schedule() {
    if (timer || closed) return
    timer = setTimeout(
      () => {
        timer = null
        pump()
      },
      Math.max(1000, backoffUntil - Date.now())
    )
    timer.unref?.()
  }
  function pump() {
    if (closed || !ready || inFlight || !queue.length) {
      checkFlushes()
      return
    }
    if (Date.now() < backoffUntil) {
      schedule()
      return
    }
    clearTimeout(timer)
    timer = null
    const entries = []
    let bytes = 0
    while (queue.length && entries.length < 128) {
      if (entries.length && bytes + queue[0].bytes > 64 * 1024) break
      const entry = queue.shift()
      entries.push(entry)
      bytes += entry.bytes
    }
    const batch = { entries, bytes }
    inFlight = batch
    rpc(
      'append',
      entries.map((entry) => entry.record)
    )
      .then(
        (result) => {
          queuedBytes -= bytes
          health.lastError = null
          backoffUntil = 0
          if (health.status !== 'ready') status('ready')
          try {
            onBatch(result)
          } catch {
            /* 自监测只做内存聚合。 */
          }
        },
        (error) => {
          if (closed && error.code === 'LOG_WRITER_CLOSED') {
            batch.unconfirmed = true
            return
          }
          health.writeErrors++
          backoffUntil =
            Date.now() + Math.min(30000, 1000 * 2 ** Math.min(5, health.writeErrors - 1))
          const retrying =
            error.code === 'LOG_WORKER_EXIT' && entries.every((entry) => !entry.retried)
          if (retrying) {
            for (const entry of entries) entry.retried = true
            queue.unshift(...entries)
          } else {
            for (const entry of entries) dropped(entry)
          }
          status(error.code === 'LOG_WORKER_EXIT' ? 'unavailable' : 'degraded', error)
          try {
            onBatch({
              records: entries.length,
              bytes: 0,
              errors: 1,
              droppedRecords: retrying ? 0 : entries.length,
              durationMs: 0
            })
          } catch {
            /* 旁路。 */
          }
        }
      )
      .finally(() => {
        if (inFlight === batch) {
          if (batch.unconfirmed) queue.unshift(...entries)
          inFlight = null
        }
        checkFlushes()
        if (queue.some((entry) => entry.sequence <= forceThrough) || queuedBytes >= 64 * 1024)
          pump()
        else if (queue.length) schedule()
      })
  }
  function enqueue(record, priority = 0) {
    if (closed || stopping) return false
    const bytes = estimateDiagnosticBytes(record)
    const capacity =
      DIAGNOSTIC_LIMITS.writerBytes - (priority < 2 ? DIAGNOSTIC_LIMITS.reservedBytes : 0)
    while (queuedBytes + bytes > capacity) {
      const index = queue.findIndex((entry) => entry.priority < priority)
      if (index < 0) {
        health.droppedRecords++
        health.droppedBytes += bytes
        return false
      }
      dropped(queue.splice(index, 1)[0])
    }
    queue.push({ record, priority, bytes, sequence: ++sequence, at: Date.now() })
    queuedBytes += bytes
    health.peakBytes = Math.max(health.peakBytes, queuedBytes)
    if (priority >= 3 || queuedBytes >= 64 * 1024) pump()
    else schedule()
    return true
  }
  function flush(timeoutMs = 5000) {
    const target = sequence
    forceThrough = Math.max(forceThrough, target)
    if (ready && !queue.length && !inFlight) return Promise.resolve(snapshot())
    return new Promise((resolve) => {
      const waiting = { target, resolve, timer: null }
      waiting.timer = setTimeout(() => {
        flushes.delete(waiting)
        resolve({ ...snapshot(), incomplete: true, reason: 'flush-timeout' })
      }, timeoutMs)
      flushes.add(waiting)
      pump()
    })
  }
  start()
  return {
    enqueue,
    flush,
    snapshot,
    async request(operation, payload, timeoutMs) {
      const flushed = await flush()
      if (flushed.incomplete) throw new Error('日志尚未完成写入，请稍后重试')
      return rpc(operation, payload, timeoutMs)
    },
    close(flushTimeoutMs = 1000, { terminateTimeoutMs = 1000 } = {}) {
      if (closePromise) return closePromise
      stopping = true
      clearTimeout(restartTimer)
      restartTimer = null
      closePromise = (async () => {
        const flushed = await flush(flushTimeoutMs)
        closed = true
        ready = false
        clearTimeout(timer)
        timer = null
        for (const pending of requests.values()) {
          clearTimeout(pending.timeout)
          pending.reject(
            Object.assign(new Error('日志写入器已关闭'), { code: 'LOG_WRITER_CLOSED' })
          )
        }
        requests.clear()
        const instance = worker
        worker = null
        if (instance) terminateWorker(instance)
        const termination = await finishTerminations(terminateTimeoutMs)
        status(termination.confirmed ? 'closed' : 'closed-incomplete')
        const final = snapshot()
        const outcome =
          termination.outcome === 'failed'
            ? 'failed'
            : flushed.incomplete || termination.outcome === 'timed-out'
              ? 'timed-out'
              : flushed.status === 'degraded' || final.droppedRecords || final.writeErrors
                ? 'degraded'
                : 'completed'
        return {
          outcome,
          incomplete: outcome !== 'completed',
          flush: flushed,
          termination,
          queuedBytes: final.queuedBytes,
          pendingRecords: final.pendingRecords,
          droppedRecords: final.droppedRecords,
          droppedBytes: final.droppedBytes,
          writeErrors: final.writeErrors
        }
      })()
      return closePromise
    }
  }
}
