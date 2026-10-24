import { createBusinessMutationAdmission } from './application/business-mutation-admission.js'
import { suspendImageDecodes, resumeImageDecodes, disposeImageDecodes } from './db/db-images.js'
import { imageReadService } from './images/image-read-service.js'
import { startImagePreviewRead } from './images/image-preview-reader.js'
import {
  createAttachmentRecoveryRetryController,
  registerAttachmentRecoveryRetryIpc
} from './application/attachment-recovery-retry.js'
import {
  runCommittedDataCleanup,
  broadcastBusinessDataCleared,
  createBusinessClearCleanupError
} from './application/business-data-clear.js'
import { createFeatureRuntime } from './application/feature-runtime.js'
import { createMainTrayController } from './tray/main-tray-controller.js'
import { createNotificationActivation } from './services/notification-activation.js'
import { createSettingsWriteCoordinator } from './settings/settings-write-coordinator.js'
import { createSettingsApplicationCoordinator } from './settings/settings-application-coordinator.js'
import {
  registerSettingsApplicationIpc,
  settingsApplicationStateForSource
} from './ipc/register-settings-application-ipc.js'
import { createSettingsWriteSource } from './settings/settings-write-source.js'
import { createSessionDraftAssetsRuntime } from './drafts/session-draft-assets-runtime.js'
import { createSessionDraftNoteCommands } from './drafts/session-draft-note-commands.js'
import { registerDraftAssetsIpc } from './ipc/register-draft-assets-ipc.js'
import { allowImageClipboardWrite } from './ipc/image-clipboard-permission.js'
import { pathToFileURL } from 'node:url'
import { createNoteWithAssets, saveNoteDraft } from './notes/note-commands.js'
import { createSettingsOperationAdmission } from './settings/settings-operation-admission.js'
import { createBackgroundSettingsCoordinator } from './settings/background-settings-coordinator.js'
import { createWallpaperRetirement } from './settings/wallpaper-retirement.js'
import { createMainViewNavigation } from './windows/main-view-navigation.js'
import { createPresentationRuntime } from './windows/presentation-runtime.js'
import { createWindowDragController } from './windows/window-drag-controller.js'
import { createWindowDragCoordinates } from './windows/window-drag-coordinates.js'
import { createDockRuntime } from './window-motion/dock-runtime.js'
import { createCaptureWindowIntegration } from './capture/capture-window-integration.js'
import { createBlurRuntime } from './windows/blur-runtime.js'
import { createZOrderRuntime } from './windows/z-order-runtime.js'
import { createWindowGeometryPersistence } from './windows/window-geometry-persistence.js'
import { createApplicationBootstrap, settleStartupRecoveries } from './application/bootstrap.js'
import { createShutdownCoordinator } from './application/shutdown-coordinator.js'
import { createMainWindowHost } from './windows/main-window-host.js'
import { installRendererRecovery } from './windows/renderer-recovery.js'
import { beginPerformanceOperation } from './logging/operation-performance.js'
import { createEditingDraftGuard } from './windows/editing-draft-guard.js'
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
const { app, shell, BrowserWindow, screen, powerMonitor, Tray, Menu, dialog, globalShortcut } =
  Electron

import { join, resolve } from 'path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { sanitizeDiagnosticValue } from '../shared/diagnostic-sanitize.js'
import { randomUUID } from 'crypto'
import { optimizer, is } from '@electron-toolkit/utils' // Electron 开发工具集
import icon from '../../resources/icon.png?asset' // 应用图标（Vite asset 导入）
import {
  initDatabase,
  closeDatabase,
  getDb,
  cleanupPendingAttachmentDirs,
  getAttachmentRecoveryReport,
  clearNoteData
} from './db/db.js'
import { getAllSettings, setSettingsBatch } from './db/db-settings-repository.js'
import { createSettingsRuntime } from './settings/settings-runtime.js'
import {
  setConfig as blurSetConfig,
  getRuntimeHealth as getBlurRuntimeHealth,
  getNativeRuntimeCompatibility
} from './bridge/blur_bridge.js'

import { createDeferredWindowRestore } from './windows/deferred-window-restore.js'

import { validateDockConfigPayload } from './window-motion/dock-config.js'

import { createNote, getNoteById, activateNotes } from './db/db-notes.js'
import { saveStickyNoteContent } from './notes/sticky-note-commands.js'
import {
  countDesktopStickyRecords,
  deleteAllDesktopStickyRecords,
  deleteDesktopStickyRecord,
  hasDesktopStickyRecord,
  insertDesktopStickyRecord,
  listDesktopStickyRecords,
  updateDesktopStickyRecord
} from './db/db-desktop-stickies.js'
import {
  applyRemoteNoticeEvents,
  acknowledgeRemoteNotice,
  getRemoteNoticeSyncState,
  getRemoteNoticeLink,
  listPendingRemoteNotices,
  listRemoteNotices
} from './db/db-remote-notices.js'
import {
  getOrCreateInstallationId,
  isRemoteServiceRetired,
  markRemoteServiceRetired
} from './db/db-identity.js'
import {
  clearPendingRemoteSessionEnds,
  listPendingRemoteSessionEnds,
  markRemoteSessionEndAttempt,
  queueRemoteSessionEnd,
  removePendingRemoteSessionEnd
} from './db/db-remote-sessions.js'
import { RemoteCoordinator } from './services/remote/remote-coordinator.js'
import { getRemoteDailyState, saveRemoteDailyState } from './db/db-remote-daily.js'
import {
  cleanupPendingWallpaperFiles,
  getWallpaperDataUrl,
  getWallpaperThumbnail
} from './db/db-wallpapers.js'
import { runRecurringTemplates } from './services/recurrence.js'
import { runAutomaticNoteMove } from './services/automatic-note-move.js'

import { AppUpdateService } from './services/app-update.js'
import { CaptureCoordinator } from './capture/CaptureCoordinator.js'
import { CaptureShortcutService } from './capture/CaptureShortcutService.js'
import { ViewVisibilityShortcutService } from './services/view-visibility-shortcut.js'
import { createNewNoteShortcut } from './services/new-note-shortcut.js'
import { ACTION_SHORTCUTS } from '../shared/capture-shortcuts.js'
import { unavailableShortcuts } from '../shared/shortcut-status.js'

import { ipcMain } from './logging/ipc-main.js'
import { checkpoint, diagnosticBroadcast } from './logging/operation-context.js'

import {
  exportLogs,
  flushLogs,
  freezeLogSnapshot,
  releaseLogSnapshot,
  getLogDirectory,
  logger,
  queryLogs,
  writeLog
} from './logging/logger.js'
import { attachWindowLogging, setWindowLogContext } from './logging/window-capture.js'
import { refreshCrashDumpIndex } from './logging/process-capture.js'
import { collectSystemDiagnostics } from './logging/system-diagnostics.js'
import { startPerformanceDiagnostics } from './logging/performance-diagnostics.js'
import { registerDiagnosticController } from './logging/diagnostic-controller.js'

import { enforceNativeRuntimeCompatibility } from './native-runtime-gate.js'
import {
  DEFAULT_SETTINGS,
  SETTING_DEFINITIONS,
  RENDERER_WRITABLE_SETTING_IDS as rendererWritableSettingIds,
  resolveSettingsRows,
  serializeSetting,
  VIEW_MODES,
  WINDOW_Z_ORDER_MODES
} from '../shared/settings-schema.js'
import { getSystemNotificationCapability } from '../shared/notification-policy.js'
import { registerBusinessIpcHandlers } from './ipc/register-business-ipc.js'
import { registerAppIpc } from './ipc/register-app-ipc.js'
import { registerLoggingIpc } from './ipc/register-logging-ipc.js'
import { registerRemoteNoticeIpc } from './ipc/register-remote-notice-ipc.js'
import { registerWallpaperIpc } from './ipc/register-wallpaper-ipc.js'
import { registerCalendarIpcHandlers } from './ipc/register-calendar-ipc.js'
import { registerDailyReportIpcHandlers } from './ipc/register-daily-report-ipc.js'
import { createMainWindowIpc } from './ipc/ipc-authorization.js'
import {
  ensureApplicationWindowSettingsInitialized,
  ensureViewSettingsInitialized,
  getViewSettingsScope,
  readApplicationSettings,
  resetCurrentViewSettings,
  writeApplicationSetting
} from './settings/application-settings.js'

import { COMPACT_WINDOW_LIMITS } from '../shared/window-compact-geometry.js'

// 草稿只在本次应用进程中有效。主窗口即使切换页面或因崩溃重载，仍使用同一会话标识；
// 应用重启后会生成新标识，渲染层因此不会恢复上一次启动留下的草稿。
const editingDraftSessionId = randomUUID()

/** 窗口标识常量，用于在数据库中区分不同窗口的设置 */
const APP_ID = 'com.abandon.note'
const APP_NAME = '便签'
// 安装版由 NSIS 快捷方式把 APP_ID 映射为 productName；开发环境没有这层注册，
// Windows 会直接展示原始 ID，因此开发时使用中文名称作为通知来源标识。
const WINDOWS_APP_USER_MODEL_ID = app.isPackaged ? APP_ID : APP_NAME
// Stable across releases: Windows uses this COM identity to activate old toasts.
// Electron otherwise generates a different CLSID on every process start.
const WINDOWS_TOAST_ACTIVATOR_CLSID = app.isPackaged
  ? '{1CBE300C-E243-4C77-8BA9-1068B748F17E}'
  : '{7A5326BE-B6B3-4F17-B4C3-C14FDFF451EA}'
const APP_PROTOCOL = 'abandon-note'
const SYSTEM_NOTIFICATION_CAPABILITY = getSystemNotificationCapability()
const integrationAppRoot =
  process.env.ABANDON_INTEGRATION_TEST === '1' ? process.env.ABANDON_INTEGRATION_APP_ROOT : null
const APP_ROOT = integrationAppRoot ? resolve(integrationAppRoot) : app.getAppPath()
const PRELOAD_ROOT = join(APP_ROOT, 'out', 'preload')
const RENDERER_ROOT = join(APP_ROOT, 'out', 'renderer')
const RENDERER_WRITABLE_SETTING_IDS = new Set(rendererWritableSettingIds)
const REMOTE_BASE_URL =
  process.env.ABANDON_REMOTE_BASE_URL || 'https://note.zhenshiyin.top/api/v1/client'

// 修改展示名称时保留 Electron 已确定的 userData 路径，避免品牌名影响数据库位置。
const userDataPath = app.getPath('userData')
app.setName(APP_NAME)
app.setPath('userData', userDataPath)
if (process.platform === 'win32') {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
  app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID)
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
let screenshotService = null

/** 主窗口实例引用 */
const mainWindowHost = createMainWindowHost({ BrowserWindow })
const getMainWindow = mainWindowHost.getWindow

function getActiveVisualWindow() {
  return getMainWindow()
}

function getApplicationWindows() {
  return getMainWindow() && !getMainWindow().isDestroyed() ? [getMainWindow()] : []
}

let viewVisibilityShortcutService = null
let captureShortcutService = null
const canOpenNewNote = () =>
  !shutdownCoordinator.isQuitting() && !captureWindowIntegration.isActive()
const newNoteShortcut = createNewNoteShortcut({
  canOpen: canOpenNewNote,
  openWindow: () =>
    openMainWindowFromTray({ source: 'new-note-shortcut', isCurrent: canOpenNewNote }),
  getWindow: getMainWindow,
  isReady: (window) => mainViewNavigation.isReadyDocument(window)
})
let startupShortcutFailures = []
let startupShortcutNoticeDismissed = false
const viewVisibilityShortcutCaptureSenders = new WeakSet()
const captureWindowIntegration = createCaptureWindowIntegration({
  getWindow: getMainWindow,
  isDockHidden: () => dockRuntime.hidden,
  shouldHide: () => settingsRuntime.values.interaction.hideMainViewDuringScreenshot,
  isQuitting: () => shutdownCoordinator.isQuitting(),
  suspendDock: (source, options) => beginDockInteractionSuspension(source, options),
  resumeDock: (source) => endDockInteractionSuspension(source),
  hideWindow: (window) => hideMainWindowForViewNavigation(window),
  reassertZOrder: (source) => reassertBottomWindowZOrder(source),
  openBusiness: ({ isCurrent } = {}) =>
    openMainWindowFromTray({ source: 'capture-delivery', isCurrent })
})

let diagnosticController = null
const businessAdmission = createBusinessMutationAdmission()
const settingsOperations = createSettingsOperationAdmission()
const notificationActivation = createNotificationActivation({
  protocol: APP_PROTOCOL,
  getWindow: getMainWindow,
  canRequestOpen: (window) =>
    mainViewNavigation.isAwaitingFirstReady(window) || mainViewNavigation.isReadyDocument(window),
  openMainWindow: () =>
    openMainWindowFromTray({ source: 'notification', allowExpandFallback: true }),
  logger
})
const {
  handleProtocol: handleNotificationProtocol,
  handleArgs: handleProtocolArgs,
  reveal: revealApplicationFromNotification,
  settlePendingReveal: revealPendingNotificationApplication
} = notificationActivation

if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    if (handleProtocolArgs(argv, 'second-instance')) return
    void openMainWindowFromTray().catch((error) =>
      logger.error('presentation-mode.second-instance-expand', error)
    )
  })
}

/** 窗口锁定状态（全视图共享，禁止移动和缩放） */
let isLocked = DEFAULT_SETTINGS.window.lockState

const MAIN_WINDOW_MIN_SIZE = 240

