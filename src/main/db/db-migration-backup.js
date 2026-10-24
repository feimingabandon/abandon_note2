import { dirname, join, resolve, toNamespacedPath } from 'node:path'
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { DATABASE_SCHEMA_VERSION } from './db-schema.js'

const require = createRequire(import.meta.url)
const BACKUP_SIDECARS = ['-wal', '-shm', '-journal']
const HASH_BUFFER_SIZE = 64 * 1024
let nativePublisher

function backupError(code, message, paths = {}, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  return Object.assign(error, paths)
}

function annotateFailure(error, details) {
  // 附加诊断不能替换原异常（包括不可扩展的原生异常对象）。
  if (!error || typeof error !== 'object') return
  try {
    for (const [key, value] of Object.entries(details)) error[key] ??= value
  } catch {
    // 保留原错误本身。
  }
}

function closePreservingFailure(close, failure) {
  try {
    close()
  } catch (error) {
    if (!failure) throw error
    annotateFailure(failure, { closeError: error })
  }
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileState(left, right) {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  )
}

function isOrdinaryFile(stat) {
  return stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
}

function normalizedRealPath(path) {
  // 规范化 Win32 路径表示；来源身份仍须另外比较 dev/ino。
  return realpathSync
    .native(resolve(path))
    .replace(/^\\\\\?\\/, '')
    .toLowerCase()
}

function verifySource(connection, dbPath) {
  const sourcePath = resolve(dbPath)
  const main = connection.pragma('database_list').find((entry) => entry.name === 'main')
  const mismatch = () =>
    backupError('MIGRATION_BACKUP_SOURCE_MISMATCH', '迁移备份路径与当前数据库来源不一致')
  const sourceStat = lstatIfPresent(sourcePath)
  const mainStat = main?.file ? lstatIfPresent(main.file) : null
  if (!main?.file || !isOrdinaryFile(sourceStat) || !isOrdinaryFile(mainStat)) throw mismatch()
  if (!sameFile(sourceStat, mainStat)) throw mismatch()
  if (normalizedRealPath(sourcePath) !== normalizedRealPath(main.file)) throw mismatch()
  return sourcePath
}

function assertNoSidecars(path, paths) {
  for (const suffix of BACKUP_SIDECARS) {
    if (lstatIfPresent(path + suffix)) {
      throw backupError(
        'MIGRATION_BACKUP_INVALID',
        '迁移备份含有 SQLite 附属文件，不能作为独立快照使用',
        paths
      )
    }
  }
}

function assertUnchangedFile(path, descriptor, expected, paths) {
  const current = lstatIfPresent(path)
  const opened = fstatSync(descriptor, { bigint: true })
  if (
    !isOrdinaryFile(current) ||
    !isOrdinaryFile(opened) ||
    !sameFileState(expected, current) ||
    !sameFileState(expected, opened)
  ) {
    throw backupError('MIGRATION_BACKUP_INVALID', '迁移备份在校验期间发生变化，拒绝使用', paths)
  }
  assertNoSidecars(path, paths)
}

function fullFileHash(descriptor, size) {
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE)
  const hash = createHash('sha256')
  let position = 0
  while (position < size) {
    const count = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position
    )
    if (count === 0) return null
    hash.update(buffer.subarray(0, count))
    position += count
  }
  return hash.digest('hex')
}

