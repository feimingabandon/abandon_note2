/**
 * ============================================================
 * db.js — 数据库模块（主进程专用）
 * ============================================================
 * 使用 better-sqlite3 管理本地 SQLite 数据库，负责：
 *   1. 数据库初始化（建表）
 *   2. 窗口样式配置的增删改查（字号、主题等）
 *   3. 窗口几何状态的增删改查（宽高、坐标、最大化状态）
 *   4. 全局应用配置的增删改查（语言、开机自启等）
 *
 * ============================================================
 * 为什么放在主进程？
 * ============================================================
 * Electron 架构中，渲染进程（Vue 页面）出于安全考虑无法直接
 * 访问 Node.js 的文件系统和原生模块。better-sqlite3 是一个
 * C++ 原生模块，只能在主进程中运行。渲染进程通过 IPC（进程间
 * 通信）向主进程发请求，主进程调用本模块完成数据库操作。
 *
 * ============================================================
 * 表结构概览
 * ============================================================
 * window_styles   — 键值对存储各窗口类型的样式配置
 * window_geometry — 列式存储各窗口的尺寸和位置
 * app_settings    — 键值对存储全局应用配置
 *
 * 使用方 → src/main/index.js
 */

// better-sqlite3 是一个同步的 SQLite 驱动（不是 async/await）
// 它的所有方法（如 .run() .get() .all()）都是立即返回结果的
import Database from 'better-sqlite3'

// join 用于拼接文件路径，确保跨操作系统兼容（Windows 用 \，macOS/Linux 用 /）
import { join } from 'path'

// app 是 Electron 的应用模块，app.getPath('userData') 返回用户数据目录
// Windows 上通常是 C:\Users\用户名\AppData\Roaming\应用名
import { app } from 'electron'

/**
 * 数据库实例（模块级变量）
 * 在 initDatabase() 中赋值，之后所有函数都通过它操作数据库。
 * 类似于 Java 中的 DataSource / Connection 概念。
 * @type {import('better-sqlite3').Database | null}
 */
let db = null

// ============================================================
// 第 1 部分：数据库初始化与关闭
// ============================================================

/**
 * 初始化数据库连接并创建表结构
 *
 * 在 app.whenReady() 中调用，应用启动时执行一次。
 * 类似 Java 中 Spring Boot 的 @PostConstruct 初始化方法。
 *
 * - IF NOT EXISTS：表已存在时不会重复创建，保证幂等性
 * - WAL 模式：Write-Ahead Logging，提升并发读写性能
 *   （类似 Java 中数据库连接池的优化配置）
 */
export function initDatabase() {
  // 数据库文件存放在用户数据目录下，名为 app.db
  // 这样卸载应用后数据文件不会遗留在程序安装目录
  const dbPath = join(app.getPath('userData'), 'app.db')
  console.log(`[db] 数据库路径: ${dbPath}`)

  // new Database(路径) 会自动创建文件（如果不存在）并打开连接
  db = new Database(dbPath)

  // 开启 WAL 模式，类似 MySQL 的 binlog，提升写入性能
  // pragma 是 SQLite 的配置命令，不是标准 SQL
  db.pragma('journal_mode = WAL')

  // exec() 可以一次执行多条 SQL 语句（用分号分隔）
  // 类似 Java 中 Statement.execute(sql)
  db.exec(`
    /*
     * 表 1：窗口样式配置（键值对设计，方便扩展新样式）
     *
     * window_type: 窗口类型，'main'（主窗口组）或 'island'（灵动岛组）
     * key:         样式属性名，如 'font_size'、'theme'、'opacity'
     * value:       样式属性值，统一存为文本（读取时按需转换类型）
     * updated_at:  最后更新时间戳（毫秒），方便调试和排查
     *
     * 复合主键 (window_type, key)：同一窗口类型下每个样式只有一行
     * 类似 Java 中 Map<String, Map<String, String>> 的二维映射
     */
    CREATE TABLE IF NOT EXISTS window_styles (
      window_type TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (window_type, key)
    );

    /*
     * 表 2：窗口几何状态（列式设计，字段固定）
     *
     * window_type:  窗口标识，'main' | 'island' | 'main_settings' | 'island_settings'
     * width/height: 窗口宽高（像素）
     * pos_x/pos_y:  窗口左上角坐标（像素）
     * is_maximized: 是否最大化（0=否，1=是），SQLite 没有布尔类型，用整数代替
     * display_id:   所在显示器的 ID，用于多显示器场景下恢复位置
     *               如果上次在副屏，这次副屏没插，就只恢复宽高，坐标居中
     * updated_at:   最后更新时间戳
     */
    CREATE TABLE IF NOT EXISTS window_geometry (
      window_type TEXT PRIMARY KEY,
      width INTEGER,
      height INTEGER,
      pos_x INTEGER,
      pos_y INTEGER,
      is_maximized INTEGER DEFAULT 0,
      display_id TEXT,
      updated_at INTEGER
    );

    /*
     * 表 3：全局应用配置（键值对，与具体窗口无关）
     *
     * 用于存储如语言、开机自启等全局设置
     * 类似 Java 中的 Properties 文件或 application.yml
     */
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
  `)

  console.log('[db] 数据库初始化完成')
}

