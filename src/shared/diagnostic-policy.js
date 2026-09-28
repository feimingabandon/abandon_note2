// 采集策略是源头协议：severity 不决定是否执行昂贵观察。
export const DIAGNOSTIC_LIMITS = Object.freeze({
  policyVersion: 1,
  dailyIntervalMs: 30_000,
  deepIntervalMs: 5_000,
  deepDurationMs: 10 * 60_000,
  maxDeepDurationMs: 30 * 60_000,
  ringBytes: 2 * 1024 * 1024,
  ringAgeMs: 120_000,
  writerBytes: 3 * 1024 * 1024,
  reservedBytes: 512 * 1024,
  transportBytes: 1024 * 1024,
  producerBytes: 256 * 1024,
  eventBytes: 8 * 1024,
  errorBytes: 32 * 1024,
  metricBytes: 64 * 1024,
  captureBytes: 10 * 1024 * 1024
})

export function dailyDiagnosticPolicy(epoch = 0) {
  return {
    policyVersion: 1,
    policyEpoch: epoch,
    mode: 'daily',
    captureId: null,
    startedAt: null,
    expiresAt: null,
    remainingMs: 0,
    sampleIntervalMs: DIAGNOSTIC_LIMITS.dailyIntervalMs
  }
}

export function isDeepDiagnostics(policy, now = Date.now()) {
  return policy?.mode === 'deep' && Number(policy.expiresAt) > now
}

export function diagnosticRecordKind(record) {
  if (['event', 'metric', 'trace'].includes(record.kind)) return record.kind
  if (String(record.scope || '').startsWith('performance.')) return 'metric'
  if (
    String(record.scope || '').startsWith('action.') ||
    String(record.scope || '').startsWith('diagnostic.') ||
    record.scope === 'ipc.action'
  ) {
    // 只有主进程的最终业务结果常态落盘，避免每端都重复保存同一结果。
    if (record.scope === 'ipc.action' && record.phase === 'returned') return 'event'
    return 'trace'
  }
  return 'event'
}

export function diagnosticDestination(record, policy, now = Date.now()) {
  if (record.detail === true && !isDeepDiagnostics(policy, now)) return 'drop'
  if (['warn', 'error', 'fatal'].includes(record.level)) return 'persist'
  if (['failure', 'mismatch', 'rejected'].includes(record.outcome)) return 'persist'
  const deep = isDeepDiagnostics(policy, now)
  if (/console/.test(String(record.scope || '')) || record.level === 'debug')
    return deep ? 'persist' : 'drop'
  if (diagnosticRecordKind(record) === 'trace') return deep ? 'persist' : 'ring'
  return 'persist'
}

export function diagnosticRecordLimit(record) {
  if (diagnosticRecordKind(record) === 'metric') return DIAGNOSTIC_LIMITS.metricBytes
  return ['error', 'fatal'].includes(record.level)
    ? DIAGNOSTIC_LIMITS.errorBytes
    : DIAGNOSTIC_LIMITS.eventBytes
}

export function diagnosticHash(value) {
  let hash = 2166136261
  const text = String(value || '').slice(0, 1024)
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return hash >>> 0
}

export function isDetailedOperation(category, operation) {
  return (
    category === 'native' ||
    category === 'scheduler-check' ||
    /hydrate|toNoteListItems|layout|vue-update|next-frame/i.test(operation)
  )
}
