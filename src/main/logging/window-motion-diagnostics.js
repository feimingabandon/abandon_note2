import { diagnosticState } from './diagnostic-state.js'
import { writeLog } from './logger.js'
import { isDeepDiagnostics } from '../../shared/diagnostic-policy.js'
import { createWindowMotionMetrics } from '../../shared/window-motion-metrics.js'

const hasObservations = (batch) =>
  Object.keys(batch.stages || {}).length ||
  Object.keys(batch.counters || {}).length ||
  batch.omitted

// Active operations can be shorter than the periodic batch interval. Export must
// drain them before its storage snapshot and retain the export cutoff identity.
const activeRecorders = new Set()

export function createWindowMotionRecorder({
  scope,
  context = {},
  state = diagnosticState,
  now = () => performance.now(),
  wallNow = Date.now,
  emit = writeLog,
  setTimer = setInterval,
  clearTimer = clearInterval
}) {
  let policy = null
  let metrics = createWindowMotionMetrics()
  let timer = null
  let intervalStartedAt = null
  let disposed = false
  let failed = false
  let unsubscribe = () => {}
  function clearCollectionTimer() {
    const previous = timer
    timer = null
    try {
      clearTimer(previous)
    } catch {
      /* A failed observer cleanup must not interrupt movement cleanup. */
    }
  }
  function failCollection() {
    if (!failed) {
      try {
        emit({
          level: 'warn',
          scope: 'window.motion-diagnostics',
          message: '窗口运动计量暂不可用，业务移动不受影响',
          metadata: {
            sourceScope: scope,
            captureId: policy?.captureId,
            observation: 'unavailable'
          }
        })
      } catch {
        /* A failed log sink cannot change the original movement result. */
      }
    }
    failed = true
    policy = null
    clearCollectionTimer()
    try {
      metrics.drain()
    } catch {
      /* Drop an unreadable observation instead of affecting the operation. */
    }
  }
  function flush(reason, exportRequestId) {
    try {
      const batch = metrics.drain()
      if (!policy || !hasObservations(batch)) return
      const at = wallNow()
      if (!Number.isFinite(at)) return failCollection()
      emit({
        kind: 'metric',
        scope,
        message: '窗口运动分阶段计量',
        exportRequestId,
        // Trusted main-process collection policy preserves the final deep batch on stop.
        collectionPolicy: policy,
        metadata: {
          schemaVersion: 1,
          ...context,
          collectedMode: 'deep',
          captureId: policy.captureId,
          collectionPolicyEpoch: policy.policyEpoch,
          intervalStartedAt,
          intervalFinishedAt: at,
          reason,
          evidenceBoundary: 'callback-and-HWND-api-state-not-presented-pixels',
          ...batch
        }
      })
      intervalStartedAt = at
    } catch {
      /* Diagnostics must not replace a movement result or exception. */
    }
  }
  function change(next) {
    if (disposed || failed) return
    try {
      const at = wallNow()
      if (!Number.isFinite(at)) return failCollection()
      const deep = isDeepDiagnostics(next, at)
      if (policy && (!deep || policy.captureId !== next.captureId)) {
        flush(deep ? 'capture-change' : 'mode-stop')
        policy = null
        clearCollectionTimer()
      }
      if (deep) {
        policy = { ...next }
        if (!timer) {
          intervalStartedAt = at
          timer = setTimer(() => {
            if (disposed || failed) return
            try {
              change(state.get())
              if (policy) flush('interval')
            } catch {
              failCollection()
            }
          }, 5000)
          timer?.unref?.()
        }
      }
    } catch {
      failCollection()
    }
  }
  try {
    change(state.get())
    const cleanup = state.subscribe(change)
    if (typeof cleanup === 'function') unsubscribe = cleanup
  } catch {
    failCollection()
  }
  function enabled() {
    if (disposed || failed) return false
    try {
      change(state.get())
      return Boolean(policy)
    } catch {
      failCollection()
      return false
    }
  }
  const recorder = {
    stamp() {
      if (!enabled()) return null
      try {
        const at = now()
        if (Number.isFinite(at)) return at
      } catch {
        /* A clock failure means missing timing evidence, not a failed move. */
      }
      failCollection()
      return null
    },
    add(name, duration) {
      try {
        if (enabled()) metrics.add(name, duration)
      } catch {
        failCollection()
      }
    },
    count(name, value) {
      try {
        if (enabled()) metrics.count(name, value)
      } catch {
        failCollection()
      }
    },
    sample(duration, values) {
      try {
        if (enabled()) metrics.sample(duration, values)
      } catch {
        failCollection()
      }
    },
    flush,
    finish(reason = 'end') {
      if (disposed) return
      disposed = true
      activeRecorders.delete(recorder)
      flush(reason)
      clearCollectionTimer()
      try {
        unsubscribe()
      } catch {
        /* The subscription may already have been released. */
      }
      policy = null
    }
  }
  activeRecorders.add(recorder)
  return recorder
}

