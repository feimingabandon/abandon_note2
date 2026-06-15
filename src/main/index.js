
/**
 * index.js — Electron 主进程入口文件
 *
 * 职责：
 *   1. 创建和管理 BrowserWindow（无边框、透明背景）
 *   2. 注册所有 IPC 通道（窗口控制、缩放手柄、数据库桥接）
 *   3. 管理应用生命周期（启动、退出、macOS 激活）
 *   4. 窗口几何信息的防抖持久化
 */

import { app, shell, BrowserWindow, ipcMain, screen, Tray, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils' // Electron 开发工具集
import icon from '../../resources/icon.png?asset' // 应用图标（Vite asset 导入）
import {
  initDatabase,
  closeDatabase,
  getGeometry,
  saveGeometry,
  getSetting,
  setSetting,
  getSettingsByType,
  deleteSetting
} from './db.js'

/** 窗口标识常量，用于在数据库中区分不同窗口的设置 */
const WINDOW_NAME = 'main'

/** 主窗口实例引用 */
let mainWindow = null

/** 系统托盘实例 */
let tray = null

/** 是否正在执行退出流程（托盘菜单「退出」触发） */
let isQuitting = false

/** 防抖定时器，用于延迟保存窗口位置/尺寸 */
let geometryTimer = null

// ============================================================
// 贴边隐藏模块
// ============================================================
const SNAP_THRESHOLD = 20 // 贴边吸附阈值（px）
const TRIGGER_WIDTH = 2 // 边缘触发窗口宽度（px）
const SLIDE_DURATION = 200 // 滑动动画总时长（ms）
const SLIDE_INTERVAL = 16 // 滑动动画帧间隔（ms）≈60fps
const HIDE_DELAY = 200 // 鼠标离开后延迟隐藏（ms）

let dockSide = null // null | 'left' | 'right' 当前吸附方向
let isDockHidden = false // 窗口是否处于贴边隐藏状态
let triggerWin = null // 边缘触发窗口实例
let cachedWorkArea = null // 缓存显示器工作区，避免隐藏后 getDisplayMatching 返回过期对象
let slideAnimTimer = null // 滑动动画定时器
let hideTimer = null // 隐藏延迟定时器
let isSliding = false // 滑动动画进行中标志

/**
 * 创建主窗口
 * - 根据数据库中保存的位置/尺寸恢复窗口状态
 * - 若无保存记录，则使用默认值（屏幕左侧 25% 宽度、90% 高度）
 * - 窗口无边框 + 透明背景，用于实现自定义外观
 */
function createWindow() {
  // 获取主显示器信息，用于计算默认窗口位置
  const display = screen.getPrimaryDisplay()
  const screenW = display.workAreaSize.width // 可用工作区宽度（排除任务栏）
  const screenH = display.workAreaSize.height // 可用工作区高度

  // 计算默认窗口尺寸：宽度为屏幕的 25%，高度为屏幕的 90%
  const defaultW = Math.round(screenW * 0.25)
  const defaultH = Math.round(screenH * 0.9)
  // 计算上下边距，使窗口垂直居中
  const margin = Math.round((screenH - defaultH) / 2)
  const defaultX = margin // 默认 X 位置（距左边距等于上边距，视觉更协调）
  const defaultY = margin // 默认 Y 位置（垂直居中）

  // 优先使用数据库中保存的窗口几何信息，否则使用默认值
  const saved = getGeometry(WINDOW_NAME)
  const bounds = saved || { x: defaultX, y: defaultY, width: defaultW, height: defaultH }

  // 创建 BrowserWindow 实例
  mainWindow = new BrowserWindow({
    ...bounds, // 展开窗口位置和尺寸
    show: false, // 先隐藏，等待渲染进程就绪后再显示（避免白屏闪烁）
    frame: false, // 无系统边框（自定义标题栏）
    transparent: true, // 透明背景（支持圆角和磨砂效果）
    autoHideMenuBar: true, // 自动隐藏菜单栏
    ...(process.platform === 'linux' ? { icon } : {}), // Linux 需要手动设置图标
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'), // 预加载脚本路径
      sandbox: false // 关闭沙箱以允许 preload 使用 Node.js API
    }
  })

  // 固定缩放因子为 1.0，防止系统 DPI 缩放影响布局
  mainWindow.webContents.setZoomFactor(1.0)

  // 拦截新窗口打开请求，改为使用系统默认浏览器打开链接
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' } // 拒绝在应用内打开新窗口
  })

  /**
   * 防抖保存窗口几何信息
   * 窗口 resize/move 事件触发频繁，使用 500ms 防抖避免频繁写数据库
   */
  const debouncedSaveGeometry = () => {
    if (geometryTimer) clearTimeout(geometryTimer)
    geometryTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const b = mainWindow.getBounds()
        saveGeometry(WINDOW_NAME, b.x, b.y, b.width, b.height)
      }
    }, 500)
  }

  // 监听窗口大小变化和移动事件，触发防抖保存
  mainWindow.on('resize', debouncedSaveGeometry)
  mainWindow.on('move', debouncedSaveGeometry)

  // 【贴边隐藏 - 边缘检测】窗口移动时检测是否靠近屏幕左/右边缘
  mainWindow.on('move', () => {
    if (!mainWindow || mainWindow.isDestroyed() || isDockHidden || isSliding) return
    const side = detectSide()
    if (side) {
      if (dockSide !== side) {
        dockSide = side
        snapToEdge(side)
      }
    } else {
      dockSide = null
    }
  })

  // 拦截窗口关闭事件：最小化到托盘而非退出
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      // 隐藏时重置贴边状态，避免恢复时状态异常
      dockSide = null
      isDockHidden = false
      if (triggerWin && !triggerWin.isDestroyed()) {
        triggerWin.destroy()
        triggerWin = null
      }
    }
  })

  // 窗口销毁时清除引用和贴边资源
  mainWindow.on('closed', () => {
    mainWindow = null
    dockSide = null
    isDockHidden = false
    if (triggerWin && !triggerWin.isDestroyed()) {
      triggerWin.destroy()
      triggerWin = null
    }
  })

  // 根据环境加载页面：开发模式用 HMR URL，生产模式加载本地 HTML 文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ============================================================
