import { createHash } from 'node:crypto'
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/settings-quit-electron.mjs',
  mode: 'electron-real-app-settings-tray-quit-sqlite',
  metadata: {
    realWindows: true,
    realRendererAndPreload: true,
    realDiskDatabase: true,
    quitEntry: 'production-tray-menu-template-quit-item-click',
    navigationEntry: 'production-tray-menu-template-view-item-click',
    nativeTrayMouseHitTesting: false,
    finalInputCommit: 'focused-local-text-without-Enter',
    failureInjection: 'real-SQLite-insert-and-update-trigger',
    ordinaryWriteScheduling: 'one real setting IPC held before original handler',
    zOrderScheduling:
      'real preload and original z-order handler; synchronous production-ledger admission observed; complete original promise plus controlled tail admitted through the real production settings ledger',
    zOrderNativeVerificationHeld: false,
    zOrderWaitBoundary: 'navigation preparation while the single quit intent is deferred',
    finalDatabaseRead: 'independent read-only connection during normal product will-quit',
    mainProcessRestart: false,
    osAutoStartModified: false,
    nativeBlurEnableVerified: false
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-settings-quit-' })
const root = profile.directory
const databasePath = join(root, 'app.db')
const output = process.env.ABANDON_TEST_EVIDENCE_DIR || root
const fontSelector = '[data-diagnostic-action="settings.fontSizeBase"] input'
const events = [],
  writes = [],
  zOrderWrites = [],
  scenarios = [],
  screenshots = []
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
let sequence = 0
let phase = 'startup'
let current, hooks, armedWrite, activeWrite, armedZOrder, activeZOrder
let firstFailure = null
let failureCleanup = false
let forcedExit = false
let readyForFinalQuit = false
let willQuitAttempted = false
let willQuitVerified = false
let evidenceWritten = false
let finalized = false
let cleanupTimer
let quitClicks = 0
let willQuitCount = 0
let finalDatabase = null
let originalWindow = null
const cleanupErrors = []

function record(event, details = {}) {
  const entry = { sequence: ++sequence, event, phase, at: Date.now(), ...details }
  events.push(entry)
  appendFileSync(join(output, 'settings-quit-events.jsonl'), JSON.stringify(entry) + '\n')
  return entry
}
function deferred() {
  let resolvePromise
  const promise = new Promise((done) => {
    resolvePromise = done
  })
  return { promise, resolve: resolvePromise }
}
async function bounded(promise, label, timeoutMs = 12000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(phase + ': ' + label)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function until(predicate, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const result = await bounded(Promise.resolve().then(predicate), label)
    if (result) return result
    await wait(20)
  }
  throw new Error(phase + ': ' + label)
}
const js = (source) =>
  bounded(current.webContents.executeJavaScript(source), 'renderer query timed out')
const exists = (selector) => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)

function readDatabase() {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    return {
      fonts: Object.fromEntries(
        database
          .prepare(
            "SELECT window_name,value FROM app_settings WHERE key='font_size_base' AND window_name IN ('main','month','week') ORDER BY window_name"
          )
          .all()
          .map(({ window_name, value }) => [window_name, Number(value)])
      ),
      activeView: database
        .prepare(
          "SELECT value FROM app_settings WHERE window_name='application' AND key='active_view'"
        )
        .get()?.value,
      zOrderMode: database
        .prepare(
          "SELECT value FROM app_settings WHERE window_name='application' AND key='z_order_mode'"
        )
        .get()?.value
    }
  } finally {
    database.close()
  }
}
function setSaveFailure(enabled) {
  const database = new Database(databasePath)
  try {
    database.exec(`DROP TRIGGER IF EXISTS quit_reject_font_insert;
      DROP TRIGGER IF EXISTS quit_reject_font_update;`)
    if (enabled)
      database.exec(`
      CREATE TRIGGER quit_reject_font_insert BEFORE INSERT ON app_settings
      WHEN NEW.window_name='main' AND NEW.key='font_size_base'
      BEGIN SELECT RAISE(ABORT,'injected quit setting failure'); END;
      CREATE TRIGGER quit_reject_font_update BEFORE UPDATE ON app_settings
      WHEN NEW.window_name='main' AND NEW.key='font_size_base'
      BEGIN SELECT RAISE(ABORT,'injected quit setting failure'); END;`)
  } finally {
    database.close()
  }
}

