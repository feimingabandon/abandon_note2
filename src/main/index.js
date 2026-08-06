/**
 * index.js — Electron 主进程入口文件
 *
 * 职责：
 *   1. 组装主进程服务并管理应用生命周期
 *   2. 创建主窗口，管理毛玻璃与贴边运动等窗口运行时
 *   3. 注册仍与主窗口运行时紧密耦合的核心 IPC
 *
 * 业务数据、截图和通知的具体编排由各自模块负责，本文件只注入运行时依赖。
 */

import * as Electron from 'electron'
const { app, shell, BrowserWindow, screen, Tray, Menu, dialog } = Electron

import { join, resolve } from 'path'
import { optimizer, is } from '@electron-toolkit/utils' // Electron 开发工具集
import icon from '../../resources/icon.png?asset' // 应用图标（Vite asset 导入）
import {
  initDatabase,
  closeDatabase,
  getDb,
  getAllSettings,
  setSettingsBatch,
  clearSettings,
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
import { createWindowMotionBackend } from './window-motion/index.js'
import { DockTransitionState } from './window-motion/dock-transition-state.js'

import {
  createNote,
  getNoteById,
  activateNotes,
  snoozeNote,
  claimDueSnoozedNotes
} from './db/db-notes.js'
import {
  acknowledgeRemoteNotice,
  getRemoteNoticeCursor,
  getRemoteNoticeLink,
  ingestRemoteNotices,
  listPendingRemoteNotices,
  listRemoteNotices
} from './db/db-remote-notices.js'
import { getOrCreateInstallationId } from './db/db-identity.js'
import { RemoteCoordinator } from './services/remote/remote-coordinator.js'
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
import { TemplateSchedulerGuard } from './services/template-scheduler-guard.js'
import { alignTriggerBoundsToEdge, inspectDockHealth } from './window-motion/dock-health.js'
import { AppUpdateService, UPDATE_LINKS } from './services/app-update.js'
import { NotificationService } from './services/NotificationService.js'
import { ScreenshotService } from './services/ScreenshotService.js'
import { ElectronStickyService } from './sticky/ElectronStickyService.js'
import { buildStickyTrayTemplate } from './sticky/StickyTrayMenu.js'
import {
  constrainMainWindowBounds,
  getPersistableWindowBounds,
  getWindowBoundsUpdate
} from './window-bounds.js'
import { ipcMain } from './logging/ipc-main.js'
import {
  exportLogs,
  flushLogs,
  getLogDirectory,
  getLogFiles,
  logger,
  normalizeRendererLog,
  queryLogs,
  writeLog
} from './logging/logger.js'
import {
  attachWindowLogging,
  getWindowLogContext,
  setWindowLogContext
} from './logging/window-capture.js'
import {
  DEFAULT_SETTINGS,
  createDefaultSettings,
  resolveSettingsRows,
  serializeSetting,
  VIEW_MODES
} from '../shared/settings-schema.js'
import { getSystemNotificationCapability } from '../shared/notification-policy.js'
import { registerBusinessIpcHandlers } from './ipc/register-business-ipc.js'
import {
  getViewSettingsScope,
  readApplicationSettings,
  writeActiveView,
  writeApplicationSetting
} from './settings/application-settings.js'
import { getWindowProfile } from './windows/window-profiles.js'

/** 窗口标识常量，用于在数据库中区分不同窗口的设置 */
const APP_ID = 'com.abandon.note'
const APP_NAME = '便签'
// 安装版由 NSIS 快捷方式把 APP_ID 映射为 productName；开发环境没有这层注册，
// Windows 会直接展示原始 ID，因此开发时使用中文名称作为通知来源标识。
const WINDOWS_APP_USER_MODEL_ID = app.isPackaged ? APP_ID : APP_NAME
const APP_PROTOCOL = 'abandon-note'
const SNOOZE_DELAY_MS = 10 * 60 * 1000
const SYSTEM_NOTIFICATION_CAPABILITY = getSystemNotificationCapability(process.platform)
const integrationAppRoot =
  process.env.ABANDON_INTEGRATION_TEST === '1' ? process.env.ABANDON_INTEGRATION_APP_ROOT : null
const APP_ROOT = integrationAppRoot ? resolve(integrationAppRoot) : app.getAppPath()
const PRELOAD_ROOT = join(APP_ROOT, 'out', 'preload')
const RENDERER_ROOT = join(APP_ROOT, 'out', 'renderer')
const RENDERER_WRITABLE_SETTING_IDS = new Set([
  'appearance.titlebarStyle',
  'css.bgColor',
  'css.popupOpacity',
  'css.bgBlur',
  'css.windowOpacity',
  'css.fontSizeBase',
  'css.textColor',
  'sticky.fontSize',
  'sticky.backgroundColor',
  'sticky.cornerRadius',
  'sticky.alwaysOnTop',
  'wallpaper.blurRadius',
  'ui.settingsPanelSize',
  'remote.receiveNotices',
  'remote.uploadDeviceInfo',
  'listFilter'
])
const APPLICATION_SETTING_IDS = new Set(['remote.receiveNotices', 'remote.uploadDeviceInfo'])
const REMOTE_BASE_URL =
  process.env.ABANDON_REMOTE_BASE_URL || 'https://note.zhenshiyin.top/api/v1/client'

// 修改展示名称时保留 Electron 已确定的 userData 路径，避免品牌名影响数据库位置。
const userDataPath = app.getPath('userData')
app.setName(APP_NAME)
app.setPath('userData', userDataPath)
if (process.platform === 'win32') {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
  const protocolArgs = process.defaultApp && process.argv[1] ? [resolve(process.argv[1])] : []
  // 完整应用集成测试会启动真实主进程，但不应修改开发机的协议关联。
  if (process.env.ABANDON_INTEGRATION_TEST !== '1') {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, protocolArgs)
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.log('[startup] 检测到已有实例在运行，本实例退出')
  app.quit()
}

let appUpdateService = null
let remoteCoordinator = null
let notificationService = null
let screenshotService = null

/** 当前只允许存在一个主视图；值持久化在 application 设置作用域。 */
let activeViewMode = VIEW_MODES.LIST
let switchingMainView = false

function getActiveWindowName() {
  return getViewSettingsScope(activeViewMode)
}

function getActiveWindowProfile() {
  return getWindowProfile(activeViewMode)
}

/** 主窗口实例引用 */
let mainWindow = null

/** 系统托盘实例 */
let tray = null
let stickyService = null

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
      openMainWindow()
      return true
    }
  } catch (error) {
    console.error('[notification] 无法解析通知操作:', error)
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
    openMainWindow()
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
let blurSettingsRequestsInFlight = 0
let queuedViewSwitch = null
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
let resolvedSettings = createDefaultSettings(activeViewMode)
let settingsRevision = 0

/** 防抖定时器，用于延迟保存窗口位置/尺寸 */
let geometryTimer = null
let dockGeometryReconcileTimer = null
let dockDisplayChangeTimer = null
const dockDisplayListeners = []

/** 窗口几何是否在最近一次成功持久化（或恢复默认）后发生过变化 */
let geometryDirty = false

/** 恢复默认时忽略程序化缩放触发的 resize，避免把默认边界重新写回设置表。 */
let suppressGeometryPersistenceUntil = 0

/** 贴边程序化移动结束后继续短暂抑制异步 move/resize 事件写库。 */
let suppressDockGeometryPersistenceUntil = 0

/** 最近一次处于屏幕内且可持久化的主窗口边界。 */
let lastVisibleMainWindowBounds = null

/** 统一调度器实例 */
const scheduler = new Scheduler()
scheduler.systemNotificationsEnabled = SYSTEM_NOTIFICATION_CAPABILITY.supported
scheduler.systemNotificationsDisabledReason = SYSTEM_NOTIFICATION_CAPABILITY.reason

function openSafeExternal(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    shell
      .openExternal(url.toString())
      .catch((error) => console.warn('[navigation] 打开外部链接失败:', error))
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
  const applicationSettings = readApplicationSettings()
  const nextSettings = resolveSettingsRows(getAllSettings(getActiveWindowName()), activeViewMode)
  nextSettings.remote = { ...applicationSettings.remote }
  const changed = JSON.stringify(nextSettings) !== JSON.stringify(resolvedSettings)
  resolvedSettings = nextSettings
  syncBlurConfigFromResolved()
  const revisionChanged = incrementRevision || changed
  if (revisionChanged) settingsRevision += 1
  return revisionChanged
}

function readAutoStartRuntime() {
  try {
    return { value: Boolean(app.getLoginItemSettings().openAtLogin), error: null }
  } catch (error) {
    logger.error('settings.auto-start-read', error)
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

function getViewSettings(viewMode) {
  return resolveSettingsRows(getAllSettings(getViewSettingsScope(viewMode)), viewMode)
}

function getWallpaperUsage(id) {
  return [VIEW_MODES.LIST, VIEW_MODES.MONTH].filter((viewMode) => {
    const wallpaper = getViewSettings(viewMode).wallpaper
    return wallpaper.activeId === Number(id)
  })
}

function greatestCommonDivisor(first, second) {
  let a = Math.abs(Math.round(first))
  let b = Math.abs(Math.round(second))
  while (b) [a, b] = [b, a % b]
  return a || 1
}

function listWallpaperLibraryRecords() {
  const bounds = mainWindow?.isDestroyed() ? null : mainWindow?.getBounds()
  const currentAspect =
    bounds?.width > 0 && bounds?.height > 0 ? bounds.width / bounds.height : null
  return listWallpaperRecords().map((record) => {
    const targetAspect = record.target_width / record.target_height
    const divisor = greatestCommonDivisor(record.target_width, record.target_height)
    return {
      ...record,
      aspectRatioLabel: `${record.target_width / divisor}:${record.target_height / divisor}`,
      usedBy: getWallpaperUsage(record.id),
      compatibleWithCurrentView:
        currentAspect === null ? null : Math.abs(Math.log(targetAspect / currentAspect)) <= 0.08
    }
  })
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
    logger.error('blur.initialize', error, { stage: 'initialize-or-first-config' })
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
    logger.error('blur.runtime-failure', error, { detail, nativeError })
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
      setSettingsBatch(getActiveWindowName(), [serializeSetting('blur.enabled', false)])
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
      // Overlay 与 Electron 是两个顶层 HWND。Win10 在焦点切换后可能把第三方
      // 窗口插到两者之间；这不是 Effect Graph 失效，重新排层即可恢复。
      if (mainWindow?.isVisible() && !health.zOrderSynchronized) {
        logger.warn('blur.z-order', '检测到毛玻璃层与主窗口不再相邻，正在自动修复')
        blurReSyncZOrder()
        updateBlurDiagnostic({
          status: 'pending',
          lastCheckedAt: checkedAt,
          message: '检测到窗口层级偏差，已请求自动修复'
        })
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
    if (windowMotionBackend?.isMoving()) return
    runBlurRuntimeOperation(blurUpdateGeometry, '同步毛玻璃窗口尺寸')
  })
  mainWindow.on('move', () => {
    if (windowMotionBackend?.isMoving()) return
    runBlurRuntimeOperation(blurUpdateGeometry, '同步毛玻璃窗口位置')
  })
  // WinEvent Hook 是主路径；Electron focus 是 Win10 漏报/过早上报重排事件时的
  // 低频兜底。两条路径最终都进入 C++ 去重队列，且同步前会检查是否已经相邻。
  mainWindow.on('focus', () => {
    runBlurRuntimeOperation(blurReSyncZOrder, '同步毛玻璃窗口焦点层级')
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
  // Windows 使用 thickFrame:false + renderer 自定义缩放手柄。调用
  // setResizable(true) 会重新引入系统 WS_THICKFRAME，破坏高 DPI 几何不变量。
  if (process.platform !== 'win32') mainWindow.setResizable(!isLocked)
  applyAlwaysOnTop()
}

/**
 * 通过共享 schema 持久化逻辑设置 ID；renderer 不再接触 type/key/raw value。
 * 返回广播出去的同一份完整快照。
 */
function persistSettingValues(entries, { applyBlurRuntime = true } = {}) {
  const normalizedEntries = entries.map(({ id, value }) => ({ id, ...serializeSetting(id, value) }))
  const applicationEntries = normalizedEntries.filter(({ id }) => APPLICATION_SETTING_IDS.has(id))
  const viewEntries = normalizedEntries.filter(({ id }) => !APPLICATION_SETTING_IDS.has(id))
  if (viewEntries.length) setSettingsBatch(getActiveWindowName(), viewEntries)
  applicationEntries.forEach(({ id, value }) => writeApplicationSetting(id, value))
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
  setSettingsBatch(getActiveWindowName(), [serializeSetting('wallpaper.enabled', false)])
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
const TRIGGER_ALWAYS_ON_TOP_LEVEL = 'screen-saver'
const SLIDE_DURATION = 200 // 滑动动画总时长（ms）
const SLIDE_INTERVAL = 16 // 滑动动画帧间隔（ms）≈60fps
const HIDE_DELAY = 200 // 鼠标离开后延迟隐藏（ms）
const HIDE_OVERSHOOT = 4 // 两侧统一多移出 4 DIP，吸收高 DPI 整数换算误差
const DOCK_GEOMETRY_SUPPRESSION_MS = 1000
const MAX_DOCK_SLIDE_AGE_MS = 5000

/** 默认窗口尺寸比例（相对屏幕工作区），改一个地方即可全局生效 */
let dockSide = null // null | 'left' | 'right' | 'top' | 'bottom' 当前吸附方向
let isDockHidden = false // 窗口是否处于贴边隐藏状态
let triggerWin = null // 边缘触发窗口实例
let triggerRequestedBounds = null // 业务请求的 2px 触发条范围
let triggerExpectedBounds = null // 原生窗口尺寸钳制后应保持的真实边界
let cachedWorkArea = null // 缓存显示器工作区，避免隐藏后 getDisplayMatching 返回过期对象
let slideAnimTimer = null // 滑动动画定时器
let hideTimer = null // 隐藏延迟定时器
let isSliding = false // 滑动动画进行中标志
let dockSlideStartedAt = null // 当前动画开始时间；健康任务用于识别卡死动画
let pendingSlideCallback = null // 动画中断时待执行的完成回调
let dockMotionSession = null // 一轮隐藏/显示共享的可见边界与工作区快照
let triggerPageLoaded = false // 当前边缘触发页面是否完成主框架加载
let triggerSequence = 0 // 触发窗口代次，便于串联一次隐藏过程的诊断日志
const dockTransitionState = new DockTransitionState()
let windowMotionBackend = null

function suppressDockGeometryPersistence() {
  suppressDockGeometryPersistenceUntil = Math.max(
    suppressDockGeometryPersistenceUntil,
    Date.now() + DOCK_GEOMETRY_SUPPRESSION_MS
  )
  scheduleDockGeometryReconciliation()
}

function isDockGeometryPersistenceSuppressed() {
  return (
    isSliding ||
    isDockHidden ||
    Boolean(dockMotionSession) ||
    Date.now() < suppressDockGeometryPersistenceUntil
  )
}

function isDockTransitionActive() {
  return isSliding || isDockHidden || Boolean(dockMotionSession)
}

function boundsEqual(first, second) {
  return (
    first &&
    second &&
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  )
}

/**
 * 动画事件全部安静下来后重新读取一次真实边界。这样既不会把动画中间帧写库，
 * 也不会丢失用户在保护期内立即进行的真实移动或缩放。
 */
function scheduleDockGeometryReconciliation() {
  if (dockGeometryReconcileTimer) clearTimeout(dockGeometryReconcileTimer)
  const delay = Math.max(0, suppressDockGeometryPersistenceUntil - Date.now()) + 50
  dockGeometryReconcileTimer = setTimeout(() => {
    dockGeometryReconcileTimer = null
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
    if (isSliding || isDockHidden || dockMotionSession) return
    if (
      Date.now() < suppressDockGeometryPersistenceUntil ||
      Date.now() < suppressGeometryPersistenceUntil
    ) {
      scheduleDockGeometryReconciliation()
      return
    }

    const bounds = mainWindow.getBounds()
    if (boundsEqual(bounds, lastVisibleMainWindowBounds)) return
    lastVisibleMainWindowBounds = { ...bounds }
    geometryDirty = true
    try {
      persistSettingValues([
        { id: 'geometry.posX', value: bounds.x },
        { id: 'geometry.posY', value: bounds.y },
        { id: 'geometry.width', value: bounds.width },
        { id: 'geometry.height', value: bounds.height }
      ])
      geometryDirty = false
    } catch (error) {
      console.warn('[settings] 补偿保存窗口位置失败:', error)
    }
  }, delay)
  dockGeometryReconcileTimer.unref?.()
}

function createStableDockBounds(bounds, side, workArea) {
  const width = Math.round(bounds.width)
  const height = Math.round(bounds.height)
  const visibleX =
    side === 'left' ? workArea.x : side === 'right' ? workArea.x + workArea.width - width : bounds.x
  const visibleY =
    side === 'top'
      ? workArea.y
      : side === 'bottom'
        ? workArea.y + workArea.height - height
        : bounds.y
  const x = Math.round(visibleX)
  const y = Math.round(visibleY)

  return { x, y, width, height }
}

/**
 * 创建主窗口
 * - 根据数据库中保存的位置/尺寸恢复窗口状态
 * - 若无保存记录，则使用默认值（屏幕左侧 25% 宽度、90% 高度）
 * - 窗口无边框 + 透明背景，用于实现自定义外观
 */
function createWindow({ preferredDisplay = null } = {}) {
  blurWindowSyncListenersAttached = false
  // 月视图首次创建优先沿用列表所在显示器；已有几何信息时仍以持久化位置为准。
  const display = preferredDisplay || screen.getPrimaryDisplay()
  const screenW = display.workAreaSize.width // 可用工作区宽度（排除任务栏）
  const screenH = display.workAreaSize.height // 可用工作区高度

  // 计算默认窗口尺寸（比例见顶部常量）
  const defaultW = Math.round(screenW * resolvedSettings.geometry.widthRatio)
  const defaultH = Math.round(screenH * resolvedSettings.geometry.heightRatio)
  // 计算上下边距，使窗口垂直居中
  const margin = Math.round((screenH - defaultH) / 2)
  const defaultX = getActiveWindowProfile().defaultCentered
    ? display.workArea.x + Math.round((screenW - defaultW) / 2)
    : display.workArea.x + margin
  const defaultY = display.workArea.y + Math.round((screenH - defaultH) / 2)

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
  const requestedBounds = saved || {
    x: defaultX,
    y: defaultY,
    width: defaultW,
    height: defaultH
  }
  const targetDisplay = saved ? screen.getDisplayMatching(saved) : display
  const bounds = constrainMainWindowBounds(requestedBounds, targetDisplay.workArea)

  // 创建主窗口实例（透明背景 + CSS 圆角）
  mainWindow = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    // Windows 的默认 thickFrame 会给无边框窗口保留不可见 resize inset。
    // 项目已有自定义缩放手柄，不需要让该 inset 参与高 DPI 边界换算。
    ...(process.platform === 'win32' ? { thickFrame: false } : {}),
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    skipTaskbar: true,
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window' } : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(PRELOAD_ROOT, 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const createdWindow = mainWindow
  setWindowLogContext(mainWindow, { role: getActiveWindowProfile().logRole })
  lastVisibleMainWindowBounds = { ...mainWindow.getBounds() }
  windowMotionBackend = createWindowMotionBackend(mainWindow, screen)
  logger.info('startup', '主窗口已创建', {
    viewMode: activeViewMode,
    bounds,
    savedGeometry: Boolean(saved)
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
        setSettingsBatch(getActiveWindowName(), [serializeSetting('wallpaper.enabled', false)])
        refreshResolvedSettings({ incrementRevision: true })
      }
    } else {
      console.warn('[blur] 初始化失败:', result.error, result.nativeError || '')
      // 启动失败不能继续保存“已开启”，否则下次打开设置会造成状态误导。
      if (blurConfig.enabled) {
        setSettingsBatch(getActiveWindowName(), [serializeSetting('blur.enabled', false)])
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
    if (isDockGeometryPersistenceSuppressed()) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    lastVisibleMainWindowBounds = { ...mainWindow.getBounds() }
    geometryDirty = true
    if (geometryTimer) clearTimeout(geometryTimer)
    geometryTimer = setTimeout(() => {
      geometryTimer = null
      if (Date.now() < suppressGeometryPersistenceUntil) return
      if (isDockGeometryPersistenceSuppressed()) return
      if (mainWindow && !mainWindow.isDestroyed()) {
        const b =
          dockMotionSession?.stableBounds || lastVisibleMainWindowBounds || mainWindow.getBounds()
        try {
          persistSettingValues([
            { id: 'geometry.posX', value: b.x },
            { id: 'geometry.posY', value: b.y },
            { id: 'geometry.width', value: b.width },
            { id: 'geometry.height', value: b.height }
          ])
          geometryDirty = false
        } catch (error) {
          console.warn('[settings] 保存窗口位置失败:', error)
        }
      }
    }, 500)
  }

  // 监听窗口大小变化和移动事件，触发防抖保存
  mainWindow.on('resize', () => {
    if (windowMotionBackend?.isMoving()) return
    debouncedSaveGeometry()
  })
  mainWindow.on('move', () => {
    if (windowMotionBackend?.isMoving()) return
    debouncedSaveGeometry()
  })

  // 【贴边隐藏 - 边缘检测】窗口移动时检测是否靠近屏幕左/右边缘
  mainWindow.on('move', () => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      windowMotionBackend?.isMoving() ||
      isDockHidden ||
      isSliding
    ) {
      return
    }
    const side = detectDockSide()
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
    if (!isQuitting && !switchingMainView) {
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
    // 视图切换会紧接着创建新窗口；旧窗口的延迟 closed 事件不能清空新引用。
    if (mainWindow !== createdWindow) return
    mainWindow = null
    windowMotionBackend = null
    lastVisibleMainWindowBounds = null
    blurWindowSyncListenersAttached = false
    resetDockState()
  })

  // 根据环境加载页面：开发模式用 HMR URL，生产模式加载本地 HTML 文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererFile = getActiveWindowProfile().rendererFile
    mainWindow.loadURL(
      rendererFile === 'index.html'
        ? process.env['ELECTRON_RENDERER_URL']
        : `${process.env['ELECTRON_RENDERER_URL']}/${rendererFile}`
    )
  } else {
    mainWindow.loadFile(join(RENDERER_ROOT, getActiveWindowProfile().rendererFile))
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
  restoreDockWindowToVisiblePosition()
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

/**
 * 贴边动画只移动窗口，绝不重新提交宽高。Windows 非 100% DPI 下反复
 * setBounds({ width, height }) 会触发 DIP/物理像素换算并造成尺寸漂移。
 */
function setDockPosition(position, motionPlan) {
  if (!mainWindow || mainWindow.isDestroyed() || !windowMotionBackend) return null
  const requestedX = Math.round(position.x)
  const requestedY = Math.round(position.y)
  suppressDockGeometryPersistence()
  const after = windowMotionBackend.moveTo(requestedX, requestedY, motionPlan.expectedSize)
  const contentAfter = mainWindow.getContentBounds()
  if (
    motionPlan.expectedElectronContentSize &&
    (contentAfter.width !== motionPlan.expectedElectronContentSize.width ||
      contentAfter.height !== motionPlan.expectedElectronContentSize.height)
  ) {
    throw new Error(
      `Electron 内容区破坏尺寸不变量：` +
        `${motionPlan.expectedElectronContentSize.width}x${motionPlan.expectedElectronContentSize.height} -> ` +
        `${contentAfter.width}x${contentAfter.height}`
    )
  }
  return after
}

function getExpectedTriggerBounds() {
  return triggerExpectedBounds ? { ...triggerExpectedBounds } : null
}

/** 生成纯数据快照，供每分钟健康任务和托盘诊断日志复用。 */
function getDockDiagnosticSnapshot() {
  const triggerExists = Boolean(triggerWin && !triggerWin.isDestroyed())
  let triggerBounds = null
  let triggerVisible = false
  let triggerAlwaysOnTop = false
  let triggerWebContentsDestroyed = true
  let mainMotionBounds = null
  let mainAtHiddenTarget = null

  if (triggerExists) {
    try {
      triggerBounds = triggerWin.getBounds()
      triggerVisible = triggerWin.isVisible()
      triggerAlwaysOnTop = triggerWin.isAlwaysOnTop()
      triggerWebContentsDestroyed = triggerWin.webContents.isDestroyed()
    } catch (error) {
      logger.error('dock.health-snapshot', error)
    }
  }

  if (isDockHidden && !isSliding && dockMotionSession?.motionPlan && windowMotionBackend) {
    try {
      mainMotionBounds = windowMotionBackend.capture()
      mainAtHiddenTarget =
        Math.abs(mainMotionBounds.x - dockMotionSession.motionPlan.hiddenX) <= 1 &&
        Math.abs(mainMotionBounds.y - dockMotionSession.motionPlan.hiddenY) <= 1
    } catch (error) {
      logger.error('dock.health-snapshot', error, { stage: 'capture-main-window' })
    }
  }

  return {
    mainWindowExists: Boolean(mainWindow && !mainWindow.isDestroyed()),
    isDockHidden,
    dockSide,
    hasDockMotionSession: Boolean(dockMotionSession),
    sessionSide: dockMotionSession?.side || null,
    mainMotionBounds,
    mainAtHiddenTarget,
    isSliding,
    slideAgeMs: isSliding && dockSlideStartedAt ? Date.now() - dockSlideStartedAt : 0,
    maxSlideAgeMs: MAX_DOCK_SLIDE_AGE_MS,
    expectedTriggerBounds: getExpectedTriggerBounds(),
    requestedTriggerBounds: triggerRequestedBounds ? { ...triggerRequestedBounds } : null,
    trigger: {
      sequence: triggerSequence,
      exists: triggerExists,
      destroyed: Boolean(triggerWin?.isDestroyed()),
      webContentsDestroyed: triggerWebContentsDestroyed,
      pageLoaded: triggerPageLoaded,
      visible: triggerVisible,
      alwaysOnTop: triggerAlwaysOnTop,
      expectedAlwaysOnTop: true,
      bounds: triggerBounds
    }
  }
}

function runDockHealthCheck() {
  const snapshot = getDockDiagnosticSnapshot()
  const issues = inspectDockHealth(snapshot)
  if (issues.length === 0) return

  const error = new Error(`贴边隐藏状态异常：${issues.join('；')}`)
  logger.error('dock.health', error, { issues, snapshot })
  throw error
}

/** 重置贴边状态（隐藏/关闭/最大化时统一调用） */
function resetDockState() {
  if (slideAnimTimer) {
    clearInterval(slideAnimTimer)
    slideAnimTimer = null
  }
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  pendingSlideCallback = null
  isSliding = false
  dockSlideStartedAt = null
  dockSide = null
  isDockHidden = false
  dockMotionSession = null
  triggerPageLoaded = false
  triggerRequestedBounds = null
  triggerExpectedBounds = null
  if (triggerWin && !triggerWin.isDestroyed()) {
    triggerWin.destroy()
    triggerWin = null
  }
  // 显示动画会临时提升层级；动画被托盘隐藏等操作中断时也必须恢复用户设置。
  const { restoreAlwaysOnTop } = dockTransitionState.reset()
  if (restoreAlwaysOnTop) applyAlwaysOnTop()
}

/**
 * 托盘隐藏会清除贴边会话；清除前先把隐藏中的窗口放回冻结的可见位置。
 * 主窗口已经 hide，因此该保底移动不会向用户闪现。
 */
function restoreDockWindowToVisiblePosition() {
  if (!mainWindow || mainWindow.isDestroyed() || !dockMotionSession) return
  const { stableBounds, motionPlan } = dockMotionSession

  try {
    if (windowMotionBackend && motionPlan) {
      windowMotionBackend.moveTo(motionPlan.visibleX, motionPlan.visibleY, motionPlan.expectedSize)
    } else {
      mainWindow.setPosition(stableBounds.x, stableBounds.y)
    }
  } catch (error) {
    console.warn('[dock] 原生恢复可见位置失败，改用 Electron 位置保底:', error)
    try {
      mainWindow.setPosition(stableBounds.x, stableBounds.y)
    } catch (fallbackError) {
      console.error('[dock] 恢复可见位置失败:', fallbackError)
    }
  }

  const current = mainWindow.getBounds()
  lastVisibleMainWindowBounds = {
    ...stableBounds,
    x: current.x,
    y: current.y
  }
}

function runPendingSlideCallback() {
  const callback = pendingSlideCallback
  pendingSlideCallback = null
  if (!callback) return true

  try {
    callback()
    return true
  } catch (error) {
    console.error('[dock] 动画完成处理失败，已保留贴边恢复入口:', error)
    preserveDockSessionAfterSlideFailure()
    return false
  }
}

/**
 * 原生移动或终点处理失败时不能直接 reset：窗口可能已经在屏外，reset 会同时
 * 销毁触发条并丢失返回坐标。保留冻结会话和触发条，下一次显示请求可从当前位置重试。
 */
function preserveDockSessionAfterSlideFailure() {
  if (slideAnimTimer) {
    clearInterval(slideAnimTimer)
    slideAnimTimer = null
  }
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  pendingSlideCallback = null
  isSliding = false
  dockSlideStartedAt = null

  if (!mainWindow || mainWindow.isDestroyed() || !dockMotionSession) {
    resetDockState()
    return
  }

  dockSide = dockMotionSession.side
  isDockHidden = true
  if (!triggerWin || triggerWin.isDestroyed()) {
    try {
      createTriggerWindow(dockSide)
    } catch (error) {
      console.error('[dock] 恢复边缘触发窗口失败:', error)
    }
  }
  const { restoreAlwaysOnTop } = dockTransitionState.reset()
  if (restoreAlwaysOnTop) {
    try {
      applyAlwaysOnTop()
    } catch (error) {
      console.error('[dock] 恢复用户置顶设置失败:', error)
    }
  }
}

/**
 * 隐藏期间显示器被拔除、分辨率或 DPI 改变时，旧的工作区快照已经失效。
 * 立即取消隐藏并把主窗口约束到当前仍存在的最近显示器，避免窗口与触发条滞留屏外。
 */
function handleDockDisplayTopologyChange() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const sourceBounds =
    dockMotionSession?.stableBounds || lastVisibleMainWindowBounds || mainWindow.getBounds()
  const center = {
    x: sourceBounds.x + Math.round(sourceBounds.width / 2),
    y: sourceBounds.y + Math.round(sourceBounds.height / 2)
  }
  const display = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay()
  const safeBounds = constrainMainWindowBounds(sourceBounds, display.workArea)
  const currentBounds = mainWindow.getBounds()
  const update = getWindowBoundsUpdate(currentBounds, safeBounds)

  suppressDockGeometryPersistence()
  resetDockState()
  cachedWorkArea = { ...display.workArea }
  if (update.mode === 'position') {
    mainWindow.setPosition(update.x, update.y)
  } else if (update.mode === 'bounds') {
    mainWindow.setBounds(update.bounds)
  }
  if (!boundsEqual(safeBounds, lastVisibleMainWindowBounds)) {
    lastVisibleMainWindowBounds = { ...safeBounds }
    geometryDirty = true
    try {
      persistSettingValues([
        { id: 'geometry.posX', value: safeBounds.x },
        { id: 'geometry.posY', value: safeBounds.y },
        { id: 'geometry.width', value: safeBounds.width },
        { id: 'geometry.height', value: safeBounds.height }
      ])
      geometryDirty = false
    } catch (error) {
      console.warn('[settings] 保存显示器变化后的窗口位置失败:', error)
    }
  }
}

function attachDockDisplayListeners() {
  if (dockDisplayListeners.length > 0) return
  for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
    const listener = () => {
      if (dockDisplayChangeTimer) clearTimeout(dockDisplayChangeTimer)
      dockDisplayChangeTimer = setTimeout(() => {
        dockDisplayChangeTimer = null
        handleDockDisplayTopologyChange()
      }, 250)
      dockDisplayChangeTimer.unref?.()
    }
    screen.on(eventName, listener)
    dockDisplayListeners.push([eventName, listener])
  }
}

function detachDockDisplayListeners() {
  if (dockDisplayChangeTimer) {
    clearTimeout(dockDisplayChangeTimer)
    dockDisplayChangeTimer = null
  }
  for (const [eventName, listener] of dockDisplayListeners) {
    screen.removeListener(eventName, listener)
  }
  dockDisplayListeners.length = 0
}

/**
 * 按当前窗口配置检测允许的贴边方向：列表仅左右，月视图仅顶部。
 * @returns {null|'left'|'right'|'top'|'bottom'} 边缘方向，null 表示未靠近
 */
function detectDockSide() {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  if (mainWindow.isMaximized() || mainWindow.isMinimized()) return null

  updateWorkArea()
  if (!cachedWorkArea) return null

  const b = mainWindow.getBounds()
  const wa = cachedWorkArea

  const nearBySide = {
    left: b.x <= wa.x + SNAP_THRESHOLD,
    right: b.x + b.width >= wa.x + wa.width - SNAP_THRESHOLD,
    top: b.y <= wa.y + SNAP_THRESHOLD,
    bottom: b.y + b.height >= wa.y + wa.height - SNAP_THRESHOLD
  }
  const candidates = getActiveWindowProfile().dockEdges.map((side) => [side, nearBySide[side]])
  for (const [side, nearEdge] of candidates) {
    if (nearEdge && windowMotionBackend?.isDockEdgeExposed(side)) return side
  }
  return null
}

/** 将窗口吸附到指定边缘 */
function snapToEdge(side) {
  updateWorkArea()
  if (!cachedWorkArea || !windowMotionBackend) return
  try {
    const motionPlan = windowMotionBackend.createDockPlan(side, HIDE_OVERSHOOT)
    const electronContentBounds = mainWindow.getContentBounds()
    motionPlan.expectedElectronContentSize = {
      width: electronContentBounds.width,
      height: electronContentBounds.height
    }
    setDockPosition({ x: motionPlan.visibleX, y: motionPlan.visibleY }, motionPlan)
  } catch (error) {
    console.error('[dock] 吸附窗口失败:', error)
    resetDockState()
  }
}

/**
 * 创建边缘触发窗口
 * 屏幕内只露出 2px 的透明触发条；Windows 若扩大原生窗口，额外宽度移到屏幕外。
 */
function createTriggerWindow(side) {
  if (triggerWin && !triggerWin.isDestroyed()) triggerWin.destroy()
  triggerWin = null
  triggerPageLoaded = false
  triggerRequestedBounds = null
  triggerExpectedBounds = null
  if (!dockMotionSession) {
    logger.warn('dock.trigger', '缺少贴边运动会话，无法创建边缘触发窗口', { side })
    return
  }

  const wa = dockMotionSession.workArea
  const b = dockMotionSession.stableBounds
  const requestedBounds =
    side === 'left'
      ? { x: wa.x, y: b.y, width: TRIGGER_WIDTH, height: b.height }
      : side === 'right'
        ? {
            x: wa.x + wa.width - TRIGGER_WIDTH,
            y: b.y,
            width: TRIGGER_WIDTH,
            height: b.height
          }
        : side === 'top'
          ? { x: b.x, y: wa.y, width: b.width, height: TRIGGER_WIDTH }
          : {
              x: b.x,
              y: wa.y + wa.height - TRIGGER_WIDTH,
              width: b.width,
              height: TRIGGER_WIDTH
            }

  const sequence = ++triggerSequence
  const win = new BrowserWindow({
    ...requestedBounds,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(PRELOAD_ROOT, 'trigger.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  triggerWin = win
  triggerRequestedBounds = { ...requestedBounds }
  const createdBounds = win.getBounds()
  triggerExpectedBounds = alignTriggerBoundsToEdge({
    side,
    requestedBounds,
    actualBounds: createdBounds,
    visibleWidth: TRIGGER_WIDTH
  })
  win.setBounds(triggerExpectedBounds)
  setWindowLogContext(win, { role: 'trigger' })
  logger.info('dock.trigger', '边缘触发窗口已创建', {
    sequence,
    side,
    requestedBounds,
    createdBounds,
    expectedBounds: triggerExpectedBounds,
    actualBounds: win.getBounds(),
    alwaysOnTopLevel: TRIGGER_ALWAYS_ON_TOP_LEVEL
  })

  // 触发条必须独立于主窗口的“置顶”偏好保持在最上层，否则其它最大化窗口
  // 或弹出菜单会覆盖它，鼠标移动消息便永远到不了 Chromium。Electron 的
  // setVisibleOnAllWorkspaces 在 Windows 上无效，不能用它替代原生 Z 序。
  win.setAlwaysOnTop(true, TRIGGER_ALWAYS_ON_TOP_LEVEL)
  // 点击继续穿透给下层应用；forward 让 Windows 的鼠标移动消息仍进入 Chromium。
  win.setIgnoreMouseEvents(true, { forward: true })

  const html =
    '<!doctype html><html style="width:100%;height:100%"><body style="margin:0;width:100%;height:100%"></body></html>'
  win
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .then(() => {
      if (triggerWin !== win || win.isDestroyed()) return
      triggerPageLoaded = true
      win.showInactive()
      logger.info('dock.trigger', '边缘触发页面加载完成', {
        sequence,
        url: win.webContents.getURL(),
        bounds: win.getBounds(),
        visible: win.isVisible(),
        alwaysOnTop: win.isAlwaysOnTop()
      })
    })
    .catch((error) => {
      if (triggerWin === win) triggerPageLoaded = false
      logger.error('dock.trigger-load', error, { sequence, side, requestedBounds })
    })

  win.on('closed', () => {
    const wasCurrent = triggerWin === win
    const metadata = {
      sequence,
      wasCurrent,
      isDockHidden,
      isSliding
    }
    if (wasCurrent && isDockHidden) {
      logger.warn('dock.trigger', '边缘触发窗口在主窗口隐藏期间关闭', metadata)
    } else {
      logger.info('dock.trigger', '边缘触发窗口已关闭', metadata)
    }
    if (wasCurrent) {
      triggerWin = null
      triggerPageLoaded = false
      triggerRequestedBounds = null
      triggerExpectedBounds = null
    }
  })
}

/**
 * 滑动动画 —— easeInOutQuad 缓动曲线，慢起 → 快 → 慢停
 * @param {{x:number,y:number}} target - 目标坐标
 * @param {object} motionPlan - 本轮冻结的坐标空间、目标位置与尺寸不变量
 * @param {Function} [onFinish] - 动画完成回调
 */
function slideTo(target, motionPlan, onFinish) {
  // 中断前一个动画时，先执行其回调以恢复状态（如置顶级别）
  if (slideAnimTimer) {
    clearInterval(slideAnimTimer)
    slideAnimTimer = null
  }
  if (pendingSlideCallback) {
    if (!runPendingSlideCallback()) return
  }

  isSliding = true
  dockSlideStartedAt = Date.now()
  pendingSlideCallback = onFinish || null

  // 记录动画起始位置和总帧数
  let from
  try {
    from = windowMotionBackend.capture()
  } catch (error) {
    console.error('[dock] 读取动画起点失败:', error)
    preserveDockSessionAfterSlideFailure()
    return
  }
  const totalFrames = Math.ceil(SLIDE_DURATION / SLIDE_INTERVAL)
  let frame = 0

  slideAnimTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(slideAnimTimer)
      slideAnimTimer = null
      resetDockState()
      return
    }

    frame++
    const progress = Math.min(frame / totalFrames, 1)
    // easeInOutQuad：前半段加速，后半段减速
    const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2

    try {
      setDockPosition(
        {
          x: from.x + (target.x - from.x) * ease,
          y: from.y + (target.y - from.y) * ease
        },
        motionPlan
      )
    } catch (error) {
      console.error('[dock] 物理移动失败，已中止贴边动画:', error)
      preserveDockSessionAfterSlideFailure()
      return
    }

    if (progress >= 1) {
      clearInterval(slideAnimTimer)
      slideAnimTimer = null
      isSliding = false
      dockSlideStartedAt = null
      runPendingSlideCallback()
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

  let motionPlan
  try {
    motionPlan = windowMotionBackend.createDockPlan(dockSide, HIDE_OVERSHOOT)
    const electronContentBefore = mainWindow.getContentBounds()
    motionPlan.expectedElectronContentSize = {
      width: electronContentBefore.width,
      height: electronContentBefore.height
    }
    suppressDockGeometryPersistence()
    setDockPosition({ x: motionPlan.visibleX, y: motionPlan.visibleY }, motionPlan)
    const snapped = windowMotionBackend.capture()
    motionPlan = {
      ...motionPlan,
      initial: snapped,
      expectedSize: { width: snapped.width, height: snapped.height },
      visibleX: motionPlan.visibleX,
      visibleY: motionPlan.visibleY
    }
  } catch (error) {
    console.error('[dock] 创建隐藏动画计划失败:', error)
    resetDockState()
    return
  }
  const stableBounds = createStableDockBounds(mainWindow.getBounds(), dockSide, cachedWorkArea)
  dockMotionSession = {
    side: dockSide,
    stableBounds,
    motionPlan,
    workArea: { ...cachedWorkArea }
  }
  lastVisibleMainWindowBounds = { ...stableBounds }
  isDockHidden = true
  logger.info('dock.lifecycle', '开始贴边隐藏', {
    side: dockSide,
    stableBounds,
    triggerSequence: triggerSequence + 1
  })

  const target = { x: motionPlan.hiddenX, y: motionPlan.hiddenY }

  createTriggerWindow(dockSide)
  slideTo(target, motionPlan, () => {
    try {
      const terminal = windowMotionBackend.capture()
      const crossedBoundary =
        dockSide === 'left'
          ? terminal.x + terminal.width <= motionPlan.workArea.left
          : dockSide === 'right'
            ? terminal.x >= motionPlan.workArea.right
            : dockSide === 'top'
              ? terminal.y + terminal.height <= motionPlan.workArea.top
              : terminal.y >= motionPlan.workArea.bottom
      if (!crossedBoundary) {
        console.error('[dock] 隐藏终点未越过工作区边界:', {
          side: dockSide,
          terminal,
          motionPlan
        })
      }
    } catch (error) {
      console.error('[dock] 读取隐藏终点失败:', error)
    }
    logger.info('dock.lifecycle', '贴边隐藏动画完成', {
      side: dockSide,
      triggerSequence
    })
    if (dockTransitionState.consumeQueuedShow()) doShow('queued-during-hide')
  })
}

/**
 * 贴边显示 —— 销毁触发窗口，窗口滑回边缘
 * 前置条件：isDockHidden === true
 */
function doShow(source = 'unknown') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger.warn('dock.show', '显示请求被拒绝：主窗口不存在', { source })
    return
  }
  const showAction = dockTransitionState.requestShow({ hidden: isDockHidden, sliding: isSliding })
  logger.info('dock.show', '收到贴边显示请求', {
    source,
    action: showAction,
    isDockHidden,
    isSliding,
    hasDockMotionSession: Boolean(dockMotionSession),
    triggerSequence
  })
  if (showAction !== 'start') return

  const session = dockMotionSession
  if (!session) {
    logger.error('dock.show', new Error('显示请求已进入执行状态，但缺少贴边运动会话'), {
      source,
      snapshot: getDockDiagnosticSnapshot()
    })
    return
  }

  suppressDockGeometryPersistence()
  isDockHidden = false

  // 立即销毁触发窗口，防止阻挡主窗口
  if (triggerWin && !triggerWin.isDestroyed()) {
    triggerWin.destroy()
  }
  triggerWin = null
  triggerPageLoaded = false
  triggerRequestedBounds = null
  triggerExpectedBounds = null

  const { stableBounds, motionPlan } = session
  const target = { x: motionPlan.visibleX, y: motionPlan.visibleY }

  // 滑出时短暂提升置顶层，确保动画可见
  dockTransitionState.beginTemporaryAlwaysOnTop()
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu')
  slideTo(target, motionPlan, () => {
    try {
      suppressDockGeometryPersistence()
      const visibleElectronBounds = mainWindow.getBounds()
      lastVisibleMainWindowBounds = {
        ...stableBounds,
        x: visibleElectronBounds.x,
        y: visibleElectronBounds.y
      }
      dockMotionSession = null
      try {
        const terminal = windowMotionBackend.capture()
        const expectedVisible = { x: motionPlan.visibleX, y: motionPlan.visibleY }
        if (terminal.x !== expectedVisible.x || terminal.y !== expectedVisible.y) {
          console.error('[dock] 显示终点未回到冻结位置:', {
            expectedVisible,
            terminal,
            motionPlan
          })
        }
      } catch (error) {
        console.error('[dock] 读取显示终点失败:', error)
      }
    } finally {
      // 动画完成或终点校验失败后都必须恢复用户设置的置顶状态。
      dockTransitionState.finishTemporaryAlwaysOnTop()
      applyAlwaysOnTop()
      logger.info('dock.lifecycle', '贴边显示动画完成', {
        source,
        side: session.side,
        triggerSequence
      })
    }
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
    triggerWin.setAlwaysOnTop(true, TRIGGER_ALWAYS_ON_TOP_LEVEL)
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
  logger.info('dock.tray', '用户点击托盘图标', { snapshot: getDockDiagnosticSnapshot() })

  if (isDockHidden) {
    doShow('tray-click')
    return
  }
  // 锁定时禁用贴边滑入：托盘点击退回普通“隐藏到托盘”行为，不再滑向屏幕边缘。
  if (dockSide && !isLocked) {
    doHide()
    return
  }
  if (mainWindow.isVisible()) {
    hideToTray()
  } else {
    mainWindow.show()
    // 从托盘恢复后重新检测贴边（hideToTray 中的 resetDockState 清除了 dockSide）
    dockSide = detectDockSide()
  }
}

function openMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (isDockHidden) {
    doShow('open-main-window')
  } else {
    mainWindow.show()
  }
  mainWindow.focus()
}

/**
 * 主窗口被替换前销毁与旧 HWND 绑定的毛玻璃资源，并同步清空 JS 运行态。
 * 调用者可以据此安全地为新窗口重新初始化；即使原生销毁抛错，状态清理也会完成。
 */
function destroyBlurRuntimeForWindowReplacement() {
  try {
    blurDestroy()
  } finally {
    blurInitialized = false
    blurRuntimeFailed = false
    blurInitializationError = null
    blurInitializationNativeError = null
    blurWindowSyncListenersAttached = false
  }
}

/** 销毁当前唯一主视图并使用另一套独立设置创建目标视图。 */
function switchMainView(targetMode) {
  const normalized = targetMode === VIEW_MODES.MONTH ? VIEW_MODES.MONTH : VIEW_MODES.LIST
  if (switchingMainView) return false
  // 启用毛玻璃时有一段壁纸退场等待。让这次设置事务先在原视图完整收敛，
  // 再执行最后一次托盘切换请求，避免异步尾部写入另一个视图作用域。
  if (blurSettingsRequestsInFlight > 0) {
    queuedViewSwitch = normalized === activeViewMode ? null : normalized
    return true
  }
  if (normalized === activeViewMode) return false

  const previousMode = activeViewMode
  switchingMainView = true
  let sourceDisplay = null
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      sourceDisplay = screen.getDisplayMatching(
        dockMotionSession?.stableBounds || lastVisibleMainWindowBounds || mainWindow.getBounds()
      )
      restoreDockWindowToVisiblePosition()
      resetDockState()
      mainWindow.hide()
    }

    if (geometryTimer) {
      clearTimeout(geometryTimer)
      geometryTimer = null
    }
    geometryDirty = false
    destroyBlurRuntimeForWindowReplacement()

    if (mainWindow && !mainWindow.isDestroyed()) {
      const previousWindow = mainWindow
      previousWindow.destroy()
      if (mainWindow === previousWindow) mainWindow = null
    }
    activeViewMode = normalized
    resolvedSettings = createDefaultSettings(activeViewMode)
    refreshResolvedSettings({ incrementRevision: true })
    createWindow({ preferredDisplay: sourceDisplay })
    applyResolvedWindowRuntime()
    writeActiveView(activeViewMode)
    rebuildTrayMenu()
    logger.info('view.switch', '主视图已切换', { activeViewMode })
    return true
  } catch (error) {
    logger.error('view.switch', error, { previousMode, targetMode: normalized })
    try {
      // 目标窗口可能已经完成毛玻璃初始化后才在后续步骤失败。必须先清理其
      // HWND/Overlay 绑定，再恢复原视图，否则 initializeBlurRuntime 会被旧状态短路。
      try {
        destroyBlurRuntimeForWindowReplacement()
      } catch (destroyError) {
        logger.error('view.switch-restore-blur-destroy', destroyError, { previousMode })
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
      activeViewMode = previousMode
      resolvedSettings = createDefaultSettings(activeViewMode)
      refreshResolvedSettings({ incrementRevision: true })
      createWindow({ preferredDisplay: sourceDisplay })
      applyResolvedWindowRuntime()
      // 目标视图持久化后若托盘重建等尾部步骤失败，也要把“下次启动视图”
      // 一并回滚；持久化自身失败不应阻止已经重建的原窗口继续可用。
      try {
        writeActiveView(previousMode)
      } catch (persistRestoreError) {
        logger.error('view.switch-restore-persistence', persistRestoreError, { previousMode })
      }
      rebuildTrayMenu()
    } catch (restoreError) {
      logger.fatal('view.switch-restore', restoreError, { previousMode })
    }
    return false
  } finally {
    switchingMainView = false
  }
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed() || !stickyService) return
  tray.setContextMenu(
    Menu.buildFromTemplate(
      buildStickyTrayTemplate({
        stickyService,
        openMainWindow,
        activeViewMode,
        switchMainView,
        quitApplication: () => {
          isQuitting = true
          app.quit()
        }
      })
    )
  )
}

// ============================================================
// 应用就绪后的初始化逻辑
// ============================================================
app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return

  // 初始化数据库连接
  const { isNewDatabase } = initDatabase()
  logger.info('startup', '数据库初始化完成', { isNewDatabase })
  if (isNewDatabase) {
    createNote({
      content:
        '欢迎使用 Abandon Note！\n\n你可以点击上方输入框快速新建便签，也可以点击这条示例便签体验编辑、提醒、标签和桌面便利贴功能。'
    })
  }
  appUpdateService = new AppUpdateService({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  })
  try {
    await Promise.all([cleanupPendingAttachmentDirs(), cleanupPendingWallpaperFiles()])
  } catch (error) {
    console.warn('[storage] 恢复未完成的存储操作失败:', error)
  }
  activeViewMode = readApplicationSettings().activeView
  resolvedSettings = createDefaultSettings(activeViewMode)
  refreshResolvedSettings({ incrementRevision: true })
  handleProtocolArgs(process.argv)

  // 监听新窗口创建事件，自动注册快捷键优化器
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    attachWindowLogging(window)
  })

  // ---- IPC 通道注册 ----

  ipcMain.on('logs:write', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const normalized = normalizeRendererLog(payload)
    const windowContext = getWindowLogContext(win)
    writeLog({
      ...normalized,
      windowRole: windowContext.role,
      webContentsId: event.sender.id
    })
  })

  ipcMain.handle('logs:query', async (event, query) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权读取应用日志')
    return {
      ...(await queryLogs(query)),
      files: getLogFiles().map((file) => ({
        name: file.name,
        size: file.size,
        modifiedAt: file.modifiedAt
      }))
    }
  })

  ipcMain.handle('logs:open-folder', async (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权打开日志目录')
    const errorMessage = await shell.openPath(getLogDirectory())
    if (errorMessage) throw new Error(errorMessage)
    return true
  })

  ipcMain.handle('logs:export', async (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权导出应用日志')
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出诊断日志',
      defaultPath: `abandon-note-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    await exportLogs(result.filePath, {
      logDirectory: getLogDirectory(),
      crashDumpsPath: app.getPath('crashDumps')
    })
    logger.info('logs.export', '诊断日志已导出', { targetPath: result.filePath })
    return { canceled: false, filePath: result.filePath }
  })

  // ---- 应用更新（全手动模式：只检查新版本，下载安装由用户前往发布页完成） ----
  // 所有 URL 均由主进程固定；renderer 不可传入任意地址。
  ipcMain.handle('update:check', async (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权检查应用更新')
    return appUpdateService.check()
  })

  ipcMain.handle('app:get-info', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权读取应用信息')
    return { version: app.getVersion(), platform: process.platform, arch: process.arch }
  })

  ipcMain.handle('update:open-manual', async (event, provider) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权打开更新页面')
    const url = UPDATE_LINKS[provider]
    if (!url) throw new Error('未知的更新来源')
    await shell.openExternal(url)
    return true
  })

  // 【渲染就绪】渲染进程初始化完成后发送此消息，主进程收到后显示窗口
  ipcMain.on('renderer-ready', (event) => {
    if (event.sender !== mainWindow?.webContents) return
    logger.info('startup', '渲染进程就绪', { suppressInitialWindowShow })
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
      !isLocked &&
      !isDockTransitionActive() &&
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

  // ---- 远程软件通知（全部阅读状态仅保存在本地） ----
  ipcMain.handle('remote-notices:list-pending', () => listPendingRemoteNotices())
  ipcMain.handle('remote-notices:list', (_event, query) => listRemoteNotices(query))
  ipcMain.handle('remote-notices:acknowledge', (_event, { id }) => acknowledgeRemoteNotice(id))
  ipcMain.handle('remote-notices:open-link', (_event, { id }) => {
    const link = getRemoteNoticeLink(id)
    if (!link) return false
    try {
      const url = new URL(link)
      if (url.protocol !== 'https:') return false
      shell
        .openExternal(url.toString())
        .catch((error) => console.warn('[remote] 打开通知链接失败:', error))
      return true
    } catch {
      return false
    }
  })
  // 设置页面只读取启动阶段缓存，不允许因为打开设置而产生新的服务器请求。
  ipcMain.handle('remote:get-health', () =>
    remoteCoordinator
      ? remoteCoordinator.getHealthSnapshot()
      : {
          available: false,
          noticeService: false,
          reportService: false,
          checkedAt: null,
          checking: false,
          skipped: false,
          error: '远程服务尚未初始化'
        }
  )

  /**
   * 恢复当前视图的持久化设置默认值。
   * 不触碰应用级设置、另一视图、业务数据或开机自启 OS 状态。
   * 当前窗口立即恢复默认宽高并保留当前位置，同时清除下次启动时的几何记录。
   */
  ipcMain.handle('reset-settings', () => {
    if (isDockTransitionActive()) {
      throw new Error('请先显示贴边窗口，再恢复默认设置')
    }
    if (geometryTimer) {
      clearTimeout(geometryTimer)
      geometryTimer = null
    }
    // 清表后若窗口没有再次移动/缩放，退出时不能把旧边界重新写回。
    geometryDirty = false
    // 旧版本把远程开关放在 main 作用域。清空列表设置前先固化到真正的应用级
    // 作用域，保证“恢复当前视图”绝不会顺带重置公共隐私选择。
    writeApplicationSetting('remote.receiveNotices', resolvedSettings.remote.receiveNotices)
    writeApplicationSetting('remote.uploadDeviceInfo', resolvedSettings.remote.uploadDeviceInfo)
    clearSettings(getActiveWindowName())
    refreshResolvedSettings({ incrementRevision: true })
    applyResolvedWindowRuntime()
    applyResolvedBlurRuntime()

    // 宽高立即恢复为当前显示器工作区的默认比例；位置仍保持当前值。
    if (mainWindow && !mainWindow.isDestroyed()) {
      const display = screen.getDisplayMatching(mainWindow.getBounds())
      const defaultWidth = Math.round(
        display.workAreaSize.width * resolvedSettings.geometry.widthRatio
      )
      const defaultHeight = Math.round(
        display.workAreaSize.height * resolvedSettings.geometry.heightRatio
      )
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
      // 鼠标离开窗口 —— 若已吸附边缘且未锁定，延迟后执行隐藏（锁定时窗口固定，不自动滑走）
      if (dockSide && !isDockHidden && !isSliding && !isLocked) {
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
    const currentWebContents =
      triggerWin && !triggerWin.isDestroyed() ? triggerWin.webContents : null
    const accepted = event.sender === currentWebContents
    logger.info('dock.trigger-ipc', '主进程收到边缘触发 IPC', {
      accepted,
      senderWebContentsId: event.sender.id,
      currentWebContentsId: currentWebContents?.id || null,
      isDockHidden,
      isSliding,
      triggerSequence
    })
    if (!accepted) return
    if (isDockHidden) doShow('edge-trigger')
  })

  // ---- 系统模糊 IPC ----

  /** 设置模糊配置（立即生效 + 持久化到数据库） */
  ipcMain.handle('set-blur-config', async (_event, config) => {
    blurSettingsRequestsInFlight += 1
    try {
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

      // 重新启用时原生引擎通常已经初始化，因此不会再次经过
      // initializeBlurRuntime() 更新诊断状态。配置实际生效后立即执行完整健康
      // 检查，让界面拿到经过原生效果链验证的最终状态，而不是等待下一分钟调度。
      if (enableRequested && runtime.effectiveEnabled) {
        runBlurRuntimeDiagnostic({ reason: 'settings-change', now: Date.now() })
        snapshot = getResolvedSettingsSnapshot()
        runtime = snapshot.runtime.blur
      }

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
    } finally {
      blurSettingsRequestsInFlight = Math.max(0, blurSettingsRequestsInFlight - 1)
      if (blurSettingsRequestsInFlight === 0 && queuedViewSwitch) {
        const targetMode = queuedViewSwitch
        queuedViewSwitch = null
        setImmediate(() => switchMainView(targetMode))
      }
    }
  })

  // ---- 主页面壁纸 IPC ----
  ipcMain.handle('wallpapers:list', () => listWallpaperLibraryRecords())
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
    const usedBy = getWallpaperUsage(parsedId)
    const deleted = await deleteWallpaperVersion(parsedId, {
      clearSelectionForWindows: usedBy.map(getViewSettingsScope)
    })
    if (deleted && usedBy.includes(activeViewMode)) {
      refreshResolvedSettings({ incrementRevision: true })
      broadcastSettingsChanged()
    }
    return deleted
  })

  createWindow()
  remoteCoordinator = new RemoteCoordinator({
    app,
    baseUrl: REMOTE_BASE_URL,
    getSettings: () => resolvedSettings,
    getInstallationId: getOrCreateInstallationId,
    getCursor: getRemoteNoticeCursor,
    ingestNotices: ingestRemoteNotices,
    onNoticesChanged: (payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('remote-notices:changed', payload)
    },
    onHealthChanged: (health) => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send('remote-health:changed', health)
    }
  })
  void remoteCoordinator.start()
  attachDockDisplayListeners()
  stickyService = new ElectronStickyService({
    getMainWindow: () => mainWindow,
    getNoteById,
    // 便利贴属于列表能力；月视图处于活动状态时也不能把它的默认占位值当成
    // 用户在列表设置页保存的便利贴外观。
    getDefaultAppearance: () => getViewSettings(VIEW_MODES.LIST).sticky,
    preloadPath: join(PRELOAD_ROOT, 'sticky.js'),
    rendererFile: join(RENDERER_ROOT, 'sticky.html'),
    rendererUrl:
      is.dev && process.env.ELECTRON_RENDERER_URL
        ? `${process.env.ELECTRON_RENDERER_URL}/sticky.html`
        : null,
    isDevelopment: is.dev,
    onRegistryChanged: rebuildTrayMenu,
    onError: (text) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('app:message', { type: 'error', text })
    }
  })
  stickyService.initialize()

  // 初始化完整快照中的窗口运行状态（必须在 createWindow 之后）
  applyResolvedWindowRuntime()
  // ---- 调度器任务注册 ----
  // 职责划分（两层任务，按此顺序执行）：
  //   1. 激活任务：查询 initialized 便签，生效时间到达的 → 转为 in_progress（含通知）
  //   2. 模板生成：查询循环模板，判断是否应当生成新便签实例（含通知）

  notificationService = new NotificationService({
    appProtocol: APP_PROTOCOL,
    capability: SYSTEM_NOTIFICATION_CAPABILITY,
    getMainWindow: () => mainWindow,
    icon,
    platform: process.platform,
    snoozeDelayMs: SNOOZE_DELAY_MS,
    snoozeNote
  })

  // 3.3 生效便签激活任务（含通知）
  scheduler.register({
    name: 'activationTask',
    shouldRun: () => true,
    execute: () => {
      const result = activateNotes()
      for (const note of result.notified) {
        if (notificationService.trySend(note.content, { noteId: note.id })) {
          const preview = (note.content || '').trim().slice(0, 10) || '空内容'
          console.log(`[activation-notify]「${preview}」便签已发送系统通知`)
        }
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
        if (notificationService.trySend(note.content, { noteId: note.id })) {
          console.log(`[snoozed-notify] 便签 #${note.id} 已再次发送系统通知`)
        }
      }
    }
  })

  // 3.5 循环模板生成任务（含通知）
  const templateSchedulerGuard = new TemplateSchedulerGuard({
    failureThreshold: 3,
    retryDelayMs: 5 * 60 * 1000,
    onAlert: (error) => {
      notificationService.trySend(error?.message || '无法读取或调度循环模板', {
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
        const preview = (note.content || '').trim().slice(0, 10) || '空内容'
        if (
          notificationService.trySend(note.content, {
            title: `「${preview}」已通过模板生成新的便签`
          })
        ) {
          console.log(`[generation-notify]「${preview}」已由循环模板生成便签，模板已发送通知`)
        }
      }
      for (const template of result.autoPaused) {
        const preview = (template.content || '').trim().slice(0, 20) || '空内容模板'
        notificationService.trySend(`模板“${preview}”连续生成失败 3 次：${template.error}`, {
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

  // 3.7 贴边隐藏状态健康检查：只验证状态不变量并记录异常，不轮询鼠标、不自动恢复窗口。
  scheduler.register({
    name: 'dockHealthTask',
    maxFailures: Infinity,
    shouldRun: () => true,
    execute: () => runDockHealthCheck()
  })

  // 启动调度器
  // 调度器终极告警通知若在 macOS 未签名等场景发送失败，同样降级为应用内消息条。
  scheduler.onAlertNotifyFailed = (title, body, error) => {
    notificationService.notifyFailure('调度器告警通知', title, body, error)
  }
  scheduler.start()
  console.log('[scheduler] 调度器已启动')

  // ---- 任务栏 & 托盘事件 ----

  // show：贴边隐藏时滑出（安全网，正常路径下 show 不会在贴边隐藏时触发）
  mainWindow.on('show', () => {
    if (isDockHidden) doShow('main-window-show-event')
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

  registerBusinessIpcHandlers({
    ipcMain,
    getMainWindow: () => mainWindow,
    platform: process.platform
  })

  screenshotService = new ScreenshotService({
    ipcMain,
    preloadPath: join(PRELOAD_ROOT, 'screenshot.js')
  })
  screenshotService.initialize()

  // ---- 调度器健康检查 IPC ----

  // 【调度器 - 健康检查】
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

  rebuildTrayMenu()
  logger.info('startup', '系统托盘已创建，启动初始化完成')

  // macOS 特有：点击 Dock 图标时显示窗口
  app.on('activate', () => {
    openMainWindow()
  })
})

// 应用退出前关闭数据库连接和贴边资源，确保数据安全
app.on('before-quit', () => {
  // 系统退出、Cmd+Q 与代码触发的 app.quit() 都必须绕过“关闭到托盘”。
  isQuitting = true
  void remoteCoordinator?.stop()
  if (geometryTimer) {
    clearTimeout(geometryTimer)
    geometryTimer = null
  }
  if (dockGeometryReconcileTimer) {
    clearTimeout(dockGeometryReconcileTimer)
    dockGeometryReconcileTimer = null
  }
  detachDockDisplayListeners()
  if (geometryDirty && getDb() && mainWindow && !mainWindow.isDestroyed()) {
    try {
      const bounds = getPersistableWindowBounds({
        dockStableBounds: dockMotionSession?.stableBounds,
        lastVisibleBounds: lastVisibleMainWindowBounds,
        currentBounds: mainWindow.getBounds()
      })
      setSettingsBatch(getActiveWindowName(), [
        serializeSetting('geometry.posX', bounds.x),
        serializeSetting('geometry.posY', bounds.y),
        serializeSetting('geometry.width', bounds.width),
        serializeSetting('geometry.height', bounds.height)
      ])
      geometryDirty = false
    } catch (error) {
      console.warn('[settings] 退出前保存窗口位置失败:', error)
    }
  }
  scheduler.stop()
  notificationService = null
  screenshotService?.dispose()
  screenshotService = null
  stickyService?.dispose()
  stickyService = null
  closeDatabase()
  // 销毁模糊引擎（释放 DLL 资源）
  blurDestroy()
  if (triggerWin && !triggerWin.isDestroyed()) {
    triggerWin.destroy()
  }
  triggerWin = null
  triggerPageLoaded = false
  triggerRequestedBounds = null
  triggerExpectedBounds = null
  if (slideAnimTimer) clearInterval(slideAnimTimer)
  if (hideTimer) clearTimeout(hideTimer)
  if (tray) {
    tray.destroy()
    tray = null
  }
  flushLogs()
})

// 所有窗口关闭时不退出应用，保持在托盘中运行
app.on('window-all-closed', () => {})
