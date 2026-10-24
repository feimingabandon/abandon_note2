import { isSettingsSource, sameSettingsSource } from './settings-receipt.js'

export const SETTINGS_APPLICATION_DOMAINS = Object.freeze(['window', 'blur', 'dock'])
export const SETTINGS_APPLICATION_DEPENDENCIES = Object.freeze([
  'blurConfig',
  'theme',
  'remote',
  'resetBindings',
  'resetGeometry'
])

const statuses = new Set([
  'pending',
  'applied',
  'failed',
  'deferred',
  'unconfirmed',
  'skipped',
  'completed',
  'available',
  'unavailable',
  'not-required'
])
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const onlyKeys = (value, keys) =>
  record(value) && Object.keys(value).every((key) => keys.includes(key))
const sequence = (value) => Number.isSafeInteger(value) && value >= 0
const message = (value) =>
  value == null ||
  typeof value === 'string' ||
  (onlyKeys(value, ['message', 'code']) &&
    typeof value.message === 'string' &&
    (value.code === undefined || typeof value.code === 'string' || typeof value.code === 'number'))
const result = (value) =>
  onlyKeys(value, ['status', 'error', 'retryable', 'reason', 'confirmation', 'attempt']) &&
  statuses.has(value.status) &&
  message(value.error) &&
  (value.attempt === undefined || sequence(value.attempt)) &&
  (value.retryable === undefined || typeof value.retryable === 'boolean') &&
  (value.reason === undefined || typeof value.reason === 'string') &&
  (value.confirmation === undefined || typeof value.confirmation === 'string')
const names = (value, allowed) =>
  Array.isArray(value) &&
  value.length <= allowed.length &&
  value.every((name) => allowed.includes(name)) &&
  new Set(value).size === value.length

/** The retry command contains targets only, never a save payload or caller context. */
export function isSettingsApplicationRetry(value) {
  return (
    onlyKeys(value, ['domains', 'dependencies']) &&
    names(value.domains, SETTINGS_APPLICATION_DOMAINS) &&
    names(value.dependencies, SETTINGS_APPLICATION_DEPENDENCIES)
  )
}

/** Validate the metadata channel independently of settings values and their revision. */
export function isSettingsApplicationState(value, { source } = {}) {
  if (
    !onlyKeys(value, ['source', 'ledgerRevision', 'ledger']) ||
    !isSettingsSource(value.source) ||
    (source !== undefined && !sameSettingsSource(value.source, source)) ||
    !sequence(value.ledgerRevision)
  )
    return false
  const ledger = value.ledger
  if (
    !onlyKeys(ledger, [
      'scope',
      'ledgerRevision',
      'commitId',
      'current',
      'domains',
      'dependencies',
      'errors'
    ]) ||
    ledger.scope !== value.source.scope ||
    (ledger.ledgerRevision !== undefined && ledger.ledgerRevision !== value.ledgerRevision) ||
    !(
      ledger.commitId == null ||
      typeof ledger.commitId === 'string' ||
      sequence(ledger.commitId)
    ) ||
    !record(ledger.domains) ||
    !record(ledger.dependencies) ||
    !Array.isArray(ledger.errors) ||
    ledger.errors.length > 64
  )
    return false
  for (const [entries, allowed] of [
    [ledger.domains, SETTINGS_APPLICATION_DOMAINS],
    [ledger.dependencies, SETTINGS_APPLICATION_DEPENDENCIES]
  ]) {
    if (Object.entries(entries).some(([name, entry]) => !allowed.includes(name) || !result(entry)))
      return false
  }
  if (
    ledger.errors.some(
      (entry) =>
        !onlyKeys(entry, ['attempt', 'stage', 'error']) ||
        !sequence(entry.attempt) ||
        typeof entry.stage !== 'string' ||
        !message(entry.error)
    )
  )
    return false
  if (ledger.current === null) return true
  const current = ledger.current
  return (
    onlyKeys(current, [
      'attempt',
      'reason',
      'phase',
      'targets',
      'resolve',
      'snapshot',
      'verification',
      'delivery',
      'superseded'
    ]) &&
    sequence(current.attempt) &&
    ['commit', 'retry'].includes(current.reason) &&
    ['running', 'settled'].includes(current.phase) &&
    typeof current.superseded === 'boolean' &&
    isSettingsApplicationRetry(current.targets) &&
    [current.resolve, current.snapshot, current.verification, current.delivery].every(result)
  )
}