const WINDOW_CONTROL_GUARD_MS = 500

let lastLockToggleAt = 0
let lockToggleInFlight = false

const blurRuntime = createBlurRuntime({
  getMainWindow,
  getActiveVisualWindow,
  getApplicationWindows,
  getSettings: () => settingsRuntime.values,
  isWindowMoving: () => dockRuntime.isMoving(),
  getActiveWindowName: () => mainViewNavigation.getActiveWindowName(),
  refreshResolvedSettings,
  broadcastSettingsChanged,
  logger
})
const {
  syncBlurConfigFromResolved,
  initializeBlurRuntime,
  updateBlurDiagnostic,
  runBlurRuntimeDiagnostic,
  runBlurRuntimeOperation,
  applyResolvedBlurRuntime,
  restoreBlurForVisibleWindow,
  synchronizePresentationBlur
} = blurRuntime
const zOrderRuntime = createZOrderRuntime({
  getMainWindow,
  getActiveVisualWindow,
  getApplicationWindows,
  getSettings: () => settingsRuntime.values,
  readBlurState: () => ({ initialized: blurRuntime.initialized, config: blurRuntime.config }),
  readDockState: () => ({ isSliding: dockRuntime.sliding, isDockHidden: dockRuntime.hidden }),
  isWindowLocked: () => isLocked,
  runBlurRuntimeOperation,
  refreshResolvedSettings,
  getResolvedSettingsSnapshot,
  broadcastSettingsChanged,
  completeCommittedSettings: (request) =>
    settingsOperations.track(
      settingsApplicationCoordinator.completeCommittedSettings({
        scope: getActiveWindowName(),
        ...request
      })
    ),
  sendAppMessage,
  logger
})
const {
  captureTitlebarZOrderStatus,
  cancelBottomWindowZOrderRetry,
  scheduleBottomWindowZOrderRetry,
  applyWindowZOrder,
  reassertBottomWindowZOrder,
  setWindowZOrderMode
} = zOrderRuntime

/** SettingsRuntime uniquely owns resolved values, revision and the session shortcut gate. */
const settingsRuntime = createSettingsRuntime({
  initialViewMode: VIEW_MODES.LIST,
  getViewMode: () => mainViewNavigation.mode,
  readApplication: readApplicationSettings,
  readViewRows: (viewMode) => getAllSettings(getViewSettingsScope(viewMode)),
  onResolved: () => {
    syncBlurConfigFromResolved()
    screenshotService?.syncTheme()
    remoteCoordinator?.settingsChanged()
  },
  readRuntime: readSettingsRuntimeSnapshot
})

/** Ordinary geometry has one state/timer owner; Dock and compact provide narrow snapshots. */
const geometryPersistence = createWindowGeometryPersistence({
  getWindow: getMainWindow,
  canSchedule: () => !mainViewNavigation.isSwitching() && !isCompactPresentationActive(),
  isDockSuppressed: () => dockRuntime.isDockGeometryPersistenceSuppressed(),
  readDockBounds: () => dockRuntime.readStableSessionBounds(),
  persistValues: (entries) => persistInternalSettingValues(entries),
  persistStoredBounds: persistStoredWindowBounds,
  onError: (error) => console.warn('[settings] 保存窗口位置失败:', error)
})
function persistStoredWindowBounds(entries) {
  setSettingsBatch(
    getActiveWindowName(),
    entries.map(({ id, value }) => serializeSetting(id, value))
  )
  // Final shutdown flush owns only synchronous persistence after application drains.
  if (shutdownCoordinator.isQuitting()) return
  try {
    refreshResolvedSettings({ notifyResolved: false })
  } catch (error) {
    // SQL already committed; readback failure must not retain dirty geometry or repeat SQL.
    logger.error('settings.geometry-resolution', error)
  }
}
function debouncedSaveGeometry() {
  geometryPersistence.schedule()
}

const dockRuntime = createDockRuntime({
  getMainWindow,
  screen,
  powerMonitor,
  getViewMode: () => mainViewNavigation.mode,
  getActiveWindowProfile: () => mainViewNavigation.getActiveWindowProfile(),
  getSettings: () => settingsRuntime.values,
  isWindowLocked: () => isLocked,
  isQuitting: () => shutdownCoordinator.isQuitting(),
  isCompactPresentationActive: () => presentationRuntime.isCompactPresentationActive(),
  reconcilePresentationDisplayGeometry: (change) =>
    presentationRuntime.reconcileDisplayGeometry(change),
  geometryPersistence,
  persistSettingValues: (...args) => persistInternalSettingValues(...args),
  readBlurState: () => ({
    config: blurRuntime.config,
    initialized: blurRuntime.initialized,
    failed: blurRuntime.failed,
    diagnostic: blurRuntime.diagnostic
  }),
  getZOrderMode: () => zOrderRuntime.mode,
  runBlurRuntimeOperation,
  applyWindowZOrder,
  reassertBottomWindowZOrder,
  logger
})
const {
  getDockRuntimeConfig,
  getDockRuntimeCapability,
  reconcileDockRuntimeConfig,
  beginDockInteractionSuspension,
  endDockInteractionSuspension,
  cancelPendingDockHide,
  isDockTransitionActive,
  setDockPosition,
  getDockDiagnosticSnapshot,
  runDockHealthCheck,
  resetDockState,
  restoreDockWindowToVisiblePosition,
  handleDockDisplayTopologyChange,
  attachDockDisplayListeners,
  attachDockPowerListeners,
  syncVisibleDockSide,
  doHide,
  doShow
} = dockRuntime

const { dipBoundsToPhysical, resolvedDragPoint } = createWindowDragCoordinates(screen)
const windowDragController = createWindowDragController({
  getMainWindow,
  isWindowLocked: () => isLocked,
  isCompactPresentationActive: () => presentationRuntime.isCompactPresentationActive(),
  getPresentationMode: () => presentationModeSnapshot().mode,
  getZOrderMode: () => zOrderRuntime.mode,
  captureTitlebarZOrderStatus,
  captureMotionBounds: dockRuntime.captureMotionBounds,
  movePosition: dockRuntime.setDockPosition,
  suspendDock: dockRuntime.beginDockInteractionSuspension,
  resumeDock: dockRuntime.endDockInteractionSuspension,
  scheduleGeometry: debouncedSaveGeometry,
  reassertBottomWindowZOrder,
  dipBoundsToPhysical,
  resolvedDragPoint,
  logger
})
const {
  begin: beginTitlebarWindowDrag,
  update: updateTitlebarWindowDrag,
  end: endTitlebarWindowDrag
} = windowDragController

const presentationRuntime = createPresentationRuntime({
  getMainWindow,
  screen,
  getSettings: () => settingsRuntime.values,
  isWindowLocked: () => isLocked,
  getUserHideGeneration: () => mainViewNavigation.getUserHideGeneration(),
  geometryPersistence,
  reconcileExpandedDisplayGeometry: (change) => dockRuntime.handleDockDisplayTopologyChange(change),
  resolveActiveViewWindowBounds: (options) =>
    mainViewNavigation.resolveActiveViewWindowBounds(options),
  restoreDockWindowToVisiblePosition,
  resetDockState,
  endTitlebarWindowDrag,
  beginDockInteractionSuspension,
  endDockInteractionSuspension,
  captureMotionBounds: dockRuntime.captureMotionBounds,
  setDockPosition,
  dipBoundsToPhysical,
  resolvedDragPoint,
  readBlurState: () => ({ initialized: blurRuntime.initialized, config: blurRuntime.config }),
  synchronizePresentationBlur,
  getZOrderMode: () => zOrderRuntime.mode,
  applyWindowZOrder,
  reassertBottomWindowZOrder,
  applyResolvedWindowRuntime,
  persistSettingValues: (...args) => persistInternalSettingValues(...args),
  logger
})
const {
  isCompactPresentationActive,
  presentationModeSnapshot,
  acknowledgePresentationRenderer,
  enterCompactPresentation,
  exitCompactPresentation,
  beginCompactWindowDrag,
  updateCompactWindowDrag,
  endCompactWindowDrag,
  finishCompactWindowResize
} = presentationRuntime

const mainViewNavigation = createMainViewNavigation({
  getMainWindow,
  screen,
  loadWindow: mainWindowHost.load,
  getDocumentGeneration: () => settingsWriteSource.readGeneration(),
  getSettings: () => settingsRuntime.values,
  resetSettingsForView: (mode) => settingsRuntime.resetForView(mode),
  refreshResolvedSettings,
  geometryPersistence,
  dockRuntime,
  isCompactPresentationActive,
  exitCompactPresentation,
  endTitlebarWindowDrag,
  openMainWindow,
  confirmEditingDrafts: (...args) => confirmEditingDrafts(...args),
  resumePageLeave: (window, owner) => confirmEditingDrafts.resume(window, owner),
  onNavigationSettled: () => shutdownCoordinator.resumeDeferredQuit(),
  isShutdownCheckingDrafts: () => shutdownCoordinator.isCheckingDrafts(),
  isQuitting: () => shutdownCoordinator.isQuitting(),
  isBackgroundInFlight: () => backgroundSettingsCoordinator.isInFlight(),
  readBlurState: () => ({
    caps: blurRuntime.caps,
    config: blurRuntime.config,
    initialized: blurRuntime.initialized
  }),
  initializeBlurRuntime,
  runBlurRuntimeOperation,
  applyResolvedWindowRuntime,
  restoreBlurForVisibleWindow,
  reassertBottomWindowZOrder,
  getDockDiagnosticSnapshot,
  revealPendingNotificationApplication,
  rebuildTrayMenu: () => mainTrayController.rebuild(),
  logger,
  rendererRoot: RENDERER_ROOT,
  isDev: is.dev
})
const {
  getActiveWindowName,
  getActiveWindowProfile,
  resolveActiveViewWindowBounds,
  getActiveRendererLocation,
  hideMainWindowForViewNavigation,
  switchMainView,
  switchMainViewFromTray
} = mainViewNavigation

const settingsApplicationCoordinator = createSettingsApplicationCoordinator({
  onLedgerChanged({ scopes }) {
    const source = settingsWriteSource.captureCurrent()
    const window = getMainWindow()
    if (
      !source ||
      !scopes.includes(source.scope) ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    )
      return
    try {
      window.webContents.send(
        'settings:application-changed',
        settingsApplicationStateForSource(settingsApplicationCoordinator, source)
      )
    } catch (error) {
      logger.warn('settings.application-state-delivery', '设置应用状态通知未发送', {
        error: error.message
      })
    }
  },
  getCurrentContext: () => ({
    scope: getActiveWindowName(),
    source: settingsWriteSource.captureCurrent()
  }),
  isContextCurrent: isSettingsApplicationContextCurrent,
  refreshResolvedSettings,
  dependencyApplies: (name, request) =>
    !name.startsWith('reset') ||
    request.reset ||
    (request.reason === 'retry' &&
      ['failed', 'deferred', 'unconfirmed'].includes(
        settingsApplicationCoordinator.snapshotLedger(request.scope)?.dependencies?.[name]?.status
      )),
  afterDomainDependencies: ['resetGeometry'],
  dependencies: {
    blurConfig: () => {
      syncBlurConfigFromResolved()
      return { status: 'applied', error: null, retryable: false }
    },
    theme: async (_request, guard) => {
      if (!guard.isCurrent())
        return { status: 'deferred', error: '设置页面已失效', retryable: true }
      if (!screenshotService?.host?.ready || screenshotService.stopping)
        return { status: 'deferred', error: '截图主题宿主尚未就绪', retryable: true }
      const result = await screenshotService.syncTheme()
      return result === false
        ? false
        : {
            status: 'unconfirmed',
            error: '截图主题已请求，宿主未提供应用确认',
            retryable: true,
            confirmation: 'invocation-only'
          }
    },
    remote: () => {
      if (!remoteCoordinator)
        return { status: 'deferred', error: '远程配置服务尚未就绪', retryable: true }
      const result = remoteCoordinator.settingsChanged()
      return result === false ? false : { status: 'applied', error: null, retryable: false }
    },
    resetBindings: applyResetShortcutBindings,
    resetGeometry: applyResetSettingsGeometry
  },
  applyDomains: {
    window: () => applyResolvedWindowRuntime(),
    blur: applyCommittedBlurRuntime,
    dock: ({ previousDockConfig, reset }) =>
      dockRuntime.applyDockRuntimeConfig(previousDockConfig, reset ? 'reset-settings' : 'persist')
  },
  retryDomains: {
    window: () => applyResolvedWindowRuntime(),
    blur: (_request, guard) =>
      observeAppliedBlurRuntime(blurRuntime.retryResolvedBlurRuntime(), guard),
    dock: () => dockRuntime.retryDockRuntimeConfig('settings-retry')
  },
  getResolvedSettingsSnapshot,
  broadcastSettingsChanged
})
const settingsWriteCoordinator = createSettingsWriteCoordinator({
  getActiveWindowName,
  refreshResolvedSettings,
  applyResolvedWindowRuntime,
  applyResolvedBlurRuntime,
  getDockRuntimeConfig,
  reconcileDockRuntimeConfig,
  getResolvedSettingsSnapshot,
  broadcastSettingsChanged,
  completeCommittedSettings: (request) =>
    settingsOperations.track(settingsApplicationCoordinator.completeCommittedSettings(request))
})
const { persistSettingValues, persistSettingValue } = settingsWriteCoordinator

