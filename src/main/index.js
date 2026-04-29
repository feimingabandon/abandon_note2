/**
 * ============================================================
 * 步骤 1：导入依赖模块
 * ============================================================
 * - app、BrowserWindow、ipcMain、shell、screen 来自 Electron 核心
 *   app       → 控制应用生命周期（启动、退出等），类似 Java 的 main() 方法
 *   BrowserWindow → 创建和管理窗口，类似 Java Swing 的 JFrame
 *   ipcMain   → 主进程的 IPC 消息接收器，类似 Java 的事件监听器
 *   shell     → 调用系统功能（如用默认浏览器打开链接）
 *   screen    → 获取显示器信息（分辨率、可用区域等）
 * - electronApp、optimizer、is 来自 electron-toolkit 工具库
 * - icon 是应用图标资源
 * - db.js 是本项目的数据库模块，封装了所有 SQLite 操作
 */
import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// 导入数据库模块（本项目自建）
import {
  initDatabase,
  closeDatabase,
  getWindowStyle,
  getAllWindowStyles,
  setWindowStyle,
  getWindowGeometry,
  saveWindowGeometry
} from './db.js'

// ============================================================
// 模块级变量：保存四个窗口的引用，供 IPC 和窗口切换使用
// ============================================================
let mainWindow = null      // 主窗口
let mainSettingsWin = null // 主窗口的设置窗口
let islandWindow = null    // 灵动岛窗口
let islandSettingsWin = null // 灵动岛的设置窗口

// 窗口尺寸缓存：由 app.whenReady() 初始化，基于主显示器可用区域
let screenW = 1920   // 默认兜底
let screenH = 1080

// ============================================================
// 防抖定时器缓存：每个窗口各自独立，避免 resize/move 高频写库
// ============================================================
// 类似 Java 中的 ScheduledFuture，延迟执行，新事件来了就取消旧的重新计时
const geometryTimers = {}

/**
 * ============================================================
 * getSharedWindowOptions() — 提取所有窗口的通用配置
 * ============================================================
 * 所有四个窗口共享相同的 preload、沙箱、图标等基础配置，
 * 避免重复代码。返回一个可展开到 BrowserWindow 构造参数的对象。
 */
function getSharedWindowOptions() {
  return {
    show: false,                        // 初始隐藏，ready-to-show 后再显示
    autoHideMenuBar: true,              // 自动隐藏菜单栏
    transparent: true,                  // 窗口背景透明，配合 CSS 毛玻璃效果
    frame: false,                       // 无边框窗口，配合透明背景实现自定义外观
    backgroundColor: '#00000000',       // 初始背景全透明（8 位十六进制，最后 00 = 透明度 0）
    ...(process.platform === 'linux' ? { icon } : {}), // Linux 需要显式设置图标
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'), // 共用同一个 preload
      sandbox: false                    // electron-toolkit 要求关闭沙箱
    }
  }
}

/**
 * ============================================================
 * configureWindow() — 窗口通用行为配置
 * ============================================================
 * 为窗口绑定 ready-to-show 显示逻辑 + 外部链接拦截。
 * 每个窗口创建后调用此函数完成标准化配置。
 * @param {BrowserWindow} win - 待配置的窗口实例
 */
function configureWindow(win) {
  // 等待渲染完成再显示，避免白屏
  win.on('ready-to-show', () => win.show())

  // 拦截 window.open / target="_blank"，交给系统浏览器
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
}

/**
 * ============================================================
 * bindGeometryPersistence() — 为窗口绑定几何状态持久化
 * ============================================================
 * 监听窗口的 resize（调整大小）和 move（拖动位置）事件，
 * 使用防抖机制（500ms）将最新的尺寸和位置写入数据库。
 *
 * 防抖原理：用户拖拽窗口时，resize/move 事件每秒触发几十次，
 * 如果每次都写数据库会浪费性能。防抖的做法是：
 *   每次事件触发时，取消上一次的定时器，重新开始计时 500ms，
 *   只有用户停止拖拽超过 500ms 后才真正执行一次写入。
 * 类似 Java 中用 ScheduledExecutorService.schedule() 实现延迟执行。
 *
 * @param {BrowserWindow} win        - 要监听的窗口实例
 * @param {string}        windowType - 窗口标识，如 'main' | 'island'
 */
