import { serializeSetting } from '../../shared/settings-schema.js'
import {
  APPLICATION_SETTING_IDS,
  writeApplicationSettings as writeApplicationBatch
} from './application-settings.js'
import {
  getAllSettings as readRows,
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
  getAllSettings = readRows,
  setSettingsBatch = writeViewBatch,
  writeApplicationSettings = writeApplicationBatch,
  observeVerification = () => diagnosticState.observation(currentOperation()?.actionId)
}) {
  const APPLICATION_SETTING_ID_SET = new Set(APPLICATION_SETTING_IDS)
  function persistSettingValues(entries, { applyBlurRuntime = true } = {}) {
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
    if (viewEntries.length) setSettingsBatch(getActiveWindowName(), viewEntries)
    if (applicationEntries.length) {
      writeApplicationSettings(applicationEntries.map(({ id, value }) => ({ id, value })))
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
