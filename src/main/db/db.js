/** Compatibility facade; concrete DB and storage owners live in narrow modules. */
import { app } from 'electron'
import { initializeDatabase } from './db-runtime.js'
import { recoverPendingAttachments } from './attachment-recovery.js'
import { resetBusinessData } from './business-data-reset.js'
import { resolveImagePath } from './db-images.js'

export { closeDatabase } from './db-runtime.js'
export { getDbIfInitialized as getDb } from './db-connection.js'
export {
  previewHistoricalNotesToToday,
  moveHistoricalNotesToToday
} from './db-historical-note-move.js'
export {
  getAllSettings,
  setSettingsBatch,
  clearAllSettings,
  clearSettings
} from './db-settings-repository.js'

export function initDatabase({ userDataPath = app.getPath('userData') } = {}) {
  return initializeDatabase({ userDataPath })
}

export function cleanupPendingAttachmentDirs({ onRecovery = () => {} } = {}) {
  return recoverPendingAttachments({
    userDataPath: app.getPath('userData'),
    resolveAttachmentPath: resolveImagePath,
    onRecovery
  })
}

export function clearNoteData() {
  return resetBusinessData({ userDataPath: app.getPath('userData') })
}
