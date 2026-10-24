import { createRequire } from 'node:module'
import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import koffi from 'koffi'
import { captureWindowLayerDiagnostic } from '../src/main/bridge/window-layer-diagnostics.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/native-leaf-runtime-electron.mjs',
  mode: 'electron-main-app-native-leaf-state',
  metadata: {
    browserWindow: true,
    mainProcessRestart: false,
    nativeAbi: NATIVE_ABI_VERSION,
    nativeShutdown: 'direct-Blur_Destroy-and-repeated-owner-observation',
    savedDomainRetry: 'direct-production-owner-with-unchanged-SQLite-rows'
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-native-leaf-' })
let completed = false
let failure
let exitCode = 0
let interloper = null
const layerEvidence = []
const shutdownEvidence = []
const getDefaultIme = koffi.load('imm32.dll').func('uintptr_t ImmGetDefaultIMEWnd(uintptr_t)')
const placeWindow = koffi
  .load('user32.dll')
  .func('int SetWindowPos(uintptr_t, uintptr_t, int, int, int, int, uint32_t)')
const hwnd = (window) => window.getNativeWindowHandle().readBigUInt64LE(0)
function observeLayers(window, phase) {
  const layers = captureWindowLayerDiagnostic(window)
  layerEvidence.push({
    phase,
    layers,
    mainDefaultIme: '0x' + BigInt(getDefaultIme(hwnd(window))).toString(16),
    overlayDefaultIme: layers.overlay?.valid
      ? '0x' + BigInt(getDefaultIme(BigInt(layers.overlay.hwnd))).toString(16)
      : null
  })
  return layers
}
app.setPath('userData', profile.directory)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const seed = new Database(join(profile.directory, 'app.db'))
try {
  createDatabaseSchema(seed)
  const insert = seed.prepare(`INSERT INTO app_settings
    (window_name,type,key,value,remark,created_at,updated_at) VALUES(?,?,?,?,'',?,?)`)
  const now = Date.now()
  for (const [scope, type, key, value] of [
    ['application', 'remote', 'receive_notices', 'false'],
    ['application', 'remote', 'upload_device_info', 'false'],
    ['application', 'application', 'active_view', 'list'],
    ['application', 'onboarding', 'first_use_notice_version', '1'],
    ['main', 'system', 'blur_enabled', 'false']
  ])
    insert.run(scope, type, key, value, now, now)
} finally {
  seed.close()
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(read, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await wait(25)
  }
  throw new Error(label)
}

async function run() {
  try {
    const window = await until(
      () =>
        BrowserWindow.getAllWindows().find((candidate) =>
          /\/index\.html(?:$|[?#])/.test(candidate.webContents.getURL())
        ),
      'Main window did not load'
    )
    await until(() => window.isVisible(), 'Main window did not become visible')
    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    assert.ok(hooks)
    await until(() => hooks.nativeCaptureState().ready, 'Capture prerequisite did not become ready')
    const js = (code) => window.webContents.executeJavaScript(code)
    await js("window.api.setDockConfig({enabledEdges:[],revealHandleMode:'direct'})")
    for (const glass of [false, true]) {
      if (glass) {
        await wait(550)
        const prepared = await js("window.api.setWindowZOrderMode('bottom')")
        assert.equal(prepared.mode, 'bottom')
        assert.equal(prepared.throttled, false)
      }
      const material = await js(`window.api.setBlurConfig({enabled:${glass}})`)
      assert.equal(material.success, true)
      assert.equal(material.runtime.effectiveEnabled, glass)
      for (const mode of [
        'normal',
        'normal',
        'top',
        'top',
        'bottom',
        'bottom',
        'top',
        'normal',
        'bottom',
        'normal'
      ]) {
        await wait(550)
        const result = await js(`window.api.setWindowZOrderMode('${mode}')`)
        assert.equal(result.mode, mode)
        assert.equal(result.throttled, false)
        assert.equal(window.isAlwaysOnTop(), mode === 'top')
        const native = hooks.getWindowZOrderStatus()
        assert.equal(native.enabled, mode === 'bottom')
        if (mode === 'bottom') {
          assert.equal(native.requestedMatches, true)
          assert.equal(native.anchored, true)
        }
        if (glass) {
          const health = hooks.getBlurRuntimeHealth()
          assert.equal(health.healthy, true)
          assert.equal(health.zOrderSynchronized, true)
        }
        let layers = observeLayers(window, `${glass ? 'glass-on' : 'glass-off'}-${mode}`)
        // A disabled overlay still receives an asynchronous sync; inspect its settled band
        // so a hidden failure cannot silently contaminate the later enable operation.
        if (layers.overlay?.topmost !== (mode === 'top')) {
          await wait(100)
          layers = observeLayers(window, '100ms-read-only-band-follow-up')
        }
        assert.equal(layers.parent?.pid, process.pid)
        assert.equal(layers.overlay?.pid, process.pid)
        assert.equal(layers.parent?.topmost, mode === 'top')
        assert.equal(layers.overlay?.topmost, mode === 'top')
        if (glass) assert.equal(layers.adjacencyObserved, true)
        const snapshot = await js('window.api.getSettingsSnapshot()')
        assert.equal(snapshot.values.window.zOrderMode, mode)
        assert.equal(snapshot.runtime.blur.effectiveEnabled, glass)
      }
    }
    // A window inserted after a completed top IPC must heal through native WinEvents.
    // No explicit re-sync, focus call or repeated mode request is allowed in the observation.
    const bounds = window.getBounds()
    interloper = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      x: bounds.x + 20,
      y: bounds.y + 20,
      width: 180,
      height: 200
    })
    await interloper.loadURL('data:text/html,<body>Owned z-order regression window</body>')
    interloper.showInactive()
    for (let round = 0; round < 3; round++) {
      await wait(550)
      const result = await js("window.api.setWindowZOrderMode('top')")
      assert.equal(result.mode, 'top')
      assert.equal(result.throttled, false)
      await wait(45)
      interloper.setAlwaysOnTop(true)
      assert.equal(placeWindow(hwnd(interloper), hwnd(window), 0, 0, 0, 0, 0x13), 1)
      observeLayers(window, `owned-interloper-${round}-immediate`)
      await wait(100)
      const layers = observeLayers(window, `owned-interloper-${round}-100ms`)
      assert.equal(layers.pairStable, true)
      assert.equal(layers.adjacencyObserved, true)
      assert.equal(hooks.getBlurRuntimeHealth().zOrderSynchronized, true)
    }
    interloper.destroy()
    interloper = null
    // Tray show deliberately schedules blur restoration outside the Win32 show stack.
    // Preserve the raw return-time read, yield that boundary, then inspect again at
    // the fixed 100ms observation point without focus, mode or re-sync repair calls.
    for (const glass of [false, true]) {
      const material = await js(`window.api.setBlurConfig({enabled:${glass}})`)
      assert.equal(material.success, true)
      assert.equal(material.runtime.effectiveEnabled, glass)
      for (const mode of ['normal', 'top', 'bottom']) {
        await wait(550)
        const result = await js(`window.api.setWindowZOrderMode('${mode}')`)
        assert.equal(result.mode, mode)
        assert.equal(result.throttled, false)
        for (const hiddenMs of [80, 550]) {
          const initial = observeLayers(window, `restore-${glass}-${mode}-${hiddenMs}-before-hide`)
          await js('window.api.closeWindow()')
          await until(() => !window.isVisible(), 'Close did not hide the main window')
          await wait(hiddenMs)
          const hidden = observeLayers(window, `restore-${glass}-${mode}-${hiddenMs}-hidden`)
          assert.equal(hidden.parent?.hwnd, initial.parent?.hwnd)
          assert.equal(hidden.overlay?.hwnd, initial.overlay?.hwnd)
          assert.equal(hidden.parent?.visible, false)
          assert.equal(hidden.overlay?.visible, false)
          await hooks.openMainWindowFromTray()
          observeLayers(window, `restore-${glass}-${mode}-${hiddenMs}-show-return`)
          await new Promise((done) => setImmediate(done))
          const fence = observeLayers(window, `restore-${glass}-${mode}-${hiddenMs}-show-fence`)
          assert.equal(fence.parent?.hwnd, initial.parent?.hwnd)
          assert.equal(fence.overlay?.hwnd, initial.overlay?.hwnd)
          assert.equal(hooks.getBlurRuntimeHealth().healthy, true)
          await wait(100)
          const shown = observeLayers(window, `restore-${glass}-${mode}-${hiddenMs}-100ms`)
          assert.equal(window.isVisible(), true)
          assert.equal(window.isMinimized(), false)
          assert.equal(shown.parent?.hwnd, initial.parent?.hwnd)
          assert.equal(shown.overlay?.hwnd, initial.overlay?.hwnd)
          assert.equal(shown.parent?.pid, process.pid)
          assert.equal(shown.overlay?.pid, process.pid)
          assert.equal(shown.pairStable, true)
          assert.equal(shown.parent?.visible, true)
          assert.equal(shown.parent?.topmost, mode === 'top')
          assert.equal(shown.overlay?.topmost, mode === 'top')
          assert.equal(shown.overlay?.visible, glass)
          const health = hooks.getBlurRuntimeHealth()
          assert.equal(health.healthy, true)
          if (glass) {
            assert.equal(shown.overlay?.cloaked, 0)
            assert.equal(shown.adjacencyObserved, true)
            assert.equal(health.zOrderSynchronized, true)
          }
          const bottom = hooks.getWindowZOrderStatus()
          assert.equal(bottom.enabled, mode === 'bottom')
          if (mode === 'bottom') {
            assert.equal(bottom.requestedMatches, true)
            assert.equal(bottom.anchored, true)
          }
          const snapshot = await js('window.api.getSettingsSnapshot()')
          assert.equal(snapshot.values.window.zOrderMode, mode)
          assert.equal(snapshot.runtime.blur.effectiveEnabled, glass)
          const database = new Database(join(profile.directory, 'app.db'), { readonly: true })
          try {
            const read = (scope, key) =>
              database
                .prepare('SELECT value FROM app_settings WHERE window_name=? AND type=? AND key=?')
                .get(scope, 'system', key)?.value
            assert.equal(read('application', 'z_order_mode'), mode)
            assert.equal(read('main', 'blur_enabled'), String(glass))
          } finally {
            database.close()
          }
        }
      }
    }
    const disabled = await js('window.api.setBlurConfig({enabled:false})')
    assert.equal(disabled.runtime.effectiveEnabled, false)
    const readSettingsRows = () => {
      const database = new Database(join(profile.directory, 'app.db'), { readonly: true })
      try {
        return database.prepare('SELECT * FROM app_settings ORDER BY window_name,type,key').all()
      } finally {
        database.close()
      }
    }
    const disabledRows = readSettingsRows()
    const retriedDisabled = hooks.retryResolvedBlurRuntime()
    assert.equal(
      retriedDisabled.status,
      'applied',
      'retry must honor the current saved disabled value'
    )
    assert.deepEqual(
      readSettingsRows(),
      disabledRows,
      'successful disabled retry must not rewrite SQL'
    )
    assert.equal(hooks.getBlurRuntimeHealth()?.healthy, true)

    const enabled = await js('window.api.setBlurConfig({enabled:true})')
    assert.equal(enabled.success, true)
    assert.equal(enabled.runtime.effectiveEnabled, true)
    const enabledRows = readSettingsRows()
    assert.equal(hooks.applyResolvedBlurRuntime().status, 'applied')
    assert.equal(hooks.retryResolvedBlurRuntime().status, 'applied')
    assert.deepEqual(
      readSettingsRows(),
      enabledRows,
      'successful enabled retry must not rewrite SQL'
    )
    assert.equal(hooks.getBlurRuntimeHealth()?.healthy, true)

    await js("window.api.setDockConfig({enabledEdges:[],revealHandleMode:'direct'})")
    const dockRows = readSettingsRows()
    assert.equal(hooks.dockCommands.retrySettings('native-leaf-visible').status, 'applied')
    assert.deepEqual(readSettingsRows(), dockRows, 'visible Dock retry must not rewrite SQL')
    await js('window.api.closeWindow()')
    await until(() => !window.isVisible(), 'Close did not hide the main window for Dock retry')
    const hiddenDockRows = readSettingsRows()
    assert.equal(hooks.dockCommands.retrySettings('native-leaf-hidden').status, 'deferred')
    assert.equal(window.isVisible(), false, 'settings retry must preserve the user-hidden window')
    assert.deepEqual(readSettingsRows(), hiddenDockRows, 'deferred Dock retry must not rewrite SQL')
    await hooks.openMainWindowFromTray()
    await until(
      () => window.isVisible(),
      'The tray owner did not restore the window after Dock retry'
    )
    const finalDisabled = await js('window.api.setBlurConfig({enabled:false})')
    assert.equal(finalDisabled.success, true)
    assert.equal(finalDisabled.runtime.effectiveEnabled, false)

    // The layer reads above cannot prove a native STA thread has exited. Read
    // the actual blur owner's shutdown result separately through the same DLL.
    const native = koffi.load(process.env.ABANDON_INTEGRATION_NATIVE_DLL)
    const destroyBlur = native.func('Blur_Destroy', 'void', [])
    const readFailure = native.func('Blur_GetLastFailureJson', 'str', [])
    const isBlurInitialized = native.func('Blur_IsInitialized', 'int', [])
    const beforeDestroy = JSON.parse(readFailure())
    shutdownEvidence.push({ phase: 'before-destroy', diagnostic: beforeDestroy })
    assert.ok(Number.isSafeInteger(beforeDestroy.shutdown?.generation))
    assert.ok(beforeDestroy.shutdown.generation > 0)
    assert.equal(beforeDestroy.shutdown.status, 'not-requested')
    assert.equal(beforeDestroy.shutdown.threadExitConfirmed, false)
    assert.equal(beforeDestroy.shutdown.waitResult, null)
    destroyBlur()
    const afterDestroy = JSON.parse(readFailure())
    shutdownEvidence.push({ phase: 'after-destroy', diagnostic: afterDestroy })
    assert.equal(afterDestroy.shutdown.generation, beforeDestroy.shutdown.generation)
    assert.equal(afterDestroy.shutdown.status, 'completed')
    assert.equal(afterDestroy.shutdown.threadExitConfirmed, true)
    assert.equal(afterDestroy.shutdown.waitResult, 0)
    assert.equal(afterDestroy.shutdown.nativeCode, 0)
    assert.equal(afterDestroy.shutdown.abandoned, false)
    assert.equal(afterDestroy.shutdown.modulePinned, false)
    assert.equal(afterDestroy.shutdown.pinNativeCode, 0)
    assert.equal(isBlurInitialized(), 0)
    destroyBlur()
    const afterRepeatedDestroy = JSON.parse(readFailure())
    shutdownEvidence.push({ phase: 'after-repeated-destroy', diagnostic: afterRepeatedDestroy })
    assert.deepEqual(afterRepeatedDestroy.shutdown, afterDestroy.shutdown)
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
  }
  if (interloper && !interloper.isDestroyed()) interloper.destroy()
  process.exitCode = exitCode
  app.quit()
}

app.once('will-quit', (event) => {
  event.preventDefault()
  writeFileSync(
    join(process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory, 'native-leaf-layers.json'),
    JSON.stringify(
      {
        completed,
        failure: failure?.stack || null,
        observations: layerEvidence,
        nativeShutdown: shutdownEvidence,
        limits: [
          'Non-atomic Win32 reads',
          'Owned blocker is a controlled disturbance',
          'No customer-machine or full regression claim'
        ]
      },
      null,
      2
    ),
    { flag: 'wx' }
  )
  let cleanup = { status: 'complete' }
  if (profile.ownership === 'script' && completed) {
    try {
      rmSync(profile.directory, { recursive: true, force: true })
    } catch (error) {
      cleanup = { status: 'failed', error: error.message }
      exitCode = 1
    }
  } else if (!completed) cleanup = { status: 'preserved', preservedProfile: profile.directory }
  recorder.finish({
    completed,
    error: failure,
    evidence: { status: 'complete' },
    profileOwnership: profile.ownership,
    cleanup
  })
  process.exitCode = exitCode
  app.exit(exitCode)
})
app
  .whenReady()
  .then(run)
  .catch((error) => {
    failure = error
    exitCode = 1
    process.exitCode = 1
    app.quit()
  })
createRequire(import.meta.url)(resolve('out/main/index.js'))