function bindGeometryPersistence(win, windowType) {
  /**
   * 实际执行保存的内部函数
   * win.getBounds() 返回 { x, y, width, height }，即窗口当前的位置和尺寸
   * win.isMaximized() 返回布尔值，表示窗口是否处于最大化状态
   *
   * screen.getDisplayMatching(rect) 根据窗口的矩形区域，
   * 返回该窗口所在的显示器对象（多显示器时能精确判断在哪个屏幕上）
   */
  const saveGeometry = () => {
    // 如果窗口已经被关闭销毁了，就不再保存
    // isDestroyed() 类似 Java 中检查对象是否已被回收
    if (win.isDestroyed()) return

    const bounds = win.getBounds()

    // 获取窗口所在显示器的 ID，用于多屏场景恢复位置
    const display = screen.getDisplayMatching(bounds)

    try {
      saveWindowGeometry(windowType, bounds, {
        isMaximized: win.isMaximized(),
        // String() 将数字转为字符串存储，display.id 是显示器的唯一标识
        displayId: String(display.id)
      })
    } catch (err) {
      console.error(`[db] 保存窗口几何状态失败 (${windowType}):`, err)
    }
  }

  /**
   * 防抖处理函数
   * clearTimeout / setTimeout 是 JS 的定时器 API：
   *   clearTimeout(id) — 取消之前的定时器
   *   setTimeout(fn, ms) — ms 毫秒后执行 fn，返回定时器 ID
   */
  const debouncedSave = () => {
    if (geometryTimers[windowType]) {
      clearTimeout(geometryTimers[windowType])
    }
    geometryTimers[windowType] = setTimeout(saveGeometry, 500)
  }

  // win.on('事件名', 回调) 是 Electron 的事件监听，类似 Java 的 addListener
  // 'resize' — 窗口大小改变时触发（用户拖拽窗口边缘）
  // 'move'   — 窗口位置改变时触发（用户拖拽标题栏）
  win.on('resize', debouncedSave)
  win.on('move', debouncedSave)
}

/**
 * ============================================================
 * resolveWindowBounds() — 从数据库恢复窗口尺寸和位置
 * ============================================================
 * 启动时调用，决定窗口应该用多大的尺寸、放在什么位置。
 *
 * 逻辑：
 *   1. 从数据库读取上次保存的几何状态
 *   2. 如果没有记录（首次启动），使用屏幕比例计算的默认值
 *   3. 如果有记录，检查上次所在的显示器是否还在：
 *      - 还在 → 恢复完整的位置和尺寸
 *      - 不在（比如副屏被拔掉了）→ 只恢复宽高，位置由系统自动居中
 *
 * @param {string} windowType      - 窗口标识
 * @param {number} defaultWidth    - 兜底默认宽度
 * @param {number} defaultHeight   - 兜底默认高度
 * @returns {Object} BrowserWindow 构造函数可用的 { width, height, x?, y? }
 */
function resolveWindowBounds(windowType, defaultWidth, defaultHeight) {
  const saved = getWindowGeometry(windowType)

  if (!saved) {
    // 首次启动，无持久化记录，使用默认尺寸
    return { width: defaultWidth, height: defaultHeight }
  }

  // 有持久化记录，检查上次所在的显示器是否仍然存在
  // screen.getAllDisplays() 返回当前所有显示器的数组
  const displays = screen.getAllDisplays()

  // .find() 是 JS 数组方法，找到第一个满足条件的元素
  // 类似 Java Stream 的 .filter().findFirst()
  const targetDisplay = displays.find(
    (d) => String(d.id) === saved.display_id
  )

  if (targetDisplay) {
    // 上次的显示器还在，完整恢复位置和尺寸
    return {
      width: saved.width,
      height: saved.height,
      x: saved.pos_x,
      y: saved.pos_y
    }
  } else {
    // 上次的显示器不在了，只恢复宽高，坐标不设置（系统会自动居中到主显示器）
    console.log(`[window] ${windowType} 的上次显示器已断开，只恢复宽高`)
    return {
      width: saved.width,
      height: saved.height
    }
  }
}

/**
 * ============================================================
 * loadPage() — 统一的页面加载逻辑（兼容开发/生产环境）
 * ============================================================
 * 开发模式：每个窗口加载 Vite 开发服务器上对应的 HTML 文件路径
 *   主窗口     → http://localhost:5173/           (index.html)
 *   设置窗口   → http://localhost:5173/settings.html
 *   灵动岛     → http://localhost:5173/island.html
 *   灵动岛设置 → http://localhost:5173/island-settings.html
 *
 * 生产模式：加载打包后的本地 HTML 文件
 * @param {BrowserWindow} win      - 目标窗口
 * @param {string} htmlFileName    - HTML 文件名（如 'index.html' / 'settings.html'）
 */