function readMainSettingsContext() {
  const window = getMainWindow()
  return {
    scope: getActiveWindowName(),
    source: null,
    origin: 'main-runtime',
    runtimeToken:
      window && !window.isDestroyed()
        ? `main-window:${window.webContents.id}:${settingsWriteSource.readGeneration()}`
        : null
  }
}

function isSettingsApplicationContextCurrent(context) {
  if (context.scope !== getActiveWindowName()) return false
  if (context.origin === 'main-runtime') {
    const runtimeToken = readMainSettingsContext().runtimeToken
    return Boolean(context.source === null && runtimeToken && context.runtimeToken === runtimeToken)
  }
  const source = settingsWriteSource.captureCurrent()
  return Boolean(source && source.token === context.source?.token && source.scope === context.scope)
}

function settingsOperationForSource(source) {
  const context = { scope: source.scope, source: { token: source.token, scope: source.scope } }
  return { context, isCurrent: () => isSettingsApplicationContextCurrent(context) }
}

// These main-owned callers clear geometry/compact dirty flags when synchronous
// SQL commits. Application settlement is separately tracked through shutdown;
// an application/readback failure must not cause the same SQL to be written again.
function persistInternalSettingValues(entries, options = {}) {
  const completion = settingsWriteCoordinator.persistSettingValues(entries, {
    ...options,
    applicationContext: readMainSettingsContext()
  })
  void Promise.resolve(completion).catch((error) =>
    logger.error('settings.internal-application', error)
  )
  return { persistence: { status: 'saved' } }
}
const settingsWriteSource = createSettingsWriteSource({
  assertCanWrite: settingsOperations.assertOpen,
  getMainWindow,
  getActiveWindowName,
  getActiveRendererLocation
})
const wallpaperRetirement = createWallpaperRetirement({
  getMainWindow,
  isSourceCurrent(source) {
    const current = settingsWriteSource.captureCurrent()
    return Boolean(current && current.token === source?.token && current.scope === source?.scope)
  }
})
const draftAssetsRuntime = createSessionDraftAssetsRuntime({
  root: join(app.getPath('userData'), 'session-draft-assets'),
  sessionId: editingDraftSessionId,
  settingsWriteSource,
  imageReads: imageReadService,
  startImageRead: (source, options) => startImagePreviewRead(source, { app, ...options }),
  consumeAssets: (descriptors, request) => draftNoteCommands.consumeAssets(descriptors, request)
})
const draftNoteCommands = createSessionDraftNoteCommands({
  runtime: draftAssetsRuntime,
  createNoteWithAssets,
  saveNoteDraft,
  runMutation: businessAdmission.run,
  logger,
  onCommitted: (note, kind) => {
    try {
      featureRuntime.refreshReminders()
    } catch (error) {
      logger.error('draft-assets.note-reminders', error, { id: note.id })
    }
    for (const window of getApplicationWindows()) {
      try {
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send('notes:changed', {
            reason: kind === 'create' ? 'create' : 'update',
            id: note.id
          })
      } catch (error) {
        logger.error('draft-assets.note-broadcast', error, { id: note.id })
      }
    }
  }
})
let draftAssetsShutdown = null
let imageDecodesShutdown = null
const backgroundSettingsCoordinator = createBackgroundSettingsCoordinator({
  beginWallpaperRetirement: (source) => wallpaperRetirement.begin(source),
  getMainWindow,
  getSettings: () => settingsRuntime.values,
  getViewMode: () => mainViewNavigation.mode,
  getViewSettings,
  getActiveWindowName,
  refreshResolvedSettings,
  getResolvedSettingsSnapshot,
  broadcastSettingsChanged,
  persistSettingValues,
  readBlurState: () => ({
    config: blurRuntime.config,
    caps: blurRuntime.caps,
    initialized: blurRuntime.initialized,
    failed: blurRuntime.failed,
    error: blurRuntime.error,
    nativeError: blurRuntime.nativeError,
    diagnostic: blurRuntime.diagnostic
  }),
  setRequestedConfig: blurRuntime.setRequestedConfig,
  clearFailure: blurRuntime.clearFailure,
  disableConfig: blurRuntime.disableConfig,
  restoreFailure: blurRuntime.restoreFailure,
  initializeBlurRuntime,
  updateBlurDiagnostic,
  runBlurRuntimeDiagnostic,
  applicationOwnsBlurDiagnostic: true,
  notifySettled: () => mainViewNavigation.onBackgroundSettled()
})

/** FeatureRuntime owns service graphs and the complete partial-start disposal ledger. */
const featureRuntime = createFeatureRuntime({
  lifecycle: {
    powerMonitor,
    logger,
    integrationTest: process.env.ABANDON_INTEGRATION_TEST === '1'
  },
  reminders: {
    configuration: {
      protocol: APP_PROTOCOL,
      capability: SYSTEM_NOTIFICATION_CAPABILITY,
      icon,
      nativeImage: Electron.nativeImage,
      preloadPath: join(PRELOAD_ROOT, 'reminder.js'),
      rendererPath: RENDERER_ROOT,
      rendererUrl: is.dev ? process.env.ELECTRON_RENDERER_URL : null
    },
    ipcMain,
    windowPorts: {
      getMainWindow,
      getSettingsSnapshot: getResolvedSettingsSnapshot,
      onNoteChanged: (id) => {
        for (const window of getApplicationWindows())
          window.webContents.send('notes:changed', { reason: 'reminder', id })
      },
      onRemindersChanged: () => mainTrayController.rebuild()
    },
    activationPort: {
      reveal: revealApplicationFromNotification,
      attachAction: notificationActivation.attachReminderAction,
      detachAction: notificationActivation.detachReminderAction
    }
  },
  stickies: {
    configuration: {
      preloadPath: join(PRELOAD_ROOT, 'sticky.js'),
      rendererFile: join(RENDERER_ROOT, 'sticky.html'),
      rendererUrl:
        is.dev && process.env.ELECTRON_RENDERER_URL
          ? `${process.env.ELECTRON_RENDERER_URL}/sticky.html`
          : null,
      isDevelopment: is.dev
    },
    commands: {
      getNoteById,
      saveContent: saveStickyNoteContent,
      repository: {
        list: listDesktopStickyRecords,
        count: countDesktopStickyRecords,
        exists: hasDesktopStickyRecord,
        insert: insertDesktopStickyRecord,
        update: updateDesktopStickyRecord,
        delete: deleteDesktopStickyRecord,
        deleteAll: deleteAllDesktopStickyRecords
      }
    },
    windowPorts: {
      getMainWindow,
      getListAppearance: () => getViewSettings(VIEW_MODES.LIST).sticky,
      onRegistryChanged: () => mainTrayController.rebuild(),
      onNoteChanged: (note) => {
        for (const window of getApplicationWindows())
          window.webContents.send('notes:changed', { reason: 'update', id: note.id })
      },
      onError: (text) => {
        if (!getMainWindow() || getMainWindow().isDestroyed()) return
        getMainWindow().webContents.send('app:message', { type: 'error', text })
      }
    }
  },
  schedule: {
    admission: businessAdmission,
    commands: { activateNotes, runRecurringTemplates, runAutomaticNoteMove },
    getAutomaticNoteMoveEnabled: () => settingsRuntime.values.notes.autoMoveToToday,
    onNotesMoved: (result) => {
      for (const window of getApplicationWindows()) {
        try {
          window.webContents.send('notes:changed', {
            reason: 'automatic-historical-move',
            count: result.count
          })
        } catch (error) {
          logger.warn('notes.automatic-move-broadcast', error.message)
        }
      }
    },
    runtimeChecks: {
      blurDiagnostic: runBlurRuntimeDiagnostic,
      shouldCheckDockHealth: () =>
        dockRuntime.hidden ||
        dockRuntime.sliding ||
        dockRuntime.hasSession() ||
        Boolean(dockRuntime.cleanupStatus),
      dockHealthCheck: runDockHealthCheck
    }
  },
  weather: {
    configuration: { ipcMain, shell, userDataPath, appVersion: app.getVersion() },
    windowPorts: {
      getMainWindow,
      getWeatherSettings: () => structuredClone(settingsRuntime.values.weather),
      canPresentWeather: () =>
        Boolean(
          getMainWindow() &&
          !getMainWindow().isDestroyed() &&
          getMainWindow().isVisible() &&
          !getMainWindow().isMinimized() &&
          !isCompactPresentationActive()
        )
    },
    performancePort: { beginPerformanceOperation }
  }
})
const mainTrayController = createMainTrayController({
  Tray,
  Menu,
  icon,
  getShortcutsEnabled: () => settingsRuntime.shortcutsEnabled,
  getViewMode: () => mainViewNavigation.mode,
  getStickyCommands: featureRuntime.getStickyCommands,
  getCaptureCommands: () =>
    screenshotService
      ? Object.freeze({
          capture: (options) => screenshotService.capture(options),
          action: (...args) => screenshotService.action(...args),
          report: (error) => screenshotService?.report(error)
        })
      : null,
  showReminders: featureRuntime.showReminders,
  getReminderCount: featureRuntime.getReminderCount,
  toggleShortcuts: toggleGlobalShortcuts,
  acknowledgeReminders: featureRuntime.acknowledgeReminders,
  attachReminderTray: featureRuntime.attachReminderTray,
  setReminderBaseIcon: featureRuntime.setReminderBaseIcon,
  openMainWindow: openMainWindowFromTray,
  switchView: switchMainViewFromTray,
  toggleWindow,
  requestQuit: (trigger) => shutdownCoordinator.requestQuit(trigger),
  logger
})
const { rebuild: rebuildTrayMenu, menuTemplate: buildTrayMenuTemplate } = mainTrayController

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

/** 从 DB 重新生成完整设置；读取本身不向 DB 回写默认值。 */
function refreshResolvedSettings(options = {}) {
  return settingsRuntime.refresh(options)
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
  return { ...settingsRuntime.snapshot(), source: settingsWriteSource.captureCurrent() }
}

/** Read-only platform providers; this operation never starts or mutates a service. */
function readSettingsRuntimeSnapshot() {
  const autoStart = readAutoStartRuntime()
  const dockRuntime = getDockRuntimeConfig()
  const dockCapability = getDockRuntimeCapability()
  const blurRuntimeError =
    blurRuntime.failed ||
    (blurRuntime.config.enabled && blurRuntime.caps.supported && !blurRuntime.initialized)
      ? blurRuntime.error || '系统模糊引擎未加载（DLL 缺失或版本不兼容）'
      : null

  return {
    autoStart,
    shortcuts: {
      ...captureShortcutService?.snapshot(),
      viewVisibility: viewVisibilityShortcutService?.snapshot() || {
        configured: settingsRuntime.values.shortcuts?.viewVisibility || '',
        enabled: settingsRuntime.values.shortcuts?.enabled !== false,
        registered: false,
        capturing: false,
        error: null
      }
    },
    dock: {
      supported: dockCapability.supported,
      reason: dockCapability.reason,
      viewMode: mainViewNavigation.mode,
      supportedEdges: dockRuntime.supportedEdges,
      enabledEdges: dockRuntime.enabledEdges,
      activeEdges: dockRuntime.activeEdges,
      revealHandleMode: dockRuntime.revealHandleMode
    },
    blur: {
      supported: blurRuntime.caps.supported,
      platform: blurRuntime.caps.platform,
      strategy: blurRuntime.caps.strategy,
      initialized: blurRuntime.initialized,
      effectiveEnabled: Boolean(
        blurRuntime.caps.supported && blurRuntime.initialized && blurRuntime.config.enabled
      ),
      error: blurRuntimeError,
      nativeError: blurRuntimeError ? blurRuntime.nativeError : null,
      diagnostic: { ...blurRuntime.diagnostic }
    }
  }
}

function getViewSettings(viewMode) {
  return resolveSettingsRows(getAllSettings(getViewSettingsScope(viewMode)), viewMode)
}

function broadcastSettingsChanged(snapshot = getResolvedSettingsSnapshot()) {
  featureRuntime.settingsChanged()
  const payload = diagnosticBroadcast(snapshot)
  for (const window of getApplicationWindows()) {
    if (
      !window.webContents.isDestroyed() &&
      !window.webContents.isCrashed() &&
      !window.webContents.isLoadingMainFrame()
    ) {
      window.webContents.send('settings:changed', payload)
      checkpoint('broadcast.sent', {
        channel: 'settings:changed',
        webContentsId: window.webContents.id,
        revision: snapshot.revision
      })
    } else {
      checkpoint(
        'broadcast.skipped',
        { channel: 'settings:changed', webContentsId: window.webContents.id },
        { outcome: 'not-ready' }
      )
    }
  }
}

function sendAppMessage(type, text, duration = 2200) {
  if (!getMainWindow() || getMainWindow().isDestroyed() || !text) return
  getMainWindow().webContents.send('app:message', { type, text, duration })
}

const scheduleVisibleBlurRestore = createDeferredWindowRestore({
  canRestore: (window) => !window.isDestroyed() && window.isVisible() && window === getMainWindow(),
  restore: (window, source) => {
    const startedAt = performance.now()
    restoreBlurForVisibleWindow(window, source)
    logger.info('blur.visible-restore', '窗口显示后恢复毛玻璃', {
      source,
      deferred: true,
      elapsedMs: performance.now() - startedAt,
      enabled: blurRuntime.config.enabled,
      initialized: blurRuntime.initialized,
      failed: blurRuntime.failed
    })
  }
})

