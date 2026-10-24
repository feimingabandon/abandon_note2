import { readdirSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/renderer-recovery-electron.mjs',
  mode: 'electron-ready-real-app-renderer-recovery',
  prefix: 'abandon-renderer-recovery-',
  metadata: {
    realWindows: true,
    actualRendererCrashes: 2,
    actualRendererReload: true,
    realPreloadApis: true,
    realNativeWindowMovement: true,
    nativeObservation: 'separate-hidden-powershell-process-at-stable-points',
    isolatedUserData: true,
    mainProcessRestart: false
  }
})
const { assert, root } = lifecycle
const execFileAsync = promisify(execFile)
// Keep Win32 observation in another process. Native reads from a window event
// callback can re-enter Chromium's WndProc while it is changing that same HWND.
async function nativeState(mainHandle, sentinelHandle) {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RecoveryWindowObservation {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
}
'@
$recoveryMainHandle = [IntPtr]::new([long]${mainHandle})
$recoverySentinelHandle = [IntPtr]::new([long]${sentinelHandle})
$recoveryForeground = [RecoveryWindowObservation]::GetForegroundWindow()
@{
  nativeMainHandle = $recoveryMainHandle.ToInt64().ToString()
  nativeSentinelHandle = $recoverySentinelHandle.ToInt64().ToString()
  nativeForeground = $recoveryForeground.ToInt64().ToString()
  nativeVisible = [RecoveryWindowObservation]::IsWindowVisible($recoveryMainHandle)
  nativeSentinelVisible = [RecoveryWindowObservation]::IsWindowVisible($recoverySentinelHandle)
  nativeSentinelEnabled = [RecoveryWindowObservation]::IsWindowEnabled($recoverySentinelHandle)
  nativeForegroundIsMain = $recoveryForeground -eq $recoveryMainHandle
  nativeForegroundIsSentinel = $recoverySentinelHandle -ne [IntPtr]::Zero -and $recoveryForeground -eq $recoverySentinelHandle
} | ConvertTo-Json -Compress
`
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 }
  )
  return JSON.parse(stdout.trim())
}
const readyCounts = new Map()
const scenarios = []
const visibility = []
const sentinelEvents = []
const presentationCalls = []
const windowStates = []
const cleanupStages = []
const evidenceDirectory = process.env.ABANDON_TEST_EVIDENCE_DIR || root
const markCleanup = (stage, details = {}) => {
  cleanupStages.push({ stage, at: Date.now(), ...details })
  writeFileSync(
    join(evidenceDirectory, 'recovery-cleanup.json'),
    JSON.stringify(cleanupStages, null, 2)
  )
}
app.once('before-quit', () => markCleanup('before-quit'))
app.once('will-quit', () => markCleanup('will-quit'))
app.once('quit', () => markCleanup('quit'))
process.once('exit', () => markCleanup('process-exit'))
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
const countReady = (event) => {
  readyCounts.set(event.sender.id, (readyCounts.get(event.sender.id) || 0) + 1)
}
ipcMain.on('renderer-ready', countReady)

async function until(read, message) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) {
      assert.ok(true, message)
      return value
    }
    await wait(25)
  }
  assert.fail(message)
}

function seed() {
  const db = new Database(join(root, 'app.db'))
  try {
    db.exec(`CREATE TABLE app_settings (
      window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
      remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
      PRIMARY KEY(window_name, key))`)
    const insert = db.prepare(
      'INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)'
    )
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['application', 'system', 'z_order_mode', 'normal'],
      ['main', 'system', 'blur_enabled', 'false']
    ])
      insert.run(...row)
  } finally {
    db.close()
  }
}

async function run() {
  let current,
    sentinel,
    completed = false,
    failure = null
  const restoreMethods = []
  const observationListeners = []
  let observing = true
  try {
    const window = await until(
      () =>
        BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().endsWith('/index.html')
        ),
      'main window missing'
    )
    current = window
    const handleOf = (target) =>
      target && !target.isDestroyed() ? target.getNativeWindowHandle().readBigUInt64LE(0) : 0n
    const rendererState = (target) => {
      if (!target || target.isDestroyed()) return null
      const contents = target.webContents
      const snapshot = {}
      for (const [key, read] of Object.entries({
        id: () => contents.id,
        destroyed: () => contents.isDestroyed(),
        crashed: () => contents.isCrashed(),
        loading: () => contents.isLoading(),
        url: () => contents.getURL(),
        osProcessId: () => contents.getOSProcessId()
      })) {
        try {
          snapshot[key] = read()
        } catch (error) {
          snapshot[key] = { observationError: error.message }
        }
      }
      return snapshot
    }
    const state = () => {
      const destroyed = window.isDestroyed()
      const sentinelDestroyed = sentinel ? sentinel.isDestroyed() : null
      return {
        mainWindowId: window.id,
        destroyed,
        visible: !destroyed && window.isVisible(),
        focused: !destroyed && window.isFocused(),
        electronFocusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
        mainRenderer: rendererState(window),
        sentinelWindowId: sentinel?.id ?? null,
        sentinelDestroyed,
        sentinelVisible: Boolean(sentinel && !sentinelDestroyed && sentinel.isVisible()),
        sentinelEnabled: Boolean(sentinel && !sentinelDestroyed && sentinel.isEnabled()),
        sentinelFocusable: Boolean(sentinel && !sentinelDestroyed && sentinel.isFocusable()),
        sentinelFocused: Boolean(sentinel && !sentinelDestroyed && sentinel.isFocused()),
        sentinelRenderer: rendererState(sentinel)
      }
    }
    const recordState = (phase) => {
      const snapshot = { phase, at: Date.now(), ...state() }
      windowStates.push(snapshot)
      return snapshot
    }
    const recordNativeState = async (phase) => {
      const native = await nativeState(String(handleOf(window)), String(handleOf(sentinel)))
      const snapshot = { phase, at: Date.now(), ...state(), ...native }
      windowStates.push(snapshot)
      return snapshot
    }
    const js = (source) => window.webContents.executeJavaScript(source)
    const hooks = await until(
      () => globalThis.__ABANDON_WINDOW_TEST_HOOKS__,
      'production window integration ports missing'
    )
    await until(
      () =>
        window.isVisible() && readyCounts.get(window.webContents.id) && hooks.trayState().created,
      'initial renderer and application did not finish startup'
    )
    for (const event of ['show', 'focus', 'hide', 'blur']) {
      const listener = () => {
        if (observing) visibility.push({ event, at: Date.now(), ...state() })
      }
      window.on(event, listener)
      observationListeners.push([window, event, listener])
    }
    for (const method of ['show', 'focus']) {
      const original = window[method]
      window[method] = (...args) => {
        if (observing)
          presentationCalls.push({
            method,
            at: Date.now(),
            stack: new Error().stack?.split('\n').slice(2, 7)
          })
        return original.apply(window, args)
      }
      restoreMethods.push(() => {
        window[method] = original
      })
    }
    const point = () => screen.getCursorScreenPoint()
    async function waitForReload(previousReady, phase) {
      await until(
        () => (readyCounts.get(window.webContents.id) || 0) > previousReady,
        'renderer did not finish real recovery'
      )
      await wait(100)
      recordState(phase + ':settled')
      assert.equal(window.webContents.isCrashed(), false)
      assert.equal(window.webContents.isLoadingMainFrame(), false)
      assert.equal(window, current, 'recovery must retain the original BrowserWindow')
    }

    // Exercise the real preload -> IPC -> controller -> native movement path.
    const origin = point()
    const beforeDrag = window.getBounds()
    assert.equal(await js(`window.api.beginTitlebarWindowDrag(${JSON.stringify(origin)})`), true)
    await js(
      `window.api.updateTitlebarWindowDrag(${JSON.stringify({ x: origin.x + 8, y: origin.y + 8 })})`
    )
    await until(
      () =>
        hooks.getDockRuntimeState().interactionSuspendCount === 1 &&
        window.getBounds().x !== beforeDrag.x,
      'titlebar drag did not move the real window with its Dock pause'
    )
    const visibleReady = readyCounts.get(window.webContents.id)
    const visibleStart = presentationCalls.length
    window.webContents.forcefullyCrashRenderer()
    await waitForReload(visibleReady, 'visible-crash')
    assert.equal(window.isVisible(), true)
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 0)
    assert.deepEqual(
      presentationCalls.slice(visibleStart),
      [],
      'visible recovery must not show or focus the window again'
    )
    const nextOrigin = point()
    assert.equal(
      await js(`window.api.beginTitlebarWindowDrag(${JSON.stringify(nextOrigin)})`),
      true
    )
    await js(
      `window.api.updateTitlebarWindowDrag(${JSON.stringify({ x: nextOrigin.x + 8, y: nextOrigin.y + 8 })})`
    )
    assert.equal(await js('window.api.endTitlebarWindowDrag()'), true)
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 0)
    scenarios.push('visible renderer crash releases titlebar drag and allows another ordinary drag')

    await js('window.api.closeWindow()')
    await until(() => !window.isVisible(), 'main window did not hide to tray')
    const workArea = screen.getPrimaryDisplay().workArea
    sentinel = new BrowserWindow({
      x: workArea.x + workArea.width - 280,
      y: workArea.y + 40,
      width: 240,
      height: 120,
      show: false,
      title: 'Renderer recovery foreground sentinel',
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
    })
    for (const event of ['show', 'hide', 'focus', 'blur', 'closed']) {
      const listener = () => {
        if (observing) sentinelEvents.push({ event, at: Date.now(), ...state() })
      }
      sentinel.on(event, listener)
      observationListeners.push([sentinel, event, listener])
    }
    const sentinelContents = sentinel.webContents
    const sentinelRendererGone = (_event, details) => {
      if (observing)
        sentinelEvents.push({
          event: 'render-process-gone',
          at: Date.now(),
          details,
          ...state()
        })
    }
    sentinelContents.on('render-process-gone', sentinelRendererGone)
    observationListeners.push([sentinelContents, 'render-process-gone', sentinelRendererGone])
    await sentinel.loadURL(
      'data:text/html,<title>Recovery foreground sentinel</title>Foreground sentinel'
    )
    sentinel.show()
    sentinel.focus()
    await until(
      () => sentinel.isFocused() && !window.isFocused(),
      'sentinel did not acquire Electron focus before the hidden crash'
    )
    // Windows may keep the user's application in the foreground even when
    // Electron reports the sentinel focused. Preserve that actual foreground.
    // Never reassert focus after the crash: that would hide a product regression.
    const sentinelState = await recordNativeState('hidden-crash:foreground-baseline')
    assert.equal(
      sentinel.isVisible(),
      true,
      'foreground sentinel must be visible before the hidden crash'
    )
    assert.equal(
      sentinelState.nativeSentinelVisible,
      true,
      'foreground sentinel must be visible to Windows before the hidden crash'
    )
    assert.notEqual(sentinelState.nativeForeground, '0', 'a real foreground window is required')
    assert.equal(
      sentinelState.nativeForegroundIsMain,
      false,
      'hidden main window must not own actual Windows foreground before crashing'
    )
    const hiddenReady = readyCounts.get(window.webContents.id)
    const hiddenStart = visibility.length
    const hiddenCalls = presentationCalls.length
    window.webContents.forcefullyCrashRenderer()
    await waitForReload(hiddenReady, 'hidden-crash')
    const hiddenState = await recordNativeState('hidden-crash:assertions')
    assert.equal(window.isVisible(), false)
    assert.equal(hiddenState.nativeVisible, false)
    assert.equal(hiddenState.focused, false, 'hidden main window must not own Electron focus')
    assert.equal(
      hiddenState.nativeForegroundIsMain,
      false,
      'hidden main window must not take Windows foreground'
    )
    assert.equal(
      hiddenState.sentinelFocused,
      true,
      'foreground sentinel lost Electron focus during hidden recovery'
    )
    assert.equal(
      hiddenState.nativeForeground,
      sentinelState.nativeForeground,
      'hidden recovery changed the actual foreground window'
    )
    assert.deepEqual(
      presentationCalls.slice(hiddenCalls),
      [],
      'product must not call show/focus during hidden recovery'
    )
    assert.deepEqual(
      visibility.slice(hiddenStart).filter(({ event }) => event === 'show'),
      [],
      'hidden recovery must not reveal or focus the window'
    )
    scenarios.push('a real renderer crash keeps a tray-hidden window hidden')

    hooks.triggerTrayClick()
    await until(() => window.isVisible(), 'tray could not reopen the recovered window')
    await js(`window.api.enterCompactPresentation(${JSON.stringify(point())})`)
    assert.equal(hooks.getPresentationModeState().mode, 'compact')
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 1)
    assert.equal(await js(`window.api.beginCompactWindowDrag(${JSON.stringify(point())})`), true)
    // Establish an actual foreground owner before reload; the first failure had
    // destroyed the sentinel and only observed the main HWND after its user hide.
    // Do not reassert sentinel focus after reload or hide.
    recordState('compact-reload:sentinel-focus-before')
    sentinel.focus()
    recordState('compact-reload:sentinel-focus-returned')
    try {
      await until(
        () => sentinel.isFocused() && !window.isFocused(),
        'sentinel did not acquire Electron focus before the compact reload'
      )
    } catch (error) {
      recordState('compact-reload:sentinel-focus-failed')
      try {
        await recordNativeState('compact-reload:sentinel-focus-failed-native')
      } catch (nativeError) {
        windowStates.push({
          phase: 'compact-reload:sentinel-focus-failed-native-unavailable',
          at: Date.now(),
          ...state(),
          nativeObservationError: {
            message: nativeError.message,
            code: nativeError.code,
            stack: nativeError.stack
          }
        })
      }
      throw error
    }
    const compactForegroundBaseline = await recordNativeState('compact-reload:foreground-baseline')
    assert.equal(
      sentinel.isVisible(),
      true,
      'foreground sentinel must be visible before compact reload'
    )
    assert.equal(
      compactForegroundBaseline.nativeSentinelVisible,
      true,
      'foreground sentinel must be visible to Windows before compact reload'
    )
    assert.notEqual(
      compactForegroundBaseline.nativeForeground,
      '0',
      'a real foreground window is required before compact reload'
    )
    assert.equal(
      compactForegroundBaseline.nativeForegroundIsMain,
      false,
      'compact main window must not own actual Windows foreground before reload'
    )
    const compactReady = readyCounts.get(window.webContents.id)
    window.webContents.once('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) window.close()
    })
    const compactStart = visibility.length
    const compactCalls = presentationCalls.length
    window.webContents.reload()
    await waitForReload(compactReady, 'compact-reload')
    assert.equal(window.isVisible(), false)
    const compactState = await recordNativeState('compact-reload:assertions')
    assert.equal(compactState.nativeVisible, false)
    assert.equal(compactState.focused, false)
    assert.equal(compactState.nativeForegroundIsMain, false)
    assert.equal(
      compactState.nativeForeground,
      compactForegroundBaseline.nativeForeground,
      'compact reload changed the actual foreground window after the user hide'
    )
    assert.deepEqual(
      presentationCalls.slice(compactCalls),
      [],
      'product must not call show/focus after a user hides during reload'
    )
    assert.equal(hooks.getPresentationModeState().mode, 'compact')
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 1)
    assert.deepEqual(
      visibility.slice(compactStart).filter(({ event }) => event === 'show'),
      [],
      'a user hide during reload must survive renderer-ready'
    )
    hooks.triggerTrayClick()
    await until(() => window.isVisible(), 'tray could not reopen compact after reload')
    assert.equal(await js(`window.api.beginCompactWindowDrag(${JSON.stringify(point())})`), true)
    await js('window.api.endCompactWindowDrag()')
    await js('window.api.exitCompactPresentation()')
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 0)
    scenarios.push(
      'manual compact reload releases its drag while preserving a later user hide and the mode pause'
    )
    sentinel.destroy()
    sentinel = null
    markCleanup('sentinel-destroyed', {
      remainingWindowIds: BrowserWindow.getAllWindows().map((target) => target.id),
      mainWindowId: window.id,
      mainWindowDestroyed: window.isDestroyed()
    })
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    ipcMain.removeListener('renderer-ready', countReady)
    const summary = {
      scenarios,
      visibility,
      sentinelEvents,
      presentationCalls,
      windowStates,
      readyCounts: Object.fromEntries(readyCounts)
    }
    // Preserve focus evidence before capturePage: a hidden renderer may have no
    // display surface, which must not discard the observations behind a failure.
    writeFileSync(
      join(evidenceDirectory, 'recovery-state.json'),
      JSON.stringify({ ...summary, completed, error: failure?.stack || null }, null, 2),
      { flag: 'wx' }
    )
    await lifecycle.finish({
      completed,
      error: failure,
      window: current && !current.isDestroyed() && current.isVisible() ? current : undefined,
      summary,
      restore: () => {
        markCleanup('observers-release-start')
        observing = false
        for (const [target, event, listener] of observationListeners)
          target.removeListener(event, listener)
        for (const restore of restoreMethods) restore()
        markCleanup('observers-released')
      }
    })
  }
}

try {
  app.setPath('userData', root)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seed()
  const require = createRequire(import.meta.url)
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'main chunk missing')
  require(resolve('out/main/chunks', chunk))
  app.once('ready', () => void run())
} catch (error) {
  void lifecycle.finish({ error })
}
