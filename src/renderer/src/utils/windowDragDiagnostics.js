import { dailyDiagnosticPolicy, isDeepDiagnostics } from '../../../shared/diagnostic-policy.js'

const FLUSH_INTERVAL_MS = 5000
const MAX_SLOW_SAMPLES = 8
const round = (value) => Math.round(value * 100) / 100

function distribution() {
  return { count: 0, totalMs: 0, maxMs: 0, over16ms: 0, over50ms: 0, over100ms: 0 }
}

function add(value, elapsed) {
  if (!Number.isFinite(elapsed) || elapsed < 0) return
  value.count++
  value.totalMs += elapsed
  value.maxMs = Math.max(value.maxMs, elapsed)
  if (elapsed > 16) value.over16ms++
  if (elapsed > 50) value.over50ms++
  if (elapsed > 100) value.over100ms++
}

function summarize(value) {
  return {
    ...value,
    totalMs: round(value.totalMs),
    maxMs: round(value.maxMs),
    meanMs: value.count ? round(value.totalMs / value.count) : null
  }
}

function retainSlowest(samples, sample, score) {
  const item = { ...sample, scoreMs: round(score) }
  if (samples.length === MAX_SLOW_SAMPLES && item.scoreMs <= samples.at(-1).scoreMs) return
  samples.push(item)
  samples.sort((left, right) => right.scoreMs - left.scoreMs)
  if (samples.length > MAX_SLOW_SAMPLES) samples.pop()
}

