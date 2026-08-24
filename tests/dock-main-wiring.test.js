import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MAIN_PATH = new URL('../src/main/index.js', import.meta.url)
const PRELOAD_PATH = new URL('../src/preload/index.js', import.meta.url)

describe('dock main-process wiring', () => {
  it('exposes one authorized atomic dock IPC and no generic per-field write path', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const preload = readFileSync(PRELOAD_PATH, 'utf8')
    const allowlist = source.slice(
      source.indexOf('const RENDERER_WRITABLE_SETTING_IDS'),
      source.indexOf('const APPLICATION_SETTING_IDS')
    )
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
    const reconcile = source.slice(
      source.indexOf('function reconcileDockRuntimeConfig'),
      source.indexOf('function persistSettingValues')
    )
    const doHide = source.slice(
      source.indexOf('function doHide()'),
      source.indexOf('function doShow(')
    )
    const toggle = source.slice(
      source.indexOf('function toggleWindow()'),
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
    expect(source).toContain("syncVisibleDockSide({ source: 'hover-hide-timer', snap: true })")
    expect(source).toContain("reconcileDockRuntimeConfig(previousDockConfig, 'reset-settings')")
    expect(source).toContain(
      "beginNativeEdgeCleanup(generation, windowMotionBackend, 'native-edge-start-timeout')"
    )
    expect(source).toContain('Boolean(nativeEdgeCleanupPending)')
    expect(source).toContain("onCaptureStart: () => beginDockInteractionSuspension('screenshot')")
    expect(source).toContain("onCaptureEnd: () => endDockInteractionSuspension('screenshot')")
    expect(source).toContain('dockInteractionSuspendCount > 0')
    expect(source).toContain('if (nativeEdgeCleanupPending)')
    expect(source).toContain("resetDockState({ source: 'view-switch' })")
    expect(source).toContain('本次视图切换已安全取消')
    expect(source).toContain('const EDGE_TRIGGER_THICKNESS_DIP = 2')
    expect(source).toContain('const EDGE_MONITOR_POLL_INTERVAL_MS = 50')
  })

  it('re-snaps an overshot window after native dragging ends without looping', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const snapToEdge = source.slice(
      source.indexOf('function snapToEdge(side)'),
      source.indexOf('function slideTo(')
    )

    expect(source).toContain("mainWindow.on('moved'")
    expect(source).toContain(
      "syncVisibleDockSide({ source: 'window-moved', snap: true, forceSnap: true })"
    )
    expect(source).toContain('(forceSnap || nextSide !== previousSide)')
    expect(snapToEdge).toContain('Math.abs(motionPlan.initial.x - motionPlan.visibleX) <= 1')
    expect(snapToEdge).toContain('if (alreadySnapped) return')
  })

  it('keeps fullscreen display-metric recovery offscreen and generation-safe', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const rebuild = source.slice(
      source.indexOf('function rebuildFullscreenDockSessionAfterDisplayChange'),
      source.indexOf('function handleDockDisplayTopologyChange')
    )
    const topology = source.slice(
      source.indexOf('function handleDockDisplayTopologyChange'),
      source.indexOf('function attachDockPowerListeners')
    )

    expect(rebuild).toContain('monitorStatus?.fullscreenActive !== true')
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

  it('persists native handle drag events without rebuilding the hidden session', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const handler = source.slice(
      source.indexOf('function handleNativeEdgeMonitorMessage'),
      source.indexOf('function attachNativeEdgeMonitorMessageHook')
    )
    const hide = source.slice(source.indexOf('function doHide'), source.indexOf('function doShow'))

    expect(handler).toContain("event.kind === 'handle-moved'")
    expect(handler).toContain("id: 'dock.revealHandlePositions'")
    expect(handler).toContain('dockMotionSession.handlePositionPermille = positionPermille')
    expect(handler).toContain('windowMotionBackend.setPersistentHandlePosition')
    expect(hide).toContain('resolveDockRevealHandlePositionPermille')
    expect(hide).toContain("applyDockPersistentHandlePosition(dockMotionSession, 'hide')")
  })
})