function validateBackup(path, expected, paths) {
  const stat = lstatIfPresent(path)
  if (!isOrdinaryFile(stat) || stat.size < 100n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw backupError('MIGRATION_BACKUP_INVALID', '迁移备份不是有效的普通数据库文件', paths)
  }
  // 必须在 SQLite 打开文件前拒绝附属文件，避免读取另一个 WAL 快照。
  assertNoSidecars(path, paths)
  let descriptor
  let failure
  try {
    descriptor = openSync(path, 'r')
    assertUnchangedFile(path, descriptor, stat, paths)
    const header = Buffer.alloc(100)
    if (
      readSync(descriptor, header, 0, header.length, 0) !== header.length ||
      header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
      header[18] !== 1 ||
      header[19] !== 1
    ) {
      // VACUUM INTO 产生独立 rollback-journal 数据库。WAL 头的旧文件即使
      // 没有 sidecar，也不交给 readonly 连接，防止该连接创建新的 sidecar。
      throw backupError('MIGRATION_BACKUP_INVALID', '迁移备份不是独立 SQLite 快照', paths)
    }
    let verification
    let verificationFailure
    try {
      assertNoSidecars(path, paths)
      verification = new Database(path, { readonly: true, fileMustExist: true })
      const integrity = verification.pragma('integrity_check')
      if (
        integrity.length !== 1 ||
        integrity[0].integrity_check !== 'ok' ||
        Number(verification.pragma('user_version', { simple: true }) || 0) !== expected.version ||
        JSON.stringify(migrationStructure(verification)) !== JSON.stringify(expected.structure)
      ) {
        throw backupError(
          'MIGRATION_BACKUP_INVALID',
          '迁移备份完整性、版本或迁移前结构校验失败',
          paths
        )
      }
    } catch (error) {
      if (error.code === 'SQLITE_NOTADB' || error.code?.startsWith('SQLITE_CORRUPT')) {
        verificationFailure = backupError(
          'MIGRATION_BACKUP_INVALID',
          '迁移备份已损坏',
          paths,
          error
        )
      } else {
        verificationFailure = error
      }
      throw verificationFailure
    } finally {
      if (verification?.open) {
        closePreservingFailure(() => verification.close(), verificationFailure)
      }
    }
    assertUnchangedFile(path, descriptor, stat, paths)
    const hash = fullFileHash(descriptor, Number(stat.size))
    if (!hash) {
      throw backupError('MIGRATION_BACKUP_INVALID', '迁移备份读取不完整', paths)
    }
    assertUnchangedFile(path, descriptor, stat, paths)
    return { hash, size: stat.size, stat }
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (descriptor !== undefined) closePreservingFailure(() => closeSync(descriptor), failure)
  }
}

function syncCandidate(path, expected, paths) {
  const descriptor = openSync(path, 'r+')
  let failure
  try {
    assertUnchangedFile(path, descriptor, expected.stat, paths)
    fsyncSync(descriptor)
    assertUnchangedFile(path, descriptor, expected.stat, paths)
  } catch (error) {
    failure = error
    throw error
  } finally {
    closePreservingFailure(() => closeSync(descriptor), failure)
  }
}

function publishWithoutReplacement(candidatePath, backupPath) {
  if (!nativePublisher) {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('迁移备份发布仅支持 Windows 10/11 x64')
    }
    const koffi = require('koffi')
    const kernel = koffi.load('kernel32.dll')
    nativePublisher = {
      move: kernel.func('int MoveFileExW(str16, str16, uint32_t)'),
      lastError: kernel.func('uint32_t GetLastError()')
    }
  }
  // 不设置 REPLACE_EXISTING/COPY_ALLOWED；同卷原子无覆盖发布。
  const moved = nativePublisher.move(
    toNamespacedPath(candidatePath),
    toNamespacedPath(backupPath),
    8
  )
  const win32Error = moved ? null : nativePublisher.lastError()
  return { moved: Boolean(moved), win32Error }
}

function reuseExisting(backupPath, candidate, expected, paths) {
  const existing = validateBackup(backupPath, expected, paths)
  if (existing.size !== candidate.size || existing.hash !== candidate.hash) {
    throw backupError(
      'MIGRATION_BACKUP_CONFLICT',
      '已有迁移备份与当前快照字节不同，保留双方并停止迁移',
      paths
    )
  }
}

function cleanupSuccessfulCandidate(directory, directoryStat, candidatePath, candidate) {
  try {
    const currentDirectory = lstatIfPresent(directory)
    if (!currentDirectory?.isDirectory() || !sameFile(currentDirectory, directoryStat)) {
      throw new Error('自有迁移备份临时目录身份已变化')
    }
    const remaining = lstatIfPresent(candidatePath)
    if (remaining) {
      if (!isOrdinaryFile(remaining) || !sameFileState(remaining, candidate.stat)) {
        throw new Error('自有迁移备份候选身份已变化')
      }
      unlinkSync(candidatePath)
    }
    // 不递归删除；未知文件或附属文件必须保留。
    rmdirSync(directory)
  } catch (error) {
    console.warn(`[db] 迁移备份已有效保存，但临时文件收尾未完成: ${directory}`, error)
  }
}

function tableHasColumn(connection, tableName, columnName) {
  return Boolean(
    connection
      .prepare(`SELECT 1 FROM pragma_table_info('${tableName}') WHERE name = ?`)
      .get(columnName)
  )
}

function tableExists(connection, tableName) {
  return Boolean(
    connection
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  )
}

function tableHasSetting(connection, type, key) {
  return (
    tableExists(connection, 'app_settings') &&
    Boolean(
      connection
        .prepare('SELECT 1 FROM app_settings WHERE type = ? AND key = ? LIMIT 1')
        .get(type, key)
    )
  )
}

