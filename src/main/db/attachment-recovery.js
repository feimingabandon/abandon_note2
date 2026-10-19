import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { getDb } from './db-connection.js'
import {
  deleteAttachmentResetCommit,
  hasAttachmentResetCommit,
  isResetOperationId,
  listAttachmentResetCommits,
  RESET_OPERATION_DIRECTORY_PREFIX
} from './attachment-reset-journal.js'

const ATTACHMENT_OPERATION_MANIFEST = 'operation.json'
const ATTACHMENT_OPERATION_COMMITTED = 'committed'

function cleanupResetCommit(operationId) {
  try {
    deleteAttachmentResetCommit(operationId)
    return true
  } catch (error) {
    console.warn('[clearNoteData] 附件目录已清理，提交日志保留待重试:', error)
    return false
  }
}

async function recoverImageDeletionOperation(
  operationDirectory,
  onRecovery,
  resolveAttachmentPath
) {
  const manifestPath = join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.version !== 1 || manifest?.type !== 'image-delete') return false

  const pendingPath = join(operationDirectory, 'payload')
  if (!existsSync(pendingPath)) {
    await rm(operationDirectory, { recursive: true, force: true })
    onRecovery({
      operationId: basename(operationDirectory),
      operationType: 'image-delete',
      action: 'cleanup-missing-payload'
    })
    return true
  }

  const row = getDb()
    .prepare('SELECT 1 FROM note_attachments WHERE file_path = ? LIMIT 1')
    .get(manifest.relativePath)
  if (!row) {
    await rm(operationDirectory, { recursive: true, force: true })
    onRecovery({
      operationId: basename(operationDirectory),
      operationType: 'image-delete',
      action: 'committed-cleanup'
    })
    return true
  }

  const originalPath = resolveAttachmentPath(manifest.relativePath)
  if (existsSync(originalPath)) {
    console.warn('[images] 附件原路径已存在，保留待恢复文件:', operationDirectory)
    onRecovery({
      operationId: basename(operationDirectory),
      operationType: 'image-delete',
      action: 'preserved-conflict'
    })
    return true
  }
  mkdirSync(dirname(originalPath), { recursive: true })
  renameSync(pendingPath, originalPath)
  await rm(operationDirectory, { recursive: true, force: true })
  onRecovery({
    operationId: basename(operationDirectory),
    operationType: 'image-delete',
    action: 'rolled-back',
    recoveredFiles: 1
  })
  return true
}

async function recoverImageAdditionOperation(
  operationDirectory,
  onRecovery,
  resolveAttachmentPath
) {
  const manifestPath = join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.version !== 1 || manifest?.type !== 'image-add') return false

  const pendingPath = join(operationDirectory, 'payload')
  if (existsSync(pendingPath)) {
    // 文件仍在暂存区，说明尚未进入数据库事务，可以直接丢弃。
    await rm(operationDirectory, { recursive: true, force: true })
    onRecovery({
      operationId: basename(operationDirectory),
      operationType: 'image-add',
      action: 'rolled-back-staging'
    })
    return true
  }

  const targetManifestPath = join(operationDirectory, 'target.json')
  if (!existsSync(targetManifestPath)) {
    await rm(operationDirectory, { recursive: true, force: true })
    onRecovery({
      operationId: basename(operationDirectory),
      operationType: 'image-add',
      action: 'cleanup-missing-target'
    })
    return true
  }
  const target = JSON.parse(readFileSync(targetManifestPath, 'utf8'))
  if (target?.version !== 1 || target?.type !== 'image-add-target' || !target.relativePath) {
    throw new Error('附件新增恢复目标无效')
  }

  const finalPath = resolveAttachmentPath(target.relativePath)
  const row = getDb()
    .prepare('SELECT 1 FROM note_attachments WHERE file_path = ? LIMIT 1')
    .get(target.relativePath)
  // 重命名成功但事务未提交时，最终文件没有数据库记录，必须清理孤儿文件。
  const orphanDeleted = !row && existsSync(finalPath)
  if (orphanDeleted) await rm(finalPath, { force: true })
  await rm(operationDirectory, { recursive: true, force: true })
  onRecovery({
    operationId: basename(operationDirectory),
    operationType: 'image-add',
    action: row ? 'committed-cleanup' : 'rolled-back',
    deletedFiles: orphanDeleted ? 1 : 0
  })
  return true
}

async function recoverAttachmentStagingDirectory(
  stagingDirectory,
  onRecovery,
  resolveAttachmentPath
) {
  const entries = await readdir(stagingDirectory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(stagingDirectory, entry.name)
    if (entry.isDirectory()) {
      try {
        if (await recoverImageAdditionOperation(path, onRecovery, resolveAttachmentPath)) continue
        if (await recoverImageDeletionOperation(path, onRecovery, resolveAttachmentPath)) continue
      } catch (error) {
        console.warn('[images] 恢复暂存附件失败，保留现场:', error)
        onRecovery({
          operationId: entry.name,
          operationType: 'unknown',
          action: 'failed-preserved',
          reason: error?.message || String(error)
        })
        continue
      }
      console.warn('[images] 发现未知附件暂存目录，保留现场:', path)
      onRecovery({
        operationId: entry.name,
        operationType: 'unknown',
        action: 'preserved-unknown'
      })
      continue
    }

    await rm(path, { force: true })
    onRecovery({
      operationId: entry.name,
      operationType: 'staging-file',
      action: 'cleanup'
    })
  }
}

