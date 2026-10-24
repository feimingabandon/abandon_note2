/** Compatibility facade; concrete DB and storage owners live in narrow modules. */
import { app } from 'electron'
import { resolve } from 'node:path'
import { initializeDatabase } from './db-runtime.js'
import { recoverPendingAttachments } from './attachment-recovery.js'
import { createAttachmentRecoveryReport } from './attachment-recovery-report.js'
import { getDbIfInitialized } from './db-connection.js'
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

// Reports belong to their database object; they never own a second DB handle.
// A later recovery on the same source replaces this entry before work starts,
// so an earlier round finishing cannot publish over the newer round.
const attachmentRecoveryReports = new WeakMap()
const unstartedAttachmentRecoveryReport = createAttachmentRecoveryReport()
const reportProfile = (value) => resolve(value).toLowerCase()
function currentReportDatabase() {
  const connection = getDbIfInitialized()
  return connection &&
    (typeof connection === 'object' || typeof connection === 'function') &&
    connection.open !== false
    ? connection
    : null
}

/** Read the current source's in-memory report without starting storage work. */
export function getAttachmentRecoveryReport() {
  const connection = currentReportDatabase()
  const owned = connection && attachmentRecoveryReports.get(connection)
  if (!owned || owned.profile !== reportProfile(app.getPath('userData')))
    return unstartedAttachmentRecoveryReport.snapshot()
  return owned.report.snapshot()
}

export function initDatabase({ userDataPath = app.getPath('userData') } = {}) {
  return initializeDatabase({ userDataPath })
}

export function cleanupPendingAttachmentDirs({ onRecovery = () => {} } = {}) {
  const userDataPath = app.getPath('userData')
  const report = createAttachmentRecoveryReport()
  const connection = currentReportDatabase()
  if (connection)
    attachmentRecoveryReports.set(connection, {
      profile: reportProfile(userDataPath),
      report
    })
  return recoverPendingAttachments({
    userDataPath,
    resolveAttachmentPath: resolveImagePath,
    onRecovery,
    report
  })
}

export function clearNoteData() {
  return resetBusinessData({ userDataPath: app.getPath('userData') })
}
