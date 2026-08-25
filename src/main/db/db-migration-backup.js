import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { DATABASE_SCHEMA_VERSION } from './db-schema.js'

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

/** 在会重建旧表或删除废弃持久数据的迁移前创建一次原库快照。 */
export function createDatabaseMigrationBackup(connection, dbPath) {
  const version = Number(connection.pragma('user_version', { simple: true }) || 0)
  if (DATABASE_SCHEMA_VERSION < 3) return null
  // 早期测试版没有维护 user_version，真实旧库会报告 V0；迁移依据必须是表结构，
  // 不能因版本号为 0 而跳过用户数据备份。
  const hasLegacyTagRelations = ['note_tags', 'template_tags'].some((tableName) =>
    tableHasColumn(connection, tableName, 'tag_name')
  )
  // V6 会用 sort_order 取代标签置顶字段并重建 tags 表。旧字段是判断依据，
  // 即使早期测试版的 user_version 不准确，也必须先备份再迁移。
  const needsTagOrderMigration =
    DATABASE_SCHEMA_VERSION >= 6 &&
    tableExists(connection, 'tags') &&
    (!tableHasColumn(connection, 'tags', 'sort_order') ||
      tableHasColumn(connection, 'tags', 'is_pinned') ||
      tableHasColumn(connection, 'tags', 'pinned_at'))
  const needsDockHandlePositionCleanup =
    DATABASE_SCHEMA_VERSION >= 8 &&
    tableHasSetting(connection, 'dock', 'dock_reveal_handle_positions')
  if (!hasLegacyTagRelations && !needsTagOrderMigration && !needsDockHandlePositionCleanup) {
    return null
  }

  const targetVersion = hasLegacyTagRelations ? 3 : needsTagOrderMigration ? 6 : 8
  const backupPath = join(dirname(dbPath), `app-v${version}-before-v${targetVersion}.db`)
  if (existsSync(backupPath)) return backupPath
  const escapedPath = backupPath.replaceAll("'", "''")
  connection.exec(`VACUUM INTO '${escapedPath}'`)
  console.log(`[db] 已创建 V${targetVersion} 数据库迁移前备份: ${backupPath}`)
  return backupPath
}

// 保留旧导出，避免内部脚本或第三方诊断代码在升级时失效。
export const createTagIdMigrationBackup = createDatabaseMigrationBackup
