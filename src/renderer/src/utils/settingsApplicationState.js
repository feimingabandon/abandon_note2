import {
  isSettingsApplicationState,
  SETTINGS_APPLICATION_DOMAINS,
  SETTINGS_APPLICATION_DEPENDENCIES
} from '../../../shared/settings-application-state.js'
import {
  isSettingsSource,
  parseSettingsReceipt,
  sameSettingsSource
} from '../../../shared/settings-receipt.js'

const stores = new WeakMap()

function copy(value) {
  if (Array.isArray(value)) return value.map(copy)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]))
  return value
}

/** Application observations never own setting values, intent leases or reset checkpoints. */
export function createSettingsApplicationStateStore(api) {
  const listeners = new Map()
  let source = null
  let state = null
  let availability = 'unknown'
  let error = null
  let reading = false
  let stopTransport = null
  let generation = 0
  let readSequence = 0
  let publication = 0

  const status = () => ({ availability, error: copy(error), reading })
  function deliver(callback) {
    const failed = (failure) => console.warn('[SettingsApplication] 同步应用状态失败:', failure)
    try {
      const result = callback(copy(state), status())
      if (result && typeof result.then === 'function') void Promise.resolve(result).catch(failed)
    } catch (failure) {
      failed(failure)
    }
  }
  function notify() {
    for (const [ticket, callback] of [...listeners]) if (listeners.has(ticket)) deliver(callback)
  }
  function bindSource(expected) {
    if (!isSettingsSource(expected)) return false
    if (source) return sameSettingsSource(source, expected)
    source = copy(expected)
    return true
  }
  function accept(value) {
    if (!isSettingsApplicationState(value, source ? { source } : {})) return false
    if (state && value.ledgerRevision < state.ledgerRevision) return false
    if (!bindSource(value.source)) return false
    // An equal revision can restore query availability, but cannot replace the
    // already accepted observation with a different equal-revision payload.
    if (!state || value.ledgerRevision > state.ledgerRevision) state = copy(value)
    availability = 'available'
    error = null
    publication += 1
    notify()
    return true
  }
  function fail(failure) {
    availability = 'unavailable'
    error = { message: failure?.message || String(failure) }
    notify()
  }
  function ensureTransport() {
    if (stopTransport || typeof api.onSettingsApplicationChanged !== 'function') return
    const subscribedGeneration = generation
    const stop = api.onSettingsApplicationChanged((value) => {
      if (generation === subscribedGeneration && listeners.size) accept(value)
    })
    stopTransport = typeof stop === 'function' ? stop : () => {}
  }

  return Object.freeze({
    bindSource,
    accept,
    latest: () => copy(state),
    status,
    subscribe(callback) {
      const ticket = Symbol('settings-application-subscriber')
      listeners.set(ticket, callback)
      try {
        ensureTransport()
        deliver(callback)
      } catch (failure) {
        // An unavailable observation channel must not prevent the settings form
        // from mounting or accepting its independently confirmed values.
        fail(failure)
      }
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        listeners.delete(ticket)
        if (!listeners.size) {
          generation += 1
          reading = false
          stopTransport?.()
          stopTransport = null
        }
      }
    },
    async read() {
      if (typeof api.getSettingsApplicationState !== 'function') return null
      const ticket = ++readSequence
      const startedGeneration = generation
      const previousPublication = publication
      reading = true
      notify()
      try {
        const result = await api.getSettingsApplicationState()
        if (generation !== startedGeneration || ticket !== readSequence) return copy(state)
        if (!isSettingsApplicationState(result, source ? { source } : {}))
          throw new Error('应用状态缺少有效的页面来源或版本')
        accept(result)
        return copy(state)
      } catch (failure) {
        if (
          generation === startedGeneration &&
          ticket === readSequence &&
          publication === previousPublication
        )
          fail(failure)
        throw failure
      } finally {
        if (generation === startedGeneration && ticket === readSequence) {
          reading = false
          notify()
        }
      }
    },
    async retry(targets, { isCurrent = () => true } = {}) {
      if (
        !targets ||
        Object.keys(targets).some((key) => !['domains', 'dependencies'].includes(key)) ||
        !Array.isArray(targets.domains) ||
        !Array.isArray(targets.dependencies) ||
        targets.domains.some((domain) => !SETTINGS_APPLICATION_DOMAINS.includes(domain)) ||
        targets.dependencies.some((name) => !SETTINGS_APPLICATION_DEPENDENCIES.includes(name))
      )
        throw new TypeError('应用重试只接受明确的领域和依赖名单')
      const startedGeneration = generation
      const previousPublication = publication
      try {
        const result = await api.retrySettingsApplication({
          domains: [...new Set(targets.domains)],
          dependencies: [...new Set(targets.dependencies)]
        })
        if (generation !== startedGeneration || !isCurrent()) return result
        const receipt = parseSettingsReceipt(result, source ? { source } : {})
        if (!receipt.valid || receipt.persistence?.status !== 'unchanged')
          throw new Error('应用重试未返回有效的无需再次保存回执')
        if (!isSettingsApplicationState(result?.applicationState, source ? { source } : {}))
          throw new Error('应用重试结果缺少有效的当前状态')
        accept(result.applicationState)
        // The receipt intentionally remains unchanged. In particular, its
        // persistence:unchanged never enters a SQL settlement or value read fence.
        return result
      } catch (failure) {
        if (generation === startedGeneration && isCurrent() && publication === previousPublication)
          fail(failure)
        throw failure
      }
    }
  })
}

export function getSettingsApplicationStateStore(api = window.api) {
  let store = stores.get(api)
  if (!store) {
    store = createSettingsApplicationStateStore(api)
    stores.set(api, store)
  }
  return store
}
