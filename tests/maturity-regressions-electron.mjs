import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
let dialogs = 0
dialog.showMessageBox = async () => {
  dialogs++
  return { response }
}
const resultPath = resolve('tmp/maturity-regressions-results.json')
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
    response = 1
    for (const mode of ['list', 'month', 'week']) {
      await view(mode)
      await js('window.api.clearNoteData()')
      if (mode === 'list') {
        await fill('.nnp-root textarea', 'unsaved list draft')
      } else {
        await until(
          () => js("Boolean(document.querySelector('.month-day-cell__quick-activate'))"),
          'calendar'
        )
        await js("document.querySelector('.month-day-cell__quick-activate').click()")
        await until(
          () => js("Boolean(document.querySelector('.month-day-cell__quick-create input'))"),
          'quick input'
        )
        await fill('.month-day-cell__quick-create input', 'unsaved calendar draft')
      }
      await js(
        "(()=>{const prefix=`abandon:editing-draft:v2:${window.api.runtimeCapabilities.editingDraftSessionId}:`;localStorage.setItem('review-unrelated-setting','keep');localStorage.setItem(prefix+'template:new',JSON.stringify({updatedAt:Date.now(),data:{content:'restored template',timeOfDay:'23:47'}}));localStorage.setItem(prefix+'note:999',JSON.stringify({data:{content:'old private body',attachments:{addedImages:[{base64:'old-image'}]}}}));localStorage.setItem(prefix+'broken','invalid json')})()"
      )
      await js("document.querySelector('.titlebar-btn-template').click()")
      await until(
        () => js("document.querySelector('.tcp-root textarea')?.value === 'restored template'"),
        'restored template'
      )
      assert.equal(
        await js("document.querySelector('.tcp-root .time-picker__trigger').textContent.trim()"),
        '23:47'
      )
      await js("document.querySelector('.tcp-button').click()")
      await until(
        () => js("Boolean(document.querySelector('.tcp-content.visible'))"),
        'expanded template'
      )
      assert.equal(
        await js("document.querySelector('.tcp-root .time-picker__trigger').textContent.trim()"),
        '23:47'
      )
      const id = await js("window.api.createNote({content:'clear test'}).then(n=>n.id)")
      await js('window.api.clearNoteData()')
      await until(
        () => js("document.querySelector('.tcp-root textarea')?.value === ''"),
        'reset open form'
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.deepEqual(
        await js("Object.keys(localStorage).filter(k=>k.startsWith('abandon:editing-draft:'))"),
        []
      )
      assert.equal(await js("localStorage.getItem('review-unrelated-setting')"), 'keep')
      assert.equal(await js('window.api.getNote(' + id + ')'), null)
      assert.equal(await js('window.__prepareEditingDrafts().dirty'), false)
      if (mode === 'list')
        assert.equal(await js("document.querySelector('.nnp-root textarea').value"), '')
      await js("document.querySelector('.tcp-button').click()")
      await until(() => js("Boolean(document.querySelector('.tcp-content.visible'))"), 'fresh form')
      await fill('.tcp-root textarea', 'new draft after clearing')
      await until(
        () =>
          js(
            "localStorage.getItem(`abandon:editing-draft:v2:${window.api.runtimeCapabilities.editingDraftSessionId}:template:new`)?.includes('new draft after clearing')"
          ),
        'new drafts still persist'
      )
      if (mode === 'list') {
        const failure = await js(
          "(async()=>{const original=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(key.startsWith('abandon:editing-draft:'))throw new Error('injected storage failure');return original.call(this,key)};try{await window.api.clearNoteData();return 'unexpected success'}catch(error){return error.message}finally{Storage.prototype.removeItem=original}})()"
        )
        assert.match(failure, /业务数据已清空.*草稿清理失败/)
        await fill('.tcp-root textarea', 'draft remains protected after failed clear')
        await until(
          () =>
            js(
              "localStorage.getItem(`abandon:editing-draft:v2:${window.api.runtimeCapabilities.editingDraftSessionId}:template:new`)?.includes('draft remains protected')"
            ),
          'failed clear keeps protection'
        )
      }
      await js('window.api.clearNoteData()')
      results.push(
        mode +
          ': restored time retained; cleared persisted and active drafts; subsequent drafts persist'
      )
      await js("document.querySelector('.titlebar-btn-template').click()")
      await until(() => js("!document.querySelector('.tcp-root')"), 'template closed')
      await js("document.querySelector('.titlebar-btn-settings').click()")
      await until(() => js("Boolean(document.querySelector('.settings-search input'))"), 'settings')
      for (const term of ['字号', '提醒', '字体大小', '窗口', '基础 字号', '同一比例联动']) {
        await fill('.settings-search input', term)
        await until(
          () => js("document.querySelectorAll('.settings-search-results button').length > 0"),
          'search ' + term
        )
      }
      await fill('.settings-search input', '绝对不存在的设置关键词')
      await until(
        () => js("document.querySelectorAll('.settings-search-results button').length === 0"),
        'no results'
      )
      results.push(mode + ': setting aliases, help text, multiword search and no-results verified')
      await js("document.querySelector('.panel-close-btn').click()")
      await until(() => js("!document.querySelector('.settings-panel')"), 'settings closed')
      if (mode !== 'week') {
        const oldWindow = current
        const targetMode = mode === 'list' ? 'month' : 'week'
        await js("window.api.switchMainView('" + targetMode + "')")
        await until(
          () =>
            oldWindow.webContents
              .getURL()
              .includes('/' + (targetMode === 'list' ? 'index' : targetMode) + '.html'),
          'switch'
        )
        assert.equal(oldWindow.isDestroyed(), false)
      }
    }
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