// 贴边隐藏 —— 核心函数
// ============================================================

/** 缓存当前窗口所在显示器的工作区 */
function updateWorkArea() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const display = screen.getDisplayMatching(mainWindow.getBounds())
    if (display) cachedWorkArea = display.workArea
  }
}

/** 仅修改窗口 X 坐标，保持 Y / 宽 / 高不变 */
function setX(x) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const b = mainWindow.getBounds()
  mainWindow.setBounds({ x: Math.round(x), y: b.y, width: b.width, height: b.height })
}

/**
 * 检测窗口是否靠近屏幕左/右边缘
 * @returns {null|'left'|'right'} 边缘方向，null 表示未靠近
 */
function detectSide() {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  if (mainWindow.isMaximized() || mainWindow.isMinimized()) return null

  updateWorkArea()
  if (!cachedWorkArea) return null

  const b = mainWindow.getBounds()
  const wa = cachedWorkArea

  if (b.x <= wa.x + SNAP_THRESHOLD) return 'left'
  if (b.x + b.width >= wa.x + wa.width - SNAP_THRESHOLD) return 'right'
  return null
}

/** 将窗口吸附到指定边缘 */
function snapToEdge(side) {
  updateWorkArea()
  if (!cachedWorkArea) return
  const wa = cachedWorkArea
  const b = mainWindow.getBounds()
  setX(side === 'left' ? wa.x : wa.x + wa.width - b.width)
}

/**
 * 创建边缘触发窗口
 * 2px 宽的透明窗口，用于在主窗口隐藏后检测鼠标进入边缘
 */
