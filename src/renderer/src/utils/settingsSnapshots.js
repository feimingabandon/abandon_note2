import { SETTING_DEFINITIONS } from '../../../shared/settings-schema.js'
import {
  isSettingsSnapshot,
  parseSettingsReceipt,
  sameSettingsSource
} from '../../../shared/settings-receipt.js'

const stores = new WeakMap()
const definitions = new Map(SETTING_DEFINITIONS.map((definition) => [definition.id, definition]))
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
// Form arrays/objects can be Vue proxies; the bridge payload itself is plain data.
function copy(value) {
  if (Array.isArray(value)) return value.map(copy)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]))
  return value
}

function sameValues(left, right) {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && left.length !== right.length) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValues(left[key], right[key]))
  )
}

function mergeValues(target, partial) {
  for (const [key, value] of Object.entries(partial || {})) {
    if (unsafeKeys.has(key) || value === undefined) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key]))
        target[key] = {}
      mergeValues(target[key], value)
    } else target[key] = copy(value)
  }
}

function fieldsForValues(values) {
  const fields = []
  for (const definition of definitions.values()) {
    let value = values
    for (const segment of definition.path) {
      value = value && Object.hasOwn(value, segment) ? value[segment] : undefined
    }
    if (value !== undefined) {
      fields.push({ key: definition.path.join('.'), path: definition.path, value: copy(value) })
    }
  }
  return fields
}

function fieldValues(field) {
  const values = {}
  let cursor = values
  for (const segment of field.path.slice(0, -1)) cursor = cursor[segment] = {}
  cursor[field.path.at(-1)] = copy(field.value)
  return values
}

function assignField(values, field) {
  let cursor = values
  for (const segment of field.path.slice(0, -1)) {
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment]))
      cursor[segment] = {}
    cursor = cursor[segment]
  }
  cursor[field.path.at(-1)] = copy(field.value)
}