// The original handlers retain their actual sender/source validation and storage/native work.
// Holding the ordinary request before admission only controls the renderer queue's race.
// For z-order, the original full promise is already admitted synchronously; a second real
// ledger ticket adds a controlled tail. No native completion or successful result is faked.
const originalHandle = ipcMain.handle
ipcMain.handle = function (channel, listener) {
  if (channel === 'set-setting-value') {
    return originalHandle.call(this, channel, async (event, id, value, source) => {
      const entry = record('setting-write-start', { id, value, sourceScope: source?.scope })
      writes.push(entry)
      const gate = id === 'css.fontSizeBase' && armedWrite?.value === value ? armedWrite : null
      if (gate) {
        armedWrite = null
        activeWrite = gate
      }
      try {
        if (gate) await gate.release.promise
        const result = await listener(event, id, value, source)
        entry.status = 'saved'
        return result
      } catch (error) {
        entry.status = 'failed'
        entry.error = error.message
        throw error
      } finally {
        entry.finishedSequence = record('setting-write-finish', {
          id,
          value,
          status: entry.status,
          error: entry.error
        }).sequence
        if (activeWrite === gate) activeWrite = null
      }
    })
  }
  if (channel === 'set-window-z-order-mode') {
    return originalHandle.call(this, channel, (event, requestedMode, source) => {
      const entry = record('z-order-handler-start', { requestedMode, sourceScope: source?.scope })
      zOrderWrites.push(entry)
      let result
      try {
        result = listener(event, requestedMode, source)
      } catch (error) {
        entry.status = 'rejected'
        entry.error = error.message
        record('z-order-handler-rejected', { error: error.message })
        throw error
      }
      entry.synchronousLedger = hooks.settingsOperationState()
      entry.originalReturnedPromise = Boolean(result && typeof result.then === 'function')
      const gate = armedZOrder
      if (!gate) return result
      armedZOrder = null
      activeZOrder = gate
      gate.entry = entry
      return hooks.runSettingsOperationForIntegration(async () => {
        try {
          const actualResult = await result
          entry.originalResult = actualResult
          entry.originalCompletedSequence = record('z-order-original-complete', {
            ledger: hooks.settingsOperationState()
          }).sequence
          await gate.release.promise
          entry.status = 'saved'
          return actualResult
        } catch (error) {
          entry.status = 'failed'
          entry.error = error.message
          throw error
        } finally {
          entry.finishedSequence = record('z-order-controlled-tail-finish', {
            status: entry.status,
            error: entry.error
          }).sequence
          if (activeZOrder === gate) activeZOrder = null
        }
      })
    })
  }
  return originalHandle.call(this, channel, listener)
}

function trayQuit() {
  const item = hooks.getTrayMenuTemplate().find((candidate) => candidate.label === '退出应用')
  assert.equal(typeof item?.click, 'function', 'real tray quit callback exists')
  quitClicks += 1
  record('tray-quit-click', { quitClicks })
  item.click()
}
function traySwitchToMonth() {
  const group = hooks.getTrayMenuTemplate().find((item) => item.label?.startsWith('当前视图：'))
  const item = group?.submenu.find((candidate) => candidate.label === '月视图')
  assert.equal(typeof item?.click, 'function', 'real tray month callback exists')
  record('tray-month-click')
  item.click()
}
async function inputFont(value, commit = false) {
  await js(`(() => {
    const input=document.querySelector(${JSON.stringify(fontSelector)});
    if (!input || input.closest('.settings-panel').inert) throw new Error('Settings form is not editable');
    input.focus();
    input.value=${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    if (${commit}) input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  })()`)
  record('font-input', { value, enterCommitted: commit })
}
async function formState() {
  return js(`(() => {
    const panel=document.querySelector('.settings-panel');
    return { present:Boolean(panel), inert:panel?.inert,
      disabled:document.querySelector('.settings-controls')?.disabled,
      value:Number(document.querySelector(${JSON.stringify(fontSelector)})?.value),
      error:document.querySelector('.settings-save-error')?.textContent.trim() || '' }
  })()`)
}
async function screenshot(file) {
  const png = (
    await bounded(current.webContents.capturePage(), 'screenshot timed out', 3000)
  ).toPNG()
  writeFileSync(join(output, file), png, { flag: 'wx' })
  screenshots.push({ file, phase, sha256: createHash('sha256').update(png).digest('hex') })
}

