import { performance } from 'node:perf_hooks'
import { drainOperationPerformance } from './operation-performance.js'
import { diagnosticState } from './diagnostic-state.js'

const IDLE_REPORT_MS = 30000
const GAP_MS = 15000
const round = (value) => Math.round(value * 10) / 10
const COUNTERS = [
  'syncRequestCount',
  'syncPostCount',
  'anchorCheckCount',
  'anchorNoopCount',
  'anchorApplyCount'
]

// 常驻的只有 1 秒一次轻量时钟检查；资源/原生状态最多每 5 秒读取一次。
// 不调用 WMI、PowerShell、getGPUInfo，也不做逐帧 IPC 或磁盘写入。
export function startPerformanceDiagnostics({
  app,
  powerMonitor,
  readWindowState,
  readNativeState,
  writeLog,
  state = diagnosticState,
  drainOperations = drainOperationPerformance,
  now = () => performance.now(),
  wallNow = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval
}) {
  let policy = state.get()
  let sampleInterval = policy.sampleIntervalMs
  let exportRequestId
  let stopped = false
  let lastTick = now()
  let lastSampleAt = -Infinity
  let lastReportAt = -Infinity
  let activeUntil = 0
  let previousProcesses = new Map()
  let previousNative = null
  let lag = { count: 0, totalMs: 0, maxMs: 0, over100ms: 0 }
  let latest = null
  let lastRendererReport = null
  let slowCollections = 0
  const paused = new Set()
  const recent = []
  const recentOperations = []
  const listeners = []

  function emit(scope, metadata, level = 'info') {
    try {
      writeLog({
        scope,
        message: scope,
        level,
        exportRequestId,
        metadata: { mode: policy.mode, policyEpoch: policy.policyEpoch, ...metadata }
      })
    } catch {
      /* 诊断旁路。 */
    }
  }
  function resetBaselines() {
    lastTick = now()
    lastSampleAt = -Infinity
    previousProcesses.clear()
    previousNative = null
    lag = { count: 0, totalMs: 0, maxMs: 0, over100ms: 0 }
  }

  function reportOperations(reason) {
    try {
      const batch = drainOperations()
      if (!batch.entries.length && !batch.omitted) return
      const metadata = { schemaVersion: 1, reason, ...batch }
      recentOperations.push(metadata)
      if (recentOperations.length > 3) recentOperations.shift()
      emit('performance.operations', metadata, 'info')
    } catch {
      /* 归因统计不阻断资源采样或导出。 */
    }
  }

  function sample(reason = 'interval') {
    if (stopped || paused.size) return latest
    const current = now()
    if (current - lastSampleAt < sampleInterval) {
      if (reason === 'export' && latest)
        emit('performance.main', { ...latest, reason, cached: true, pendingLoopDelay: { ...lag } })
      return latest
    }
    const errors = []
    const attempt = (field, callback) => {
      try {
        return callback()
      } catch (error) {
        errors.push({ field, message: String(error?.message || error).slice(0, 160) })
        return null
      }
    }
    const windowState = attempt('window', readWindowState)
    const visible = windowState?.visible && !windowState?.minimized
    if (!visible && reason !== 'export') {
      resetBaselines()
      return latest
    }
    const metrics = attempt('processes', () => app.getAppMetrics())
    const nextProcesses = new Map()
    const processes =
      metrics?.slice(0, 32).map((metric) => {
        const cumulative = metric.cpu?.cumulativeCPUUsage
        const previous = previousProcesses.get(metric.pid)
        const elapsed = previous ? current - previous.at : 0
        // 使用累计 CPU 的差值，避免其他 getAppMetrics 调用改变百分比采样窗口。
        const valid =
          previous &&
          elapsed > 0 &&
          elapsed <= Math.max(GAP_MS, sampleInterval * 2.5) &&
          metric.creationTime === previous.creationTime &&
          Number.isFinite(cumulative) &&
          cumulative >= previous.cpu
        nextProcesses.set(metric.pid, {
          at: current,
          cpu: cumulative,
          creationTime: metric.creationTime
        })
        return {
          pid: metric.pid,
          type: metric.type,
          cpuPercentOneCore: valid ? round(((cumulative - previous.cpu) * 100000) / elapsed) : null,
          cumulativeCpuSeconds: cumulative ?? null,
          workingSetKiB: metric.memory?.workingSetSize ?? null,
          privateKiB: metric.memory?.privateBytes ?? null
        }
      }) ?? null
    previousProcesses = nextProcesses
    const native = attempt('nativeZOrder', readNativeState)
    let nativeCounterDelta = null
    if (
      native &&
      previousNative &&
      current - previousNative.at <= Math.max(GAP_MS, sampleInterval * 2.5) &&
      previousNative.windowId === windowState?.id
    ) {
      nativeCounterDelta = Object.fromEntries(
        COUNTERS.map((key) => {
          const delta = native[key] - previousNative.value[key]
          return [key, Number.isFinite(delta) && delta >= 0 ? delta : null]
        })
      )
    }
    const sampleDurationMs = Number.isFinite(lastSampleAt) ? current - lastSampleAt : null
    previousNative = native ? { value: native, at: current, windowId: windowState?.id } : null
    lastSampleAt = current
    latest = {
      schemaVersion: 1,
      capturedAt: new Date(wallNow()).toISOString(),
      reason,
      sampleDurationMs: sampleDurationMs === null ? null : round(sampleDurationMs),
      mainLoopDelay: {
        samples: lag.count,
        maxMs: round(lag.maxMs),
        meanMs: lag.count ? round(lag.totalMs / lag.count) : null,
        over100ms: lag.over100ms
      },
      window: windowState,
      processes,
      nativeZOrder: native,
      nativeCounterDelta,
      lastRendererReport,
      collectionDurationMs: round(now() - current),
      collectionErrors: errors
    }
    slowCollections = latest.collectionDurationMs >= 20 ? slowCollections + 1 : 0
    if (policy.mode === 'deep' && slowCollections >= 3) state.stop('collector-cost')
    lag = { count: 0, totalMs: 0, maxMs: 0, over100ms: 0 }
    recent.push(latest)
    if (recent.length > 12) recent.shift()
    if (
      reason === 'export' ||
      current <= activeUntil ||
      current - lastReportAt >= IDLE_REPORT_MS ||
      latest.mainLoopDelay.over100ms > 0
    ) {
      lastReportAt = current
      emit('performance.main', latest, latest.mainLoopDelay.over100ms > 0 ? 'warn' : 'info')
      reportOperations(reason)
    }
    return latest
  }

  function tick() {
    if (stopped) return
    const current = now()
    const elapsed = current - lastTick
    lastTick = current
    if (paused.size) return
    if (elapsed > GAP_MS || elapsed < 0) {
      emit('performance.observation-gap', {
        elapsedMs: round(elapsed),
        reason: 'clock-or-scheduling-gap',
        excludedFromLoopDelay: true
      })
      resetBaselines()
    } else {
      const delay = Math.max(0, elapsed - 1000)
      lag.count++
      lag.totalMs += delay
      lag.maxMs = Math.max(lag.maxMs, delay)
      if (delay > 100) lag.over100ms++
      if (delay >= 1000)
        emit('performance.main-stall', { delayMs: round(delay), intervalMs: elapsed }, 'warn')
    }
    sample()
  }

  function observeRenderer(record, senderId) {
    if (stopped || !['performance.renderer', 'performance.render-work'].includes(record.scope))
      return
    activeUntil = now() + 10000
    lastRendererReport = { webContentsId: senderId, receivedAt: new Date(wallNow()).toISOString() }
  }

  for (const [event, key, pause] of [
    ['suspend', 'suspend', true],
    ['resume', 'suspend', false],
    ['lock-screen', 'lock', true],
    ['unlock-screen', 'lock', false]
  ]) {
    const listener = () => {
      if (pause) paused.add(key)
      else paused.delete(key)
      resetBaselines()
      emit('performance.lifecycle', { event, paused: [...paused] })
    }
    powerMonitor.on(event, listener)
    listeners.push([event, listener])
  }
  const timer = setTimer(() => {
    try {
      tick()
    } catch {
      /* 采集失败不影响主进程。 */
    }
  }, 1000)
  timer.unref?.()
  const unsubscribePolicy = state.subscribe((next) => {
    reportOperations('mode-change')
    policy = next
    sampleInterval = next.sampleIntervalMs
    resetBaselines()
  })
  function stop() {
    if (stopped) return
    reportOperations('quit')
    stopped = true
    clearTimer(timer)
    unsubscribePolicy()
    for (const [event, listener] of listeners) powerMonitor.removeListener(event, listener)
    app.removeListener('will-quit', stop)
  }
  app.once('will-quit', stop)
  return {
    observeRenderer,
    flush: (requestId) => {
      exportRequestId = requestId
      try {
        // 即使资源采样仍在限频窗口内，也提交未满一个周期的操作统计。
        reportOperations('export')
        return sample('export')
      } catch {
        return latest
      } finally {
        exportRequestId = undefined
      }
    },
    snapshot: () => ({
      mode: policy.mode,
      sampleIntervalMs: sampleInterval,
      idleReportIntervalMs: IDLE_REPORT_MS,
      cpuUnit: 'percent-of-one-logical-core',
      gpuProcessCpuIsNotGpuUtilization: true,
      paused: [...paused],
      recentSamples: recent.slice(),
      recentOperations: recentOperations.slice()
    }),
    stop
  }
}
