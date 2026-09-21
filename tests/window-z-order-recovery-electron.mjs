import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import koffi from 'koffi'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'abandon-z-order-recovery-')))
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const database = new Database(join(app.getPath('userData'), 'app.db'))
database.exec(`CREATE TABLE app_settings (
  window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY(window_name, key))`)
const insert = database.prepare(
  'INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)'
)
for (const [scope, type, key, value] of [
  ['application', 'application', 'active_view', 'month'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1']
])
  insert.run(scope, type, key, value)
database.close()
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
let debugWindow
async function until(fn, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await fn()) return
    await wait(30)
  }
  if (debugWindow && !debugWindow.isDestroyed()) {
    console.error('Layer diagnostics', layerDiagnostics(debugWindow))
    console.error(
      'Settings',
      await debugWindow.webContents.executeJavaScript('window.api.getSettingsSnapshot()')
    )
  }
  throw new Error(label)
}
const user32 = koffi.load('user32.dll')
const getStyle = user32.func('intptr_t GetWindowLongPtrW(intptr_t hwnd, int index)')
const native = koffi.load(process.env.ABANDON_INTEGRATION_NATIVE_DLL)
const synchronized = native.func('Blur_IsZOrderSynchronized', 'int', [])
function nativeTop(window) {
  return Boolean(Number(getStyle(window.getNativeWindowHandle().readBigUInt64LE(), -20)) & 8)
}
function layerDiagnostics(window) {
  const next = user32.func('intptr_t GetWindow(intptr_t hwnd, uint32_t command)')
  const owner = user32.func('uint32_t GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)')
  const name = user32.func('int GetClassNameA(intptr_t hwnd, _Out_ uint8_t *name, int size)')
  const visible = user32.func('int IsWindowVisible(intptr_t hwnd)')
  const windows = []
  let hwnd = next(window.getNativeWindowHandle().readBigUInt64LE(), 0)
  while (hwnd) {
    const pid = [0]
    owner(hwnd, pid)
    if (pid[0] === process.pid) {
      const text = Buffer.alloc(128)
      name(hwnd, text, text.length)
      windows.push({
        hwnd: String(hwnd),
        name: text.toString().split('\0')[0],
        top: Boolean(Number(getStyle(hwnd, -20)) & 8),
        visible: Boolean(visible(hwnd))
      })
    }
    hwnd = next(hwnd, 2)
  }
  return {
    windows,
    healthy: native.func('Blur_IsHealthy', 'int', [])(),
    synchronized: synchronized()
  }
}
app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const mainChunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(mainChunk)
require(resolve('out/main/chunks', mainChunk))

async function run() {
  try {
    let previousWindow
    for (const view of ['month', 'list', 'week']) {
      const reusedWindow = previousWindow
      const reusedNativeHandle = reusedWindow?.getNativeWindowHandle().toString('hex')
      if (reusedWindow)
        await previousWindow.webContents.executeJavaScript(`window.api.switchMainView('${view}')`)
      const file = view === 'list' ? 'index' : view
      let window
      await until(() => {
        window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().endsWith(`/${file}.html`)
        )
        return window?.isVisible()
      }, `${view}: window missing`)
      if (reusedWindow) {
        assert.equal(window, reusedWindow, `${view}: view switch replaced BrowserWindow`)
        assert.equal(window.isDestroyed(), false, `${view}: reused BrowserWindow was destroyed`)
        assert.equal(
          window.getNativeWindowHandle().toString('hex'),
          reusedNativeHandle,
          `${view}: view switch replaced native HWND`
        )
      }
      previousWindow = window
      debugWindow = window
      const js = (code) => window.webContents.executeJavaScript(code)
      await until(
        () => js(`Boolean(document.querySelector('.light-pin'))`),
        `${view}: titlebar missing`
      )
      const changeMode = async (mode) => {
        await wait(600)
        const result = await js(`window.api.setWindowZOrderMode('${mode}')`)
        assert.equal(result.throttled, false)
        return result
      }
      await js('window.api.setBlurConfig({enabled:true})')
      await changeMode('normal')
      const originalSetTop = window.setAlwaysOnTop.bind(window)
      let dropTopRequests = 1
      window.setAlwaysOnTop = (...args) => {
        if (args[0] && dropTopRequests-- > 0) return
        return originalSetTop(...args)
      }
      await changeMode('top')
      assert.equal(
        nativeTop(window),
        true,
        `${view}: ignored native request was reported successful without recovery`
      )
      await until(
        () => synchronized() === 1,
        `${view}: visible blur did not follow recovered topmost state`
      )
      window.setAlwaysOnTop = originalSetTop

      // Simulate real window drift while the saved/UI mode remains top, then use the actual menu.
      originalSetTop(false)
      assert.equal(nativeTop(window), false)
      await wait(650)
      await js(`document.querySelector('.light-pin').click()`)
      await until(
        () => js(`Boolean(document.querySelector('.z-order-option[data-mode="top"]'))`),
        'menu missing'
      )
      await js(`document.querySelector('.z-order-option[data-mode="top"]').click()`)
      await until(
        () => nativeTop(window),
        `${view}: selecting the current mode did not repair drift`
      )
      await until(() => synchronized() === 1, `${view}: blur did not follow same-mode recovery`)

      await changeMode('normal')
      window.setAlwaysOnTop = (...args) => {
        if (!args[0]) return originalSetTop(...args)
      }
      await assert.rejects(changeMode('top'), /窗口层级|置顶/)
      assert.equal(
        await js(`window.api.getSettingsSnapshot().then(s => s.values.window.zOrderMode)`),
        'normal',
        `${view}: failed request persisted top`
      )
      assert.equal(nativeTop(window), false)
      window.setAlwaysOnTop = originalSetTop

      // Windows callbacks can re-enter application code while leaving native bottom mode.
      await changeMode('bottom')
      let reenterShow = true
      window.setAlwaysOnTop = (...args) => {
        if (args[0] && reenterShow) {
          reenterShow = false
          window.emit('show')
        }
        return originalSetTop(...args)
      }
      await changeMode('top')
      assert.equal(
        nativeTop(window),
        true,
        `${view}: show callback restored the obsolete bottom mode`
      )
      window.setAlwaysOnTop = originalSetTop
      for (const mode of ['top', 'bottom', 'top', 'normal', 'top']) {
        await changeMode(mode)
        assert.equal(
          nativeTop(window),
          mode === 'top',
          `${view}: actual layer differs after ${mode}`
        )
        await until(() => synchronized() === 1, `${view}: blur layer differs after ${mode}`)
      }
      console.log(
        `${view}: transient failure recovery, repeated menu selection, permanent failure rollback and native blur synchronization passed`
      )
    }
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}
