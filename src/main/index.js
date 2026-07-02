
/**
 * index.js — Electron 主进程入口文件
 *
 * 职责：
 *   1. 创建和管理 BrowserWindow（无边框、透明背景）
 *   2. 注册所有 IPC 通道（窗口控制、缩放手柄、数据库桥接）
 *   3. 管理应用生命周期（启动、退出、macOS 激活）
 *   4. 窗口几何信息的防抖持久化
 */

import * as Electron from 'electron'
const { app, shell, BrowserWindow, ipcMain, screen, Tray, Menu } = Electron

import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils' // Electron 开发工具集
import icon from '../../resources/icon.png?asset' // 应用图标（Vite asset 导入）
import {
  initDatabase,
  closeDatabase,
  getGeometry,
  saveGeometry,
  getSetting,
  setSetting,
  getSettingsByType,
  deleteSetting,
  resetDatabase
} from './db.js'
import {
  detectCapabilities,
  initialize as blurInit,
  setConfig as blurSetConfig,
  updateGeometry as blurUpdateGeometry,
  destroy as blurDestroy
} from './blur_bridge.js'

/** 窗口标识常量，用于在数据库中区分不同窗口的设置 */
const WINDOW_NAME = 'main'

/** 主窗口实例引用 */
let mainWindow = null

/** 系统托盘实例 */
let tray = null

/** 是否正在执行退出流程（托盘菜单「退出」触发） */
let isQuitting = false

/** 窗口置顶状态 */
let alwaysOnTop = true

/** 窗口锁定状态（禁止移动和缩放） */
let isLocked = false

/** 系统模糊能力信息（启动时检测） */
const blurCaps = detectCapabilities()

/** 系统模糊是否已初始化 */
let blurInitialized = false

/** 当前模糊配置（持久化到数据库） */
const blurConfig = {
  enabled: true,
  radius: 10,                          // 模糊半径/通透度 (0~100 DIP)，默认 10
  tint: { r: 255, g: 255, b: 255 },    // 颜色 (默认白色=无色叠加)
  saturation: 1.8,                      // 饱和度 (0~2, 苹果风格 = 1.8)
  cornerRadius: 12                       // 窗口圆角 (0~30 DIP)
}

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
let pendingSlideCallback = null // 动画中断时待执行的完成回调

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

  // 创建主窗口实例（透明背景 + CSS 圆角）
  mainWindow = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    skipTaskbar: true,
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window' } : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 固定缩放因子为 1.0，防止系统 DPI 缩放影响布局
  mainWindow.webContents.setZoomFactor(1.0)

  // 恢复锁定状态（持久化）
  const savedLocked = getSetting(WINDOW_NAME, 'lock_state')
  if (savedLocked === 'true') {
    isLocked = true
    mainWindow.setMovable(false)
    mainWindow.setResizable(false)
  }

  // ---- 初始化系统模糊 ----
  if (blurCaps.supported) {
    try {
      // 从数据库恢复模糊配置
      const savedEnabled = getSetting(WINDOW_NAME, 'blur_enabled')
      const savedRadius = getSetting(WINDOW_NAME, 'blur_radius')
      const savedTintR = getSetting(WINDOW_NAME, 'blur_tint_r')
      const savedTintG = getSetting(WINDOW_NAME, 'blur_tint_g')
      const savedTintB = getSetting(WINDOW_NAME, 'blur_tint_b')
      const savedSaturation = getSetting(WINDOW_NAME, 'blur_saturation')
      const savedCornerRadius = getSetting(WINDOW_NAME, 'blur_corner_radius')

      if (savedEnabled !== null) blurConfig.enabled = savedEnabled === 'true'
      if (savedRadius !== null) blurConfig.radius = parseFloat(savedRadius)
      if (savedTintR !== null) blurConfig.tint.r = parseInt(savedTintR)
      if (savedTintG !== null) blurConfig.tint.g = parseInt(savedTintG)
      if (savedTintB !== null) blurConfig.tint.b = parseInt(savedTintB)
      if (savedSaturation !== null) blurConfig.saturation = parseFloat(savedSaturation)
      if (savedCornerRadius !== null) blurConfig.cornerRadius = parseFloat(savedCornerRadius)

      const result = blurInit(mainWindow)
      if (result.success) {
        blurInitialized = true
        // 仅 Windows 需要设置初始参数（macOS 在构造时已设置 vibrancy）
        if (process.platform === 'win32' && blurConfig.enabled) {
          blurSetConfig(blurConfig)
        }
        // macOS：若持久化配置中毛玻璃为关闭，需覆盖构造时硬编码的 vibrancy
        if (process.platform === 'darwin' && !blurConfig.enabled) {
          mainWindow.setVibrancy(null)
        }
        console.log('[blur] 系统模糊已初始化, 策略:', result.strategy)
      } else {
        console.warn('[blur] 初始化失败:', result.error)
      }
    } catch (e) {
      console.warn('[blur] 初始化异常:', e.message)
    }
  } else {
    console.log('[blur] 当前平台不支持系统模糊:', blurCaps.reason)
  }

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

  // 窗口移动/缩放时同步模糊 overlay 位置
  if (blurInitialized && process.platform === 'win32') {
    mainWindow.on('resize', () => {
      try { blurUpdateGeometry(mainWindow) } catch (_) { /* DComp 会话失效时静默 */ }
    })
    mainWindow.on('move', () => {
      try { blurUpdateGeometry(mainWindow) } catch (_) { /* DComp 会话失效时静默 */ }
    })
  }

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
      hideToTray()
    }
  })

  // 窗口显示时恢复模糊（从托盘恢复）
  mainWindow.on('show', () => {
    if (blurInitialized && blurConfig.enabled) {
      blurSetConfig(blurConfig)
    }
  })

  // 窗口销毁时清除引用和贴边资源
  mainWindow.on('closed', () => {
    mainWindow = null
    resetDockState()
  })

  // 根据环境加载页面：开发模式用 HMR URL，生产模式加载本地 HTML 文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ============================================================