function applyResetSettingsGeometry({ reset }) {
  const window = getMainWindow()
  if (!window || window.isDestroyed())
    return { status: 'deferred', error: '主窗口尚未就绪', retryable: true }
  const display = screen.getDisplayMatching(window.getBounds())
  const geometry = settingsRuntime.values.geometry
  // An application retry follows the latest saved dimensions. Only a new reset
  // chooses default ratios; it must not replay an old reset over a later resize.
  const width = Math.round(
    !reset && geometry.width > 0 ? geometry.width : display.workAreaSize.width * geometry.widthRatio
  )
  const height = Math.round(
    !reset && geometry.height > 0
      ? geometry.height
      : display.workAreaSize.height * geometry.heightRatio
  )
  geometryPersistence.suppressUntil(Date.now() + 750)
  window.setSize(width, height)
  return window.getBounds().width === width && window.getBounds().height === height
    ? { status: 'applied', error: null, retryable: false }
    : { status: 'unconfirmed', error: '窗口尺寸尚未确认', retryable: true }
}

function applyResetShortcutBindings() {
  if (!viewVisibilityShortcutService || !captureShortcutService)
    return { status: 'deferred', error: '快捷键服务尚未就绪', retryable: true }
  viewVisibilityShortcutService.initialize(settingsRuntime.values.shortcuts.viewVisibility, {
    enabled: settingsRuntime.values.shortcuts.enabled
  })
  captureShortcutService.initialize(settingsRuntime.values.shortcuts)
  rebuildTrayMenu()
  const shortcuts = {
    ...captureShortcutService.snapshot(),
    viewVisibility: viewVisibilityShortcutService.snapshot()
  }
  const failures = unavailableShortcuts(shortcuts)
  if (failures.length)
    return {
      status: 'failed',
      error: failures.map((item) => item.message).join('；'),
      retryable: true,
      shortcuts
    }
  if (
    Object.values(shortcuts).some(
      (state) => state?.enabled && state.configured && !state.registered
    )
  )
    return { status: 'deferred', error: '快捷键注册尚未确认', retryable: true, shortcuts }
  return { status: 'applied', error: null, retryable: false, shortcuts }
}

function observeAppliedBlurRuntime(result, guard) {
  if (!guard.isCurrent())
    return { status: 'deferred', error: '设置请求所属页面已失效', retryable: true }
  if (blurRuntime.config.enabled && blurRuntime.initialized) {
    runBlurRuntimeDiagnostic({ reason: 'settings-change', now: Date.now() })
    if (
      blurRuntime.failed ||
      !blurRuntime.config.enabled ||
      blurRuntime.diagnostic.status === 'error'
    )
      return { status: 'failed', error: blurRuntime.error || '原生模糊运行期失效', retryable: true }
    if (blurRuntime.diagnostic.status !== 'healthy')
      return {
        status: 'unconfirmed',
        error: blurRuntime.diagnostic.message || '原生模糊状态尚未确认',
        retryable: true
      }
  }
  return result
}

function applyCommittedBlurRuntime(request, guard) {
  if (!guard.isCurrent())
    return { status: 'deferred', error: '设置请求所属页面已失效', retryable: true }
  const result = request.applyBlurRuntime
    ? applyResolvedBlurRuntime()
    : { status: 'unconfirmed', error: '首次原生配置未提供独立应用确认', retryable: true }
  return observeAppliedBlurRuntime(result, guard)
}

function applyResolvedWindowRuntime() {
  isLocked = settingsRuntime.values.window.lockState
  // 锁定或视图刷新可能在异步层级核验期间读取旧设置；保留正在提交的目标层级。
  zOrderRuntime.syncResolved()
  if (!getMainWindow() || getMainWindow().isDestroyed())
    return { status: 'deferred', error: '主窗口尚未就绪', retryable: true }
  getMainWindow().setMovable(!isLocked)
  // Windows 使用 thickFrame:false + renderer 自定义缩放手柄。调用
  // setResizable(true) 会重新引入系统 WS_THICKFRAME，破坏高 DPI 几何不变量。
  const result = applyWindowZOrder()
  if (!result.success) {
    logger.error('window.z-order', new Error(result.error), {
      mode: zOrderRuntime.mode,
      code: result.code,
      diagnosticId: result.diagnosticId ?? null,
      source: 'resolved-settings'
    })
    if (zOrderRuntime.mode === WINDOW_Z_ORDER_MODES.BOTTOM) {
      scheduleBottomWindowZOrderRetry('resolved-settings', result)
    } else {
      sendAppMessage('error', result.error)
    }
  }
  return {
    ...result,
    status: result.success && getMainWindow().isMovable() === !isLocked ? 'applied' : 'failed',
    error: result.success
      ? getMainWindow().isMovable() === !isLocked
        ? null
        : '窗口锁定状态尚未确认'
      : result.error,
    retryable: !result.success || getMainWindow().isMovable() !== !isLocked
  }
}

/**
 * 创建主窗口
 * - 根据数据库中保存的位置/尺寸恢复窗口状态
 * - 若无保存记录，则使用默认值（屏幕左侧 25% 宽度、90% 高度）
 * - 窗口无边框 + 透明背景，用于实现自定义外观
 */
