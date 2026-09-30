// Run with bundled Node after a --dir --publish never Windows build.
const assert = require('node:assert/strict')
const { spawn, execFile } = require('node:child_process')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { promisify } = require('node:util')

const packageDir = resolve(process.argv[2] || 'tmp/capture-package-20260929/win-unpacked')
mkdirSync('tmp/test-runs', { recursive: true })
const evidence = mkdtempSync(resolve('tmp/test-runs/capture-package-'))
const profile = join(evidence, 'profile')
const env = {
  ...process.env,
  ABANDON_INTEGRATION_TEST: '1',
  PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`
}
for (const key of [
  'ELECTRON_RUN_AS_NODE',
  'QT_PLUGIN_PATH',
  'QT_QPA_PLATFORM_PLUGIN_PATH',
  'QT_ROOT_DIR',
  'QTDIR',
  'ABANDON_INTEGRATION_APP_ROOT',
  'ABANDON_INTEGRATION_NATIVE_DLL'
])
  delete env[key]
let output = '',
  child,
  socket,
  exited = false,
  sequence = 0,
  enginePid
function launch() {
  const outputStart = output.length
  exited = false
  child = spawn(
    join(packageDir, 'AbandonNote.exe'),
    ['--inspect=0', `--user-data-dir=${profile}`],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout.on('data', (bytes) => {
    output += bytes
  })
  child.stderr.on('data', (bytes) => {
    output += bytes
  })
  child.on('exit', () => {
    exited = true
  })
  return outputStart
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, label) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await wait(40)
  }
  throw Error(label)
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const requests = new Map()
function evaluate(expression) {
  return new Promise((resolveResult, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => {
      requests.delete(id)
      reject(Error('Inspector evaluation timed out'))
    }, 15000)
    requests.set(id, (result) => {
      clearTimeout(timeout)
      if (result.error || result.result?.exceptionDetails) reject(Error(JSON.stringify(result)))
      else resolveResult(result.result.result.value)
    })
    socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      })
    )
  })
}
async function connectToApp() {
  const outputStart = launch()
  const url = await until(
    () => output.slice(outputStart).match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/)?.[0],
    'Packaged app inspector did not start'
  )
  socket = new WebSocket(url)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    requests.get(message.id)?.(message)
    requests.delete(message.id)
  })
  // Attach after Electron has left its short-lived bootstrap context.
  await wait(1000)
  await evaluate(
    `globalThis.captureTestElectron = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json')('electron'); true`
  )
}
async function quitApp() {
  await evaluate(`setTimeout(()=>captureTestElectron.app.quit(),100); true`)
  socket.close()
  await until(() => exited, 'Packaged app did not quit')
  await until(() => !alive(enginePid), 'Packaged helper survived quit')
}
;(async () => {
  try {
    await connectToApp()
    const identity = await evaluate(
      `({ packaged: captureTestElectron.app.isPackaged, profile: captureTestElectron.app.getPath('userData') })`
    )
    assert.equal(identity.packaged, true)
    assert.equal(resolve(identity.profile), profile)
    await until(
      () =>
        evaluate(`globalThis.__ABANDON_WINDOW_TEST_HOOKS__?.nativeCaptureState().ready === true`),
      'Packaged native engine not ready'
    )
    enginePid = await evaluate(`__ABANDON_WINDOW_TEST_HOOKS__.nativeCaptureState().pid`)
    assert.equal(alive(enginePid), true)
    const directory = await evaluate(
      `__ABANDON_WINDOW_TEST_HOOKS__.captureCoordinator().host.directory`
    )
    assert.equal(resolve(directory), join(packageDir, 'resources', 'native_capture'))
    const started = await evaluate(`__ABANDON_WINDOW_TEST_HOOKS__.startNativeCapture()`)
    assert.equal(started.status, 'started')
    await wait(250)
    for (const args of [['F'], ['N', 'ctrl']])
      await promisify(execFile)(
        resolve('native_capture/build/bin/capture_input_driver.exe'),
        [String(enginePid), ...args],
        { windowsHide: true }
      )
    await until(
      () => evaluate(`__ABANDON_WINDOW_TEST_HOOKS__.nativeCaptureState().active === false`),
      'Packaged image worker/delivery failed'
    )
    const checkDraft = `!!document.querySelector('.app-modal-card[aria-label="截图新建便签"] .ip-thumb')`
    const attached = await evaluate(
      `Promise.all(captureTestElectron.BrowserWindow.getAllWindows().map(w=>w.webContents.executeJavaScript(${JSON.stringify(checkDraft)}).catch(()=>false))).then(results=>results.some(Boolean))`
    )
    assert.equal(attached, true)
    await evaluate(`(async () => {
      const w = captureTestElectron.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))
      const snapshot = await w.webContents.executeJavaScript('window.api.getSettingsSnapshot()')
      if (snapshot.values.shortcuts.enabled)
        __ABANDON_WINDOW_TEST_HOOKS__.getTrayMenuTemplate().find(item => item.id === 'toggle-global-shortcuts').click()
      const result = await w.webContents.executeJavaScript("window.api.setCaptureShortcut('screenshot', 'Control+Alt+Shift+F8')")
      if (result.status !== 'saved') throw Error('Packaged screenshot binding did not save')
      return true
    })()`)
    await evaluate(
      `Promise.all(captureTestElectron.BrowserWindow.getAllWindows().map(w=>w.webContents.executeJavaScript('window.__clearEditingDrafts?.()').catch(()=>{}))).then(()=>true)`
    )
    await quitApp()
    await connectToApp()
    await until(
      () =>
        evaluate(`globalThis.__ABANDON_WINDOW_TEST_HOOKS__?.nativeCaptureState().ready === true`),
      'Packaged native engine not ready after restart'
    )
    enginePid = await evaluate(`__ABANDON_WINDOW_TEST_HOOKS__.nativeCaptureState().pid`)
    const restored = await evaluate(`(async () => {
      const w = captureTestElectron.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))
      const snapshot = await w.webContents.executeJavaScript('window.api.getSettingsSnapshot()')
      return { profile: captureTestElectron.app.getPath('userData'), values: snapshot.values.shortcuts,
        runtime: snapshot.runtime.shortcuts.screenshot,
        registered: captureTestElectron.globalShortcut.isRegistered('Control+Alt+Shift+F8') }
    })()`)
    assert.equal(resolve(restored.profile), profile)
    assert.equal(restored.values.enabled, true)
    assert.equal(restored.values.screenshot, 'Control+Alt+Shift+F8')
    assert.equal(restored.runtime.enabled, true)
    assert.equal(restored.runtime.registered, true)
    assert.equal(restored.registered, true)
    await quitApp()
    writeFileSync(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          status: 'passed',
          packageDir,
          identity,
          restored,
          assertions: [
            'isolated packaged profile',
            'app-local Qt without development PATH',
            'real screenshot',
            'ASAR image worker',
            'renderer image draft',
            'app/helper quit',
            'same-profile restart retains screenshot binding and restores enabled shortcuts',
            'restarted app/helper quit'
          ]
        },
        null,
        2
      )
    )
    console.log(`Packaged capture smoke passed: ${evidence}`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    socket?.close()
    if (!exited) child?.kill()
    writeFileSync(join(evidence, 'process.log'), output)
  }
})()