// 托盘隐藏（窗口关闭 → 最小化到托盘，统一入口）
// ============================================================

/** 窗口关闭/隐藏时统一执行：隐藏窗口 + 清理贴边 + 禁用系统模糊 */
function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
  resetDockState()
  if (blurInitialized) blurSetConfig({ enabled: false })
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

/** 重置贴边状态（隐藏/关闭/最大化时统一调用） */
function resetDockState() {
  dockSide = null
  isDockHidden = false
  if (triggerWin && !triggerWin.isDestroyed()) {
    triggerWin.destroy()
    triggerWin = null
  }
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

  // 允许鼠标事件穿透触发窗口，避免阻挡下层 UI 的点击操作
  // forward: true 确保 mouseenter 仍能正常触发恢复动画
  triggerWin.setIgnoreMouseEvents(true, { forward: true })
}

/**
 * 滑动动画 —— easeInOutQuad 缓动曲线，慢起 → 快 → 慢停
 * @param {number} targetX - 目标 X 坐标
 * @param {Function} [onFinish] - 动画完成回调
 */
function slideTo(targetX, onFinish) {
  // 中断前一个动画时，先执行其回调以恢复状态（如置顶级别）
  if (slideAnimTimer) {
    clearInterval(slideAnimTimer)
    slideAnimTimer = null
  }
  if (pendingSlideCallback) {
    const cb = pendingSlideCallback
    pendingSlideCallback = null
    cb()
  }

  isSliding = true
  pendingSlideCallback = onFinish || null

  // 记录动画起始位置和总帧数
  const fromX = mainWindow.getBounds().x
  const totalFrames = Math.ceil(SLIDE_DURATION / SLIDE_INTERVAL)
  let frame = 0

  slideAnimTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(slideAnimTimer)
      slideAnimTimer = null
      isSliding = false
      if (pendingSlideCallback) {
        const cb = pendingSlideCallback
        pendingSlideCallback = null
        cb()
      }
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
      if (pendingSlideCallback) {
        const cb = pendingSlideCallback
        pendingSlideCallback = null
        cb()
      }
    }
  }, SLIDE_INTERVAL)
}

/**
 * 贴边隐藏 —— 窗口滑出屏幕，创建边缘触发窗口
 * 前置条件：dockSide 非空且 isDockHidden === false
 */