function latchFailure(error) {
  if (!firstFailure) {
    firstFailure = error instanceof Error ? error : new Error(String(error))
    process.stderr.write(firstFailure.stack + '\n')
  }
  process.exitCode = 1
}
function writeEvidence(file) {
  writeFileSync(
    join(output, file),
    JSON.stringify(
      {
        phase,
        firstFailure: firstFailure?.stack || null,
        failureCleanup,
        forcedExit,
        readyForFinalQuit,
        willQuitVerified,
        willQuitCount,
        quitClicks,
        originalWindow,
        finalDatabase,
        scenarios,
        writes,
        zOrderWrites,
        events,
        screenshots,
        shutdown: hooks?.shutdownState(),
        settingsOperations: hooks?.settingsOperationState(),
        cleanupErrors
      },
      null,
      2
    ),
    { flag: 'wx' }
  )
}
function fail(error) {
  latchFailure(error)
  if (failureCleanup) return
  failureCleanup = true
  clearTimeout(watchdog)
  try {
    record('failure-cleanup-start', { error: firstFailure.message })
    writeEvidence('settings-quit-first-failure.json')
  } catch (evidenceError) {
    cleanupErrors.push(evidenceError.stack || evidenceError.message)
  }
  ipcMain.handle = originalHandle
  armedWrite?.release.resolve()
  activeWrite?.release.resolve()
  armedZOrder?.release.resolve()
  activeZOrder?.release.resolve()
  // Failure cleanup cannot become a successful exit assertion. Retain the profile and
  // first evidence; let ordinary shutdown try first, with a bounded nonzero fallback.
  cleanupTimer = setTimeout(() => {
    forcedExit = true
    try {
      record('failure-cleanup-forced-exit', { exitCode: 1 })
    } catch (diagnosticError) {
      cleanupErrors.push('Forced-exit diagnostic: ' + diagnosticError.message)
    }
    app.exit(1)
  }, 10000)
  try {
    app.quit()
  } catch (quitError) {
    cleanupErrors.push(quitError.stack || quitError.message)
    forcedExit = true
    app.exit(1)
  }
}
const watchdog = setTimeout(() => fail(new Error('Settings quit suite exceeded 90 seconds')), 90000)

