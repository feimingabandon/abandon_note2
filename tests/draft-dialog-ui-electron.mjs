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
const resultPath = resolve('tmp/draft-dialog-ui-results.json')
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
async function switchFromButton(target) {
  await js("document.querySelector('.view-switcher__trigger').click()")
  await until(() => js("Boolean(document.querySelector('.view-switcher__menu'))"), 'view menu')
  await js("document.querySelector('.view-switcher__menu [data-view=" + target + "]').click()")
  await until(
    () => js("Boolean(document.querySelector('.confirm-card.active'))"),
    'application confirmation'
  )
}
async function waitCancelled() {
  await until(
    () =>
      js(
        "!document.querySelector('.confirm-card') && !document.querySelector('.view-switcher__trigger').disabled"
      ),
    'cancel releases switch button'
  )
}
async function run() {
  try {
    for (const mode of ['list', 'month', 'week']) {
      await view(mode)
      await js('window.api.clearNoteData()')
      if (mode === 'list') await fill('.nnp-root textarea', 'keep my draft')
      else {
        await until(
          () => js("Boolean(document.querySelector('.month-day-cell__quick-activate'))"),
          'calendar ready'
        )
        await js("document.querySelector('.month-day-cell__quick-activate').click()")
        await until(
          () => js("Boolean(document.querySelector('.month-day-cell__quick-create input'))"),
          'calendar input'
        )
        await fill('.month-day-cell__quick-create input', 'keep my draft')
      }
      const target = mode === 'list' ? 'month' : mode === 'month' ? 'week' : 'list'
      await switchFromButton(target)
      assert.equal(current.isEnabled(), true, 'native window must remain enabled')
      assert.equal(dialogs, 0, 'normal confirmation must not use Windows message boxes')
      assert.equal(
        await js(
          "(()=>{const r=document.querySelector('.confirm-card').getBoundingClientRect();return [...document.querySelectorAll('.confirm-actions button')].every(b=>{const v=b.getBoundingClientRect();return v.left>=r.left && v.right<=r.right})})()"
        ),
        true
      )
      if (mode === 'list') {
        const originalStyles = await js(
          '({root:document.documentElement.style.cssText,body:document.body.style.cssText})'
        )
        for (const theme of ['white', 'black', 'wallpaper']) {
          await js(
            "document.documentElement.style.setProperty('--bg-color'," +
              JSON.stringify(theme === 'black' ? '0 0 0' : '255 255 255') +
              ");document.documentElement.style.setProperty('--text-color'," +
              JSON.stringify(theme === 'black' ? '#ffffff' : '#182333') +
              ');document.body.style.background=' +
              JSON.stringify(
                theme === 'wallpaper'
                  ? 'repeating-linear-gradient(35deg,#b85b72 0 70px,#3b769c 70px 140px,#bda775 140px 210px)'
                  : theme
              )
          )
          await new Promise((resolve) => setTimeout(resolve, 250))
          writeFileSync(
            resolve('tmp/draft-dialog-' + theme + '.png'),
            (await current.webContents.capturePage()).toPNG()
          )
        }
        await js(
          'document.documentElement.style.cssText=' +
            JSON.stringify(originalStyles.root) +
            ';document.body.style.cssText=' +
            JSON.stringify(originalStyles.body)
        )
      }
      await js(
        "document.querySelector('.confirm-card').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
      )
      await waitCancelled()
      await switchFromButton(target)
      await js("document.querySelector('.confirm-overlay').click()")
      await waitCancelled()
      await switchFromButton(target)
      await js("document.querySelector('.confirm-actions button').click()")
      await waitCancelled()
      await switchFromButton(target)
      current.hide()
      current.show()
      await waitCancelled()
      assert.equal(await js('window.__prepareEditingDrafts().dirty'), true)
      current.hide()
      app.quit()
      await until(() => current.isVisible(), 'tray quit reveals hidden window')
      await until(
        () => js("Boolean(document.querySelector('.confirm-card.active'))"),
        'tray quit confirmation'
      )
      await js("document.querySelector('.confirm-actions button').click()")
      await waitCancelled()
      results.push(
        mode +
          ': app dialog, Escape, backdrop, cancel button and hide release busy state; hidden quit visible; drafts remain'
      )
      await js("document.querySelector('.titlebar-btn-settings').click()")
      await until(() => js("Boolean(document.querySelector('.settings-search input'))"), 'settings')
      await fill('.settings-search input', '编辑草稿')
      await until(
        () => js("document.querySelectorAll('.settings-search-results button').length > 0"),
        'search result'
      )
      const scroll = await js(
        "(async()=>{const c=document.querySelector('.settings-panel .panel-body');c.scrollTop=0;const samples=[];document.querySelector('.settings-search-results button').click();for(let i=0;i<65;i++){await new Promise(requestAnimationFrame);samples.push(c.scrollTop)}return {samples,focused:!!document.activeElement.closest('.settings-section')}})()"
      )
      assert.ok(new Set(scroll.samples.map(Math.round)).size > 8, JSON.stringify(scroll))
      assert.ok(scroll.samples.at(-1) > 100)
      assert.equal(scroll.focused, true)
      results.push(
        mode + ': settings search has intermediate animation frames and focuses target section'
      )
      await js("document.querySelector('.panel-close-btn').click()")
      await until(() => js("!document.querySelector('.settings-panel')"), 'settings closed')
      const old = current
      await switchFromButton(target)
      await js("document.querySelector('.confirm-actions button:last-child').click()")
      await until(() => old.isDestroyed(), 'accepted switch replaces window')
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
