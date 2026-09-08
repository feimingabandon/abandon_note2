import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const url = (path) => new URL(path, import.meta.url)
const read = (path) => readFileSync(url(path), 'utf8')

describe('compact single-window architecture', () => {
  it('reveals the main view from notifications without routing into note editors', () => {
    const main = read('../src/main/index.js')
    const service = read('../src/main/services/NotificationService.js')
    const preload = read('../src/preload/index.js')
    const listApp = read('../src/renderer/src/App.vue')
    const calendarApp = read('../src/renderer/src/MonthApp.vue')

    expect(main).toMatch(/function revealApplicationFromNotification\([^)]*\)/)
    expect(main).toContain('revealPendingNotificationApplication()')
    expect(main).toContain('expandCompactWindowForNotification()')
    expect(service).toContain('this.revealApplication?.()')
    expect(service).toContain('`${this.appProtocol}://notification/open`')
    for (const source of [main, preload, listApp, calendarApp]) {
      expect(source).not.toContain('notification:open-note')
      expect(source).not.toContain('onNotificationOpenNote')
      expect(source).not.toContain('openNoteFromNotification')
    }
  })

  it('keeps every new Windows runtime suite in the CI and release aggregate', () => {
    const packageJson = JSON.parse(read('../package.json'))
    const aggregate = packageJson.scripts['test:window-frame:win']
    const ci = read('../.github/workflows/ci.yml')
    const release = read('../.github/workflows/release.yml')

    for (const testFile of [
      'daily-report-electron.mjs',
      'titlebar-icon-scale-electron.mjs',
      'view-visibility-shortcut-electron.mjs',
      'compact-window-electron.mjs list',
      'compact-window-electron.mjs month',
      'compact-window-electron.mjs week',
      'compact-window-electron.mjs list notification'
    ]) {
      expect(aggregate).toContain(testFile)
    }
    expect(ci).toContain('npm run test:window-frame:win')
    expect(release).toContain('npm run test:window-frame:win')
  })

  it('pre-mounts both presentations in each main renderer and has no dedicated compact renderer', () => {
    const config = read('../electron.vite.config.mjs')
    const scene = read('../src/renderer/src/components/system/CompactWindowScene.vue')

    for (const path of ['../src/renderer/src/App.vue', '../src/renderer/src/MonthApp.vue']) {
      const source = read(path)
      expect(source).toContain(
        "import CompactWindowScene from './components/system/CompactWindowScene.vue'"
      )
      expect(source).toContain(':transition="compactWindow.transition.value"')
      expect(source).toContain('is-compact-stage-')
    }
    expect(scene).toContain("import CompactIsland from './CompactIsland.vue'")
    expect(scene).toContain('<CompactIsland :phase="phase" />')
    expect(scene).toContain('<slot />')
    expect(scene).toContain('is-stage-content-exit')
    expect(scene).toContain('is-stage-shell-transform')
    expect(scene).toContain('is-stage-content-enter')
    expect(config).not.toContain('compact.html')
    expect(config).not.toContain('preload/compact.js')
    expect(existsSync(url('../src/renderer/compact.html'))).toBe(false)
    expect(existsSync(url('../src/renderer/src/CompactApp.vue'))).toBe(false)
    expect(existsSync(url('../src/renderer/src/compact-main.js'))).toBe(false)
    expect(existsSync(url('../src/preload/compact.js'))).toBe(false)
  })

  it('owns compact and expanded phases with one BrowserWindow and one renderer surface', () => {
    const main = read('../src/main/index.js')
    const controller = read('../src/main/windows/compact-window-controller.js')
    const transitionBlock = main.slice(
      main.indexOf('async function runCompactNativeTransition'),
      main.indexOf('function flushPendingCompactTopologyChange')
    )

    expect(main.match(/new BrowserWindow\(/g)).toHaveLength(1)
    expect(main).toContain('function getActiveVisualWindow()')
    expect(main).toContain('return mainWindow')
    expect(main).not.toContain('let compactWindow = null')
    expect(main).not.toContain('function createCompactWindow')
    expect(main).not.toContain("loadFile(join(RENDERER_ROOT, 'compact.html'))")
    expect(transitionBlock.match(/runWindowTransition\(/g)).toHaveLength(1)
    expect(controller).not.toContain('setInterval')
    expect(controller).not.toContain('.setBounds(')
  })

  it('uses a compositor clock with a fixed carrier and one final HWND resize', () => {
    const transition = read('../native_blur/transition_engine.cpp')
    const blurEngine = read('../native_blur/blur_engine.cpp')
    const bridge = read('../src/main/bridge/blur_bridge.js')

    expect(transition).toContain('blurEngine.SetWindowTransitionGeometry')
    expect(transition).toContain('blurEngine.AbortWindowTransition')
    expect(transition).toContain('DwmFlush()')
    expect(transition).toContain('blurEngine.AnimateShellTransition(durationMs)')
    expect(transition).toContain('composition-shell')
    expect(transition).not.toContain('std::pow(')
    expect(blurEngine).toContain('CreateVector2KeyFrameAnimation()')
    expect(blurEngine).toContain('CompositionBatchTypes::Animation')
    expect(blurEngine).toContain('m_shellClipGeometry.StartAnimation(property, animation)')
    expect(blurEngine).toContain('m_blurVisual.IsVisible(cfg.enabled)')
    expect(blurEngine).toContain('BeginDeferWindowPos(showOverlay ? 2 : 1)')
    expect(blurEngine.match(/DeferWindowPos\(/g)?.length).toBeGreaterThanOrEqual(4)
    expect(blurEngine).toContain('EqualRect(&parentAfter, &overlayAfter)')
    expect(blurEngine).toContain('WM_BLUR_TRANSITION_VISUAL')
    expect(blurEngine).not.toContain('TransitionVisualSize')
    expect(blurEngine).toContain('static_cast<WPARAM>(width)')
    expect(blurEngine).toContain('static_cast<LPARAM>(height)')
    expect(blurEngine).toContain('m_rootVisual.Clip(m_clip)')
    expect(blurEngine).toContain('m_tintVisual.Size(visualSize)')
    expect(blurEngine).toContain('m_tintVisual.Opacity(cfg.tintOpacity)')
    expect(bridge).toContain('lib.WindowTransition_Run.async(')
    expect(bridge).toContain('WindowTransition_GetStatusJson')

    for (const forbidden of [
      'TransitionHost',
      'CreateSurfaceFromHwnd',
      'CreateRectangleClip',
      'DWMWA_CLOAK',
      'WindowTransition_SetCloaked'
    ]) {
      expect(transition).not.toContain(forbidden)
      expect(bridge).not.toContain(forbidden)
    }
  })

  it('retires the fixed native shell without rebasing visible clip coordinates', () => {
    const source = read('../native_blur/blur_engine.cpp')
    const finish = source.slice(
      source.indexOf('bool Engine::FinishShellOnSta()'),
      source.indexOf('void Engine::CancelShellOnSta()')
    )
    expect(finish).not.toContain('.Offset(')
    expect(finish).not.toContain('SetWindowPos(')
    expect(finish).toContain('GetCommitBatch(CompositionBatchTypes::Animation)')
    expect(finish).toContain('m_rootVisual.IsVisible(true)')
    expect(finish).toContain('m_shellRoot.IsVisible(false)')
    expect(finish).toContain('m_shellReleaseBatch.Completed(')
  })

  it('waits for final layout before handing the shell to the entering content', () => {
    const main = read('../src/main/index.js')
    const preload = read('../src/preload/index.js')
    const composable = read('../src/renderer/src/composables/useCompactWindowMode.js')
    const scene = read('../src/renderer/src/components/system/CompactWindowScene.vue')

    expect(main).toContain('PRESENTATION_STAGES.CONTENT_EXIT')
    expect(main).toContain('PRESENTATION_STAGES.SHELL_TRANSFORM')
    expect(main).toContain('PRESENTATION_STAGES.CONTENT_ENTER')
    expect(main).not.toContain('COMPACT_EXPAND_CONTENT_ENTER_PROGRESS')
    expect(main).toContain('PRESENTATION_STAGES.SHELL_SETTLE')
    expect(main).toContain('await finishWindowTransitionShell()')
    expect(main).toContain('operationWindow.setOpacity(originalOpacity)')
    expect(main).toContain('operationWindow.setIgnoreMouseEvents(false)')
    expect(main).toContain('setTransitionStage(')
    expect(main).toContain('screen.dipToScreenRect(window, bounds)')
    expect(main).not.toContain('screen.dipToScreenPoint')
    expect(main).toContain("ipcMain.on('compact-window:transition-ready'")
    expect(preload).toContain(
      "ipcRenderer.send('compact-window:transition-ready', generation, stage)"
    )
    expect(scene).toContain('requestAnimationFrame(() => requestAnimationFrame(resolve))')
    expect(scene).toContain('notifyCompactTransitionReady?.(generation, expectedStage)')
    expect(composable).not.toContain('compactSceneLayout')
    expect(composable).not.toContain('is-compact-window-transition')
  })

  it('keeps pointer-driven drags lossless and suspends dock snapping for titlebar sessions', () => {
    const main = read('../src/main/index.js')
    const preload = read('../src/preload/index.js')
    const titlebar = read('../src/renderer/src/components/system/AppTitlebar.vue')
    const island = read('../src/renderer/src/components/system/CompactIsland.vue')

    expect(preload).toContain("ipcRenderer.invoke('titlebar-window:begin-drag', point)")
    expect(preload).toContain("ipcRenderer.send('titlebar-window:update-drag', point)")
    expect(preload).toContain("ipcRenderer.invoke('compact-window:begin-drag', point)")
    expect(main).toContain("beginDockInteractionSuspension('titlebar-drag')")
    expect(main).toContain("endDockInteractionSuspension('titlebar-drag')")
    expect(main).toContain('if (titlebarDragSession) return')
    const titlebarDrag = main.slice(
      main.indexOf('function beginTitlebarWindowDrag'),
      main.indexOf('const WINDOW_CONTROL_GUARD_MS')
    )
    expect(titlebarDrag).toContain('windowMotionBackend?.capture()')
    expect(titlebarDrag).toContain('setDockPosition(motionPosition, session.motionPlan)')
    expect(titlebarDrag).toContain('expectedElectronContentSize')
    expect(titlebarDrag).toContain("logger.error('titlebar.drag-move'")
    expect(titlebarDrag).not.toContain('mainWindow.setPosition(')
    expect(titlebar).toContain('window.api.beginTitlebarWindowDrag(titlebarDragLatestPoint)')
    expect(titlebar).toContain('window.api.updateTitlebarWindowDrag(titlebarDragLatestPoint)')
    expect(titlebar).toContain('@pointerdown="onTitlebarPointerDown"')
    expect(titlebar).toContain('target.closest(TITLEBAR_INTERACTIVE_SELECTOR)')
    expect(titlebar).toContain('-webkit-app-region: no-drag')
    expect(titlebar).not.toContain('-webkit-app-region: drag')
    expect(island).toContain('window.api.beginCompactWindowDrag(pointerStart)')
    expect(island).toContain('window.api.updateCompactWindowDrag(pointerLatest)')
  })

  it('restores BrowserWindow geometry before releasing a failed renderer scene transaction', () => {
    const main = read('../src/main/index.js')
    const api = read('../native_blur/blur_api.h')
    const blurEngine = read('../native_blur/blur_engine.cpp')
    const bridge = read('../src/main/bridge/blur_bridge.js')
    const enterRollback = main.slice(
      main.indexOf('async function enterCompactWindow()'),
      main.indexOf('async function exitCompactWindow()')
    )
    const exitRollback = main.slice(
      main.indexOf('async function exitCompactWindow()'),
      main.indexOf('async function resizeCompactWindow(')
    )

    expect(
      enterRollback.indexOf("restoreCompactWindowBounds(operationWindow, expandedBounds, 'enter')")
    ).toBeLessThan(
      enterRollback.indexOf("compactWindowController.setPhase(operationWindow, 'expanded')")
    )
    expect(
      exitRollback.indexOf("restoreCompactWindowBounds(operationWindow, compactBounds, 'exit')")
    ).toBeLessThan(
      exitRollback.indexOf("compactWindowController.setPhase(operationWindow, 'compact')")
    )
    expect(api).toContain('BLUR_API int Blur_ApplyConfig(')
    expect(blurEngine).toContain('bool Engine::ApplyConfigAndWait(')
    expect(blurEngine).toContain('SendMessageTimeoutW(')
    expect(blurEngine).toContain('IsWindowVisible(self->m_parentHwnd.load()) && FAILED(DwmFlush())')
    expect(bridge).toContain('export function setWindowBoundsSynchronized(')
    expect(bridge).toContain('lib.WindowTransition_Run(')
    expect(bridge).toContain('      0\n    )')
  })

  it('authorizes and broadcasts application changes only through the current main window', () => {
    const main = read('../src/main/index.js')
    const authorization = read('../src/main/ipc/ipc-authorization.js')

    expect(main).toContain('getAuthorizedWindows: () => getApplicationWindows()')
    expect(main).toContain('getBroadcastWindows: () => getApplicationWindows()')
    expect(main).toContain("compactControlIpc.handle('compact-window:get-settings'")
    expect(main).toContain('return mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : []')
    expect(authorization).toContain('Array.isArray(resolved)')
  })
})
