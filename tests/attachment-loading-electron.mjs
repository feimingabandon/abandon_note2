import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { traceRendererExpressions } from './helpers/renderer-evidence.mjs'

// Exercise real Vue forms, preload/IPC, and attachment storage with controlled slow reads.
const root = mkdtempSync(join(tmpdir(), 'abandon-attachment-loading-'))
app.setPath('userData', root)
app.commandLine.appendSwitch('disable-gpu')
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const seed = new Database(join(root, 'app.db'))
seed.exec(`CREATE TABLE app_settings (
  window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (window_name, key))`)
const insert = seed.prepare(
  'INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)'
)
for (const row of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false'])
])
  insert.run(...row)
seed.close()

const handlers = new Map()
const register = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => {
  handlers.set(channel, handler)
  register(channel, handler)
}
function delayIpc(channel, matches) {
  const original = handlers.get(channel)
  assert.ok(original, channel)
  let release
  let started = false
  const barrier = new Promise((done) => {
    release = done
  })
  ipcMain.removeHandler(channel)
  register(channel, async (event, ...args) => {
    if (matches(...args)) {
      started = true
      await barrier
    }
    return original(event, ...args)
  })
  return {
    started: () => started,
    release,
    restore() {
      release()
      ipcMain.removeHandler(channel)
      register(channel, original)
    }
  }
}

