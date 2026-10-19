import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MAIN_PATH = new URL('../src/main/index.js', import.meta.url)
const PRELOAD_PATH = new URL('../src/preload/index.js', import.meta.url)
const DOCK_PATH = new URL('../src/main/window-motion/dock-runtime.js', import.meta.url)
const NAVIGATION_PATH = new URL('../src/main/windows/main-view-navigation.js', import.meta.url)
const CAPTURE_PATH = new URL('../src/main/capture/capture-window-integration.js', import.meta.url)

describe('dock main-process wiring', () => {
  it('exposes one authorized atomic dock IPC and no generic per-field write path', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const preload = readFileSync(PRELOAD_PATH, 'utf8')
    // The application IDs are now imported; using their old declaration as an
    // end marker sliced the whole remainder of main and produced false failures.
    const allowlistMatch = source.match(
      /const RENDERER_WRITABLE_SETTING_IDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/
    )
    expect(allowlistMatch, 'renderer allowlist declaration must exist').not.toBeNull()
    const allowlist = [...allowlistMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
    const handler = source.slice(
      source.indexOf("mainWindowIpc.handle('set-dock-config'"),
      source.indexOf("mainWindowIpc.handle('get-settings-snapshot'")
    )

    expect(preload).toContain(
      "setDockConfig: (config) => ipcRenderer.invoke('set-dock-config', config)"
    )
    expect(allowlist).not.toContain('dock.revealHandleMode')
    expect(allowlist).not.toContain('dock.enabledEdges')
    expect(handler).toContain('validateDockConfigPayload(config)')
    expect(handler).toContain("id: 'dock.revealHandleMode'")
    expect(handler).toContain("id: 'dock.enabledEdges'")
    expect(handler.match(/persistSettingValues\(/g)).toHaveLength(1)
  })

  it('fails open on active config changes and revalidates delayed/tray hides', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const dock = readFileSync(DOCK_PATH, 'utf8')
    const capture = readFileSync(CAPTURE_PATH, 'utf8')
    const reconcile = dock.slice(
      dock.indexOf('function reconcileDockRuntimeConfig'),
      dock.indexOf('function scheduleNativeEdgeCleanup')
    )
    const doHide = dock.slice(dock.indexOf('function doHide()'), dock.indexOf('function doShow('))
    const toggle = source.slice(
      source.indexOf('function toggleWindow('),
      source.indexOf('function openMainWindow()')
    )

    expect(reconcile).toContain('cancelPendingDockHide')
    expect(reconcile).toContain('emergencyRestoreDock')
    expect(doHide).toContain('activeEdges.includes(dockSide)')
    expect(doHide).toContain('revealHandleMode: dockConfig.revealHandleMode')
    expect(doHide).toContain('revealHandleMode: dockMotionSession.revealHandleMode')
    expect(doHide).toContain('windowMotionBackend.showPersistentHandle(generation)')
    expect(doHide).toContain("doShow('queued-during-hide')")
    expect(doHide.indexOf("doShow('queued-during-hide')")).toBeLessThan(
      doHide.indexOf('windowMotionBackend.showPersistentHandle(generation)')
    )
    expect(toggle).toContain("syncVisibleDockSide({ source: 'tray-toggle', snap: true })")
    expect(dock).toContain("syncVisibleDockSide({ source: 'hover-hide-timer', snap: true })")
    expect(source).toContain("reconcileDockRuntimeConfig(previousDockConfig, 'reset-settings')")
    expect(dock).toContain(
      "beginNativeEdgeCleanup(generation, windowMotionBackend, 'native-edge-start-timeout')"
    )
    expect(dock).toContain('Boolean(nativeEdgeCleanupPending)')
    expect(capture).toContain("suspendDock('screenshot')")
    expect(capture).toContain("resumeDock('screenshot')")
    expect(source).toContain('screenshotCaptureActive: captureWindowIntegration.isActive()')
    expect(dock).toContain('dockInteractionSuspendCount > 0')
    const navigation = readFileSync(NAVIGATION_PATH, 'utf8')
    expect(navigation).toContain('if (dockRuntime.cleanupStatus)')
    expect(navigation).toContain("dockRuntime.resetDockState({ source: 'view-switch' })")
    expect(navigation).toContain('本次视图切换已安全取消')
    expect(dock).toContain('const EDGE_TRIGGER_THICKNESS_DIP = 2')
    expect(dock).toContain('const EDGE_MONITOR_POLL_INTERVAL_MS = 50')
    expect(source).toContain('dockRuntime.handleHover(isHovering)')
  })

  it('re-snaps an overshot window after native dragging ends without looping', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const dock = readFileSync(DOCK_PATH, 'utf8')
    const snapToEdge = dock.slice(
      dock.indexOf('function snapToEdge(side)'),
      dock.indexOf('function slideTo(')
    )

    expect(source).toContain("getMainWindow().on('moved'")
    expect(source).toContain(
      "syncVisibleDockSide({ source: 'window-moved', snap: true, forceSnap: true })"
    )
    expect(dock).toContain('(forceSnap || nextSide !== previousSide)')
    expect(snapToEdge).toContain('Math.abs(motionPlan.initial.x - motionPlan.visibleX) <= 1')
    expect(snapToEdge).toContain('if (alreadySnapped) return')
  })

  it('keeps fullscreen display-metric recovery offscreen and generation-safe', () => {
    const source = readFileSync(DOCK_PATH, 'utf8')
    const rebuild = source.slice(
      source.indexOf('function rebuildFullscreenDockSessionAfterDisplayChange'),
      source.indexOf('function handleDockDisplayTopologyChange')
    )
    const topology = source.slice(
      source.indexOf('function handleDockDisplayTopologyChange'),
      source.indexOf('function attachDockPowerListeners')
    )

    expect(rebuild).toContain('monitorStatus?.fullscreenActive !== true')
    expect(rebuild).toContain('resolveFullscreenRebuildHandlePosition(')
    expect(rebuild.indexOf('resolveFullscreenRebuildHandlePosition(')).toBeLessThan(
      rebuild.indexOf('stopEdgeMonitorForFullscreenRebuild({')
    )
    expect(rebuild).toContain('stopEdgeMonitorForFullscreenRebuild({')
    expect(rebuild).toContain('setDockPosition({ x: motionPlan.hiddenX, y: motionPlan.hiddenY }')
    expect(rebuild).toContain('const generation = ++dockSessionSequence')
    expect(rebuild).toContain('windowMotionBackend.armEdgeMonitor')
    expect(rebuild).toContain('windowMotionBackend.showPersistentHandle(generation)')
    expect(rebuild).toContain("emergencyRestoreDock('fullscreen-display-rebuild-failed'")
    expect(topology).toContain("change?.eventName === 'display-metrics-changed'")
    expect(topology).toContain('String(change.displayId) !== String(dockMotionSession.displayId)')
    expect(topology).toContain('pendingDockDisplayChange')
  })

  it('keeps native handle dragging session-local and resets every new hide to center', () => {
    const source = readFileSync(DOCK_PATH, 'utf8')
    const handler = source.slice(
      source.indexOf('function handleNativeEdgeMonitorMessage'),
      source.indexOf('function attachNativeEdgeMonitorMessageHook')
    )
    const hide = source.slice(source.indexOf('function doHide'), source.indexOf('function doShow'))

    expect(handler).toContain("event.kind === 'handle-moved'")
    expect(handler).toContain('dockMotionSession.handlePositionPermille = positionPermille')
    expect(handler).toContain('windowMotionBackend.setPersistentHandlePosition')
    expect(handler).toContain('persisted: false')
    expect(handler).not.toContain('persistSettingValue')
    expect(hide).toContain('handlePositionPermille: null')
    expect(hide).not.toContain("applyDockPersistentHandlePosition(dockMotionSession, 'hide')")
  })

  it('records actionable hide and wake latency plus low-noise native status transitions', () => {
    const source = readFileSync(DOCK_PATH, 'utf8')
    const hide = source.slice(
      source.indexOf('function doHide()'),
      source.indexOf('function doShow(')
    )
    const show = source.slice(
      source.indexOf('function doShow('),
      source.indexOf('function handleDockHover')
    )

    expect(source).toContain('pendingDockHideRequestedAt = Date.now()')
    expect(hide).toContain('requestDelayMs:')
    expect(hide).toContain('preparationMs:')
    expect(hide).toContain('animationMs:')
    expect(hide).toContain('totalElapsedMs:')
    expect(hide).toContain("dockNativeStatusObserver.start(generation, 'arm-succeeded')")
    expect(hide).toContain(
      'snapshot: isDeepDiagnosticMode() ? getDockDiagnosticSnapshot() : undefined'
    )
    expect(hide).toContain("dockNativeStatusObserver.capture('persistent-handle-activated'")
    expect(show).toContain('monitorStopMs')
    expect(show).toContain('animationMs:')
    expect(show).toContain('totalElapsedMs:')
    expect(show).toContain("dockNativeStatusObserver.capture('show-before-disarm'")
    expect(show).toContain("dockNativeStatusObserver.stop('show-after-disarm')")
    expect(show).toContain('terminalMatchesTarget')
    expect(show).toContain(
      'display: isDeepDiagnosticMode() ? getDockDiagnosticSnapshot().display : undefined'
    )
    expect(source).not.toContain("logger.info('dock.slide-frame'")
  })

  it('distinguishes minimized window geometry and avoids duplicate recovery errors', () => {
    const source = readFileSync(DOCK_PATH, 'utf8')
    const main = readFileSync(MAIN_PATH, 'utf8')
    const health = source.slice(
      source.indexOf('function getDockDiagnosticSnapshot'),
      source.indexOf('function resetDockState')
    )
    const power = source.slice(
      source.indexOf('function handleDockPowerBoundary'),
      source.indexOf('function attachDockPowerListeners')
    )

    expect(health).toContain('mainWindowMinimized')
    expect(health).toContain('mainElectronBounds')
    expect(health).toContain('mainContentBounds')
    expect(health).toContain("electronBounds: 'DIP'")
    expect(health).toContain('scalePercent:')
    expect(health).toContain('visibleTarget:')
    expect(health).toContain('hiddenTarget:')
    expect(health).toContain('{ skipRecoveryLog: true }')
    expect(main).toContain("getMainWindow().on('minimize'")
    expect(main).toContain("getMainWindow().on('restore'")
    expect(power).toContain("recoveryLogLevel: 'info'")
  })

  it('records startup presentation timing and display topology before/after snapshots', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')

    const navigation = readFileSync(NAVIGATION_PATH, 'utf8')
    expect(source).toContain('mainViewNavigation.recordTiming')
    expect(navigation).toContain("logger.info('startup.window-presentation'")
    expect(navigation).toContain('createdToRendererReadyMs:')
    expect(navigation).toContain('loadRequestedToRendererReadyMs:')
    expect(navigation).toContain('showCallToSnapshotMs:')
    const dock = readFileSync(DOCK_PATH, 'utf8')
    expect(dock).toContain("logger.info('window.display-topology', '开始处理显示器参数变化'")
    expect(dock).toContain("logger.info('window.display-topology', '显示器参数变化处理完成'")
  })
})
