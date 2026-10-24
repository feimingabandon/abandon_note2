const DOMAINS = Object.freeze(['window', 'blur', 'dock'])
const STATUSES = new Set(['applied', 'failed', 'deferred', 'unconfirmed'])
const SCOPES = new Set(['main', 'month', 'week'])
const MAX_ERRORS_PER_SCOPE = 64

function errorValue(error) {
  return {
    message: error?.message || String(error),
    ...(typeof error?.code === 'string' || typeof error?.code === 'number'
      ? { code: error.code }
      : {})
  }
}

function plain(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!value || typeof value !== 'object') return undefined
  if (value instanceof Error) return errorValue(value)
  if (seen.has(value)) return null
  seen.add(value)
  const result = Array.isArray(value)
    ? value.map((item) => plain(item, seen) ?? null)
    : Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
          .map(([key, item]) => [key, plain(item, seen)])
          .filter(([, item]) => item !== undefined)
      )
  seen.delete(value)
  return result
}

function domainResult(result) {
  if (result === false)
    return { status: 'failed', error: '应用端口明确拒绝了请求', retryable: true }
  const status = STATUSES.has(result?.status) ? result.status : 'unconfirmed'
  return {
    ...(plain(result) || {}),
    status,
    error: result?.error == null ? null : errorValue(result.error).message,
    retryable: typeof result?.retryable === 'boolean' ? result.retryable : status !== 'applied'
  }
}

function summarize(results) {
  const statuses = results.map((result) => result.status)
  return (
    ['failed', 'deferred', 'unconfirmed'].find((status) => statuses.includes(status)) || 'applied'
  )
}