function doHide() {
  if (!mainWindow || mainWindow.isDestroyed() || isDockHidden || !dockSide) return
  if (isSliding) return

  updateWorkArea()
  if (!cachedWorkArea) return

  isDockHidden = true

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
  if (isSliding) return

  updateWorkArea()
  if (!cachedWorkArea) return

  isDockHidden = false

  // 立即销毁触发窗口，防止阻挡主窗口
  if (triggerWin && !triggerWin.isDestroyed()) {
    triggerWin.destroy()
    triggerWin = null
  }

  const wa = cachedWorkArea
  const b = mainWindow.getBounds()
  const targetX = dockSide === 'left' ? wa.x : wa.x + wa.width - b.width

  // 滑出时短暂提升置顶层，确保动画可见
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu')
  slideTo(targetX, () => {
    // 动画完成后恢复用户设置的置顶状态
    applyAlwaysOnTop()
  })
}

// ============================================================
// 窗口置顶控制
// ============================================================

/** 根据当前 alwaysOnTop 状态应用定级 */
function applyAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setAlwaysOnTop(alwaysOnTop, 'pop-up-menu')
}

// ============================================================
// 窗口切换（托盘点击）
// ============================================================

/**
 * 托盘点击统一切换逻辑：
 * - 贴边隐藏 → 滑出（doShow）
 * - 贴边可见 → 滑入（doHide）
 * - 非贴边   → 显示/隐藏到托盘
 */
function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (isDockHidden) {
    doShow()
    return
  }
  if (dockSide) {
    doHide()
    return
  }
  if (mainWindow.isVisible()) {
    hideToTray()
  } else {
    mainWindow.show()
    // 从托盘恢复后重新检测贴边（hideToTray 中的 resetDockState 清除了 dockSide）
    dockSide = detectSide()
  }
}

