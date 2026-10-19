import { join } from 'node:path'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { getDb } from './db-connection.js'
import {
  deleteAttachmentResetCommit,
  recordAttachmentResetCommit,
  RESET_OPERATION_DIRECTORY_PREFIX
} from './attachment-reset-journal.js'

const ATTACHMENT_OPERATION_MANIFEST = 'operation.json'
const ATTACHMENT_OPERATION_COMMITTED = 'committed'

function writeAttachmentOperationManifest(operationDirectory, manifest) {
  const temporaryPath = join(operationDirectory, `${ATTACHMENT_OPERATION_MANIFEST}.tmp`)
  const finalPath = join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST)
  writeFileSync(temporaryPath, JSON.stringify(manifest), 'utf8')
  renameSync(temporaryPath, finalPath)
}

/** 清空便签业务数据；保留 app_settings 和开机自启等系统状态。 */
export async function resetBusinessData({ userDataPath, removeDirectory = rm }) {
  const attachmentsDir = join(userDataPath, 'attachments')
  const operationId = randomUUID()
  const operationDirectory = join(userDataPath, `${RESET_OPERATION_DIRECTORY_PREFIX}${operationId}`)
  const pendingDeleteDir = join(operationDirectory, 'attachments')
  let attachmentsMoved = false

  // 同卷目录重命名是常量时间操作，先将旧附件与后续可能创建的新目录隔离。
  if (existsSync(attachmentsDir)) {
    mkdirSync(operationDirectory)
    writeAttachmentOperationManifest(operationDirectory, {
      version: 2,
      type: 'reset',
      operationId
    })
    renameSync(attachmentsDir, pendingDeleteDir)
    attachmentsMoved = true
  }

  try {
    // 显式清理关联表，保持操作顺序清晰，也避免把大量级联工作留到最后一步。
    const db = getDb()
    db.transaction(() => {
      db.prepare('DELETE FROM desktop_stickies').run()
      db.prepare('DELETE FROM template_tags').run()
      db.prepare('DELETE FROM note_tags').run()
      db.prepare('DELETE FROM note_attachments').run()
      db.prepare('DELETE FROM note_templates').run()
      db.prepare('DELETE FROM notes').run()
      db.prepare('DELETE FROM tags').run()
      if (attachmentsMoved) recordAttachmentResetCommit(db, operationId)
    })()
  } catch (error) {
    // 数据库未提交时恢复附件目录，使数据库记录和文件仍保持一致。
    if (attachmentsMoved && !existsSync(attachmentsDir)) {
      try {
        renameSync(pendingDeleteDir, attachmentsDir)
        rmSync(operationDirectory, { recursive: true, force: true })
      } catch (restoreError) {
        console.error('[clearNoteData] 恢复附件目录失败:', restoreError)
      }
    }
    throw error
  }

  // 递归删除移出主路径后异步执行，不阻塞 Electron 主线程，也不占用 SQLite 事务。
  if (attachmentsMoved) {
    try {
      writeFileSync(join(operationDirectory, ATTACHMENT_OPERATION_COMMITTED), '', 'utf8')
    } catch (error) {
      console.error('[clearNoteData] 写入附件清理提交标记失败:', error)
    }
    let directoryRemoved = false
    try {
      await removeDirectory(operationDirectory, { recursive: true, force: true })
      directoryRemoved = true
    } catch (error) {
      console.error('[clearNoteData] 清理待删除附件目录失败:', error)
      // 数据库已经成功提交，不能再向 UI 报告“清空失败”。遗留目录会在下次启动重试。
    }
    if (directoryRemoved) {
      try {
        // The durable decision is removed only after its detached bytes are gone.
        deleteAttachmentResetCommit(operationId)
      } catch (error) {
        console.error('[clearNoteData] 附件目录已清理，提交日志留待下次清理:', error)
      }
    }
  }
}
