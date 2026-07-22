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
const { app, shell, BrowserWindow, ipcMain, screen, Tray, Menu, Notification, desktopCapturer } =
  Electron

import { join, resolve } from 'path'
import { optimizer, is } from '@electron-toolkit/utils' // Electron 开发工具集
import icon from '../../resources/icon.png?asset' // 应用图标（Vite asset 导入）
import {
  initDatabase,
  closeDatabase,
  getDb,
  getAllSettings,
  setSettingsBatch,
  clearAllSettings,
  deleteSettingsByKey,
  cleanupPendingAttachmentDirs,
  clearNoteData
} from './db/db.js'
import {
  detectCapabilities,
  initialize as blurInit,
  setConfig as blurSetConfig,
  updateGeometry as blurUpdateGeometry,
  destroy as blurDestroy,
  reSyncZOrder as blurReSyncZOrder,
  getRuntimeHealth as getBlurRuntimeHealth
} from './bridge/blur_bridge.js'

import {
  createNote,
  updateNote,
  deleteNote,
  purgeNote,
  getNoteById,
  queryPinnedNotes,
  queryRecentNotes,
  queryEarlierNotes,
  queryCustomPinned,
  queryCustomNormal,
  searchNotes,
  countActiveNotes,
  reorderCustomSortOrder,
  updateCustomSortOrders,
  startProgress,
  completeNote,
  reopenNote,
  activateNotes,
  snoozeNote,
  claimDueSnoozedNotes
} from './db/db-notes.js'
import {
  createTag,
  deleteTag as deleteTagFn,
  listTags,
  getTagByName,
  bindTag,
  unbindTag,
  setNoteTags,
  getNoteTags,
  getTagUsage
} from './db/db-tags.js'
import {
  createTemplate,
  updateTemplate,
  deleteTemplate as deleteTemplateFn,
  listTemplates,
  getTemplateById,
  pauseTemplate,
  resumeTemplate,
  restoreTemplate,
  purgeTemplate
} from './db/db-templates.js'
import {
  stageImage,
  commitStagedImage,
  cleanupStagedImage,
  stageImageDeletion,
  restoreStagedImageDeletion,
  stageNoteImagesDeletion,
  cleanupStagedNoteImages,
  deleteImageFile,
  deleteNoteImages,
  getImageBase64,
  getImageThumbnail,
  addImageRecord,
  listImageRecords,
  getImageCount
} from './db/db-images.js'
import {
  cleanupPendingWallpaperFiles,
  deleteWallpaperVersion,
  getWallpaperDataUrl,
  getWallpaperThumbnail,
  listWallpaperRecords,
  markWallpaperUsed,
  saveWallpaperVersion
} from './db/db-wallpapers.js'
import { Scheduler } from './services/scheduler.js'
import { runRecurringTemplates } from './services/recurrence.js'
import { calculateNextRun, normalizeRecurrenceRule } from './services/recurrence-rules.js'
import { TemplateSchedulerGuard } from './services/template-scheduler-guard.js'
import { sendNotificationSafely } from './services/notification-guard.js'
import {
  DEFAULT_SETTINGS,
  createDefaultSettings,
  resolveSettingsRows,
  serializeSetting
} from '../shared/settings-schema.js'

/** 窗口标识常量，用于在数据库中区分不同窗口的设置 */
const WINDOW_NAME = 'main'
const APP_ID = 'com.abandon.note'
const APP_NAME = '便签'
// 安装版由 NSIS 快捷方式把 APP_ID 映射为 productName；开发环境没有这层注册，
// Windows 会直接展示原始 ID，因此开发时使用中文名称作为通知来源标识。
const WINDOWS_APP_USER_MODEL_ID = app.isPackaged ? APP_ID : APP_NAME
const APP_PROTOCOL = 'abandon-note'
const SNOOZE_DELAY_MS = 10 * 60 * 1000
const RENDERER_WRITABLE_SETTING_IDS = new Set([
  'css.bgColor',
  'css.popupOpacity',
  'css.bgBlur',
  'css.windowOpacity',
  'css.fontSizeBase',
  'css.textColor',
  'wallpaper.blurRadius',
  'listFilter'
])

// 修改展示名称时保留 Electron 已确定的 userData 路径，避免品牌名影响数据库位置。
const userDataPath = app.getPath('userData')
app.setName(APP_NAME)
app.setPath('userData', userDataPath)
if (process.platform === 'win32') {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
  const protocolArgs = process.defaultApp && process.argv[1] ? [resolve(process.argv[1])] : []
  app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, protocolArgs)
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

/** 主窗口实例引用 */
let mainWindow = null
let screenshotWindow = null

/** 系统托盘实例 */
let tray = null

/** 是否正在执行退出流程（托盘菜单「退出」触发） */
let isQuitting = false
let suppressInitialWindowShow = false

/** 处理 Windows 富通知通过自定义协议回传的操作。 */
function handleNotificationProtocol(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== `${APP_PROTOCOL}:` || url.hostname !== 'notification') return false

    const noteId = Number(url.searchParams.get('id'))
    if (!Number.isInteger(noteId) || noteId <= 0) return true

    if (url.pathname === '/snooze') {
      if (!mainWindow) suppressInitialWindowShow = true
      const result = snoozeNote(noteId, SNOOZE_DELAY_MS)
      if (result) {
        console.log(`[notification] 便签 #${noteId} 已延后 10 分钟提醒`)
      } else {
        console.log(`[notification] 便签 #${noteId} 已非进行中，忽略延后提醒`)
      }
      return true
    }

    if (url.pathname === '/open') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
      }
      return true
    }
  } catch (error) {
    console.error('[notification] 无法解析通知操作:', error.message)
  }
  return false
}

function handleProtocolArgs(argv) {
  const protocolUrl = argv.find((arg) => arg.startsWith(`${APP_PROTOCOL}://`))
  return protocolUrl ? handleNotificationProtocol(protocolUrl) : false
}

if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    if (handleProtocolArgs(argv)) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

/** 窗口置顶状态 */
let alwaysOnTop = DEFAULT_SETTINGS.window.alwaysOnTop

/** 窗口锁定状态（禁止移动和缩放） */
let isLocked = DEFAULT_SETTINGS.window.lockState

/** 系统模糊能力信息（启动时检测） */
const blurCaps = detectCapabilities()

/** 系统模糊是否已初始化 */
let blurInitialized = false
let blurInitializationError = null
let blurInitializationNativeError = null
let blurRuntimeFailed = false
let blurWindowSyncListenersAttached = false
let blurRuntimeFailureHandling = false
let blurConfigRequestRevision = 0
let wallpaperActivationRevision = 0
let blurDiagnostic = {
  status: blurCaps.supported ? 'pending' : 'unsupported',
  lastCheckedAt: null,
  message: blurCaps.supported
    ? '等待调度器执行首次诊断'
    : blurCaps.reason || '当前平台不支持系统毛玻璃'
}

/** 当前模糊配置（由完整设置快照派生） */
const blurConfig = {
  ...DEFAULT_SETTINGS.blur
}

/** DB 值覆盖共享默认值后的完整运行时设置快照。 */
let resolvedSettings = createDefaultSettings()
let settingsRevision = 0

/** 防抖定时器，用于延迟保存窗口位置/尺寸 */
let geometryTimer = null

/** 窗口几何是否在最近一次成功持久化（或恢复默认）后发生过变化 */
let geometryDirty = false

/** 恢复默认时忽略程序化缩放触发的 resize，避免把默认边界重新写回设置表。 */
let suppressGeometryPersistenceUntil = 0

/** 统一调度器实例 */
const scheduler = new Scheduler()

function openSafeExternal(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    shell
      .openExternal(url.toString())
      .catch((error) => console.warn('[navigation] 打开外部链接失败:', error.message))
    return true
  } catch {
    return false
  }
}

function syncBlurConfigFromResolved() {
  const next = resolvedSettings.blur
  blurConfig.enabled = next.enabled
  blurConfig.radius = next.radius
  blurConfig.saturation = next.saturation
  blurConfig.cornerRadius = next.cornerRadius
}

/** 从 DB 重新生成完整设置；读取本身不向 DB 回写默认值。 */
function refreshResolvedSettings({ incrementRevision = false } = {}) {
  const nextSettings = resolveSettingsRows(getAllSettings(WINDOW_NAME))
  const changed = JSON.stringify(nextSettings) !== JSON.stringify(resolvedSettings)
  resolvedSettings = nextSettings
  syncBlurConfigFromResolved()
  const revisionChanged = incrementRevision || changed
  if (revisionChanged) settingsRevision += 1
  return revisionChanged
}

/**
 * 将旧版“出厂外观值”平滑升级为当前 Apple 风格默认值。
 *
 * app_settings 只保存用户实际改动，缺失值本来就会由 schema 回退；这里仅迁移
 * 明确仍等于旧默认值的记录，绝不覆盖用户已选定的字号或文字颜色。
 */