let nativeCollector = null
export function registerNativeMotionDiagnostics(ports) {
  try {
    nativeCollector?.dispose()
    nativeCollector = createNativeMotionDiagnostics(ports)
  } catch {
    nativeCollector = null
  }
}
export function flushNativeMotionDiagnostics(reason = 'export', exportRequestId) {
  try {
    nativeCollector?.flush(reason, exportRequestId)
  } catch {
    /* This boundary is used by business completion and shutdown paths. */
  }
}
export function flushWindowMotionDiagnostics(reason = 'export', exportRequestId) {
  for (const recorder of activeRecorders) recorder.flush(reason, exportRequestId)
  flushNativeMotionDiagnostics(reason, exportRequestId)
}

export function createNativeMotionDiagnostics({
  setLease,
  drain,
  state = diagnosticState,
  now = Date.now,
  emit = writeLog,
  setTimer = setInterval,
  clearTimer = clearInterval
}) {
  let policy = null
  let timer = null
  let reportedFailure = false
  let disposed = false
  let unsubscribe = () => {}
  function clearCollectionTimer() {
    const previous = timer
    timer = null
    try {
      clearTimer(previous)
    } catch {
      /* No cleanup failure may prevent clearing policy or subscription. */
    }
  }
  function flush(reason, exportRequestId) {
    if (!policy) return
    try {
      const started = performance.now()
      const raw = drain()
      if (typeof raw !== 'string' || raw.length > 48 * 1024) throw new Error('native-motion-budget')
      const batch = JSON.parse(raw)
      if (!batch || !batch.observations) return
      emit({
        kind: 'metric',
        scope: 'performance.window-motion-native',
        message: '原生窗口运动分阶段计量',
        exportRequestId,
        collectionPolicy: policy,
        metadata: {
          ...batch,
          reason,
          collectedMode: 'deep',
          captureId: policy.captureId,
          collectionPolicyEpoch: policy.policyEpoch,
          collectionMs: Math.round((performance.now() - started) * 100) / 100,
          evidenceBoundary: 'native-call-and-HWND-state-not-DWM-presentation'
        }
      })
    } catch {
      if (!reportedFailure) {
        reportedFailure = true
        try {
          emit({
            level: 'warn',
            scope: 'window.motion-diagnostics',
            message: '原生窗口计量暂不可用，业务移动不受影响',
            exportRequestId,
            metadata: { captureId: policy?.captureId, reason, observation: 'unavailable' }
          })
        } catch {
          /* Preserve the original business result. */
        }
      }
    }
  }
  function stopCollection(reason) {
    try {
      setLease(0)
    } catch {
      /* Its bounded native lease still expires if the DLL cannot be reached. */
    }
    flush(reason)
    clearCollectionTimer()
    policy = null
  }
  function change(next) {
    if (disposed) return
    try {
      const at = now()
      if (!Number.isFinite(at)) return stopCollection('clock-unavailable')
      const deep = isDeepDiagnostics(next, at)
      if (policy && (!deep || policy.captureId !== next.captureId)) {
        stopCollection(deep ? 'capture-change' : 'mode-stop')
      }
      if (deep) {
        policy = { ...next }
        reportedFailure = false
        setLease(Math.max(1, Math.min(1800000, next.expiresAt - at)))
        if (!timer) {
          timer = setTimer(() => {
            if (disposed) return
            try {
              const nextPolicy = state.get()
              if (
                !isDeepDiagnostics(nextPolicy, now()) ||
                nextPolicy.captureId !== policy?.captureId ||
                nextPolicy.policyEpoch !== policy?.policyEpoch
              )
                change(nextPolicy)
              if (policy) flush('interval')
            } catch {
              stopCollection('state-unavailable')
            }
          }, 5000)
          timer?.unref?.()
        }
      } else if (!policy) setLease(0)
    } catch {
      // Native measurement setup is an observation, never a runtime capability gate.
      stopCollection('setup-unavailable')
    }
  }
  try {
    change(state.get())
    const cleanup = state.subscribe(change)
    if (typeof cleanup === 'function') unsubscribe = cleanup
  } catch {
    stopCollection('state-unavailable')
  }
  return {
    flush,
    dispose() {
      if (disposed) return
      disposed = true
      stopCollection('dispose')
      try {
        unsubscribe()
      } catch {
        /* A failed release must not affect application shutdown. */
      }
    }
  }
}
