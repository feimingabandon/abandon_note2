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
const { app, shell, BrowserWindow, ipcMain, screen, Tray, Menu, Notification } = Electron

import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils' // Electron 开发工具集
import icon from '../../resources/icon.png?asset' // 应用图标（Vite asset 导入）
import {
  initDatabase,
  closeDatabase,
  getDb,
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
  destroy as blurDestroy,
  reSyncZOrder as blurReSyncZOrder
} from './blur_bridge.js'

import {
  createNote,
  updateNote,
  deleteNote,
  getNoteById,
  listNotes,
  startProgress,
  completeNote,
  cancelNote,
  batchUpdateStatus,
  batchSetPinned,
  batchSetEffectiveAt,
  batchAddTags
} from './db-notes.js'
import {
  createTag,
  updateTag,
  deleteTag as deleteTagFn,
  listTags,
  getTagById,
  bindTag,
  unbindTag,
  setNoteTags,
  getNoteTags
} from './db-tags.js'
import {
  createTemplate,
  updateTemplate,
  deleteTemplate as deleteTemplateFn,
  listTemplates,
  getTemplateById,
  pauseTemplate,
  resumeTemplate
} from './db-templates.js'
import { addAttachment, removeAttachment, listAttachments } from './db-attachments.js'
import { searchNotes, searchSuggestions } from './db-search.js'
import { Scheduler } from './scheduler.js'
import { generateRecurringNotes } from './recurrence.js'

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
  radius: 15, // 模糊半径/通透度 (0~100 DIP)，默认 15
  opacity: 1.0, // 模糊层透明度 (0=全透, 1=不透明, 0~1)
  tint: { r: 255, g: 255, b: 255 }, // 颜色 (默认白色=无色叠加)
  saturation: 1.8, // 饱和度 (0~2, 苹果风格 = 1.8)
  cornerRadius: 12 // 窗口圆角 (0~30 DIP)
}

/** 防抖定时器，用于延迟保存窗口位置/尺寸 */
let geometryTimer = null

/** 统一调度器实例 */
const scheduler = new Scheduler()

// ============================================================
// 贴边隐藏模块
// ============================================================
const SNAP_THRESHOLD = 20 // 贴边吸附阈值（px）
const TRIGGER_WIDTH = 2 // 边缘触发窗口宽度（px）
const SLIDE_DURATION = 200 // 滑动动画总时长（ms）
const SLIDE_INTERVAL = 16 // 滑动动画帧间隔（ms）≈60fps
const HIDE_DELAY = 200 // 鼠标离开后延迟隐藏（ms）

