const scopes = new Set(['main', 'month', 'week'])

export function isSettingsSource(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    scopes.has(value.scope)
  )
}

export function sameSettingsSource(first, second) {
  return Boolean(
    isSettingsSource(first) &&
    isSettingsSource(second) &&
    first.token === second.token &&
    first.scope === second.scope
  )
}

export function isSettingsSnapshot(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isSettingsSource(value.source) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    value.values &&
    typeof value.values === 'object' &&
    !Array.isArray(value.values)
  )
}

function validCommitId(value) {
  return (
    (typeof value === 'string' && value.length > 0) || (Number.isSafeInteger(value) && value >= 0)
  )
}

/** Decode the save contract without interpreting a native operation's success flag. */
export function parseSettingsReceipt(result, { source: expectedSource } = {}) {
  const empty = {
    valid: false,
    saved: false,
    source: null,
    canonical: null,
    persistence: null,
    application: null,
    snapshotError: null,
    error: null
  }
  const invalid = (message, code = 'SETTINGS_RECEIPT_INVALID') => ({
    ...empty,
    error: { message, code }
  })
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return invalid('设置写入结果缺少可确认的保存回执')
  }
  const nested = result.snapshot
  const candidate = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : result
  const canonical = isSettingsSnapshot(candidate) ? candidate : null
  if (candidate.values !== undefined && !canonical) {
    return invalid('设置写入结果包含无效的设置快照')
  }
  const persistence = candidate.persistence ?? result.persistence ?? null
  const source = candidate.source ?? result.source ?? null
  if (!isSettingsSource(source)) return invalid('设置保存回执缺少有效的页面来源')
  if (
    (expectedSource !== undefined && !sameSettingsSource(source, expectedSource)) ||
    (result.source !== undefined && !sameSettingsSource(source, result.source)) ||
    (canonical && !sameSettingsSource(source, canonical.source))
  ) {
    return invalid('设置保存回执不属于当前页面', 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH')
  }
  if (persistence !== null) {
    if (
      !['saved', 'unchanged'].includes(persistence.status) ||
      (persistence.status === 'saved' && !validCommitId(persistence.commitId)) ||
      (persistence.status === 'unchanged' &&
        persistence.commitId != null &&
        !validCommitId(persistence.commitId))
    ) {
      return invalid('设置保存回执包含无效的持久化标识')
    }
  } else if (!canonical) {
    return invalid('设置写入结果缺少可确认的保存回执')
  }
  if (!canonical && candidate.snapshot !== null) {
    return invalid('未取得设置快照的保存回执必须显式声明 snapshot:null')
  }
  return {
    valid: true,
    // Legacy canonical setters already acknowledge their completed disk write.
    // OS auto-start booleans and shortcut status objects are separate contracts.
    saved: persistence ? persistence.status === 'saved' : true,
    source: { token: source.token, scope: source.scope },
    canonical,
    persistence,
    application: candidate.application ?? result.application ?? null,
    snapshotError: candidate.snapshotError ?? result.snapshotError ?? null,
    error: null
  }
}
