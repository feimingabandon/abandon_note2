import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'

const userData = mkdtempSync(join(tmpdir(), 'abandon-modal-queue-'))
app.setPath('userData', userData)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const db = new Database(join(userData, 'app.db'))
db.exec(`CREATE TABLE app_settings (
  window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (window_name, key))`)
const put = db.prepare('INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)')
for (const row of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false'])
])
  put.run(...row)
db.close()

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(predicate, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(30)
  }
  throw new Error(label)
}
let current
const js = (source) => current.webContents.executeJavaScript(source)
const exists = (selector) => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
const labels = () =>
  js(
    `Array.from(document.querySelectorAll('[role="dialog"]'), el => el.getAttribute('aria-label'))`
  )
const welcome = '[aria-label="欢迎使用 Abandon 便签"]'
const notice = '[aria-label="软件通知"]'
let notices = []
let checks = 0
const report = (message) => process.stdout.write(`[modal-queue] ${message}\n`)

async function finishWelcome() {
  await js(
    `Array.from(document.querySelectorAll('.app-modal-footer button')).find(b => b.textContent.includes('已阅读')).click()`
  )
}

async function run() {
  try {
    await until(() => {
      current = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL().includes('/index.html')
      )
      return current
    }, 'list window')
    ipcMain.removeHandler('remote-notices:list-pending')
    ipcMain.handle('remote-notices:list-pending', () => notices)
    ipcMain.removeHandler('calendar:holiday-data-notice')
    ipcMain.handle('calendar:holiday-data-notice', () => ({ required: false }))
    ipcMain.removeHandler('update:check')
    ipcMain.handle('update:check', () => {
      checks++
      return {
        status: 'available',
        latestVersion: '99.0.0',
        currentVersion: '1.3.0',
        releaseNotes: 'Queue test',
        downloadAvailable: false
      }
    })
    await until(() => exists(welcome), 'startup onboarding')
    notices = [{ id: 101, title: 'FIFO notice', body: 'Queued notification' }]
    current.webContents.send('remote-notices:changed')
    await until(() => checks > 0, 'startup update check')
    await wait(120)
    assert.deepEqual(await labels(), ['欢迎使用 Abandon 便签'])
    await finishWelcome()
    await until(() => exists(notice), 'notice after onboarding')
    assert.deepEqual(await labels(), ['软件通知'])
    await click(`${notice} .app-modal-close`)
    notices = []
    await until(
      () => js(`document.querySelector('.app-modal-header h2')?.textContent.includes('99.0.0')`),
      'update after notice'
    )
    assert.equal((await labels()).length, 1)
    await click('.app-modal-close')
    await until(async () => (await labels()).length === 0, 'update leave animation')
    report('startup: onboarding → notification → update')

    // App template places the almanac before the report. Opening the report
    // first in one JS turn must still win, across both business wrappers.
    await js(
      `document.querySelector('.titlebar-btn-daily-report').click(); window.dispatchEvent(new CustomEvent('abandon:open-almanac'))`
    )
    await until(() => exists('[aria-label="便签报表"]'), 'report requested first in same tick')
    assert.equal(await exists('[aria-label="万年历"]'), false)
    await click('[aria-label="便签报表"] .app-modal-close')
    await until(() => exists('[aria-label="万年历"]'), 'almanac requested second')
    assert.equal(await exists('[aria-label="便签报表"]'), false)
    await click('[aria-label="万年历"] .app-modal-close')
    await until(async () => (await labels()).length === 0, 'batched requests drained')
    report('same tick: report → almanac, regardless of component order')

    // Screenshot ownership must be acknowledged while its modal is waiting.
    // Exercise the real preload and renderer with isolated synthetic pixels.
    const acknowledgements = []
    ipcMain.removeHandler('screenshot:ack')
    ipcMain.handle('screenshot:ack', (_event, payload) => {
      acknowledgements.push(payload)
      return true
    })
    const png = nativeImage
      .createFromBitmap(Buffer.alloc(20 * 30 * 4, 220), { width: 20, height: 30 })
      .toPNG()
    const asset = {
      sessionId: 'queue-test',
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      size: png.length
    }
    for (const action of ['note', 'background']) {
      await js(`window.api.setSettingValue('onboarding.noticeVersion', 0)`)
      await until(() => exists(welcome), 'onboarding before screenshot ' + action)
      current.webContents.send('screenshot:delivery', { ...asset, action, deliveryId: action })
      await until(
        () => acknowledgements.some((item) => item.deliveryId === action),
        action + ' acknowledged without waiting for display'
      )
      assert.equal(acknowledgements.find((item) => item.deliveryId === action).accepted, true)
      assert.deepEqual(await labels(), ['欢迎使用 Abandon 便签'])
      assert.equal(
        await js('window.__prepareEditingDrafts().dirty'),
        true,
        'queued image is protected before acknowledgement'
      )
      await finishWelcome()
      if (action === 'note') {
        await until(
          () => exists('[aria-label="截图新建便签"] .ip-thumb'),
          'queued image transferred into note form'
        )
        assert.equal(
          await js(`document.querySelectorAll('[aria-label="截图新建便签"] .ip-thumb').length`),
          1
        )
        await click('[aria-label="截图新建便签"] .app-modal-close')
        await until(() => exists('.confirm-card.active'), 'capture discard confirmation')
        await click('.confirm-actions button:last-child')
      } else {
        await until(() => exists('[data-modal-layer="wallpaper-crop"]'), 'queued background crop')
        assert.equal((await labels()).length, 1)
        await click('.wc-close')
      }
      await until(async () => (await labels()).length === 0, 'capture modal closed')
      assert.equal(
        await js('window.__prepareEditingDrafts().dirty'),
        false,
        'discard clears pending image'
      )
      report(
        `screenshot ${action}: accepted while queued, shown after onboarding, discard clears staged image`
      )
    }

    await js(`window.api.setSettingValue('onboarding.noticeVersion', 0)`)
    await until(() => exists(welcome), 'onboarding before failed staging')
    await js(`window.originalStorageSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
      if (key.includes('capture:pending-delivery')) throw new DOMException('quota test', 'QuotaExceededError');
      return window.originalStorageSetItem.call(this, key, value)
    }; void 0`)
    current.webContents.send('screenshot:delivery', {
      ...asset,
      action: 'note',
      deliveryId: 'storage-failure'
    })
    await until(
      () => acknowledgements.some((item) => item.deliveryId === 'storage-failure'),
      'staging failure acknowledged'
    )
    await js('Storage.prototype.setItem = window.originalStorageSetItem; void 0')
    assert.equal(
      acknowledgements.find((item) => item.deliveryId === 'storage-failure').accepted,
      false
    )
    assert.deepEqual(await labels(), ['欢迎使用 Abandon 便签'])
    await finishWelcome()
    await until(async () => (await labels()).length === 0, 'failed delivery leaves no queued modal')
    report('failed staging: negative acknowledgement, no lost-success report or orphan modal')

    for (const mode of ['list', 'month', 'week']) {
      if (mode !== 'list') {
        await js(`window.api.switchMainView(${JSON.stringify(mode)})`)
        await until(
          () => exists(`.view-switcher__trigger[data-active-view="${mode}"]`),
          mode + ' ready'
        )
      }
      const layer =
        mode === 'list'
          ? '[data-modal-layer="note-editor"]'
          : '[data-modal-layer="month-note-creator"]'
      if (mode === 'list') {
        const id = await js(
          `window.api.createNote({ content: 'FIFO edit test' }).then(note => note.id)`
        )
        await until(() => exists(`.nl-card[data-note-id="${id}"]`), 'list note')
        await js(
          `document.querySelector('.nl-card[data-note-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:160, clientY:260 }))`
        )
        await until(() => exists('[data-diagnostic-action="note.edit.open"]'), 'edit menu')
        await click('[data-diagnostic-action="note.edit.open"]')
      } else {
        await until(() => exists('.month-day-cell'), 'calendar loaded')
        await js(
          `document.querySelector('.month-day-cell').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:350,clientY:250}))`
        )
        await until(() => exists('.month-cell-context-menu button'), 'calendar menu')
        await click('.month-cell-context-menu button')
      }
      await until(() => exists(layer), 'business modal')
      await js(
        `(() => { const el = document.querySelector(${JSON.stringify(layer + ' textarea')}); el.value = 'dirty queue draft'; el.dispatchEvent(new Event('input', { bubbles:true })); el.focus() })()`
      )
      await js(`window.queueOverlaps = []; window.queueObserver = new MutationObserver(() => {
        const count = document.querySelectorAll('.app-modal-overlay, .app-editor-overlay, .month-modal-overlay').length;
        if (count > 1) window.queueOverlaps.push(count)
      }); window.queueObserver.observe(document.body, { childList:true, subtree:true })`)
      notices = [{ id: 200, title: mode + ' pending notice', body: 'Keep the draft' }]
      current.webContents.send('remote-notices:changed')
      await wait(100)
      await js(`window.api.setSettingValue('onboarding.noticeVersion', 0)`)
      await wait(100)
      assert.equal(await exists(notice), false)
      assert.equal(await exists(welcome), false)
      assert.equal(
        await js(`document.querySelector(${JSON.stringify(layer + ' textarea')}).value`),
        'dirty queue draft'
      )
      assert.equal(
        await js(
          `document.querySelector(${JSON.stringify(layer)}).contains(document.activeElement)`
        ),
        true
      )
      await click(mode === 'list' ? '.app-editor-close' : '[aria-label="关闭新建便签"]')
      await until(() => exists('.confirm-card.active'), 'dependent discard confirmation')
      assert.equal(await exists(notice), false)
      await click('.confirm-actions button:last-child')
      await until(() => exists(notice), 'queued notice after discard')
      assert.equal(await exists(layer), false)
      await until(
        () =>
          js(`document.querySelector(${JSON.stringify(notice)}).contains(document.activeElement)`),
        'queued notice receives focus after its animation frame'
      )
      // Notification dismissal policy must remain explicit even with a queue.
      await js(
        `document.querySelector(${JSON.stringify(notice)}).dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`
      )
      assert.equal(await exists(notice), true)
      await click(`${notice} .app-modal-close`)
      notices = []
      await until(() => exists(welcome), 'reset onboarding waits its turn')
      await until(
        () =>
          js(
            `Boolean(document.querySelector('.first-use-stage.is-ready, .story-scroll .is-visible, [data-reveal].is-visible'))`
          ),
        'delayed onboarding initializes reveal'
      )
      await finishWelcome()
      await until(async () => (await labels()).length === 0, 'queue drained')
      assert.deepEqual(
        await js('window.queueOverlaps'),
        [],
        'independent overlays must never overlap, including during leave'
      )
      await js('window.queueObserver.disconnect()')
      report(
        `${mode}: dirty editor → child confirmation → notification → onboarding; no overlay overlap`
      )
    }
    report('PASS')
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (current) console.error(await labels().catch(() => []))
    app.exit(1)
  }
}
setTimeout(() => {
  report('TIMEOUT')
  app.exit(1)
}, 90000)
app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(chunk)
require(resolve('out/main/chunks', chunk))