/** 默认窗口尺寸比例（相对屏幕工作区），改一个地方即可全局生效 */
const DEFAULT_WIDTH_RATIO = 0.25 // 宽度 = 屏幕工作区宽度 × 25%
const DEFAULT_HEIGHT_RATIO = 0.9 // 高度 = 屏幕工作区高度 × 90%

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

  // 计算默认窗口尺寸（比例见顶部常量）
  const defaultW = Math.round(screenW * DEFAULT_WIDTH_RATIO)
  const defaultH = Math.round(screenH * DEFAULT_HEIGHT_RATIO)
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
      const savedOpacity = getSetting(WINDOW_NAME, 'blur_opacity')
      const savedCornerRadius = getSetting(WINDOW_NAME, 'blur_corner_radius')

      if (savedEnabled !== null) blurConfig.enabled = savedEnabled === 'true'
      if (savedRadius !== null) blurConfig.radius = parseFloat(savedRadius)
      if (savedTintR !== null) blurConfig.tint.r = parseInt(savedTintR)
      if (savedTintG !== null) blurConfig.tint.g = parseInt(savedTintG)
      if (savedTintB !== null) blurConfig.tint.b = parseInt(savedTintB)
      if (savedSaturation !== null) blurConfig.saturation = parseFloat(savedSaturation)
      if (savedOpacity !== null) blurConfig.opacity = parseFloat(savedOpacity)
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
      try {
        blurUpdateGeometry(mainWindow)
      } catch (_) {
        /* DComp 会话失效时静默 */
      }
    })
    mainWindow.on('move', () => {
      try {
        blurUpdateGeometry(mainWindow)
      } catch (_) {
        /* DComp 会话失效时静默 */
      }
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
 * 2px 宽的透明窗口，高度与主窗口一致，仅覆盖窗口实际所在的屏幕边缘区域
 */
function createTriggerWindow(side) {
  if (triggerWin && !triggerWin.isDestroyed()) triggerWin.destroy()
  updateWorkArea()
  if (!cachedWorkArea) return

  const wa = cachedWorkArea
  const b = mainWindow.getBounds()
  const bounds =
    side === 'left'
      ? { x: wa.x, y: b.y, width: TRIGGER_WIDTH, height: b.height }
      : { x: wa.x + wa.width - TRIGGER_WIDTH, y: b.y, width: TRIGGER_WIDTH, height: b.height }

  triggerWin = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: alwaysOnTop,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  const html = `<body style="margin:0;height:100%" onmouseenter="api.triggerEnter()">`
  triggerWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {})

  triggerWin.setVisibleOnAllWorkspaces(true)
  // 跟随主窗口置顶状态（置顶时提升到 pop-up-menu 覆盖全屏应用）
  triggerWin.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? 'pop-up-menu' : undefined)

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
    const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2

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
  blurReSyncZOrder()

  // 同步触发窗口置顶状态（贴边隐藏时切换置顶按钮生效）
  if (triggerWin && !triggerWin.isDestroyed()) {
    triggerWin.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? 'pop-up-menu' : undefined)
  }
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

  // 【窗口锁定 - 切换锁定状态】
  ipcMain.handle('toggle-lock', () => {
    isLocked = !isLocked
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setMovable(!isLocked)
      mainWindow.setResizable(!isLocked)
    }
    setSetting(
      WINDOW_NAME,
      'system',
      'lock_state',
      String(isLocked),
      '窗口锁定状态（true=锁定禁止移动缩放, false=解锁）'
    )
    return isLocked
  })

  // 【窗口锁定 - 获取锁定状态】
  ipcMain.handle('get-lock-state', () => {
    return isLocked
  })

  // 【窗口置顶 - 切换】
  ipcMain.handle('toggle-always-on-top', () => {
    alwaysOnTop = !alwaysOnTop
    applyAlwaysOnTop()
    setSetting(
      WINDOW_NAME,
      'system',
      'always_on_top',
      String(alwaysOnTop),
      '窗口置顶状态（true=始终置顶, false=正常层级）'
    )
    return alwaysOnTop
  })

  // 【窗口置顶 - 获取状态】
  ipcMain.handle('get-always-on-top', () => {
    return alwaysOnTop
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
  ipcMain.handle('set-setting', (_event, windowName, type, key, value, remark) => {
    setSetting(windowName, type, key, value, remark)
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
            if (
              cursor.x >= b.x &&
              cursor.x <= b.x + b.width &&
              cursor.y >= b.y &&
              cursor.y <= b.y + b.height
            ) {
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
    if (config.opacity !== undefined) blurConfig.opacity = config.opacity
    if (config.cornerRadius !== undefined) blurConfig.cornerRadius = config.cornerRadius

    // 持久化到数据库
    setSetting(
      WINDOW_NAME,
      'system',
      'blur_enabled',
      String(blurConfig.enabled),
      '系统级毛玻璃效果开关（true=启用, false=关闭）'
    )
    setSetting(
      WINDOW_NAME,
      'system',
      'blur_radius',
      String(blurConfig.radius),
      '系统模糊半径/通透度（0~100 DIP）'
    )
    setSetting(
      WINDOW_NAME,
      'system',
      'blur_tint_r',
      String(blurConfig.tint.r),
      '系统模糊着色-红色通道（0~255）'
    )
    setSetting(
      WINDOW_NAME,
      'system',
      'blur_tint_g',
      String(blurConfig.tint.g),
      '系统模糊着色-绿色通道（0~255）'
    )
    setSetting(
      WINDOW_NAME,
      'system',
      'blur_tint_b',
      String(blurConfig.tint.b),
      '系统模糊着色-蓝色通道（0~255）'
    )
    setSetting(
      WINDOW_NAME,
      'system',
      'blur_saturation',
      String(blurConfig.saturation),
      '系统模糊饱和度（0~2 浮点数，苹果风格=1.8）'
    )
    setSetting(
      WINDOW_NAME,
      'system',
      'blur_opacity',
      String(blurConfig.opacity),
      '系统模糊层透明度（0~1 浮点数，1=不透明）'
    )
    setSetting(
      WINDOW_NAME,
      'system',
      'blur_corner_radius',
      String(blurConfig.cornerRadius),
      '窗口圆角半径（0~30 DIP）'
    )

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

  // 从数据库恢复置顶状态（默认 true）
  const savedAlwaysOnTop = getSetting(WINDOW_NAME, 'always_on_top')
  if (savedAlwaysOnTop !== null) alwaysOnTop = savedAlwaysOnTop === 'true'

  // 初始化置顶状态（必须在 createWindow 之后）
  applyAlwaysOnTop()
  // ---- 调度器任务注册 ----

  // 3.3 通知任务：每分钟检查生效时间已到的便签并弹出操作系统通知
  scheduler.register({
    name: 'notificationTask',
    shouldRun: () => true,
    execute: () => {
      const now = Date.now()
      const db = getDb()
      const notes = db
        .prepare(
          `SELECT id, content, note_type, effective_at FROM notes
         WHERE notify_enabled = 1 AND effective_at <= ? AND effective_at > ?
         AND status IN ('active','in_progress')
         ORDER BY effective_at DESC LIMIT 20`
        )
        .all(now, now - 60000)

      for (const note of notes) {
        const summary = (note.content || '').slice(0, 50) || '（空内容）'
        new Notification({ title: '便签提醒', body: summary, silent: false }).show()
        db.prepare('UPDATE notes SET notify_enabled = 0 WHERE id = ?').run(note.id)

        const name = (note.content || '').trim().slice(0, 5) || '空内容'
        const typeLabel = note.note_type === 'one_time' ? '一次性' : note.note_type
        const time = new Date(note.effective_at).toLocaleTimeString('zh-CN', { hour12: false })
        console.log(`[notification] 便签 #${note.id}「${name}」[${typeLabel}] 生效 ${time}`)
      }
    }
  })

  // 3.4 循环模板生成任务：每分钟检查应当生成的模板并创建实例
  scheduler.register({
    name: 'noteGenerationTask',
    shouldRun: () => true,
    execute: () => {
      generateRecurringNotes()
      // 具体生成日志由 generateRecurringNotes 内部逐模板打印
    }
  })

  // 启动调度器
  scheduler.start()
  console.log('[scheduler] 调度器已启动')

  // ---- 任务栏 & 托盘事件 ----

  // show：贴边隐藏时滑出（安全网，正常路径下 show 不会在贴边隐藏时触发）
  mainWindow.on('show', () => {
    if (isDockHidden) doShow()
  })

  // 【重置数据库】
  ipcMain.handle('reset-database', () => {
    resetDatabase()
    return true
  })

  // 【重置窗口几何】仅恢复默认宽高（屏幕 25% × 90%），保留当前位置
  ipcMain.handle('reset-window-geometry', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false

    // 保留当前位置
    const currentBounds = mainWindow.getBounds()

    // 计算默认尺寸（比例见顶部常量）
    const display = screen.getPrimaryDisplay()
    const screenW = display.workAreaSize.width
    const screenH = display.workAreaSize.height
    const defaultW = Math.round(screenW * DEFAULT_WIDTH_RATIO)
    const defaultH = Math.round(screenH * DEFAULT_HEIGHT_RATIO)

    mainWindow.setBounds({
      x: currentBounds.x,
      y: currentBounds.y,
      width: defaultW,
      height: defaultH
    })

    // 仅持久化新的宽高，不修改 x、y
    setSetting(WINDOW_NAME, 'geometry', 'width', String(defaultW), '窗口宽度（像素）')
    setSetting(WINDOW_NAME, 'geometry', 'height', String(defaultH), '窗口高度（像素）')
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
      setSetting(
        WINDOW_NAME,
        'system',
        'auto_start',
        String(osSettings.openAtLogin),
        '开机自启开关（true=启用, false=关闭）'
      )
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
    setSetting(
      WINDOW_NAME,
      'system',
      'auto_start',
      String(enabled),
      '开机自启开关（true=启用, false=关闭）'
    )

    // 立即回读确认 OS 是否设置成功
    const verifySettings = app.getLoginItemSettings()
    return verifySettings.openAtLogin
  })

  // ---- 便签便签 CRUD IPC ----

  // 【便签 - 创建】
  ipcMain.handle('notes:create', (_event, options) => {
    return createNote(options || {})
  })

  // 【便签 - 更新】
  ipcMain.handle('notes:update', (_event, { id, fields }) => {
    return updateNote(id, fields || {})
  })

  // 【便签 - 删除（取消）】
  ipcMain.handle('notes:delete', (_event, { id }) => {
    return deleteNote(id)
  })

  // 【便签 - 获取单条（含附件和标签）】
  ipcMain.handle('notes:get', (_event, { id }) => {
    return getNoteById(id)
  })

  // 【便签 - 列表查询】
  ipcMain.handle('notes:list', (_event, options) => {
    return listNotes(options || {})
  })

  // 【便签 - 开始处理】
  ipcMain.handle('notes:start-progress', (_event, { id }) => {
    return startProgress(id)
  })

  // 【便签 - 完成】
  ipcMain.handle('notes:complete', (_event, { id }) => {
    return completeNote(id)
  })

  // 【便签 - 取消】
  ipcMain.handle('notes:cancel', (_event, { id }) => {
    return cancelNote(id)
  })

  // ---- 标签 CRUD IPC ----

  // 【标签 - 创建】
  ipcMain.handle('tags:create', (_event, { name, color }) => {
    return createTag(name, color)
  })

  // 【标签 - 更新】
  ipcMain.handle('tags:update', (_event, { name, fields }) => {
    return updateTag(name, fields || {})
  })

  // 【标签 - 删除】
  ipcMain.handle('tags:delete', (_event, { name }) => {
    return deleteTagFn(name)
  })

  // 【标签 - 列表】
  ipcMain.handle('tags:list', () => {
    return listTags()
  })

  // 【标签 - 获取单条】
  ipcMain.handle('tags:get', (_event, { name }) => {
    return getTagByName(name)
  })

  // 【便签标签 - 绑定】
  ipcMain.handle('note-tags:bind', (_event, { noteId, tagName }) => {
    return bindTag(noteId, tagName)
  })

  // 【便签标签 - 解绑】
  ipcMain.handle('note-tags:unbind', (_event, { noteId, tagName }) => {
    return unbindTag(noteId, tagName)
  })

  // 【便签标签 - 整体设置（事务替换）】
  ipcMain.handle('note-tags:set', (_event, { noteId, tagNames }) => {
    setNoteTags(noteId, tagNames)
    return getNoteTags(noteId)
  })

  // 【便签标签 - 获取便签的标签列表】
  ipcMain.handle('note-tags:list', (_event, { noteId }) => {
    return getNoteTags(noteId)
  })

  // ---- 循环模板 CRUD IPC ----

  // 【模板 - 创建】
  ipcMain.handle('templates:create', (_event, options) => {
    return createTemplate(options || {})
  })

  // 【模板 - 更新】
  ipcMain.handle('templates:update', (_event, { id, fields }) => {
    return updateTemplate(id, fields || {})
  })

  // 【模板 - 删除（软删）】
  ipcMain.handle('templates:delete', (_event, { id }) => {
    return deleteTemplateFn(id)
  })

  // 【模板 - 列表（仅活跃模板）】
  ipcMain.handle('templates:list', () => {
    return listTemplates()
  })

  // 【模板 - 获取单条】
  ipcMain.handle('templates:get', (_event, { id }) => {
    return getTemplateById(id)
  })

  // 【模板 - 暂停】
  ipcMain.handle('templates:pause', (_event, { id }) => {
    return pauseTemplate(id)
  })

  // 【模板 - 恢复】
  ipcMain.handle('templates:resume', (_event, { id }) => {
    return resumeTemplate(id)
  })

  // ---- 附件 IPC ----

  // 【附件 - 添加】
  ipcMain.handle('attachments:add', (_event, options) => {
    return addAttachment(options || {})
  })

  // 【附件 - 删除】
  ipcMain.handle('attachments:remove', (_event, { id }) => {
    return removeAttachment(id)
  })

  // 【附件 - 列表】
  ipcMain.handle('attachments:list', (_event, { noteId }) => {
    return listAttachments(noteId)
  })

  // ---- 搜索 IPC ----

  // 【搜索 - 全文搜索】
  ipcMain.handle('search:notes', (_event, { query, options }) => {
    return searchNotes(query, options || {})
  })

  // 【搜索 - 自动补全建议】
  ipcMain.handle('search:suggestions', (_event, { prefix, limit }) => {
    return searchSuggestions(prefix, limit)
  })

  // ---- 批量操作 IPC ----

  // 【批量 - 更新状态】
  ipcMain.handle('batch:update-status', (_event, { ids, status }) => {
    return batchUpdateStatus(ids, status)
  })

  // 【批量 - 设置置顶】
  ipcMain.handle('batch:set-pinned', (_event, { ids, pinned }) => {
    return batchSetPinned(ids, pinned)
  })

  // 【批量 - 设置生效时间】
  ipcMain.handle('batch:set-effective-at', (_event, { ids, effectiveAt }) => {
    return batchSetEffectiveAt(ids, effectiveAt)
  })

  // 【批量 - 添加标签】
  ipcMain.handle('batch:add-tags', (_event, { noteIds, tagNames }) => {
    batchAddTags(noteIds, tagNames)
    return true
  })

  // ---- 调度器健康检查 IPC ----

  // 【调度器 - 健康检查】（占位，调度器未实现前返回离线状态）
  ipcMain.handle('scheduler:health', () => {
    return scheduler.getHealth()
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
  scheduler.stop()
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
