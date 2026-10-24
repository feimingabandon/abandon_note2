import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/background-navigation-electron.mjs',
  mode: 'electron-ready-real-app-background-navigation',
  prefix: 'abandon-background-navigation-',
  destroyWindowsBeforeQuit: false,
  metadata: {
    realWindows: true,
    realDiskDatabase: true,
    realPreloadApis: true,
    nativeBlurEnableVerified: true,
    actualWallpaperAfterLeaveAcknowledgment: true,
    controlledAckHolds: true,
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
let nextAckGate = null
const ackGates = []
function holdNextAck(label) {
  let release
  const gate = { label, arrived: null, result: null, error: null, released: false }
  gate.waiting = new Promise((resolve) => {
    release = resolve
  })
  gate.release = () => {
    if (gate.released) return
    gate.released = true
    release()
  }
  ackGates.push(gate)
  nextAckGate = gate
  return gate
}
const releaseAckGates = () => ackGates.forEach((gate) => gate.release())
app.once('will-quit', releaseAckGates)
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, async (event, ...args) => {
    const interested = [
      'set-blur-config',
      'wallpapers:activate',
      'wallpapers:retirement-ack',
      'view:switch'
    ].includes(channel)
    const startedAt = Date.now()
    if (interested)
      trace.push({
        channel,
        phase: 'start',
        at: startedAt,
        requestedMode: channel === 'view:switch' ? args[0]?.mode : undefined
      })
    let gate
    try {
      if (channel === 'wallpapers:retirement-ack' && nextAckGate) {
        gate = nextAckGate
        nextAckGate = null
        gate.arrived = {
          at: Date.now(),
          payload: args[0],
          source: args[1],
          nativeEnabled:
            globalThis.__ABANDON_WINDOW_TEST_HOOKS__.getResolvedSettingsSnapshot().runtime.blur
              .effectiveEnabled,
          dom: await event.sender.executeJavaScript(`({
            wallpaperNodes:document.querySelectorAll('.app-wallpaper,.month-wallpaper').length,
            visible:document.visibilityState
          })`)
        }
        await gate.waiting
      }
      const result = await listener(event, ...args)
      if (gate) gate.result = result
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
      if (gate) gate.error = error.message
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
    await dismissStartupShortcutNotice(current)
    await until(() => js("!document.querySelector('.app-scene').inert"), 'list scene interactive')
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

    // Hold the actual after-leave ACK at the transport boundary. Product CSS,
    // renderer hooks and the main owner all remain real.
    const navigationAck = holdNextAck('navigation')
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
    await until(() => navigationAck.arrived, 'real after-leave ACK reached its transport gate')
    assert.equal(navigationAck.arrived.payload.outcome, 'left')
    assert.equal(navigationAck.arrived.dom.wallpaperNodes, 0)
    assert.equal(navigationAck.arrived.dom.visible, 'visible')
    assert.equal(navigationAck.arrived.nativeEnabled, false)
    // Deliberate fault-injection hold, longer than the removed 190ms wait.
    await wait(250)
    assert.equal(lastBlurCompletion, null)
    assert.equal(hooks.getResolvedSettingsSnapshot().runtime.blur.effectiveEnabled, false)
    assert.ok(hooks.wallpaperRetirementState().pending)
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
    navigationAck.release()
    await until(() => lastBlurCompletion !== null, 'actual preload blur request completed')
    assert.equal(lastBlurCompletion.result.success, true)
    assert.equal(lastBlurCompletion.result.runtime.effectiveEnabled, true)
    assert.equal(lastBlurCompletion.nativeHealth?.healthy, true)
    assert.equal(lastBlurCompletion.nativeHealth?.zOrderSynchronized, true)
    assert.deepEqual(navigationAck.result, { accepted: true })
    assert.ok(
      navigationAck.arrived.at < Date.now(),
      'native completed after the actual ACK arrived'
    )
    assert.deepEqual(hooks.wallpaperRetirementState(), {
      stopped: false,
      pending: null,
      timers: 0,
      listeners: 0
    })
    summary.navigationRetirement = navigationAck.arrived
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
      'real after-leave ACK before native blur; held ACK blocks native beyond the old wait, latest navigation target and source SQLite scope preserved'
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

    async function activateVisibleWallpaper() {
      await js(`window.api.activateWallpaper(${wallpaper.id})`)
      await until(
        () => js("Boolean(document.querySelector('.month-wallpaper'))"),
        'week wallpaper element is present before retirement'
      )
    }
    async function clickExposed(selector) {
      await js(
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`
      )
      await until(
        () =>
          js(`(() => {
            const target=document.querySelector(${JSON.stringify(selector)});
            if(!target || target.disabled || target.closest('[inert]'))return false;
            const r=target.getBoundingClientRect();
            return r.width>0 && r.height>0 &&
              target.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
          })()`),
        'real control exposed to the user: ' + selector
      )
      await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
    }

    // Exercise the new unchanged-failure receipt through the actual settings
    // queue, rather than assigning a result to a renderer test double.
    await activateVisibleWallpaper()
    await dismissStartupShortcutNotice(current)
    await clickExposed('.titlebar-btn-settings[title="设置"]')
    await until(
      () => js("Boolean(document.querySelector('.settings-panel.active'))"),
      'settings open'
    )
    const toggle = '.settings-panel.active [data-diagnostic-action="settings.blurEnabled"]'
    await until(
      () => js(`Boolean(document.querySelector(${JSON.stringify(toggle)}))`),
      'native toggle ready'
    )
    assert.equal(
      await js(`document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-checked')`),
      'false'
    )
    const hiddenAck = holdNextAck('hidden-settings-queue')
    lastBlurCompletion = null
    await clickExposed(toggle)
    await until(() => hiddenAck.arrived, 'settings action reached actual week after-leave ACK')
    assert.equal(hiddenAck.arrived.payload.outcome, 'left')
    assert.equal(hiddenAck.arrived.dom.wallpaperNodes, 0)
    current.hide()
    await until(
      () => lastBlurCompletion !== null,
      'hidden window cancels the waiting native action'
    )
    assert.equal(lastBlurCompletion.result.success, false)
    assert.equal(lastBlurCompletion.result.persistence.status, 'unchanged')
    assert.equal(lastBlurCompletion.result.retirement.status, 'cancelled')
    assert.equal(hooks.wallpaperRetirementState().pending, null)
    assert.equal(hooks.wallpaperRetirementState().timers, 0)
    assert.equal(hooks.wallpaperRetirementState().listeners, 0)
    assert.equal(readBackgroundRows('week').blur_enabled, 'false')
    assert.equal(readBackgroundRows('week').wallpaper_enabled, 'true')
    hiddenAck.release()
    await until(() => hiddenAck.result !== null, 'late ACK from hidden retirement was consumed')
    assert.deepEqual(hiddenAck.result, { accepted: false })
    current.show()
    current.focus()
    await until(
      () =>
        js(
          `document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-checked')==='false'`
        ),
      'real settings queue converges its toggle to unchanged actual config'
    )
    await until(
      () =>
        js(
          "[...document.querySelectorAll('.msg-text,.setting-error')].some(el=>/退场|隐藏|取消/.test(el.textContent))"
        ),
      'actual settings feedback describes the cancelled background operation'
    )
    summary.hidden = {
      completion: lastBlurCompletion,
      lateAck: hiddenAck.result,
      rows: readBackgroundRows('week')
    }
    await clickExposed('.settings-panel.active .panel-close-btn')
    await until(() => js("!document.querySelector('.settings-panel')"), 'settings finished leaving')
    scenarios.push(
      'real settings queue accepts unchanged actual after hide, restores wallpaper and rejects late ACK'
    )

    await activateVisibleWallpaper()
    const reloadAck = holdNextAck('reload')
    lastBlurCompletion = null
    await js(
      'window.__retirementReload=window.api.setBlurConfig({enabled:true}).catch(error=>({error:String(error)}));true'
    )
    await until(() => reloadAck.arrived, 'reload scenario waits at actual after-leave ACK')
    const originalSource = reloadAck.arrived.source
    let reloaded = false
    const onReloaded = () => {
      reloaded = true
    }
    current.webContents.once('did-finish-load', onReloaded)
    try {
      current.webContents.reload()
      await until(() => reloaded, 'same-view reload completed its real document load')
    } finally {
      current.webContents.removeListener('did-finish-load', onReloaded)
    }
    await until(() => lastBlurCompletion !== null, 'reload cancelled old background request')
    assert.equal(lastBlurCompletion.result.success, false)
    assert.equal(lastBlurCompletion.result.retirement.status, 'cancelled')
    const newSnapshot = await until(
      () => js('window.api.getSettingsSnapshot().then(s=>s.source?.token?s:null)'),
      'reloaded document obtained its own source'
    )
    assert.notEqual(newSnapshot.source.token, originalSource.token)
    reloadAck.release()
    await until(() => reloadAck.error !== null, 'old document ACK rejected after reload')
    assert.match(reloadAck.error, /页面已失效/)
    assert.equal(hooks.getResolvedSettingsSnapshot().runtime.blur.effectiveEnabled, false)
    assert.deepEqual(hooks.wallpaperRetirementState(), {
      stopped: false,
      pending: null,
      timers: 0,
      listeners: 0
    })
    summary.reload = {
      originalSource,
      newSource: newSnapshot.source,
      completion: lastBlurCompletion,
      lateAckError: reloadAck.error
    }
    scenarios.push(
      'real reload cancels old visual owner, rotates document token and rejects its late ACK'
    )

    await activateVisibleWallpaper()
    const shutdownAck = holdNextAck('shutdown')
    lastBlurCompletion = null
    await js(
      'window.__retirementShutdown=window.api.setBlurConfig({enabled:true}).catch(error=>({error:String(error)}));true'
    )
    await until(() => shutdownAck.arrived, 'quit scenario has a genuine pending visual wait')
    app.once('before-quit', () => {
      summary.shutdownBeforeQuit = hooks.wallpaperRetirementState()
    })
    app.once('will-quit', () => {
      const result = {
        beforeQuit: summary.shutdownBeforeQuit,
        retirement: hooks.wallpaperRetirementState(),
        background: hooks.backgroundSettingsState(),
        settings: hooks.settingsOperationState(),
        completion: lastBlurCompletion
      }
      try {
        assert.ok(result.beforeQuit.pending, 'quit started with its owned visual wait pending')
        assert.deepEqual(result.retirement, {
          stopped: true,
          pending: null,
          timers: 0,
          listeners: 0
        })
        assert.equal(result.background.pendingRequests, 0)
        assert.equal(result.settings.pending, 0)
        assert.equal(result.completion.result.success, false)
        assert.equal(result.completion.result.retirement.status, 'cancelled')
      } catch (error) {
        result.error = error.stack || String(error)
        console.error(error)
        process.exitCode = 1
      } finally {
        writeFileSync(
          join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, 'wallpaper-retirement-shutdown.json'),
          JSON.stringify(result, null, 2),
          { flag: 'wx' }
        )
      }
    })
    scenarios.push(
      'normal app quit cancels pending retirement before settings drain and releases owner resources'
    )
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    if (failure) releaseAckGates()
    await lifecycle.finish({
      completed,
      error: failure,
      window: current,
      summary: {
        ...summary,
        scenarios,
        trace,
        navigatedViews,
        ackGates: ackGates.map(({ label, arrived, result, error, released }) => ({
          label,
          arrived,
          result,
          error,
          released
        })),
        shutdownEvidenceFile: 'wallpaper-retirement-shutdown.json'
      }
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
