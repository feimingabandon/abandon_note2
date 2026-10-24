const OUTCOMES = new Set(['completed', 'degraded', 'timed-out', 'failed'])

function outcomeRecord(outcome, details = {}) {
  if (!OUTCOMES.has(outcome)) throw new TypeError('退出阶段评估必须返回明确的终态')
  // Preserve the consumed normal status spelling, derived in exactly one place.
  return { ...details, outcome, status: outcome === 'completed' ? 'complete' : outcome }
}

function assessResult(result, assess) {
  let assessment = assess?.(result)
  if (assessment === undefined) {
    assessment = {
      status: OUTCOMES.has(result?.outcome || result?.status)
        ? result.outcome || result.status
        : result === 'timeout'
          ? 'timed-out'
          : result?.complete === false || result?.incomplete === true
            ? 'degraded'
            : 'completed'
    }
  } else if (typeof assessment === 'string') assessment = { status: assessment }
  const outcome = assessment?.outcome || assessment?.status
  return outcomeRecord(outcome, assessment)
}

const errorText = (error) => error?.message || String(error)

/** Serial ownership drain. A deadline exits rather than releasing resources under a live owner. */
export function createShutdownCoordinator({
  app,
  logger,
  getWindow,
  confirmDrafts,
  isViewDraftCheckActive = () => false,
  getViewNavigationActive = isViewDraftCheckActive,
  onBegin,
  hasRemoteSession,
  stages,
  cleanup,
  flushLogs,
  timeoutMs = 30_000,
  onTerminal = () => {},
  now = Date.now
}) {
  const budgetMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 30_000
  let quitting = false
  let quitRequested = false
  let deferredQuit = false
  let checkingDrafts = false
  let draftsApproved = false
  let startedAt = null
  let deadlineAt = null
  let finishedAt = null
  let trigger = null
  let activeStage = null
  let completed = false
  let terminal = false
  let beginning = false
  let outcome = null
  let exitMode = null
  let deadlineTimer
  let reportError = null
  let frozenStages = null
  let frozenLoggingErrors = null
  let logFlush = { status: 'not-started' }
  const results = new Map()
  const loggingErrors = []

  function log(level, ...args) {
    try {
      logger[level](...args)
    } catch (error) {
      // Logging cannot bypass admission retirement, the deadline or process exit.
      if (!terminal) loggingErrors.push(errorText(error))
    }
  }

  function stageSnapshot() {
    return Object.fromEntries([...results].map(([name, value]) => [name, { ...value }]))
  }

  function snapshot() {
    return {
      quitting,
      quitRequested,
      deferredQuit,
      checkingDrafts,
      draftsApproved,
      startedAt,
      deadlineAt,
      elapsedMs: startedAt === null ? 0 : (finishedAt ?? now()) - startedAt,
      trigger,
      activeStage,
      completed,
      terminal,
      outcome,
      success: outcome === 'completed',
      exitMode,
      stages: frozenStages || stageSnapshot(),
      // Normal owner results are sealed; the existing independent log barrier
      // may still report its own fulfilled incomplete result afterward.
      logFlush: { ...logFlush },
      loggingErrors: frozenLoggingErrors || [...loggingErrors],
      reportError
    }
  }

  function aggregateOutcome(extra) {
    const statuses = new Set([...results.values()].map((result) => result.outcome || result.status))
    if (extra) statuses.add(extra)
    if (statuses.has('failed')) return 'failed'
    if (statuses.has('timed-out')) return 'timed-out'
    if (statuses.has('degraded') || loggingErrors.length) return 'degraded'
    return 'completed'
  }

  function sealStages() {
    frozenStages = Object.freeze(
      Object.fromEntries([...results].map(([name, value]) => [name, Object.freeze({ ...value })]))
    )
    frozenLoggingErrors = Object.freeze([...loggingErrors])
  }

  function hardTerminal(status, mode) {
    if (terminal) return
    terminal = true
    completed = false
    quitting = true
    quitRequested = true
    deferredQuit = false
    finishedAt = now()
    exitMode = mode
    if (activeStage && results.get(activeStage)?.status === 'running') {
      results.set(
        activeStage,
        outcomeRecord(status, {
          ...results.get(activeStage),
          reason: mode
        })
      )
    }
    outcome = aggregateOutcome(status)
    clearTimeout(deadlineTimer)
    sealStages()
    try {
      // No await, app.quit, downstream cleanup, DB close or log-writer barrier:
      // an admitted command can retain its DB across an await. Ending this
      // process prevents that owner from later committing or restoring a window.
      const observed = onTerminal(snapshot())
      if (observed && typeof observed.then === 'function') {
        void Promise.resolve(observed).catch(() => {})
        reportError = '退出终态记录必须同步完成'
      }
    } catch (error) {
      reportError = errorText(error)
    } finally {
      app.exit(1)
    }
  }

  function expired() {
    if (terminal) return true
    if (startedAt !== null && now() >= deadlineAt) {
      hardTerminal('timed-out', 'deadline')
      return true
    }
    return false
  }

  function failAdmission(name, error, phase = name) {
    results.set(
      name,
      outcomeRecord('failed', {
        phase,
        error: errorText(error),
        settled: false
      })
    )
    log('error', 'lifecycle.shutdown-admission', error, { stage: name, phase })
    hardTerminal('failed', 'failed-admission')
  }

  function cancelQuitRequest() {
    quitRequested = false
    deferredQuit = false
    quitting = false
  }

  function startStage(stage) {
    activeStage = stage.name
    const stageStartedAt = now()
    results.set(stage.name, { status: 'running', startedAt: stageStartedAt, settled: false })
    void Promise.resolve()
      .then(() => {
        if (expired()) return
        return stage.run()
      })
      .then((result) => {
        if (terminal) return
        results.set(stage.name, { ...results.get(stage.name), result, settled: true })
        if (expired()) return
        results.set(stage.name, {
          ...assessResult(result, stage.assess),
          result,
          settled: true,
          elapsedMs: now() - stageStartedAt
        })
      })
      .catch((error) => {
        if (terminal) return
        results.set(
          stage.name,
          outcomeRecord('failed', {
            error: errorText(error),
            settled: true,
            elapsedMs: now() - stageStartedAt
          })
        )
        log('error', stage.errorScope || 'lifecycle.shutdown-stage', error, { stage: stage.name })
        expired()
      })
      .finally(() => {
        // app.exit may be a returning test mock. Late continuations still cannot
        // replace a terminal record or enter app.quit again.
        if (terminal || expired()) return
        log('info', 'lifecycle.shutdown-wait', '退出清理阶段结束', {
          stage: stage.name,
          elapsedMs: now() - stageStartedAt,
          ...results.get(stage.name)
        })
        activeStage = null
        app.quit()
      })
  }

  function observeLogFlush() {
    logFlush = { status: 'running' }
    let flushing
    try {
      flushing = flushLogs()
    } catch (error) {
      logFlush = outcomeRecord('failed', { error: errorText(error) })
      log('error', 'lifecycle.shutdown-logs', error)
      return
    }
    void Promise.resolve(flushing).then(
      (result) => {
        logFlush = { ...assessResult(result), result }
      },
      (error) => {
        logFlush = outcomeRecord('failed', { error: errorText(error) })
        log('error', 'lifecycle.shutdown-logs', error)
      }
    )
  }

  function beforeQuit(event) {
    if (terminal) {
      if (!completed) event.preventDefault()
      return
    }
    if (beginning) {
      event.preventDefault()
      return
    }
    const window = getWindow()
    if (!draftsApproved && window && !window.isDestroyed()) {
      event.preventDefault()
      quitRequested = true
      if (checkingDrafts) return
      // A successful page preparation remains owned until navigation releases it.
      if (getViewNavigationActive()) {
        deferredQuit = true
        return
      }
      deferredQuit = false
      checkingDrafts = true
      void Promise.resolve()
        .then(() => confirmDrafts(window, '退出'))
        .then((allowed) => {
          if (startedAt !== null || terminal) return
          if (allowed) {
            draftsApproved = true
            app.quit()
          } else cancelQuitRequest()
        })
        .catch((error) => {
          if (startedAt === null && !terminal) cancelQuitRequest()
          log('error', 'lifecycle.shutdown-drafts', error)
        })
        .finally(() => {
          if (!terminal) checkingDrafts = false
        })
      return
    }
    if (startedAt === null) {
      startedAt = now()
      deadlineAt = startedAt + budgetMs
      trigger ||= 'system-or-programmatic'
      quitRequested = true
      deferredQuit = false
      quitting = true
      beginning = true
      for (const stage of [...stages, ...cleanup])
        results.set(stage.name, { status: 'not-started' })
      // This timer requires a responsive JS event loop. It cannot interrupt a
      // synchronous FFI; before/after checks stop later work once that call returns.
      deadlineTimer = setTimeout(() => hardTerminal('timed-out', 'deadline'), budgetMs)
      try {
        const remoteSessionActive = hasRemoteSession()
        log('info', 'lifecycle.shutdown-start', '应用开始退出清理', {
          trigger,
          remoteSessionActive
        })
      } catch (error) {
        event.preventDefault()
        failAdmission('has-remote-session', error)
        return
      }
      try {
        const result = onBegin()
        if (result && typeof result.then === 'function') {
          void Promise.resolve(result).catch(() => {})
          throw new TypeError('退出准入停止必须同步完成')
        }
        results.set('on-begin', { ...assessResult(result), result, settled: true })
      } catch (error) {
        event.preventDefault()
        failAdmission('on-begin', error)
        return
      }
      beginning = false
    }
    if (expired()) {
      event.preventDefault()
      return
    }
    if (activeStage) {
      event.preventDefault()
      return
    }
    for (const stage of stages) {
      if (results.get(stage.name)?.status !== 'not-started') continue
      let enabled
      try {
        enabled = stage.enabled()
      } catch (error) {
        event.preventDefault()
        failAdmission(stage.name, error, 'enabled')
        return
      }
      if (expired()) {
        event.preventDefault()
        return
      }
      if (!enabled) {
        results.set(stage.name, { status: 'not-created' })
        continue
      }
      event.preventDefault()
      startStage(stage)
      return
    }
    for (const stage of cleanup) {
      if (expired()) {
        event.preventDefault()
        return
      }
      activeStage = stage.name
      const stageStartedAt = now()
      results.set(stage.name, { status: 'running', startedAt: stageStartedAt, settled: false })
      try {
        const result = stage.run()
        if (result && typeof result.then === 'function') {
          void Promise.resolve(result).catch(() => {})
          event.preventDefault()
          failAdmission(stage.name, new TypeError('同步退出清理返回了异步工作'), 'cleanup-contract')
          return
        }
        results.set(stage.name, { ...results.get(stage.name), result, settled: true })
        if (expired()) {
          event.preventDefault()
          return
        }
        results.set(stage.name, {
          ...assessResult(result, stage.assess),
          result,
          settled: true,
          elapsedMs: now() - stageStartedAt
        })
      } catch (error) {
        results.set(
          stage.name,
          outcomeRecord('failed', {
            error: errorText(error),
            settled: true,
            elapsedMs: now() - stageStartedAt
          })
        )
        log('error', 'lifecycle.shutdown-cleanup', error, { stage: stage.name })
        if (expired()) {
          event.preventDefault()
          return
        }
      }
      activeStage = null
    }
    if (expired()) {
      event.preventDefault()
      return
    }
    terminal = true
    completed = true
    outcome = aggregateOutcome()
    exitMode = 'normal'
    finishedAt = now()
    clearTimeout(deadlineTimer)
    sealStages()
    log('info', 'lifecycle.shutdown-complete', '应用退出清理结束', {
      trigger,
      elapsedMs: finishedAt - startedAt,
      outcome,
      success: outcome === 'completed',
      stages: frozenStages
    })
    // Keep the logger's existing bounded will-quit barrier. Its independent
    // result must not mutate the already sealed owner outcomes.
    observeLogFlush()
  }

  app.on('before-quit', beforeQuit)
  return {
    isQuitting: () => quitting,
    isCheckingDrafts: () => checkingDrafts || deferredQuit,
    setTrigger(value) {
      if (!terminal) trigger = value
    },
    requestQuit(value) {
      if (terminal) return
      if (value) trigger = value
      else trigger ||= 'user-request'
      quitRequested = true
      app.quit()
    },
    resumeDeferredQuit() {
      if (
        terminal ||
        !quitRequested ||
        !deferredQuit ||
        checkingDrafts ||
        quitting ||
        startedAt !== null ||
        getViewNavigationActive()
      )
        return false
      deferredQuit = false
      app.quit()
      return true
    },
    snapshot
  }
}
