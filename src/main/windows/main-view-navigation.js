import { join } from 'node:path'
import { VIEW_MODES, normalizeViewMode, serializeSetting } from '../../shared/settings-schema.js'
import { getWindowProfile } from './window-profiles.js'
import {
  getViewSettingsScope,
  prepareViewSettingsForSwitch,
  writeActiveView
} from '../settings/application-settings.js'
import { setSettingsBatch } from '../db/db-settings-repository.js'
import { setConfig as blurSetConfig } from '../bridge/blur_bridge.js'
import { constrainMainWindowBounds, getPersistableWindowBounds } from '../window-bounds.js'
import { setWindowLogContext } from '../logging/window-capture.js'

/** Owns active scope, single-window navigation, renderer-ready and the deferred background target. */
export function createMainViewNavigation({
  getMainWindow,
  screen,
  loadWindow,
  getSettings,
  resetSettingsForView,
  refreshResolvedSettings,
  geometryPersistence,
  dockRuntime,
  isCompactPresentationActive,
  exitCompactPresentation,
  endTitlebarWindowDrag,
  openMainWindow,
  confirmEditingDrafts,
  isShutdownCheckingDrafts,
  isQuitting = () => false,
  isBackgroundInFlight,
  readBlurState,
  initializeBlurRuntime,
  runBlurRuntimeOperation,
  applyResolvedWindowRuntime,
  restoreBlurForVisibleWindow,
  reassertBottomWindowZOrder,
  getDockDiagnosticSnapshot,
  revealPendingNotificationApplication,
  rebuildTrayMenu,
  logger,
  rendererRoot: RENDERER_ROOT,
  isDev = false
}) {
  let stopped = false
  let activeViewMode = VIEW_MODES.LIST

  let switchingMainView = false

  let pendingMainViewRendererReady = null

  let mainWindowPresentationTiming = null

  let checkingViewDrafts = false

  let queuedViewSwitch = null
  let queuedViewCallback = null
  let navigationAdmission = null
  let navigationSequence = 0
  let userHideGeneration = 0
  const readyWindows = new WeakSet()

  const MAIN_VIEW_RENDERER_READY_TIMEOUT_MS = 15000

  function getActiveWindowName() {
    return getViewSettingsScope(activeViewMode)
  }

  function getActiveWindowProfile() {
    return getWindowProfile(activeViewMode)
  }

  function resolveActiveViewWindowBounds({ preferredDisplay = null } = {}) {
    const display = preferredDisplay || screen.getPrimaryDisplay()
    const screenW = display.workAreaSize.width
    const screenH = display.workAreaSize.height
    const defaultW = Math.round(screenW * getSettings().geometry.widthRatio)
    const defaultH = Math.round(screenH * getSettings().geometry.heightRatio)
    const margin = Math.round((screenH - defaultH) / 2)
    const defaultX = getActiveWindowProfile().defaultCentered
      ? display.workArea.x + Math.round((screenW - defaultW) / 2)
      : display.workArea.x + margin
    const defaultY = display.workArea.y + Math.round((screenH - defaultH) / 2)
    const geometry = getSettings().geometry
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

    return {
      bounds,
      requestedBounds,
      targetDisplay,
      saved: Boolean(saved)
    }
  }

  function getActiveRendererLocation() {
    const rendererFile = getActiveWindowProfile().rendererFile
    if (isDev && process.env['ELECTRON_RENDERER_URL']) {
      return {
        rendererFile,
        type: 'url',
        value:
          rendererFile === 'index.html'
            ? process.env['ELECTRON_RENDERER_URL']
            : `${process.env['ELECTRON_RENDERER_URL']}/${rendererFile}`
      }
    }
    return {
      rendererFile,
      type: 'file',
      value: join(RENDERER_ROOT, rendererFile)
    }
  }

  function beginMainViewRendererReadyWait(window, viewMode) {
    if (pendingMainViewRendererReady) {
      pendingMainViewRendererReady.reject(new Error('新的主视图加载覆盖了尚未完成的等待'))
    }

    let resolvePromise
    let rejectPromise
    const promise = new Promise((resolveReady, rejectReady) => {
      resolvePromise = resolveReady
      rejectPromise = rejectReady
    })
    const pending = {
      window,
      viewMode,
      timer: null,
      resolve: () => {
        if (pendingMainViewRendererReady !== pending) return
        clearTimeout(pending.timer)
        pendingMainViewRendererReady = null
        resolvePromise()
      },
      reject: (error) => {
        if (pendingMainViewRendererReady !== pending) return
        clearTimeout(pending.timer)
        pendingMainViewRendererReady = null
        rejectPromise(error)
      }
    }
    pending.timer = setTimeout(() => {
      pending.reject(new Error(`等待${viewMode}视图渲染完成超时`))
    }, MAIN_VIEW_RENDERER_READY_TIMEOUT_MS)
    pending.timer.unref?.()
    pendingMainViewRendererReady = pending
    return promise
  }

  function acknowledgeMainViewRendererReady(sender, viewMode) {
    const pending = pendingMainViewRendererReady
    if (!pending || pending.window.isDestroyed()) return
    if (
      sender !== pending.window.webContents ||
      pending.viewMode !== activeViewMode ||
      viewMode !== pending.viewMode
    )
      return
    pending.resolve()
  }

  function cancelMainViewRendererReadyWait(error) {
    pendingMainViewRendererReady?.reject(error)
  }

  async function loadActiveViewIntoWindow(window) {
    if (!window || window.isDestroyed()) throw new Error('主窗口不可用')
    const location = getActiveRendererLocation()
    const readyPromise = beginMainViewRendererReadyWait(window, activeViewMode)
    if (mainWindowPresentationTiming) mainWindowPresentationTiming.loadRequestedAt = Date.now()

    try {
      const loadPromise = loadWindow(window, location)
      await Promise.all([loadPromise, readyPromise])
    } catch (error) {
      cancelMainViewRendererReadyWait(error)
      await readyPromise.catch(() => {})
      throw error
    }
  }

  function hideMainWindowForViewNavigation(window) {
    if (!window || window.isDestroyed()) return
    if (readBlurState().initialized) {
      runBlurRuntimeOperation(
        () => blurSetConfig({ ...readBlurState().config, enabled: false }),
        '视图切换前暂时隐藏毛玻璃层'
      )
    }
    window.hide()
  }

  function prepareMainWindowPresentationForView(window, targetDisplay) {
    const startedAt = Date.now()
    mainWindowPresentationTiming = {
      creationStartedAt: startedAt,
      createdAt: startedAt,
      loadRequestedAt: null,
      loadStartedAt: null,
      rendererReadyAt: null,
      displayId: targetDisplay.id,
      displayScaleFactor: targetDisplay.scaleFactor
    }
    setWindowLogContext(window, { role: getActiveWindowProfile().logRole })
  }

  function prepareBlurRuntimeForActiveViewNavigation() {
    if (!readBlurState().caps.supported) return

    if (readBlurState().config.enabled && !readBlurState().initialized) {
      const result = initializeBlurRuntime()
      if (!result.success) {
        setSettingsBatch(getActiveWindowName(), [serializeSetting('blur.enabled', false)])
        refreshResolvedSettings({ incrementRevision: true })
        return
      }
    }

    if (
      readBlurState().initialized &&
      readBlurState().config.enabled &&
      getSettings().wallpaper.enabled
    ) {
      setSettingsBatch(getActiveWindowName(), [serializeSetting('wallpaper.enabled', false)])
      refreshResolvedSettings({ incrementRevision: true })
    }

    if (readBlurState().initialized) {
      runBlurRuntimeOperation(
        () => blurSetConfig({ ...readBlurState().config, enabled: false }),
        '视图导航期间保持毛玻璃层隐藏'
      )
    }
  }

  async function presentActiveViewInExistingWindow(window, { preferredDisplay = null } = {}) {
    if (!window || window.isDestroyed()) throw new Error('主窗口不可用')
    prepareBlurRuntimeForActiveViewNavigation()
    const { bounds, targetDisplay } = resolveActiveViewWindowBounds({ preferredDisplay })
    prepareMainWindowPresentationForView(window, targetDisplay)
    window.setBounds(bounds, false)
    geometryPersistence.setStableBounds({ ...window.getBounds() })
    dockRuntime.setWorkArea(targetDisplay.workArea)
    applyResolvedWindowRuntime()
    await loadActiveViewIntoWindow(window)
    return bounds
  }

  function ownsCurrentWindow(admission) {
    return (
      navigationAdmission === admission &&
      !stopped &&
      !isQuitting() &&
      admission.window === getMainWindow() &&
      admission.window &&
      !admission.window.isDestroyed()
    )
  }

  function hasVisibilityAuthority(admission) {
    return ownsCurrentWindow(admission) && admission.hideGeneration === userHideGeneration
  }

  function restoreConcealedSource(admission) {
    if (
      !admission.concealed ||
      !admission.sourceVisible ||
      !hasVisibilityAuthority(admission) ||
      admission.window.isVisible()
    )
      return
    try {
      openMainWindow()
    } catch (error) {
      logger.error('view.switch-refusal-visibility', error, { admissionId: admission.id })
    }
  }

  async function switchMainView(targetMode) {
    if (stopped || isQuitting()) return false
    const admittedWindow = getMainWindow()
    if (
      navigationAdmission ||
      switchingMainView ||
      checkingViewDrafts ||
      isShutdownCheckingDrafts()
    )
      return false
    const requestedMode = normalizeViewMode(targetMode)
    const inherited = queuedViewSwitch
    const inheritsConcealment =
      inherited?.window === admittedWindow && inherited.hideGeneration === userHideGeneration
    const admission = {
      id: ++navigationSequence,
      window: admittedWindow,
      sourceVisible: inheritsConcealment
        ? inherited.sourceVisible
        : Boolean(admittedWindow && !admittedWindow.isDestroyed() && admittedWindow.isVisible()),
      hideGeneration: userHideGeneration,
      concealed: inheritsConcealment && inherited.concealed,
      rendererNavigationStarted: false,
      transferred: false
    }
    if (!isBackgroundInFlight()) queuedViewSwitch = null
    // Admission starts before the compact ACK wait; another request cannot borrow its concealment.
    navigationAdmission = admission
    try {
      if (dockRuntime.cleanupStatus) {
        logger.warn('view.switch', '原生边缘监视器仍在清理，暂缓切换主视图', {
          targetMode: requestedMode,
          generation: dockRuntime.cleanupStatus.generation
        })
        return false
      }
      if (isCompactPresentationActive()) {
        admission.concealed = true
        await exitCompactPresentation({ source: 'view-switch', showWhenDone: false })
      }
      if (!hasVisibilityAuthority(admission)) return false
      if (requestedMode === activeViewMode) {
        queuedViewSwitch = null
        openMainWindow()
        return false
      }
      checkingViewDrafts = true
      let allowed
      try {
        allowed = await confirmEditingDrafts(getMainWindow(), '切换视图', {
          canReveal: () => hasVisibilityAuthority(admission)
        })
      } finally {
        checkingViewDrafts = false
      }
      if (!allowed || !hasVisibilityAuthority(admission)) return false
      const normalized = normalizeViewMode(targetMode)
      if (switchingMainView) return false
      if (dockRuntime.cleanupStatus) {
        logger.warn('view.switch', '原生边缘监视器仍在清理，暂缓切换主视图', {
          targetMode: normalized,
          generation: dockRuntime.cleanupStatus.generation
        })
        return false
      }
      // 启用毛玻璃时有一段壁纸退场等待。让这次设置事务先在原视图完整收敛，
      // 再执行最后一次托盘切换请求，避免异步尾部写入另一个视图作用域。
      if (isBackgroundInFlight()) {
        queuedViewSwitch = { ...admission, target: normalized }
        admission.transferred = true
        return true
      }
      if (normalized === activeViewMode) return false

      const previousMode = activeViewMode
      switchingMainView = true
      let sourceDisplay = null
      let sourceBounds = null
      try {
        if (getMainWindow() && !getMainWindow().isDestroyed()) {
          sourceBounds = getPersistableWindowBounds({
            dockStableBounds: dockRuntime.readStableSessionBounds(),
            lastVisibleBounds: geometryPersistence.getStableBounds(),
            currentBounds: getMainWindow().getBounds()
          })
          sourceDisplay = screen.getDisplayMatching(sourceBounds || getMainWindow().getBounds())
          dockRuntime.restoreDockWindowToVisiblePosition()
          dockRuntime.resetDockState({ source: 'view-switch' })
          if (dockRuntime.cleanupStatus) {
            logger.warn('view.switch', '停止原生边缘监视器超时，本次视图切换已安全取消', {
              targetMode: normalized,
              generation: dockRuntime.cleanupStatus.generation
            })
            return false
          }
          endTitlebarWindowDrag()
        }

        geometryPersistence.cancel()
        const pendingGeometry = geometryPersistence.readPendingBounds()
        const switchPreparation = prepareViewSettingsForSwitch({
          sourceViewMode: previousMode,
          targetViewMode: normalized,
          pendingGeometry
        })
        if (switchPreparation.geometryPersisted) geometryPersistence.markSaved()

        const reusedWindow = getMainWindow()
        if (!reusedWindow || reusedWindow.isDestroyed()) throw new Error('主窗口不可用')
        admission.rendererNavigationStarted = true
        hideMainWindowForViewNavigation(reusedWindow)
        activeViewMode = normalized
        resetSettingsForView(activeViewMode)
        refreshResolvedSettings({ incrementRevision: true })
        await presentActiveViewInExistingWindow(reusedWindow, { preferredDisplay: sourceDisplay })
        if (!ownsCurrentWindow(admission)) return false
        writeActiveView(activeViewMode)
        rebuildTrayMenu()
        logger.info('view.switch', '已在现有窗口中切换主视图', {
          activeViewMode,
          reusedBrowserWindow: true,
          browserWindowId: reusedWindow.id
        })
        return true
      } catch (error) {
        if (!ownsCurrentWindow(admission)) {
          cancelMainViewRendererReadyWait(error)
          return false
        }
        logger.error('view.switch', error, { previousMode, targetMode: normalized })
        try {
          cancelMainViewRendererReadyWait(error)
          if (!getMainWindow() || getMainWindow().isDestroyed())
            throw new Error('原主窗口已经不可恢复')
          hideMainWindowForViewNavigation(getMainWindow())
          activeViewMode = previousMode
          resetSettingsForView(activeViewMode)
          refreshResolvedSettings({ incrementRevision: true })
          const restoreDisplay = sourceBounds
            ? screen.getDisplayMatching(sourceBounds)
            : sourceDisplay
          if (sourceBounds) {
            prepareMainWindowPresentationForView(getMainWindow(), restoreDisplay)
            getMainWindow().setBounds(
              constrainMainWindowBounds(sourceBounds, restoreDisplay.workArea),
              false
            )
            geometryPersistence.setStableBounds({ ...getMainWindow().getBounds() })
            dockRuntime.setWorkArea(restoreDisplay.workArea)
            applyResolvedWindowRuntime()
            await loadActiveViewIntoWindow(getMainWindow())
          } else {
            await presentActiveViewInExistingWindow(getMainWindow(), {
              preferredDisplay: sourceDisplay
            })
          }
          if (!ownsCurrentWindow(admission)) return false
          try {
            writeActiveView(previousMode)
          } catch (persistRestoreError) {
            logger.error('view.switch-restore-persistence', persistRestoreError, { previousMode })
          }
          rebuildTrayMenu()
        } catch (restoreError) {
          if (!ownsCurrentWindow(admission)) return false
          logger.fatal('view.switch-restore', restoreError, { previousMode })
          if (hasVisibilityAuthority(admission)) getMainWindow().show()
        }
        return false
      } finally {
        switchingMainView = false
      }
    } finally {
      if (navigationAdmission === admission) {
        if (!admission.transferred && !admission.rendererNavigationStarted)
          restoreConcealedSource(admission)
        navigationAdmission = null
        if (queuedViewSwitch && !isBackgroundInFlight()) onBackgroundSettled()
      }
    }
  }

  async function switchMainViewFromTray(targetMode) {
    return switchMainView(targetMode)
  }
  function handleRendererReady(sender, viewMode) {
    if (stopped || isQuitting()) return
    if (sender !== getMainWindow()?.webContents) return
    if (!Object.values(VIEW_MODES).includes(viewMode) || viewMode !== activeViewMode) {
      logger.warn('renderer.ready-stale', '忽略与当前主视图不一致的渲染就绪消息', {
        activeViewMode,
        reportedViewMode: viewMode
      })
      return
    }
    const rendererReadyAt = Date.now()
    const timing = mainWindowPresentationTiming
    if (timing) timing.rendererReadyAt = rendererReadyAt
    logger.info('startup.window-presentation', '渲染进程就绪，准备显示主窗口', {
      viewMode: activeViewMode,
      createdToRendererReadyMs: timing?.createdAt ? rendererReadyAt - timing.createdAt : null,
      loadRequestedToRendererReadyMs: timing?.loadRequestedAt
        ? rendererReadyAt - timing.loadRequestedAt
        : null,
      loadStartedToRendererReadyMs: timing?.loadStartedAt
        ? rendererReadyAt - timing.loadStartedAt
        : null,
      beforeShow: getDockDiagnosticSnapshot()
    })
    const currentWindow = getMainWindow()
    const firstReady = !readyWindows.has(currentWindow)
    readyWindows.add(currentWindow)
    // A reload keeps this BrowserWindow's visibility. Only startup or an admitted
    // view switch may reveal it; recovery must not undo a user hide or take focus.
    const canShow = navigationAdmission
      ? hasVisibilityAuthority(navigationAdmission)
      : firstReady && userHideGeneration === 0
    if (canShow && getMainWindow() && !getMainWindow().isDestroyed()) {
      const presentedWindow = getMainWindow()
      const showCalledAt = Date.now()
      getMainWindow().show()
      // 视图导航会暂时隐藏 Overlay；窗口重新显示后立即恢复目标视图配置，
      // show 事件中的延迟恢复继续作为 Win10 可见性提交后的幂等兜底。
      restoreBlurForVisibleWindow(getMainWindow(), 'renderer-ready')
      getMainWindow().focus()
      reassertBottomWindowZOrder('renderer-ready')
      revealPendingNotificationApplication()
      setImmediate(() => {
        if (stopped || isQuitting()) return
        if (getMainWindow() !== presentedWindow || presentedWindow.isDestroyed()) return
        logger.info('startup.window-presentation', '主窗口首次显示调用已完成', {
          viewMode: activeViewMode,
          rendererReadyToShowCallMs: showCalledAt - rendererReadyAt,
          showCallToSnapshotMs: Date.now() - showCalledAt,
          visible: presentedWindow.isVisible(),
          focused: presentedWindow.isFocused(),
          snapshot: getDockDiagnosticSnapshot()
        })
      })
    }
    acknowledgeMainViewRendererReady(sender, viewMode)
  }
  function requestFromRenderer(sender, mode) {
    if (stopped || isQuitting()) return false
    if (!Object.values(VIEW_MODES).includes(mode)) throw new Error('无效的主视图')
    if (mode === activeViewMode) return false
    if (navigationAdmission || switchingMainView || dockRuntime.cleanupStatus) {
      return false
    }
    setImmediate(async () => {
      try {
        await switchMainView(mode)
      } catch (error) {
        logger.error('view.switch', error)
        if (!sender.isDestroyed())
          sender.send('app:message', {
            type: 'error',
            text: '切换视图失败，请重试'
          })
      } finally {
        // The IPC reply only acknowledged the request. Cancellation must also
        // release the renderer's busy state when the original window survives.
        if (!sender.isDestroyed()) sender.send('view:switch-finished')
      }
    })
    return true
  }
  function onBackgroundSettled() {
    if (stopped || isQuitting()) return
    if (isBackgroundInFlight() || !queuedViewSwitch || navigationAdmission) return
    const queued = queuedViewSwitch
    if (queuedViewCallback === queued) return
    queuedViewCallback = queued
    setImmediate(() => {
      if (queuedViewCallback !== queued) return
      queuedViewCallback = null
      if (stopped || isQuitting() || queuedViewSwitch !== queued || navigationAdmission) return
      if (queued.window !== getMainWindow() || queued.hideGeneration !== userHideGeneration) {
        queuedViewSwitch = null
        return
      }
      void switchMainView(queued.target).catch((error) =>
        logger.error('view.switch-deferred', error)
      )
    })
  }
  return {
    getActiveWindowName,
    getActiveWindowProfile,
    resolveActiveViewWindowBounds,
    getActiveRendererLocation,
    beginMainViewRendererReadyWait,
    acknowledgeMainViewRendererReady,
    cancelMainViewRendererReadyWait,
    loadActiveViewIntoWindow,
    hideMainWindowForViewNavigation,
    prepareMainWindowPresentationForView,
    prepareBlurRuntimeForActiveViewNavigation,
    presentActiveViewInExistingWindow,
    switchMainView,
    switchMainViewFromTray,
    handleRendererReady,
    requestFromRenderer,
    onBackgroundSettled,
    noteWindowHiddenByUser(window) {
      if (!window || window !== getMainWindow()) return false
      userHideGeneration++
      if (queuedViewSwitch?.window === window) queuedViewSwitch = null
      queuedViewCallback = null
      return true
    },
    getUserHideGeneration: () => userHideGeneration,
    initializeActiveView: (mode) => {
      activeViewMode = normalizeViewMode(mode)
    },
    get mode() {
      return activeViewMode
    },
    isSwitching: () => switchingMainView,
    isCheckingDrafts: () => checkingViewDrafts,
    setPresentationTiming: (timing) => {
      mainWindowPresentationTiming = timing ? { ...timing } : null
    },
    recordTiming: (field, value) => {
      if (mainWindowPresentationTiming) mainWindowPresentationTiming[field] = value
    },
    get presentationTiming() {
      return mainWindowPresentationTiming ? { ...mainWindowPresentationTiming } : null
    },
    releaseWindow(window, error = new Error('主窗口已关闭')) {
      if (window !== getMainWindow()) return false
      if (pendingMainViewRendererReady?.window === window) cancelMainViewRendererReadyWait(error)
      mainWindowPresentationTiming = null
      queuedViewSwitch = null
      queuedViewCallback = null
      return true
    },
    dispose() {
      if (stopped) return
      stopped = true
      queuedViewSwitch = null
      queuedViewCallback = null
      cancelMainViewRendererReadyWait(new Error('应用正在退出，已取消主视图加载'))
      mainWindowPresentationTiming = null
    },
    snapshot: () => ({
      mode: activeViewMode,
      stopped,
      switching: switchingMainView,
      checkingDrafts: checkingViewDrafts,
      queuedTarget: queuedViewSwitch?.target ?? null,
      pendingReady: pendingMainViewRendererReady
        ? {
            viewMode: pendingMainViewRendererReady.viewMode,
            windowId: pendingMainViewRendererReady.window.id
          }
        : null
    })
  }
}