/** Owns post-commit attempts and receipts, never SQL or a second copy of resolved values. */
export function createSettingsApplicationCoordinator({
  getCurrentContext,
  isContextCurrent,
  refreshResolvedSettings,
  dependencies = {},
  dependencyApplies = () => true,
  afterDomainDependencies = [],
  domainDependencies = { blur: ['blurConfig'] },
  applyDomains = {},
  retryDomains = {},
  getResolvedSettingsSnapshot,
  broadcastSettingsChanged,
  onLedgerChanged
}) {
  if (typeof getCurrentContext !== 'function' || typeof isContextCurrent !== 'function')
    throw new TypeError('设置应用必须提供同步的当前页面上下文与有效性检查')
  if (onLedgerChanged !== undefined && typeof onLedgerChanged !== 'function')
    throw new TypeError('设置应用状态通知必须是函数')
  const ledger = new Map()
  const dependencyEntries = Object.entries(dependencies)
  const dependencyNames = new Set(dependencyEntries.map(([name]) => name))
  const afterDomains = new Set(afterDomainDependencies)
  if ([...afterDomains].some((name) => !Object.hasOwn(dependencies, name)))
    throw new TypeError('后置设置依赖必须来自固定依赖名单')
  let windowDomain = null
  let attemptSequence = 0
  let commitSequence = 0
  let ledgerRevision = 0
  let notificationQueued = false
  const changedScopes = new Set()

  function changed(scope, { sharedWindow = false } = {}) {
    ledgerRevision += 1
    if (!onLedgerChanged) return
    for (const affected of sharedWindow ? SCOPES : [scope]) changedScopes.add(affected)
    if (notificationQueued) return
    notificationQueued = true
    queueMicrotask(() => {
      notificationQueued = false
      const notification = { ledgerRevision, scopes: [...changedScopes] }
      changedScopes.clear()
      try {
        // Observers are outside the application attempt. Neither a failed IPC
        // delivery nor an asynchronous observer rejection may rewrite its result
        // or append history that recursively schedules another notification.
        void Promise.resolve(onLedgerChanged(notification)).catch(() => {})
      } catch {
        // The main adapter can report its own transport failure independently.
      }
    })
  }

  function recordFor(scope) {
    if (!ledger.has(scope))
      ledger.set(scope, {
        scope,
        commitId: null,
        current: null,
        dependencies: {},
        domains: {},
        errors: []
      })
    return ledger.get(scope)
  }

  function publishCurrent(state, patch) {
    const record = ledger.get(state.scope)
    if (record?.current?.attempt !== state.attempt) return false
    const current = { ...record.current, ...plain(patch) }
    if (JSON.stringify(current) === JSON.stringify(record.current)) return true
    record.current = current
    changed(state.scope)
    return true
  }

  function rememberError(state, stage, error) {
    const entry = { attempt: state.attempt, stage, error: errorValue(error) }
    state.errors.push(entry)
    const errors = recordFor(state.scope).errors
    errors.push(plain(entry))
    if (errors.length > MAX_ERRORS_PER_SCOPE) errors.splice(0, errors.length - MAX_ERRORS_PER_SCOPE)
    changed(state.scope)
    return entry.error
  }

  function currentContext(state) {
    if (state.contextInvalid) return false
    const source = state.context?.source
    // Only the trusted getCurrentContext port can issue runtime contexts for a
    // committed main-owned write. Renderer retries always require a document.
    const runtimeContext =
      state.allowRuntimeContext &&
      state.context?.origin === 'main-runtime' &&
      source === null &&
      typeof state.context.runtimeToken === 'string' &&
      state.context.runtimeToken.length > 0
    if (
      !SCOPES.has(state.scope) ||
      state.context?.scope !== state.scope ||
      (state.context?.origin === 'main-runtime' && !runtimeContext) ||
      (!runtimeContext &&
        (typeof source?.token !== 'string' || !source.token || source.scope !== state.scope))
    ) {
      state.contextInvalid = true
      return false
    }
    try {
      const result = isContextCurrent(plain(state.context))
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(() => {})
        throw new TypeError('设置上下文检查必须同步返回 boolean')
      }
      if (result !== true) state.contextInvalid = true
      return !state.contextInvalid
    } catch (error) {
      rememberError(state, 'context', error)
      state.contextInvalid = true
      return false
    }
  }

  function ownsDomain(state, domain) {
    const entry = domain === 'window' ? windowDomain : ledger.get(state.scope)?.domains[domain]
    return entry?.attempt === state.attempt
  }

  function setDomain(state, domain, result) {
    const entry = {
      attempt: state.attempt,
      status: result.status,
      error: result.error,
      retryable: result.retryable
    }
    // Window lock/layer settings belong to the application even when the
    // requesting document is a different view. Blur and Dock remain per-view.
    if (domain === 'window') windowDomain = entry
    else recordFor(state.scope).domains[domain] = entry
    changed(state.scope, { sharedWindow: domain === 'window' })
  }

  function publishDomain(state, domain, result) {
    if (!ownsDomain(state, domain)) return false
    if (
      result.status === 'failed' &&
      result.error &&
      !state.errors.some((entry) => entry.stage === `domain:${domain}`)
    ) {
      rememberError(state, `domain:${domain}`, new Error(result.error))
    }
    setDomain(state, domain, result)
    return true
  }

  function hasSupersededDomain(state) {
    return state.domains.some((domain) => !ownsDomain(state, domain))
  }

  function ownsDependency(state, name) {
    return ledger.get(state.scope)?.dependencies[name]?.attempt === state.attempt
  }

  function setDependency(state, name, result) {
    recordFor(state.scope).dependencies[name] = {
      attempt: state.attempt,
      status: result.status,
      error: result.error,
      retryable: result.retryable
    }
    changed(state.scope)
  }

  function publishDependency(state, name, result) {
    if (!ownsDependency(state, name)) return false
    if (
      result.status === 'failed' &&
      result.error &&
      !state.errors.some((entry) => entry.stage === `dependency:${name}`)
    ) {
      rememberError(state, `dependency:${name}`, new Error(result.error))
    }
    setDependency(state, name, result)
    return true
  }

  function hasSupersededWork(state) {
    return (
      hasSupersededDomain(state) ||
      state.dependencySuperseded ||
      [...state.pendingDependencies].some((name) => !ownsDependency(state, name))
    )
  }

  async function capture(state, stage, operation, normalize = (result) => result) {
    try {
      return { ok: true, result: normalize(await operation()) }
    } catch (error) {
      return { ok: false, error: rememberError(state, stage, error) }
    }
  }

  function snapshotMatches(snapshot, state) {
    return Boolean(
      snapshot &&
      snapshot.source?.token === state.context?.source?.token &&
      snapshot.source?.scope === state.scope &&
      Number.isSafeInteger(snapshot.revision) &&
      snapshot.revision >= 0 &&
      snapshot.values &&
      typeof snapshot.values === 'object' &&
      !Array.isArray(snapshot.values)
    )
  }

  async function execute({
    scope,
    context,
    domains,
    ids = [],
    previousDockConfig = null,
    applyBlurRuntime = true,
    verify,
    reset = false,
    selectedDependencies,
    reason
  }) {
    const attempt = ++attemptSequence
    const commitId =
      reason === 'commit'
        ? `settings-commit-${++commitSequence}`
        : (ledger.get(scope)?.commitId ?? null)
    const state = {
      scope,
      context: null,
      contextInvalid: false,
      allowRuntimeContext: reason === 'commit',
      terminal: false,
      domains,
      attempt,
      errors: [],
      pendingDependencies: new Set(),
      dependencySuperseded: false
    }
    let activeDependencies = []
    try {
      try {
        activeDependencies = dependencyEntries.filter(([name]) =>
          selectedDependencies === undefined
            ? dependencyApplies(name, {
                scope,
                ids: [...ids],
                reset,
                reason,
                domains: [...domains]
              })
            : selectedDependencies.includes(name)
        )
        state.pendingDependencies = new Set(activeDependencies.map(([name]) => name))
      } catch (error) {
        rememberError(state, 'dependency-selection', error)
        state.contextInvalid = true
      }
      try {
        const candidate = context === undefined ? getCurrentContext() : context
        if (candidate && typeof candidate.then === 'function') {
          void Promise.resolve(candidate).catch(() => {})
          throw new TypeError('设置页面上下文必须同步读取')
        }
        state.context = candidate?.scope === scope ? plain(candidate) : null
      } catch (error) {
        rememberError(state, 'context', error)
      }
      // A stale caller must not acquire ownership and cancel a valid in-flight
      // application. Committed callers still receive their saved receipt below.
      if (currentContext(state)) {
        const record = recordFor(scope)
        if (reason === 'commit') record.commitId = commitId
        // This scope owner controls stage metadata only. Domain/name owners below
        // remain independent, so a newer font attempt cannot cancel an old blur.
        record.current = {
          attempt,
          reason,
          phase: 'running',
          targets: {
            domains: [...domains],
            dependencies: activeDependencies.map(([name]) => name)
          },
          resolve: { status: 'deferred', error: null },
          snapshot: { status: 'pending', error: null },
          verification:
            typeof verify === 'function'
              ? { status: 'unconfirmed', error: null, reason: 'pending' }
              : { status: 'skipped', error: null },
          delivery: { status: 'skipped', error: null },
          superseded: false
        }
        changed(scope)
        for (const domain of domains) {
          setDomain(state, domain, { status: 'deferred', error: null, retryable: true })
        }
        for (const [name] of activeDependencies) {
          setDependency(state, name, { status: 'deferred', error: null, retryable: true })
        }
      }
      const application = {
        status: 'deferred',
        attempt,
        resolve: { status: 'deferred', error: null },
        dependencies: {},
        domains: {},
        superseded: false
      }
      let verification = { status: 'skipped', error: null }
      let delivery = { status: 'skipped', error: null }
      let snapshot = null
      let snapshotError = null
      const request = {
        context: state.context,
        scope,
        reason,
        attempt,
        ids: [...ids],
        reset,
        previousDockConfig: plain(previousDockConfig),
        applyBlurRuntime
      }

      if (typeof verify === 'function') {
        const verified = await capture(state, 'verification', verify, plain)
        if (!verified.ok) verification = { status: 'failed', error: verified.error }
        else if (verified.result === false || verified.result?.status === 'failed') {
          verification = {
            status: 'failed',
            error: rememberError(
              state,
              'verification',
              verified.result?.error ||
                Object.assign(new Error('验证端口明确拒绝了请求'), {
                  code: 'SETTINGS_VERIFICATION_REJECTED'
                })
            )
          }
        } else {
          verification = {
            status: ['completed', 'skipped'].includes(verified.result?.status)
              ? verified.result.status
              : 'unconfirmed',
            error: null,
            ...(typeof verified.result?.reason === 'string'
              ? { reason: verified.result.reason }
              : {})
          }
        }
      }
      publishCurrent(state, { verification })
      if (currentContext(state)) {
        const resolved = await capture(state, 'resolve', () =>
          refreshResolvedSettings({
            incrementRevision: reason === 'commit',
            notifyResolved: false
          })
        )
        if (!currentContext(state)) {
          application.resolve = { status: 'deferred', error: '设置请求所属页面已失效' }
          publishCurrent(state, { resolve: application.resolve })
        } else if (!resolved.ok) {
          application.resolve = { status: 'failed', error: resolved.error.message }
          snapshotError = resolved.error
          publishCurrent(state, { resolve: application.resolve })
        } else {
          application.resolve = { status: 'applied', error: null }
          publishCurrent(state, { resolve: application.resolve })
          async function runDependencies(after) {
            for (const [name, dependency] of activeDependencies) {
              if (afterDomains.has(name) !== after) continue
              // An explicit dependency can remain owned even after every selected
              // domain was replaced. Each name keeps its own guarded lifetime.
              if (!currentContext(state)) break
              if (!ownsDependency(state, name)) {
                state.dependencySuperseded = true
                application.dependencies[name] = {
                  status: 'deferred',
                  error: '依赖应用已被更新请求替代',
                  retryable: true
                }
                state.pendingDependencies.delete(name)
                continue
              }
              let portActive = true
              // Dependencies can update shared runtime state too. Their ownership is
              // per scope/name and ends once this result is accepted; later unrelated
              // commits must not cancel a domain that already entered its own port.
              const guard = Object.freeze({
                isCurrent: () =>
                  portActive &&
                  !state.terminal &&
                  currentContext(state) &&
                  ownsDependency(state, name)
              })
              let outcome
              try {
                outcome = await capture(
                  state,
                  `dependency:${name}`,
                  () => dependency(plain(request), guard),
                  domainResult
                )
              } finally {
                portActive = false
              }
              if (!currentContext(state)) break
              if (!ownsDependency(state, name)) {
                state.dependencySuperseded = true
                application.dependencies[name] = {
                  status: 'deferred',
                  error: '依赖应用已被更新请求替代',
                  retryable: true
                }
              } else
                application.dependencies[name] = outcome.ok
                  ? outcome.result
                  : { status: 'failed', error: outcome.error.message, retryable: true }
              publishDependency(state, name, application.dependencies[name])
              state.pendingDependencies.delete(name)
            }
          }
          await runDependencies(false)
          for (const domain of domains) {
            if (!currentContext(state)) break
            if (!ownsDomain(state, domain)) {
              application.domains[domain] = {
                status: 'deferred',
                error: '应用已被更新请求替代',
                retryable: true
              }
              continue
            }
            const blocked = (domainDependencies[domain] || []).find(
              (name) => application.dependencies[name]?.status !== 'applied'
            )
            let result
            if (blocked) {
              result = { status: 'deferred', error: `依赖 ${blocked} 尚未应用`, retryable: true }
            } else {
              const port = (reason === 'retry' ? retryDomains : applyDomains)[domain]
              if (typeof port !== 'function') {
                result = { status: 'deferred', error: `缺少 ${domain} 应用端口`, retryable: true }
              } else {
                let portActive = true
                // The owner suppresses stale results and later stages; it cannot
                // undo work already performed or queued natively. Async ports must
                // use this guard after awaits and before native/compensation work.
                const guard = Object.freeze({
                  isCurrent: () =>
                    portActive &&
                    !state.terminal &&
                    currentContext(state) &&
                    ownsDomain(state, domain)
                })
                let outcome
                try {
                  outcome = await capture(
                    state,
                    `domain:${domain}`,
                    () => port(plain(request), guard),
                    domainResult
                  )
                } finally {
                  portActive = false
                }
                if (!currentContext(state)) break
                result = outcome.ok
                  ? outcome.result
                  : { status: 'failed', error: outcome.error.message, retryable: true }
              }
            }
            if (!publishDomain(state, domain, result)) {
              result = { status: 'deferred', error: '应用已被更新请求替代', retryable: true }
            }
            application.domains[domain] = result
          }
          await runDependencies(true)
          if (
            currentContext(state) &&
            !hasSupersededWork(state) &&
            state.context.origin === 'main-runtime'
          ) {
            // An internal lifecycle write has no renderer document to receive a
            // canonical snapshot. This is intentional, not a snapshot failure.
            snapshotError = {
              message: '主进程内部写入不提供页面设置快照',
              code: 'SETTINGS_INTERNAL_NO_DOCUMENT'
            }
          } else if (currentContext(state) && !hasSupersededWork(state)) {
            const captured = await capture(
              state,
              'snapshot',
              getResolvedSettingsSnapshot,
              (value) => {
                if (!snapshotMatches(value, state))
                  throw Object.assign(new Error('设置快照不属于本次请求的页面'), {
                    code: 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH'
                  })
                return plain(value)
              }
            )
            if (currentContext(state) && !hasSupersededWork(state)) {
              if (!captured.ok) snapshotError = captured.error
              else snapshot = captured.result
            }
          }
        }
      }
      const contextValid = currentContext(state)
      application.superseded = !contextValid || hasSupersededWork(state)
      if (application.superseded) {
        snapshot = null
        snapshotError = {
          message: '设置请求所属页面或领域应用已失效',
          code: 'SETTINGS_APPLICATION_SUPERSEDED'
        }
      }
      for (const [name] of activeDependencies) {
        if (!application.dependencies[name]) {
          application.dependencies[name] = {
            status: 'deferred',
            error: snapshotError?.message || application.resolve.error || '依赖应用尚未执行',
            retryable: true
          }
          publishDependency(state, name, application.dependencies[name])
        }
      }
      for (const domain of domains) {
        if (!application.domains[domain]) {
          application.domains[domain] = {
            status: 'deferred',
            error: snapshotError?.message || application.resolve.error,
            retryable: true
          }
          publishDomain(state, domain, application.domains[domain])
        }
      }
      application.status = application.superseded
        ? 'deferred'
        : summarize([
            application.resolve,
            ...Object.values(application.dependencies),
            ...Object.values(application.domains)
          ])
      if (snapshot) {
        publishCurrent(state, {
          snapshot: { status: 'available', error: null },
          delivery: { status: 'unconfirmed', error: null, reason: 'pending' }
        })
        const broadcast = await capture(state, 'delivery', () =>
          broadcastSettingsChanged(plain(snapshot))
        )
        if (!broadcast.ok) delivery = { status: 'failed', error: broadcast.error }
        else if (broadcast.result === false) {
          delivery = {
            status: 'failed',
            error: rememberError(
              state,
              'delivery',
              Object.assign(new Error('设置广播端口明确拒绝了请求'), {
                code: 'SETTINGS_DELIVERY_REJECTED'
              })
            )
          }
        } else {
          // A void broadcaster returning normally only confirms this invocation,
          // never renderer receipt, CSS application or visible pixels.
          delivery = { status: 'completed', error: null, confirmation: 'invocation-only' }
        }
        if (!currentContext(state) || hasSupersededWork(state)) {
          snapshot = null
          application.superseded = true
          application.status = 'deferred'
          snapshotError = {
            message: '设置请求所属页面或领域应用已失效',
            code: 'SETTINGS_APPLICATION_SUPERSEDED'
          }
        }
      }
      publishCurrent(state, {
        resolve: application.resolve,
        snapshot: snapshot
          ? { status: 'available', error: null }
          : snapshotError?.code === 'SETTINGS_INTERNAL_NO_DOCUMENT' && !application.superseded
            ? { status: 'not-required', error: null, reason: 'main-runtime' }
            : {
                status: 'unavailable',
                error: plain(snapshotError) || { message: '未取得当前页面的权威设置快照' }
              },
        verification,
        delivery,
        superseded: application.superseded
      })
      const metadata = {
        persistence: { status: reason === 'commit' ? 'saved' : 'unchanged', commitId },
        application,
        verification,
        delivery
      }
      return snapshot
        ? { ...snapshot, ...metadata }
        : {
            kind: 'settings-saved',
            source: plain(state.context?.source) ?? null,
            ...metadata,
            snapshot: null,
            snapshotError: snapshotError || { message: '未取得当前页面的权威设置快照' }
          }
    } finally {
      state.terminal = true
      publishCurrent(state, { phase: 'settled' })
    }
  }

  function snapshotLedger(scope) {
    const project = (record) => ({
      ...record,
      ledgerRevision,
      domains: { ...record.domains, ...(windowDomain ? { window: windowDomain } : {}) }
    })
    return plain(
      scope === undefined
        ? [...ledger.values()].map(project)
        : SCOPES.has(scope)
          ? project(
              ledger.get(scope) || {
                scope,
                commitId: null,
                current: null,
                dependencies: {},
                domains: {},
                errors: []
              }
            )
          : null
    )
  }

  return Object.freeze({
    completeCommittedSettings({
      scope,
      context,
      ids = [],
      previousDockConfig = null,
      applyBlurRuntime = true,
      verify,
      reset = false
    }) {
      const domains = DOMAINS.filter((domain) =>
        domain === 'blur'
          ? ids.some(
              (id) => id.startsWith('blur.') || ['css.bgColor', 'css.windowOpacity'].includes(id)
            )
          : ids.some((id) => id.startsWith(`${domain}.`))
      )
      return execute({
        scope,
        context,
        ids,
        previousDockConfig,
        applyBlurRuntime,
        verify,
        reset,
        domains,
        reason: 'commit'
      })
    },
    retryAppliedSettings(input) {
      const explicitDependencies = Boolean(input && Object.hasOwn(input, 'dependencies'))
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !['domains', 'dependencies', 'context'].includes(key)) ||
        !Array.isArray(input.domains) ||
        (!explicitDependencies && !input.domains.length) ||
        Array.from(input.domains).some((domain) => !DOMAINS.includes(domain)) ||
        (explicitDependencies &&
          (!Array.isArray(input.dependencies) ||
            Array.from(input.dependencies).some((name) => !dependencyNames.has(name)))) ||
        !SCOPES.has(input.context?.scope)
      )
        return Promise.reject(new TypeError('应用重试只接受当前页面上下文与允许的领域'))
      const domains = [...new Set(input.domains)]
      let selectedDependencies
      if (explicitDependencies) {
        selectedDependencies = [
          ...new Set([
            ...input.dependencies,
            ...domains.flatMap((domain) => domainDependencies[domain] || [])
          ])
        ]
        if (selectedDependencies.some((name) => !dependencyNames.has(name)))
          return Promise.reject(new TypeError('应用重试只接受已注册的固定依赖'))
      }
      return execute({
        scope: input.context.scope,
        context: input.context,
        domains,
        // Older internal callers deliberately retain their fixed dependency
        // policy. Explicit arrays select only these targets and prerequisites.
        selectedDependencies,
        reason: 'retry'
      })
    },
    snapshotLedger
  })
}
