import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, screen } from 'electron'
import koffi from 'koffi'

const setCursor = koffi.load('user32.dll').func('int SetCursorPos(int X, int Y)')
function positionCursor(point) {
  const physical = screen.dipToScreenPoint(point)
  assert.ok(setCursor(physical.x, physical.y), 'test cursor could not be positioned')
}

const root =
  process.env.ABANDON_TEST_USER_DATA || mkdtempSync(join(tmpdir(), 'abandon-titlebar-native-drag-'))
app.setPath('userData', root)
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
  ['application', 'onboarding', 'first_use_notice_version', '1']
]) {
  insert.run(scope, type, key, value)
}
database.close()

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, message) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await wait(25)
  }
  throw new Error(message)
}

app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(chunk, 'main process chunk missing')
require(resolve('out/main/chunks', chunk))
const timeout = setTimeout(() => app.exit(1), 90_000)

async function run() {
  let exitCode = 0
  const originalCursor = screen.getCursorScreenPoint()
  try {
    const window = await until(
      () =>
        BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().endsWith('/index.html')
        ),
      'main window missing'
    )
    const js = (code) => window.webContents.executeJavaScript(code)
    await until(() => js("Boolean(document.querySelector('.app-titlebar'))"), 'titlebar missing')
    await js("window.api.setDockConfig({ enabledEdges: [], revealHandleMode: 'direct' })")
    const workArea = screen.getDisplayMatching(window.getBounds()).workArea

    // Use Chromium mouse input, not dispatched PointerEvents: DOM-only events cannot
    // trigger native text dragging or the pointercancel that interrupted the user's drag.
    for (const style of ['apple', 'microsoft']) {
      await js(`window.api.setSettingValue('appearance.titlebarStyle', '${style}')`)
      await until(
        () => js(`document.querySelector('.app-titlebar').dataset.style === '${style}'`),
        `${style}: style did not update`
      )
      for (const mode of ['normal', 'top', 'bottom']) {
        await wait(600)
        await js(`window.api.setWindowZOrderMode('${mode}')`)
        window.setBounds({ x: workArea.x + 100, y: workArea.y + 100, width: 480, height: 640 })
        window.show()
        window.focus()
        await wait(150)
        const label = `${style}/${mode}`
        await until(
          () => js("!document.querySelector('.msg-toast')"),
          `${label}: layer toast still covers navigation`
        )
        const point = await js(`(() => {
          document.activeElement?.blur()
          const header = document.querySelector('.app-titlebar')
          const surface = header.querySelector('.app-titlebar-interaction-surface')
          // Supply a title even in views whose title is normally empty, so the
          // regression covers dragging selected text as well as empty padding.
          surface.textContent = '导航拖动验证'
          window.__nativeDragEvents = []
          window.__recordNativeDrag ||= event => window.__nativeDragEvents.push({
            type: event.type, prevented: event.defaultPrevented, trusted: event.isTrusted
          })
          for (const name of ['dragstart', 'pointercancel', 'pointerdown', 'pointerup']) {
            window.addEventListener(name, window.__recordNativeDrag)
          }
          const rect = surface.getBoundingClientRect()
          const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
          if (!surface.contains(document.elementFromPoint(point.x, point.y))) {
            throw new Error('drag origin does not hit the titlebar surface')
          }
          return point
        })()`)
        window.webContents.selectAll()
        await until(
          () => js('window.getSelection().toString().length > 0'),
          `${label}: no page selection`
        )
        const start = window.getBounds()
        const origin = { x: start.x + point.x, y: start.y + point.y }
        // Repositioning an HWND may generate a native move at the real cursor.
        // Keep that cursor aligned with Chromium input so it cannot replace the
        // synthetic drag point with the pointer left by the preceding test.
        positionCursor(origin)
        await wait(40)
        window.webContents.sendInputEvent({
          type: 'mouseMove',
          ...point,
          globalX: origin.x,
          globalY: origin.y
        })
        window.webContents.sendInputEvent({
          type: 'mouseDown',
          ...point,
          globalX: origin.x,
          globalY: origin.y,
          button: 'left',
          clickCount: 1
        })
        await wait(60)
        for (const delta of [8, 24, 56, 96, 140]) {
          const current = window.getBounds()
          positionCursor({ x: origin.x + delta, y: origin.y + Math.round(delta / 2) })
          window.webContents.sendInputEvent({
            type: 'mouseMove',
            x: origin.x + delta - current.x,
            y: origin.y + Math.round(delta / 2) - current.y,
            globalX: origin.x + delta,
            globalY: origin.y + Math.round(delta / 2),
            button: 'left'
          })
          await until(() => {
            const bounds = window.getBounds()
            return (
              Math.abs(bounds.x - start.x - delta) <= 1 &&
              Math.abs(bounds.y - start.y - Math.round(delta / 2)) <= 1
            )
          }, `${label}: drag stopped before ${delta}px`)
        }
        const current = window.getBounds()
        window.webContents.sendInputEvent({
          type: 'mouseUp',
          x: origin.x + 140 - current.x,
          y: origin.y + 70 - current.y,
          globalX: origin.x + 140,
          globalY: origin.y + 70,
          button: 'left',
          clickCount: 1
        })
        await until(
          () => js("window.__nativeDragEvents.some(event => event.type === 'pointerup')"),
          `${label}: no pointerup`
        )
        const events = await js('window.__nativeDragEvents')
        assert.ok(
          events.some((event) => event.type === 'pointerdown' && event.prevented && event.trusted),
          `${label}: default mouse action not blocked`
        )
        assert.equal(
          events.some((event) => event.type === 'pointercancel'),
          false,
          `${label}: pointer cancelled`
        )
        assert.equal(
          events.some((event) => event.type === 'dragstart' && !event.prevented),
          false,
          `${label}: native drag escaped`
        )

        // An already-existing/programmatic selection or a draggable child must also
        // be stopped at dragstart, including icons supplied through the action slot.
        const prevention = await js(`(() => {
          const header = document.querySelector('.app-titlebar')
          return [...header.querySelectorAll('button, img'), header].map(target => {
            const event = new DragEvent('dragstart', { bubbles: true, cancelable: true })
            target.dispatchEvent(event)
            return event.defaultPrevented
          })
        })()`)
        assert.ok(
          prevention.length > 5 && prevention.every(Boolean),
          `${label}: descendant drag escaped`
        )
        assert.equal(await js('getComputedStyle(document.body).userSelect'), 'text')
        assert.equal(
          await js("getComputedStyle(document.querySelector('.app-titlebar')).userSelect"),
          'none'
        )
        console.log(`${label}: select-all + 140px window drag passed`)
      }
    }

    // Real control clicks still work; locked navigation must reject native dragging too.
    await js("window.api.setWindowZOrderMode('normal')")
    for (const expected of [true, false]) {
      await wait(600)
      const point = await js(`(() => {
        const rect = document.querySelector('.light-lock').getBoundingClientRect()
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      })()`)
      for (const type of ['mouseDown', 'mouseUp']) {
        window.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 })
      }
      await until(
        () =>
          js(`document.querySelector('.light-lock').classList.contains('locked') === ${expected}`),
        'lock control click failed'
      )
      assert.equal(
        await js(`(() => {
        const event = new DragEvent('dragstart', { bubbles: true, cancelable: true })
        document.querySelector('.app-titlebar').dispatchEvent(event)
        return event.defaultPrevented
      })()`),
        true
      )
    }
    console.log('titlebar native drag prevention and lock control integration passed')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    positionCursor(originalCursor)
    clearTimeout(timeout)
    app.once('quit', () => process.exit(exitCode))
    app.quit()
  }
}
