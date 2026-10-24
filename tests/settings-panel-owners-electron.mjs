import { app, BrowserWindow } from 'electron'
import { build } from 'vite'
import { join, resolve } from 'node:path'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { traceRendererExpressions } from './helpers/renderer-evidence.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/settings-panel-owners-electron.mjs',
  mode: 'electron-component-fixture',
  prefix: 'abandon-settings-panel-owners-',
  metadata: {
    productOwners: ['useHolidayDataSettings', 'useSettingsDiagnostics'],
    api: 'isolated delayed promises and retained events',
    scope: 'real Vue mount/unmount and renderer resource ownership; no production IPC or network'
  },
  timeoutMs: 90000
})
app.setPath('userData', lifecycle.root)
const assert = lifecycle.assert
let window
const js = (code) => window.webContents.executeJavaScript(code)
const snapshot = () => js('window.fixture.snapshot()')
async function until(read, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(label)
}
async function restore() {
  if (window && !window.isDestroyed()) await js('window.fixture?.cleanup()')
}
async function run() {
  const output = join(lifecycle.root, 'fixture-dist')
  await build({
    configFile: false,
    root: resolve('tests/fixtures/settings-panel-owners'),
    base: './',
    logLevel: 'error',
    build: { outDir: output, emptyOutDir: false }
  })
  window = new BrowserWindow({
    width: 640,
    height: 440,
    title: 'Settings owner lifetime',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  traceRendererExpressions(window, 'settings-panel-owners')
  await window.loadFile(join(output, 'index.html'))
  await until(
    () => js('Boolean(window.fixture && document.querySelector("#owner"))'),
    'owner did not mount'
  )
  await until(
    async () => (await snapshot()).pending.length === 3,
    'initial owner reads did not start'
  )
  const initial = await snapshot()
  assert.deepEqual(
    initial.subscriptions,
    { holiday: 1, blur: 1, remote: 1 },
    'one subscription per owner event'
  )
  assert.equal(initial.intervals, 1, 'one owned scheduler timer')
  assert.deepEqual(
    initial.calls,
    { holiday: 1, scheduler: 1, retry: 0, remote: 1, import: 0 },
    'mount reads local health once'
  )
  await js('window.fixture.refreshAndQueueRetry()')
  await js('window.fixture.importData()')
  const pending = await snapshot()
  assert.equal(pending.calls.scheduler, 1, 'refreshes coalesce with the active scheduler read')
  assert.equal(pending.calls.retry, 0, 'retry waits behind the active read')
  assert.equal(pending.state.holidayBusy, 'import', 'pending user action owns busy state')
  await js('window.fixture.setMounted(false)')
  assert.equal(
    await js('Boolean(document.querySelector("#unmounted"))'),
    true,
    'Vue owner really unmounted'
  )
  const retired = await snapshot()
  assert.deepEqual(
    retired.subscriptions,
    { holiday: 0, blur: 0, remote: 0 },
    'unmount releases all subscriptions'
  )
  assert.equal(retired.intervals, 0, 'unmount releases its scheduler timer')
  await js('window.fixture.retainedEvents()')
  await js('window.fixture.settle("holiday", {available:true})')
  await js('window.fixture.settle("remote", {available:true})')
  await js('window.fixture.settle("scheduler", null, "late scheduler failure")')
  await js('window.fixture.settle("import", {status:{available:true},importedYears:[2026]})')
  const late = await snapshot()
  assert.deepEqual(
    late.state,
    retired.state,
    'late responses and retained callbacks cannot write retired refs'
  )
  assert.equal(late.calls.retry, 0, 'retired owner cannot dispatch its queued retry')
  assert.deepEqual(late.messages, [], 'retired actions cannot display success or failure toasts')
  assert.deepEqual(late.pending, [], 'all fixture promises settled')
  assert.equal(late.schedulerInFlight, 0, 'scheduler read returned')
  assert.equal(late.maximumSchedulerInFlight, 1, 'scheduler never overlapped')
  await js('window.fixture.setMounted(true)')
  await until(
    async () => (await snapshot()).pending.length === 3,
    'replacement owner reads did not start'
  )
  await js('window.fixture.retainedEvents(0)')
  await js('window.fixture.settle("holiday", {available:true,source:"import",coveredYears:[2026]})')
  await js('window.fixture.settle("remote", {available:true})')
  await js('window.fixture.settle("scheduler", {status:"running"})')
  const replacement = await snapshot()
  assert.deepEqual(
    replacement.subscriptions,
    { holiday: 1, blur: 1, remote: 1 },
    'replacement has fresh subscriptions'
  )
  assert.equal(replacement.intervals, 1, 'replacement owns exactly one new timer')
  assert.equal(
    replacement.state.holiday.available,
    true,
    'replacement accepts its current local result'
  )
  assert.equal(
    replacement.state.remote,
    'available',
    'replacement accepts its current remote result'
  )
  assert.equal(
    replacement.state.scheduler.status,
    'running',
    'replacement accepts its current scheduler result'
  )
  assert.equal(
    replacement.state.blur.status,
    'pending',
    'old callback cannot change replacement diagnostics'
  )
  await js('window.fixture.setMounted(false)')
  const final = await snapshot()
  assert.deepEqual(
    final.subscriptions,
    { holiday: 0, blur: 0, remote: 0 },
    'replacement subscriptions released'
  )
  assert.equal(final.intervals, 0, 'replacement timer released')
  await lifecycle.finish({
    completed: true,
    window,
    summary: {
      initial,
      retired,
      late,
      replacement,
      final,
      limitations: [
        'isolated renderer API',
        'no production IPC, holiday import/download or network',
        'not the complete SettingsPanel SFC'
      ]
    },
    restore
  })
}
void app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error)
    void lifecycle.finish({ error, window, restore })
  })
