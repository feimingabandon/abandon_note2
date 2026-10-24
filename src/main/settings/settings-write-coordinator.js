import { serializeSetting } from '../../shared/settings-schema.js'
import {
  APPLICATION_SETTING_IDS,
  writeApplicationSettings as writeApplicationBatch
} from './application-settings.js'
import {
  getAllSettings as readRows,
  runSettingsTransaction as runTransaction,
  setSettingsBatch as writeViewBatch
} from '../db/db-settings-repository.js'
import { diagnosticState } from '../logging/diagnostic-state.js'
import { currentOperation } from '../logging/operation-context.js'
import { readSettingEvidence, reportSettingEvidence } from '../logging/persistence-evidence.js'

/** Owns the full settings write sequence; resolved values and revision remain solely in SettingsRuntime. */
export function createSettingsWriteCoordinator({
  getActiveWindowName,
  refreshResolvedSettings,
  applyResolvedWindowRuntime,
  applyResolvedBlurRuntime,
  getDockRuntimeConfig,
  reconcileDockRuntimeConfig,
  getResolvedSettingsSnapshot,
  broadcastSettingsChanged,
  completeCommittedSettings,
  getAllSettings = readRows,
  runSettingsTransaction = runTransaction,
  setSettingsBatch = writeViewBatch,
  writeApplicationSettings = writeApplicationBatch,
  observeVerification = () => diagnosticState.observation(currentOperation()?.actionId)
}) {
  if (completeCommittedSettings !== undefined && typeof completeCommittedSettings !== 'function')
    throw new TypeError('设置提交后端口必须是函数')
  const APPLICATION_SETTING_ID_SET = new Set(APPLICATION_SETTING_IDS)
  function persistSettingValues(entries, { applyBlurRuntime = true, applicationContext } = {}) {
    const changesDockConfig = entries.some(({ id }) => id.startsWith('dock.'))
    const previousDockConfig = changesDockConfig ? getDockRuntimeConfig() : null
    const normalizedEntries = entries.map(({ id, value }) => ({
      id,
      ...serializeSetting(id, value)
    }))
    const evidenceScope = getActiveWindowName()
    const evidenceTicket = observeVerification()
    if (currentOperation()) currentOperation().verification = evidenceTicket.reason
    const beforeEvidence = readSettingEvidence(
      normalizedEntries,
      getAllSettings,
      APPLICATION_SETTING_ID_SET,
      evidenceScope,
      evidenceTicket
    )
    const applicationEntries = normalizedEntries.filter(({ id }) =>
      APPLICATION_SETTING_ID_SET.has(id)
    )
    const viewEntries = normalizedEntries.filter(({ id }) => !APPLICATION_SETTING_ID_SET.has(id))
    runSettingsTransaction(() => {
      if (viewEntries.length) setSettingsBatch(getActiveWindowName(), viewEntries)
      if (applicationEntries.length) {
        writeApplicationSettings(applicationEntries.map(({ id, value }) => ({ id, value })))
      }
    })
    if (completeCommittedSettings) {
      return completeCommittedSettings({
        scope: evidenceScope,
        ...(applicationContext === undefined ? {} : { context: applicationContext }),
        ids: normalizedEntries.map(({ id }) => id),
        previousDockConfig,
        applyBlurRuntime,
        verify: () => {
          if (!evidenceTicket.enabled) return { status: 'skipped', reason: evidenceTicket.reason }
          const afterEvidence = readSettingEvidence(
            normalizedEntries,
            getAllSettings,
            APPLICATION_SETTING_ID_SET,
            evidenceScope,
            evidenceTicket
          )
          reportSettingEvidence(beforeEvidence, afterEvidence)
          const completeEvidence =
            Array.isArray(afterEvidence) &&
            afterEvidence.length === normalizedEntries.length &&
            afterEvidence.every(
              (entry, index) =>
                entry?.id === normalizedEntries[index].id &&
                entry.scope ===
                  (APPLICATION_SETTING_ID_SET.has(entry.id) ? 'application' : evidenceScope)
            )
          if (!completeEvidence) return { status: 'unconfirmed', reason: 'readback-unavailable' }
          if (afterEvidence.some((entry) => !entry.exists || entry.stored !== entry.expected))
            return { status: 'unconfirmed', reason: 'readback-mismatch' }
          return { status: 'completed', reason: evidenceTicket.reason }
        }
      })
    }
    reportSettingEvidence(
      beforeEvidence,
      readSettingEvidence(
        normalizedEntries,
        getAllSettings,
        APPLICATION_SETTING_ID_SET,
        evidenceScope,
        evidenceTicket
      )
    )
    refreshResolvedSettings({ incrementRevision: true })

    if (normalizedEntries.some(({ id }) => id.startsWith('window.'))) {
      applyResolvedWindowRuntime()
    }
    const changesBlurRuntime = normalizedEntries.some(
      ({ id }) => id.startsWith('blur.') || id === 'css.bgColor' || id === 'css.windowOpacity'
    )
    if (applyBlurRuntime && changesBlurRuntime) {
      applyResolvedBlurRuntime()
    }
    if (changesDockConfig) reconcileDockRuntimeConfig(previousDockConfig, 'persist')

    const snapshot = getResolvedSettingsSnapshot()
    broadcastSettingsChanged(snapshot)
    return snapshot
  }

  function persistSettingValue(id, value) {
    return persistSettingValues([{ id, value }])
  }
  return { persistSettingValues, persistSettingValue }
}
