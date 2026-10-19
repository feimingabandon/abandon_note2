import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { app, BrowserWindow, globalShortcut, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { coverCaptureTestDesktop } from './helpers/capture-test-desktop.mjs'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const require = createRequire(import.meta.url),
  execute = promisify(execFile)
const ownedProfile = prepareTestProfile({ prefix: 'abandon-capture-business-' })
const profile = ownedProfile.directory
const realInput = process.env.ABANDON_CAPTURE_REAL_INPUT === '1'
const recorder = createAssertionRecorder({
  suite: 'tests/capture-business-electron.mjs',
  mode: realInput
    ? 'electron-real-app-capture-business-native-input'
    : 'electron-real-app-capture-business-synthetic-transport',
  metadata: {
    actualApplication: true,
    realWindow: true,
    realDatabase: true,
    transport: realInput ? 'native-desktop-input' : 'synthetic-image-output',
    limits: realInput
      ? []
      : ['Native overlay/input/clipboard are not asserted by synthetic transport']
  }
})
const { assert } = recorder
let completed = false
let failure = null
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(30)
  }
  throw new Error(label)
}
mkdirSync(profile, { recursive: true })
const db = new Database(join(profile, 'app.db'))
db.exec(
  'CREATE TABLE app_settings (window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,remark TEXT DEFAULT "",created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))'
)
const insert = db.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
for (const [type, key, value] of [
  ['application', 'active_view', 'list'],
  ['remote', 'receive_notices', 'false'],
  ['remote', 'upload_device_info', 'false'],
  ['onboarding', 'first_use_notice_version', '1'],
  ['shortcuts', 'screenshot', ''],
  ['shortcuts', 'screenshot_copy', ''],
  ['shortcuts', 'clipboard_pin', ''],
  ['shortcuts', 'toggle_pins', '']
])
  insert.run('application', type, key, value)
insert.run('main', 'system', 'blur_enabled', 'false')
db.close()
app.setPath('userData', profile)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
require(resolve('out/main/chunks', chunk))

