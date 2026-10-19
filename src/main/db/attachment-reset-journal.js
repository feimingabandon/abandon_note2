import { getDb } from './db-connection.js'

export const RESET_OPERATION_DIRECTORY_PREFIX = '.attachments-deleting-reset-'
export const isResetOperationId = (value) =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)

/** Internal decisions survive business-data clear and share its SQLite commit. */
export function createAttachmentResetJournalSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS attachment_reset_commits (
    operation_id TEXT PRIMARY KEY NOT NULL,
    committed_at INTEGER NOT NULL CHECK(committed_at >= 0)
  );`)
}

export function recordAttachmentResetCommit(db, operationId) {
  if (!isResetOperationId(operationId)) throw new Error('无效的附件清空操作 ID')
  db.prepare('INSERT INTO attachment_reset_commits (operation_id, committed_at) VALUES (?, ?)').run(
    operationId,
    Date.now()
  )
}

export function hasAttachmentResetCommit(operationId) {
  return Boolean(
    getDb()
      .prepare('SELECT operation_id FROM attachment_reset_commits WHERE operation_id = ?')
      .get(operationId)
  )
}

export function deleteAttachmentResetCommit(operationId) {
  getDb().prepare('DELETE FROM attachment_reset_commits WHERE operation_id = ?').run(operationId)
}

export function listAttachmentResetCommits() {
  return getDb().prepare('SELECT operation_id FROM attachment_reset_commits').all()
}
