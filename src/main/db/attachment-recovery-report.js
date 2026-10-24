import { randomUUID } from 'node:crypto'

const STATUS_ORDER = [
  'undetermined',
  'preservedConflict',
  'referenceMissing',
  'cleanupPending',
  'completed'
]

const copy = (value) => structuredClone(value)
const reasonFor = (error) => error?.message || String(error)

/** One in-memory observation round. Reading it never re-runs recovery or touches storage. */
export function createAttachmentRecoveryReport() {
  const operations = new Map()
  let phase = 'not-started'
  let currentPhase = 'not-started'
  let roundId = null
  let startedAt = null
  let finishedAt = null
  let failure = null

  function operation(key, { operationId, operationType }) {
    let entry = operations.get(key)
    if (!entry) {
      entry = {
        operationId,
        operationType,
        decision: 'unknown',
        phase: 'read-manifest',
        action: null,
        result: 'undetermined',
        observations: [],
        failures: [],
        cleanupOnly: false
      }
      operations.set(key, entry)
    }
    return Object.freeze({
      type(value) {
        entry.operationType = value
      },
      decision(value) {
        entry.decision = value
      },
      phase(value, cleanupOnly = false) {
        entry.phase = value
        entry.cleanupOnly = cleanupOnly
      },
      observe(status, error) {
        entry.observations.push({
          status,
          phase: entry.phase,
          ...(error ? { reason: reasonFor(error) } : {})
        })
      },
      finish(action = entry.action, status = 'completed') {
        entry.action = action
        entry.result = status
      },
      action(value) {
        entry.action = value
      },
      fail(error) {
        entry.result =
          entry.cleanupOnly && entry.decision !== 'unknown' ? 'cleanupPending' : 'undetermined'
        const failure = { phase: entry.phase, reason: reasonFor(error) }
        const previous = entry.failures.at(-1)
        if (previous?.phase !== failure.phase || previous?.reason !== failure.reason)
          entry.failures.push(failure)
      }
    })
  }

  return Object.freeze({
    start() {
      if (phase !== 'not-started') throw new Error('附件恢复报告只能用于一轮恢复')
      roundId = randomUUID()
      startedAt = new Date().toISOString()
      phase = 'running'
    },
    phase(value) {
      currentPhase = value
    },
    operation,
    finish() {
      phase = 'finished'
      finishedAt = new Date().toISOString()
    },
    fail(error) {
      phase = 'failed'
      failure = { phase: currentPhase, reason: reasonFor(error) }
      finishedAt = new Date().toISOString()
    },
    snapshot() {
      const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]))
      const values = [...operations.values()].map((entry) => {
        const statuses = STATUS_ORDER.filter(
          (status) =>
            (status === entry.result ||
              entry.observations.some((item) => item.status === status)) &&
            (status !== 'completed' ||
              (entry.result === 'completed' && entry.observations.length === 0))
        )
        for (const status of statuses) counts[status] += 1
        const lastFailure = entry.failures.at(-1) || entry.observations.at(-1)
        return {
          operationId: entry.operationId,
          operationType: entry.operationType,
          status: statuses[0],
          statuses,
          action: entry.action,
          decision: entry.decision,
          phase: entry.phase,
          ...(lastFailure ? { failurePhase: lastFailure.phase, reason: lastFailure.reason } : {}),
          observations: entry.observations,
          failures: entry.failures
        }
      })
      return copy({
        schemaVersion: 1,
        scope: 'pending-attachment-recovery-round',
        status:
          phase !== 'finished'
            ? 'undetermined'
            : STATUS_ORDER.find((status) => counts[status] > 0) || 'completed',
        phase,
        partial: phase !== 'finished',
        roundId,
        startedAt,
        finishedAt,
        failure,
        counts,
        operations: values
      })
    }
  })
}