function createWindow({ preferredDisplay = null } = {}) {
  const creationStartedAt = Date.now()
  // 日历视图首次创建优先沿用列表所在显示器；已有几何信息时仍以持久化位置为准。
  const {
    bounds: normalBounds,
    requestedBounds,
    targetDisplay,
    saved
  } = resolveActiveViewWindowBounds({ preferredDisplay })
  const bounds = normalBounds

  // 创建主窗口实例（透明背景 + CSS 圆角）
  mainWindowHost.create({
    ...bounds,
    minWidth: MAIN_WINDOW_MIN_SIZE,
    minHeight: MAIN_WINDOW_MIN_SIZE,
    show: false,
    frame: false,
    transparent: true,
    // Windows 的默认 thickFrame 会给无边框窗口保留不可见 resize inset。
    // 项目已有自定义缩放手柄，不需要让该 inset 参与高 DPI 边界换算。
    thickFrame: false,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(PRELOAD_ROOT, 'index.js'),
      additionalArguments: [`--editing-draft-session=${editingDraftSessionId}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 主视图在窗口缩放期间保持持续合成。
      backgroundThrottling: false
    }
  })
  const createdWindow = getMainWindow()
  presentationRuntime.initialize(getMainWindow(), normalBounds)
  mainViewNavigation.setPresentationTiming({
    creationStartedAt,
    createdAt: Date.now(),
    loadRequestedAt: null,
    loadStartedAt: null,
    rendererReadyAt: null,
    displayId: targetDisplay.id,
    displayScaleFactor: targetDisplay.scaleFactor
  })
  installRendererRecovery(createdWindow, {
    dialog,
    logger,
    openDiagnostics: () => shell.openPath(getLogDirectory()),
    canRecover: () =>
      !shutdownCoordinator.isQuitting() &&
      !mainViewNavigation.isSwitching() &&
      mainViewNavigation.hasAcceptedReady(createdWindow),
    onRendererReset: (reason) => {
      try {
        endTitlebarWindowDrag({ reason })
      } finally {
        endCompactWindowDrag()
      }
    },
    restart: () => {
      app.relaunch()
      app.quit()
    }
  })
  const mainSession = getMainWindow().webContents.session
  const allowMainWindowGeolocation = (webContents, permission) =>
    (permission === 'geolocation' || permission === 'geolocation-approximate') &&
    webContents === getMainWindow()?.webContents
  const allowMainWindowImageWrite = (webContents, permission, details) =>
    allowImageClipboardWrite({
      webContents,
      permission,
      details,
      mainWindow: getMainWindow(),
      isTrustedDocumentUrl(value) {
        const location = getActiveRendererLocation()
        const expected = new URL(
          location.type === 'file' ? pathToFileURL(location.value).href : location.value
        )
        const actual = new URL(value)
        expected.hash = ''
        actual.hash = ''
        return actual.href === expected.href
      }
    })
  // 图片写入仅属于当前可信主页面；剪贴板读取和其他 Web API 权限仍拒绝。
  mainSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) =>
      allowMainWindowGeolocation(webContents, permission) ||
      allowMainWindowImageWrite(webContents, permission, details)
  )
  mainSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed =
      allowMainWindowGeolocation(webContents, permission) ||
      allowMainWindowImageWrite(webContents, permission, details)
    if (permission === 'geolocation' || permission === 'geolocation-approximate') {
      logger.info(
        'weather.location-permission',
        allowed ? '已允许设备定位权限' : '已拒绝设备定位权限',
        {
          permission,
          allowed
        }
      )
    }
    callback(allowed)
  })
  setWindowLogContext(getMainWindow(), { role: getActiveWindowProfile().logRole })
  geometryPersistence.setStableBounds({ ...normalBounds })
  dockRuntime.attachWindow(getMainWindow())

  // 固定缩放因子为 1.0，防止系统 DPI 缩放影响布局
  getMainWindow().webContents.setZoomFactor(1.0)
  logger.info('startup.window-presentation', '主窗口已创建并等待渲染就绪', {
    viewMode: mainViewNavigation.mode,
    creationMs: mainViewNavigation.presentationTiming.createdAt - creationStartedAt,
    savedGeometry: saved,
    requestedBounds,
    constrainedExpandedBounds: normalBounds,
    initialBounds: getMainWindow().getBounds(),
    initialContentBounds: getMainWindow().getContentBounds(),
    initialDisplay: {
      id: targetDisplay.id,
      scaleFactor: targetDisplay.scaleFactor,
      scalePercent: targetDisplay.scaleFactor * 100,
      bounds: targetDisplay.bounds,
      workArea: targetDisplay.workArea
    },
    rendererZoomFactor: getMainWindow().webContents.getZoomFactor(),
    blur: {
      configuredEnabled: blurRuntime.config.enabled,
      supported: blurRuntime.caps.supported
    }
  })
  getMainWindow().webContents.on('did-start-loading', () => {
    if (getMainWindow() === createdWindow) {
      if (mainViewNavigation.presentationTiming)
        mainViewNavigation.recordTiming('loadStartedAt', Date.now())
    }
  })

  // 从完整设置快照恢复锁定状态
  isLocked = settingsRuntime.values.window.lockState
  if (isLocked) {
    getMainWindow().setMovable(false)
    // Windows 的用户缩放已经由 thickFrame:false 和 renderer 自定义手柄控制；
    // 保留程序化 resize，供恢复默认尺寸等受控窗口操作使用。
  }
  // ---- 初始化系统模糊 ----
  if (blurRuntime.caps.supported) {
    const result = initializeBlurRuntime()
    if (result.success) {
      console.log('[blur] 系统模糊已初始化, 策略:', result.strategy)
      // 历史版本可能同时留下两项启用状态；启动时以已实际生效的原生玻璃为准。
      if (blurRuntime.config.enabled && settingsRuntime.values.wallpaper.enabled) {
        setSettingsBatch(getActiveWindowName(), [serializeSetting('wallpaper.enabled', false)])
        refreshResolvedSettings({ incrementRevision: true })
      }
    } else {
      console.warn('[blur] 初始化失败:', result.error, result.nativeError || '')
      // 启动失败不能继续保存“已开启”，否则下次打开设置会造成状态误导。
      if (blurRuntime.config.enabled) {
        setSettingsBatch(getActiveWindowName(), [serializeSetting('blur.enabled', false)])
        refreshResolvedSettings({ incrementRevision: true })
      }
    }
  } else {
    console.log('[blur] 当前平台不支持系统模糊:', blurRuntime.caps.reason)
  }

  // 拦截新窗口打开请求，改为使用系统默认浏览器打开链接
  getMainWindow().webContents.setWindowOpenHandler((details) => {
    openSafeExternal(details.url)
    return { action: 'deny' } // 拒绝在应用内打开新窗口
  })
  getMainWindow().webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openSafeExternal(url)
  })

  // 监听窗口大小变化和移动事件，触发防抖保存
  getMainWindow().on('resize', () => {
    if (dockRuntime.isMoving()) return
    if (presentationRuntime.handleResize(getMainWindow().getBounds())) return
    debouncedSaveGeometry()
    syncVisibleDockSide({ source: 'window-resize' })
  })
  getMainWindow().on('move', () => {
    if (dockRuntime.isMoving()) return
    if (windowDragController.isActive()) return
    debouncedSaveGeometry()
  })

  // 【贴边隐藏 - 边缘检测】窗口移动时检测是否靠近屏幕左/右边缘
  getMainWindow().on('move', () => {
    if (dockRuntime.isMoving()) return
    if (windowDragController.isActive()) return
    syncVisibleDockSide({ source: 'window-move', snap: true })
  })

  // Windows 原生拖动可能在首次进入阈值后继续把窗口带出屏幕；move 阶段已经
  // 记录了 dockSide，但不能持续抢夺系统拖动。等用户松手后再做一次强制收口，
  // 即使方向未变化，也把窗口吸回精确边缘。
  getMainWindow().on('moved', () => {
    if (dockRuntime.isMoving()) return
    if (windowDragController.isActive()) return
    syncVisibleDockSide({ source: 'window-moved', snap: true, forceSnap: true })
  })

  // 拦截窗口关闭事件：最小化到托盘而非退出
  getMainWindow().on('close', (e) => {
    if (!shutdownCoordinator.isQuitting() && !mainViewNavigation.isSwitching()) {
      e.preventDefault()
      hideToTray()
    }
  })

  // 窗口显示时恢复模糊（从托盘恢复）
  getMainWindow().on('show', () => {
    scheduleVisibleBlurRestore(getMainWindow(), 'main-window-show')
  })

  // 启动恢复、托盘/通知唤醒和视图切换都可能直接把窗口放回已保存的
  // 边缘位置，却不会产生可靠的用户 move 事件。显示后主动重建可见态贴边方向。
  getMainWindow().on('show', () => {
    if (getMainWindow() !== getActiveVisualWindow()) return
    syncVisibleDockSide({ source: 'window-show', snap: true })
    reassertBottomWindowZOrder('window-show')
  })

  getMainWindow().on('minimize', () => {
    if (!isDockTransitionActive()) return
    logger.info('dock.window-minimized', '贴边会话进入系统最小化状态，暂停几何健康判断', {
      snapshot: getDockDiagnosticSnapshot()
    })
  })

  getMainWindow().on('restore', () => {
    if (!isDockTransitionActive()) return
    logger.info('dock.window-restored', '贴边会话已退出系统最小化状态，重新校验真实边界', {
      snapshot: getDockDiagnosticSnapshot()
    })
    setImmediate(runDockHealthCheck)
  })

  // 窗口销毁时清除引用和贴边资源
  mainWindowHost.installClosedCleanup(getMainWindow(), () => {
    // 只清理由 createWindow 创建并仍被主进程持有的唯一主窗口。
    if (getMainWindow() !== createdWindow) return
    mainViewNavigation.releaseWindow(createdWindow)
    presentationRuntime.releaseWindow(createdWindow)
    cancelBottomWindowZOrderRetry()
    windowDragController.releaseWindow(createdWindow)
    dockRuntime.releaseWindow(createdWindow)
    geometryPersistence.setStableBounds(null)
  })

  // Service bootstrap and renderer readiness have separate owners. Register the
  // bounded startup owner before requesting the first document, without holding quit.
  void mainViewNavigation.startInitialView(createdWindow)
  revealPendingNotificationApplication()
}

// ============================================================
// 托盘隐藏（窗口关闭 → 最小化到托盘，统一入口）
// ============================================================

/** 窗口关闭/隐藏时统一执行：隐藏窗口 + 清理贴边 + 禁用系统模糊 */
function hideToTray() {
  const visualWindow = getActiveVisualWindow()
  if (!visualWindow || visualWindow.isDestroyed()) return
  mainViewNavigation.noteWindowHiddenByUser(visualWindow)
  notificationActivation.cancelPendingReveal('user-hide')

  // Blur_ApplyConfig 要求完整材质配置，不能只传 { enabled: false }。
  // 先隐藏 Overlay 再隐藏 Electron，避免异常中断后留下孤立模糊窗口。
  if (blurRuntime.initialized) {
    runBlurRuntimeOperation(
      () => blurSetConfig({ ...blurRuntime.config, enabled: false }),
      '隐藏窗口前关闭毛玻璃层'
    )
  }

  for (const window of getApplicationWindows()) window.hide()
  restoreDockWindowToVisiblePosition()
  resetDockState()
}

// ============================================================
// 窗口切换（托盘点击）
// ============================================================

/**
 * 托盘点击统一切换逻辑：
 * - 贴边隐藏 → 滑出（doShow）
 * - 贴边可见 → 滑入（doHide）
 * - 正常层级被其他窗口遮住、最小化或隐藏 → 恢复并激活
 * - 已在前台 → 隐藏到托盘（贴边时滑入）
 */
function toggleWindow(source = 'tray-click') {
  const visualWindow = getActiveVisualWindow()
  if (!visualWindow || visualWindow.isDestroyed()) return
  if (mainViewNavigation.isAwaitingFirstReady(getMainWindow())) {
    void openMainWindow()
    return
  }
  if (shutdownCoordinator.isQuitting() || !mainViewNavigation.isReadyDocument(getMainWindow()))
    return
  logger.info('window.visibility-toggle', '用户切换主窗口显示状态', {
    source,
    focused: getMainWindow().isFocused(),
    snapshot: getDockDiagnosticSnapshot()
  })

  // Visible includes covered and minimized windows. A show request must reveal
  // these in one action, without changing the user's persistent z-order mode.
  if (
    getMainWindow().isMinimized() ||
    (!dockRuntime.hidden &&
      zOrderRuntime.mode === WINDOW_Z_ORDER_MODES.NORMAL &&
      getMainWindow().isVisible() &&
      !getMainWindow().isFocused())
  ) {
    openMainWindow()
    return
  }

  // 原生线程延迟清理期间不允许重新贴边，但托盘的基本显示/隐藏必须仍然可用。
  if (dockRuntime.cleanupStatus) {
    if (getMainWindow().isVisible()) hideToTray()
    else openMainWindow()
    return
  }

  if (dockRuntime.hidden) {
    const request = captureMainOpenRequest()
    doShow(source)
    if (canPresentMainOpenRequest(request)) focusMainWindow(source, request)
    return
  }
  // 托盘点击可能晚于移动、显示或设置事件；选择“滑入”前以实时几何和
  // 当前 activeEdges 深度复验，避免陈旧 dockSide 吞掉本次托盘操作。
  if (getMainWindow().isVisible() && !dockRuntime.sliding && !dockRuntime.hasSession()) {
    syncVisibleDockSide({ source: 'tray-toggle', snap: true })
  }
  // 锁定时禁用贴边滑入：托盘点击退回普通“隐藏到托盘”行为，不再滑向屏幕边缘。
  if (dockRuntime.side && !isLocked) {
    cancelPendingDockHide('tray-hide')
    doHide()
    return
  }
  if (getMainWindow().isVisible()) {
    hideToTray()
  } else {
    openMainWindow()
  }
}

function handleViewVisibilityShortcut() {
  const reason = shutdownCoordinator.isQuitting()
    ? 'quitting'
    : mainViewNavigation.isSwitching()
      ? 'switching-view'
      : captureWindowIntegration.isActive()
        ? 'screenshot'
        : null
  const metadata = {
    action: reason ? 'ignored' : 'toggle',
    reason,
    visible: Boolean(
      getMainWindow() && !getMainWindow().isDestroyed() && getMainWindow().isVisible()
    ),
    dockHidden: dockRuntime.hidden
  }
  if (reason) {
    logger.info('shortcut.view-visibility-trigger', '显示/隐藏快捷键触发被忽略', metadata)
    return
  }
  logger.info('shortcut.view-visibility-trigger', '显示/隐藏快捷键已触发', metadata)
  toggleWindow('view-visibility-shortcut')
}

function focusMainWindow(source, request = null) {
  if (!getMainWindow() || getMainWindow().isDestroyed()) return
  if (request && !canPresentMainOpenRequest(request)) return
  if (zOrderRuntime.mode !== WINDOW_Z_ORDER_MODES.BOTTOM) getMainWindow().moveTop()
  if (request && !canPresentMainOpenRequest(request)) return
  getMainWindow().focus()
  if (request && !canPresentMainOpenRequest(request)) return
  reassertBottomWindowZOrder(source)
}

let mainOpenSequence = 0
function captureMainOpenRequest() {
  return {
    id: ++mainOpenSequence,
    window: getMainWindow(),
    documentGeneration: settingsWriteSource.readGeneration(),
    hideGeneration: mainViewNavigation.getUserHideGeneration()
  }
}

function canPresentMainOpenRequest(request) {
  return (
    ownsMainOpenRequest(request) &&
    mainViewNavigation.isReadyDocument(request.window) &&
    request.documentGeneration === settingsWriteSource.readGeneration()
  )
}

function ownsMainOpenRequest(request) {
  return (
    !shutdownCoordinator.isQuitting() &&
    (!request.isCurrent || request.isCurrent()) &&
    !mainViewNavigation.snapshot().stopped &&
    request.id === mainOpenSequence &&
    request.window === getMainWindow() &&
    request.window &&
    !request.window.isDestroyed() &&
    request.hideGeneration === mainViewNavigation.getUserHideGeneration()
  )
}

function openMainWindow(request = captureMainOpenRequest()) {
  if (!ownsMainOpenRequest(request)) return false
  const startup = mainViewNavigation.requestInitialOpen(request.window)
  if (startup !== null)
    return startup.then(
      (shown) =>
        ownsMainOpenRequest(request) && mainViewNavigation.isReadyDocument(request.window) && shown
    )
  if (!canPresentMainOpenRequest(request)) return false
  if (request.window.isMinimized()) request.window.restore()
  if (!canPresentMainOpenRequest(request)) return false
  if (dockRuntime.hidden) {
    doShow('open-main-window')
  } else {
    request.window.show()
    if (!canPresentMainOpenRequest(request)) return false
    syncVisibleDockSide({ source: 'open-main-window', snap: true })
  }
  if (!canPresentMainOpenRequest(request)) return false
  focusMainWindow('open-main-window', request)
  return canPresentMainOpenRequest(request) && request.window.isVisible()
}

async function openMainWindowFromTray({
  source = 'tray-open',
  allowExpandFallback = false,
  isCurrent = null
} = {}) {
  const request = captureMainOpenRequest()
  request.isCurrent = isCurrent
  if (!ownsMainOpenRequest(request)) return false
  const startup = mainViewNavigation.requestInitialOpen(request.window)
  if (startup !== null)
    return (
      (await startup) &&
      ownsMainOpenRequest(request) &&
      mainViewNavigation.isReadyDocument(request.window)
    )
  try {
    await exitCompactPresentation({ source, showWhenDone: false })
  } catch (error) {
    if (!allowExpandFallback) throw error
    logger.error('notification.expand', error)
  }
  if (!canPresentMainOpenRequest(request)) return false
  return openMainWindow(request)
}

const confirmEditingDrafts = createEditingDraftGuard({
  logger,
  prepareSettingsOperations: settingsOperations.sealAndDrain,
  resumeSettingsOperations: settingsOperations.resume,
  reveal: async (window, canContinue) => {
    if (window !== getMainWindow() || window.isDestroyed()) throw new Error('主窗口已变化')
    // The existing page-leave owner may need to reveal a document that was
    // exposed before startup presentation failed. Ordinary open would retry
    // loading and recursively ask this same guard. Keep this original page.
    const request = captureMainOpenRequest()
    const contents = window.webContents
    const frame = contents.mainFrame
    const assertOwned = () => {
      if (
        !canContinue() ||
        !ownsMainOpenRequest(request) ||
        request.documentGeneration !== settingsWriteSource.readGeneration() ||
        contents.isDestroyed() ||
        contents.isCrashed() ||
        contents.mainFrame !== frame ||
        !frame ||
        frame.isDestroyed() ||
        frame.detached
      )
        throw new Error('草稿确认所属页面或显示请求已失效')
    }
    assertOwned()
    if (window.isMinimized()) window.restore()
    assertOwned()
    if (dockRuntime.hidden) doShow('draft-guard')
    else window.show()
    assertOwned()
    syncVisibleDockSide({ source: 'draft-guard', snap: true })
    assertOwned()
    if (zOrderRuntime.mode !== WINDOW_Z_ORDER_MODES.BOTTOM) window.moveTop()
    assertOwned()
    window.focus()
    assertOwned()
    reassertBottomWindowZOrder('draft-guard')
    assertOwned()
    if (!window.isVisible()) throw new Error('草稿确认窗口未能显示')
  }
})

function toggleGlobalShortcuts() {
  try {
    settingsOperations.assertOpen()
    const enabled = settingsRuntime.setShortcutsEnabled(!settingsRuntime.shortcutsEnabled)
    if (captureShortcutService) captureShortcutService.setEnabled(enabled)
    else viewVisibilityShortcutService?.setEnabled(enabled)
    broadcastSettingsChanged(getResolvedSettingsSnapshot())
    rebuildTrayMenu()
  } catch (error) {
    logger.error('shortcuts.toggle', error)
    dialog.showErrorBox('无法修改快捷键开关', '快捷键状态切换失败，请重试。')
  }
}

if (process.env.ABANDON_INTEGRATION_TEST === '1') {
  globalThis.__ABANDON_WINDOW_TEST_HOOKS__ = Object.freeze({
    switchMainView,
    switchMainViewFromTray,
    openMainWindowFromTray,
    enterCompactPresentation,
    exitCompactPresentation,
    getPresentationModeState: presentationModeSnapshot,
    dockCommands: Object.freeze({
      syncVisible: dockRuntime.syncVisibleDockSide,
      hide: dockRuntime.doHide,
      show: dockRuntime.doShow,
      suspend: dockRuntime.beginDockInteractionSuspension,
      resume: dockRuntime.endDockInteractionSuspension,
      retrySettings: dockRuntime.retryDockRuntimeConfig,
      snapshot: dockRuntime.getDockDiagnosticSnapshot,
      resources: dockRuntime.resourceSnapshot
    }),
    getDockRuntimeState: () => ({
      ...getDockDiagnosticSnapshot(),
      interactionSuspendCount: dockRuntime.suspendCount,
      screenshotCaptureActive: captureWindowIntegration.isActive(),
      locked: isLocked
    }),
    handleDisplayTopologyChange: handleDockDisplayTopologyChange,
    getBlurRuntimeHealth: () => (blurRuntime.initialized ? getBlurRuntimeHealth() : null),
    applyResolvedBlurRuntime,
    retryResolvedBlurRuntime: blurRuntime.retryResolvedBlurRuntime,
    getWindowZOrderStatus: captureTitlebarZOrderStatus,
    triggerViewVisibilityShortcut: () => viewVisibilityShortcutService?.handleTrigger(),
    triggerNewNoteShortcut: () => captureShortcutService?.services.newNote.handleTrigger(),
    triggerTrayClick: mainTrayController.triggerClick,
    getTrayMenuTemplate: buildTrayMenuTemplate,
    getReminderService: featureRuntime.observeRemindersForIntegration,
    featureState: featureRuntime.snapshot,
    businessMutationState: businessAdmission.snapshot,
    draftAssetState: draftAssetsRuntime.snapshot,
    settingsOperationState: settingsOperations.snapshot,
    getResolvedSettingsSnapshot,
    runSettingsOperationForIntegration: settingsOperations.run,
    backgroundSettingsState: backgroundSettingsCoordinator.snapshot,
    wallpaperRetirementState: wallpaperRetirement.snapshot,
    navigationState: mainViewNavigation.snapshot,
    notificationActivationState: notificationActivation.snapshot,
    handleNotificationProtocol,
    trayState: mainTrayController.snapshot,
    trayMenu: mainTrayController.menuTemplate,
    shutdownState: () => shutdownCoordinator.snapshot(),
    triggerScreenshotShortcut: (action = 'screenshot') =>
      ['screenshot', 'screenshotCopy'].includes(action)
        ? captureShortcutService?.services[action].handleTrigger()
        : undefined,
    startNativeCapture: () => screenshotService?.capture(),
    captureCoordinator: () => screenshotService,
    nativeCaptureState: () => ({
      ready: screenshotService?.host?.ready,
      pid: screenshotService?.host?.pid,
      active: Boolean(screenshotService?.active)
    })
  })
}

// ============================================================
// 应用就绪后的初始化逻辑
// ============================================================
const applicationBootstrap = createApplicationBootstrap({
  whenReady: () => app.whenReady(),
  start: async ({ runStage, checkpoint: checkStartup }) => {
    if (!gotSingleInstanceLock) return

    if (
      !enforceNativeRuntimeCompatibility({
        getCompatibility: getNativeRuntimeCompatibility,
        logger,
        dialog,
        flushLogs,
        exit: (code) => app.exit(code)
      })
    ) {
      return
    }

    // 初始化数据库连接
    const { isNewDatabase } = await runStage('database', () =>
      initDatabase({ userDataPath: app.getPath('userData') })
    )
    logger.info('startup', '数据库初始化完成', { isNewDatabase })
    await runStage('draft-assets', () => draftAssetsRuntime.initialize())
    if (isNewDatabase) {
      createNote({
        content:
          '欢迎使用 Abandon Note！\n\n你可以点击上方输入框快速新建便签，也可以点击这条示例便签体验编辑、提醒、标签和桌面便利贴功能。'
      })
    }
    appUpdateService = new AppUpdateService({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      checkEnabled: process.env.ABANDON_INTEGRATION_TEST !== '1'
    })
    try {
      await runStage('storage-recovery', () =>
        settleStartupRecoveries([
          () =>
            cleanupPendingAttachmentDirs({
              onRecovery: (metadata) =>
                logger.info('storage.attachment-recovery', '附件存储恢复补偿已执行', metadata)
            }),
          () =>
            cleanupPendingWallpaperFiles({
              onRecovery: (metadata) =>
                logger.info('storage.wallpaper-recovery', '壁纸存储恢复补偿已执行', metadata)
            })
        ])
      )
    } catch (error) {
      console.warn('[storage] 恢复未完成的存储操作失败:', error)
    }
    checkStartup()
    mainViewNavigation.initializeActiveView(readApplicationSettings().activeView)
    ensureViewSettingsInitialized(mainViewNavigation.mode)
    ensureApplicationWindowSettingsInitialized(mainViewNavigation.mode)
    settingsRuntime.resetForView(mainViewNavigation.mode)
    refreshResolvedSettings({ incrementRevision: true })
    viewVisibilityShortcutService = new ViewVisibilityShortcutService({
      globalShortcut,
      onTrigger: handleViewVisibilityShortcut,
      logger
    })
    viewVisibilityShortcutService.initialize(settingsRuntime.values.shortcuts.viewVisibility, {
      enabled: settingsRuntime.values.shortcuts.enabled
    })
    handleProtocolArgs(process.argv)

    // 监听新窗口创建事件，自动注册快捷键优化器
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
      attachWindowLogging(window)
    })

    // ---- IPC 通道注册 ----
    const mainWindowIpc = createMainWindowIpc(ipcMain, () => getMainWindow())
    mainWindowIpc.handle('settings:write-context', (event) => settingsWriteSource.issue(event))
    registerDraftAssetsIpc({
      ipcMain,
      runtime: draftAssetsRuntime,
      noteCommands: draftNoteCommands,
      logger
    })

    const performanceDiagnostics = startPerformanceDiagnostics({
      app,
      powerMonitor,
      writeLog,
      readNativeState: captureTitlebarZOrderStatus,
      readWindowState: () => {
        const window = getActiveVisualWindow()
        if (!window || window.isDestroyed()) return null
        const display = screen.getDisplayMatching(window.getBounds())
        return {
          id: window.id,
          webContentsId: window.webContents.id,
          rendererPid: window.webContents.getOSProcessId(),
          viewMode: mainViewNavigation.mode,
          visible: window.isVisible(),
          minimized: window.isMinimized(),
          focused: window.isFocused(),
          zOrderMode: zOrderRuntime.mode,
          blurEnabled: blurRuntime.config.enabled,
          wallpaperEnabled: Boolean(
            settingsRuntime.values.wallpaper.enabled &&
            settingsRuntime.values.wallpaper.activeId &&
            !blurRuntime.config.enabled
          ),
          wallpaperBlurRadius: settingsRuntime.values.wallpaper.blurRadius,
          displayId: display.id,
          displayFrequency: display.displayFrequency,
          scaleFactor: display.scaleFactor
        }
      }
    })

    diagnosticController = registerDiagnosticController({
      ipcMain,
      controls: mainWindowIpc,
      BrowserWindow,
      observeRenderer: performanceDiagnostics.observeRenderer,
      flushPerformance: (requestId) => performanceDiagnostics.flush(requestId)
    })

    const disposeLoggingIpc = registerLoggingIpc({
      mainWindowIpc,
      getAttachmentRecoveryReport,
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      getWindow: getMainWindow,
      dialog,
      shell,
      diagnosticController,
      logStore: {
        queryLogs,
        flushLogs,
        freezeLogSnapshot,
        releaseLogSnapshot,
        getLogDirectory,
        exportLogs
      },
      collectSystemDiagnostics: () =>
        collectSystemDiagnostics({
          app,
          screen,
          windows: getApplicationWindows(),
          runtime: {
            activeViewMode: mainViewNavigation.mode,
            blur: { ...blurRuntime.config, initialized: blurRuntime.initialized },
            native: getNativeRuntimeCompatibility(),
            dock: getDockDiagnosticSnapshot(),
            performance: performanceDiagnostics.snapshot()
          }
        }),
      getCrashDumpsPath: () => app.getPath('crashDumps'),
      refreshCrashDumpIndex,
      logger
    })
    app.once('will-quit', disposeLoggingIpc)

    const attachmentRecoveryRetry = createAttachmentRecoveryRetryController({
      businessAdmission,
      draftAssetsRuntime,
      canStart: () =>
        !shutdownCoordinator.isQuitting() &&
        !shutdownCoordinator.isCheckingDrafts() &&
        !mainViewNavigation.isSwitching() &&
        mainViewNavigation.isReadyDocument(getMainWindow()) &&
        Boolean(getDb()) &&
        getDb().open !== false,
      getSource: () => ({
        connection: getDb(),
        profile: resolve(app.getPath('userData')).toLowerCase(),
        window: getMainWindow()
      }),
      isSourceCurrent: (source) =>
        source.connection === getDb() &&
        source.connection?.open !== false &&
        source.profile === resolve(app.getPath('userData')).toLowerCase() &&
        source.window === getMainWindow() &&
        !source.window?.isDestroyed(),
      recover: () =>
        cleanupPendingAttachmentDirs({
          onRecovery: (metadata) =>
            logger.info('storage.attachment-recovery', '手动附件存储恢复已执行', metadata)
        }),
      getReport: getAttachmentRecoveryReport,
      onError: (error) => logger.error('storage.attachment-recovery-retry', error)
    })
    const disposeAttachmentRecoveryRetry = registerAttachmentRecoveryRetryIpc({
      mainWindowIpc,
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      retry: attachmentRecoveryRetry.retry
    })
    app.once('will-quit', disposeAttachmentRecoveryRetry)

    // ---- 应用更新（检查版本后，通过浏览器直链或对应标签页下载） ----
    // renderer 只能选择固定目标；实际 URL 来自主进程刚完成的更新检查。
    const disposeAppIpc = registerAppIpc({
      mainWindowIpc,
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      app,
      shell,
      appUpdateService
    })
    app.once('will-quit', disposeAppIpc)

    // 【渲染就绪】渲染进程初始化完成后发送此消息，主进程收到后显示窗口
    ipcMain.on('renderer-ready', (event, { viewMode } = {}, source) => {
      let document
      try {
        document = settingsWriteSource.assertDocument(event, source)
      } catch (error) {
        logger.warn('renderer.ready-stale', '忽略已失效页面的主视图就绪消息', {
          viewMode,
          code: error.code
        })
        return
      }
      mainViewNavigation.handleRendererReady(event.sender, viewMode, document)
    })

    ipcMain.on('presentation-mode:renderer-ready', (event, { operationId } = {}) => {
      if (event.sender !== getMainWindow()?.webContents) return
      acknowledgePresentationRenderer(operationId)
    })

    // 【窗口控制 - 关闭】渲染进程请求关闭窗口 → 最小化到托盘
    ipcMain.on('window-close', (event) => {
      if (event.sender !== getMainWindow()?.webContents) return
      hideToTray()
    })

    // 先回复当前页面，再在下一轮事件循环中使用同一个 BrowserWindow 加载目标页面。
    mainWindowIpc.handle('view:switch', (event, { mode } = {}) =>
      mainViewNavigation.requestFromRenderer(event.sender, mode)
    )

    // 【窗口锁定 - 切换锁定状态】
    mainWindowIpc.handle('toggle-lock', async (event, source) => {
      settingsWriteSource.assert(event, source)
      const now = Date.now()
      const before = {
        isLocked,
        zOrderMode: zOrderRuntime.mode,
        nativeZOrder: captureTitlebarZOrderStatus()
      }
      if (lockToggleInFlight || now - lastLockToggleAt < WINDOW_CONTROL_GUARD_MS) {
        logger.info('window.control-change', '窗口锁定切换请求被节流', {
          control: 'lock',
          before,
          lockToggleInFlight,
          elapsedSinceLastChangeMs: now - lastLockToggleAt
        })
        return { value: isLocked, changed: false, throttled: true }
      }
      lockToggleInFlight = true
      try {
        const receipt = await settingsOperations.run(() =>
          persistSettingValue('window.lockState', !isLocked)
        )
        const value = receipt.values?.window?.lockState
        logger.info('window.control-change', '窗口锁定状态已切换', {
          control: 'lock',
          before,
          after: {
            isLocked: value,
            zOrderMode: zOrderRuntime.mode,
            movable:
              getMainWindow() && !getMainWindow().isDestroyed()
                ? getMainWindow().isMovable()
                : null,
            nativeZOrder: captureTitlebarZOrderStatus()
          }
        })
        if (
          typeof value === 'boolean' &&
          receipt.application?.domains?.window?.status === 'applied'
        )
          sendAppMessage('success', value ? '主窗口已锁定' : '主窗口已解除锁定')
        return {
          ...(typeof value === 'boolean' ? { value } : {}),
          changed: true,
          throttled: false,
          snapshot: receipt
        }
      } catch (error) {
        sendAppMessage('error', `切换窗口锁定失败：${error.message}`)
        throw error
      } finally {
        lastLockToggleAt = Date.now()
        lockToggleInFlight = false
      }
    })

    // 【主窗口层级 - top / normal / bottom】
    mainWindowIpc.handle('set-window-z-order-mode', (event, requestedMode, source) => {
      settingsWriteSource.assert(event, source)
      const operation = settingsOperationForSource(source)
      return settingsOperations.run(() => setWindowZOrderMode(requestedMode, operation))
    })

    // 【缩放手柄 - 获取边界】返回当前窗口的位置和尺寸
    mainWindowIpc.handle('window-get-bounds', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win ? win.getBounds() : null
    })

    mainWindowIpc.handle('presentation-mode:get-state', () => presentationModeSnapshot())
    mainWindowIpc.handle('presentation-mode:enter-compact', (_event, { anchor } = {}) =>
      enterCompactPresentation(anchor)
    )
    mainWindowIpc.handle('presentation-mode:exit-compact', () =>
      exitCompactPresentation({ source: 'renderer', showWhenDone: true })
    )
    mainWindowIpc.handle('presentation-mode:begin-drag', (_event, point) =>
      beginCompactWindowDrag(point)
    )
    ipcMain.on('presentation-mode:update-drag', (event, point) => {
      if (event.sender !== getMainWindow()?.webContents) return
      updateCompactWindowDrag(point)
    })
    mainWindowIpc.handle('presentation-mode:end-drag', () => endCompactWindowDrag())
    mainWindowIpc.handle('presentation-mode:show-context-menu', () => {
      if (!presentationRuntime.isCompact()) return false
      Menu.buildFromTemplate([
        {
          label: '展开主视图',
          click: () =>
            void exitCompactPresentation({ source: 'context-menu', showWhenDone: true }).catch(
              (error) => logger.error('presentation-mode.context-expand', error)
            )
        },
        { label: '隐藏到托盘', click: hideToTray },
        { type: 'separator' },
        {
          label: '退出软件',
          click: () => {
            shutdownCoordinator.requestQuit('compact-context-menu')
          }
        }
      ]).popup({ window: getMainWindow() })
      return true
    })

    mainWindowIpc.handle('titlebar-window:begin-drag', (_event, payload = {}) =>
      beginTitlebarWindowDrag(payload.point, payload.diagnostics)
    )
    ipcMain.on('titlebar-window:update-drag', (event, point, diagnostics) => {
      if (event.sender !== getMainWindow()?.webContents) return
      updateTitlebarWindowDrag(point, diagnostics)
    })
    mainWindowIpc.handle('titlebar-window:end-drag', (_event, diagnostics) =>
      endTitlebarWindowDrag(diagnostics)
    )
    mainWindowIpc.handle('window-resize:end', () => finishCompactWindowResize())
    // 【缩放手柄 - 设置边界】根据渲染进程传入的 bounds 调整窗口大小/位置
    ipcMain.on('window-set-bounds', (event, bounds) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const values = bounds && [bounds.x, bounds.y, bounds.width, bounds.height].map(Number)
      const compact = presentationRuntime.isCompact()
      const minWidth = compact ? COMPACT_WINDOW_LIMITS.minWidth : MAIN_WINDOW_MIN_SIZE
      const minHeight = compact ? COMPACT_WINDOW_LIMITS.minHeight : MAIN_WINDOW_MIN_SIZE
      const maxWidth = compact ? COMPACT_WINDOW_LIMITS.maxWidth : 16_384
      const maxHeight = compact ? COMPACT_WINDOW_LIMITS.maxHeight : 16_384
      if (
        win &&
        win === getMainWindow() &&
        !isLocked &&
        !presentationRuntime.isBusy() &&
        !isDockTransitionActive() &&
        values?.every(Number.isFinite) &&
        values[2] >= minWidth &&
        values[3] >= minHeight &&
        values[2] <= maxWidth &&
        values[3] <= maxHeight
      ) {
        // Math.round 确保像素值为整数，避免亚像素渲染问题
        win.setBounds({
          x: Math.round(values[0]),
          y: Math.round(values[1]),
          width: Math.round(values[2]),
          height: Math.round(values[3])
        })
        if (compact) presentationRuntime.handleResize(win.getBounds())
      }
    })

    // ---- 设置 IPC ----
    const disposeSettingsApplicationIpc = registerSettingsApplicationIpc({
      mainWindowIpc,
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      settingsWriteSource,
      settingsOperations,
      coordinator: settingsApplicationCoordinator
    })
    app.once('will-quit', disposeSettingsApplicationIpc)
    mainWindowIpc.handle('shortcuts:startup-notice', async () => {
      // The renderer can mount before capture initialization has registered F1.
      await startupPromise
      if (startupShortcutNoticeDismissed) return []
      return unavailableShortcuts(getResolvedSettingsSnapshot().runtime.shortcuts).filter((item) =>
        startupShortcutFailures.includes(item.action)
      )
    })
    mainWindowIpc.handle('shortcuts:dismiss-startup-notice', () => {
      startupShortcutNoticeDismissed = true
    })
    mainWindowIpc.handle('shortcuts:retry', async () => {
      await startupPromise
      if (!shutdownCoordinator.isQuitting()) {
        viewVisibilityShortcutService?.retryRegistration()
        for (const service of Object.values(captureShortcutService?.services || {}))
          service.retryRegistration()
        settingsRuntime.advanceRevision()
      }
      const snapshot = getResolvedSettingsSnapshot()
      broadcastSettingsChanged(snapshot)
      return snapshot
    })
    // renderer 只提交 schema ID，数据库 type/key、校验、序列化均由共享 schema 决定。
    mainWindowIpc.handle('set-setting-value', async (event, id, value, source) => {
      settingsWriteSource.assert(event, source)
      if (!RENDERER_WRITABLE_SETTING_IDS.has(id))
        throw new Error(`renderer 无权直接写入设置项: ${id}`)
      return settingsOperations.run(() => persistSettingValue(id, value))
    })

    mainWindowIpc.handle(
      'shortcut:view-visibility-capture-start',
      (event, key = 'viewVisibility') => {
        const ownerId = event.sender.id
        if (!viewVisibilityShortcutCaptureSenders.has(event.sender)) {
          viewVisibilityShortcutCaptureSenders.add(event.sender)
          event.sender.once('destroyed', () => {
            captureShortcutService?.endCapture(ownerId)
            viewVisibilityShortcutService?.endCapture(ownerId)
          })
        }
        captureShortcutService?.beginCapture(ownerId)
        const viewRuntime = viewVisibilityShortcutService.beginCapture(ownerId)
        return key === 'viewVisibility' ? viewRuntime : captureShortcutService?.snapshot()[key]
      }
    )

    mainWindowIpc.handle(
      'shortcut:view-visibility-capture-end',
      (event, key = 'viewVisibility') => {
        captureShortcutService?.endCapture(event.sender.id)
        const viewRuntime = viewVisibilityShortcutService.endCapture(event.sender.id)
        return key === 'viewVisibility' ? viewRuntime : captureShortcutService?.snapshot()[key]
      }
    )

    mainWindowIpc.handle('shortcut:view-visibility-set', async (event, accelerator, source) => {
      settingsWriteSource.assert(event, source)
      if (captureShortcutService?.conflicts('viewVisibility', accelerator))
        return { status: 'conflict', runtime: viewVisibilityShortcutService.snapshot() }
      const result = viewVisibilityShortcutService.update(accelerator, {
        ownerId: event.sender.id,
        persist: (next) => writeApplicationSetting('shortcuts.viewVisibility', next)
      })
      if (['saved', 'cleared', 'unchanged'].includes(result.status))
        captureShortcutService?.endCapture(event.sender.id)
      if (!['saved', 'cleared'].includes(result.status)) return result

      const receipt = await settingsOperations.track(
        settingsApplicationCoordinator.completeCommittedSettings({
          scope: getActiveWindowName(),
          ids: ['shortcuts.viewVisibility']
        })
      )
      return {
        ...result,
        runtime: receipt.runtime?.shortcuts?.viewVisibility || result.runtime,
        snapshot: receipt
      }
    })

    mainWindowIpc.handle('shortcut:capture-set', async (event, key, accelerator, source) => {
      settingsWriteSource.assert(event, source)
      const result = captureShortcutService.update(key, accelerator, {
        ownerId: event.sender.id,
        persist: (next) => writeApplicationSetting(`shortcuts.${key}`, next)
      })
      if (['saved', 'cleared'].includes(result.status)) {
        const receipt = await settingsOperations.track(
          settingsApplicationCoordinator.completeCommittedSettings({
            scope: getActiveWindowName(),
            ids: [`shortcuts.${key}`]
          })
        )
        return { ...result, snapshot: receipt }
      }
      return result
    })

    /**
     * 小黑条模式与边缘多选属于同一份运行配置；通过一次数据库批量写入
     * 和一次 runtime reconcile 提交，避免短暂运行在半新半旧状态。
     */
    mainWindowIpc.handle('set-dock-config', (event, config, source) => {
      settingsWriteSource.assert(event, source)
      const normalized = validateDockConfigPayload(config)
      return settingsOperations.run(() =>
        persistSettingValues([
          { id: 'dock.revealHandleMode', value: normalized.revealHandleMode },
          { id: 'dock.enabledEdges', value: normalized.enabledEdges }
        ])
      )
    })

    /** 获取 DB 值覆盖共享默认值后的完整设置快照。 */
    mainWindowIpc.handle('get-settings-snapshot', (event, source) => {
      // Reads retain their document identity while page-leave preparation seals writes.
      settingsWriteSource.assertDocument(event, source)
      // 每次查询都重新读取 SQLite，避免设置页拿到陈旧的主进程内存副本。
      refreshResolvedSettings({ notifyResolved: false })
      return getResolvedSettingsSnapshot()
    })

    // ---- 远程软件通知（全部阅读状态仅保存在本地） ----
    const disposeRemoteNoticeIpc = registerRemoteNoticeIpc({
      mainWindowIpc,
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      listPendingRemoteNotices,
      listRemoteNotices,
      acknowledgeRemoteNotice,
      getRemoteNoticeLink,
      getRemoteCoordinator: () => remoteCoordinator,
      shell
    })
    app.once('will-quit', disposeRemoteNoticeIpc)

    /**
     * 恢复当前视图的持久化设置和全部用户可配置的应用级设置。
     * 其他视图的独立设置、应用运行元数据、业务数据和开机自启 OS 状态不受影响。
     * 当前窗口立即恢复默认宽高并保留当前位置，同时清除下次启动时的几何记录。
     */
    mainWindowIpc.handle('reset-settings', async (event, source) => {
      settingsWriteSource.assert(event, source)
      if (isDockTransitionActive()) {
        throw new Error('请先显示贴边窗口，再恢复默认设置')
      }
      const previousDockConfig = getDockRuntimeConfig()
      const resetViewScope = getActiveWindowName()
      const { resetApplicationSettingCount, clearedViewSettingCount } = resetCurrentViewSettings(
        mainViewNavigation.mode
      )
      cancelPendingDockHide('reset-settings')
      geometryPersistence.cancel()
      // Only a committed reset may clear dirty geometry and pending persistence.
      geometryPersistence.markSaved()
      const receipt = await settingsOperations.track(
        settingsApplicationCoordinator.completeCommittedSettings({
          scope: resetViewScope,
          ids: SETTING_DEFINITIONS.map(({ id }) => id),
          previousDockConfig,
          reset: true
        })
      )
      logger.info('settings.reset', '当前视图与全局共享设置已恢复默认值', {
        viewMode: mainViewNavigation.mode,
        viewScope: resetViewScope,
        clearedViewSettingCount,
        resetApplicationSettingCount
      })
      return receipt
    })

    // ---- 贴边隐藏 IPC ----

    // 【贴边隐藏 - 鼠标悬停】渲染进程报告鼠标进入/离开主窗口
    ipcMain.on('window-hover', (event, isHovering) => {
      if (event.sender !== getMainWindow()?.webContents) return
      dockRuntime.handleHover(isHovering)
    })

    // ---- 系统模糊 IPC ----

    /** 设置模糊配置（立即生效 + 持久化到数据库） */
    mainWindowIpc.handle('set-blur-config', (event, payload, source) => {
      settingsWriteSource.assert(event, source)
      const operation = settingsOperationForSource(source)
      return settingsOperations.run(() => backgroundSettingsCoordinator.setBlur(payload, operation))
    })

    // ---- 主页面壁纸 IPC ----
    const disposeWallpaperIpc = registerWallpaperIpc({
      mainWindowIpc,
      assertWriteSource: (event, source) => settingsWriteSource.assert(event, source),
      assertDocumentSource: (event, source) => settingsWriteSource.assertDocument(event, source),
      wallpaperRetirement,
      createSettingsOperation: settingsOperationForSource,
      runMutation: settingsOperations.run,
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      backgroundSettingsCoordinator,
      getWallpaperThumbnail,
      getWallpaperDataUrl
    })
    app.once('will-quit', disposeWallpaperIpc)

    createWindow()
    remoteCoordinator = new RemoteCoordinator({
      app,
      baseUrl: REMOTE_BASE_URL,
      getDailyState: getRemoteDailyState,
      saveDailyState: saveRemoteDailyState,
      getSettings: () => settingsRuntime.values,
      getInstallationId: getOrCreateInstallationId,
      getNoticeSyncState: getRemoteNoticeSyncState,
      applyNoticeEvents: applyRemoteNoticeEvents,
      isServiceRetired: isRemoteServiceRetired,
      markServiceRetired: markRemoteServiceRetired,
      queueSessionEnd: queueRemoteSessionEnd,
      listPendingSessionEnds: listPendingRemoteSessionEnds,
      markSessionEndAttempt: markRemoteSessionEndAttempt,
      removePendingSessionEnd: removePendingRemoteSessionEnd,
      clearPendingSessionEnds: clearPendingRemoteSessionEnds,
      onNoticesChanged: (payload) => {
        if (!getMainWindow() || getMainWindow().isDestroyed()) return
        getMainWindow().webContents.send('remote-notices:changed', payload)
      },
      onHealthChanged: (health) => {
        if (
          !getMainWindow() ||
          getMainWindow().isDestroyed() ||
          getMainWindow().webContents.isDestroyed()
        )
          return
        getMainWindow().webContents.send('remote-health:changed', health)
      }
    })
    void remoteCoordinator.start()
    attachDockDisplayListeners()
    attachDockPowerListeners()
    featureRuntime.initializeSticky()
    // The complete window settings runtime is initialized after the sole host exists.
    applyResolvedWindowRuntime()
    featureRuntime.initializeReminders()
    featureRuntime.startScheduledTasks()
    console.log('[scheduler] 调度器已启动')

    // ---- 任务栏 & 托盘事件 ----

    // show：贴边隐藏时滑出（安全网，正常路径下 show 不会在贴边隐藏时触发）
    getMainWindow().on('show', () => {
      if (dockRuntime.hidden) doShow('main-window-show-event')
    })
    getMainWindow().on('session-end', () => {
      shutdownCoordinator.setTrigger('windows-session-end')
      logger.warn('lifecycle.session-end', 'Windows 会话正在结束，应用将执行退出清理')
    })

    // 【清空便签数据】仅清理便签、模板、标签和附件，保留 app_settings。
    mainWindowIpc.handle('clear-note-data', () => {
      const owner = Symbol('clear-note-data-drafts')
      const draftsDrained = draftAssetsRuntime.sealAndDrain(owner)
      // Issue cancellation before waiting for read pins. Accepted saves may be
      // waiting for these same readers to close before they can commit.
      const imagesDrained = suspendImageDecodes(owner)
      const readsDrained = Promise.all([draftsDrained, imagesDrained])
      void readsDrained.catch(() => {})
      return businessAdmission
        .clear(async () => {
          // No decoder may retain an attachment handle across the reset directory rename.
          await readsDrained
          const counts = getDb()
            .prepare(
              `SELECT
         (SELECT COUNT(*) FROM notes) AS notes,
         (SELECT COUNT(*) FROM note_templates) AS templates,
         (SELECT COUNT(*) FROM tags) AS tags,
         (SELECT COUNT(*) FROM note_attachments) AS attachments,
         (SELECT COUNT(*) FROM desktop_stickies) AS desktopStickies`
            )
            .get()
          await clearNoteData()
          const cleanupFailures = await runCommittedDataCleanup(
            [
              {
                id: 'reminders',
                label: '提醒清理',
                run: () => featureRuntime.refreshReminders()
              },
              {
                id: 'stickies',
                label: '桌面便签清理',
                run: () => featureRuntime.getStickyCommands()?.discardAllRuntime()
              },
              {
                id: 'drafts',
                label: '编辑草稿清理',
                run: async () => {
                  const window = getMainWindow()
                  if (!window || window.isDestroyed()) return
                  const cleared = await window.webContents.executeJavaScript(
                    'window.__clearEditingDrafts?.()'
                  )
                  if (cleared !== true) throw new Error('草稿清理接口不可用')
                }
              },
              {
                id: 'draft-assets',
                label: '草稿附件清理',
                run: async () => {
                  try {
                    await draftAssetsRuntime.clearAfterCommit(owner)
                  } finally {
                    draftNoteCommands.clear()
                  }
                }
              },
              {
                id: 'broadcast',
                label: '界面刷新',
                run: () => broadcastBusinessDataCleared(getApplicationWindows())
              }
            ],
            ({ id, error }) => logger.error(`data.clear-${id}`, error)
          )
          logger.info('data.clear', '便签业务数据已清空', {
            viewMode: mainViewNavigation.mode,
            ...counts
          })
          if (cleanupFailures.length) throw createBusinessClearCleanupError(cleanupFailures)
          return true
        })
        .finally(() => {
          resumeImageDecodes(owner)
          draftAssetsRuntime.resume(owner)
        })
    })

    // ---- 开机自启 ----

    /**
     * 校验开机自启状态
     * 每次打开设置页面时直接读取 OS；不再维护数据库副本。
     * @returns {{ value: boolean, error: string|null }}
     */
    mainWindowIpc.handle('verify-auto-start', () => {
      return readAutoStartRuntime()
    })

    /**
     * 设置开机自启
     * 只更新 OS 注册表/LoginItem，并返回回读后的真实状态。
     */
    mainWindowIpc.handle('set-auto-start', (event, enabled, source) => {
      settingsWriteSource.assert(event, source)
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
      const actual = readAutoStartRuntime().value
      settingsRuntime.advanceRevision()
      broadcastSettingsChanged()
      return actual
    })

    registerBusinessIpcHandlers({
      ipcMain,
      getMainWindow: () => getMainWindow(),
      getAuthorizedWindows: () => getApplicationWindows(),
      getBroadcastWindows: () => getApplicationWindows(),
      getViewMode: () => mainViewNavigation.mode,
      diagnosticLogger: logger,
      runMutation: businessAdmission.run,
      onRemindersChanged: featureRuntime.refreshReminders,
      onNotePurged: (noteId) => featureRuntime.getStickyCommands()?.discardByNoteId(noteId)
    })
    registerCalendarIpcHandlers({
      ipcMain,
      dialog,
      shell,
      getMainWindow: () => getMainWindow()
    })
    registerDailyReportIpcHandlers({
      ipcMain,
      dialog,
      shell,
      getMainWindow: () => getMainWindow()
    })
    featureRuntime.initializeWeather()

    screenshotService = new CaptureCoordinator({
      ipcMain,
      logger,
      getTheme: () => settingsRuntime.values.css,
      onError: (message) => {
        if (!shutdownCoordinator.isQuitting())
          void dialog.showMessageBox({ type: 'warning', title: '截图与贴图', message })
      },
      onBusinessOpen: captureWindowIntegration.openBusiness,
      getMainWindow: () => getMainWindow(),
      onCaptureStart: captureWindowIntegration.begin,
      onCaptureEnd: captureWindowIntegration.finish
    })
    await runStage('capture', () => screenshotService.initialize())
    captureShortcutService = new CaptureShortcutService({
      globalShortcut,
      definitions: ACTION_SHORTCUTS,
      viewService: viewVisibilityShortcutService,
      logger,
      onTrigger: (action) => {
        if (shutdownCoordinator.isQuitting()) return
        if (action === 'newNote') {
          void newNoteShortcut.trigger().catch((error) => logger.error('shortcut.new-note', error))
          return
        }
        void screenshotService
          .capture({ mode: action === 'screenshotCopy' ? 'copy-on-select' : 'edit' })
          .catch((error) => screenshotService?.report(error))
      }
    })
    captureShortcutService.initialize(settingsRuntime.values.shortcuts)
    startupShortcutFailures = unavailableShortcuts(
      getResolvedSettingsSnapshot().runtime.shortcuts
    ).map((item) => item.action)
    const cancelNativeCapture = () => screenshotService?.cancel()
    powerMonitor.on('lock-screen', cancelNativeCapture)
    powerMonitor.on('suspend', cancelNativeCapture)
    app.once('will-quit', () => {
      powerMonitor.removeListener('lock-screen', cancelNativeCapture)
      powerMonitor.removeListener('suspend', cancelNativeCapture)
    })

    // ---- 调度器健康检查 IPC ----

    // 【调度器 - 健康检查】
    mainWindowIpc.handle('scheduler:retry', featureRuntime.retryScheduledTasks)

    mainWindowIpc.handle('scheduler:health', featureRuntime.schedulerHealth)

    // ---- 系统托盘 ----
    mainTrayController.create()
    logger.info('startup', '系统托盘已创建，启动初始化完成')
  },
  onFailure: (error) => {
    logger.error('startup.failed', error)
    dialog.showErrorBox(
      'Abandon 便签启动失败',
      '无法完成初始化，原有数据未被自动清除。请检查磁盘空间与目录权限后重启。\n\n' +
        (error?.message || String(error))
    )
    app.quit()
  }
})

// The coordinator owns quit admission, re-entry and the serial disposal ledger.
const shutdownCoordinator = createShutdownCoordinator({
  app,
  logger,
  getWindow: getMainWindow,
  confirmDrafts: (window, ...args) => {
    // The draft/setting drain can itself be waiting for this background request.
    // Cancel its visual wait before entering that drain; a cancelled quit stays usable.
    wallpaperRetirement.cancelAll('shutdown-draft-check')
    return mainViewNavigation.canSkipInitialDrafts(window)
      ? true
      : confirmEditingDrafts(window, ...args)
  },
  isViewDraftCheckActive: () => mainViewNavigation.isCheckingDrafts(),
  getViewNavigationActive: () => mainViewNavigation.isNavigating(),
  onBegin: () => {
    // Seal remote continuations and persist the local session-end checkpoint
    // before any other owner can fail or consume the shutdown deadline.
    remoteCoordinator?.prepareStop()
    wallpaperRetirement.stop('shutdown')
    settingsOperations.stop()
    // dispose seals synchronously, then waits for admitted IO and pinned note
    // consumers. Its async outcome belongs to the serial shutdown stage below.
    draftAssetsShutdown = draftAssetsRuntime.dispose()
    void draftAssetsShutdown.catch(() => {})
    imageDecodesShutdown = disposeImageDecodes()
    void imageDecodesShutdown.catch(() => {})
    settingsWriteSource.stop()
    businessAdmission.preventNewMutations()
    featureRuntime.stopReminderPresentation()
    const stickyInitializations = featureRuntime.stopStickyInitializations()
    logger.info('sticky.shutdown-initializations', '停止便利贴初始化并交接退出清理', {
      stopped: stickyInitializations.stopped,
      alreadyStopped: stickyInitializations.alreadyStopped,
      cancelled: stickyInitializations.cancelled,
      preserved: stickyInitializations.preserved,
      pendingCommit: stickyInitializations.pendingCommit,
      cleanupErrors: stickyInitializations.cleanupErrors.map(({ stickyId, error }) => ({
        stickyId,
        error: error?.message || String(error)
      }))
    })
    for (const { stickyId, error } of stickyInitializations.cleanupErrors) {
      logger.error('sticky.shutdown-initialization-cleanup', error, { stickyId })
    }
    notificationActivation.dispose()
    featureRuntime.stopScheduledTasks()
    mainViewNavigation.dispose()
    presentationRuntime.prepareShutdown()
    backgroundSettingsCoordinator.preventNewRequests()
    applicationBootstrap.cancel()
  },
  onTerminal: (snapshot) => {
    // A deadline cannot safely close storage under admitted async mutations.
    // Keep one bounded local failure snapshot, then the coordinator exits in
    // the same turn without awaiting the log worker or running later cleanup.
    if (snapshot.exitMode === 'normal') return
    const directory = getLogDirectory()
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'shutdown-incomplete.json'),
      JSON.stringify({
        schemaVersion: 1,
        time: new Date().toISOString(),
        pid: process.pid,
        shutdown: sanitizeDiagnosticValue(snapshot, {
          maxBytes: 32768,
          maxDepth: 8,
          maxArray: 64,
          maxNodes: 2048
        })
      })
    )
  },
  hasRemoteSession: () => Boolean(remoteCoordinator?.hasActiveSession()),
  stages: [
    {
      name: 'capture',
      enabled: () => Boolean(screenshotService),
      errorScope: 'capture.shutdown',
      run: () => {
        captureShortcutService?.dispose()
        return screenshotService.dispose()
      }
    },
    {
      name: 'remote-session',
      enabled: () => Boolean(remoteCoordinator),
      run: () => remoteCoordinator.stop({ timeoutMs: 1600 })
    },
    { name: 'business-mutations', enabled: () => true, run: businessAdmission.drain },
    {
      name: 'image-decodes',
      enabled: () => true,
      run: () => imageDecodesShutdown || disposeImageDecodes()
    },
    {
      name: 'draft-assets',
      enabled: () => true,
      run: () =>
        (draftAssetsShutdown || draftAssetsRuntime.dispose()).finally(() =>
          draftNoteCommands.clear()
        )
    },
    { name: 'settings-operations', enabled: () => true, run: settingsOperations.drain },
    {
      name: 'diagnostic',
      enabled: () => Boolean(diagnosticController),
      errorScope: 'logging.shutdown-capture',
      run: () =>
        diagnosticController.freeze('shutdown').then((capture) => {
          logger.info('logging.shutdown-capture', '退出前提交页面诊断', {
            complete: capture.complete,
            windows: capture.windows,
            retiredIncompleteOmitted: capture.retiredIncompleteOmitted
          })
          return { complete: capture.complete }
        })
    },
    {
      name: 'background-settings',
      enabled: () => backgroundSettingsCoordinator.snapshot().pendingRequests > 0,
      run: backgroundSettingsCoordinator.settled
    },
    {
      name: 'presentation-settlement',
      enabled: () => presentationRuntime.isBusy(),
      run: () =>
        presentationRuntime.settled().catch((error) => {
          if (error.code === 'PRESENTATION_CANCELLED') return { cancelled: true }
          throw error
        })
    },
    {
      name: 'startup-settlement',
      enabled: () => applicationBootstrap.snapshot().phase !== 'ready',
      run: () => applicationBootstrap.settled()
    }
  ],
  cleanup: [
    {
      name: 'geometry',
      run: () => {
        geometryPersistence.cancel()
        presentationRuntime.prepareShutdown()
        if (getMainWindow() && !getMainWindow().isDestroyed()) endTitlebarWindowDrag()
        cancelBottomWindowZOrderRetry()
        dockRuntime.prepareShutdown()
        if (getDb()) geometryPersistence.flush()
      }
    },
    { name: 'scheduler', run: featureRuntime.stopScheduledTasks },
    { name: 'weather', run: featureRuntime.disposeWeather },
    { name: 'reminder', run: featureRuntime.disposeReminders },
    {
      name: 'shortcuts',
      run: () => {
        viewVisibilityShortcutService?.dispose()
        viewVisibilityShortcutService = null
      }
    },
    {
      name: 'capture-release',
      run: () => {
        captureShortcutService?.dispose()
        captureShortcutService = null
        screenshotService = null
      }
    },
    { name: 'sticky', run: featureRuntime.disposeStickyAfterDrain },
    { name: 'feature-ledger', run: featureRuntime.disposeCreated },
    { name: 'database', run: closeDatabase },
    { name: 'native-blur', run: blurRuntime.destroy },
    {
      name: 'dock-timers',
      run: dockRuntime.dispose
    },
    { name: 'tray', run: mainTrayController.dispose }
  ],
  flushLogs
})
const startupPromise = applicationBootstrap.start()

// 所有窗口关闭时不退出应用，保持在托盘中运行
app.on('window-all-closed', () => {})
