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
  getDocumentGeneration = () => null,
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
  resumePageLeave = () => {},
  onNavigationSettled = () => {},
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
  let loadSequence = 0
  let unavailableView = false
  let initialization = null
  let initialViewSelection = null
  const trackedWindows = new Map()

  let mainWindowPresentationTiming = null

  let checkingViewDrafts = false

  let queuedViewSwitch = null
  let queuedViewCallback = null
  let navigationAdmission = null
  let navigationSequence = 0
  let userHideGeneration = 0
  const readyWindows = new WeakSet()
  const exposedWindows = new WeakSet()
  const readyDocuments = new WeakMap()
  const invalidatedWindows = new WeakSet()

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

  function readinessError(message, code = 'MAIN_VIEW_READY_TIMEOUT') {
    return Object.assign(new Error(message), { code })
  }

  function trackReadyDocument(window) {
    if (trackedWindows.has(window)) return
    const contents = window.webContents
    const documentState = { epoch: 0 }
    const onCommit = () => {
      documentState.epoch++
      readyDocuments.delete(window)
    }
    const onShow = () => exposedWindows.add(window)
    const onClosed = () => untrackReadyDocument(window)
    trackedWindows.set(
      window,
      Object.assign(documentState, { contents, onCommit, onClosed, onShow })
    )
    contents.on('did-navigate', onCommit)
    contents.on('render-process-gone', onCommit)
    window.on('show', onShow)
    window.once('closed', onClosed)
  }

  function untrackReadyDocument(window) {
    const listeners = trackedWindows.get(window)
    if (!listeners) return
    listeners.contents.removeListener('did-navigate', listeners.onCommit)
    listeners.contents.removeListener('render-process-gone', listeners.onCommit)
    window.removeListener('show', listeners.onShow)
    window.removeListener('closed', listeners.onClosed)
    readyDocuments.delete(window)
    trackedWindows.delete(window)
  }

  function beginMainViewRendererReadyWait(window, viewMode, initial = null) {
    if (pendingMainViewRendererReady) {
      pendingMainViewRendererReady.cancel(new Error('新的主视图加载覆盖了尚未完成的等待'))
    }
    const contents = window.webContents

    let resolvePromise
    let rejectPromise
    const promise = new Promise((resolveReady, rejectReady) => {
      resolvePromise = resolveReady
      rejectPromise = rejectReady
    })
    const pending = {
      id: ++loadSequence,
      window,
      contents,
      viewMode,
      baselineGeneration: getDocumentGeneration(),
      deadline: Date.now() + MAIN_VIEW_RENDERER_READY_TIMEOUT_MS,
      state: 'pending',
      presenting: false,
      initial,
      timer: null,
      resolve: () => settle('succeeded'),
      reject: (error) => settle('failed', error),
      cancel: (error) => {
        const cancelled = new Error(error.message, { cause: error })
        cancelled.code = 'MAIN_VIEW_LOAD_CANCELLED'
        return settle('cancelled', cancelled)
      }
    }
    const onClosed = () => pending.cancel(new Error('主窗口已关闭，已取消主视图加载'))
    const onDestroyed = () => pending.cancel(new Error('主页面已销毁，已取消主视图加载'))
    const onCrashed = (_event, details) =>
      pending.reject(
        readinessError(
          `主页面渲染进程已退出：${details?.reason || 'unknown'}`,
          'MAIN_VIEW_RENDERER_CRASHED'
        )
      )
    function settle(state, error = null) {
      if (pending.state !== 'pending') return false
      pending.state = state
      if (initial) {
        initial.state = state
        initial.error = error
          ? { code: error.code || 'MAIN_VIEW_LOAD_FAILED', message: error.message }
          : null
        if (initialization === initial) unavailableView = state !== 'succeeded'
        if (error) {
          try {
            logger.error('startup.renderer-initialization', error, {
              id: pending.id,
              phase: initial.phase,
              state,
              viewMode
            })
          } catch {
            /* Diagnostics cannot retain a failed startup owner. */
          }
        }
      }
      if (error) invalidatedWindows.add(window)
      else invalidatedWindows.delete(window)
      if (pendingMainViewRendererReady === pending) pendingMainViewRendererReady = null
      clearTimeout(pending.timer)
      pending.timer = null
      window.removeListener('closed', onClosed)
      contents.removeListener('destroyed', onDestroyed)
      contents.removeListener('render-process-gone', onCrashed)
      if (
        initial &&
        state !== 'succeeded' &&
        initialization === initial &&
        window === getMainWindow() &&
        !window.isDestroyed()
      ) {
        try {
          hideMainWindowForViewNavigation(window)
        } catch (hideError) {
          try {
            logger.error('startup.renderer-failure-hide', hideError, { id: pending.id })
          } catch {
            /* Failure observation cannot keep readiness pending. */
          }
        }
      }
      if (error) rejectPromise(error)
      else resolvePromise()
      return true
    }
    pending.timer = setTimeout(() => {
      pending.reject(readinessError(`等待${viewMode}视图渲染完成超时`))
    }, MAIN_VIEW_RENDERER_READY_TIMEOUT_MS)
    pending.timer.unref?.()
    pendingMainViewRendererReady = pending
    if (initial) {
      initial.id = pending.id
      initial.deadline = pending.deadline
    }
    window.once('closed', onClosed)
    contents.once('destroyed', onDestroyed)
    contents.once('render-process-gone', onCrashed)
    if (stopped || isQuitting() || window !== getMainWindow() || window.isDestroyed()) onClosed()
    return promise
  }

  function matchesReady(pending, sender, viewMode, document) {
    if (pending?.state === 'pending' && Date.now() >= pending.deadline) {
      pending.reject(readinessError(`等待${pending.viewMode}视图渲染完成超时`))
      return false
    }
    return (
      pending?.state === 'pending' &&
      pending === pendingMainViewRendererReady &&
      !stopped &&
      !isQuitting() &&
      pending.window === getMainWindow() &&
      !pending.window.isDestroyed() &&
      sender === pending.contents &&
      pending.viewMode === activeViewMode &&
      viewMode === pending.viewMode &&
      (pending.baselineGeneration === null ||
        (Number.isSafeInteger(document?.generation) &&
          document.generation === getDocumentGeneration() &&
          document.generation > pending.baselineGeneration))
    )
  }

  function acknowledgeMainViewRendererReady(sender, viewMode, document = {}) {
    const pending = pendingMainViewRendererReady
    if (!matchesReady(pending, sender, viewMode, document)) return false
    return pending.resolve()
  }

  function cancelMainViewRendererReadyWait(error) {
    return pendingMainViewRendererReady?.cancel(error) || false
  }

  async function loadActiveViewIntoWindow(window, initial = null) {
    if (!window || window.isDestroyed()) throw new Error('主窗口不可用')
    const location = getActiveRendererLocation()
    const readyPromise = beginMainViewRendererReadyWait(window, activeViewMode, initial)
    const operation = pendingMainViewRendererReady
    if (mainWindowPresentationTiming) mainWindowPresentationTiming.loadRequestedAt = Date.now()
    const onLoadFailure = (error) => {
      if (operation?.state === 'pending') {
        if (initial) initial.phase = 'load'
        operation.reject(
          initial
            ? Object.assign(new Error(error.message, { cause: error }), {
                code: 'MAIN_VIEW_LOAD_FAILED'
              })
            : error
        )
      } else if (operation?.state === 'succeeded') {
        try {
          logger.error('view.load-after-ready', error, {
            operationId: operation.id,
            viewMode: operation.viewMode
          })
        } catch {
          // An observer cannot revoke a completed business operation or create
          // another unhandled rejection when its diagnostic sink fails.
        }
      }
    }
    try {
      if (operation?.state === 'pending')
        void Promise.resolve(loadWindow(window, location)).catch(onLoadFailure)
    } catch (error) {
      onLoadFailure(error)
    }
    // Core renderer state is the business barrier. A held nonessential resource
    // cannot retain navigation, its page-leave owner, or a deferred quit request.
    await readyPromise
  }

  function isAwaitingFirstReady(window) {
    return Boolean(window && initialization?.window === window && !readyWindows.has(window))
  }

  function isReadyDocument(window) {
    const ready = window && readyDocuments.get(window)
    return Boolean(
      ready &&
      ready.viewMode === activeViewMode &&
      (getDocumentGeneration() === null || ready.generation === getDocumentGeneration())
    )
  }

  function canSkipInitialDrafts(window) {
    return isAwaitingFirstReady(window) && !exposedWindows.has(window) && !window.isVisible()
  }

  function startInitialView(window) {
    if (stopped || isQuitting() || !window || window !== getMainWindow() || window.isDestroyed())
      return Promise.resolve(false)
    if (readyWindows.has(window)) return Promise.resolve(false)
    trackReadyDocument(window)
    const initial = {
      kind: 'initial',
      window,
      windowId: window.id,
      viewMode: activeViewMode,
      state: 'pending',
      phase: 'ready',
      error: null,
      documentGeneration: null,
      hideGeneration: userHideGeneration,
      showRequested: true,
      shown: false,
      requestSequence: 0,
      persistSelection:
        initialViewSelection?.window === window && initialViewSelection.viewMode === activeViewMode
    }
    initialization = initial
    unavailableView = false
    // The ready owner is installed synchronously before loadWindow is called.
    // Catch immediately: first-start failure stays available for explicit retry.
    initial.promise = loadActiveViewIntoWindow(window, initial).then(
      () => true,
      () => false
    )
    return initial.promise
  }

  function requestInitialOpen(window) {
    if (!isAwaitingFirstReady(window)) return null
    if (stopped || isQuitting()) return Promise.resolve(false)
    const pending = pendingMainViewRendererReady
    if (
      pending?.initial === initialization &&
      pending.state === 'pending' &&
      Date.now() >= pending.deadline
    )
      pending.reject(readinessError(`等待${pending.viewMode}视图渲染完成超时`))
    if (initialization.state !== 'pending' && !canSkipInitialDrafts(window))
      return switchMainView(activeViewMode)
    if (initialization.state !== 'pending') startInitialView(window)
    const initial = initialization
    initial.showRequested = true
    initial.hideGeneration = userHideGeneration
    const request = ++initial.requestSequence
    return initial.promise.then((ready) =>
      Boolean(
        ready &&
        initialization === initial &&
        request === initial.requestSequence &&
        initial.shown &&
        isReadyDocument(window) &&
        (initial.documentGeneration === null ||
          initial.documentGeneration === getDocumentGeneration()) &&
        !stopped &&
        !isQuitting() &&
        initial.hideGeneration === userHideGeneration &&
        window === getMainWindow() &&
        !window.isDestroyed() &&
        window.isVisible()
      )
    )
  }

  async function switchInitialView(window, requestedMode) {
    if (requestedMode === activeViewMode) return (await requestInitialOpen(window)) || false
    cancelMainViewRendererReadyWait(new Error('首次启动切换目标视图'))
    initialViewSelection = { window, viewMode: requestedMode }
    prepareViewSettingsForSwitch({
      sourceViewMode: activeViewMode,
      targetViewMode: requestedMode,
      pendingGeometry: geometryPersistence.readPendingBounds()
    })
    activeViewMode = requestedMode
    resetSettingsForView(activeViewMode)
    refreshResolvedSettings({ incrementRevision: true })
    const { bounds, targetDisplay } = resolveActiveViewWindowBounds()
    prepareMainWindowPresentationForView(window, targetDisplay)
    window.setBounds(bounds, false)
    geometryPersistence.setStableBounds({ ...window.getBounds() })
    dockRuntime.setWorkArea(targetDisplay.workArea)
    applyResolvedWindowRuntime()
    const pending = startInitialView(window)
    const initial = initialization
    const succeeded = await pending
    if (!succeeded || initialization !== initial || stopped || isQuitting()) return false
    return true
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
    if (canSkipInitialDrafts(admittedWindow))
      return switchInitialView(admittedWindow, requestedMode)
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
      if (requestedMode === activeViewMode && !unavailableView) {
        queuedViewSwitch = null
        openMainWindow()
        return false
      }
      // The settings drain itself waits for background work. Queue the intent
      // before entering it so an unresolved visual ACK cannot seal admission
      // and reject the user's newer target. Settlement re-enters this method
      // and performs the complete page-leave negotiation before any navigation.
      if (isBackgroundInFlight()) {
        queuedViewSwitch = { ...admission, target: requestedMode }
        admission.transferred = true
        return true
      }
      checkingViewDrafts = true
      let allowed
      try {
        allowed = await confirmEditingDrafts(getMainWindow(), '切换视图', {
          owner: admission,
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
      if (normalized === activeViewMode && !unavailableView) return false

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
        if (!ownsCurrentWindow(admission) || activeViewMode !== normalized) return false
        writeActiveView(normalized)
        unavailableView = false
        rebuildTrayMenu()
        logger.info('view.switch', '已在现有窗口中切换主视图', {
          activeViewMode,
          reusedBrowserWindow: true,
          browserWindowId: reusedWindow.id
        })
        return true
      } catch (error) {
        if (!ownsCurrentWindow(admission) || error.code === 'MAIN_VIEW_LOAD_CANCELLED') return false
        logger.error('view.switch', error, { previousMode, targetMode: normalized })
        try {
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
          unavailableView = false
          try {
            writeActiveView(previousMode)
          } catch (persistRestoreError) {
            logger.error('view.switch-restore-persistence', persistRestoreError, { previousMode })
          }
          rebuildTrayMenu()
        } catch (restoreError) {
          if (!ownsCurrentWindow(admission) || restoreError.code === 'MAIN_VIEW_LOAD_CANCELLED')
            return false
          unavailableView = true
          logger.fatal('view.switch-restore', restoreError, { previousMode })
        }
        return false
      } finally {
        switchingMainView = false
      }
    } finally {
      await resumePageLeave(admission.window, admission)
      if (navigationAdmission === admission) {
        if (!admission.transferred && !admission.rendererNavigationStarted)
          restoreConcealedSource(admission)
        navigationAdmission = null
        try {
          onNavigationSettled()
        } catch (error) {
          logger.error('view.switch-settlement', error)
        }
        if (queuedViewSwitch && !isBackgroundInFlight()) onBackgroundSettled()
      }
    }
  }

  async function switchMainViewFromTray(targetMode) {
    return switchMainView(targetMode)
  }
  function handleRendererReady(sender, viewMode, document = {}) {
    if (stopped || isQuitting()) return false
    const currentWindow = getMainWindow()
    if (!currentWindow || currentWindow.isDestroyed() || sender !== currentWindow.webContents)
      return false
    if (!Object.values(VIEW_MODES).includes(viewMode) || viewMode !== activeViewMode) {
      logger.warn('renderer.ready-stale', '忽略与当前主视图不一致的渲染就绪消息', {
        activeViewMode,
        reportedViewMode: viewMode
      })
      return false
    }
    const operation = pendingMainViewRendererReady
    if (operation && (!matchesReady(operation, sender, viewMode, document) || operation.presenting))
      return false
    const documentEpoch = trackedWindows.get(currentWindow)?.epoch
    if (
      !operation &&
      (switchingMainView || unavailableView || invalidatedWindows.has(currentWindow))
    )
      return false
    const previousReady = readyDocuments.get(currentWindow)
    if (
      !operation &&
      previousReady?.viewMode === viewMode &&
      previousReady.generation === document.generation
    )
      return false
    if (operation) operation.presenting = true
    const stillCurrent = () => {
      const current =
        !stopped &&
        !isQuitting() &&
        currentWindow === getMainWindow() &&
        !currentWindow.isDestroyed() &&
        trackedWindows.get(currentWindow)?.epoch === documentEpoch &&
        activeViewMode === viewMode &&
        (operation
          ? operation.state === 'pending' && pendingMainViewRendererReady === operation
          : pendingMainViewRendererReady === null)
      if (!current && operation?.state === 'pending')
        operation.cancel(new Error('主视图显示期间操作已失效'))
      return current
    }
    try {
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
      const firstReady = !readyWindows.has(currentWindow)
      // A reload keeps this BrowserWindow's visibility. Only startup or an admitted
      // view switch may reveal it; recovery must not undo a user hide or take focus.
      const canShow = () =>
        navigationAdmission
          ? hasVisibilityAuthority(navigationAdmission)
          : operation?.initial
            ? operation.initial === initialization &&
              operation.initial.showRequested &&
              operation.initial.hideGeneration === userHideGeneration
            : firstReady && userHideGeneration === 0
      if (canShow() && stillCurrent()) {
        const showCalledAt = Date.now()
        currentWindow.show()
        if (currentWindow.isVisible()) exposedWindows.add(currentWindow)
        if (!stillCurrent()) return false
        if (canShow() && !currentWindow.isVisible()) throw new Error('主视图窗口未能显示')
        // 视图导航会暂时隐藏 Overlay；窗口重新显示后立即恢复目标视图配置，
        // show 事件中的延迟恢复继续作为 Win10 可见性提交后的幂等兜底。
        if (canShow()) restoreBlurForVisibleWindow(currentWindow, 'renderer-ready')
        if (!stillCurrent()) return false
        if (canShow()) currentWindow.focus()
        if (!stillCurrent()) return false
        if (canShow()) reassertBottomWindowZOrder('renderer-ready')
        if (!stillCurrent()) return false
        setImmediate(() => {
          if (stopped || isQuitting()) return
          if (
            getMainWindow() !== currentWindow ||
            currentWindow.isDestroyed() ||
            activeViewMode !== viewMode
          )
            return
          if (
            Number.isSafeInteger(document.generation) &&
            getDocumentGeneration() !== document.generation
          )
            return
          logger.info('startup.window-presentation', '主窗口首次显示调用已完成', {
            viewMode,
            rendererReadyToShowCallMs: showCalledAt - rendererReadyAt,
            showCallToSnapshotMs: Date.now() - showCalledAt,
            visible: currentWindow.isVisible(),
            focused: currentWindow.isFocused(),
            snapshot: getDockDiagnosticSnapshot()
          })
        })
      }
      if (!stillCurrent()) return false
      if (operation && !matchesReady(operation, sender, viewMode, document)) return false
      if (operation?.initial?.persistSelection) {
        operation.initial.phase = 'commit'
        writeActiveView(viewMode)
        if (!stillCurrent()) return false
        try {
          rebuildTrayMenu()
        } catch (error) {
          logger.error('startup.view-menu', error, { viewMode })
        }
      }
      if (operation?.initial) {
        operation.initial.phase = 'ready'
      }
      if (!stillCurrent()) return false
      const accepted = operation
        ? acknowledgeMainViewRendererReady(sender, viewMode, document)
        : true
      if (!accepted) return false
      readyWindows.add(currentWindow)
      readyDocuments.set(currentWindow, { viewMode, generation: document.generation })
      if (operation?.initial) {
        operation.initial.documentGeneration = document.generation ?? null
        operation.initial.shown = Boolean(canShow() && currentWindow.isVisible())
      }
      // Notification admission uses business readiness, including a held load tail.
      if (accepted) revealPendingNotificationApplication()
      return accepted
    } catch (error) {
      if (operation?.initial) {
        const phase = operation.initial.phase === 'commit' ? 'commit' : 'presentation'
        operation.initial.phase = phase
        operation.reject(
          Object.assign(new Error(error.message, { cause: error }), {
            code: phase === 'commit' ? 'MAIN_VIEW_COMMIT_FAILED' : 'MAIN_VIEW_PRESENTATION_FAILED'
          })
        )
      } else operation?.reject(error)
      logger.error('view.presentation', error, { operationId: operation?.id ?? null, viewMode })
      return false
    }
  }
  function requestFromRenderer(sender, mode) {
    if (stopped || isQuitting()) return false
    if (!Object.values(VIEW_MODES).includes(mode)) throw new Error('无效的主视图')
    if (mode === activeViewMode && !unavailableView) return false
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
    startInitialView,
    requestInitialOpen,
    isAwaitingFirstReady,
    isReadyDocument,
    hasAcceptedReady: (window) => readyWindows.has(window),
    canSkipInitialDrafts,
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
      if (initialization?.window === window) initialization.showRequested = false
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
    isNavigating: () => Boolean(navigationAdmission),
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
      untrackReadyDocument(window)
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
      for (const window of trackedWindows.keys()) untrackReadyDocument(window)
      mainWindowPresentationTiming = null
    },
    snapshot: () => ({
      mode: activeViewMode,
      stopped,
      switching: switchingMainView,
      checkingDrafts: checkingViewDrafts,
      queuedTarget: queuedViewSwitch?.target ?? null,
      unavailable: unavailableView,
      initialization: initialization
        ? {
            id: initialization.id,
            kind: initialization.kind,
            windowId: initialization.windowId,
            viewMode: initialization.viewMode,
            state: initialization.state,
            deadline: initialization.deadline,
            error: initialization.error ? { ...initialization.error } : null,
            phase: initialization.phase,
            documentGeneration: initialization.documentGeneration,
            shown: initialization.shown
          }
        : null,
      pendingReady: pendingMainViewRendererReady
        ? {
            viewMode: pendingMainViewRendererReady.viewMode,
            windowId: pendingMainViewRendererReady.window.id
          }
        : null
    })
  }
}