async function until(fn, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error(label)
}
const q = JSON.stringify
let window
const js = (code) => window.webContents.executeJavaScript(code)
const exists = (selector) => js(`Boolean(document.querySelector(${q(selector)}))`)
const click = (selector) => js(`document.querySelector(${q(selector)}).click()`)
const disabled = (selector) => js(`document.querySelector(${q(selector)})?.disabled`)
async function fill(selector, content) {
  await js(`(() => {
    const node = document.querySelector(${q(selector)})
    node.value = ${q(content)}
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
}
async function ready(view) {
  const filename = view === 'list' ? 'index' : view
  window = await until(
    () =>
      BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('/' + filename + '.html')
      ),
    view + ' window'
  )
  traceRendererExpressions(window, 'attachment-loading-' + view)
  await until(() => exists(`.view-switcher__trigger[data-active-view="${view}"]`), view + ' ready')
  await js(`(() => {
    const original = FileReader.prototype.readAsDataURL
    window.pendingImageReads = []
    FileReader.prototype.readAsDataURL = function(file) {
      window.pendingImageReads.push((fail) => fail
        ? this.onerror(new Event('error')) : original.call(this, file))
    }
  })()`)
}
async function switchView(view) {
  await click('.view-switcher__trigger')
  const item = `.view-switcher__menu [data-view="${view}"]`
  await until(() => exists(item), 'view menu')
  await click(item)
  await ready(view)
}
function fixture(color) {
  return nativeImage
    .createFromBitmap(Buffer.from([...color, ...color, ...color, ...color]), {
      width: 2,
      height: 2
    })
    .toPNG()
    .toString('base64')
}
let png
async function selectImages(form, count = 1) {
  await js(`(() => {
    const transfer = new DataTransfer()
    const bytes = Uint8Array.from(atob(${q(png)}), char => char.charCodeAt(0))
    for (let i = 0; i < ${count}; i++) transfer.items.add(new File([bytes], 'image-' + i + '.png', {type:'image/png'}))
    const input = document.querySelector(${q(form + ' .ip-input')})
    input.files = transfer.files
    input.dispatchEvent(new Event('change', {bubbles:true}))
  })()`)
  await until(() => js('window.pendingImageReads.length > 0'), 'file read started')
}
async function releaseRead(fail = false) {
  await js(`window.pendingImageReads.shift()(${fail})`)
}
async function blocked(button) {
  await until(() => disabled(button), 'save disabled during read')
  assert.equal(
    await js('window.__prepareEditingDrafts().blocked'),
    true,
    'draft navigation blocked'
  )
  // dispatchEvent also exercises the handler guard despite the disabled button.
  await js(
    `document.querySelector(${q(button)}).dispatchEvent(new MouseEvent('click', {bubbles:true}))`
  )
}

const timeout = setTimeout(() => {
  console.error('attachment loading timed out')
  app.exit(1)
}, 120000)
app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(chunk)
require(resolve('out/main/chunks', chunk))

async function run() {
  let db
  try {
    await ready('list')
    ipcMain.handle = register
    db = new Database(join(root, 'app.db'), { readonly: true })
    const note = (content) => db.prepare('SELECT id FROM notes WHERE content = ?').get(content)
    png = fixture([0, 0, 255, 255])

    await click('[aria-label="展开新建面板"]')
    await fill('.nnp-root textarea', 'list pending images')
    await selectImages('.nnp-root', 2)
    await blocked('.nnp-submit')
    assert.equal(note('list pending images'), undefined)
    await releaseRead()
    await until(() => js('window.pendingImageReads.length === 1'), 'second file read started')
    await blocked('.nnp-submit')
    assert.equal(note('list pending images'), undefined)
    await releaseRead()
    await until(async () => (await disabled('.nnp-submit')) === false, 'create ready')
    await click('.nnp-submit')
    const first = await until(() => note('list pending images'), 'list note persisted')
    assert.equal((await js(`window.api.listImages(${first.id})`)).length, 2)
    await until(
      () => js(`document.querySelector('.nnp-root textarea')?.value === ''`),
      'form reset'
    )
    console.log('List create: pending batch blocked; both images persisted')

    await js(`window.api.setSettingValue('listAppearance.minimalMode', true)`)
    await until(() => exists('.nl-card--minimal'), 'minimal list applied')
    await click('[aria-label="展开新建面板"]')
    await fill('.nnp-root textarea', 'minimal failure recovery')
    await selectImages('.nnp-root')
    await blocked('.nnp-submit')
    await releaseRead(true)
    await until(async () => (await disabled('.nnp-submit')) === false, 'failed read unblocked')
    await selectImages('.nnp-root')
    await click('.nnp-root .ip-thumb__del')
    await until(async () => (await disabled('.nnp-submit')) === false, 'cancelled read unblocked')
    await releaseRead()
    await until(
      () => js(`document.querySelectorAll('.nnp-root .ip-thumb').length === 0`),
      'cancelled image not restored'
    )
    await selectImages('.nnp-root')
    await releaseRead()
    await until(async () => (await disabled('.nnp-submit')) === false, 'retry ready')
    await click('.nnp-submit')
    const minimal = await until(() => note('minimal failure recovery'), 'minimal note persisted')
    assert.equal((await js(`window.api.listImages(${minimal.id})`)).length, 1)
    await until(
      () => js(`document.querySelector('.nnp-root textarea')?.value === ''`),
      'minimal form reset'
    )
    console.log('Minimal list: failure and cancellation unlock form; retry persists image')

    const loading = delayIpc('images:list', ({ noteId }) => noteId === first.id)
    await js(
      `document.querySelector('.nl-card[data-note-id="${first.id}"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:120,clientY:180}))`
    )
    await until(() => exists('.nl-context-menu'), 'edit menu')
    await js(
      `Array.from(document.querySelectorAll('.nl-context-menu button')).find(node => node.textContent.trim() === '修改').click()`
    )
    await until(() => exists('.app-editor textarea'), 'editor')
    await until(loading.started, 'existing images load')
    await fill('.app-editor textarea', 'edited with pending images')
    await blocked('.app-editor .ne-submit')
    assert.equal(
      await exists('.app-editor .ip-input'),
      false,
      'no additions during initial loading'
    )
    loading.restore()
    await until(() => exists('.app-editor .ip-input'), 'editor attachments ready')
    await selectImages('.app-editor')
    await blocked('.app-editor .ne-submit')
    assert.equal(
      await js(`window.api.getNote(${first.id}).then(note => note.content)`),
      'list pending images'
    )
    await releaseRead()
    await until(
      async () => (await disabled('.app-editor .ne-submit')) === false,
      'editor save ready'
    )
    const saving = delayIpc('notes:save-draft', () => true)
    await click('.app-editor .ne-submit')
    await until(saving.started, 'save started')
    assert.equal(await js(`document.querySelector('.app-editor .ne-body').inert`), true)
    saving.restore()
    await until(() => note('edited with pending images'), 'editor persisted')
    assert.equal((await js(`window.api.listImages(${first.id})`)).length, 3)
    await until(async () => !(await exists('.app-editor textarea')), 'editor closed')
    console.log('Editor: initial loading and new reads guarded; all attachments preserved')

    for (const view of ['month', 'week']) {
      await switchView(view)
      await until(() => exists('.month-day-cell.is-today'), view + ' calendar')
      await js(
        `document.querySelector('.month-day-cell.is-today').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:180,clientY:210}))`
      )
      await until(() => exists('.month-cell-context-menu [role="menuitem"]'), view + ' date menu')
      await js(
        `Array.from(document.querySelectorAll('.month-cell-context-menu [role="menuitem"]')).find(node => node.textContent.includes('新建便签')).click()`
      )
      await until(() => exists('.month-creator textarea'), view + ' creator')
      await fill('.month-creator textarea', view + ' pending image')
      await selectImages('.month-creator')
      await blocked('.month-creator footer .is-primary')
      assert.equal(await disabled('.month-creator [aria-label="关闭新建便签"]'), true)
      assert.equal(note(view + ' pending image'), undefined)
      await releaseRead()
      await until(
        async () => (await disabled('.month-creator footer .is-primary')) === false,
        view + ' create ready'
      )
      await click('.month-creator footer .is-primary')
      const created = await until(() => note(view + ' pending image'), view + ' persisted')
      assert.equal((await js(`window.api.listImages(${created.id})`)).length, 1)
      await until(async () => !(await exists('.month-creator textarea')), view + ' creator closed')
      console.log(view + ' create: read blocked premature save; image persisted')
    }

    // The same preview component is shared by month/week. Open A, then B while A waits.
    const ids = []
    for (const data of [png, fixture([255, 0, 0, 255])]) {
      ids.push(
        await js(
          `window.api.createNoteWithAssets({options:{content:''},images:[{base64:${q(data)},ext:'png'}],tagIds:[]}).then(note=>note.id)`
        )
      )
    }
    const [a] = await js(`window.api.listImages(${ids[0]})`)
    const [b] = await js(`window.api.listImages(${ids[1]})`)
    const expected = await js(`window.api.getImageBase64(${q(b.file_path)})`)
    await until(() => exists(`.month-event-bar[data-note-id="${ids[1]}"]`), 'image note bars')
    const thumbnails = delayIpc(
      'images:get-thumbnail',
      ({ relativePath }) => relativePath === a.file_path
    )
    await click(`.month-event-bar[data-note-id="${ids[0]}"]`)
    await until(thumbnails.started, 'A thumbnail request actually pending')
    assert.equal(await exists('.ipv-overlay'), false, 'preview waits for sources')
    await click(`.month-event-bar[data-note-id="${ids[1]}"]`)
    await until(
      () => js(`document.querySelector('.ipv-image')?.src === ${q(expected)}`),
      'B preview ready'
    )
    await js(`window.previewChanges = []; window.previewObserver = new MutationObserver(() => {
      window.previewChanges.push(document.querySelector('.ipv-image')?.src)
    }); window.previewObserver.observe(document.querySelector('.ipv-image-stage'), {subtree:true,attributes:true,childList:true})`)
    thumbnails.restore()
    // Allow stale IPC delivery and the preview transition to finish; inspect every mutation too.
    await js(`new Promise(resolve => setTimeout(resolve, 400))`)
    assert.equal(await js(`document.querySelector('.ipv-image')?.src`), expected)
    assert.equal(
      await js(`window.previewChanges.some(source => source && source !== ${q(expected)})`),
      false
    )
    await js('window.previewObserver.disconnect()')
    await click('.ipv-btn--close')
    console.log('Calendar preview: late A thumbnail cannot replace B image')
    console.log('Attachment loading regression passed')
    clearTimeout(timeout)
    db.close()
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    db?.close()
    app.exit(1)
  }
}
