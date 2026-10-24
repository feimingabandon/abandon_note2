const positive = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  return value
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

/**
 * Owns one real decoder resource at a time. Payloads must contain only bounded
 * metadata; opening/reading the source belongs to start(), after admission.
 * A response timeout never constitutes evidence that the resource has closed.
 */
export function createImageDecodeRuntime({
  start,
  maxPending = 128,
  totalTimeoutMs = 30_000,
  activeTimeoutMs = 5_000,
  now = () => globalThis.performance.now(),
  timers = globalThis,
  onDiagnostic = () => {}
}) {
  if (typeof start !== 'function') throw new TypeError('Image decoding requires start')
  positive(maxPending, 'maxPending')
  if (!Number.isInteger(maxPending)) throw new TypeError('maxPending must be an integer')
  positive(totalTimeoutMs, 'totalTimeoutMs')
  positive(activeTimeoutMs, 'activeTimeoutMs')
  const entries = new Map()
  const queue = []
  let active = null
  let sealed = false
  let blocked = false
  let fatalError = null
  let firstCleanupError = null
  let cleanupFailures = 0
  let disposal = null
  let pumping = false

  function diagnostic(type, entry, error) {
    try {
      const logged = onDiagnostic({
        type,
        key: entry?.key,
        ...(error === undefined ? {} : { error })
      })
      if (typeof logged?.then === 'function') void Promise.resolve(logged).catch(() => {})
    } catch {
      // A logger must never change ownership, cancellation or queue progression.
    }
  }

  function isCurrent(entry) {
    try {
      return Boolean(entry.isCurrent())
    } catch (error) {
      diagnostic('source-check-error', entry, error)
      return false
    }
  }

  function clearTimers(entry) {
    if (entry.totalTimer !== null) timers.clearTimeout(entry.totalTimer)
    if (entry.activeTimer !== null) timers.clearTimeout(entry.activeTimer)
    entry.totalTimer = null
    entry.activeTimer = null
  }

  function respond(entry, value) {
    if (entry.responded) return
    entry.responded = true
    clearTimers(entry)
    entry.response.resolve(value)
  }

  function removeQueued(entry, reason) {
    if (entry.state !== 'queued') return
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
    entries.delete(entry.key)
    entry.state = 'finished'
    diagnostic(reason, entry)
    respond(entry, null)
  }

  function sealFailure(type, entry, error) {
    sealed = true
    if (!blocked) fatalError = error
    blocked = true
    diagnostic(type, entry, error)
    for (const queued of [...queue]) removeQueued(queued, 'runtime-blocked')
    if (active) respond(active, null)
  }

  function releaseIfFinished(entry) {
    if (active !== entry || !entry.closedConfirmed) return
    if (!entry.responded) {
      if (!entry.resultSettled) return
      if (!isCurrent(entry)) {
        diagnostic('source-expired', entry)
        respond(entry, null)
      } else respond(entry, entry.resultValue ?? null)
    }
    entries.delete(entry.key)
    entry.state = 'finished'
    active = null
    clearTimers(entry)
    if (entry.cleanupFailed) entry.finished.reject(entry.cleanupError)
    else entry.finished.resolve()
    pump()
  }

  function cancel(entry, reason) {
    if (entry.cancelRequested || entry.closedConfirmed || entry.closeFailed) return
    entry.cancelRequested = true
    try {
      entry.operation.cancel(reason)
    } catch (error) {
      entry.cleanupFailed = true
      entry.cleanupError = error
      sealFailure('cancel-error', entry, error)
    }
  }

  function failActive(entry, reason, error) {
    if (active !== entry) return
    diagnostic(reason, entry, error)
    respond(entry, null)
    cancel(entry, reason)
    releaseIfFinished(entry)
  }

  function scheduleTotal(entry) {
    const remaining = entry.totalDeadline - now()
    if (remaining <= 0) {
      if (entry.state === 'queued') {
        removeQueued(entry, 'total-timeout')
        pump()
      } else if (entry.state === 'active') failActive(entry, 'total-timeout')
      return
    }
    entry.totalTimer = timers.setTimeout(() => {
      entry.totalTimer = null
      scheduleTotal(entry)
    }, remaining)
  }

  function scheduleActive(entry) {
    const remaining = entry.activeDeadline - now()
    if (remaining <= 0) {
      failActive(entry, 'active-timeout')
      return
    }
    entry.activeTimer = timers.setTimeout(() => {
      entry.activeTimer = null
      scheduleActive(entry)
    }, remaining)
  }

  function begin(entry) {
    active = entry
    entry.state = 'active'
    entry.activeDeadline = now() + activeTimeoutMs
    let operation
    try {
      operation = start(entry.payload)
    } catch (error) {
      // start's synchronous failure must not leave an unreturned resource.
      diagnostic('start-error', entry, error)
      respond(entry, null)
      entry.closedConfirmed = true
      releaseIfFinished(entry)
      return
    }
    entry.operation = operation
    let result
    let closed
    try {
      result = operation?.result
      closed = operation?.closed
      if (
        typeof result?.then !== 'function' ||
        typeof closed?.then !== 'function' ||
        typeof operation?.cancel !== 'function'
      )
        throw new TypeError('Image decoder must provide result, closed and cancel')
    } catch (error) {
      entry.cleanupFailed = true
      entry.cleanupError = error
      sealFailure('invalid-operation', entry, error)
      if (typeof operation?.cancel === 'function') cancel(entry, 'invalid-operation')
      // A malformed close contract cannot establish resource termination.
      if (typeof closed?.then !== 'function') {
        entry.closeFailed = true
        entry.finished.reject(error)
      }
    }

    if (typeof result?.then === 'function') {
      void Promise.resolve(result).then(
        (value) => {
          if (active !== entry || entry.responded) return
          entry.resultSettled = true
          entry.resultValue = value
          if (!isCurrent(entry)) failActive(entry, 'source-expired')
          else releaseIfFinished(entry)
        },
        (error) => failActive(entry, 'result-error', error)
      )
    }
    if (typeof closed?.then === 'function') {
      void Promise.resolve(closed).then(
        (status) => {
          entry.closedConfirmed = true
          if (status?.cleanupError !== undefined) {
            const error = status.cleanupError
            if (!cleanupFailures) firstCleanupError = error
            cleanupFailures = Math.min(Number.MAX_SAFE_INTEGER, cleanupFailures + 1)
            entry.cleanupFailed = true
            entry.cleanupError = error
            diagnostic('cleanup-error', entry, error)
          }
          releaseIfFinished(entry)
        },
        (error) => {
          entry.cleanupFailed = true
          entry.cleanupError = error
          sealFailure('closed-error', entry, error)
          cancel(entry, 'closed-error')
          entry.closeFailed = true
          // Rejected closed is not proof of exit. Keep the active slot occupied.
          entry.finished.reject(error)
        }
      )
    }
    if (!entry.responded) {
      if (!isCurrent(entry)) failActive(entry, 'source-expired')
      else if (now() >= entry.totalDeadline) failActive(entry, 'total-timeout')
      else scheduleActive(entry)
    }
  }

  function pump() {
    if (pumping || active || sealed) return
    pumping = true
    try {
      while (!active && !sealed && queue.length) {
        const entry = queue[0]
        if (now() >= entry.totalDeadline) removeQueued(entry, 'total-timeout')
        else if (!isCurrent(entry)) removeQueued(entry, 'source-expired')
        else {
          queue.shift()
          begin(entry)
        }
      }
    } finally {
      pumping = false
    }
  }

  function request(key, payload, current = () => true) {
    const existing = entries.get(key)
    if (existing) return existing.response.promise
    if (sealed) {
      diagnostic('runtime-sealed', { key })
      return Promise.resolve(null)
    }
    const entry = { key, payload, isCurrent: current }
    if (!isCurrent(entry)) {
      diagnostic('source-expired', entry)
      return Promise.resolve(null)
    }
    if (entries.size >= maxPending) {
      diagnostic('queue-full', entry)
      return Promise.resolve(null)
    }
    Object.assign(entry, {
      state: 'queued',
      totalDeadline: now() + totalTimeoutMs,
      response: deferred(),
      finished: deferred(),
      totalTimer: null,
      activeTimer: null,
      responded: false,
      resultSettled: false,
      resultValue: null,
      closedConfirmed: false,
      closeFailed: false,
      cleanupError: null,
      cleanupFailed: false,
      cancelRequested: false
    })
    // The runtime observes cleanup failures even when no caller has disposed yet.
    void entry.finished.promise.catch(() => {})
    entries.set(key, entry)
    queue.push(entry)
    scheduleTotal(entry)
    pump()
    return entry.response.promise
  }

  function cancelAll(reason = 'cancelled') {
    for (const queued of [...queue]) removeQueued(queued, reason)
    const current = active
    if (current?.cancellation) return current.cancellation
    if (current) failActive(current, reason)
    const completion = (current ? current.finished.promise : Promise.resolve()).then(() => {
      if (blocked) throw fatalError
    })
    void completion.catch(() => {})
    if (current) current.cancellation = completion
    return completion
  }

  function dispose() {
    if (disposal) return disposal
    sealed = true
    disposal = cancelAll('disposed').then(() => {
      if (cleanupFailures) throw firstCleanupError
    })
    void disposal.catch(() => {})
    return disposal
  }

  return Object.freeze({
    request,
    cancelAll,
    dispose,
    snapshot: () => ({
      busy: active !== null,
      pending: entries.size,
      queued: queue.length,
      sealed,
      blocked,
      cleanupFailures
    })
  })
}