function loadPage(win, htmlFileName) {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    // 开发模式：使用 URL 构造函数确保路径正确拼接
    // 避免 ELECTRON_RENDERER_URL 有无末尾斜杠导致的拼接错误
    const baseUrl = process.env['ELECTRON_RENDERER_URL']
    let devUrl
    if (htmlFileName === 'index.html') {
      devUrl = baseUrl
    } else {
      // URL 构造函数会自动处理 baseUrl 末尾有无斜杠的问题
      devUrl = new URL(htmlFileName, baseUrl).href
    }
    console.log(`[loadPage] 开发模式加载: ${devUrl}`)
    win.loadURL(devUrl)
  } else {
    // 生产模式：加载 out/renderer/ 下打包好的对应 HTML 文件
    win.loadFile(join(__dirname, '../renderer/', htmlFileName))
  }
}

/**
 * ============================================================
 * createWindow() — 创建主窗口（窗口 1 / 4）
 * ============================================================
 * 加载 index.html，显示主界面。
 * 应用启动时自动调用，也可由灵动岛窗口切换过来。
 */
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 主窗口已存在 → 直接显示，不重复创建
    mainWindow.show()
    return
  }

  // 从数据库恢复窗口尺寸/位置，首次启动用屏幕比例兜底
  const bounds = resolveWindowBounds(
    'main',
    Math.round(screenW * 0.3),    // 默认：屏幕宽的 30%
    Math.round(screenH * 0.62)    // 默认：屏幕高的 62%
  )

  mainWindow = new BrowserWindow({
    ...bounds,
    ...getSharedWindowOptions()
  })

  configureWindow(mainWindow)

  // 绑定几何状态持久化（resize/move 时防抖写入数据库）
  bindGeometryPersistence(mainWindow, 'main')

  // 窗口关闭时清空引用，防止内存泄漏
  mainWindow.on('closed', () => { mainWindow = null })

  // 开发模式：http://localhost:5173/（不带 hash，直接加载 index.html）
  // 生产模式：index.html
  loadPage(mainWindow, 'index.html')
}

/**
 * ============================================================
 * createMainSettingsWindow() — 创建主窗口的设置窗口（窗口 2 / 4）
 * ============================================================
 * 加载 settings.html，由主窗口的「设置」按钮触发。
 * 设计为只能同时存在一个实例。
 */
function createMainSettingsWindow() {
  // 防重复：如果设置窗口已存在，直接聚焦
  if (mainSettingsWin && !mainSettingsWin.isDestroyed()) {
    mainSettingsWin.focus()
    return
  }

  // 从数据库恢复设置窗口的尺寸/位置
  const bounds = resolveWindowBounds(
    'main_settings',
    Math.round(screenW * 0.32),   // 默认：屏幕宽的 32%
    Math.round(screenH * 0.46)    // 默认：屏幕高的 46%
  )

  mainSettingsWin = new BrowserWindow({
    ...bounds,
    parent: mainWindow,       // 设为子窗口，跟随主窗口
    modal: false,             // 非模态，可以同时操作主窗口
    ...getSharedWindowOptions()
  })

  configureWindow(mainSettingsWin)

  // 设置窗口也绑定几何状态持久化
  bindGeometryPersistence(mainSettingsWin, 'main_settings')

  mainSettingsWin.on('closed', () => { mainSettingsWin = null })

  // 开发模式：http://localhost:5173/settings.html；生产模式：settings.html
  loadPage(mainSettingsWin, 'settings.html')
}

/**
 * ============================================================
 * createIslandWindow() — 创建灵动岛窗口（窗口 3 / 4）
 * ============================================================
 * 加载 island.html，由主窗口的「灵动岛」按钮触发。
 * 打开后会显示一个灵动岛风格的独立窗口。
 */
function createIslandWindow() {
  if (islandWindow && !islandWindow.isDestroyed()) {
    islandWindow.show()
    return
  }

  const bounds = resolveWindowBounds(
    'island',
    Math.round(screenW * 0.22),   // 默认：屏幕宽的 22%
    Math.round(screenH * 0.15)    // 默认：屏幕高的 15%
  )

  islandWindow = new BrowserWindow({
    ...bounds,
    resizable: true,          // 允许调整大小（灵动岛通常较小，但给用户自由）
    ...getSharedWindowOptions()
  })

  configureWindow(islandWindow)

  // 绑定几何状态持久化
  bindGeometryPersistence(islandWindow, 'island')

  islandWindow.on('closed', () => { islandWindow = null })

  // 开发模式：http://localhost:5173/island.html；生产模式：island.html
  loadPage(islandWindow, 'island.html')
}

