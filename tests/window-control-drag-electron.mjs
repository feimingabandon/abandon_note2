import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, screen } from 'electron'

const root =
  process.env.ABANDON_TEST_USER_DATA || mkdtempSync(join(tmpdir(), 'abandon-window-control-drag-'))
app.setPath('userData', root)
app.commandLine.appendSwitch('disable-gpu')
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')

const database = new Database(join(root, 'app.db'))
database.exec(`CREATE TABLE app_settings (
  window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY(window_name, key))`)
const insert = database.prepare(
  'INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)'
)
for (const [scope, type, key, value] of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ['main', 'system', 'blur_enabled', 'false']
]) {
  insert.run(scope, type, key, value)
}
database.close()

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))

async function until(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await wait(25)
  }
  throw new Error(message)
}

if (!process.env.ABANDON_TEST_USER_DATA) {
  app.on('quit', () => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Direct execution has no parent runner to clean Chromium cache files.
    }
  })
}

app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const mainChunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(mainChunk, 'main process chunk missing')
require(resolve('out/main/chunks', mainChunk))

const timeout = setTimeout(() => {
  console.error('window control drag integration timed out')
  app.exit(1)
}, 60_000)

async function run() {
  let exitCode = 0
  let window = null
  try {
    window = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.isDestroyed() && candidate.webContents.getURL().endsWith('/index.html')
        ),
      'list window missing'
    )
    await until(() => window.isVisible(), 'list window never became visible')
    const js = (code) => window.webContents.executeJavaScript(code)
    await until(() => js("Boolean(document.querySelector('.app-titlebar'))"), 'titlebar missing')
    await js('window.api.setBlurConfig({ enabled: false })')

    const changeMode = async (mode) => {
      await wait(600)
      const result = await js(`window.api.setWindowZOrderMode('${mode}')`)
      assert.equal(result.throttled, false, `${mode}: z-order request was throttled`)
      assert.equal(result.mode, mode, `${mode}: z-order result did not match request`)
    }
    const toggleLock = async (expected) => {
      await wait(600)
      const result = await js('window.api.toggleLock()')
      assert.equal(result.throttled, false, `lock=${expected}: request was throttled`)
      assert.equal(result.value, expected, `lock=${expected}: state did not change`)
    }
    const drag = async (cycle) => {
      const start = window.getBounds()
      const pointerOrigin = { x: start.x + 120, y: start.y + 24 }
      assert.equal(
        await js(
          `window.api.beginTitlebarWindowDrag(${JSON.stringify(pointerOrigin)}, { dragId: 'cycle-${cycle}' })`
        ),
        true,
        `cycle ${cycle}: drag start was rejected after unlock`
      )

      for (const [deltaX, deltaY] of [
        [18, 12],
        [42, 28],
        [86, 54]
      ]) {
        await js(
          `window.api.updateTitlebarWindowDrag(${JSON.stringify({
            x: pointerOrigin.x + deltaX,
            y: pointerOrigin.y + deltaY
          })})`
        )
        await until(() => {
          const bounds = window.getBounds()
          return bounds.x === start.x + deltaX && bounds.y === start.y + deltaY
        }, `cycle ${cycle}: drag stopped before delta ${deltaX},${deltaY}`)
      }

      assert.equal(
        await js(
          `window.api.endTitlebarWindowDrag({ dragId: 'cycle-${cycle}', reason: 'integration-test' })`
        ),
        true,
        `cycle ${cycle}: drag transaction did not finish`
      )
      assert.deepEqual(
        { x: window.getBounds().x, y: window.getBounds().y },
        { x: start.x + 86, y: start.y + 54 },
        `cycle ${cycle}: drag updates did not accumulate`
      )
    }

    await changeMode('normal')
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      await changeMode('top')
      await changeMode('bottom')
      const workArea = screen.getDisplayNearestPoint(window.getBounds()).workArea
      window.setBounds({ ...window.getBounds(), x: workArea.x + 80, y: workArea.y + 80 })

      await toggleLock(true)
      assert.equal(window.isMovable(), false, `cycle ${cycle}: locked window remained movable`)
      assert.equal(
        await js(
          `window.api.beginTitlebarWindowDrag({ x: 160, y: 120 }, { dragId: 'cycle-${cycle}-locked' })`
        ),
        false,
        `cycle ${cycle}: locked window accepted a drag transaction`
      )

      await toggleLock(false)
      assert.equal(window.isMovable(), true, `cycle ${cycle}: unlocked window remained non-movable`)
      await drag(cycle)
    }

    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    await js("window.api.setDockConfig({ enabledEdges: ['left'], revealHandleMode: 'direct' })")
    await js('window.api.setBlurConfig({ enabled: true })')
    for (const mode of ['normal', 'bottom', 'top']) {
      await changeMode(mode)
      for (const locked of [true, false]) {
        await toggleLock(locked)
        for (const hideMain of [false, true]) {
          const label = `${mode}, locked=${locked}, hideMain=${hideMain}`
          await js(
            `window.api.setSettingValue('interaction.hideMainViewDuringScreenshot', ${hideMain})`
          )
          await js(`window.__captureResult = 'pending';
            void window.api.captureScreen().then(result => { window.__captureResult = result })`)
          const overlay = await until(
            () =>
              BrowserWindow.getAllWindows().find(
                (candidate) =>
                  candidate !== window &&
                  !candidate.isDestroyed() &&
                  candidate.webContents.getURL().startsWith('data:text/html')
              ),
            `${label}: screenshot overlay missing`
          )
          await until(() => overlay.isVisible(), `${label}: screenshot overlay not ready`)
          assert.equal(window.isVisible(), !hideMain, label)
          assert.equal(hooks.getDockRuntimeState().screenshotCaptureActive, true, label)
          assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 1, label)
          hooks.triggerViewVisibilityShortcut()
          assert.equal(window.isVisible(), !hideMain, `${label}: shortcut interrupted screenshot`)
          overlay.webContents.forcefullyCrashRenderer()
          await until(
            () => js('window.__captureResult === null'),
            `${label}: screenshot remained pending`
          )
          await until(() => window.isVisible(), `${label}: main view not restored`)
          assert.equal(overlay.isDestroyed(), true, label)
          const state = hooks.getDockRuntimeState()
          assert.equal(state.screenshotCaptureActive, false, label)
          assert.equal(state.interactionSuspendCount, 0, label)
          assert.equal(state.locked, locked, label)
          assert.equal(window.isMovable(), !locked, label)
          assert.deepEqual(state.activeDockEdges, ['left'], label)
          assert.equal(hooks.getBlurRuntimeHealth()?.healthy, true, label)
          // The shortcut must be usable again after the crash, including while locked.
          hooks.triggerViewVisibilityShortcut()
          await until(() => !window.isVisible(), `${label}: shortcut suspension leaked`)
          hooks.triggerViewVisibilityShortcut()
          await until(() => window.isVisible(), `${label}: shortcut restore failed`)
        }
      }
    }
    console.log(
      '12 screenshot crash combinations: z-order, lock, dock, blur and visibility recovery passed'
    )
    console.log('z-order, lock/unlock and continuous titlebar drag integration passed')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    clearTimeout(timeout)
    app.once('quit', () => process.exit(exitCode))
    app.quit()
  }
}