/**
 * 关闭数据库连接
 *
 * 在应用退出前调用（app.on('before-quit')），确保数据完整写入磁盘。
 * 类似 Java 中 DataSource.close() 或 connection.close()。
 */
export function closeDatabase() {
  if (db) {
    db.close()
    db = null
    console.log('[db] 数据库连接已关闭')
  }
}

// ============================================================
// 第 2 部分：窗口样式配置 CRUD
// ============================================================

/**
 * 读取某个窗口类型的单个样式值
 *
 * @param {string} windowType - 窗口类型，如 'main' 或 'island'
 * @param {string} key        - 样式属性名，如 'font_size'
 * @returns {string|null}       样式值（字符串），不存在时返回 null
 *
 * 示例：getWindowStyle('main', 'font_size') → '20' 或 null
 *
 * db.prepare(sql) 类似 Java 中的 PreparedStatement
 * .get(参数) 执行查询并返回第一行结果（对象），无结果返回 undefined
 */
export function getWindowStyle(windowType, key) {
  const row = db
    .prepare('SELECT value FROM window_styles WHERE window_type = ? AND key = ?')
    .get(windowType, key)

  // row 是 { value: '20' } 或 undefined（没找到时）
  // 这里用可选链 ?. 安全访问，类似 Java 的 Optional
  return row?.value ?? null
}

/**
 * 读取某个窗口类型的全部样式配置
 *
 * @param {string} windowType - 窗口类型，如 'main' 或 'island'
 * @returns {Object}            键值对对象，如 { font_size: '20', theme: 'dark' }
 *                              如果没有任何配置则返回空对象 {}
 *
 * .all(参数) 类似 Java 中 ResultSet 读取所有行，返回数组
 * .reduce() 是 JS 数组方法，将数组归并为一个对象（类似 Java Stream.collect(toMap())）
 */
export function getAllWindowStyles(windowType) {
  const rows = db
    .prepare('SELECT key, value FROM window_styles WHERE window_type = ?')
    .all(windowType)

  // 将 [{key: 'font_size', value: '20'}, ...] 转换为 {font_size: '20', ...}
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value
    return acc
  }, {})
}

/**
 * 写入/更新某个窗口类型的单个样式值
 *
 * @param {string} windowType - 窗口类型
 * @param {string} key        - 样式属性名
 * @param {string} value      - 样式属性值（请传字符串）
 *
 * INSERT OR REPLACE：如果 (window_type, key) 已存在则更新，不存在则插入。
 * 类似 Java 中 JPA 的 saveOrUpdate()，或 MySQL 的 INSERT ... ON DUPLICATE KEY UPDATE
 *
 * Date.now() 返回当前时间戳（毫秒），类似 Java 的 System.currentTimeMillis()
 */
export function setWindowStyle(windowType, key, value) {
  db.prepare(
    'INSERT OR REPLACE INTO window_styles (window_type, key, value, updated_at) VALUES (?, ?, ?, ?)'
  ).run(windowType, key, String(value), Date.now())
}

// ============================================================
// 第 3 部分：窗口几何状态 CRUD
// ============================================================

/**
 * 读取某个窗口的几何状态（尺寸 + 位置）
 *
 * @param {string} windowType - 窗口标识，如 'main' | 'island' | 'main_settings' | 'island_settings'
 * @returns {Object|null}       几何状态对象，或 null（首次启动无记录时）
 *
 * 返回示例：{ width: 600, height: 700, pos_x: 100, pos_y: 50, is_maximized: 0, display_id: '12345' }
 */
export function getWindowGeometry(windowType) {
  const row = db
    .prepare(
      'SELECT width, height, pos_x, pos_y, is_maximized, display_id FROM window_geometry WHERE window_type = ?'
    )
    .get(windowType)

  return row ?? null
}

/**
 * 保存窗口的几何状态
 *
 * @param {string} windowType - 窗口标识
 * @param {Object} bounds     - Electron 的 win.getBounds() 返回的对象
 *                              格式：{ x: 100, y: 50, width: 600, height: 700 }
 *                              （类似 Java 中 Rectangle 的 x, y, width, height）
 * @param {Object} [options]  - 可选参数
 * @param {boolean} [options.isMaximized] - 是否最大化
 * @param {string}  [options.displayId]   - 所在显示器 ID
 */
export function saveWindowGeometry(windowType, bounds, options = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO window_geometry
      (window_type, width, height, pos_x, pos_y, is_maximized, display_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    windowType,
    bounds.width,
    bounds.height,
    bounds.x,
    bounds.y,
    options.isMaximized ? 1 : 0,
    options.displayId ?? null,
    Date.now()
  )
}

// ============================================================
// 第 4 部分：全局应用配置 CRUD
// ============================================================

/**
 * 读取全局应用配置
 *
 * @param {string} key - 配置键名，如 'language' | 'auto_launch'
 * @returns {string|null} 配置值，不存在返回 null
 */
export function getAppSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)
  return row?.value ?? null
}

/**
 * 写入/更新全局应用配置
 *
 * @param {string} key   - 配置键名
 * @param {string} value - 配置值
 */
export function setAppSetting(key, value) {
  db.prepare(
    'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(key, String(value), Date.now())
}