/**
 * ============================================================
 * createIslandSettingsWindow() — 创建灵动岛的设置窗口（窗口 4 / 4）
 * ============================================================
 * 加载 island-settings.html，由灵动岛窗口的「设置」按钮触发。
 */
function createIslandSettingsWindow() {
  if (islandSettingsWin && !islandSettingsWin.isDestroyed()) {
    islandSettingsWin.focus()
    return
  }

  const bounds = resolveWindowBounds(
    'island_settings',
    Math.round(screenW * 0.28),   // 默认：屏幕宽的 28%
    Math.round(screenH * 0.38)    // 默认：屏幕高的 38%
  )

  islandSettingsWin = new BrowserWindow({
    ...bounds,
    parent: islandWindow,     // 设为灵动岛窗口的子窗口
    modal: false,
    ...getSharedWindowOptions()
  })

  configureWindow(islandSettingsWin)

  // 绑定几何状态持久化
  bindGeometryPersistence(islandSettingsWin, 'island_settings')

  islandSettingsWin.on('closed', () => { islandSettingsWin = null })

  // 开发模式：http://localhost:5173/island-settings.html；生产模式：island-settings.html
  loadPage(islandSettingsWin, 'island-settings.html')
}

/**
 * ============================================================
 * 步骤 3：app.whenReady() — Electron 初始化完成后的回调
 * ============================================================
 * 仅当 Electron 完成初始化后才执行，所有窗口 API 必须在此之后调用。
 * 类似 Java 中 Spring 的 ApplicationReadyEvent 回调。
 */
