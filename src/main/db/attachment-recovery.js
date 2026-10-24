import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { getDb } from './db-connection.js'
import { createAttachmentRecoveryReport } from './attachment-recovery-report.js'
import {
  deleteAttachmentResetCommit,
  hasAttachmentResetCommit,
  isResetOperationId,
  listAttachmentResetCommits,
  RESET_OPERATION_DIRECTORY_PREFIX
} from './attachment-reset-journal.js'

const ATTACHMENT_OPERATION_MANIFEST = 'operation.json'
const ATTACHMENT_OPERATION_COMMITTED = 'committed'

function notifyRecovery(operation, onRecovery, event, status = 'completed') {
  const { operationId, operationType, action, ...metadata } = event
  if (status) operation.finish(action, status)
  else operation.action(action)
  operation.phase('notify')
  try {
    onRecovery({ operationId, operationType, action, ...metadata })
  } catch (error) {
    operation.fail(error)
    throw error
  }
  operation.phase('finished')
}

function observeReferencedFile(operation, resolvePath, findReference) {
  operation.phase('observe-reference')
  try {
    if (findReference && !findReference()) {
      operation.decision('committed')
      return true
    }
    if (findReference) operation.decision('uncommitted')
    const path = resolvePath()
    try {
      if (!statSync(path).isFile()) {
        operation.observe('undetermined', '附件引用目标不是普通文件')
        return false
      }
      return true
    } catch (error) {
      operation.observe(
        error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'referenceMissing' : 'undetermined',
        error
      )
    }
  } catch (error) {
    // Additional observations cannot change the existing recovery decision or cleanup.
    operation.observe('undetermined', error)
  }
  return false
}

function cleanupResetCommit(operationId, operation) {
  try {
    deleteAttachmentResetCommit(operationId)
    return true
  } catch (error) {
    console.warn('[clearNoteData] 附件目录已清理，提交日志保留待重试:', error)
    operation.fail(error)
    return false
  }
}

