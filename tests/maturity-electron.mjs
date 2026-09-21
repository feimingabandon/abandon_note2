import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, dialog, nativeImage } from 'electron'

const root = mkdtempSync(join(tmpdir(), 'abandon-draft-conflict-ui-'))
app.setPath('userData', root)
app.commandLine.appendSwitch('disable-gpu')
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const db = new Database(join(root, 'app.db'))
db.exec(`CREATE TABLE app_settings (
  window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (window_name, key))`)
const insert = db.prepare('INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)')
for (const [scope, type, key, value] of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ['main', 'system', 'blur_enabled', 'false'],
  ['month', 'system', 'blur_enabled', 'false'],
  ['week', 'system', 'blur_enabled', 'false']
])
  insert.run(scope, type, key, value)
db.close()

async function until(fn, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error(label)
}

app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(chunk)
require(resolve('out/main/chunks', chunk))

let response = 0
dialog.showMessageBox = async () => {
  return { response }
}
const resultPath = resolve('tmp/maturity-electron-results.json')
const results = []
setTimeout(() => {
  writeFileSync(resultPath, JSON.stringify({ status: 'timeout', results }))
  app.exit(1)
}, 45000)
let current
const js = (code) => current.webContents.executeJavaScript(code)
async function view(mode) {
  current = await until(
    () =>
      BrowserWindow.getAllWindows().find(
        (w) =>
          !w.isDestroyed() &&
          w.webContents.getURL().includes('/' + (mode === 'list' ? 'index' : mode) + '.html')
      ),
    'view ' + mode
  )
  await until(
    () =>
      js(
        "Boolean(document.querySelector('.view-switcher__trigger')) && typeof window.__prepareEditingDrafts === 'function'"
      ),
    'ready ' + mode
  )
}
async function openEditor(id) {
  await until(
    () => js('Boolean(document.querySelector(\'.nl-card[data-note-id="' + id + '"]\'))'),
    'card'
  )
  await js(
    'document.querySelector(\'.nl-card[data-note-id="' +
      id +
      "\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:180}))"
  )
  await until(() => js("Boolean(document.querySelector('.nl-context-menu'))"), 'menu')
  await js(
    "Array.from(document.querySelectorAll('.nl-context-menu button')).find(b=>b.textContent.trim()==='修改').click()"
  )
  await until(() => js("Boolean(document.querySelector('.app-editor textarea'))"), 'editor')
}
async function fill(selector, text) {
  await js(
    '(()=>{const n=document.querySelector(' +
      JSON.stringify(selector) +
      ');n.value=' +
      JSON.stringify(text) +
      ";n.dispatchEvent(new Event('input',{bubbles:true}))})()"
  )
}
async function run() {
  try {
    await view('list')
    const id = await js("window.api.createNote({content:'original'}).then(n=>n.id)")
    await openEditor(id)

    await fill('.app-editor textarea', 'durable local draft')
    const png = nativeImage
      .createFromBitmap(Buffer.alloc(4, 255), { width: 1, height: 1 })
      .toPNG()
      .toString('base64')
    await js(
      '(()=>{const bytes=Uint8Array.from(atob(' +
        JSON.stringify(png) +
        "), c=>c.charCodeAt(0));const d=new DataTransfer();d.items.add(new File([bytes], 'draft.png',{type:'image/png'}));const input=document.querySelector('.app-editor .ip-input');input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()"
    )
    await until(
      () => js("document.querySelectorAll('.app-editor .ip-thumb').length === 1"),
      'draft attachment selected'
    )
    await until(() => js('window.__prepareEditingDrafts().dirty'), 'dirty state')
    const first = current
    await js("window.api.switchMainView('month')")
    await until(
      () => js("Boolean(document.querySelector('.confirm-card.active'))"),
      'cancel dialog'
    )
    await js("document.querySelector('.confirm-actions button').click()")
    await until(() => js("!document.querySelector('.confirm-card')"), 'cancelled dialog')
    assert.equal(first.isDestroyed(), false)
    results.push('view cancellation preserves window')
    response = 1
    await js("window.api.switchMainView('month')")
    await until(
      () => js("Boolean(document.querySelector('.confirm-card.active'))"),
      'confirm dialog'
    )
    await js("document.querySelector('.confirm-actions button:last-child').click()")
    await until(
      () => first.webContents.getURL().includes('/month.html'),
      'existing window navigated to month'
    )
    assert.equal(first.isDestroyed(), false)
    await view('month')
    assert.equal(current, first)
    await until(
      () => js("!document.querySelector('.view-switcher__trigger').disabled"),
      'month view switch finished'
    )
    await js("window.api.switchMainView('list')")
    await view('list')
    await openEditor(id)
    await until(
      () => js("document.querySelector('.app-editor textarea').value === 'durable local draft'"),
      'rehydrated full draft'
    )

    assert.equal(await js('window.api.getNote(' + id + ').then(n=>n.content)'), 'original')
    await until(
      () => js("document.querySelectorAll('.app-editor .ip-thumb').length === 1"),
      'draft attachment restored'
    )
    await js("document.querySelector('.app-editor .ne-submit').click()")
    await until(
      () => js('window.api.getNote(' + id + ").then(n=>n.content === 'durable local draft')"),
      'save draft'
    )
    await until(() => js("!document.querySelector('.app-editor textarea')"), 'editor closed')

    assert.equal(await js('window.api.getNote(' + id + ').then(n=>n.attachments.length)'), 1)
    results.push(
      'view navigation reuses the window and restores drafts without automatic database writes'
    )
    await js(
      'document.querySelector(\'.nl-card[data-note-id="' +
        id +
        "\"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2,clientX:100,clientY:180}))"
    )
    await until(
      () => js("Boolean(document.querySelector('.quick-note-editor textarea'))"),
      'quick editor'
    )
    await fill('.quick-note-editor textarea', 'stale quick draft')
    await js('window.api.updateNote(' + id + ",{content:'concurrent body'})")
    await js(
      "document.querySelector('.quick-note-editor textarea').dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:document.body}))"
    )
    await until(
      () => js("Boolean(document.querySelector('.quick-note-editor__recovery'))"),
      'quick conflict'
    )
    assert.equal(await js('window.api.getNote(' + id + ').then(n=>n.content)'), 'concurrent body')
    assert.equal(
      await js("document.querySelector('.quick-note-editor textarea').value"),
      'stale quick draft'
    )
    results.push('quick conflict keeps database and local draft')
    const reloaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('crash reload timed out')), 10000)
      current.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    current.webContents.forcefullyCrashRenderer()
    await reloaded
    await until(
      () => !current.webContents.isCrashed() && !current.webContents.isLoading(),
      'crash reload'
    )
    await until(
      () => js("Boolean(document.querySelector('.view-switcher__trigger'))"),
      'renderer recovered'
    )
    assert.equal(
      await js(
        'JSON.parse(localStorage.getItem(`abandon:editing-draft:v2:${window.api.runtimeCapabilities.editingDraftSessionId}:quick:' +
          id +
          '`)).data.draft'
      ),
      'stale quick draft'
    )
    results.push('renderer crash recovers and preserves draft journal')
    await js('window.api.deleteNote(' + id + ')')
    const restored = await js('window.api.restoreNote(' + id + ')')
    assert.equal(restored.content, 'concurrent body')
    assert.equal(restored.notify_enabled, 0)

    results.push('restore IPC returns retained note')
    await js('window.api.deleteNote(' + id + ')')
    await js('document.querySelector(\'.ab-box-btn[title="搜索"]\').click()')
    await until(() => js("Boolean(document.querySelector('.sb-input'))"), 'search UI')
    await fill('.sb-input', 'concurrent body')
    await js("document.querySelector('.sb-submit').click()")
    await until(
      () =>
        js(
          'Boolean(document.querySelector(\'[data-search-note-id="' +
            id +
            '"] .src-actions-trigger\'))'
        ),
      'deleted search result'
    )
    await js(
      'document.querySelector(\'[data-search-note-id="' + id + '"] .src-actions-trigger\').click()'
    )
    await until(
      () =>
        js(
          "Array.from(document.querySelectorAll('.src-context-menu button')).some(b=>b.textContent.includes('恢复便签'))"
        ),
      'restore menu'
    )
    await js(
      "Array.from(document.querySelectorAll('.src-context-menu button')).find(b=>b.textContent.includes('恢复便签')).click()"
    )
    await until(
      () => js('window.api.getNote(' + id + ').then(n=>!!n && !n.is_deleted)'),
      'restored from UI'
    )
    results.push('deleted search result restores through keyboard-accessible menu')

    await js("document.querySelector('.titlebar-btn-settings').click()")
    await until(
      () => js("Boolean(document.querySelector('.settings-search input'))"),
      'settings lazy load'
    )
    await fill('.settings-search input', '图标')
    await until(
      () => js("document.querySelectorAll('.settings-search-results button').length > 0"),
      'settings search results'
    )
    await js("document.querySelector('.settings-search-results button').click()")
    await until(
      () => js("Boolean(document.activeElement.closest('.settings-section'))"),
      'animated settings navigation'
    )
    for (const theme of ['white', 'black', 'wallpaper']) {
      await js(
        "(()=>{const e=document.documentElement;e.style.setProperty('--bg-color'," +
          JSON.stringify(theme === 'black' ? '0 0 0' : '255 255 255') +
          ");e.style.setProperty('--text-color'," +
          JSON.stringify(theme === 'black' ? '#ffffff' : '#182333') +
          ');document.body.style.background=' +
          JSON.stringify(
            theme === 'wallpaper'
              ? 'repeating-linear-gradient(35deg, #b85b72 0 70px, #3b769c 70px 140px, #bda775 140px 210px)'
              : theme
          ) +
          ';})()'
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      writeFileSync(
        resolve('tmp/maturity-settings-' + theme + '.png'),
        (await current.webContents.capturePage()).toPNG()
      )
    }
    results.push('settings lazy load, search, navigation and theme captures')
    await js("document.querySelector('.panel-close-btn').click()")
    await until(() => js("!document.querySelector('.settings-panel')"), 'settings closed')
    await js("document.querySelector('.titlebar-btn-template').click()")
    await until(
      () => js("Boolean(document.querySelector('.tp-filter-button'))"),
      'template lazy load'
    )
    await js("document.querySelector('.tp-filter-button').click()")
    await until(() => js("Boolean(document.querySelector('.sel-trigger'))"), 'select trigger')
    current.setBounds({ width: 240, height: 460 })
    await new Promise((resolve) => setTimeout(resolve, 350))
    await js("document.querySelector('.sel-trigger').click()")
    await until(() => js("Boolean(document.querySelector('.sel-panel-wrap'))"), 'select panel')
    const selectBounds = await js(
      "(()=>{const r=document.querySelector('.sel-panel-wrap').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}})()"
    )
    assert.ok(
      selectBounds.x >= 0 &&
        selectBounds.y >= 0 &&
        selectBounds.right <= selectBounds.w + 1 &&
        selectBounds.bottom <= selectBounds.h + 1,
      JSON.stringify(selectBounds)
    )
    await js(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    assert.equal(await js("document.activeElement.matches('.sel-trigger')"), true)
    results.push('select keyboard focus and narrow-window bounds')
    await js("document.querySelector('.titlebar-btn-template').click()")
    await until(() => js("!document.querySelector('.tp-filter-button')"), 'template closed')
    await openEditor(id)
    await js("document.querySelector('.app-editor .ts-more').click()")
    await until(() => js("Boolean(document.querySelector('.ts-panel'))"), 'tags panel')
    const tagBounds = await js(
      "(()=>{const r=document.querySelector('.ts-panel').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}})()"
    )
    assert.ok(
      tagBounds.x >= 0 &&
        tagBounds.y >= 0 &&
        tagBounds.right <= tagBounds.w + 1 &&
        tagBounds.bottom <= tagBounds.h + 1,
      JSON.stringify(tagBounds)
    )
    await js(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    assert.equal(await js("document.activeElement.matches('.ts-more')"), true)
    results.push('tag popover narrow-window bounds and focus restoration')
    await fill('.app-editor textarea', 'exit cancellation draft')
    response = 0
    app.quit()
    await until(
      () => js("Boolean(document.querySelector('.confirm-card.active'))"),
      'quit confirmation'
    )
    await js("document.querySelector('.confirm-actions button').click()")
    await until(() => js("!document.querySelector('.confirm-card')"), 'quit cancelled')
    assert.equal(current.isDestroyed(), false)
    assert.equal(
      await js("document.querySelector('.app-editor textarea').value"),
      'exit cancellation draft'
    )
    results.push('quit cancellation preserves editing')
    writeFileSync(resultPath, JSON.stringify({ status: 'passed', results }, null, 2))
    app.exit(0)
  } catch (error) {
    writeFileSync(
      resultPath,
      JSON.stringify({ status: 'failed', results, error: error.stack }, null, 2)
    )
    app.exit(1)
  }
}