function migrateAppearanceDefaults() {
  const rows = getAllSettings(WINDOW_NAME)
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const entries = []
  const fontSizeRow = byKey.get('font_size_base')
  const textColorRow = byKey.get('text_color')

  if (Number(fontSizeRow?.value) === 18) {
    entries.push(serializeSetting('css.fontSizeBase', DEFAULT_SETTINGS.css.fontSizeBase))
  }
  if (
    String(textColorRow?.value || '')
      .trim()
      .toLowerCase() === '#000000'
  ) {
    entries.push(serializeSetting('css.textColor', DEFAULT_SETTINGS.css.textColor))
  }

  if (entries.length > 0) setSettingsBatch(WINDOW_NAME, entries)
}

function readAutoStartRuntime() {
  try {
    return { value: Boolean(app.getLoginItemSettings().openAtLogin), error: null }
  } catch (error) {
    return { value: false, error: error.message }
  }
}

function getResolvedSettingsSnapshot() {
  const autoStart = readAutoStartRuntime()
  const blurRuntimeError =
    blurRuntimeFailed || (blurConfig.enabled && blurCaps.supported && !blurInitialized)
      ? blurInitializationError || '系统模糊引擎未加载（DLL 缺失或版本不兼容）'
      : null

  return {
    revision: settingsRevision,
    values: {
      ...structuredClone(resolvedSettings),
      system: { autoStart: autoStart.value }
    },
    runtime: {
      autoStart,
      blur: {
        supported: blurCaps.supported,
        platform: blurCaps.platform,
        strategy: blurCaps.strategy,
        initialized: blurInitialized,
        effectiveEnabled: Boolean(blurCaps.supported && blurInitialized && blurConfig.enabled),
        error: blurRuntimeError,
        nativeError: blurRuntimeError ? blurInitializationNativeError : null,
        diagnostic: { ...blurDiagnostic }
      }
    }
  }
}

/** 初始化或重试初始化系统模糊，并保留可传给 renderer 的结构化错误。 */
function initializeBlurRuntime() {
  if (blurInitialized) return { success: true, strategy: blurCaps.strategy }
  if (!blurCaps.supported || !mainWindow || mainWindow.isDestroyed()) {
    const error = blurCaps.reason || '主窗口尚未就绪'
    blurInitializationError = error
    blurInitializationNativeError = null
    return { success: false, error, nativeError: null }
  }

  try {
    const result = blurInit(mainWindow)
    if (!result.success) {
      blurRuntimeFailed = true
      blurInitializationError = result.error
      blurInitializationNativeError = result.nativeError ?? null
      updateBlurDiagnostic(
        { status: 'error', lastCheckedAt: Date.now(), message: result.error },
        { notify: false }
      )
      return result
    }

    blurInitialized = true
    blurRuntimeFailed = false
    blurInitializationError = null
    blurInitializationNativeError = null
    if (process.platform === 'win32') blurSetConfig(blurConfig)
    if (process.platform === 'darwin' && !blurConfig.enabled) mainWindow.setVibrancy(null)
    updateBlurDiagnostic(
      {
        status: blurConfig.enabled ? 'pending' : 'disabled',
        lastCheckedAt: null,
        message: blurConfig.enabled ? '等待调度器执行诊断' : '系统毛玻璃未启用'
      },
      { notify: false }
    )
    attachBlurWindowSyncListeners()
    return result
  } catch (error) {
    // blurInit 成功而首次配置失败时也必须完整回滚，否则 JS、bridge 和
    // native 三层会处于互相矛盾的初始化状态，后续重试还会被短路。
    try {
      blurDestroy()
    } catch (destroyError) {
      console.error('[blur] 初始化回滚时销毁原生资源失败:', destroyError)
    }
    blurInitialized = false
    blurRuntimeFailed = true
    blurInitializationError = error.message
    blurInitializationNativeError = {
      code: null,
      key: 'electron_initialization_exception',
      message: error.message
    }
    updateBlurDiagnostic(
      { status: 'error', lastCheckedAt: Date.now(), message: error.message },
      { notify: false }
    )
    return {
      success: false,
      error: error.message,
      nativeError: blurInitializationNativeError
    }
  }
}

function broadcastSettingsChanged(snapshot = getResolvedSettingsSnapshot()) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:changed', snapshot)
  }
}

function broadcastBlurDiagnosticChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('blur:diagnostic-changed', { ...blurDiagnostic })
  }
}

function updateBlurDiagnostic(next, { notify = true } = {}) {
  blurDiagnostic = { ...blurDiagnostic, ...next }
  if (notify) broadcastBlurDiagnosticChanged()
}

/**
 * 原生层在初始化后失效时统一执行真实降级：销毁可能残留的 Overlay、关闭并
 * 持久化开关，再把错误状态广播给 renderer。这样设置值不会继续声称已启用。
 */
function handleBlurRuntimeFailure(error, { broadcast = true } = {}) {
  if (blurRuntimeFailureHandling) return
  blurRuntimeFailureHandling = true

  try {
    const nativeError = error?.nativeError ?? null
    const detail = nativeError?.message || error?.message || '原生模糊运行期失效'
    blurInitializationError = `系统毛玻璃运行中断：${detail}`
    blurInitializationNativeError = nativeError
    blurRuntimeFailed = true
    updateBlurDiagnostic(
      {
        status: 'error',
        lastCheckedAt: Date.now(),
        message: blurInitializationError
      },
      { notify: broadcast }
    )

    try {
      blurDestroy()
    } catch (destroyError) {
      console.error('[blur] 运行期失效后销毁原生资源失败:', destroyError)
    }
    blurInitialized = false

    if (blurConfig.enabled) {
      setSettingsBatch(WINDOW_NAME, [serializeSetting('blur.enabled', false)])
      refreshResolvedSettings({ incrementRevision: true })
    } else {
      blurConfig.enabled = false
    }

    console.error('[blur] 已检测到运行期失效并切换到透明背景回退:', detail, nativeError || '')
    if (broadcast) broadcastSettingsChanged()
  } finally {
    blurRuntimeFailureHandling = false
  }
}

/** 由统一调度器执行的毛玻璃诊断任务；不再创建独立计时器。 */
function runBlurRuntimeDiagnostic(context = {}) {
  const checkedAt = context.now || Date.now()

  if (!blurCaps.supported) {
    updateBlurDiagnostic({
      status: 'unsupported',
      lastCheckedAt: checkedAt,
      message: blurCaps.reason || '当前平台不支持系统毛玻璃'
    })
    return
  }

  if (blurRuntimeFailed) {
    updateBlurDiagnostic({
      status: 'error',
      lastCheckedAt: checkedAt,
      message: blurInitializationError || '系统毛玻璃初始化或运行失败'
    })
    return
  }

  if (!blurConfig.enabled) {
    updateBlurDiagnostic({
      status: 'disabled',
      lastCheckedAt: checkedAt,
      message: '系统毛玻璃未启用'
    })
    return
  }

  if (!blurInitialized) {
    updateBlurDiagnostic({
      status: 'pending',
      lastCheckedAt: checkedAt,
      message: '系统毛玻璃尚未完成初始化'
    })
    return
  }

  if (process.platform === 'win32') {
    try {
      const health = getBlurRuntimeHealth()
      if (!health.healthy) {
        const error = new Error(health.nativeError?.message || '原生模糊运行期失效')
        error.nativeError = health.nativeError
        handleBlurRuntimeFailure(error, { broadcast: false })
        updateBlurDiagnostic({
          status: 'error',
          lastCheckedAt: checkedAt,
          message: blurInitializationError
        })
        broadcastSettingsChanged()
        return
      }
    } catch (error) {
      handleBlurRuntimeFailure(error, { broadcast: false })
      updateBlurDiagnostic({
        status: 'error',
        lastCheckedAt: checkedAt,
        message: blurInitializationError
      })
      broadcastSettingsChanged()
      return
    }
  }

  updateBlurDiagnostic({
    status: 'healthy',
    lastCheckedAt: checkedAt,
    message: '系统毛玻璃运行正常'
  })
}

function runBlurRuntimeOperation(operation, label) {
  if (process.platform !== 'win32' || !blurInitialized) return false
  try {
    operation()
    return true
  } catch (error) {
    const wrapped = new Error(`${label}失败：${error?.message || '原生接口调用异常'}`)
    wrapped.nativeError = error?.nativeError ?? null
    handleBlurRuntimeFailure(wrapped)
    return false
  }
}

/**
 * 监听只绑定一次，但初始化成功时都调用本函数。这样启动失败后由用户重试成功，
 * 也会补齐移动、缩放和置顶层同步，不再依赖创建窗口瞬间的初始化结果。
 */
