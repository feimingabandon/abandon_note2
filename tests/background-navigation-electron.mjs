import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/background-navigation-electron.mjs',
  mode: 'electron-ready-real-app-background-navigation',
  prefix: 'abandon-background-navigation-',
  metadata: {
    realWindows: true,
    realDiskDatabase: true,
    realPreloadApis: true,
    nativeBlurEnableVerified: true,
    actualWallpaperExitDelay: true,
    sqlFailureInjectedWithRealTrigger: true,
    mixedDpi: false,
    mainProcessRestart: false
  }
})
const { assert, root } = lifecycle
const databasePath = join(root, 'app.db')
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const trace = []
const scenarios = []
const navigatedViews = []
let lastBlurCompletion = null
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, async (event, ...args) => {
    const interested = ['set-blur-config', 'wallpapers:activate', 'view:switch'].includes(channel)
    const startedAt = Date.now()
    if (interested)
      trace.push({
        channel,
        phase: 'start',
        at: startedAt,
        requestedMode: channel === 'view:switch' ? args[0]?.mode : undefined
      })
    try {
      const result = await listener(event, ...args)
      if (interested) trace.push({ channel, phase: 'complete', at: Date.now() })
      if (channel === 'set-blur-config') {
        const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
        lastBlurCompletion = {
          elapsedMs: Date.now() - startedAt,
          result,
          background: hooks.backgroundSettingsState(),
          navigation: hooks.navigationState(),
          nativeHealth: hooks.getBlurRuntimeHealth(),
          nativeZOrder: hooks.getWindowZOrderStatus()
        }
      }
      return result
    } catch (error) {
      if (interested) trace.push({ channel, phase: 'error', at: Date.now(), error: error.message })
      throw error
    }
  })
async function until(read, message, step = 20) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) {
      assert.ok(true, message)
      return value
    }
    await wait(step)
  }
  assert.fail(message)
}
function readBackgroundRows(scope) {
  const db = new Database(databasePath, { readonly: true })
  try {
    return Object.fromEntries(
      db
        .prepare(
          "SELECT key,value FROM app_settings WHERE window_name=? AND key IN ('blur_enabled','wallpaper_enabled','active_wallpaper_id') ORDER BY key"
        )
        .all(scope)
        .map(({ key, value }) => [key, value])
    )
  } finally {
    db.close()
  }
}
function seedSettings() {
  const db = new Database(databasePath)
  try {
    db.exec(
      `CREATE TABLE app_settings (window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))`
    )
    const insert = db.prepare(
      'INSERT INTO app_settings (window_name,type,key,value) VALUES(?,?,?,?)'
    )
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['application', 'system', 'z_order_mode', 'normal'],
      ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false'])
    ])
      insert.run(...row)
  } finally {
    db.close()
  }
}
function wallpaperPayload() {
  const bitmap = Buffer.from([
    255, 80, 60, 255, 60, 180, 255, 255, 80, 220, 120, 255, 245, 210, 70, 255
  ])
  const png = nativeImage
    .createFromBitmap(bitmap, { width: 2, height: 2, scaleFactor: 1 })
    .toPNG()
    .toString('base64')
  return {
    original: { base64: png, ext: 'png' },
    cropped: { base64: png, ext: 'png' },
    crop: { x: 0, y: 0, width: 2, height: 2, scale: 1 }
  }
}