app.once('ready', async () => {
  let code = 0
  let uncover
  try {
    const window = await until(
      () =>
        BrowserWindow.getAllWindows().find((w) =>
          /\/index\.html(?:$|[?#])/.test(w.webContents.getURL())
        ),
      'Main window missing'
    )
    const js = (body) => window.webContents.executeJavaScript(body)
    await until(() => window.isVisible(), 'Main window never appeared')
    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    await until(() => hooks.nativeCaptureState().ready, 'Native engine not ready')
    if (realInput) uncover = await coverCaptureTestDesktop()
    const coordinator = hooks.captureCoordinator()
    if (!realInput) {
      // Synthetic transport exercises the real coordinator, asset validation,
      // preload, renderer forms and acknowledgements without using a locked desktop.
      const ownedHost = coordinator.host
      coordinator.host = {
        ready: true,
        pid: 0,
        start: async () => {},
        dispose: () => ownedHost.dispose(),
        send: (message) => {
          if (message.type === 'capture' && message.sessionId)
            queueMicrotask(() =>
              coordinator.message({ type: 'captureReady', sessionId: message.sessionId })
            )
          if (message.type === 'ack' && message.accepted)
            queueMicrotask(() =>
              coordinator.message({
                type: 'finished',
                sessionId: message.sessionId,
                status: 'delivered'
              })
            )
          if (message.type === 'cancel')
            queueMicrotask(() =>
              coordinator.message({
                type: 'finished',
                sessionId: message.sessionId,
                status: 'cancelled'
              })
            )
        }
      }
    }
    const press = async (key, ctrl = false) => {
      if (!realInput) {
        if (key === 'F') return
        const id = coordinator.active.id,
          asset = randomUUID()
        const png = nativeImage
          .createFromBitmap(Buffer.alloc(20 * 30 * 4, 220), { width: 20, height: 30 })
          .toPNG()
        writeFileSync(join(coordinator.assets.root, id, `${asset}.png`), png)
        await coordinator.message({
          type: 'output',
          sessionId: id,
          deliveryId: asset,
          action: key === 'N' ? 'note' : key === 'B' ? 'background' : 'source'
        })
        await wait(100)
        return
      }
      await execute(
        resolve('native_capture/build/bin/capture_input_driver.exe'),
        [String(hooks.nativeCaptureState().pid), key, ...(ctrl ? ['ctrl'] : [])],
        { windowsHide: true }
      )
      await wait(100)
    }
    const capture = async () => {
      assert.equal((await hooks.startNativeCapture()).status, 'started')
      await wait(180)
      await press('F')
    }
    const occupied = 'Control+Alt+Shift+F12'
    assert.equal(
      globalShortcut.register(occupied, () => {}),
      true
    )
    assert.equal(
      (await js(`window.api.setCaptureShortcut('screenshot', '${occupied}')`)).status,
      'conflict'
    )
    globalShortcut.unregister(occupied)
    assert.equal(
      (await js(`window.api.setCaptureShortcut('screenshot', 'Control+Alt+Shift+F11')`)).status,
      'saved'
    )
    await js(`window.api.beginViewVisibilityShortcutCapture('screenshot')`)
    const runtime = await js(`window.api.getSettingsSnapshot().then(s=>s.runtime.shortcuts)`)
    assert.equal(runtime.screenshot.registered, false)
    assert.equal(runtime.screenshotCopy.registered, false)
    await js(`window.api.endViewVisibilityShortcutCapture('screenshot')`)
    assert.equal(
      (await js(`window.api.getSettingsSnapshot().then(s=>s.runtime.shortcuts.screenshot)`))
        .registered,
      true
    )
    const configured = await js(`window.api.getSettingsSnapshot().then(s=>s.values.shortcuts)`)
    // Start with empty saved bindings so another application owning Ctrl+F1
    // cannot leave a startup conflict modal ahead of the image-draft checks.
    // The default Ctrl+F1 value is asserted by the shortcut/schema unit tests.
    assert.equal(configured.screenshotCopy, '')
    assert.equal(
      (await js(`window.api.setCaptureShortcut('screenshotCopy', 'Control+Alt+Shift+F10')`)).status,
      'saved'
    )
    assert.equal(
      (await js(`window.api.getSettingsSnapshot().then(s=>s.runtime.shortcuts.screenshotCopy)`))
        .registered,
      true
    )
    assert.equal(
      await js(`window.api.getSettingsSnapshot().then(s=>s.values.shortcuts.screenshotCopy)`),
      'Control+Alt+Shift+F10'
    )
    assert.equal(hooks.trayMenu().find((item) => item.id === 'show-note-reminders').enabled, false)
    assert.equal(hooks.trayMenu().find((item) => item.label === '快速截图复制') !== undefined, true)
    if (!realInput) {
      // Exercise the actual shortcut callback and main-window restore without
      // writing the interactive clipboard. Native automatic copying is tested
      // separately by the Qt test on its private Windows window station.
      hooks.triggerScreenshotShortcut('screenshotCopy')
      await until(
        () => coordinator.active?.mode === 'copy-on-select',
        'Quick-copy shortcut did not start its mode'
      )
      const quickId = coordinator.active.id
      await wait(120)
      await coordinator.message({ type: 'finished', sessionId: quickId, status: 'copied' })
      await until(
        () => !hooks.nativeCaptureState().active,
        'Quick-copy completion did not release the session'
      )
      await until(() => window.isVisible(), 'Quick-copy completion did not restore the main window')
    }

    if (realInput) {
      const pidBeforeClose = coordinator.host.pid
      await capture()
      await press('AltF4')
      await until(
        () => !hooks.nativeCaptureState().active,
        'System close left the coordinator in an active capture session'
      )
      await until(() => window.isVisible(), 'System close did not restore the main window')
      assert.equal(coordinator.host.ready, true)
      assert.equal(coordinator.host.pid, pidBeforeClose)
      console.log('native Alt+F4: session cleared, main window restored, engine retained')
    }

    // Window restoration belongs to one capture and must preserve the original visibility.
    await js("window.api.setSettingValue('interaction.hideMainViewDuringScreenshot', true)")
    await capture()
    assert.equal(window.isVisible(), false, 'Visible source should hide during capture')
    coordinator.cancel()
    await until(() => !hooks.nativeCaptureState().active, 'Cancellation did not finish capture')
    await until(() => window.isVisible(), 'Cancelled capture did not restore its visible source')
    assert.equal(hooks.getDockRuntimeState().screenshotCaptureActive, false)
    window.hide()
    await capture()
    coordinator.cancel()
    await until(
      () => !hooks.nativeCaptureState().active,
      'Hidden-source cancellation did not finish'
    )
    assert.equal(
      window.isVisible(),
      false,
      'Cancellation must not reveal a previously hidden source'
    )

    // Temporary PNG -> validated host delivery -> independent renderer draft.
    // In real-input mode this also verifies recapture after Alt+F4.
    await capture()
    await press('N', true)
    await until(
      () => js(`!!document.querySelector('.app-modal-card[aria-label="截图新建便签"] .ip-thumb')`),
      'Global capture was not attached to a new draft'
    )
    await until(
      () => !hooks.nativeCaptureState().active,
      'Business acknowledgement did not finish native session'
    )
    const draftCount = await js(`window.__prepareEditingDrafts().dirty`)
    assert.equal(draftCount, true)
    assert.equal(
      window.isVisible(),
      true,
      'Accepted business delivery keeps its intentional reveal'
    )

    // Declining an app quit must leave the owned engine and shortcuts alive.
    const beforeQuitPid = coordinator.host.pid
    app.quit()
    await until(
      () => js(`!!document.querySelector('.confirm-card.active[aria-label="保留草稿后继续？"]')`),
      'Quit bypassed draft confirmation'
    )
    await js(
      `Array.from(document.querySelectorAll('.confirm-card.active button')).find(b=>b.textContent.trim()==='继续编辑').click()`
    )
    await until(
      () => js(`!document.querySelector('.confirm-card.active[aria-label="保留草稿后继续？"]')`),
      'Quit cancellation did not dismiss confirmation'
    )
    assert.equal(coordinator.stopping, false)
    assert.equal(coordinator.host.ready, true)
    assert.equal(coordinator.host.pid, beforeQuitPid)
    assert.equal(globalShortcut.isRegistered('Control+Alt+Shift+F11'), true)

    // Existing draft's own screenshot entry adds to that draft, with no DB commit yet.
    await js(`document.querySelector('.app-modal-card[aria-label="截图新建便签"] .sp-btn').click()`)
    await until(() => hooks.nativeCaptureState().active, 'Draft capture did not start')
    await wait(180)
    await press('F')
    await press('Enter')
    await until(
      () =>
        js(
          `document.querySelectorAll('.app-modal-card[aria-label="截图新建便签"] .ip-thumb').length === 2`
        ),
      'Existing draft did not receive the second image'
    )
    await until(
      () => !hooks.nativeCaptureState().active,
      'Source delivery did not release the session'
    )
    await js(
      `document.querySelector('.app-modal-card[aria-label="截图新建便签"] .app-modal-close').click()`
    )
    await until(
      () => js(`!!document.querySelector('.confirm-card.active[aria-label="放弃这张便签草稿？"]')`),
      'Draft close bypassed confirmation'
    )
    await js(
      `Array.from(document.querySelectorAll('.confirm-card.active button')).find(b=>b.textContent.trim()==='放弃草稿').click()`
    )
    await until(
      () => js(`!document.querySelector('.app-modal-card[aria-label="截图新建便签"]')`),
      'Discard did not close screenshot draft'
    )

    // Background goes through the existing crop editor; cancellation does not apply it.
    await capture()
    await press('B', true)
    await until(
      () => js(`!!document.querySelector('[data-modal-layer="wallpaper-crop"]')`),
      'Global background capture did not open crop editor'
    )
    await until(() => !hooks.nativeCaptureState().active, 'Background receiver did not acknowledge')
    await js(
      `Array.from(document.querySelectorAll('[data-modal-layer="wallpaper-crop"] button')).find(b=>b.textContent.trim()==='取消').click()`
    )
    await until(
      () => js(`!document.querySelector('[data-modal-layer="wallpaper-crop"]')`),
      'Background cancellation did not close editor'
    )
    console.log(
      `capture business integration passed (${realInput ? 'real desktop input' : 'synthetic image transport'}): shortcut conflict/recording, global image draft, source draft attachment, draft guard, background crop cancellation`
    )
    completed = true
  } catch (error) {
    console.error(error)
    failure = error
    code = 1
  } finally {
    uncover?.()
    globalShortcut.unregisterAll()
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed())
        await window.webContents
          .executeJavaScript('window.__clearEditingDrafts?.()')
          .catch(() => {})
    app.releaseSingleInstanceLock()
    app.once('quit', () => {
      const cleanup = { status: 'complete' }
      if (ownedProfile.ownership === 'script') {
        try {
          rmSync(profile, { recursive: true, force: true })
        } catch (error) {
          cleanup.status = 'failed'
          cleanup.error = error.message
          code = 1
        }
      }
      recorder.finish({
        completed,
        error: failure,
        cleanup,
        evidence: { status: 'complete' },
        profileOwnership: ownedProfile.ownership
      })
      process.exit(code)
    })
    app.quit()
  }
})
