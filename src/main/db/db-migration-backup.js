import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { DATABASE_SCHEMA_VERSION } from './db-schema.js'

/** 在把可变标签名称迁移为稳定 ID 前，为所有真实旧表结构创建一次原库快照。 */
export function createTagIdMigrationBackup(connection, dbPath) {
  const version = Number(connection.pragma('user_version', { simple: true }) || 0)
  if (DATABASE_SCHEMA_VERSION < 3) return null
  // 早期测试版没有维护 user_version，真实旧库会报告 V0；迁移依据必须是表结构，
  // 不能因版本号为 0 而跳过用户数据备份。
  const hasLegacyTagRelations = ['note_tags', 'template_tags'].some((tableName) =>
    connection
      .prepare(`SELECT 1 FROM pragma_table_info('${tableName}') WHERE name = 'tag_name'`)
      .get()
  )
  if (!hasLegacyTagRelations) return null

  const backupPath = join(dirname(dbPath), `app-v${version}-before-v3.db`)
  if (existsSync(backupPath)) return backupPath
  const escapedPath = backupPath.replaceAll("'", "''")
  connection.exec(`VACUUM INTO '${escapedPath}'`)
  console.log(`[db] 已创建 V3 标签迁移前备份: ${backupPath}`)
  return backupPath
}
