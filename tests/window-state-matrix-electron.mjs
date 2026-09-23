import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, screen, powerMonitor } from 'electron'
import koffi from 'koffi'

const root = process.env.ABANDON_TEST_USER_DATA || mkdtempSync(join(tmpdir(), 'window-matrix-'))
app.setPath('userData', root)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const db = new Database(join(root, 'app.db'))
db.exec(
  `CREATE TABLE app_settings (window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT, remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER, PRIMARY KEY(window_name,key))`
)
const insert = db.prepare('INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)')
for (const row of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1']
])
  insert.run(...row)
db.close()
const user32 = koffi.load('user32.dll')
const setCursor = user32.func('int SetCursorPos(int X, int Y)')
const getStyle = user32.func('intptr_t GetWindowLongPtrW(intptr_t hwnd, int index)')
const native = koffi.load(process.env.ABANDON_INTEGRATION_NATIVE_DLL)
const syncGeometry = native.func('Blur_SyncGeometryAndWait', 'int', ['int'])
const syncZOrder = native.func('Blur_IsZOrderSynchronized', 'int', [])
const results = []
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
let win, hooks, originalCursor, currentCase
const js = (code) => win.webContents.executeJavaScript(code)
const state = () => hooks.getDockRuntimeState()
const until = async (fn, label, timeout = 8000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await wait(20)
  }
  throw new Error(label)
}
function persist() {
  const data = JSON.stringify(
    { environment: { platform: process.platform, displays: screen.getAllDisplays() }, results },
    null,
    2
  )
  writeFileSync(join(root, 'matrix-results.json'), data)
  writeFileSync(resolve('tmp/window-state-matrix-results.json'), data)
}
async function scenario(id, fn) {
  if (process.argv[3] && !new RegExp(process.argv[3]).test(id)) return
  currentCase = id
  const started = Date.now()
  try {
    await fn()
    results.push({ id, status: 'passed', durationMs: Date.now() - started })
  } catch (error) {
    const failure = {
      id,
      status: 'failed',
      error: error.stack,
      state: state(),
      durationMs: Date.now() - started
    }
    results.push(failure)
    console.error(JSON.stringify(failure))
  }
  persist()
  console.log(`[matrix] ${results.at(-1).status} ${id}`)
}
async function config(edges, mode = 'direct') {
  await js(
    `window.api.setDockConfig(${JSON.stringify({ enabledEdges: edges, revealHandleMode: mode })})`
  )
}
async function reset() {
  await config([])
  if (hooks.getPresentationModeState().mode !== 'expanded')
    await hooks.exitCompactPresentation({ source: 'matrix-reset' })
  if (state().locked) {
    await wait(600)
    await js('window.api.toggleLock()')
  }
  await hooks.openMainWindowFromTray()
  await until(() => !state().isSliding && !state().isDockHidden, 'reset retained dock session')
  const area = screen.getDisplayMatching(win.getBounds()).workArea
  win.setBounds({
    x: area.x + Math.round(area.width / 4),
    y: area.y + Math.round(area.height / 4),
    width: 480,
    height: 400
  })
  setCursor(area.x + area.width - 60, area.y + area.height - 60)
  await wait(40)
}
async function place(edge) {
  const area = screen.getDisplayMatching(win.getBounds()).workArea
  const b = win.getBounds()
  win.setBounds({
    ...b,
    x:
      edge === 'left'
        ? area.x
        : edge === 'right'
          ? area.x + area.width - b.width
          : area.x + Math.round((area.width - b.width) / 2),
    y: edge === 'top' ? area.y : area.y + Math.round((area.height - b.height) / 2)
  })
  // Same callback as the registered view-visibility shortcut, which synchronizes live geometry.
  await wait(30)
}
async function hide({ sliding = false } = {}) {
  hooks.triggerViewVisibilityShortcut()
  await until(
    () => state().isDockHidden && (sliding ? state().isSliding : !state().isSliding),
    'dock did not enter requested hidden state'
  )
  const s = state()
  assert.ok(s.sessionGeneration > 0)
  if (!sliding) {
    assert.equal(s.mainAtHiddenTarget, true, 'native position is not at hidden target')
    assert.equal(s.edgeMonitor.workerAlive, true, 'native edge monitor is not alive')
    const b = s.mainMotionBounds,
      a = s.session.motionPlan.workArea
    if (s.dockSide === 'left') assert.ok(b.x + b.width <= a.left, 'left edge still visible')
    if (s.dockSide === 'right') assert.ok(b.x >= a.right, 'right edge still visible')
    if (s.dockSide === 'top') assert.ok(b.y + b.height <= a.top, 'top edge still visible')
  }
}
async function restored() {
  await until(
    () => !state().isDockHidden && !state().isSliding && win.isVisible(),
    'window did not restore'
  )
  const s = state()
  assert.equal(s.hasDockMotionSession, false, 'stale dock session')
  assert.equal(s.interactionSuspendCount, 0, 'leaked suspension')
  const b = win.getBounds(),
    a = screen.getDisplayMatching(b).workArea
  assert.ok(
    b.x >= a.x - 2 &&
      b.y >= a.y - 2 &&
      b.x + b.width <= a.x + a.width + 2 &&
      b.y + b.height <= a.y + a.height + 2,
    'restored bounds offscreen'
  )
}
async function show() {
  await hooks.openMainWindowFromTray()
  await restored()
}
async function screenshotCrash(cancel = false) {
  await js(
    `window.__matrixCapture='pending';void window.api.captureScreen().then(r=>{window.__matrixCapture=r})`
  )
  let overlay
  await until(() => {
    overlay = BrowserWindow.getAllWindows().find(
      (w) => w !== win && !w.isDestroyed() && w.webContents.getURL().startsWith('data:text/html')
    )
    return overlay?.isVisible()
  }, 'screenshot overlay missing')
  if (cancel) {
    overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    overlay.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  } else overlay.webContents.forcefullyCrashRenderer()
  await until(() => js('window.__matrixCapture===null'), 'screenshot crash remained pending')
  await restored()
}
async function run() {
  let exitCode = 0
  const timeout = setTimeout(() => {
    console.error('matrix timed out at', currentCase)
    persist()
    app.exit(1)
  }, 600000)
  try {
    originalCursor = screen.getCursorScreenPoint()
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    await until(() => {
      win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/index.html')
      )
      return win?.isVisible()
    }, 'main window missing')
    const originalHandle = win.getNativeWindowHandle().toString('hex')
    for (const view of process.argv[2] && process.argv[2] !== 'all'
      ? [process.argv[2]]
      : ['list', 'month', 'week']) {
      await reset()
      if (state().viewMode !== view) await hooks.switchMainView(view)
      await until(() => state().viewMode === view && win.isVisible(), 'view not ready')
      for (const z of ['normal', 'bottom', 'top']) {
        await reset()
        await wait(600)
        const mode = await js(`window.api.setWindowZOrderMode('${z}')`)
        assert.equal(mode.mode, z)
        for (const blur of [false, true]) {
          await js(`window.api.setBlurConfig({enabled:${blur}})`)
          for (const handle of ['direct', 'on-touch', 'persistent'])
            for (const edge of ['top', 'left', 'right']) {
              await scenario(`M1/${view}/${z}/blur-${blur}/${handle}/${edge}`, async () => {
                await reset()
                await config([edge], handle)
                await place(edge)
                const before = win.getBounds()
                let generation = 0
                for (let cycle = 0; cycle < 2; cycle++) {
                  await hide()
                  assert.ok(state().sessionGeneration > generation)
                  generation = state().sessionGeneration
                  await show()
                  assert.deepEqual(win.getBounds(), before, 'geometry drift')
                  assert.equal(win.getNativeWindowHandle().toString('hex'), originalHandle)
                  assert.equal(
                    Boolean(
                      Number(getStyle(win.getNativeWindowHandle().readBigUInt64LE(), -20)) & 8
                    ),
                    z === 'top',
                    'native topmost drift'
                  )
                  if (blur) {
                    assert.equal(syncGeometry(1000), 1)
                    assert.equal(syncZOrder(), 1)
                  }
                }
              })
            }
        }
        await scenario(`M2/${view}/${z}/lock-hover-drag-unlock`, async () => {
          await reset()
          await config(['left'])
          await place('left')
          await wait(600)
          assert.equal((await js('window.api.toggleLock()')).value, true)
          await js('window.api.windowHover(false)')
          await wait(700)
          assert.equal(state().isDockHidden, false, 'locked window auto-hid')
          assert.equal(await js('window.api.beginTitlebarWindowDrag({x:100,y:100})'), false)
          assert.equal(win.isMovable(), false)
          await wait(600)
          assert.equal((await js('window.api.toggleLock()')).value, false)
          await hide()
          await show()
        })
      }
      await wait(600)
      await js("window.api.setWindowZOrderMode('bottom')")
      for (const phase of ['hidden', 'sliding'])
        for (const action of [
          'disable-edge',
          'handle-mode',
          'lock',
          'layer',
          'view',
          'tray',
          'compact',
          'display-event',
          'suspend-event',
          'resume-event',
          'lock-screen-event',
          'unlock-screen-event',
          'screenshot-crash',
          'screenshot-cancel'
        ]) {
          await scenario(`M3/${view}/${phase}/${action}`, async () => {
            await reset()
            if (state().viewMode !== view) await hooks.switchMainView(view)
            await config(['left'], 'persistent')
            await place('left')
            await wait(600)
            await hide({ sliding: phase === 'sliding' })
            if (action === 'disable-edge') await config([])
            else if (action === 'handle-mode') await config(['left'], 'on-touch')
            else if (action === 'lock') {
              assert.equal((await js('window.api.toggleLock()')).value, true)
              await show()
              assert.equal(win.isMovable(), false)
            } else if (action === 'layer') {
              const r = await js("window.api.setWindowZOrderMode('top')")
              assert.equal(r.mode, 'top')
              await show()
            } else if (action === 'view')
              await hooks.switchMainViewFromTray(view === 'list' ? 'month' : 'list')
            else if (action === 'tray') await hooks.openMainWindowFromTray()
            else if (action === 'compact') {
              await hooks.enterCompactPresentation({ x: 700, y: 400 })
              await hooks.exitCompactPresentation({ source: 'matrix' })
            } else if (action === 'display-event')
              hooks.handleDisplayTopologyChange({
                eventName: 'display-metrics-changed',
                displayId: screen.getPrimaryDisplay().id,
                changedMetrics: ['workArea']
              })
            else if (action === 'suspend-event') powerMonitor.emit('suspend')
            else if (action === 'resume-event') powerMonitor.emit('resume')
            else if (action === 'lock-screen-event') powerMonitor.emit('lock-screen')
            else if (action === 'unlock-screen-event') powerMonitor.emit('unlock-screen')
            else if (action === 'screenshot-crash') await screenshotCrash()
            else if (action === 'screenshot-cancel') await screenshotCrash(true)
            await restored()
          })
        }
      await scenario(`M4/${view}/rapid-requests`, async () => {
        await reset()
        await wait(600)
        const locks = await js(
          'Promise.all([window.api.toggleLock(),window.api.toggleLock(),window.api.toggleLock()])'
        )
        assert.equal(locks.filter((r) => r.changed).length, 1)
        assert.equal(locks.filter((r) => r.throttled).length, 2)
        await reset()
        await config(['left'])
        await place('left')
        await hide({ sliding: true })
        await Promise.all([
          hooks.openMainWindowFromTray(),
          hooks.openMainWindowFromTray(),
          hooks.openMainWindowFromTray()
        ])
        await restored()
      })
      await scenario(`M4/${view}/rapid-layer`, async () => {
        await reset()
        await wait(600)
        await js("window.api.setWindowZOrderMode('normal')")
        await wait(600)
        const modes = await js(
          "Promise.all(['top','bottom','normal'].map(mode=>window.api.setWindowZOrderMode(mode)))"
        )
        assert.equal(modes.filter((r) => r.throttled).length, 2)
        assert.equal(modes[0].mode, 'top')
        assert.equal(
          Boolean(Number(getStyle(win.getNativeWindowHandle().readBigUInt64LE(), -20)) & 8),
          true
        )
        await restored()
      })
      await scenario(`M4/${view}/rapid-compact`, async () => {
        await reset()
        await Promise.all([
          hooks.enterCompactPresentation({ x: 700, y: 400 }),
          hooks.enterCompactPresentation({ x: 720, y: 420 }),
          hooks.exitCompactPresentation({ source: 'matrix-reentry' })
        ])
        assert.equal(hooks.getPresentationModeState().mode, 'expanded')
        assert.equal(hooks.getPresentationModeState().operation, null)
        await restored()
      })
    }
    await reset()
    console.log(
      `MATRIX_COMPLETE ${results.filter((r) => r.status === 'passed').length}/${results.length}`
    )
    exitCode = results.some((r) => r.status !== 'passed') ? 1 : 0
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    clearTimeout(timeout)
    if (originalCursor) setCursor(originalCursor.x, originalCursor.y)
    persist()
    app.once('quit', () => process.exit(exitCode))
    app.quit()
  }
}
app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
require(
  resolve(
    'out/main/chunks',
    readdirSync(resolve('out/main/chunks')).find((name) => /^index-[\w-]+\.js$/.test(name))
  )
)