function migrationStructure(connection) {
  return {
    noteTagsLegacy: tableHasColumn(connection, 'note_tags', 'tag_name'),
    templateTagsLegacy: tableHasColumn(connection, 'template_tags', 'tag_name'),
    tagsExists: tableExists(connection, 'tags'),
    tagsSortOrder: tableHasColumn(connection, 'tags', 'sort_order'),
    tagsPinned: tableHasColumn(connection, 'tags', 'is_pinned'),
    tagsPinnedAt: tableHasColumn(connection, 'tags', 'pinned_at'),
    dockHandlePositions: tableHasSetting(connection, 'dock', 'dock_reveal_handle_positions'),
    stickyFontRangeLegacy: /CHECK\s*\(\s*font_size\s+BETWEEN\s+12\s+AND\s+32\s*\)/i.test(
      connection
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'desktop_stickies'")
        .get()?.sql || ''
    )
  }
}

/** 在会重建旧表或删除废弃持久数据的迁移前创建一次原库快照。 */
export function createDatabaseMigrationBackup(connection, dbPath) {
  const version = Number(connection.pragma('user_version', { simple: true }) || 0)
  if (DATABASE_SCHEMA_VERSION < 3) return null
  // 早期测试版没有维护 user_version，真实旧库会报告 V0；迁移依据必须是表结构，
  // 不能因版本号为 0 而跳过用户数据备份。
  const structure = migrationStructure(connection)
  const hasLegacyTagRelations = structure.noteTagsLegacy || structure.templateTagsLegacy
  // V6 会用 sort_order 取代标签置顶字段并重建 tags 表。旧字段是判断依据，
  // 即使早期测试版的 user_version 不准确，也必须先备份再迁移。
  const needsTagOrderMigration =
    DATABASE_SCHEMA_VERSION >= 6 &&
    structure.tagsExists &&
    (!structure.tagsSortOrder || structure.tagsPinned || structure.tagsPinnedAt)
  const needsDockHandlePositionCleanup =
    DATABASE_SCHEMA_VERSION >= 8 && structure.dockHandlePositions
  const needsStickyFontRangeMigration =
    DATABASE_SCHEMA_VERSION >= 19 && version < 19 && structure.stickyFontRangeLegacy
  if (
    !hasLegacyTagRelations &&
    !needsTagOrderMigration &&
    !needsDockHandlePositionCleanup &&
    !needsStickyFontRangeMigration
  ) {
    return null
  }

  const sourcePath = verifySource(connection, dbPath)
  const targetVersion = hasLegacyTagRelations
    ? 3
    : needsTagOrderMigration
      ? 6
      : needsDockHandlePositionCleanup
        ? 8
        : 19
  const backupPath = join(dirname(sourcePath), `app-v${version}-before-v${targetVersion}.db`)
  const directory = mkdtempSync(join(dirname(sourcePath), '.migration-backup-'))
  const directoryStat = lstatSync(directory, { bigint: true })
  const candidatePath = join(directory, 'snapshot.db')
  const paths = { backupPath, candidatePath }
  try {
    const escapedPath = candidatePath.replaceAll("'", "''")
    connection.exec(`VACUUM INTO '${escapedPath}'`)
    const expected = { version, structure }
    const candidate = validateBackup(candidatePath, expected, paths)
    syncCandidate(candidatePath, candidate, paths)
    if (lstatIfPresent(backupPath)) {
      reuseExisting(backupPath, candidate, expected, paths)
    } else {
      const publication = publishWithoutReplacement(candidatePath, backupPath)
      const { win32Error } = publication
      if (!publication.moved && (win32Error === 80 || win32Error === 183)) {
        reuseExisting(backupPath, candidate, expected, paths)
      } else if (!publication.moved) {
        const error = backupError(
          'MIGRATION_BACKUP_PUBLISH_FAILED',
          `迁移备份发布失败，Win32 错误 ${win32Error}`,
          paths
        )
        error.win32Error = win32Error
        throw error
      }
    }
    cleanupSuccessfulCandidate(directory, directoryStat, candidatePath, candidate)
    console.log(`[db] 已保存 V${targetVersion} 数据库迁移前备份: ${backupPath}`)
    return backupPath
  } catch (error) {
    // SQLite/fs 的原始异常、错误码与 cause 不替换；失败现场也不清理。
    annotateFailure(error, paths)
    throw error
  }
}

// 保留旧导出，避免内部脚本或第三方诊断代码在升级时失效。
export const createTagIdMigrationBackup = createDatabaseMigrationBackup
