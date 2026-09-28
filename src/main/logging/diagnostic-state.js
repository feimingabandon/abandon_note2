import { randomUUID } from 'node:crypto'
import {
  dailyDiagnosticPolicy,
  DIAGNOSTIC_LIMITS,
  diagnosticHash
} from '../../shared/diagnostic-policy.js'

export function createDiagnosticState({
  now = Date.now,
  monotonic = () => performance.now(),
  timer = setTimeout,
  clear = clearTimeout
} = {}) {
  let policy = dailyDiagnosticPolicy()
  let deadline = 0
  let expiryTimer = null
  let lastDailyVerification = -Infinity
  let verificationWindow = -Infinity
  let verificationCount = 0
  const listeners = new Set()
  const history = [{ ...policy, reason: 'startup', at: now() }]
  const verification = { sampled: 0, skippedPolicy: 0, skippedBudget: 0 }
  function publish(reason) {
    history.push({ ...policy, reason, at: now() })
    if (history.length > 64) history.shift()
    for (const listener of listeners) {
      try {
        listener({ ...policy }, reason)
      } catch {
        /* 观察者不可改变模式控制。 */
      }
    }
  }
  function stop(reason = 'user') {
    if (policy.mode !== 'deep') return get()
    clear(expiryTimer)
    expiryTimer = null
    policy = {
      ...dailyDiagnosticPolicy(policy.policyEpoch + 1),
      previousCaptureId: policy.captureId,
      reason
    }
    publish(reason)
    return get()
  }
  function get() {
    if (policy.mode === 'deep' && (now() >= policy.expiresAt || monotonic() >= deadline))
      stop('expired')
    return {
      ...policy,
      remainingMs:
        policy.mode === 'deep'
          ? Math.max(0, Math.min(policy.expiresAt - now(), deadline - monotonic()))
          : 0
    }
  }
  function arm() {
    clear(expiryTimer)
    expiryTimer = timer(
      () => {
        if (get().mode === 'deep') arm()
      },
      Math.min(1000, Math.max(1, deadline - monotonic()))
    )
    expiryTimer?.unref?.()
  }
  function start(minutes = 10) {
    const duration = Math.min(30, Math.max(1, Number(minutes) || 10)) * 60_000
    if (get().mode === 'deep') {
      policy.expiresAt = Math.min(
        policy.startedAt + DIAGNOSTIC_LIMITS.maxDeepDurationMs,
        policy.expiresAt + duration
      )
      deadline = Math.min(policy.maxMonotonic, monotonic() + Math.max(0, policy.expiresAt - now()))
      policy.policyEpoch++
      publish('extended')
    } else {
      verificationWindow = -Infinity
      verificationCount = 0
      const currentMono = monotonic()
      policy = {
        policyVersion: 1,
        policyEpoch: policy.policyEpoch + 1,
        mode: 'deep',
        captureId: randomUUID(),
        startedAt: now(),
        expiresAt: now() + duration,
        maxMonotonic: currentMono + DIAGNOSTIC_LIMITS.maxDeepDurationMs,
        sampleIntervalMs: DIAGNOSTIC_LIMITS.deepIntervalMs
      }
      deadline = currentMono + duration
      publish('started')
    }
    arm()
    return get()
  }
  function observation(actionId = '') {
    const current = get()
    const at = monotonic()
    let reason = 'selected'
    if (current.mode === 'daily') {
      if (diagnosticHash(actionId) % 100 !== 0) reason = 'skipped-policy'
      else if (at - lastDailyVerification < 60_000) reason = 'skipped-budget'
      else lastDailyVerification = at
    } else {
      if (at - verificationWindow >= 1000) {
        verificationWindow = at
        verificationCount = 0
      }
      if (verificationCount >= 5) reason = 'skipped-budget'
      else verificationCount++
    }
    verification[
      reason === 'selected'
        ? 'sampled'
        : reason === 'skipped-policy'
          ? 'skippedPolicy'
          : 'skippedBudget'
    ]++
    return {
      enabled: reason === 'selected',
      reason,
      mode: current.mode,
      policyEpoch: current.policyEpoch,
      captureId: current.captureId
    }
  }
  return {
    get,
    start,
    stop,
    observation,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => ({
      policy: get(),
      history: history.slice(),
      verification: { ...verification }
    }),
    dispose() {
      clear(expiryTimer)
      listeners.clear()
    }
  }
}

export const diagnosticState = createDiagnosticState()
export const getDiagnosticPolicy = () => diagnosticState.get()
export const isDeepDiagnosticMode = () => getDiagnosticPolicy().mode === 'deep'