async function run() {
  let current,
    completed = false,
    failure = null
  const summary = {}
  try {
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
        ),
      'actual list window loaded'
    )
    await until(() => current.isVisible(), 'list renderer ready made the actual window visible')
    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    assert.equal(typeof hooks?.backgroundSettingsState, 'function')
    assert.equal(typeof hooks?.navigationState, 'function')
    await until(() => hooks.nativeCaptureState().ready, 'actual app startup prerequisite settled')
    const js = (source) => current.webContents.executeJavaScript(source)
    current.webContents.on('did-navigate', (_event, url) => {
      const match = String(url).match(/\/(index|month|week)\.html(?:$|[?#])/)
      if (match) navigatedViews.push(match[1])
    })
    await until(() => js("Boolean(document.querySelector('.app-titlebar'))"), 'list UI ready')
    await js("window.api.setDockConfig({enabledEdges:[],revealHandleMode:'direct'})")
    const windowId = current.id
    const hwnd = current.getNativeWindowHandle().toString('hex')
    const wallpaper = await js(`window.api.saveWallpaper(${JSON.stringify(wallpaperPayload())})`)
    assert.ok(Number(wallpaper.id) > 0)
    await js(`window.api.activateWallpaper(${wallpaper.id})`)
    await until(
      () => js("Boolean(document.querySelector('.app-wallpaper'))"),
      'actual wallpaper image became visible'
    )
    const before = await js('window.api.getSettingsSnapshot()')
    assert.equal(before.values.wallpaper.enabled, true)
    assert.equal(before.values.wallpaper.activeId, wallpaper.id)
    assert.equal(before.runtime.blur.effectiveEnabled, false)
    const monthBefore = readBackgroundRows('month')
    const weekBefore = readBackgroundRows('week')

    // Keep the product's real 190 ms delay. No timer substitution or held IPC replies.
    lastBlurCompletion = null
    await js(
      'window.__backgroundBlurRequest=window.api.setBlurConfig({enabled:true}).then(result=>{window.__backgroundBlurResult=result;return result}); true'
    )
    await until(
      () => hooks.backgroundSettingsState().blurInFlight === 1,
      'wallpaper exit owns an in-flight blur request',
      5
    )
    assert.equal(hooks.navigationState().mode, 'list')
    assert.equal(readBackgroundRows('main').wallpaper_enabled, 'false')
    assert.equal(await js("window.api.switchMainView('month')"), true)
    await until(
      () => hooks.navigationState().queuedTarget === 'month',
      'first target queued during actual wallpaper exit',
      5
    )
    assert.equal(await js("window.api.switchMainView('week')"), true)
    await until(
      () => hooks.navigationState().queuedTarget === 'week',
      'last target replaces the first while the background request is pending',
      5
    )
    assert.equal(hooks.backgroundSettingsState().blurInFlight, 1)
    summary.queued = {
      background: hooks.backgroundSettingsState(),
      navigation: hooks.navigationState(),
      mainRows: readBackgroundRows('main')
    }
    await until(() => lastBlurCompletion !== null, 'actual preload blur request completed')
    assert.equal(lastBlurCompletion.result.success, true)
    assert.equal(lastBlurCompletion.result.runtime.effectiveEnabled, true)
    assert.equal(lastBlurCompletion.nativeHealth?.healthy, true)
    assert.equal(lastBlurCompletion.nativeHealth?.zOrderSynchronized, true)
    assert.ok(
      lastBlurCompletion.elapsedMs >= 185,
      'wallpaper retirement was not the product 190 ms path'
    )
    assert.equal(lastBlurCompletion.navigation.mode, 'list')
    summary.blurCompletion = lastBlurCompletion
    await until(
      () =>
        /\/week\.html(?:$|[?#])/.test(current.webContents.getURL()) &&
        current.isVisible() &&
        !hooks.navigationState().switching,
      'only the final week target completed renderer-ready navigation'
    )
    assert.equal(current.id, windowId)
    assert.equal(current.getNativeWindowHandle().toString('hex'), hwnd)
    assert.deepEqual(
      navigatedViews,
      ['week'],
      'an intermediate month page was loaded instead of consuming one final target'
    )
    const final = await js('window.api.getSettingsSnapshot()')
    assert.ok(final.revision > before.revision)
    assert.equal(final.values.blur.enabled, false)
    assert.equal(final.values.wallpaper.enabled, false)
    assert.equal(final.runtime.blur.effectiveEnabled, false)
    assert.equal(readBackgroundRows('main').blur_enabled, 'true')
    assert.equal(readBackgroundRows('main').wallpaper_enabled, 'false')
    assert.equal(Number(readBackgroundRows('main').active_wallpaper_id), wallpaper.id)
    assert.deepEqual(readBackgroundRows('month'), monthBefore)
    assert.deepEqual(readBackgroundRows('week'), weekBefore)
    assert.equal(hooks.backgroundSettingsState().blurInFlight, 0)
    assert.equal(hooks.backgroundSettingsState().pendingRequests, 0)
    assert.equal(hooks.navigationState().mode, 'week')
    assert.equal(hooks.navigationState().queuedTarget, null)
    const appRows = new Database(databasePath, { readonly: true })
    try {
      assert.equal(
        appRows
          .prepare(
            "SELECT value FROM app_settings WHERE window_name='application' AND key='active_view'"
          )
          .get().value,
        'week'
      )
    } finally {
      appRows.close()
    }
    summary.finalNavigation = {
      snapshot: final,
      background: hooks.backgroundSettingsState(),
      navigation: hooks.navigationState(),
      mainRows: readBackgroundRows('main'),
      monthRows: readBackgroundRows('month'),
      weekRows: readBackgroundRows('week')
    }
    scenarios.push(
      'real 190 ms wallpaper-to-native-blur; month/week latest target and source SQLite scope preserved'
    )

    // Actual SQL rejection of the atomic wallpaper activation must preserve glass state.
    const enabled = await js('window.api.setBlurConfig({enabled:true})')
    assert.equal(enabled.success, true)
    assert.equal(enabled.runtime.effectiveEnabled, true)
    assert.equal(hooks.getBlurRuntimeHealth()?.healthy, true)
    await wait(350)
    const beforeFailure = await js('window.api.getSettingsSnapshot()')
    const rowsBeforeFailure = readBackgroundRows('week')
    const requestsBeforeFailure = hooks.backgroundSettingsState()
    const injection = new Database(databasePath)
    try {
      injection.exec(
        `CREATE TRIGGER fail_b4f_wallpaper_insert BEFORE INSERT ON app_settings WHEN NEW.window_name='week' AND NEW.key='wallpaper_enabled' AND NEW.value='true' BEGIN SELECT RAISE(ABORT,'Injected B4f activation SQL failure'); END;`
      )
      await assert.rejects(
        () => js(`window.api.activateWallpaper(${wallpaper.id})`),
        /Injected B4f activation SQL failure/
      )
    } finally {
      injection.exec('DROP TRIGGER IF EXISTS fail_b4f_wallpaper_insert')
      injection.close()
    }
    const afterFailure = await js('window.api.getSettingsSnapshot()')
    assert.deepEqual(readBackgroundRows('week'), rowsBeforeFailure)
    assert.deepEqual(afterFailure.values.blur, beforeFailure.values.blur)
    assert.deepEqual(afterFailure.values.wallpaper, beforeFailure.values.wallpaper)
    assert.equal(afterFailure.revision, beforeFailure.revision)
    assert.equal(afterFailure.runtime.blur.effectiveEnabled, true)
    assert.equal(hooks.getBlurRuntimeHealth()?.healthy, true)
    assert.equal(hooks.backgroundSettingsState().blurRevision, requestsBeforeFailure.blurRevision)
    assert.equal(
      hooks.backgroundSettingsState().wallpaperRevision,
      requestsBeforeFailure.wallpaperRevision
    )
    assert.equal(hooks.backgroundSettingsState().blurInFlight, 0)
    assert.equal(hooks.backgroundSettingsState().pendingRequests, 0)
    assert.equal(hooks.navigationState().queuedTarget, null)
    summary.sqlFailure = {
      beforeFailure,
      afterFailure,
      rowsBeforeFailure,
      rowsAfterFailure: readBackgroundRows('week'),
      backgroundBefore: requestsBeforeFailure,
      backgroundAfter: hooks.backgroundSettingsState(),
      nativeHealth: hooks.getBlurRuntimeHealth(),
      markUsedIsSeparateTransaction: true
    }
    scenarios.push(
      'actual SQLite wallpaper activation failure restores revisions/failure state and keeps native glass enabled; no partial settings commit'
    )
    await js('window.api.setBlurConfig({enabled:false})')
    assert.equal(hooks.backgroundSettingsState().blurInFlight, 0)
    assert.equal(hooks.backgroundSettingsState().pendingRequests, 0)
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    await lifecycle.finish({
      completed,
      error: failure,
      window: current,
      summary: { ...summary, scenarios, trace, navigatedViews }
    })
  }
}
try {
  app.setPath('userData', root)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seedSettings()
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