// Observe normal product shutdown only. The logger owns its will-quit barrier and final exit.
app.on('will-quit', () => {
  willQuitCount += 1
  if (willQuitAttempted) return
  willQuitAttempted = true
  try {
    record('will-quit', { failureCleanup })
    if (failureCleanup) return
    assert.equal(readyForFinalQuit, true, 'all pre-quit business assertions finished')
    assert.equal(quitClicks, 2, 'failed initial quit and exactly one final deferred quit')
    const shutdown = hooks.shutdownState()
    assert.equal(shutdown.completed, true)
    assert.equal(shutdown.trigger, 'tray-menu')
    for (const [name, stage] of Object.entries(shutdown.stages))
      assert.notEqual(stage.status, 'failed', name + ' shutdown stage failed')
    for (const name of ['business-mutations', 'settings-operations', 'database', 'tray'])
      assert.equal(shutdown.stages[name]?.status, 'complete', name + ' completed normally')
    assert.equal(hooks.settingsOperationState().pending, 0)
    assert.equal(hooks.settingsOperationState().stopped, true)
    finalDatabase = readDatabase()
    assert.deepEqual(
      finalDatabase.fonts,
      { main: 20, month: 23, week: 21 },
      'last uncommitted local text persisted in its source scope before real quit'
    )
    assert.equal(
      finalDatabase.activeView,
      'month',
      'single deferred quit allowed navigation to commit'
    )
    assert.equal(finalDatabase.zOrderMode, 'normal')
    assert.equal(current.isDestroyed(), true, 'product quit closed the original window')
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    const navigation = events.filter((entry) => entry.event === 'did-navigate')
    assert.equal(navigation.length, 1, 'only the authorized month navigation committed')
    assert.match(navigation[0].url, /\/month\.html(?:$|[?#])/)
    const lastWrite = writes.findLast(
      (entry) => entry.id === 'css.fontSizeBase' && entry.value === 20
    )
    assert.equal(lastWrite?.status, 'saved')
    assert.equal(lastWrite.sourceScope, 'main')
    assert.ok(lastWrite.finishedSequence < navigation[0].sequence)
    const zOrder = zOrderWrites.find((entry) => entry.originalCompletedSequence)
    assert.equal(zOrder?.status, 'saved')
    assert.ok(zOrder.finishedSequence < navigation[0].sequence)
    assert.ok(navigation[0].sequence < events.find((entry) => entry.event === 'will-quit').sequence)
    willQuitVerified = true
    writeEvidence('settings-quit-evidence.json')
    evidenceWritten = true
  } catch (error) {
    latchFailure(error)
    try {
      writeEvidence('settings-quit-will-quit-failure.json')
    } catch (evidenceError) {
      cleanupErrors.push(evidenceError.stack || evidenceError.message)
    }
  }
})
app.once('quit', (_event, code) => {
  clearTimeout(watchdog)
  clearTimeout(cleanupTimer)
  ipcMain.handle = originalHandle
  const windowsClosed = BrowserWindow.getAllWindows().length === 0
  try {
    record('quit', { code, windowsClosed, forcedExit })
    if (!firstFailure) {
      assert.equal(code, 0, 'normal product quit reported exit code zero')
      assert.equal(willQuitVerified, true)
      assert.equal(windowsClosed, true)
      assert.equal(failureCleanup, false)
      assert.equal(forcedExit, false)
      assert.equal(evidenceWritten, true)
    }
  } catch (error) {
    latchFailure(error)
  }
  if (finalized) return
  finalized = true
  const completed =
    readyForFinalQuit &&
    willQuitVerified &&
    code === 0 &&
    windowsClosed &&
    evidenceWritten &&
    !firstFailure &&
    !failureCleanup &&
    !forcedExit &&
    cleanupErrors.length === 0
  try {
    recorder.finish({
      completed,
      error: firstFailure,
      evidence: {
        status: evidenceWritten ? 'complete' : 'incomplete',
        artifacts: [
          'settings-quit-events.jsonl',
          ...(evidenceWritten ? ['settings-quit-evidence.json'] : [])
        ],
        scope:
          'Real renderer/preload/SQLite, production tray callbacks and normal single-process quit; no reopened-process claim'
      },
      profileOwnership: profile.ownership,
      cleanup: {
        status:
          completed && profile.ownership === 'runner'
            ? 'complete'
            : completed
              ? 'preserved'
              : 'failed',
        windowsClosed,
        reachedWillQuit: willQuitCount > 0,
        exitCode: code,
        forcedExit,
        errors: cleanupErrors,
        preservedProfile: profile.ownership === 'script' || !completed ? root : undefined,
        scope:
          'Product owns window/process cleanup; runner removes its profile only after verified exit'
      }
    })
  } catch (error) {
    latchFailure(error)
  }
})

async function run() {
  try {
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (window) => !window.isDestroyed() && window.webContents.getURL().endsWith('/index.html')
        ),
      'actual list window loaded'
    )
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    for (const name of [
      'getTrayMenuTemplate',
      'settingsOperationState',
      'runSettingsOperationForIntegration',
      'shutdownState'
    ])
      assert.equal(typeof hooks?.[name], 'function', name + ' integration observation exists')
    await until(() => current.isVisible() && hooks.nativeCaptureState().ready, 'application ready')
    await until(() => exists('.titlebar-btn-settings'), 'titlebar ready')
    originalWindow = { id: current.id, hwnd: current.getNativeWindowHandle().toString('hex') }
    current.webContents.on('did-navigate', (_event, url) => record('did-navigate', { url }))
    current.on('closed', () => record('window-closed', { id: originalWindow.id }))
    await click('.titlebar-btn-settings')
    await until(() => exists('.settings-panel.active'), 'actual settings panel active')
    await until(async () => (await formState()).value === 16, 'form loaded seeded SQLite value')

    phase = 'uncommitted-input-sql-failure-blocks-direct-tray-quit'
    const initial = readDatabase()
    setSaveFailure(true)
    await inputFont(17)
    assert.equal(await js(`document.activeElement.matches(${JSON.stringify(fontSelector)})`), true)
    assert.deepEqual(readDatabase(), initial, 'focused uncommitted input has not reached storage')
    trayQuit()
    await until(() => exists('.settings-save-error'), 'actual SQL failure banner appeared')
    await until(
      async () => !hooks.shutdownState().checkingDrafts && !(await formState()).inert,
      'failed quit restored the editable settings panel'
    )
    const failedForm = await formState()
    const failedState = hooks.shutdownState()
    const rejected = writes.findLast((entry) => entry.value === 17)
    assert.equal(rejected?.status, 'failed')
    assert.match(
      rejected.error,
      /injected quit setting failure/,
      'actual SQLite trigger rejected save'
    )
    assert.deepEqual(readDatabase(), initial)
    assert.equal(current.isDestroyed(), false)
    assert.equal(current.isVisible(), true)
    assert.match(current.webContents.getURL(), /\/index\.html(?:$|[?#])/)
    assert.equal(failedForm.present, true)
    assert.equal(failedForm.disabled, false)
    assert.equal(failedForm.value, 17, 'unsaved user intent remains available for explicit retry')
    assert.match(failedForm.error, /字体大小/)
    assert.equal(failedState.quitRequested, false)
    assert.equal(failedState.deferredQuit, false)
    assert.equal(failedState.startedAt, null)
    assert.equal(willQuitCount, 0)
    await screenshot('settings-quit-sql-failure.png')
    scenarios.push({ phase, failedForm, failedState, rejected, database: readDatabase() })

    phase = 'explicit-retry-saves-retained-intent'
    setSaveFailure(false)
    await click('[data-settings-save-retry]')
    await until(
      async () => !(await exists('.settings-save-error')) && readDatabase().fonts.main === 17,
      'explicit retry saved the retained value'
    )
    assert.deepEqual(readDatabase().fonts, { main: 17, month: 23, week: 21 })
    assert.equal(quitClicks, 1, 'retry does not silently repeat the cancelled quit')
    assert.equal(hooks.shutdownState().startedAt, null)
    scenarios.push({ phase, database: readDatabase(), form: await formState() })

    phase = 'inflight-setting-uncommitted-tail-navigation-and-one-deferred-quit'
    const zOrderGate = { release: deferred(), entry: null }
    armedZOrder = zOrderGate
    await js(`(() => {
      window.__settingsQuitZOrder = {status:'pending'};
      void window.api.setWindowZOrderMode('normal').then(
        result => { window.__settingsQuitZOrder = {status:'saved',result}; },
        error => { window.__settingsQuitZOrder = {status:'failed',error:error.message}; });
    })()`)
    await until(
      () => activeZOrder === zOrderGate && zOrderGate.entry?.originalCompletedSequence,
      'real z-order operation completed and reached controlled ledger tail'
    )
    assert.equal(zOrderGate.entry.originalReturnedPromise, true)
    assert.ok(
      zOrderGate.entry.synchronousLedger.pending > 0,
      'original production z-order handler registered its full promise synchronously'
    )
    assert.equal(zOrderGate.entry.originalResult?.mode, 'normal')
    assert.equal(
      zOrderGate.entry.originalResult?.throttled,
      false,
      'the original z-order request ran its real verification instead of being throttled'
    )
    assert.equal(zOrderGate.entry.sourceScope, 'main')
    assert.equal(
      hooks.settingsOperationState().pending,
      1,
      'controlled tail remains in real ledger'
    )
    const fontGate = { value: 18, release: deferred() }
    armedWrite = fontGate
    await inputFont(18, true)
    await until(() => activeWrite === fontGate, 'first same-setting write is genuinely in flight')
    await inputFont(20)
    assert.equal(await js(`document.activeElement.matches(${JSON.stringify(fontSelector)})`), true)
    assert.equal((await formState()).value, 20)
    assert.equal(readDatabase().fonts.main, 17)
    // Dispatch both real menu actions in the same turn. No artificial delay or second quit
    // gives the navigation owner time to finish before the quit intent is registered.
    traySwitchToMonth()
    trayQuit()
    await until(() => hooks.shutdownState().deferredQuit, 'single quit intent became deferred')
    assert.equal(quitClicks, 2)
    assert.equal(hooks.shutdownState().quitRequested, true)
    assert.equal(hooks.shutdownState().startedAt, null)
    assert.equal(hooks.shutdownState().quitting, false)
    assert.equal(hooks.navigationState().checkingDrafts, true)
    assert.equal(willQuitCount, 0)
    record('ordinary-gate-release')
    fontGate.release.resolve()
    await until(
      () => readDatabase().fonts.main === 20 && hooks.settingsOperationState().sealed,
      'same-setting queue saved final local text then sealed the main settings ledger'
    )
    const heldState = {
      shutdown: hooks.shutdownState(),
      ledger: hooks.settingsOperationState(),
      navigation: hooks.navigationState(),
      database: readDatabase(),
      form: await formState()
    }
    assert.equal(heldState.ledger.pending, 1)
    assert.equal(heldState.shutdown.deferredQuit, true)
    assert.equal(heldState.shutdown.startedAt, null)
    assert.equal(heldState.form.inert, true)
    assert.equal(heldState.form.disabled, true)
    assert.equal(current.isDestroyed(), false)
    assert.equal(events.filter((entry) => entry.event === 'did-navigate').length, 0)
    assert.equal(willQuitCount, 0, 'quit cannot pass the controlled complete settings operation')
    assert.deepEqual(heldState.database.fonts, { main: 20, month: 23, week: 21 })
    const sealedWrite = await js(`window.api.setWindowZOrderMode('normal').then(
      () => ({accepted:true}), error => ({accepted:false,error:error.message}))`)
    assert.equal(sealedWrite.accepted, false, 'sealed main source rejects new nonqueue settings')
    assert.match(sealedWrite.error, /正在离开当前页面/)
    assert.equal(hooks.settingsOperationState().pending, 1)
    const finalWrites = writes.filter(
      (entry) => entry.phase === phase && entry.id === 'css.fontSizeBase'
    )
    assert.deepEqual(
      finalWrites.map((entry) => entry.value),
      [18, 20]
    )
    assert.ok(
      finalWrites.every((entry) => entry.status === 'saved' && entry.sourceScope === 'main')
    )
    assert.ok(
      finalWrites[0].finishedSequence < finalWrites[1].sequence,
      'same-setting writes stayed serialized through final input drain'
    )
    assert.equal(current.id, originalWindow.id)
    assert.equal(current.getNativeWindowHandle().toString('hex'), originalWindow.hwnd)
    scenarios.push({ phase, heldState, sealedWrite, finalWrites })
    await screenshot('settings-quit-held-complete-operation.png')
    readyForFinalQuit = true
    phase = 'release-complete-operation-and-observe-product-quit'
    record('z-order-tail-release')
    zOrderGate.release.resolve()
    // Deliberately no app.quit(), window.destroy(), or second tray quit here.
    // Navigation settlement must resume the preserved intent all the way to real quit.
  } catch (error) {
    fail(error)
  }
}

try {
  app.setPath('userData', root)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  const database = new Database(databasePath)
  try {
    database.exec(`CREATE TABLE app_settings (
      window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,
      remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))`)
    const insert = database.prepare(
      'INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)'
    )
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['application', 'system', 'z_order_mode', 'normal'],
      ...['main', 'month', 'week'].flatMap((scope) => [
        [scope, 'system', 'blur_enabled', 'false'],
        [scope, 'dock', 'dock_enabled_edges', '[]']
      ]),
      ['main', 'css', 'font_size_base', '16'],
      ['month', 'css', 'font_size_base', '23'],
      ['week', 'css', 'font_size_base', '21']
    ])
      insert.run(...row)
  } finally {
    database.close()
  }
  const require = createRequire(import.meta.url)
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'built main chunk exists')
  require(resolve('out/main/chunks', chunk))
  app.once('ready', () => void run())
} catch (error) {
  fail(error)
}