function createTriggerWindow(side) {
  if (triggerWin && !triggerWin.isDestroyed()) triggerWin.destroy()
  updateWorkArea()
  if (!cachedWorkArea) return

  const wa = cachedWorkArea
  const bounds =
    side === 'left'
      ? { x: wa.x, y: wa.y, width: TRIGGER_WIDTH, height: wa.height }
      : { x: wa.x + wa.width - TRIGGER_WIDTH, y: wa.y, width: TRIGGER_WIDTH, height: wa.height }

  triggerWin = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 直接在 HTML 中绑定 onmouseenter，避免 executeJavaScript 异步注入的时序风险
  const html = `<body style="margin:0;height:100vh" onmouseenter="api.triggerEnter()">`
  triggerWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {})

  triggerWin.setVisibleOnAllWorkspaces(true)
  // 弹出菜单级别置顶，确保全屏应用覆盖时触发窗口仍在其上方
  triggerWin.setAlwaysOnTop(true, 'pop-up-menu')
}

/**
 * 滑动动画 —— easeInOutQuad 缓动曲线，慢起 → 快 → 慢停
 * @param {number} targetX - 目标 X 坐标
 */
function slideTo(targetX) {
  if (slideAnimTimer) clearInterval(slideAnimTimer)
  isSliding = true

  // 记录动画起始位置和总帧数
  const fromX = mainWindow.getBounds().x
  const totalFrames = Math.ceil(SLIDE_DURATION / SLIDE_INTERVAL)
  let frame = 0

  slideAnimTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(slideAnimTimer)
      slideAnimTimer = null
      isSliding = false
      return
    }

    frame++
    const progress = Math.min(frame / totalFrames, 1)
    // easeInOutQuad：前半段加速，后半段减速
    const ease = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2

    setX(fromX + (targetX - fromX) * ease)

    if (progress >= 1) {
      clearInterval(slideAnimTimer)
      slideAnimTimer = null
      isSliding = false
    }
  }, SLIDE_INTERVAL)
}

/**
 * 贴边隐藏 —— 窗口滑出屏幕，创建边缘触发窗口
 * 前置条件：dockSide 非空且 isDockHidden === false
 */
function doHide() {
  if (!mainWindow || mainWindow.isDestroyed() || isDockHidden || !dockSide) return
  isDockHidden = true

  // 隐藏后恢复默认定级，避免在其他应用上方干扰
  mainWindow.setAlwaysOnTop(true)

  updateWorkArea()
  if (!cachedWorkArea) return

  const wa = cachedWorkArea
  const b = mainWindow.getBounds()
  const targetX = dockSide === 'left' ? wa.x - b.width : wa.x + wa.width

  createTriggerWindow(dockSide)
  slideTo(targetX)
}

/**
 * 贴边显示 —— 销毁触发窗口，窗口滑回边缘
 * 前置条件：isDockHidden === true
 */
function doShow() {
  if (!mainWindow || mainWindow.isDestroyed() || !isDockHidden) return
  isDockHidden = false

  // 立即销毁触发窗口，防止阻挡主窗口
  if (triggerWin && !triggerWin.isDestroyed()) {
    triggerWin.destroy()
    triggerWin = null
  }

  updateWorkArea()
  if (!cachedWorkArea) return

  const wa = cachedWorkArea
  const b = mainWindow.getBounds()
  const targetX = dockSide === 'left' ? wa.x : wa.x + wa.width - b.width

  // 滑回前提升定级，确保能覆盖全屏应用
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu')
  slideTo(targetX)
}