app.whenReady().then(() => {
  // --- 步骤 3.0：初始化数据库 ---
  // 必须在创建任何窗口之前调用，因为创建窗口时需要从数据库读取几何状态
  initDatabase()

  // --- 步骤 3.1：获取主显示器可用区域尺寸，供首次启动时按比例计算窗口大小 ---
  // getPrimaryDisplay() 获取主显示器信息
  // workAreaSize 是排除任务栏后的可用区域（不是整个屏幕分辨率）
  const display = screen.getPrimaryDisplay()
  screenW = display.workAreaSize.width
  screenH = display.workAreaSize.height
  console.log(`[screen] 主显示器可用区域: ${screenW}×${screenH} (比例 ${(screenW / screenH).toFixed(2)})`)

  // --- 步骤 3.2：设置 Windows 任务栏应用 ID ---
  electronApp.setAppUserModelId('com.electron')

  // --- 步骤 3.3：注册开发调试快捷键 ---
  // 所有窗口自动绑定 F12（开发工具）和 Ctrl+R（刷新）快捷键
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ============================================================
  // 步骤 3.4：注册 IPC 通信处理（四个窗口的所有 IPC 通道）
  // ============================================================
  // ipcMain.on(通道名, 回调) — 监听渲染进程发来的消息（单向，无返回值）
  //   类似 Java 中的 @EventListener 或消息队列消费者
  // ipcMain.handle(通道名, 回调) — 监听渲染进程的请求（双向，有返回值）
  //   类似 Java 中的 @RequestMapping 接口，渲染进程 invoke 后会收到返回值

  // IPC 测试（保留）
  ipcMain.on('ping', () => console.log('pong'))

  // ============================================================
  // 窗口控制 IPC（关闭 / 最小化 / 最大化）
  // ============================================================
  // BrowserWindow.fromWebContents(event.sender) — 根据发送消息的
  // 渲染进程，找到它所在的 BrowserWindow 实例。
  // 这样所有窗口共用同一组 IPC 通道，无需每个窗口单独注册。

  ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.close()
  })

  ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
  })

  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      // isMaximized() 检查窗口是否已最大化，是则还原，否则最大化
      win.isMaximized() ? win.unmaximize() : win.maximize()
    }
  })

  // ============================================================
  // 窗口缩放 IPC（自定义 resize 手柄）
  // ============================================================
  // ResizeHandles.vue 组件在 mousedown 时通过 invoke 获取当前 bounds，
  // 在 mousemove 时通过 send 高频设置新 bounds，实现自定义窗口缩放。

  /** 获取当前窗口的矩形区域（invoke 有返回值，类似 GET 请求） */
  ipcMain.handle('window-get-bounds', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? win.getBounds() : null
  })

  /** 设置当前窗口的矩形区域（send 无返回值，类似 POST 请求） */
  ipcMain.on('window-set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && bounds) {
      win.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
      })
    }
  })

  // 主窗口 → 打开主窗口的设置窗口
  ipcMain.on('open-main-settings', () => {
    createMainSettingsWindow()
  })

  // 主窗口 → 切换到灵动岛窗口（关闭主窗口，打开灵动岛）
  ipcMain.on('open-island', () => {
    createIslandWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close()
    }
  })

  // 灵动岛窗口 → 切换到主窗口（关闭灵动岛，打开主窗口）
  ipcMain.on('open-main', () => {
    createWindow()
    if (islandWindow && !islandWindow.isDestroyed()) {
      islandWindow.close()
    }
  })

  // 灵动岛窗口 → 打开灵动岛的设置窗口
  ipcMain.on('open-island-settings', () => {
    createIslandSettingsWindow()
  })

  // ============================================================
  // 步骤 3.5：字体大小 IPC（设置窗口 → 主进程 → 目标窗口 + 持久化）
  // ============================================================

  /**
   * 主窗口设置页 → 修改主窗口字体
   * 数据流：设置窗口 → IPC → 主进程 → ① 转发给主窗口 ② 写入数据库
   *
   * 内存优先策略：先让主窗口立刻生效，再写数据库持久化。
   * 即使数据库写入失败，主窗口的显示也不受影响。
   */
  ipcMain.on('set-main-font-size', (_event, size) => {
    // ① 转发给主窗口渲染进程，立刻更新 CSS 变量
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('font-size-changed', size)
    }
    // ② 持久化到数据库（try-catch 保护，写入失败不影响主流程）
    try {
      setWindowStyle('main', 'font_size', size)
    } catch (err) {
      console.error('[db] 写入主窗口字号失败:', err)
    }
  })

  /**
   * 灵动岛设置页 → 修改灵动岛窗口字体
   * 数据流同上，window_type 为 'island'
   */
  ipcMain.on('set-island-font-size', (_event, size) => {
    if (islandWindow && !islandWindow.isDestroyed()) {
      islandWindow.webContents.send('font-size-changed', size)
    }
    try {
      setWindowStyle('island', 'font_size', size)
    } catch (err) {
      console.error('[db] 写入灵动岛字号失败:', err)
    }
  })

  // ============================================================
  // 步骤 3.6：样式查询 IPC（渲染进程主动拉取持久化样式）
  // ============================================================

  /**
   * ipcMain.handle() 注册一个可以被渲染进程 ipcRenderer.invoke() 调用的接口
   *
   * 渲染进程调用：const styles = await window.api.getWindowStyle('main')
   * 主进程返回：{ font_size: '20', theme: 'dark' }（或空对象 {}）
   *
   * 类似 Java 的 REST 接口：
   *   @GetMapping("/api/window-style/{windowType}")
   *   public Map<String, String> getWindowStyle(@PathVariable String windowType)
   */
  ipcMain.handle('get-window-style', (_event, windowType) => {
    try {
      return getAllWindowStyles(windowType)
    } catch (err) {
      console.error('[db] 读取窗口样式失败:', err)
      return {}
    }
  })

  // --- 步骤 3.7：应用启动，创建主窗口 ---
  createWindow()

  // --- 步骤 3.8：macOS 激活事件处理 ---
  app.on('activate', function () {
    // 所有窗口都关闭时点击 Dock 图标 → 重新创建主窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * ============================================================
 * 步骤 4：应用退出前 — 关闭数据库连接
 * ============================================================
 * 'before-quit' 事件在应用即将退出时触发（所有窗口关闭之前）。
 * 此时关闭数据库连接，确保 WAL 日志刷入主数据库文件。
 * 类似 Java 的 @PreDestroy 或 ShutdownHook。
 */
app.on('before-quit', () => {
  closeDatabase()
})

/**
 * ============================================================
 * 步骤 5：window-all-closed — 所有窗口关闭时的处理
 * ============================================================
 * Windows / Linux：所有窗口关闭 = 应用退出
 * macOS：菜单栏保持活跃，用户需手动 Cmd+Q 退出
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