// 只观察既有输入/RAF/发送点。不开额外RAF，不按帧写日志，不读取DOM或窗口快照。
export function createWindowDragDiagnostics(options = {}) {
  const api = options.api || globalThis.window?.api
  const clock = options.clock || globalThis.performance
  const nowEpoch = options.nowEpoch || (() => clock.timeOrigin + clock.now())
  const policyNow = options.policyNow || (() => Date.now())
  const readPolicy = options.readPolicy || (() => api?.getDiagnosticPolicy?.())
  const sink = options.sink || ((record) => api?.reportLog?.(record))
  const startInterval = options.setInterval || globalThis.setInterval
  const stopInterval = options.clearInterval || globalThis.clearInterval
  const pageTarget = options.pageTarget || globalThis.window
  let observationFailures = 0
  let policy = dailyDiagnosticPolicy()
  try {
    policy = readPolicy() || policy
  } catch {
    observationFailures++
    // 诊断桥尚未就绪时按日常模式，不阻断标题栏初始化。
  }
  let disposed = false
  let dragId = null
  let seq = 0
  let batch = null
  let timer = null
  let timerGeneration = 0
  let timerFailed = false
  let handshake = null
  let clockBounds = null
  let clockStatus = 'missing-begin-handshake'
  let latestInputAt = null
  let latestEventAt = null
  let latestDispatchAge = null
  let scheduledAt = null
  let pendingPointers = 0
  let lastUpdateAt = null

  const deep = () => {
    try {
      return !disposed && isDeepDiagnostics(policy, policyNow())
    } catch {
      observationFailures++
      return false
    }
  }

  function failObservation() {
    observationFailures++
    clockBounds = null
    handshake = null
    clockStatus = 'observation-unavailable'
    resetPending()
  }

  function observe(work, fallback) {
    return (...args) => {
      try {
        return work(...args)
      } catch {
        failObservation()
        return fallback
      }
    }
  }

  function safely(work) {
    try {
      return work()
    } catch {
      observationFailures++
      return undefined
    }
  }

  function clockValue(read) {
    const value = safely(read)
    return Number.isFinite(value) ? value : null
  }

  function resetPending() {
    latestInputAt = null
    latestEventAt = null
    latestDispatchAge = null
    scheduledAt = null
    pendingPointers = 0
    lastUpdateAt = null
  }

  function stopTimer() {
    const currentTimer = timer
    timer = null
    timerGeneration++
    if (currentTimer !== null) safely(() => stopInterval(currentTimer))
  }

  function createBatch() {
    const startedAt = clock.now()
    batch = {
      dragId,
      captureId: policy.captureId,
      sourcePolicyEpoch: policy.policyEpoch,
      startedAt,
      intervalStart: nowEpoch(),
      pointerMoves: 0,
      updates: 0,
      finalUpdates: 0,
      coalescedPointers: 0,
      cancelledFrames: 0,
      invalidEventTimestamps: 0,
      dispatchAge: distribution(),
      scheduleWait: distribution(),
      latestPointerAge: distribution(),
      updateIntervals: distribution(),
      beginRoundTrip: distribution(),
      seqFirst: null,
      seqLast: null,
      slowestSamples: []
    }
  }

  function flush(reason = 'interval') {
    if (!batch) return
    const current = batch
    batch = null
    if (
      !current.pointerMoves &&
      !current.updates &&
      !current.beginRoundTrip.count &&
      !current.cancelledFrames
    )
      return
    // 卸载/结束时钟可能已不可用，仍尽力提交已有聚合，时间字段明确unknown。
    const endedAt = clockValue(() => clock.now())
    const intervalEnd = clockValue(nowEpoch)
    try {
      const pending = sink({
        level: 'info',
        kind: 'metric',
        scope: 'performance.window-drag-renderer',
        message: '窗口拖动渲染侧耗时汇总',
        // 尾批可能在退出deep后提交，不能标detail:true而被运输层丢弃。
        metadata: {
          schemaVersion: 1,
          collectedMode: 'deep',
          flushReason: reason,
          dragId: current.dragId,
          captureId: current.captureId,
          sourcePolicyEpoch: current.sourcePolicyEpoch,
          intervalStart: current.intervalStart,
          intervalEnd,
          durationMs: endedAt === null ? null : round(Math.max(0, endedAt - current.startedAt)),
          observationFailures,
          pointerMoves: current.pointerMoves,
          updates: current.updates,
          finalUpdates: current.finalUpdates,
          coalescedPointers: current.coalescedPointers,
          cancelledFrames: current.cancelledFrames,
          invalidEventTimestamps: current.invalidEventTimestamps,
          dispatchAge: summarize(current.dispatchAge),
          scheduleWait: summarize(current.scheduleWait),
          latestPointerAge: summarize(current.latestPointerAge),
          updateIntervals: summarize(current.updateIntervals),
          beginRoundTrip: summarize(current.beginRoundTrip),
          clockStatus,
          clockOffsetLowMs: clockBounds?.low ?? null,
          clockOffsetHighMs: clockBounds?.high ?? null,
          seqFirst: current.seqFirst,
          seqLast: current.seqLast,
          slowestSamples: current.slowestSamples,
          updateIntervalIsNotPresentationFps: true,
          dispatchAgeExcludesOsInputDelivery: true,
          latestPointerAgeIncludesDispatch: true
        }
      })
      pending?.catch?.(() => {
        observationFailures++
      })
    } catch {
      observationFailures++
      // 诊断失败不能阻断窗口移动。
    }
  }

  function armTimer() {
    stopTimer()
    if (!dragId || !deep()) return
    const generation = timerGeneration
    const callback = observe(() => {
      // clearInterval异常时，旧回调仍必须成为无操作，不能采到新事务。
      if (generation !== timerGeneration || disposed || !dragId) return
      if (!deep()) {
        flush('policy-expired')
        stopTimer()
        resetPending()
        clockBounds = null
        handshake = null
        clockStatus = 'missing-begin-handshake'
      } else flush('interval')
    })
    try {
      timer = startInterval(callback, FLUSH_INTERVAL_MS)
    } catch {
      observationFailures++
      timerFailed = true
    }
  }

  function changePolicy(next) {
    if (disposed || !next) return
    const sameCapture =
      policy.mode === next.mode &&
      policy.captureId === next.captureId &&
      policy.policyEpoch === next.policyEpoch
    if (!sameCapture) {
      flush('policy-change')
      resetPending()
      clockBounds = null
      handshake = null
      clockStatus = 'missing-begin-handshake'
      timerFailed = false
    }
    policy = next
    if (!sameCapture || timer === null || !deep()) armTimer()
  }

  function collecting() {
    if (!dragId || !deep()) {
      if (batch) flush('policy-expired')
      if (!deep()) {
        stopTimer()
        resetPending()
        clockBounds = null
        handshake = null
        clockStatus = 'missing-begin-handshake'
      }
      return false
    }
    if (!batch) createBatch()
    if (timer === null && !timerFailed) armTimer()
    return true
  }

  function begin(nextDragId) {
    flush('next-drag')
    stopTimer()
    dragId = nextDragId
    seq = 0
    timerFailed = false
    handshake = null
    clockBounds = null
    clockStatus = 'missing-begin-handshake'
    resetPending()
    if (!collecting()) return undefined
    const sentAt = nowEpoch()
    handshake = { dragId, sentAt, captureId: policy.captureId, policyEpoch: policy.policyEpoch }
    clockStatus = 'clock-calibration-pending'
    return { version: 1, sentAt }
  }

  function beginAccepted(result) {
    try {
      return result === true || result?.started === true
    } catch {
      observationFailures++
      return false
    }
  }

  function acceptBegin(result, responseDragId) {
    // 兼容旧bool；不能将{started:false}当truthy成功。
    const started = beginAccepted(result)
    try {
      calibrateBegin(result, responseDragId, started)
    } catch {
      failObservation()
    }
    return started
  }

  function calibrateBegin(result, responseDragId, started) {
    if (!started || responseDragId !== dragId || !handshake || !collecting()) return
    const receivedAt = nowEpoch()
    add(batch.beginRoundTrip, receivedAt - handshake.sentAt)
    const response = result?.diagnosticClock
    const low = response?.mainSentAt - receivedAt
    const high = response?.mainReceivedAt - handshake.sentAt
    if (
      response?.version === 1 &&
      Number.isFinite(response.mainReceivedAt) &&
      Number.isFinite(response.mainSentAt) &&
      response.mainSentAt >= response.mainReceivedAt &&
      Number.isFinite(low) &&
      Number.isFinite(high) &&
      low <= high
    ) {
      // 区间来自一次往返因果边界；不假定两端performance timeOrigin完全一致。
      clockBounds = { low, high }
      clockStatus = 'calibrated'
    } else clockStatus = response ? 'invalid-handshake' : 'missing-main-handshake'
    handshake = null
  }

  function recordPointer(event) {
    if (!collecting()) return
    const now = clock.now()
    batch.pointerMoves++
    pendingPointers++
    latestInputAt = now
    // Chromium事件时间戳同源；epoch/缺失/未来时间戳只能记unknown。
    const stamp = event?.timeStamp
    latestDispatchAge = Number.isFinite(stamp) && stamp > 0 && stamp <= now ? now - stamp : null
    latestEventAt = latestDispatchAge === null ? null : stamp
    if (latestDispatchAge === null) batch.invalidEventTimestamps++
    else add(batch.dispatchAge, latestDispatchAge)
  }

  function scheduleFrame() {
    if (collecting()) scheduledAt = clock.now()
  }

  function cancelFrame() {
    try {
      if (collecting() && scheduledAt !== null) batch.cancelledFrames++
    } finally {
      scheduledAt = null
    }
  }

  function createUpdatePacket({ source = 'raf', dragId: expectedDragId } = {}) {
    if (expectedDragId !== undefined && expectedDragId !== dragId) return undefined
    if (!collecting()) return undefined
    const now = clock.now()
    const sentAt = nowEpoch()
    const scheduleWait =
      source === 'raf' && scheduledAt !== null ? Math.max(0, now - scheduledAt) : null
    const latestPointerAge = latestEventAt !== null ? Math.max(0, now - latestEventAt) : null
    const interval = lastUpdateAt !== null ? Math.max(0, now - lastUpdateAt) : null
    add(batch.scheduleWait, scheduleWait)
    add(batch.latestPointerAge, latestPointerAge)
    add(batch.updateIntervals, interval)
    batch.updates++
    if (source !== 'raf') batch.finalUpdates++
    const coalescedPointers = Math.max(0, pendingPointers - 1)
    batch.coalescedPointers += coalescedPointers
    const updateSeq = ++seq
    if (batch.seqFirst === null) batch.seqFirst = updateSeq
    batch.seqLast = updateSeq
    retainSlowest(
      batch.slowestSamples,
      {
        seq: updateSeq,
        sentAt,
        source,
        dispatchAgeMs: latestDispatchAge === null ? null : round(latestDispatchAge),
        scheduleWaitMs: scheduleWait === null ? null : round(scheduleWait),
        latestPointerAgeMs: latestPointerAge === null ? null : round(latestPointerAge),
        dispatchToSendMs: latestInputAt === null ? null : round(Math.max(0, now - latestInputAt)),
        updateIntervalMs: interval === null ? null : round(interval),
        coalescedPointers
      },
      Math.max(scheduleWait || 0, latestPointerAge || 0, interval || 0, latestDispatchAge || 0)
    )
    scheduledAt = null
    pendingPointers = 0
    lastUpdateAt = now
    return {
      version: 1,
      dragId,
      captureId: policy.captureId,
      policyEpoch: policy.policyEpoch,
      seq: updateSeq,
      sentAt,
      clockOffsetLowMs: clockBounds?.low ?? null,
      clockOffsetHighMs: clockBounds?.high ?? null
    }
  }

  function end(reason = 'drag-ended', expectedDragId) {
    if (expectedDragId !== undefined && expectedDragId !== dragId) return
    try {
      flush(reason)
    } finally {
      stopTimer()
      dragId = null
      handshake = null
      clockBounds = null
      resetPending()
    }
  }

  let unsubscribePolicy
  let unsubscribeFlush
  // 每项独立隔离；一项可选注册失败不能跳过其余生命周期能力。
  unsubscribePolicy = safely(() => api?.onDiagnosticPolicy?.(observe(changePolicy)))
  unsubscribeFlush = safely(() => api?.onDiagnosticFlush?.(observe(() => flush('export'))))
  safely(() => api?.registerDiagnosticCapability?.('renderer-window-drag'))
  function dispose() {
    if (disposed) return
    try {
      end('dispose')
    } finally {
      disposed = true
      safely(() => unsubscribePolicy?.())
      safely(() => unsubscribeFlush?.())
      safely(() => pageTarget?.removeEventListener?.('pagehide', safeDispose))
    }
  }
  const safeDispose = observe(dispose)
  safely(() => pageTarget?.addEventListener?.('pagehide', safeDispose))
  return {
    begin: observe(begin),
    acceptBegin,
    recordPointer: observe(recordPointer),
    scheduleFrame: observe(scheduleFrame),
    cancelFrame: observe(cancelFrame),
    createUpdatePacket: observe(createUpdatePacket),
    end: observe(end),
    flush: observe(flush),
    dispose: safeDispose
  }
}
