/** 可注入的数据库连接边界；生产环境与隔离集成测试共用。 */
let database = null

export function setDb(databaseInstance) {
  database = databaseInstance
}

export function getDb() {
  if (!database) throw new Error('数据库尚未初始化')
  return database
}

export function clearDb() {
  database = null
}