// ============================================================
// 应用就绪后的初始化逻辑
// ============================================================
app.whenReady().then(() => {
  // 初始化数据库连接
  initDatabase()

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
    hideToTray()
  })

  // 【窗口控制 - 最小化】渲染进程请求最小化窗口
  ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
  })

  // 【窗口锁定 - 切换锁定状态】
  ipcMain.handle('toggle-lock', () => {
    isLocked = !isLocked
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setMovable(!isLocked)
      mainWindow.setResizable(!isLocked)
    }
    setSetting(WINDOW_NAME, 'system', 'lock_state', String(isLocked))
    return isLocked
  })

  // 【窗口锁定 - 获取锁定状态】
  ipcMain.handle('get-lock-state', () => {
    return isLocked
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

  // ---- 系统模糊 IPC ----

  /** 获取平台模糊能力信息 */
  ipcMain.handle('get-blur-capabilities', () => {
    return blurCaps
  })

  /** 获取当前模糊配置 */
  ipcMain.handle('get-blur-config', () => {
    return { ...blurConfig, initialized: blurInitialized }
  })

  /** 设置模糊配置（立即生效 + 持久化到数据库） */
  ipcMain.handle('set-blur-config', (_event, config) => {
    // 合并到当前配置
    if (config.enabled !== undefined) blurConfig.enabled = config.enabled
    if (config.radius !== undefined) blurConfig.radius = config.radius
    if (config.tint) {
      if (config.tint.r !== undefined) blurConfig.tint.r = config.tint.r
      if (config.tint.g !== undefined) blurConfig.tint.g = config.tint.g
      if (config.tint.b !== undefined) blurConfig.tint.b = config.tint.b
    }
    if (config.saturation !== undefined) blurConfig.saturation = config.saturation
    if (config.cornerRadius !== undefined) blurConfig.cornerRadius = config.cornerRadius

    // 持久化到数据库
    setSetting(WINDOW_NAME, 'system', 'blur_enabled', String(blurConfig.enabled))
    setSetting(WINDOW_NAME, 'system', 'blur_radius', String(blurConfig.radius))
    setSetting(WINDOW_NAME, 'system', 'blur_tint_r', String(blurConfig.tint.r))
    setSetting(WINDOW_NAME, 'system', 'blur_tint_g', String(blurConfig.tint.g))
    setSetting(WINDOW_NAME, 'system', 'blur_tint_b', String(blurConfig.tint.b))
    setSetting(WINDOW_NAME, 'system', 'blur_saturation', String(blurConfig.saturation))
    setSetting(WINDOW_NAME, 'system', 'blur_corner_radius', String(blurConfig.cornerRadius))

    // 立即生效（仅 Windows 需要调用 DLL）
    if (blurInitialized && process.platform === 'win32') {
      blurSetConfig(blurConfig)
    }

    // macOS：切换 vibrancy 类型
    if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
      if (blurConfig.enabled) {
        mainWindow.setVibrancy('under-window')
      } else {
        mainWindow.setVibrancy(null)
      }
    }

    return { ...blurConfig }
  })

  createWindow()

  // 初始化置顶状态（必须在 createWindow 之后）
  applyAlwaysOnTop()

  // ---- 任务栏 & 托盘事件 ----

  // show：贴边隐藏时滑出（安全网，正常路径下 show 不会在贴边隐藏时触发）
  mainWindow.on('show', () => {
    if (isDockHidden) doShow()
  })

  // minimize：贴边状态下取消最小化并滑出隐藏，非贴边场景正常隐藏到托盘
  mainWindow.on('minimize', () => {
    if (dockSide && !isDockHidden && !isSliding && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.restore()
      setTimeout(() => doHide(), 0)
      return
    }
    hideToTray()
  })

  // 【重置数据库】
  ipcMain.handle('reset-database', () => {
    resetDatabase()
    return true
  })

  // ---- 开机自启 ----

  /**
   * 校验开机自启状态
   * 每次打开设置页面时调用：以数据库为权威，尝试将 OS 同步为数据库的值
   * 若同步失败则返回错误信息（持久显示，不自动消失）
   * @returns {{ value: boolean, error: string|null }}
   */
  ipcMain.handle('verify-auto-start', () => {
    const dbValue = getSetting(WINDOW_NAME, 'auto_start')

    // 数据库无记录 → 以 OS 当前状态为准，写入数据库
    if (dbValue === null) {
      const osSettings = app.getLoginItemSettings()
      setSetting(WINDOW_NAME, 'system', 'auto_start', String(osSettings.openAtLogin))
      return { value: osSettings.openAtLogin, error: null }
    }

    const dbEnabled = dbValue === 'true'

    // 尝试将 OS 同步为数据库的值
    app.setLoginItemSettings({ openAtLogin: dbEnabled })
    const verifySettings = app.getLoginItemSettings()

    if (verifySettings.openAtLogin === dbEnabled) {
      return { value: dbEnabled, error: null }
    }

    // 同步失败：返回实际状态 + 错误信息
    return {
      value: verifySettings.openAtLogin,
      error: dbEnabled
        ? '开启失败，请检查系统安全软件是否拦截了开机启动权限'
        : '关闭失败，请检查系统权限设置'
    }
  })

  /**
   * 校验毛玻璃启用状态
   * 每次打开设置页面时调用：以数据库为权威，尝试将运行时状态同步为数据库的值
   * 若无法启用（如 DLL 未加载）则返回错误信息
   * @returns {{ value: boolean, error: string|null }}
   */
  ipcMain.handle('verify-blur-enabled', () => {
    const dbValue = getSetting(WINDOW_NAME, 'blur_enabled')
    if (dbValue === null) return { value: true, error: null }

    const dbEnabled = dbValue === 'true'

    // macOS：直接设置 vibrancy
    if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setVibrancy(dbEnabled ? 'under-window' : null)
      blurConfig.enabled = dbEnabled
      return { value: dbEnabled, error: null }
    }

    // Windows：需要通过 DLL 控制
    if (process.platform === 'win32') {
      if (dbEnabled && !blurInitialized) {
        return {
          value: false,
          error: '系统模糊引擎未加载（DLL 缺失或版本不兼容）'
        }
      }
      if (blurInitialized) {
        blurConfig.enabled = dbEnabled
        blurSetConfig({ enabled: dbEnabled })
      }
      return { value: dbEnabled, error: null }
    }

    // 不支持模糊的平台（Linux 等）
    return { value: dbEnabled, error: null }
  })

  /**
   * 设置开机自启
   * 同时更新 OS 注册表/LoginItem 和本地数据库
   * 返回设置后 OS 确认的真实状态（用于 UI 校验）
   */
  ipcMain.handle('set-auto-start', (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled })
    setSetting(WINDOW_NAME, 'system', 'auto_start', String(enabled))

    // 立即回读确认 OS 是否设置成功
    const verifySettings = app.getLoginItemSettings()
    return verifySettings.openAtLogin
  })

  // ---- 系统托盘 ----
  tray = new Tray(icon)
  tray.setToolTip('便签')

  // 左键点击：切换（显示/隐藏 ↔ 滑出/滑入）
  tray.on('click', () => {
    toggleWindow()
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
  // 销毁模糊引擎（释放 DLL 资源）
  blurDestroy()
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
