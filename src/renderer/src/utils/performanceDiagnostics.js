// 本地诊断：被动观察输入和帧回调，不改变滚动行为、不读取页面正文。
import { createPerformanceAggregates } from '../../../shared/performance-aggregates.js'
import { isDetailedOperation, isDeepDiagnostics } from '../../../shared/diagnostic-policy.js'
import { rendererDiagnosticPolicy } from './diagnosticPolicy.js'
const monitors = new WeakMap()
const ACTIVE_MS = 1500
const GAP_MS = 15000

function counter() {
  return { count: 0, totalMs: 0, maxMs: 0, over50ms: 0, over100ms: 0, over250ms: 0 }
}

function add(counter, value) {
  if (!Number.isFinite(value) || value < 0) return
  counter.count++
  counter.totalMs += value
  counter.maxMs = Math.max(counter.maxMs, value)
  if (value > 50) counter.over50ms++
  if (value > 100) counter.over100ms++
  if (value > 250) counter.over250ms++
}

const rounded = (value) => Math.round(value * 10) / 10
function summary(value) {
  return {
    ...value,
    totalMs: rounded(value.totalMs),
    maxMs: rounded(value.maxMs),
    meanMs: value.count ? rounded(value.totalMs / value.count) : null
  }
}

export function installRendererPerformanceDiagnostics(api, environment = {}) {
  const win = environment.window || globalThis.window
  const doc = environment.document || globalThis.document
  const clock = environment.performance || globalThis.performance
  const Observer = environment.PerformanceObserver || win?.PerformanceObserver
  if (!win?.requestAnimationFrame || !doc?.addEventListener || !clock?.now || !api?.reportLog)
    return { flush() {}, dispose() {} }
  if (monitors.has(win)) return monitors.get(win)

  let policy = rendererDiagnosticPolicy(api)
  const deep = () => isDeepDiagnostics(policy)
  let lastProbe = -Infinity
  let timer
  let disposed = false
  let observer = null
  let observerStatus = 'unsupported'
  let frame = null
  let lastFrame = null
  let firstInput = null
  let activeUntil = 0
  let visibleSince = clock.now()
  let batch
  const work = createPerformanceAggregates({ now: () => clock.now(), maxEntries: 48 })
  let refreshFrame = null
  let finishRefreshFrame = null
  let coalescedFrames = 0

  function reset() {
    batch = {
      started: clock.now(),
      wheelEvents: 0,
      scrollEvents: 0,
      pointerEvents: 0,
      inputDelay: counter(),
      firstFrameDelay: counter(),
      frameIntervals: counter(),
      longTasks: counter(),
      samplingGaps: 0,
      maxSamplingGapMs: 0
    }
  }
  reset()

  function report(scope, metadata, level = 'info') {
    try {
      const pending = api.reportLog({
        level,
        scope,
        message: scope,
        metadata: {
          schemaVersion: 1,
          page: win.location?.pathname?.split('/').at(-1),
          timeOrigin: clock.timeOrigin,
          visibility: doc.visibilityState,
          mode: deep() ? 'deep' : 'daily',
          policyEpoch: policy.policyEpoch,
          focused: doc.hasFocus?.() ?? null,
          ...metadata
        }
      })
      pending?.catch?.(() => {})
    } catch {
      /* 诊断不可中断输入。 */
    }
  }

  function collectLongTasks(entries) {
    if (disposed || doc.visibilityState !== 'visible') return
    for (const entry of entries) {
      // visibilitychange 之前排队的记录不能归到新的一段前台交互。
      if (entry.startTime >= visibleSince) add(batch.longTasks, entry.duration)
    }
  }

  function flush(reason = 'interval') {
    if (disposed) return
    const operations = work.drain()
    if (operations.entries.length || operations.omitted) {
      const collectionStarted = clock.now()
      let dom = null
      try {
        // 只在汇总时读取结构数量，不遍历文本、不读取样式或逐帧扫描 DOM。
        if (deep())
          dom = {
            noteCards: doc.querySelectorAll?.('.nl-card').length ?? null,
            calendarSegments: doc.querySelectorAll?.('.month-event-bar').length ?? null,
            images: doc.images?.length ?? null
          }
      } catch {
        /* 页面卸载期间允许无法读取数量。 */
      }
      report('performance.render-work', {
        reason,
        ...operations,
        dom,
        collectionDurationMs: rounded(clock.now() - collectionStarted),
        nextFrameIsNotPaint: true
      })
    }
    try {
      collectLongTasks(observer?.takeRecords?.() || [])
    } catch {
      /* 浏览器可不支持 takeRecords。 */
    }
    const current = batch
    const end = clock.now()
    reset()
    if (
      !current.wheelEvents &&
      !current.scrollEvents &&
      !current.pointerEvents &&
      !current.frameIntervals.count &&
      !current.longTasks.count &&
      !current.samplingGaps
    )
      return
    const interrupted = reason === 'hidden' || current.samplingGaps > 0
    const slow =
      !interrupted &&
      (current.frameIntervals.over100ms > 0 ||
        current.inputDelay.over100ms > 0 ||
        current.firstFrameDelay.over100ms > 0 ||
        current.longTasks.over100ms > 0)
    report(
      'performance.renderer',
      {
        reason,
        intervalStart: new Date(clock.timeOrigin + current.started).toISOString(),
        intervalEnd: new Date(clock.timeOrigin + end).toISOString(),
        durationMs: rounded(end - current.started),
        wheelEvents: current.wheelEvents,
        scrollEvents: current.scrollEvents,
        pointerEvents: current.pointerEvents,
        inputDelay: summary(current.inputDelay),
        firstFrameDelay: summary(current.firstFrameDelay),
        frameIntervals: summary(current.frameIntervals),
        // rAF 回调频率不是显示器实际呈现帧率，不能单凭它认定 GPU 故障。
        frameCallbackHz:
          current.frameIntervals.totalMs > 0
            ? rounded((current.frameIntervals.count * 1000) / current.frameIntervals.totalMs)
            : null,
        longTasks: { status: observerStatus, ...summary(current.longTasks) },
        samplingGaps: current.samplingGaps,
        maxSamplingGapMs: rounded(current.maxSamplingGapMs),
        interrupted
      },
      slow ? 'warn' : 'info'
    )
  }

  function recordFrame() {
    frame = null
    if (disposed || doc.visibilityState !== 'visible') return
    const now = clock.now()
    const gap = now - (lastFrame ?? firstInput ?? now)
    if (gap > GAP_MS) {
      // 无法仅凭超长间隔区分休眠、调试暂停和严重卡死；保留间隔但不计作掉帧。
      batch.samplingGaps++
      batch.maxSamplingGapMs = Math.max(batch.maxSamplingGapMs, gap)
    } else {
      if (lastFrame !== null) add(batch.frameIntervals, now - lastFrame)
      if (firstInput !== null) add(batch.firstFrameDelay, now - firstInput)
    }
    firstInput = null
    lastFrame = now
    if (deep() && now < activeUntil) frame = win.requestAnimationFrame(recordFrame)
    else lastFrame = null
  }

  function onActivity(event) {
    if (disposed || doc.visibilityState !== 'visible') return
    const now = clock.now()
    if (event.type === 'wheel') {
      batch.wheelEvents++
      // Chromium 的事件时间戳与 performance.now 同源；不把 epoch 时间戳当延迟。
      if (event.timeStamp > 0 && event.timeStamp <= now)
        add(batch.inputDelay, now - event.timeStamp)
    } else if (event.type === 'scroll') batch.scrollEvents++
    else batch.pointerEvents++
    if (!deep() && now - lastProbe < 1000) return
    activeUntil = now + ACTIVE_MS
    if (firstInput === null && event.type !== 'scroll') firstInput = now
    if (frame === null) {
      lastProbe = now
      frame = win.requestAnimationFrame(recordFrame)
    }
  }

  function stopFrames() {
    if (frame !== null) win.cancelAnimationFrame(frame)
    frame = null
    lastFrame = null
    firstInput = null
    activeUntil = 0
    if (refreshFrame !== null) win.cancelAnimationFrame(refreshFrame)
    refreshFrame = null
    finishRefreshFrame?.({ interrupted: 1, coalesced: coalescedFrames })
    finishRefreshFrame = null
    coalescedFrames = 0
  }

  function visibilityChanged() {
    stopFrames()
    if (doc.visibilityState !== 'visible') flush('hidden')
    reset()
    visibleSince = clock.now()
  }

  function dispose() {
    if (disposed) return
    stopFrames()
    flush('pagehide')
    disposed = true
    win.clearInterval(timer)
    unsubscribePolicy?.()
    unsubscribeFlush?.()
    observer?.disconnect()
    for (const name of ['wheel', 'scroll', 'pointerdown'])
      doc.removeEventListener(name, onActivity, true)
    doc.removeEventListener('visibilitychange', visibilityChanged)
    win.removeEventListener('pagehide', dispose)
    monitors.delete(win)
  }

  try {
    if (Observer?.supportedEntryTypes?.includes('longtask')) {
      observer = new Observer((list) => collectLongTasks(list.getEntries()))
      observer.observe({ type: 'longtask' })
      observerStatus = 'observing'
    }
  } catch {
    observer?.disconnect()
    observer = null
    observerStatus = 'unavailable'
  }
  for (const name of ['wheel', 'scroll', 'pointerdown'])
    doc.addEventListener(name, onActivity, { passive: true, capture: true })
  doc.addEventListener('visibilitychange', visibilityChanged)
  win.addEventListener('pagehide', dispose)
  const armTimer = () => {
    win.clearInterval(timer)
    timer = win.setInterval(
      () => {
        if (policy.mode === 'deep' && !deep())
          changePolicy({ ...policy, mode: 'daily', sampleIntervalMs: 30000 })
        else flush()
      },
      deep() ? 5000 : 30000
    )
  }
  const changePolicy = (next) => {
    stopFrames()
    flush('mode-change')
    policy = next
    lastProbe = -Infinity
    reset()
    armTimer()
  }
  armTimer()
  const unsubscribePolicy = api.onDiagnosticPolicy?.(changePolicy)
  const unsubscribeFlush = api.onDiagnosticFlush?.(() => flush('export'))
  api.registerDiagnosticCapability?.('renderer-performance')
  const monitor = {
    flush,
    dispose,
    beginWork: (operation) =>
      !isDetailedOperation('renderer', operation) || deep()
        ? work.begin('renderer', operation)
        : () => {},
    recordWork: (operation, metrics) => {
      if (!isDetailedOperation('renderer', operation) || deep())
        work.record('renderer', operation, 0, metrics)
    },
    dataApplied: (view) => {
      if (!deep()) return
      if (doc.visibilityState !== 'visible') {
        work.record('renderer', `refresh.frame-skipped.${view}`, 0, { hidden: 1 })
        return
      }
      if (refreshFrame !== null) {
        coalescedFrames++
        return
      }
      finishRefreshFrame = work.begin('renderer', `refresh.next-frame.${view}`)
      refreshFrame = win.requestAnimationFrame(() => {
        refreshFrame = null
        finishRefreshFrame?.({ coalesced: coalescedFrames })
        finishRefreshFrame = null
        coalescedFrames = 0
      })
    }
  }
  monitors.set(win, monitor)
  report('performance.renderer-ready', {
    reportIntervalMs: deep() ? 5000 : 30000,
    activeFrameWindowMs: ACTIVE_MS,
    longTaskObserver: observerStatus,
    frameSampling: deep() ? 'interaction-only' : 'one-probe-per-second'
  })
  return monitor
}

export function beginRendererWork(operation, win = globalThis.window) {
  return monitors.get(win)?.beginWork(operation) || (() => {})
}

export function recordRendererWork(operation, metrics = {}, win = globalThis.window) {
  monitors.get(win)?.recordWork(operation, metrics)
}

export function recordRefreshDataApplied(view, win = globalThis.window) {
  try {
    monitors.get(win)?.dataApplied(view)
  } catch {
    /* 诊断旁路。 */
  }
}

export function measureRendererLayout(operation, work) {
  const finish = beginRendererWork(operation)
  try {
    return work()
  } finally {
    finish()
  }
}

export function flushRendererPerformanceDiagnostics(reason = 'export', win = globalThis.window) {
  try {
    monitors.get(win)?.flush(reason)
  } catch {
    /* 性能采集失败不能阻断日志导出。 */
  }
}