function attachBlurWindowSyncListeners() {
  if (
    process.platform !== 'win32' ||
    !blurInitialized ||
    blurWindowSyncListenersAttached ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return
  }

  blurWindowSyncListenersAttached = true
  mainWindow.on('resize', () => {
    runBlurRuntimeOperation(blurUpdateGeometry, '同步毛玻璃窗口尺寸')
  })
  mainWindow.on('move', () => {
    runBlurRuntimeOperation(blurUpdateGeometry, '同步毛玻璃窗口位置')
  })
  mainWindow.on('always-on-top-changed', () => {
    runBlurRuntimeOperation(blurReSyncZOrder, '同步毛玻璃窗口层级')
  })
}

function applyResolvedBlurRuntime() {
  if (blurInitialized && process.platform === 'win32') {
    runBlurRuntimeOperation(() => blurSetConfig(blurConfig), '更新毛玻璃配置')
  }
  if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setVibrancy(blurConfig.enabled ? 'under-window' : null)
    } catch (error) {
      handleBlurRuntimeFailure(error, { broadcast: false })
    }
  }
}

function applyResolvedWindowRuntime() {
  isLocked = resolvedSettings.window.lockState
  alwaysOnTop = resolvedSettings.window.alwaysOnTop
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setMovable(!isLocked)
  mainWindow.setResizable(!isLocked)
  applyAlwaysOnTop()
}

/**
 * 通过共享 schema 持久化逻辑设置 ID；renderer 不再接触 type/key/raw value。
 * 返回广播出去的同一份完整快照。
 */
function persistSettingValues(entries, { applyBlurRuntime = true } = {}) {
  const normalizedEntries = entries.map(({ id, value }) => ({ id, ...serializeSetting(id, value) }))
  setSettingsBatch(WINDOW_NAME, normalizedEntries)
  refreshResolvedSettings({ incrementRevision: true })

  if (normalizedEntries.some(({ id }) => id.startsWith('window.'))) {
    applyResolvedWindowRuntime()
  }
  if (applyBlurRuntime && normalizedEntries.some(({ id }) => id.startsWith('blur.'))) {
    applyResolvedBlurRuntime()
  }

  const snapshot = getResolvedSettingsSnapshot()
  broadcastSettingsChanged(snapshot)
  return snapshot
}

function persistSettingValue(id, value) {
  return persistSettingValues([{ id, value }])
}

/** 壁纸与原生毛玻璃共享同一个主窗口背景槽，任何时刻最多启用一个。 */
function persistWallpaperState({ enabled, activeId = resolvedSettings.wallpaper.activeId }) {
  return persistSettingValues([
    { id: 'wallpaper.enabled', value: Boolean(enabled) },
    { id: 'wallpaper.activeId', value: activeId }
  ])
}

function deactivateWallpaperForGlass({ broadcast = true } = {}) {
  if (!resolvedSettings.wallpaper.enabled) return null
  setSettingsBatch(WINDOW_NAME, [serializeSetting('wallpaper.enabled', false)])
  refreshResolvedSettings({ incrementRevision: true })
  const snapshot = getResolvedSettingsSnapshot()
  if (broadcast) broadcastSettingsChanged(snapshot)
  return {
    activeId: resolvedSettings.wallpaper.activeId,
    wasEnabled: true
  }
}

function restoreSuspendedWallpaper(suspended) {
  if (!suspended?.wasEnabled || !suspended.activeId) return getResolvedSettingsSnapshot()
  return persistWallpaperState({ enabled: true, activeId: suspended.activeId })
}

// ============================================================
// 贴边隐藏模块
// ============================================================
const SNAP_THRESHOLD = 20 // 贴边吸附阈值（px）
const TRIGGER_WIDTH = 2 // 边缘触发窗口宽度（px）
const SLIDE_DURATION = 200 // 滑动动画总时长（ms）
const SLIDE_INTERVAL = 16 // 滑动动画帧间隔（ms）≈60fps
const HIDE_DELAY = 200 // 鼠标离开后延迟隐藏（ms）