/** One document owns accepted snapshots and its still-unconfirmed local values. */
export function createSettingsSnapshotStore(api) {
  const listeners = new Map()
  const owners = new Map()
  const leases = new WeakMap()
  const saved = new Map()
  const settledSequences = new Map()
  let stopTransport = null
  let current = null
  let documentSource = null
  let resetFloor = 0
  let resetPending = null
  let lastResetSettlement = null
  let version = 0
  let externalVersion = 0
  let readSequence = 0
  let acceptedReadSequence = 0
  let intentSequence = 0

  function status() {
    return {
      availability: current && !resetPending ? 'available' : 'unavailable',
      awaitingCanonical: saved.size > 0 || Boolean(resetPending),
      savedCount: saved.size,
      resetPending: Boolean(resetPending)
    }
  }

  function project() {
    if (!current || resetPending) return null
    const snapshot = copy(current)
    const intents = [
      ...saved.values(),
      ...[...owners.values()].flatMap((entries) => [...entries.values()])
    ]
    intents.sort((left, right) => left.sequence - right.sequence)
    for (const intent of intents) {
      mergeValues(snapshot.values, intent.values)
      // Object-valued settings, such as a weather region, are one setting value.
      // Replacing one must not inherit fields from an older region.
      for (const field of intent.fields || []) assignField(snapshot.values, field)
    }
    // Runtime remains the platform's observation, even while values are a local preview.
    return snapshot
  }

  function deliver(subscription, origin) {
    const { callback, availabilityEvents } = subscription
    const projection = project()
    if (!projection && !availabilityEvents) return
    const failed = (error) => console.warn('[SettingsSnapshot] 同步设置消费者失败:', error)
    try {
      const result = callback(projection, { origin, ...(availabilityEvents ? status() : {}) })
      // Consumers can finish their query/layout work asynchronously; observe its
      // rejection without serializing or delaying the other subscribers.
      if (result && typeof result.then === 'function') void Promise.resolve(result).catch(failed)
    } catch (error) {
      failed(error)
    }
  }

  function notify(origin) {
    for (const [ticket, subscription] of [...listeners]) {
      if (listeners.has(ticket)) deliver(subscription, origin)
    }
  }

  function reconcileRead(readTicket) {
    let reconciled = false
    // Revision or value equality cannot prove coverage. Only a raw read started
    // after acknowledgement may retire that save/reset's protection.
    for (const [key, shadow] of saved) {
      if (readTicket > shadow.readFence) {
        saved.delete(key)
        reconciled = true
      }
    }
    if (resetPending && readTicket > resetPending.readFence) {
      resetPending = null
      reconciled = true
    }
    return reconciled
  }

  function receive(snapshot, origin, readTicket, readVersion, { silent = false } = {}) {
    if (!isSettingsSnapshot(snapshot)) return false
    if (documentSource && !sameSettingsSource(snapshot.source, documentSource)) return false
    if (current) {
      if (
        snapshot.source.token !== current.source.token ||
        snapshot.source.scope !== current.source.scope ||
        snapshot.revision < current.revision
      )
        return false
      // The settings revision does not version every OS/native observation.
      // An equal-revision read may refresh runtime only while it still owns its request.
      if (origin === 'read' && snapshot.revision === current.revision) {
        if (readTicket < acceptedReadSequence) return false
        if (readVersion !== externalVersion) {
          // The getter can send this same canonical base before its IPC reply.
          // Confirm covered saves/reset only; keep the accepted base's newer
          // OS/native observations and every still-pending local intent.
          if (!sameValues(snapshot.values, current.values) || !reconcileRead(readTicket))
            return false
          acceptedReadSequence = Math.max(acceptedReadSequence, readTicket)
          version += 1
          if (!silent) notify(origin)
          return true
        }
      }
    }
    if (!documentSource) documentSource = copy(snapshot.source)
    current = copy(snapshot)
    if (origin === 'read') {
      acceptedReadSequence = Math.max(acceptedReadSequence, readTicket)
      reconcileRead(readTicket)
    } else externalVersion += 1
    version += 1
    if (!silent) notify(origin)
    return true
  }

  function ensureTransport() {
    if (stopTransport || typeof api.onSettingsChanged !== 'function') return
    const stop = api.onSettingsChanged((snapshot) => receive(snapshot, 'broadcast'))
    stopTransport = typeof stop === 'function' ? stop : () => {}
  }

  function revealsSaved(entry) {
    return entry.fields.some((field) => {
      const shadow = saved.get(field.key)
      return shadow && shadow.sequence < entry.sequence
    })
  }

  function supersededBySaved(entry) {
    return entry.fields.some((field) => (settledSequences.get(field.key) || 0) > entry.sequence)
  }

  function ownsDisplay(entry) {
    if (!entry?.release.isActive()) return false
    const keys = new Set(entry.fields.map((field) => field.key))
    return ![...owners.values()].some((entries) =>
      [...entries.values()].some(
        (other) =>
          other.sequence > entry.sequence && other.fields.some((field) => keys.has(field.key))
      )
    )
  }

  function protect(owner, key, values, sequence = ++intentSequence) {
    let entries = owners.get(owner)
    if (!entries) owners.set(owner, (entries = new Map()))
    const entry = {
      sequence,
      source: documentSource ? copy(documentSource) : null,
      values: copy(values),
      fields: fieldsForValues(values),
      settled: false,
      silentRelease: false,
      release: null
    }
    entries.set(key, entry)
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (entries.get(key) !== entry) return
      entries.delete(key)
      if (!entries.size && owners.get(owner) === entries) owners.delete(owner)
      // Removing a preview never replays a potentially older base over a confirmed reply.
      // A saved underlay is different: discarding B must reveal confirmed saved A.
      if (!entry.silentRelease && revealsSaved(entry)) {
        version += 1
        notify('release')
      }
    }
    release.isActive = () =>
      !released &&
      owners.get(owner) === entries &&
      entries.get(key) === entry &&
      !supersededBySaved(entry)
    entry.release = release
    leases.set(release, entry)
    return release
  }

  function settlement(parsed, { settled = false, current: ownsCurrent = false } = {}) {
    return {
      ...parsed,
      settled,
      current: ownsCurrent,
      projection: project(),
      unavailable: status().availability === 'unavailable'
    }
  }

  function parseReceipt(result) {
    return parseSettingsReceipt(result, documentSource ? { source: documentSource } : {})
  }

  function settleWrite(lease, result) {
    const parsed = parseReceipt(result)
    const entry = leases.get(lease)
    const ownsCurrent = ownsDisplay(entry)
    if (!parsed.valid || !parsed.saved || !entry) return settlement(parsed)
    if (
      entry.sequence <= resetFloor ||
      (entry.source && !sameSettingsSource(entry.source, parsed.source))
    ) {
      return settlement(parsed)
    }
    if (entry.settled) return settlement(parsed, { settled: true })
    if (!documentSource) documentSource = copy(parsed.source)
    // Replacing A's display lease with B does not revoke A's SQL result. Keep A
    // below B, but never recreate A after a later saved B or confirmed reset.
    for (const field of entry.fields) {
      if ((settledSequences.get(field.key) || 0) > entry.sequence) continue
      settledSequences.set(field.key, entry.sequence)
      if (parsed.canonical) {
        if ((saved.get(field.key)?.sequence || 0) <= entry.sequence) saved.delete(field.key)
      } else {
        saved.set(field.key, {
          sequence: entry.sequence,
          values: fieldValues(field),
          fields: [field],
          readFence: readSequence,
          commitId: parsed.persistence?.commitId ?? null
        })
      }
    }
    entry.settled = true
    entry.silentRelease = true
    entry.release()
    entry.silentRelease = false
    for (const [owner, entries] of owners) {
      for (const [key, pending] of entries) {
        if (supersededBySaved(pending)) entries.delete(key)
      }
      if (!entries.size) owners.delete(owner)
    }
    if (parsed.canonical)
      receive(parsed.canonical, 'commit', undefined, undefined, { silent: true })
    externalVersion += 1
    version += 1
    notify('commit')
    return settlement(parsed, { settled: true, current: ownsCurrent })
  }

  function settleReset(result, { checkpoint = intentSequence } = {}) {
    const parsed = parseReceipt(result)
    if (
      !parsed.valid ||
      !parsed.saved ||
      !Number.isSafeInteger(checkpoint) ||
      checkpoint < resetFloor ||
      checkpoint < 0
    ) {
      return settlement(parsed)
    }
    if (!documentSource) documentSource = copy(parsed.source)
    if (
      parsed.persistence?.commitId != null &&
      lastResetSettlement?.commitId === parsed.persistence.commitId &&
      lastResetSettlement.checkpoint === checkpoint
    ) {
      return settlement(parsed, { settled: true })
    }
    lastResetSettlement = { checkpoint, commitId: parsed.persistence?.commitId ?? null }
    resetFloor = checkpoint
    for (const [owner, entries] of owners) {
      for (const [key, entry] of entries) {
        if (entry.sequence <= checkpoint) entries.delete(key)
      }
      if (!entries.size) owners.delete(owner)
    }
    for (const [key, shadow] of saved) {
      if (shadow.sequence <= checkpoint) saved.delete(key)
    }
    if (parsed.canonical) {
      resetPending = null
      receive(parsed.canonical, 'reset', undefined, undefined, { silent: true })
    } else {
      // Reset is committed, but its resulting values are unknown. Quarantine the
      // old base instead of publishing it as defaults or discarding later intents.
      resetPending = { checkpoint, readFence: readSequence }
    }
    externalVersion += 1
    version += 1
    notify('reset')
    return settlement(parsed, { settled: true, current: true })
  }

  return Object.freeze({
    subscribe(callback, { replay = true, availabilityEvents = false } = {}) {
      const ticket = Symbol('settings-snapshot-subscriber')
      const previousVersion = version
      const subscription = { callback, availabilityEvents }
      listeners.set(ticket, subscription)
      try {
        ensureTransport()
        if (replay && (current || availabilityEvents) && version === previousVersion)
          deliver(subscription, 'replay')
      } catch (error) {
        listeners.delete(ticket)
        if (!listeners.size) {
          const stop = stopTransport
          stopTransport = null
          stop?.()
        }
        throw error
      }
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        listeners.delete(ticket)
        if (!listeners.size) {
          const stop = stopTransport
          stopTransport = null
          stop?.()
        }
      }
    },
    async read({ allowCachedOnError = true, protectIntents = true } = {}) {
      const ticket = ++readSequence
      const previousVersion = externalVersion
      let snapshot
      try {
        snapshot = await api.getSettingsSnapshot()
      } catch (error) {
        if (allowCachedOnError && current && !resetPending)
          return protectIntents ? project() : copy(current)
        throw error
      }
      const sourceMatches = !documentSource || sameSettingsSource(snapshot?.source, documentSource)
      if (
        (!isSettingsSnapshot(snapshot) || !sourceMatches) &&
        (!allowCachedOnError || !current || resetPending)
      ) {
        const error = new Error('设置快照缺少有效的页面来源或版本')
        error.code = 'SETTINGS_SNAPSHOT_INVALID'
        throw error
      }
      const accepted = receive(snapshot, 'read', ticket, previousVersion)
      if ((!accepted && !current) || resetPending) {
        const error = new Error('设置快照缺少有效的页面来源或版本')
        error.code = 'SETTINGS_SNAPSHOT_INVALID'
        throw error
      }
      return protectIntents ? project() : copy(current)
    },
    latest: project,
    status,
    settleWrite,
    settleReset,
    captureIntentCheckpoint: () => intentSequence,
    acceptReset(snapshot, { checkpoint = intentSequence } = {}) {
      return settleReset(snapshot, { checkpoint }).settled
    },
    acceptCommitted(snapshot, { reconcile = false } = {}) {
      const accepted = receive(snapshot, 'commit')
      if (
        !accepted &&
        reconcile &&
        isSettingsSnapshot(snapshot) &&
        current &&
        snapshot.source.token === current.source.token &&
        snapshot.source.scope === current.source.scope &&
        snapshot.revision < current.revision
      ) {
        // A confirmed caller may just have released its preview. Publish the newer
        // accepted base, never the rejected reply, so normalized values converge.
        version += 1
        externalVersion += 1
        notify('commit')
      }
      return accepted
    },
    protectSetting(owner, id, value, { continuationOf } = {}) {
      // A delayed presentation may derive its write while a reset is in flight.
      // Keep that write on the original click's side of the reset checkpoint.
      const parent = continuationOf ? leases.get(continuationOf) : null
      if (continuationOf && (!parent || !continuationOf.isActive())) {
        const release = () => {}
        release.isActive = () => false
        return release
      }
      const definition = definitions.get(id)
      // Unknown IDs still reach the existing main-process rejection path.
      if (!definition) {
        let released = false
        const release = () => {
          released = true
        }
        release.isActive = () => !released
        return release
      }
      const values = {}
      let cursor = values
      for (const segment of definition.path.slice(0, -1)) cursor = cursor[segment] = {}
      cursor[definition.path.at(-1)] = copy(value)
      return protect(owner, `setting:${id}`, values, parent?.sequence)
    },
    protectDomain(owner, domain, partialValues = {}) {
      return protect(owner, `domain:${domain}`, partialValues)
    },
    clearOwner(owner) {
      const entries = owners.get(owner)
      owners.delete(owner)
      if (entries && [...entries.values()].some(revealsSaved)) {
        version += 1
        notify('release')
      }
    },
    get protectedCount() {
      return [...owners.values()].reduce((count, entries) => count + entries.size, 0)
    }
  })
}

/** The bridge API is stable for one preload/document; replacement documents get a new owner. */
export function getSettingsSnapshotStore(api = window.api) {
  let store = stores.get(api)
  if (!store) {
    store = createSettingsSnapshotStore(api)
    stores.set(api, store)
  }
  return store
}
