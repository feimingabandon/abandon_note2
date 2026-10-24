import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createSettingsWriteSource } from '../src/main/settings/settings-write-source.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const require = createRequire(import.meta.url)
const { buildSync } = require('esbuild')
const Database = require('better-sqlite3')
const recorder = createAssertionRecorder({
  suite: 'tests/settings-write-source-electron.mjs',
  mode: 'electron-settings-source-frame-and-scope',
  metadata: {
    realBrowserWindow: true,
    productionSettingsSourceAndClient: true,
    fullApplication: false,
    sqlite: 'real-disk',
    subframePreloadEnabledOnlyInFixture: true
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-settings-source-' })
app.setPath('userData', profile.directory)
const preloadPath = join(profile.directory, 'source-preload.cjs')
buildSync({
  stdin: {
    contents: `import { contextBridge, ipcRenderer } from 'electron'
      import { createSettingsClient } from './src/preload/settings-client.js'
      const client = createSettingsClient(ipcRenderer)
      const initialSnapshot = client.getSnapshot()
      void initialSnapshot.catch(() => {})
      contextBridge.exposeInMainWorld('sourceProbe', {
        snapshot: () => initialSnapshot,
        read: () => client.getSnapshot(),
        readWith: context => ipcRenderer.invoke('get-settings-snapshot', context),
        write: value => client.invoke('set-setting-value', 'font', value),
        issue: () => ipcRenderer.invoke('settings:write-context'),
        writeWith: (context, value) => ipcRenderer.invoke('set-setting-value', 'font', value, context)
      })`,
    resolveDir: process.cwd(),
    sourcefile: 'settings-source-fixture-preload.js'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: preloadPath
})
for (const name of ['index.html', 'month.html'])
  writeFileSync(
    join(profile.directory, name),
    '<!doctype html><title>Settings source fixture</title>'
  )
const database = new Database(join(profile.directory, 'source.db'))
database.exec('CREATE TABLE settings (scope TEXT PRIMARY KEY, value INTEGER)')
database.prepare('INSERT INTO settings VALUES (?, ?)').run('main', 14)
database.prepare('INSERT INTO settings VALUES (?, ?)').run('month', 19)
let currentWindow = null
let scope = 'main'
let file = 'index.html'
let writesSealed = false
const source = createSettingsWriteSource({
  assertCanWrite: () => {
    if (writesSealed) throw new Error('writes sealed')
  },
  getMainWindow: () => currentWindow,
  getActiveWindowName: () => scope,
  getActiveRendererLocation: () => ({ type: 'file', value: join(profile.directory, file) })
})
ipcMain.handle('settings:write-context', (event) => source.issue(event))
ipcMain.handle('get-settings-snapshot', (event, context) => {
  source.assertDocument(event, context)
  return { source: source.captureCurrent(), revision: 0, values: {} }
})
ipcMain.handle('set-setting-value', (event, _id, value, context) => {
  const originalScope = source.assert(event, context)
  database.prepare('UPDATE settings SET value=? WHERE scope=?').run(value, originalScope)
  return true
})

async function run() {
  let completed = false
  let failure = null
  let exitCode = 0
  let windowDestroyed = false
  let databaseClosed = false
  try {
    currentWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true
      }
    })
    const js = (code) => currentWindow.webContents.executeJavaScript(code)
    await currentWindow.loadFile(join(profile.directory, file))
    await js('window.sourceProbe.snapshot()')
    const first = await js('window.sourceProbe.issue()')
    assert.deepEqual((await js('window.sourceProbe.read()')).source, first)
    writesSealed = true
    assert.deepEqual(
      (await js('window.sourceProbe.read()')).source,
      first,
      'A sealed write gate still allows the live document to read'
    )
    await assert.rejects(js('window.sourceProbe.write(17)'), /writes sealed/)
    assert.equal(database.prepare('SELECT value FROM settings WHERE scope=?').get('main').value, 14)
    writesSealed = false
    assert.equal(await js('window.sourceProbe.write(18)'), true, 'Live source can persist')
    assert.equal(database.prepare('SELECT value FROM settings WHERE scope=?').get('main').value, 18)

    const prevented = new Promise((resolveNavigation) => {
      currentWindow.webContents.once('will-navigate', (event) => {
        event.preventDefault()
        resolveNavigation()
      })
    })
    await js("window.location.href = 'https://example.invalid/'; true")
    await prevented
    assert.equal(
      await js('window.sourceProbe.write(18)'),
      true,
      'Prevented navigation retains live settings source'
    )

    // Keep the old document alive while logical navigation has already changed scope.
    scope = 'month'
    file = 'month.html'
    await assert.rejects(js('window.sourceProbe.write(21)'), /页面已失效/)
    await assert.rejects(js('window.sourceProbe.issue()'), /页面已失效/)
    assert.equal(
      database.prepare('SELECT value FROM settings WHERE scope=?').get('month').value,
      19
    )
    await currentWindow.loadFile(join(profile.directory, file))
    await js('window.sourceProbe.snapshot()')
    await assert.rejects(js(`window.sourceProbe.readWith(${JSON.stringify(first)})`), /页面已失效/)
    assert.equal(await js('window.sourceProbe.write(22)'), true)
    await assert.rejects(
      js(`window.sourceProbe.writeWith(${JSON.stringify(first)}, 23)`),
      /页面已失效/
    )
    assert.equal(database.prepare('SELECT value FROM settings WHERE scope=?').get('main').value, 18)
    assert.equal(
      database.prepare('SELECT value FROM settings WHERE scope=?').get('month').value,
      22
    )

    const beforeReload = await js('window.sourceProbe.issue()')
    await currentWindow.loadFile(join(profile.directory, file))
    await js('window.sourceProbe.snapshot()')
    await assert.rejects(
      js(`window.sourceProbe.readWith(${JSON.stringify(beforeReload)})`),
      /页面已失效/
    )
    await assert.rejects(
      js(`window.sourceProbe.writeWith(${JSON.stringify(beforeReload)}, 24)`),
      /页面已失效/
    )
    assert.equal(await js('window.sourceProbe.write(25)'), true)

    await js(`new Promise(resolve => {
      const frame = document.createElement('iframe')
      frame.onload = () => resolve(true)
      frame.src = 'month.html'
      document.body.appendChild(frame)
    })`)
    const childFrame = currentWindow.webContents.mainFrame.frames[0]
    assert.ok(childFrame, 'Fixture has an actual child frame')
    assert.equal(await childFrame.executeJavaScript('Boolean(window.sourceProbe)'), true)
    await assert.rejects(childFrame.executeJavaScript('window.sourceProbe.issue()'), /页面已失效/)
    assert.equal(
      database.prepare('SELECT value FROM settings WHERE scope=?').get('month').value,
      25
    )

    source.stop()
    await assert.rejects(js('window.sourceProbe.write(26)'), /页面已失效/)
    assert.equal(
      database.prepare('SELECT value FROM settings WHERE scope=?').get('month').value,
      25
    )
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    source.stop()
    if (currentWindow && !currentWindow.isDestroyed()) currentWindow.destroy()
    windowDestroyed = !currentWindow || currentWindow.isDestroyed()
    database.close()
    databaseClosed = !database.open
    for (const channel of ['settings:write-context', 'get-settings-snapshot', 'set-setting-value'])
      ipcMain.removeHandler(channel)
    recorder.finish({
      completed,
      error: failure,
      evidence: { status: 'complete', profile: resolve(profile.directory) },
      profileOwnership: profile.ownership,
      cleanup: {
        status: windowDestroyed && databaseClosed ? 'complete' : 'failed',
        windowDestroyed,
        databaseClosed
      }
    })
    app.exit(exitCode)
  }
}

app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