/** 默认窗口尺寸比例（相对屏幕工作区），改一个地方即可全局生效 */
const DEFAULT_WIDTH_RATIO = DEFAULT_SETTINGS.geometry.widthRatio
const DEFAULT_HEIGHT_RATIO = DEFAULT_SETTINGS.geometry.heightRatio

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
  blurWindowSyncListenersAttached = false
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

  // 完整快照已经统一完成“数据库值优先、缺失/非法时回退默认”的解析。
  const geometry = resolvedSettings.geometry
  const hasSavedGeometry =
    [geometry.posX, geometry.posY, geometry.width, geometry.height].every(Number.isFinite) &&
    geometry.width > 0 &&
    geometry.height > 0
  const saved = hasSavedGeometry
    ? {
        x: geometry.posX,
        y: geometry.posY,
        width: geometry.width,
        height: geometry.height
      }
    : null
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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 固定缩放因子为 1.0，防止系统 DPI 缩放影响布局
  mainWindow.webContents.setZoomFactor(1.0)

  // 从完整设置快照恢复锁定状态
  isLocked = resolvedSettings.window.lockState
  if (isLocked) {
    mainWindow.setMovable(false)
    mainWindow.setResizable(false)
  }

  // ---- 初始化系统模糊 ----
  if (blurCaps.supported) {
    const result = initializeBlurRuntime()
    if (result.success) {
      console.log('[blur] 系统模糊已初始化, 策略:', result.strategy)
      // 历史版本可能同时留下两项启用状态；启动时以已实际生效的原生玻璃为准。
      if (blurConfig.enabled && resolvedSettings.wallpaper.enabled) {
        setSettingsBatch(WINDOW_NAME, [serializeSetting('wallpaper.enabled', false)])
        refreshResolvedSettings({ incrementRevision: true })
      }
    } else {
      console.warn('[blur] 初始化失败:', result.error, result.nativeError || '')
      // 启动失败不能继续保存“已开启”，否则下次打开设置会造成状态误导。
      if (blurConfig.enabled) {
        setSettingsBatch(WINDOW_NAME, [serializeSetting('blur.enabled', false)])
        refreshResolvedSettings({ incrementRevision: true })
      }
    }
  } else {
    console.log('[blur] 当前平台不支持系统模糊:', blurCaps.reason)
  }

  // 拦截新窗口打开请求，改为使用系统默认浏览器打开链接
  mainWindow.webContents.setWindowOpenHandler((details) => {
    openSafeExternal(details.url)
    return { action: 'deny' } // 拒绝在应用内打开新窗口
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openSafeExternal(url)
  })

  /**
   * 防抖保存窗口几何信息
   * 窗口 resize/move 事件触发频繁，使用 500ms 防抖避免频繁写数据库
   */
  const debouncedSaveGeometry = () => {
    if (Date.now() < suppressGeometryPersistenceUntil) return
    geometryDirty = true
    if (geometryTimer) clearTimeout(geometryTimer)
    geometryTimer = setTimeout(() => {
      geometryTimer = null
      if (mainWindow && !mainWindow.isDestroyed()) {
        const b = mainWindow.getBounds()
        try {
          persistSettingValues([
            { id: 'geometry.posX', value: b.x },
            { id: 'geometry.posY', value: b.y },
            { id: 'geometry.width', value: b.width },
            { id: 'geometry.height', value: b.height }
          ])
          geometryDirty = false
        } catch (error) {
          console.warn('[settings] 保存窗口位置失败:', error.message)
        }
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
      hideToTray()
    }
  })

  // 窗口显示时恢复模糊（从托盘恢复）
  mainWindow.on('show', () => {
    if (!blurConfig.enabled) return

    // 隐藏阶段若因原生异常销毁过 Overlay，恢复窗口时重新初始化。
    if (!blurInitialized) {
      const result = initializeBlurRuntime()
      if (!result.success) {
        broadcastSettingsChanged()
        return
      }
    } else {
      if (!runBlurRuntimeOperation(() => blurSetConfig(blurConfig), '恢复毛玻璃配置')) return
    }
    runBlurRuntimeOperation(blurReSyncZOrder, '恢复毛玻璃窗口层级')
  })

  // 窗口销毁时清除引用和贴边资源
  mainWindow.on('closed', () => {
    mainWindow = null
    blurWindowSyncListenersAttached = false
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

  // Blur_ApplyConfig 要求完整的四项配置，不能只传 { enabled: false }。
  // 先隐藏 Overlay 再隐藏 Electron，避免异常中断后留下孤立模糊窗口。
  if (blurInitialized) {
    runBlurRuntimeOperation(
      () => blurSetConfig({ ...blurConfig, enabled: false }),
      '隐藏窗口前关闭毛玻璃层'
    )
  }

  mainWindow.hide()
  resetDockState()
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
      preload: join(__dirname, '../preload/trigger.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
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
  runBlurRuntimeOperation(blurReSyncZOrder, '同步毛玻璃窗口层级')

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
app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return

  // 初始化数据库连接
  initDatabase()
  try {
    await Promise.all([cleanupPendingAttachmentDirs(), cleanupPendingWallpaperFiles()])
  } catch (error) {
    console.warn('[storage] 清理历史暂存目录失败:', error.message)
  }
  // 开机自启以操作系统为唯一权威；移除旧版本遗留的数据库副本。
  deleteSettingsByKey('auto_start')
  // 清理已退出产品设置模型的历史键，避免不可见状态继续影响画面。
  for (const key of [
    'blur_opacity',
    'blur_tint_r',
    'blur_tint_g',
    'blur_tint_b',
    'bg_saturation',
    'bg_border',
    'wallpaper_overlay_opacity',
    'wallpaper_overlay_tone'
  ]) {
    deleteSettingsByKey(key)
  }
  migrateAppearanceDefaults()
  refreshResolvedSettings({ incrementRevision: true })
  handleProtocolArgs(process.argv)

  // 监听新窗口创建事件，自动注册快捷键优化器
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ---- IPC 通道注册 ----

  // 【渲染就绪】渲染进程初始化完成后发送此消息，主进程收到后显示窗口
  ipcMain.on('renderer-ready', (event) => {
    if (event.sender !== mainWindow?.webContents) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (suppressInitialWindowShow) {
        suppressInitialWindowShow = false
      } else {
        mainWindow.show()
      }
    }
  })

  // 【窗口控制 - 关闭】渲染进程请求关闭窗口 → 最小化到托盘
  ipcMain.on('window-close', (event) => {
    if (event.sender !== mainWindow?.webContents) return
    hideToTray()
  })

  // 【窗口锁定 - 切换锁定状态】
  ipcMain.handle('toggle-lock', () => {
    const snapshot = persistSettingValue('window.lockState', !isLocked)
    return snapshot.values.window.lockState
  })

  // 【窗口置顶 - 切换】
  ipcMain.handle('toggle-always-on-top', () => {
    const snapshot = persistSettingValue('window.alwaysOnTop', !alwaysOnTop)
    return snapshot.values.window.alwaysOnTop
  })

  // 【缩放手柄 - 获取边界】返回当前窗口的位置和尺寸
  ipcMain.handle('window-get-bounds', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? win.getBounds() : null
  })

  // 【缩放手柄 - 设置边界】根据渲染进程传入的 bounds 调整窗口大小/位置
  ipcMain.on('window-set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const values = bounds && [bounds.x, bounds.y, bounds.width, bounds.height].map(Number)
    if (
      win &&
      win === mainWindow &&
      values?.every(Number.isFinite) &&
      values[2] >= 240 &&
      values[3] >= 240 &&
      values[2] <= 16_384 &&
      values[3] <= 16_384
    ) {
      // Math.round 确保像素值为整数，避免亚像素渲染问题
      win.setBounds({
        x: Math.round(values[0]),
        y: Math.round(values[1]),
        width: Math.round(values[2]),
        height: Math.round(values[3])
      })
    }
  })

  // ---- 设置 IPC ----
  // renderer 只提交 schema ID，数据库 type/key、校验、序列化均由共享 schema 决定。
  ipcMain.handle('set-setting-value', (_event, id, value) => {
    if (!RENDERER_WRITABLE_SETTING_IDS.has(id))
      throw new Error(`renderer 无权直接写入设置项: ${id}`)
    persistSettingValue(id, value)
    return true
  })

  /** 获取 DB 值覆盖共享默认值后的完整设置快照。 */
  ipcMain.handle('get-settings-snapshot', () => {
    // 每次查询都重新读取 SQLite，避免设置页拿到陈旧的主进程内存副本。
    const changed = refreshResolvedSettings()
    if (changed) {
      applyResolvedWindowRuntime()
      applyResolvedBlurRuntime()
    }
    const snapshot = getResolvedSettingsSnapshot()
    if (changed) broadcastSettingsChanged(snapshot)
    return snapshot
  })

  /**
   * 恢复全部持久化设置默认值。
   * 仅清空 app_settings，不触碰便签、标签、模板、附件或开机自启 OS 状态。
   * 当前窗口立即恢复默认宽高并保留当前位置，同时清除下次启动时的几何记录。
   */
  ipcMain.handle('reset-settings', () => {
    if (geometryTimer) {
      clearTimeout(geometryTimer)
      geometryTimer = null
    }
    // 清表后若窗口没有再次移动/缩放，退出时不能把旧边界重新写回。
    geometryDirty = false
    clearAllSettings()
    refreshResolvedSettings({ incrementRevision: true })
    applyResolvedWindowRuntime()
    applyResolvedBlurRuntime()

    // 宽高立即恢复为当前显示器工作区的默认比例；位置仍保持当前值。
    if (mainWindow && !mainWindow.isDestroyed()) {
      const display = screen.getDisplayMatching(mainWindow.getBounds())
      const defaultWidth = Math.round(display.workAreaSize.width * DEFAULT_WIDTH_RATIO)
      const defaultHeight = Math.round(display.workAreaSize.height * DEFAULT_HEIGHT_RATIO)
      suppressGeometryPersistenceUntil = Date.now() + 750
      mainWindow.setSize(defaultWidth, defaultHeight)
    }

    const snapshot = getResolvedSettingsSnapshot()
    broadcastSettingsChanged(snapshot)
    return snapshot
  })

  // ---- 贴边隐藏 IPC ----

  // 【贴边隐藏 - 鼠标悬停】渲染进程报告鼠标进入/离开主窗口
  ipcMain.on('window-hover', (event, isHovering) => {
    if (event.sender !== mainWindow?.webContents) return
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
  ipcMain.on('trigger-enter', (event) => {
    if (event.sender !== triggerWin?.webContents) return
    if (isDockHidden) doShow()
  })

  // ---- 系统模糊 IPC ----

  /** 设置模糊配置（立即生效 + 持久化到数据库） */
  ipcMain.handle('set-blur-config', async (_event, config) => {
    const requestRevision = ++blurConfigRequestRevision
    const activationRevision = wallpaperActivationRevision
    // 本次请求必须持有独立快照。关闭壁纸会从 DB 刷新完整设置，而 DB 中的
    // blur.enabled 此时还是旧值，不能让它覆盖用户刚刚提交的启用请求。
    const requestedConfig = {
      enabled: config.enabled !== undefined ? Boolean(config.enabled) : blurConfig.enabled,
      radius: config.radius !== undefined ? config.radius : blurConfig.radius,
      saturation: config.saturation !== undefined ? config.saturation : blurConfig.saturation,
      cornerRadius:
        config.cornerRadius !== undefined ? config.cornerRadius : blurConfig.cornerRadius
    }
    Object.assign(blurConfig, requestedConfig)

    // 启用时若启动阶段初始化失败，则现场重试一次，以便把详细错误反馈给用户。
    const enableRequested = blurConfig.enabled
    // 先让壁纸退场，再创建/启用原生层；失败时恢复刚才挂起的壁纸。
    const suspendedWallpaper = enableRequested ? deactivateWallpaperForGlass() : null
    if (suspendedWallpaper) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 190))
      if (requestRevision !== blurConfigRequestRevision) {
        const supersededByWallpaper = activationRevision !== wallpaperActivationRevision
        const snapshot =
          !supersededByWallpaper && !blurConfig.enabled && suspendedWallpaper
            ? restoreSuspendedWallpaper(suspendedWallpaper)
            : getResolvedSettingsSnapshot()
        return {
          success: snapshot.runtime.blur.effectiveEnabled,
          config: { ...blurConfig },
          runtime: snapshot.runtime.blur,
          error: snapshot.runtime.blur.error,
          nativeError: snapshot.runtime.blur.nativeError
        }
      }
      // deactivateWallpaperForGlass() 内部的完整设置刷新会恢复数据库旧值；
      // 退场完成且请求仍为最新时，重新提交本次请求自己的快照。
      Object.assign(blurConfig, requestedConfig)
    }
    if (!enableRequested) {
      blurRuntimeFailed = false
      blurInitializationError = null
      blurInitializationNativeError = null
      updateBlurDiagnostic(
        { status: 'disabled', lastCheckedAt: Date.now(), message: '系统毛玻璃未启用' },
        { notify: false }
      )
    }
    const initializationResult =
      enableRequested && blurCaps.supported && !blurInitialized ? initializeBlurRuntime() : null

    // 初始化失败时不能让持久化值继续显示为“已启用”，否则设置值会与实际效果不一致。
    if (enableRequested && initializationResult && !initializationResult.success) {
      blurConfig.enabled = false
    }

    let snapshot = persistSettingValues(
      [
        { id: 'blur.enabled', value: blurConfig.enabled },
        { id: 'blur.radius', value: blurConfig.radius },
        { id: 'blur.saturation', value: blurConfig.saturation },
        { id: 'blur.cornerRadius', value: blurConfig.cornerRadius }
      ],
      // 新初始化路径已经在 initializeBlurRuntime 中提交过完整配置。
      { applyBlurRuntime: !initializationResult?.success }
    )
    let runtime = snapshot.runtime.blur
    if (enableRequested && !runtime.effectiveEnabled && suspendedWallpaper) {
      snapshot = restoreSuspendedWallpaper(suspendedWallpaper)
      runtime = snapshot.runtime.blur
    }
    return {
      success: !enableRequested || runtime.effectiveEnabled,
      config: { ...blurConfig },
      runtime,
      error: initializationResult?.error ?? runtime.error,
      nativeError: initializationResult?.nativeError ?? runtime.nativeError
    }
  })

  // ---- 主页面壁纸 IPC ----
  ipcMain.handle('wallpapers:list', () => listWallpaperRecords())
  ipcMain.handle('wallpapers:get-thumbnail', (_event, { id, maxSize }) =>
    getWallpaperThumbnail(id, maxSize)
  )
  ipcMain.handle('wallpapers:get-data', (_event, { id, original = false }) =>
    getWallpaperDataUrl(id, { original })
  )
  ipcMain.handle('wallpapers:save', (_event, payload) => saveWallpaperVersion(payload || {}))
  ipcMain.handle('wallpapers:activate', (_event, { id }) => {
    const record = markWallpaperUsed(id)
    const previousFailureState = {
      failed: blurRuntimeFailed,
      error: blurInitializationError,
      nativeError: blurInitializationNativeError,
      diagnostic: { ...blurDiagnostic }
    }
    const previousBlurRequestRevision = blurConfigRequestRevision
    const previousWallpaperActivationRevision = wallpaperActivationRevision

    // 三个互斥设置在同一个 SQLite 事务中提交，不能先关玻璃再单独开壁纸。
    // 同时使任何尚在等待壁纸退场的旧毛玻璃请求失效。
    wallpaperActivationRevision += 1
    blurConfigRequestRevision += 1
    blurRuntimeFailed = false
    blurInitializationError = null
    blurInitializationNativeError = null
    updateBlurDiagnostic(
      { status: 'disabled', lastCheckedAt: Date.now(), message: '系统毛玻璃未启用' },
      { notify: false }
    )
    try {
      const snapshot = persistSettingValues([
        { id: 'blur.enabled', value: false },
        { id: 'wallpaper.enabled', value: true },
        { id: 'wallpaper.activeId', value: record.id }
      ])
      return { record, snapshot }
    } catch (error) {
      blurRuntimeFailed = previousFailureState.failed
      blurInitializationError = previousFailureState.error
      blurInitializationNativeError = previousFailureState.nativeError
      blurDiagnostic = previousFailureState.diagnostic
      blurConfigRequestRevision = previousBlurRequestRevision
      wallpaperActivationRevision = previousWallpaperActivationRevision
      throw error
    }
  })
  ipcMain.handle('wallpapers:disable', () => persistWallpaperState({ enabled: false }))
  ipcMain.handle('wallpapers:delete', async (_event, { id }) => {
    const parsedId = Number(id)
    if (resolvedSettings.wallpaper.enabled && resolvedSettings.wallpaper.activeId === parsedId) {
      throw new Error('请先切换或关闭当前壁纸')
    }
    const clearsSelection = resolvedSettings.wallpaper.activeId === parsedId
    const deleted = await deleteWallpaperVersion(parsedId, {
      clearSelectionForWindow: clearsSelection ? WINDOW_NAME : null
    })
    if (deleted && clearsSelection) {
      refreshResolvedSettings({ incrementRevision: true })
      broadcastSettingsChanged()
    }
    return deleted
  })

  createWindow()

  // 初始化完整快照中的窗口运行状态（必须在 createWindow 之后）
  applyResolvedWindowRuntime()
  // ---- 调度器任务注册 ----
  // 职责划分（两层任务，按此顺序执行）：
  //   1. 激活任务：查询 initialized 便签，生效时间到达的 → 转为 in_progress（含通知）
  //   2. 模板生成：查询循环模板，判断是否应当生成新便签实例（含通知）

  /**
   * 发送操作系统原生通知
   * @param {string} body - 通知正文（自动截断至 50 字）
   * @param {Object} [opts]
   * @param {string} [opts.title='便签提醒'] - 通知标题
   * @param {boolean} [opts.silent=false] - 静默（不播放声音）
   */
  function escapeToastXml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;')
  }

  function sendNotify(body, { title = '便签提醒', silent = false, noteId = null } = {}) {
    const summary = String(body || '') || '（空内容）'
    const parsedNoteId = Number(noteId)

    if (process.platform === 'win32' && Number.isInteger(parsedNoteId) && parsedNoteId > 0) {
      const openUrl = `${APP_PROTOCOL}://notification/open?id=${parsedNoteId}`
      const snoozeUrl = `${APP_PROTOCOL}://notification/snooze?id=${parsedNoteId}`
      const toastXml = `<toast launch="${openUrl}" activationType="protocol">
        <visual>
          <binding template="ToastGeneric">
            <text>${escapeToastXml(title)}</text>
            <text>${escapeToastXml(summary)}</text>
          </binding>
        </visual>
        <audio silent="${silent ? 'true' : 'false'}"/>
        <actions>
          <action content="明白" arguments="dismiss" activationType="system"/>
          <action content="稍后提醒（10分钟）" arguments="${snoozeUrl}" activationType="protocol"/>
        </actions>
      </toast>`
      const notification = new Notification({ toastXml })
      notification.on('failed', (_event, error) => {
        console.error('[notification] Windows 富通知发送失败:', error)
      })
      notification.show()
      return
    }

    new Notification({ title, body: summary, silent, icon }).show()
  }

  function trySendNotify(body, options) {
    return sendNotificationSafely(sendNotify, body, options)
  }

  // 3.3 生效便签激活任务（含通知）
  scheduler.register({
    name: 'activationTask',
    shouldRun: () => true,
    execute: () => {
      const result = activateNotes()
      for (const note of result.notified) {
        sendNotify(note.content, { noteId: note.id })
        const preview = (note.content || '').trim().slice(0, 10) || '空内容'
        console.log(`[activation-notify]「${preview}」便签已发送系统通知`)
      }
      if (result.count > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notes:changed', { reason: 'activation' })
      }
    }
  })

  // 3.4 独立延后提醒任务：只领取仍处于进行中的到期便签。
  scheduler.register({
    name: 'snoozedReminderTask',
    shouldRun: () => true,
    execute: () => {
      const due = claimDueSnoozedNotes()
      for (const note of due) {
        sendNotify(note.content, { noteId: note.id })
        console.log(`[snoozed-notify] 便签 #${note.id} 已再次发送系统通知`)
      }
    }
  })

  // 3.5 循环模板生成任务（含通知）
  const templateSchedulerGuard = new TemplateSchedulerGuard({
    failureThreshold: 3,
    retryDelayMs: 5 * 60 * 1000,
    onAlert: (error) => {
      trySendNotify(error?.message || '无法读取或调度循环模板', {
        title: '模板调度服务异常'
      })
    }
  })
  scheduler.register({
    name: 'noteGenerationTask',
    maxFailures: Infinity,
    shouldRun: (context) => templateSchedulerGuard.shouldRun(context.now),
    execute: (context) => {
      const result = templateSchedulerGuard.run(() => runRecurringTemplates(context), context.now)
      for (const note of result.generated) {
        if (trySendNotify(note.content, { title: '模板生成通知' })) {
          const preview = (note.content || '').trim().slice(0, 10) || '空内容'
          console.log(`[generation-notify]「${preview}」已由循环模板生成便签，模板已发送通知`)
        }
      }
      for (const template of result.autoPaused) {
        const preview = (template.content || '').trim().slice(0, 20) || '空内容模板'
        trySendNotify(`模板“${preview}”连续生成失败 3 次：${template.error}`, {
          title: '循环模板已自动暂停'
        })
      }
      const templatesChanged =
        result.count > 0 ||
        result.skipped > 0 ||
        result.errors.length > 0 ||
        result.autoPaused.length > 0
      if (templatesChanged && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('templates:changed', {
          reason: result.autoPaused.length > 0 ? 'auto-pause' : 'scheduler',
          ids: result.autoPaused.map((template) => template.id)
        })
      }
      if (result.count > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notes:changed', { reason: 'recurrence' })
      }
    }
  })

  // 3.6 原生毛玻璃运行诊断：随统一调度器启动即检查，之后每分钟检查一次。
  scheduler.register({
    name: 'blurRuntimeDiagnosticTask',
    maxFailures: Infinity,
    shouldRun: () => true,
    execute: (context) => runBlurRuntimeDiagnostic(context)
  })

  // 启动调度器
  scheduler.start()
  console.log('[scheduler] 调度器已启动')

  // ---- 任务栏 & 托盘事件 ----

  // show：贴边隐藏时滑出（安全网，正常路径下 show 不会在贴边隐藏时触发）
  mainWindow.on('show', () => {
    if (isDockHidden) doShow()
  })

  // 【清空便签数据】仅清理便签、模板、标签和附件，保留 app_settings。
  ipcMain.handle('clear-note-data', async () => {
    await clearNoteData()
    mainWindow?.webContents.send('notes:changed', { reason: 'note-data-cleared' })
    return true
  })

  // ---- 开机自启 ----

  /**
   * 校验开机自启状态
   * 每次打开设置页面时直接读取 OS；不再维护数据库副本。
   * @returns {{ value: boolean, error: string|null }}
   */
  ipcMain.handle('verify-auto-start', () => {
    return readAutoStartRuntime()
  })

  /**
   * 设置开机自启
   * 只更新 OS 注册表/LoginItem，并返回回读后的真实状态。
   */
  ipcMain.handle('set-auto-start', (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
    const actual = readAutoStartRuntime().value
    settingsRevision += 1
    broadcastSettingsChanged()
    return actual
  })

  // ---- 便签便签 CRUD IPC ----

  // 【便签 - 创建】
  ipcMain.handle('notes:create', (_event, options) => {
    return createNote(options || {})
  })

  // 【便签 - 原子创建（含图片 + 标签，事务保护，失败则自动回滚并清理文件）】
  ipcMain.handle('notes:create-with-assets', async (_event, { options, images, tagNames }) => {
    const db = getDb()
    const writtenFiles = []
    const stagedImages = []

    try {
      for (const image of images || []) stagedImages.push(await stageImage(image.base64, image.ext))
    } catch (error) {
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }

    const txn = db.transaction(() => {
      const note = createNote(options || {})
      if (!note || !note.id) throw new Error('创建便签失败')

      // 保存图片
      for (const staged of stagedImages) {
        const { relativePath, fileSize } = commitStagedImage(note.id, staged)
        writtenFiles.push(relativePath)
        addImageRecord({ noteId: note.id, filePath: relativePath, fileSize })
      }

      // 绑定标签（内联 SQL，避免与 setNoteTags 内部事务嵌套冲突）
      if (tagNames && tagNames.length > 0) {
        const delTag = db.prepare('DELETE FROM note_tags WHERE note_id = ?')
        const insTag = db.prepare('INSERT INTO note_tags (note_id, tag_name) VALUES (?, ?)')
        delTag.run(note.id)
        for (const tn of tagNames) {
          insTag.run(note.id, tn)
        }
      }

      return getNoteById(note.id)
    })

    try {
      return txn()
    } catch (e) {
      // 事务回滚后，清理已写入磁盘的图片文件
      await Promise.all(writtenFiles.map(deleteImageFile))
      await Promise.all(stagedImages.map(cleanupStagedImage))
      console.error('[notes:create-with-assets] 创建失败，已回滚并清理文件:', e.message)
      throw e
    }
  })

  // 【便签 - 更新】
  ipcMain.handle('notes:update', (_event, { id, fields }) => {
    return updateNote(id, fields || {})
  })

  // 【便签 - 原子保存编辑草稿（字段 + 标签 + 附件）】
  ipcMain.handle('notes:save-draft', async (_event, payload = {}) => {
    const db = getDb()
    const id = Number(payload.id)
    const fields = payload.fields || {}
    const tagNames = Array.isArray(payload.tagNames)
      ? [...new Set(payload.tagNames.map((name) => String(name).trim()).filter(Boolean))]
      : []
    const addedImages = Array.isArray(payload.addedImages) ? payload.addedImages : []
    const deletedImageIds = [
      ...new Set(
        (Array.isArray(payload.deletedImageIds) ? payload.deletedImageIds : [])
          .map(Number)
          .filter((imageId) => Number.isInteger(imageId) && imageId > 0)
      )
    ]

    if (!Number.isInteger(id) || id <= 0) throw new Error('无效的便签 ID')
    const original = getNoteById(id)
    if (!original) throw new Error('便签不存在或已删除')

    const content = String(fields.content ?? '').trim()
    if (!content) throw new Error('请输入便签内容')

    const requestedStatus = String(fields.status || original.status)
    if (requestedStatus !== original.status) {
      throw new Error(`不允许的状态修改：${original.status} → ${requestedStatus}`)
    }

    const ownedDeletedRows = deletedImageIds.length
      ? db
          .prepare(
            `SELECT id, file_path FROM note_attachments
         WHERE note_id = ? AND id IN (${deletedImageIds.map(() => '?').join(',')})`
          )
          .all(id, ...deletedImageIds)
      : []
    if (ownedDeletedRows.length !== deletedImageIds.length)
      throw new Error('附件不存在或不属于当前便签')

    const resultingCount = original.attachments.length - deletedImageIds.length + addedImages.length
    if (resultingCount > 50) throw new Error('单条便签最多只能保存 50 张图片')

    const stagedImages = []
    const writtenFiles = []
    try {
      for (const image of addedImages) stagedImages.push(await stageImage(image.base64, image.ext))
    } catch (error) {
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }

    const stagedDeletions = []
    try {
      for (const row of ownedDeletedRows) stagedDeletions.push(stageImageDeletion(row.file_path))
    } catch (error) {
      for (const staged of stagedDeletions.reverse()) restoreStagedImageDeletion(staged)
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }

    const txn = db.transaction(() => {
      const current = db.prepare('SELECT * FROM notes WHERE id = ? AND is_deleted = 0').get(id)
      if (!current) throw new Error('便签不存在或已删除')
      if (current.status !== original.status)
        throw new Error('便签状态已发生变化，请重新打开后再修改')

      const timestamp = Date.now()
      let status = current.status
      let effectiveAt = current.effective_at
      let notifyEnabled = current.notify_enabled
      let finishedAt = current.finished_at
      let remindAgainAt = current.remind_again_at

      if (current.status === 'initialized') {
        const requestedEffectiveAt = Number(fields.effectiveAt)
        if (!Number.isFinite(requestedEffectiveAt) || requestedEffectiveAt <= 0) {
          throw new Error('请选择有效的生效时间')
        }
        const effectiveAtChanged =
          Math.floor(requestedEffectiveAt / 1000) !== Math.floor(current.effective_at / 1000)
        if (effectiveAtChanged && requestedEffectiveAt - timestamp < 5 * 60 * 1000) {
          throw new Error('生效时间需在当前时间 5 分钟之后')
        }
        // UI 只显示到秒；未修改时保留数据库原有的毫秒精度。
        effectiveAt = effectiveAtChanged ? requestedEffectiveAt : current.effective_at
        notifyEnabled = fields.notifyEnabled ? 1 : 0
      }

      db.prepare(
        `UPDATE notes SET
           content = ?, status = ?, is_pinned = ?, notify_enabled = ?, effective_at = ?,
           finished_at = ?, remind_again_at = ?, updated_at = ?
         WHERE id = ? AND is_deleted = 0`
      ).run(
        content,
        status,
        fields.isPinned ? 1 : 0,
        notifyEnabled,
        effectiveAt,
        finishedAt,
        remindAgainAt,
        timestamp,
        id
      )

      db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(id)
      const insertTag = db.prepare('INSERT INTO note_tags (note_id, tag_name) VALUES (?, ?)')
      for (const tagName of tagNames) insertTag.run(id, tagName)

      if (deletedImageIds.length) {
        db.prepare(
          `DELETE FROM note_attachments
           WHERE note_id = ? AND id IN (${deletedImageIds.map(() => '?').join(',')})`
        ).run(id, ...deletedImageIds)
      }

      for (const staged of stagedImages) {
        const { relativePath, fileSize } = commitStagedImage(id, staged)
        writtenFiles.push(relativePath)
        addImageRecord({ noteId: id, filePath: relativePath, fileSize })
      }

      return getNoteById(id)
    })

    try {
      const updated = txn()
      await Promise.all(stagedDeletions.map(cleanupStagedImage))
      return updated
    } catch (error) {
      await Promise.all(writtenFiles.map(deleteImageFile))
      await Promise.all(stagedImages.map(cleanupStagedImage))
      for (const staged of stagedDeletions.reverse()) restoreStagedImageDeletion(staged)
      throw error
    }
  })

  // 【便签 - 逻辑删除】
  ipcMain.handle('notes:delete', (_event, { id }) => {
    const deleted = deleteNote(id)
    if (deleted) mainWindow?.webContents.send('notes:changed', { reason: 'deletion', id })
    return deleted
  })

  // 【便签 - 彻底删除】先隔离附件目录，数据库失败时恢复；成功后异步清理文件。
  ipcMain.handle('notes:purge', async (_event, { id }) => {
    const noteId = Number(id)
    if (!Number.isInteger(noteId) || noteId <= 0) throw new Error('无效的便签 ID')
    if (!getDb().prepare('SELECT id FROM notes WHERE id = ?').get(noteId)) return false

    const stagedImages = stageNoteImagesDeletion(noteId)
    try {
      const purged = purgeNote(noteId)
      if (!purged) {
        restoreStagedImageDeletion(stagedImages)
        return false
      }
    } catch (error) {
      restoreStagedImageDeletion(stagedImages)
      throw error
    }

    await cleanupStagedNoteImages(stagedImages)
    mainWindow?.webContents.send('notes:changed', { reason: 'purge', id: noteId })
    return true
  })

  // 【便签 - 获取单条（含附件和标签）】
  ipcMain.handle('notes:get', (_event, { id }) => {
    return getNoteById(id)
  })

  // 【便签 - 列表查询（已废弃，由专用查询替代）】

  // 【便签 - 置顶查询（时间线模式）】
  ipcMain.handle('notes:query-pinned', (_event, options) => {
    return queryPinnedNotes(options || {})
  })

  // 【便签 - 三天内查询（时间线模式）】
  ipcMain.handle('notes:query-recent', (_event, options) => {
    return queryRecentNotes(options || {})
  })

  // 【便签 - 更早查询（时间线模式，分页）】
  ipcMain.handle('notes:query-earlier', (_event, options) => {
    return queryEarlierNotes(options || {})
  })

  // 【便签 - 自定义模式：置顶查询】
  ipcMain.handle('notes:query-custom-pinned', (_event, options) => {
    return queryCustomPinned(options || {})
  })

  // 【便签 - 自定义模式：日常查询（分页）】
  ipcMain.handle('notes:query-custom-normal', (_event, options) => {
    return queryCustomNormal(options || {})
  })

  // 【便签 - 独立搜索工作区】
  ipcMain.handle('notes:search', (_event, options) => {
    return searchNotes(options || {})
  })

  // 【便签 - 未删除总数（不受列表筛选影响）】
  ipcMain.handle('notes:count-active', () => {
    return countActiveNotes()
  })

  // 【便签 - 自定义模式：全局重排 sort_order】
  ipcMain.handle('notes:reorder-custom', () => {
    return reorderCustomSortOrder()
  })

  ipcMain.handle('notes:update-custom-order', (_event, { items }) => {
    return updateCustomSortOrders(items)
  })

  // 【便签 - 开始处理】
  ipcMain.handle('notes:start-progress', (_event, { id }) => {
    return startProgress(id)
  })

  // 【便签 - 完成】
  ipcMain.handle('notes:complete', (_event, { id }) => {
    return completeNote(id)
  })

  // 【便签 - 重新进行】
  ipcMain.handle('notes:reopen', (_event, { id }) => {
    return reopenNote(id)
  })

  // ---- 标签 CRUD IPC ----

  // 【标签 - 创建】
  ipcMain.handle('tags:create', (_event, { name, color }) => {
    return createTag(name, color)
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

  // 【标签 - 删除影响统计】包含逻辑删除但尚未彻底删除的便签和模板关联。
  ipcMain.handle('tags:usage', (_event, { name }) => {
    return getTagUsage(name)
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

  // 【模板 - 列表】state: active | running | paused | deleted | all
  ipcMain.handle('templates:list', (_event, options) => {
    return listTemplates(options || {})
  })

  // 【模板 - 获取单条】
  ipcMain.handle('templates:get', (_event, { id, includeDeleted }) => {
    return getTemplateById(id, { includeDeleted: !!includeDeleted })
  })

  // 【模板 - 暂停】
  ipcMain.handle('templates:pause', (_event, { id }) => {
    return pauseTemplate(id)
  })

  // 【模板 - 恢复】
  ipcMain.handle('templates:resume', (_event, { id }) => {
    return resumeTemplate(id)
  })

  // 【模板 - 从已删除恢复并默认运行】
  ipcMain.handle('templates:restore', (_event, { id }) => {
    return restoreTemplate(id)
  })

  // 【模板 - 彻底删除】仅允许删除已进入回收区的模板。
  ipcMain.handle('templates:purge', (_event, { id }) => {
    return purgeTemplate(id)
  })

  // 【模板 - 下一次生成时间预览】与调度器共用同一套日历算法。
  ipcMain.handle(
    'templates:preview-next-run',
    (_event, { recurrenceRule, afterTimestamp } = {}) => {
      const after = Number.isFinite(Number(afterTimestamp)) ? Number(afterTimestamp) : Date.now()
      const rule = normalizeRecurrenceRule(recurrenceRule)
      return calculateNextRun(rule, after, after)
    }
  )

  // ---- 图片附件 IPC ----

  /** 批量保存图片（Base64 数组 → 磁盘 + DB） */
  ipcMain.handle('images:save-batch', async (_event, { noteId, images }) => {
    const batch = Array.isArray(images) ? images : []
    const remaining = 50 - getImageCount(noteId)
    if (batch.length > remaining) throw new Error(`最多还能添加 ${Math.max(0, remaining)} 张图片`)

    const db = getDb()
    const writtenFiles = []
    const stagedImages = []
    try {
      for (const image of batch) stagedImages.push(await stageImage(image.base64, image.ext))
    } catch (error) {
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }
    const txn = db.transaction(() => {
      const results = []
      for (const staged of stagedImages) {
        const { relativePath, fileSize } = commitStagedImage(noteId, staged)
        writtenFiles.push(relativePath)
        results.push(addImageRecord({ noteId, filePath: relativePath, fileSize }))
      }
      return results
    })

    try {
      return txn()
    } catch (error) {
      await Promise.all(writtenFiles.map(deleteImageFile))
      await Promise.all(stagedImages.map(cleanupStagedImage))
      throw error
    }
  })

  /** 删除图片记录 + 文件 */
  ipcMain.handle('images:delete', async (_event, { id }) => {
    const db = getDb()
    const row = db
      .prepare(
        `SELECT a.* FROM note_attachments a
         INNER JOIN notes n ON n.id = a.note_id
         WHERE a.id = ? AND n.is_deleted = 0`
      )
      .get(id)
    if (!row) return false
    if (!(await deleteImageFile(row.file_path))) throw new Error('删除图片文件失败')
    db.prepare('DELETE FROM note_attachments WHERE id = ?').run(id)
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), row.note_id)
    return true
  })

  /** 获取便签的所有图片附件 */
  ipcMain.handle('images:list', (_event, { noteId }) => {
    return listImageRecords(noteId)
  })

  /** 获取图片 Base64（用于预览） */
  ipcMain.handle('images:get-base64', (_event, { relativePath }) => {
    return getImageBase64(relativePath)
  })

  /** 获取列表展示用缩略图，避免一次性把全部原图传入渲染进程。 */
  ipcMain.handle('images:get-thumbnail', (_event, { relativePath, maxSize }) => {
    return getImageThumbnail(relativePath, maxSize)
  })

  /** 获取图片数量 */
  ipcMain.handle('images:count', (_event, { noteId }) => {
    return getImageCount(noteId)
  })

  /** 物理删除便签的所有图片（逻辑删除时不调用） */
  ipcMain.handle('images:delete-note-dir', async (_event, { noteId }) => {
    await deleteNoteImages(noteId)
    return true
  })

  // ---- 截图 IPC ----

  /** 捕获全屏截图，打开独立窗口供用户选区，返回裁切后的 data URL */
  ipcMain.handle('screenshot:capture', async (requestEvent) => {
    if (screenshotWindow && !screenshotWindow.isDestroyed()) {
      screenshotWindow.focus()
      return null
    }

    const targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const pixelSize = {
      width: Math.round(targetDisplay.size.width * targetDisplay.scaleFactor),
      height: Math.round(targetDisplay.size.height * targetDisplay.scaleFactor)
    }

    async function captureTargetDisplay() {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: pixelSize
      })
      if (sources.length === 0) return null
      return (
        sources.find((item) => String(item.display_id) === String(targetDisplay.id)) || sources[0]
      ).thumbnail
    }

    function cropScreenshot(selection, sourceImage) {
      if (!sourceImage) return null
      const viewportWidth = Number(selection?.viewportWidth)
      const viewportHeight = Number(selection?.viewportHeight)
      if (!viewportWidth || !viewportHeight) return null

      const imageSize = sourceImage.getSize()
      const scaleX = imageSize.width / viewportWidth
      const scaleY = imageSize.height / viewportHeight
      const x = Math.max(0, Math.round(Number(selection.x) * scaleX))
      const y = Math.max(0, Math.round(Number(selection.y) * scaleY))
      const width = Math.min(
        imageSize.width - x,
        Math.max(1, Math.round(Number(selection.w) * scaleX))
      )
      const height = Math.min(
        imageSize.height - y,
        Math.max(1, Math.round(Number(selection.h) * scaleY))
      )
      if (!Number.isFinite(x + y + width + height) || width <= 0 || height <= 0) return null
      return sourceImage.crop({ x, y, width, height }).toDataURL()
    }

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        ...targetDisplay.bounds,
        show: false,
        transparent: true,
        backgroundColor: '#00000000',
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        fullscreenable: false,
        hasShadow: false,
        webPreferences: {
          preload: join(__dirname, '../preload/screenshot.js'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      screenshotWindow = win

      let settled = false
      let confirming = false
      const done = (result) => {
        if (settled) return
        settled = true
        ipcMain.removeListener('screenshot:confirm', onConfirm)
        ipcMain.removeListener('screenshot:cancel', onCancel)
        if (!win.isDestroyed()) win.close()
        if (screenshotWindow === win) screenshotWindow = null
        resolve(result)
      }

      const onConfirm = async (event, selection) => {
        if (event.sender !== win.webContents || confirming || settled) return
        confirming = true
        win.hide()
        try {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 60))
          const sourceImage = await captureTargetDisplay()
          done(cropScreenshot(selection, sourceImage))
        } catch (error) {
          console.error('[screenshot] 保存截图失败:', error)
          done(null)
        }
      }
      const onCancel = (event) => {
        if (event.sender === win.webContents) done(null)
      }

      ipcMain.on('screenshot:confirm', onConfirm)
      ipcMain.on('screenshot:cancel', onCancel)
      win.on('closed', () => done(null))

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:transparent}
body{overflow:hidden;cursor:crosshair;user-select:none;width:100vw;height:100vh;font-family:system-ui,sans-serif;animation:sc-overlay-in 150ms ease-out both}
canvas.sc-canvas{position:absolute;inset:0;z-index:1}
.sc-hint{position:fixed;bottom:20px;right:24px;font-size:14px;color:rgba(255,255,255,.45);z-index:3;pointer-events:none;font-family:inherit;opacity:1;transition:opacity 140ms ease,transform 180ms cubic-bezier(.32,.72,0,1)}
.sc-hint.hidden{opacity:0;transform:translateY(4px)}
.sc-actions{position:fixed;display:flex;align-items:center;gap:10px;z-index:3;font-family:inherit;opacity:0;transform:translateY(-4px) scale(.98);pointer-events:none;transition:opacity 150ms ease,transform 200ms cubic-bezier(.32,.72,0,1)}
.sc-actions.visible{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.sc-btn{border:none;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;padding:6px 16px;font-weight:500;transition:background 120ms ease,transform 160ms cubic-bezier(.32,.72,0,1)}
.sc-btn:active{transform:scale(.96);transition-duration:70ms}
.sc-btn-exit{background:rgba(255,255,255,.12);color:#fff}
.sc-btn-exit:hover{background:rgba(255,255,255,.22)}
.sc-btn-save{background:#0071e3;color:#fff}
.sc-btn-save:hover{background:#0077ed}
@keyframes sc-overlay-in{from{opacity:0}to{opacity:1}}
</style></head><body>
<canvas class="sc-canvas"></canvas>
<span class="sc-hint" id="hint">拖拽选择截图区域</span>
<div class="sc-actions" id="actions"><button class="sc-btn sc-btn-exit" id="btnExit">退出截屏</button><button class="sc-btn sc-btn-save" id="btnSave">保存截屏</button></div>
<script>
const cv=document.querySelector('canvas'),ctx=cv.getContext('2d')
const hint=document.getElementById('hint'),actions=document.getElementById('actions'),btnExit=document.getElementById('btnExit'),btnSave=document.getElementById('btnSave')
let s={x:0,y:0},e={x:0,y:0},has=false,mode='idle',dragOX=0,dragOY=0,dsX=0,dsY=0,deX=0,deY=0

function resize(){
  const dpr=window.devicePixelRatio||1
  cv.style.width=window.innerWidth+'px';cv.style.height=window.innerHeight+'px'
  cv.width=Math.round(window.innerWidth*dpr);cv.height=Math.round(window.innerHeight*dpr)
  ctx.setTransform(dpr,0,0,dpr,0,0);draw()
}
window.addEventListener('resize',resize)

function draw(){
  ctx.clearRect(0,0,window.innerWidth,window.innerHeight)
  ctx.fillStyle='rgba(0,0,0,.3)';ctx.fillRect(0,0,window.innerWidth,window.innerHeight)
  if(!has && mode!=='sel') return
  const x=Math.min(s.x,e.x),y=Math.min(s.y,e.y),w=Math.abs(e.x-s.x),h=Math.abs(e.y-s.y)
  ctx.clearRect(x,y,w,h)
  ctx.strokeStyle='#0071e3';ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,w-1,h-1)
}

function selRect(){
  const x=Math.min(s.x,e.x),y=Math.min(s.y,e.y),w=Math.abs(e.x-s.x),h=Math.abs(e.y-s.y)
  return{x,y,w,h}
}

function inside(px,py){const r=selRect();return px>=r.x&&px<=r.x+r.w&&py>=r.y&&py<=r.y+r.h}

function updateActions(){
  if(!has){actions.classList.remove('visible');return}
  const r=selRect();let tx=r.x,ty=r.y+r.h+8
  if(ty+36>window.innerHeight)ty=r.y-44
  actions.style.left=tx+'px';actions.style.top=ty+'px';actions.classList.add('visible')
}

function doSave(){
  const r=selRect();if(r.w<5||r.h<5)return
  screenshot.confirm({...r,viewportWidth:window.innerWidth,viewportHeight:window.innerHeight})
}

function doClear(){has=false;hint.classList.remove('hidden');actions.classList.remove('visible');draw()}

btnExit.onclick=()=>screenshot.cancel()
btnSave.onclick=()=>doSave()

document.addEventListener('keydown',(ev)=>{if(ev.key==='Escape')screenshot.cancel()})
document.addEventListener('contextmenu',(ev)=>{ev.preventDefault();has?doClear():screenshot.cancel()})

document.addEventListener('mousedown',(ev)=>{
  if(ev.button!==0)return
  if(ev.target.closest('#actions'))return
  if(has&&inside(ev.clientX,ev.clientY)){
    mode='move';dragOX=ev.clientX;dragOY=ev.clientY;dsX=s.x;dsY=s.y;deX=e.x;deY=e.y;document.body.style.cursor='grabbing'
    return
  }
  if(has){doClear()}
  mode='sel';s.x=e.x=ev.clientX;s.y=e.y=ev.clientY;has=false;hint.classList.remove('hidden');actions.classList.remove('visible');draw();document.body.style.cursor='crosshair'
})

document.addEventListener('mousemove',(ev)=>{
  if(mode==='sel'){e.x=ev.clientX;e.y=ev.clientY;draw()}
  else if(mode==='move'){
    const dx=ev.clientX-dragOX,dy=ev.clientY-dragOY
    s.x=dsX+dx;s.y=dsY+dy;e.x=deX+dx;e.y=deY+dy;draw();updateActions()
  }
  else if(has&&inside(ev.clientX,ev.clientY)){document.body.style.cursor='move'}
  else{document.body.style.cursor='crosshair'}
})

document.addEventListener('mouseup',(ev)=>{
  if(ev.button!==0)return
  if(mode==='sel'){
    mode='idle';const w=Math.abs(e.x-s.x),h=Math.abs(e.y-s.y);has=w>3&&h>3
    if(has){hint.classList.add('hidden');updateActions()}else{draw()}
  }else if(mode==='move'){mode='idle';document.body.style.cursor=has&&inside(ev.clientX,ev.clientY)?'move':'crosshair'}
})

setTimeout(()=>{resize()},0)
</script></body></html>`

      win
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        .then(() => {
          win.show()
          win.focus()
          if (!requestEvent.sender.isDestroyed()) {
            requestEvent.sender.send('screenshot:ready')
          }
        })
        .catch(() => done(null))
    })
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
  // 系统退出、Cmd+Q 与代码触发的 app.quit() 都必须绕过“关闭到托盘”。
  isQuitting = true
  if (geometryTimer) {
    clearTimeout(geometryTimer)
    geometryTimer = null
  }
  if (geometryDirty && getDb() && mainWindow && !mainWindow.isDestroyed()) {
    try {
      const bounds = mainWindow.getBounds()
      setSettingsBatch(WINDOW_NAME, [
        serializeSetting('geometry.posX', bounds.x),
        serializeSetting('geometry.posY', bounds.y),
        serializeSetting('geometry.width', bounds.width),
        serializeSetting('geometry.height', bounds.height)
      ])
      geometryDirty = false
    } catch (error) {
      console.warn('[settings] 退出前保存窗口位置失败:', error.message)
    }
  }
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