async function recoverImageDeletionOperation(
  operationDirectory,
  onRecovery,
  resolveAttachmentPath,
  operation
) {
  const manifestPath = join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.version !== 1 || manifest?.type !== 'image-delete') return false
  operation.type('image-delete')

  const pendingPath = join(operationDirectory, 'payload')
  if (!existsSync(pendingPath)) {
    const contentResolved = observeReferencedFile(
      operation,
      () => resolveAttachmentPath(manifest.relativePath),
      () =>
        getDb()
          .prepare('SELECT 1 FROM note_attachments WHERE file_path = ? LIMIT 1')
          .get(manifest.relativePath)
    )
    operation.phase('cleanup-operation', contentResolved)
    await rm(operationDirectory, { recursive: true, force: true })
    notifyRecovery(operation, onRecovery, {
      operationId: basename(operationDirectory),
      operationType: 'image-delete',
      action: 'cleanup-missing-payload'
    })
    return true
  }

  operation.phase('read-decision')
  const row = getDb()
    .prepare('SELECT 1 FROM note_attachments WHERE file_path = ? LIMIT 1')
    .get(manifest.relativePath)
  operation.decision(row ? 'uncommitted' : 'committed')
  if (!row) {
    operation.phase('cleanup-operation', true)
    await rm(operationDirectory, { recursive: true, force: true })
    notifyRecovery(operation, onRecovery, {
      operationId: basename(operationDirectory),
      operationType: 'image-delete',
      action: 'committed-cleanup'
    })
    return true
  }

  operation.phase('resolve-path')
  const originalPath = resolveAttachmentPath(manifest.relativePath)
  operation.phase('restore-payload')
  if (existsSync(originalPath)) {
    console.warn('[images] 附件原路径已存在，保留待恢复文件:', operationDirectory)
    notifyRecovery(
      operation,
      onRecovery,
      {
        operationId: basename(operationDirectory),
        operationType: 'image-delete',
        action: 'preserved-conflict'
      },
      'preservedConflict'
    )
    return true
  }
  mkdirSync(dirname(originalPath), { recursive: true })
  renameSync(pendingPath, originalPath)
  operation.phase('cleanup-operation', true)
  await rm(operationDirectory, { recursive: true, force: true })
  notifyRecovery(operation, onRecovery, {
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
  resolveAttachmentPath,
  operation
) {
  const manifestPath = join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.version !== 1 || manifest?.type !== 'image-add') return false
  operation.type('image-add')

  const pendingPath = join(operationDirectory, 'payload')
  if (existsSync(pendingPath)) {
    // 文件仍在暂存区，说明尚未进入数据库事务，可以直接丢弃。
    operation.decision('uncommitted')
    operation.phase('cleanup-operation', true)
    await rm(operationDirectory, { recursive: true, force: true })
    notifyRecovery(operation, onRecovery, {
      operationId: basename(operationDirectory),
      operationType: 'image-add',
      action: 'rolled-back-staging'
    })
    return true
  }

  const targetManifestPath = join(operationDirectory, 'target.json')
  if (!existsSync(targetManifestPath)) {
    operation.decision('uncommitted')
    operation.phase('cleanup-operation', true)
    await rm(operationDirectory, { recursive: true, force: true })
    notifyRecovery(operation, onRecovery, {
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

  operation.phase('resolve-path')
  const finalPath = resolveAttachmentPath(target.relativePath)
  operation.phase('read-decision')
  const row = getDb()
    .prepare('SELECT 1 FROM note_attachments WHERE file_path = ? LIMIT 1')
    .get(target.relativePath)
  operation.decision(row ? 'committed' : 'uncommitted')
  if (row) observeReferencedFile(operation, () => finalPath)
  // 重命名成功但事务未提交时，最终文件没有数据库记录，必须清理孤儿文件。
  const orphanDeleted = !row && existsSync(finalPath)
  // Removing the final orphan is still the rollback itself, not residual cleanup.
  operation.phase('cleanup-orphan')
  if (orphanDeleted) await rm(finalPath, { force: true })
  operation.phase('cleanup-operation', true)
  await rm(operationDirectory, { recursive: true, force: true })
  notifyRecovery(operation, onRecovery, {
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
  resolveAttachmentPath,
  report
) {
  const entries = await readdir(stagingDirectory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(stagingDirectory, entry.name)
    const operation = report.operation(`staging:${entry.name}`, {
      operationId: entry.name,
      operationType: entry.isDirectory() ? 'unknown' : 'staging-file'
    })
    if (entry.isDirectory()) {
      try {
        if (await recoverImageAdditionOperation(path, onRecovery, resolveAttachmentPath, operation))
          continue
        if (await recoverImageDeletionOperation(path, onRecovery, resolveAttachmentPath, operation))
          continue
      } catch (error) {
        console.warn('[images] 恢复暂存附件失败，保留现场:', error)
        operation.fail(error)
        notifyRecovery(
          operation,
          onRecovery,
          {
            operationId: entry.name,
            operationType: 'unknown',
            action: 'failed-preserved',
            reason: error?.message || String(error)
          },
          null
        )
        continue
      }
      console.warn('[images] 发现未知附件暂存目录，保留现场:', path)
      notifyRecovery(
        operation,
        onRecovery,
        {
          operationId: entry.name,
          operationType: 'unknown',
          action: 'preserved-unknown'
        },
        'undetermined'
      )
      continue
    }

    operation.decision('uncommitted')
    operation.phase('cleanup-operation', true)
    try {
      await rm(path, { force: true })
    } catch (error) {
      operation.fail(error)
      throw error
    }
    notifyRecovery(operation, onRecovery, {
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
  resolveAttachmentPath,
  operation
) {
  const payloadPath = join(operationDirectory, 'attachments')
  const attachmentsDir = join(userDataDir, 'attachments')
  const manifest = JSON.parse(
    readFileSync(join(operationDirectory, ATTACHMENT_OPERATION_MANIFEST), 'utf8')
  )
  const markedCommitted = existsSync(join(operationDirectory, ATTACHMENT_OPERATION_COMMITTED))
  operation.phase('read-decision')
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
    operation.decision(committed ? 'committed' : 'uncommitted')
  } else if (manifest?.version === 1 && manifest.type === 'reset') {
    committed = markedCommitted
    if (
      !committed &&
      existsSync(payloadPath) &&
      !legacyResetHasReferencedPayload(payloadPath, attachmentsDir, resolveAttachmentPath)
    ) {
      notifyRecovery(
        operation,
        onRecovery,
        {
          operationId: basename(operationDirectory),
          operationType: 'reset',
          action: 'preserved-ambiguous-legacy'
        },
        'undetermined'
      )
      return
    }
    operation.decision(committed ? 'committed' : 'uncommitted')
  } else throw new Error('附件清空恢复凭据无效')

  if (committed || !existsSync(payloadPath)) {
    operation.phase('cleanup-operation', true)
    await rm(operationDirectory, { recursive: true, force: true })
    operation.phase('cleanup-journal', true)
    const journalCleanupPending =
      operationId && committed && !cleanupResetCommit(operationId, operation)
    notifyRecovery(
      operation,
      onRecovery,
      {
        operationId: basename(operationDirectory),
        operationType: 'reset',
        action: committed ? 'committed-cleanup' : 'cleanup-unneeded',
        ...(journalCleanupPending ? { journalCleanupPending: true } : {})
      },
      journalCleanupPending ? 'cleanupPending' : 'completed'
    )
    return
  }
  if (existsSync(attachmentsDir)) {
    console.warn('[clearNoteData] 附件目录已重新创建，保留待恢复目录:', operationDirectory)
    notifyRecovery(
      operation,
      onRecovery,
      {
        operationId: basename(operationDirectory),
        operationType: 'reset',
        action: 'preserved-conflict'
      },
      'preservedConflict'
    )
    return
  }
  operation.phase('restore-payload')
  renameSync(payloadPath, attachmentsDir)
  operation.phase('cleanup-operation', true)
  await rm(operationDirectory, { recursive: true, force: true })
  notifyRecovery(operation, onRecovery, {
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
  onRecovery = () => {},
  report = createAttachmentRecoveryReport()
}) {
  const userDataDir = userDataPath
  report.start()
  try {
    report.phase('scan-root')
    const entries = await readdir(userDataDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '.attachments-staging') {
        report.phase('scan-staging')
        await recoverAttachmentStagingDirectory(
          join(userDataDir, entry.name),
          onRecovery,
          resolveAttachmentPath,
          report
        )
        continue
      }
      if (entry.name.startsWith(RESET_OPERATION_DIRECTORY_PREFIX)) {
        report.phase('recover-reset')
        const operation = report.operation(
          `reset:${entry.name.slice(RESET_OPERATION_DIRECTORY_PREFIX.length)}`,
          { operationId: entry.name, operationType: 'reset' }
        )
        try {
          await recoverResetOperation(
            join(userDataDir, entry.name),
            onRecovery,
            userDataDir,
            resolveAttachmentPath,
            operation
          )
        } catch (error) {
          console.warn('[clearNoteData] 恢复附件清空操作失败，保留现场:', error)
          operation.fail(error)
          notifyRecovery(
            operation,
            onRecovery,
            {
              operationId: entry.name,
              operationType: 'reset',
              action: 'failed-preserved',
              reason: error?.message || String(error)
            },
            null
          )
        }
      }
    }
    // A crash may occur after filesystem cleanup but before deleting its decision.
    report.phase('scan-journals')
    for (const { operation_id: operationId } of listAttachmentResetCommits()) {
      if (!isResetOperationId(operationId)) {
        const operation = report.operation(`invalid-reset-journal:${operationId}`, {
          operationId,
          operationType: 'reset'
        })
        operation.phase('validate-journal-id')
        operation.observe('undetermined', '附件清空提交日志操作 ID 无效，原样保留')
        operation.finish(null, 'undetermined')
        operation.phase('finished')
        continue
      }
      if (!existsSync(join(userDataDir, `${RESET_OPERATION_DIRECTORY_PREFIX}${operationId}`))) {
        const operation = report.operation(`reset:${operationId}`, {
          operationId,
          operationType: 'reset'
        })
        operation.decision('committed')
        operation.phase('cleanup-journal', true)
        if (!cleanupResetCommit(operationId, operation)) {
          notifyRecovery(
            operation,
            onRecovery,
            {
              operationId,
              operationType: 'reset',
              action: 'journal-cleanup-pending'
            },
            null
          )
        } else {
          operation.finish()
          operation.phase('finished')
        }
      }
    }
    report.finish()
  } catch (error) {
    report.fail(error)
    throw error
  }
}