function legacyResetHasReferencedPayload(payloadPath, attachmentsDir, resolveAttachmentPath) {
  const attachments = getDb().prepare('SELECT file_path FROM note_attachments').all()
  return attachments.some(({ file_path: filePath }) => {
    const subpath = relative(attachmentsDir, resolveAttachmentPath(filePath))
    if (!subpath || isAbsolute(subpath) || subpath === '..' || subpath.startsWith(`..${sep}`))
      return false
    return existsSync(join(payloadPath, subpath))
  })
}

async function recoverResetOperation(
  operationDirectory,
  onRecovery,
  userDataDir,
  resolveAttachmentPath
) {
  const payloadPath = join(operationDirectory, 'attachments')
  const attachmentsDir = join(userDataDir, 'attachments')
  const manifest = JSON.parse(
    readFileSync(join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST), 'utf8')
  )
  const markedCommitted = existsSync(join(operationDirectory, ATTACHMENT_OPERATION_COMMITTED))
  let operationId = null
  let committed
  if (manifest?.version === 2 && manifest.type === 'reset') {
    operationId = manifest.operationId
    if (
      !isResetOperationId(operationId) ||
      basename(operationDirectory) !== `${RESET_OPERATION_DIRECTORY_PREFIX}${operationId}`
    )
      throw new Error('附件清空恢复操作 ID 与目录不一致')
    committed = hasAttachmentResetCommit(operationId)
    // A v2 marker without its transaction decision is not proof of rollback.
    if (markedCommitted && !committed) throw new Error('附件清空提交标记与数据库日志不一致')
  } else if (manifest?.version === 1 && manifest.type === 'reset') {
    committed = markedCommitted
    if (
      !committed &&
      existsSync(payloadPath) &&
      !legacyResetHasReferencedPayload(payloadPath, attachmentsDir, resolveAttachmentPath)
    ) {
      onRecovery({
        operationId: basename(operationDirectory),
        operationType: 'reset',
        action: 'preserved-ambiguous-legacy'
      })
      return
    }
  } else throw new Error('附件清空恢复凭据无效')

  if (committed || !existsSync(payloadPath)) {
    await rm(operationDirectory, { recursive: true, force: true })
    const journalCleanupPending = operationId && committed && !cleanupResetCommit(operationId)
    onRecovery({
      operationId: basename(operationDirectory),
      operationType: 'reset',
      action: committed ? 'committed-cleanup' : 'cleanup-unneeded',
      ...(journalCleanupPending ? { journalCleanupPending: true } : {})
    })
    return
  }
  if (existsSync(attachmentsDir)) {
    console.warn('[clearNoteData] 附件目录已重新创建，保留待恢复目录:', operationDirectory)
    onRecovery({
      operationId: basename(operationDirectory),
      operationType: 'reset',
      action: 'preserved-conflict'
    })
    return
  }
  renameSync(payloadPath, attachmentsDir)
  await rm(operationDirectory, { recursive: true, force: true })
  onRecovery({
    operationId: basename(operationDirectory),
    operationType: 'reset',
    action: 'rolled-back',
    recoveredDirectories: 1
  })
}

/** 启动时恢复未提交的附件操作，并清理已经提交的暂存数据。 */
export async function recoverPendingAttachments({
  userDataPath,
  resolveAttachmentPath,
  onRecovery = () => {}
}) {
  const userDataDir = userDataPath
  const entries = await readdir(userDataDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.attachments-staging') {
      await recoverAttachmentStagingDirectory(
        join(userDataDir, entry.name),
        onRecovery,
        resolveAttachmentPath
      )
      continue
    }
    if (entry.name.startsWith(RESET_OPERATION_DIRECTORY_PREFIX)) {
      try {
        await recoverResetOperation(
          join(userDataDir, entry.name),
          onRecovery,
          userDataDir,
          resolveAttachmentPath
        )
      } catch (error) {
        console.warn('[clearNoteData] 恢复附件清空操作失败，保留现场:', error)
        onRecovery({
          operationId: entry.name,
          operationType: 'reset',
          action: 'failed-preserved',
          reason: error?.message || String(error)
        })
      }
    }
  }
  // A crash may occur after filesystem cleanup but before deleting its decision.
  for (const { operation_id: operationId } of listAttachmentResetCommits()) {
    if (!isResetOperationId(operationId)) continue
    if (
      !existsSync(join(userDataDir, `${RESET_OPERATION_DIRECTORY_PREFIX}${operationId}`)) &&
      !cleanupResetCommit(operationId)
    ) {
      onRecovery({ operationId, operationType: 'reset', action: 'journal-cleanup-pending' })
    }
  }
}