// ============================================================
// 应用就绪后的初始化逻辑
// ============================================================
app.whenReady().then(() => {
  // 初始化数据库连接
  initDatabase()

  // 设置 Windows 任务栏的应用程序用户模型 ID
  electronApp.setAppUserModelId('com.electron')

  // 监听新窗口创建事件，自动注册快捷键优化器
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ---- IPC 通道注册 ----

  // 【渲染就绪】渲染进程初始化完成后发送此消息，主进程收到后显示窗口
  ipcMain.on('renderer-ready', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
    }
  })

  // 【窗口控制 - 关闭】渲染进程请求关闭窗口 → 最小化到托盘
  ipcMain.on('window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
      // 隐藏时重置贴边状态
      dockSide = null
      isDockHidden = false
      if (triggerWin && !triggerWin.isDestroyed()) {
        triggerWin.destroy()
        triggerWin = null
      }
    }
  })

  // 【窗口控制 - 最小化】渲染进程请求最小化窗口
  ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
  })

  // 【窗口控制 - 最大化/还原】切换最大化状态
  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      // 最大化/还原时重置贴边状态，避免状态残留
      dockSide = null
      isDockHidden = false
      if (triggerWin && !triggerWin.isDestroyed()) {
        triggerWin.destroy()
        triggerWin = null
      }
      win.isMaximized() ? win.unmaximize() : win.maximize()
    }
  })

  // 【缩放手柄 - 获取边界】返回当前窗口的位置和尺寸
  ipcMain.handle('window-get-bounds', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? win.getBounds() : null
  })

  // 【缩放手柄 - 设置边界】根据渲染进程传入的 bounds 调整窗口大小/位置
  ipcMain.on('window-set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && bounds) {
      // Math.round 确保像素值为整数，避免亚像素渲染问题
      win.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
      })
    }
  })

  // ---- 数据库 IPC 桥接 ----
  // 以下通道将渲染进程的数据库操作请求转发到主进程的 db 模块

  // 按类型批量获取设置
  ipcMain.handle('get-settings', (_event, windowName, type) => {
    return getSettingsByType(windowName, type)
  })

  // 获取单个设置值
  ipcMain.handle('get-setting', (_event, windowName, key) => {
    return getSetting(windowName, key)
  })

  // 写入/更新设置
  ipcMain.handle('set-setting', (_event, windowName, type, key, value) => {
    setSetting(windowName, type, key, value)
    return true
  })

  // 删除设置
  ipcMain.handle('delete-setting', (_event, windowName, key) => {
    deleteSetting(windowName, key)
    return true
  })

  // ---- 贴边隐藏 IPC ----

  // 【贴边隐藏 - 鼠标悬停】渲染进程报告鼠标进入/离开主窗口
  ipcMain.on('window-hover', (_event, isHovering) => {
    if (isHovering) {
      // 鼠标进入窗口 —— 取消待执行的隐藏定时器
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
    } else {
      // 鼠标离开窗口 —— 若已吸附边缘，延迟后执行隐藏
      if (dockSide && !isDockHidden && !isSliding) {
        if (hideTimer) clearTimeout(hideTimer)
        hideTimer = setTimeout(() => {
          hideTimer = null
          // 透明窗口圆角区域会误触发 mouseleave，此处用光标位置二次确认
          if (mainWindow && !mainWindow.isDestroyed()) {
            const b = mainWindow.getBounds()
            const cursor = screen.getCursorScreenPoint()
            if (cursor.x >= b.x && cursor.x <= b.x + b.width && cursor.y >= b.y && cursor.y <= b.y + b.height) {
              return // 光标仍在窗口矩形内 → 误触发，不隐藏
            }
          }
          doHide()
        }, HIDE_DELAY)
      }
    }
  })

  // 【贴边隐藏 - 触发窗口】边缘触发窗口检测到鼠标进入，恢复主窗口
  ipcMain.on('trigger-enter', () => {
    if (isDockHidden) doShow()
  })

  // 创建主窗口
  createWindow()

  // ---- 系统托盘 ----
  tray = new Tray(icon)
  tray.setToolTip('便签')

  // 左键点击：显示窗口
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!mainWindow.isVisible()) {
      if (isDockHidden) doShow()
      mainWindow.show()
      mainWindow.focus()
      // 恢复后重新检测边缘，因为 hide 时 dockSide 被重置了
      dockSide = detectSide()
    }
  })

  // 右键菜单
  const trayMenu = Menu.buildFromTemplate([
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(trayMenu)

  // macOS 特有：点击 Dock 图标时显示窗口
  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
    }
  })
})

// 应用退出前关闭数据库连接和贴边资源，确保数据安全
app.on('before-quit', () => {
  closeDatabase()
  if (triggerWin && !triggerWin.isDestroyed()) {
    triggerWin.destroy()
    triggerWin = null
  }
  if (slideAnimTimer) clearInterval(slideAnimTimer)
  if (hideTimer) clearTimeout(hideTimer)
  if (tray) {
    tray.destroy()
    tray = null
  }
})

// 所有窗口关闭时不退出应用，保持在托盘中运行
app.on('window-all-closed', () => {})
