/**
 * db.js — 数据库模块（主进程）
 *
 * 职责：
 *   1. 初始化 SQLite 数据库连接（使用 better-sqlite3）
 *   2. 提供 app_settings 表的 CRUD 操作
 *   3. 提供窗口几何信息（位置/尺寸）的持久化读写
 *
 * 数据库文件存储在 Electron 的 userData 目录下，名为 app.db
 * 使用 WAL 模式提升并发读写性能
 */

import Database from 'better-sqlite3' // SQLite3 同步驱动，适合 Electron 主进程
import { join } from 'path' // Node.js 路径拼接工具
import { app } from 'electron' // Electron app 模块，用于获取用户数据目录

/** 数据库实例引用，整个应用生命周期内复用 */
let db = null

/**
 * 初始化数据库
 * - 在 userData 目录下创建/打开 app.db
 * - 启用 WAL (Write-Ahead Logging) 模式，提升写入性能
 * - 自动检测旧表结构，若缺少 window_name 字段则删除旧表重建
 * - 创建 app_settings 表（如果不存在）
 */
export function initDatabase() {
  // 拼接数据库文件的绝对路径（如 C:\Users\xxx\AppData\Roaming\app-name\app.db）
  const dbPath = join(app.getPath('userData'), 'app.db')
  db = new Database(dbPath)

  // 启用 WAL 模式：允许读写并行，减少锁等待
  db.pragma('journal_mode = WAL')

  // === 旧表兼容性处理 ===
  // 检查 app_settings 表的列信息
  const tableInfo = db.prepare("PRAGMA table_info('app_settings')").all()
  // 判断是否包含 window_name 列（新表结构的标志）
  const hasWindowName = tableInfo.some((col) => col.name === 'window_name')
  // 如果表存在但缺少 window_name 列，说明是旧版结构，需要删除重建
  if (tableInfo.length > 0 && !hasWindowName) {
    db.exec('DROP TABLE app_settings')
  }

  // === 创建 app_settings 表 ===
  // 主键为 (window_name, key) 的复合主键
  // type 字段用于分类（如 'css'、'geometry'、'system'）
  // value 以文本形式存储，由调用方负责类型转换
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      window_name TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (window_name, key)
    );
  `)
}

/**
 * 关闭数据库连接
 * 应在应用退出前调用，确保数据完整写入磁盘
 */
export function closeDatabase() {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * 获取单个设置值
 * @param {string} windowName - 窗口标识（如 'main'）
 * @param {string} key - 设置项的键名
 * @returns {string|null} 设置值的字符串形式，不存在则返回 null
 */
export function getSetting(windowName, key) {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE window_name = ? AND key = ?')
    .get(windowName, key)
  return row?.value ?? null
}

/**
 * 写入/更新单个设置项
 * 使用 UPSERT 策略：存在则更新 value/type/updated_at，不存在则插入新行
 * @param {string} windowName - 窗口标识
 * @param {string} type - 设置分类（如 'css'、'geometry'、'system'）
 * @param {string} key - 设置项的键名
 * @param {*} value - 设置值（会被转为字符串存储）
 */
export function setSetting(windowName, type, key, value) {
  const now = Date.now() // 当前时间戳（毫秒）
  db.prepare(`
    INSERT INTO app_settings (window_name, type, key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(window_name, key) DO UPDATE SET
      value = excluded.value,
      type = excluded.type,
      updated_at = excluded.updated_at
  `).run(windowName, type, key, String(value), now, now)
}

/**
 * 按类型批量获取设置
 * @param {string} windowName - 窗口标识
 * @param {string} type - 设置分类
 * @returns {Array<{key: string, value: string}>} 该分类下所有设置的键值对数组
 */
export function getSettingsByType(windowName, type) {
  return db
    .prepare('SELECT key, value FROM app_settings WHERE window_name = ? AND type = ?')
    .all(windowName, type)
}

/**
 * 删除单个设置项
 * @param {string} windowName - 窗口标识
 * @param {string} key - 要删除的设置键名
 */
export function deleteSetting(windowName, key) {
  db.prepare('DELETE FROM app_settings WHERE window_name = ? AND key = ?').run(windowName, key)
}

/**
 * 保存窗口几何信息（位置 + 尺寸）
 * 使用事务将四个值一次性写入，保证原子性
 * @param {string} windowName - 窗口标识
 * @param {number} x - 窗口左上角 X 坐标
 * @param {number} y - 窗口左上角 Y 坐标
 * @param {number} width - 窗口宽度
 * @param {number} height - 窗口高度
 */
export function saveGeometry(windowName, x, y, width, height) {
  const save = db.transaction(() => {
    setSetting(windowName, 'geometry', 'pos_x', String(x))
    setSetting(windowName, 'geometry', 'pos_y', String(y))
    setSetting(windowName, 'geometry', 'width', String(width))
    setSetting(windowName, 'geometry', 'height', String(height))
  })
  save()
}

/**
 * 重置数据库 —— 删除 app_settings 表中所有数据，恢复为初始状态
 */
export function resetDatabase() {
  db.exec('DELETE FROM app_settings')
}

/**
 * 读取窗口几何信息
 * @param {string} windowName - 窗口标识
 * @returns {{x: number, y: number, width: number, height: number}|null}
 *   返回数值化的窗口边界对象；如果任一值缺失则返回 null（表示无保存记录）
 */
export function getGeometry(windowName) {
  const x = getSetting(windowName, 'pos_x')
  const y = getSetting(windowName, 'pos_y')
  const w = getSetting(windowName, 'width')
  const h = getSetting(windowName, 'height')
  // 任一值缺失则视为未保存过，返回 null 让调用方使用默认值
  if (x === null || y === null || w === null || h === null) return null
  return {
    x: Number(x),
    y: Number(y),
    width: Number(w),
    height: Number(h)
  }
}
