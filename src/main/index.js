/**
 * ============================================================
 * 步骤 1：导入依赖模块
 * ============================================================
 * - app、BrowserWindow、ipcMain、shell 来自 Electron 核心
 * - electronApp、optimizer、is 来自 electron-toolkit 工具库
 * - icon 是应用图标资源
 */
import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

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

  mainWindow = new BrowserWindow({
    width: Math.round(screenW * 0.3),   // 屏幕宽的 30%
    height: Math.round(screenH * 0.62),  // 屏幕高的 62%
    ...getSharedWindowOptions()
  })

  configureWindow(mainWindow)

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

  mainSettingsWin = new BrowserWindow({
    width: Math.round(screenW * 0.32),   // 屏幕宽的 32%
    height: Math.round(screenH * 0.46),  // 屏幕高的 46%
    parent: mainWindow,       // 设为子窗口，跟随主窗口
    modal: false,             // 非模态，可以同时操作主窗口
    ...getSharedWindowOptions()
  })

  configureWindow(mainSettingsWin)

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

  islandWindow = new BrowserWindow({
    width: Math.round(screenW * 0.22),   // 屏幕宽的 22%
    height: Math.round(screenH * 0.15),  // 屏幕高的 15%
    resizable: true,          // 允许调整大小（灵动岛通常较小，但给用户自由）
    frame: true,              // 保留窗口边框，用户可拖拽
    ...getSharedWindowOptions()
  })

  configureWindow(islandWindow)

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

  islandSettingsWin = new BrowserWindow({
    width: Math.round(screenW * 0.28),   // 屏幕宽的 28%
    height: Math.round(screenH * 0.38),  // 屏幕高的 38%
    parent: islandWindow,     // 设为灵动岛窗口的子窗口
    modal: false,
    ...getSharedWindowOptions()
  })

  configureWindow(islandSettingsWin)

  islandSettingsWin.on('closed', () => { islandSettingsWin = null })

  // 开发模式：http://localhost:5173/island-settings.html；生产模式：island-settings.html
  loadPage(islandSettingsWin, 'island-settings.html')
}

/**
 * ============================================================
 * 步骤 3：app.whenReady() — Electron 初始化完成后的回调
 * ============================================================
 * 仅当 Electron 完成初始化后才执行，所有窗口 API 必须在此之后调用。
 */
app.whenReady().then(() => {
  // --- 步骤 3.0：获取主显示器可用区域尺寸，供所有窗口按比例计算 ---
  const display = screen.getPrimaryDisplay()
  screenW = display.workAreaSize.width
  screenH = display.workAreaSize.height
  console.log(`[screen] 主显示器可用区域: ${screenW}×${screenH} (比例 ${(screenW / screenH).toFixed(2)})`)

  // --- 步骤 3.1：设置 Windows 任务栏应用 ID ---
  electronApp.setAppUserModelId('com.electron')

  // --- 步骤 3.2：注册开发调试快捷键 ---
  // 所有窗口自动绑定 F12（开发工具）和 Ctrl+R（刷新）快捷键
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ============================================================
  // 步骤 3.3：注册 IPC 通信处理（四个窗口的所有 IPC 通道）
  // ============================================================

  // IPC 测试（保留）
  ipcMain.on('ping', () => console.log('pong'))

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
  // 字体大小 IPC：设置窗口 → 主进程 → 目标窗口
  // ============================================================

  // 主窗口设置页 → 修改主窗口字体
  // 接收 rem 值，转发给主窗口渲染进程更新 CSS 变量
  ipcMain.on('set-main-font-size', (_event, size) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('font-size-changed', size)
    }
  })

  // 灵动岛设置页 → 修改灵动岛窗口字体
  // 接收 rem 值，转发给灵动岛渲染进程更新 CSS 变量
  ipcMain.on('set-island-font-size', (_event, size) => {
    if (islandWindow && !islandWindow.isDestroyed()) {
      islandWindow.webContents.send('font-size-changed', size)
    }
  })

  // --- 步骤 3.4：应用启动，创建主窗口 ---
  createWindow()

  // --- 步骤 3.5：macOS 激活事件处理 ---
  app.on('activate', function () {
    // 所有窗口都关闭时点击 Dock 图标 → 重新创建主窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * ============================================================
 * 步骤 4：window-all-closed — 所有窗口关闭时的处理
 * ============================================================
 * Windows / Linux：所有窗口关闭 = 应用退出
 * macOS：菜单栏保持活跃，用户需手动 Cmd+Q 退出
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
