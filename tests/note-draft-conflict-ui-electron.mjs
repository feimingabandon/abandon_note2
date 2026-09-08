import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

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
  ['main', 'system', 'blur_enabled', 'false']
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

async function run() {
  try {
    const window = await until(
      () =>
        BrowserWindow.getAllWindows().find((win) => /\/index\.html/.test(win.webContents.getURL())),
      'list window'
    )
    const js = (code) => window.webContents.executeJavaScript(code)
    await until(
      () => js(`Boolean(document.querySelector('.view-switcher__trigger'))`),
      'renderer ready'
    )
    const id = await js(`window.api.createNote({content:'original'}).then(note=>note.id)`)
    async function openEditor() {
      await until(
        () => js(`Boolean(document.querySelector('.nl-card[data-note-id="${id}"]'))`),
        'note card'
      )
      await js(
        `document.querySelector('.nl-card[data-note-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:180}))`
      )
      await until(() => js(`Boolean(document.querySelector('.nl-context-menu'))`), 'context menu')
      await js(
        `Array.from(document.querySelectorAll('.nl-context-menu button')).find(button=>button.textContent.trim()==='修改').click()`
      )
      await until(
        () => js(`Boolean(document.querySelector('.app-editor textarea'))`),
        'full editor'
      )
    }
    async function fill(content) {
      await js(
        `(()=>{const node=document.querySelector('.app-editor textarea');node.value=${JSON.stringify(content)};node.dispatchEvent(new Event('input',{bubbles:true}))})()`
      )
      await until(
        () => js(`!document.querySelector('.app-editor .ne-submit').disabled`),
        'save enabled'
      )
    }
    await openEditor()
    await fill('unsaved local draft')
    await js(`window.api.updateNote(${id},{content:'newer external content'})`)
    await js(`document.querySelector('.app-editor .ne-submit').click()`)
    await until(
      () =>
        js(
          `Array.from(document.querySelectorAll('.msg-toast')).some(node=>node.textContent.includes('便签已发生变化'))`
        ),
      'conflict message'
    )
    assert.equal(
      await js(`document.querySelector('.app-editor textarea')?.value`),
      'unsaved local draft'
    )
    assert.equal(
      await js(`window.api.getNote(${id}).then(note=>note.content)`),
      'newer external content'
    )
    assert.equal(await js(`document.querySelector('.app-editor .ne-submit').disabled`), false)
    console.log('Full editor conflict: database preserved, local draft retained, save re-enabled')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}

app.on('will-quit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* SQLite may still be closing. */
  }
})
