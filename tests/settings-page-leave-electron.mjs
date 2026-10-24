import { createHash } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/settings-page-leave-electron.mjs',
  mode: 'electron-real-app-settings-page-leave-tray-sqlite',
  prefix: 'abandon-settings-page-leave-',
  metadata: {
    realWindows: true,
    realRendererAndPreload: true,
    realDiskDatabase: true,
    navigationEntry: 'production-tray-menu-template-view-item-click',
    nativeTrayMouseHitTesting: false,
    requestedInputToTrayDelaysMs: [0, 100, 299],
    inputCommit: 'focused-local-text-without-Enter-at-0ms; Enter-committed-model-at-100-and-299ms',
    timingBoundary: 'requested delays; actual dispatch and write times recorded, not sub-ms timing',
    saveFailure: 'real-SQLite-insert-and-update-trigger',
    committedReadFailure:
      'test-only exact repository SELECT interception after a second connection observes committed font DML; held through actual renderer page-leave preparation',
    committedReceiptTransport: 'actual renderer window.api through production preload and IPC',
    committedWriteAudit: 'real AFTER INSERT/UPDATE triggers include repeated same-value writes',
    cancellationTiming: 'one test-held real setting IPC handler before original validation/write',
    userHideEntry: 'real-preload-closeWindow-to-hideToTray',
    exitPreparationVerified: false,
    mainProcessRestart: false,
    osAutoStartModified: false,
    nativeBlurEnableVerified: false
  }
})
const { assert, root } = lifecycle
const databasePath = join(root, 'app.db')
const output = process.env.ABANDON_TEST_EVIDENCE_DIR || root
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const viewLabels = { list: '便签列表', month: '月视图', week: '周视图' }
const scopes = { list: 'main', month: 'month', week: 'week' }
const fontSelector = '[data-diagnostic-action="settings.fontSizeBase"] input'
const scenarios = [],
  writes = [],
  navigations = [],
  windowEvents = [],
  appMessages = [],
  screenshots = [],
  committedReadFailures = []
let current, hooks, armedWrite, activeWrite, restoreSend
let committedReadFault = null,
  restoreSettingsPrepare = null,
  probeCommittedRead = null
let phase = 'startup'
let eventSequence = 0

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function receiptSummary(result) {
  return {
    kind: result?.kind ?? null,
    source: result?.source ?? null,
    persistence: result?.persistence ?? null,
    application: result?.application ?? null,
    verification: result?.verification ?? null,
    delivery: result?.delivery ?? null,
    hasValues: Object.prototype.hasOwnProperty.call(result || {}, 'values'),
    snapshotIsNull: result?.snapshot === null,
    snapshotError: result?.snapshotError ?? null
  }
}

// Preserve the production handler, source validation and SQLite. Only the cancellation
// case holds one request, so hiding can be tested before an actual write completes.
const originalHandle = ipcMain.handle
ipcMain.handle = function (channel, listener) {
  if (channel !== 'set-setting-value') return originalHandle.call(this, channel, listener)
  return originalHandle.call(this, channel, async (event, id, value, source) => {
    const entry = {
      id,
      value,
      source: source ? { ...source } : null,
      sourceScope: source?.scope,
      sourceUrl: event.senderFrame?.url,
      startedAt: Date.now(),
      startedSequence: ++eventSequence,
      phase
    }
    writes.push(entry)
    const gate = armedWrite?.value === value && id === 'css.fontSizeBase' ? armedWrite : null
    if (gate) {
      armedWrite = null
      activeWrite = gate
    }
    try {
      if (gate) await gate.release.promise
      const result = await listener(event, id, value, source)
      entry.receipt = receiptSummary(result)
      entry.status = 'saved'
      return result
    } catch (error) {
      entry.status = 'failed'
      entry.error = error.message
      throw error
    } finally {
      entry.finishedAt = Date.now()
      entry.finishedSequence = ++eventSequence
      gate?.finished.resolve()
      if (activeWrite === gate) activeWrite = null
    }
  })
}

const js = (source) => current.webContents.executeJavaScript(source)
const exists = (selector) => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
async function until(predicate, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await wait(20)
  }
  throw new Error(phase + ': ' + label)
}
function readFonts() {
  const db = new Database(databasePath, { readonly: true })
  try {
    return Object.fromEntries(
      db
        .prepare(
          "SELECT window_name,value FROM app_settings WHERE key='font_size_base' AND window_name IN ('main','month','week') ORDER BY window_name"
        )
        .all()
        .map(({ window_name, value }) => [window_name, Number(value)])
    )
  } finally {
    db.close()
  }
}
function idle() {
  const state = hooks.navigationState()
  return !state.checkingDrafts && !state.switching && !state.pendingReady && !state.queuedTarget
}
function traySwitch(mode) {
  const menu = hooks.getTrayMenuTemplate().find((item) => item.label?.startsWith('当前视图：'))
  const item = menu?.submenu.find((candidate) => candidate.label === viewLabels[mode])
  assert.equal(typeof item?.click, 'function', 'production tray view callback exists')
  const requestedAt = Date.now()
  item.click()
  return requestedAt
}
async function waitForView(mode) {
  const filename = mode === 'list' ? 'index' : mode
  await until(
    () =>
      current.webContents.getURL().endsWith('/' + filename + '.html') &&
      hooks.navigationState().mode === mode &&
      current.isVisible() &&
      idle(),
    mode + ' completed real renderer-ready navigation'
  )
  await until(() => exists('.titlebar-btn-settings'), mode + ' titlebar ready')
}
async function openSettings() {
  if (!(await exists('.settings-panel'))) await click('.titlebar-btn-settings')
  await until(() => exists('.settings-panel.active'), 'settings panel active')
  await until(
    () =>
      js(`(() => { const input=document.querySelector(${JSON.stringify(fontSelector)});
        return input && Number(input.value)===${readFonts()[scopes[hooks.navigationState().mode]]} })()`),
    'settings form loaded actual SQLite value'
  )
}
async function inputFont(value, { commit = true } = {}) {
  return js(`(() => {
    const input=document.querySelector(${JSON.stringify(fontSelector)});
    if (!input || input.closest('.settings-panel').inert) throw new Error('Settings form is not editable');
    input.focus();
    input.value=${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    if (${commit}) input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    return Date.now()
  })()`)
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
  const png = (await current.webContents.capturePage()).toPNG()
  writeFileSync(join(output, file), png, { flag: 'wx' })
  screenshots.push({ file, sha256: createHash('sha256').update(png).digest('hex'), phase })
}
function setSaveFailure(enabled) {
  const db = new Database(databasePath)
  try {
    db.exec(`DROP TRIGGER IF EXISTS page_leave_reject_font_insert;
      DROP TRIGGER IF EXISTS page_leave_reject_font_update;`)
    if (enabled) {
      db.exec(`
        CREATE TRIGGER page_leave_reject_font_insert BEFORE INSERT ON app_settings
        WHEN NEW.window_name='main' AND NEW.key='font_size_base'
        BEGIN SELECT RAISE(ABORT,'injected page leave setting failure'); END;
        CREATE TRIGGER page_leave_reject_font_update BEFORE UPDATE ON app_settings
        WHEN NEW.window_name='main' AND NEW.key='font_size_base'
        BEGIN SELECT RAISE(ABORT,'injected page leave setting failure'); END;`)
    }
  } finally {
    db.close()
  }
}

function createFontWriteAudit() {
  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE page_leave_font_write_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        window_name TEXT NOT NULL,
        value TEXT
      );
      CREATE TRIGGER page_leave_font_audit_insert AFTER INSERT ON app_settings
      WHEN NEW.key='font_size_base' AND NEW.window_name IN ('main','month','week')
      BEGIN
        INSERT INTO page_leave_font_write_audit(operation,window_name,value)
        VALUES('INSERT',NEW.window_name,NEW.value);
      END;
      CREATE TRIGGER page_leave_font_audit_update AFTER UPDATE ON app_settings
      WHEN NEW.key='font_size_base' AND NEW.window_name IN ('main','month','week')
      BEGIN
        INSERT INTO page_leave_font_write_audit(operation,window_name,value)
        VALUES('UPDATE',NEW.window_name,NEW.value);
      END;`)
  } finally {
    database.close()
  }
}

function readFontWriteAudit(prepare = Database.prototype.prepare) {
  // This connection only sees committed DML. Supplying the original prepare also
  // keeps the injected product read from recursively observing its own probe.
  const database = new Database(databasePath, { readonly: true })
  try {
    return prepare
      .call(
        database,
        'SELECT sequence,operation,window_name,value FROM page_leave_font_write_audit ORDER BY sequence'
      )
      .all()
  } finally {
    database.close()
  }
}

function clearCommittedReadFailure() {
  committedReadFault = null
  probeCommittedRead = null
  restoreSettingsPrepare?.()
  restoreSettingsPrepare = null
}

function armCommittedReadFailure({ scope, value, afterSequence }) {
  if (restoreSettingsPrepare) throw new Error('A committed settings read fault is already armed')
  const originalPrepare = Database.prototype.prepare
  const repositorySelect =
    'SELECT type, key, value, remark, created_at, updated_at FROM app_settings WHERE window_name = ?'
  committedReadFault = { scope, value: String(value), afterSequence }
  Database.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql)
    const productConnection = this
    if (
      typeof sql !== 'string' ||
      sql.replace(/\s+/g, ' ').trim() !== repositorySelect ||
      resolve(productConnection.name).toLowerCase() !== resolve(databasePath).toLowerCase()
    )
      return statement
    const originalAll = statement.all
    statement.all = function (...args) {
      const fault = committedReadFault
      if (fault && args[0] === 'application' && !productConnection.inTransaction) {
        const committed = readFontWriteAudit(originalPrepare).filter(
          (entry) => entry.sequence > fault.afterSequence
        )
        if (
          committed.some(
            (entry) => entry.window_name === fault.scope && entry.value === fault.value
          )
        ) {
          // Keep failing until the real renderer has prepared and cancelled its
          // leave. A diagnostic observer consuming an earlier read cannot make
          // the application owner or renderer recover accidentally.
          committedReadFailures.push({
            phase,
            sequence: ++eventSequence,
            scope: args[0],
            inTransaction: productConnection.inTransaction,
            audit: committed,
            at: Date.now()
          })
          throw Object.assign(new Error('injected committed settings resolve read unavailable'), {
            code: 'TEST_COMMITTED_SETTINGS_READ_UNAVAILABLE'
          })
        }
      }
      return originalAll.apply(this, args)
    }
    // Probe this same product connection without requiring the public snapshot
    // getter to keep doing SQLite reads once its later pure-read work is done.
    probeCommittedRead = () => statement.all('application')
    return statement
  }
  restoreSettingsPrepare = () => {
    Database.prototype.prepare = originalPrepare
  }
}

function removeFontWriteAuditTriggers() {
  const database = new Database(databasePath)
  try {
    database.exec(`DROP TRIGGER IF EXISTS page_leave_font_audit_insert;
      DROP TRIGGER IF EXISTS page_leave_font_audit_update;`)
  } finally {
    database.close()
  }
}

async function verifyCommittedReadFailureDoesNotReplay() {
  phase = 'committed-read-failure-crosses-real-preload-and-ipc'
  await waitForView('list')
  await openSettings()
  const before = readFonts()
  const url = current.webContents.getURL()
  const navigationCount = navigations.length
  const writeCount = writes.length
  const faultCount = committedReadFailures.length
  createFontWriteAudit()
  const auditBefore = readFontWriteAudit()
  const afterSequence = auditBefore.at(-1)?.sequence || 0
  armCommittedReadFailure({ scope: 'main', value: 24, afterSequence })

  // This first explicit write observes the actual value returned through
  // contextBridge, rather than treating a main-process listener result as proof
  // of preload transport. The next distinct write exercises the mounted queue.
  const transported = await js(`window.api.setSettingValue('css.fontSizeBase', 24)`)
  const firstWrite = writes.at(-1)
  assert.equal(writes.length, writeCount + 1)
  assert.equal(firstWrite.id, 'css.fontSizeBase')
  assert.equal(firstWrite.value, 24)
  assert.equal(firstWrite.status, 'saved')
  assert.deepEqual(receiptSummary(transported), firstWrite.receipt)
  assert.equal(transported.kind, 'settings-saved')
  assert.equal(transported.persistence.status, 'saved')
  assert.equal(transported.application.resolve.status, 'failed')
  assert.equal(transported.snapshot, null)
  assert.equal(Object.hasOwn(transported, 'values'), false)
  assert.equal(Object.hasOwn(transported, 'runtime'), false)
  assert.deepEqual(transported.source, firstWrite.source)
  assert.equal(transported.source.scope, 'main')
  assert.equal(typeof transported.source.token, 'string')
  assert.ok(transported.source.token.length > 0)
  assert.equal(
    transported.snapshotError.message,
    'injected committed settings resolve read unavailable'
  )
  assert.deepEqual(readFonts(), { ...before, main: 24 })
  assert.deepEqual(
    readFontWriteAudit().map(({ window_name, value }) => ({ window_name, value })),
    [{ window_name: 'main', value: '24' }]
  )

  phase = 'committed-read-failure-mounted-setting-queue'
  await inputFont(18)
  await until(
    () =>
      writes.some(
        (entry) =>
          entry.phase === phase &&
          entry.id === 'css.fontSizeBase' &&
          entry.value === 18 &&
          entry.finishedSequence
      ),
    'mounted settings queue completed its actual committed IPC'
  )
  const queuedWrite = writes.findLast((entry) => entry.phase === phase && entry.value === 18)
  assert.equal(writes.length, writeCount + 2)
  assert.equal(queuedWrite.status, 'saved')
  assert.equal(queuedWrite.receipt.kind, 'settings-saved')
  assert.equal(queuedWrite.receipt.persistence.status, 'saved')
  assert.equal(queuedWrite.receipt.application.resolve.status, 'failed')
  assert.equal(queuedWrite.receipt.hasValues, false)
  assert.equal(queuedWrite.receipt.snapshotIsNull, true)
  assert.deepEqual(queuedWrite.source, firstWrite.source)
  assert.deepEqual(readFonts(), { ...before, main: 18 })
  const committedAudit = readFontWriteAudit()
  assert.deepEqual(
    committedAudit.map(({ window_name, value }) => ({ window_name, value })),
    [
      { window_name: 'main', value: '24' },
      { window_name: 'main', value: '18' }
    ]
  )
  assert.deepEqual(
    committedAudit.map(({ operation }) => operation),
    ['UPDATE', 'UPDATE']
  )
  assert.ok(
    committedReadFailures.length >= faultCount + 2,
    'each committed write reached an unavailable real application settings read'
  )
  assert.equal(
    committedReadFailures.slice(faultCount).every((entry) => entry.inTransaction === false),
    true
  )
  assert.equal(typeof probeCommittedRead, 'function')
  const failuresBeforePreparationProbe = committedReadFailures.length
  assert.throws(probeCommittedRead, /injected committed settings resolve read unavailable/)
  assert.equal(committedReadFailures.length, failuresBeforePreparationProbe + 1)

  phase = 'committed-read-failure-real-renderer-page-leave-ready'
  const preparationId = 'committed-read-failure-page-leave'
  const prepared = await js(`(async () => {
    let timer;
    try {
      return await Promise.race([
        window.__preparePageLeave(${JSON.stringify(preparationId)}),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('committed receipt page-leave preparation timed out')), 12000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  })()`)
  assert.equal(prepared.ready, true, 'saved without canonical is safe to leave without resaving')
  assert.equal(
    (await formState()).inert,
    true,
    'the actual settings participant prepared its leave'
  )
  assert.equal((await formState()).error, '', 'saved receipt is not displayed as an unsaved intent')
  assert.equal(current.webContents.getURL(), url)
  assert.equal(navigations.length, navigationCount)
  assert.equal(
    writes.length,
    writeCount + 2,
    'page preparation never replays either committed value'
  )
  assert.deepEqual(
    readFontWriteAudit(),
    committedAudit,
    'same-value SQL is also forbidden on leave'
  )
  // Cover the actual queue debounce interval while the persistent read fault and
  // successful preparation remain in force, then release this exact leave ID.
  await wait(400)
  assert.equal(writes.length, writeCount + 2)
  assert.deepEqual(readFontWriteAudit(), committedAudit)
  const failuresBeforeReadyProbe = committedReadFailures.length
  assert.throws(probeCommittedRead, /injected committed settings resolve read unavailable/)
  assert.equal(committedReadFailures.length, failuresBeforeReadyProbe + 1)
  await js(`window.__cancelPageLeave(${JSON.stringify(preparationId)})`)
  clearCommittedReadFailure()

  phase = 'committed-read-failure-production-tray-remount'
  traySwitch('month')
  await waitForView('month')
  assert.equal(navigations.length, navigationCount + 1)
  traySwitch('list')
  await waitForView('list')
  await openSettings()
  assert.equal((await formState()).value, 18, 'remounted source form reads the committed value')
  assert.equal(
    await js(
      `getComputedStyle(document.documentElement).getPropertyValue('--font-size-base').trim()`
    ),
    '18rem'
  )
  assert.equal((await formState()).error, '')
  assert.deepEqual(readFonts(), { ...before, main: 18 })
  assert.equal(navigations.length, navigationCount + 2)
  assert.equal(
    writes.length,
    writeCount + 2,
    'navigation and remount do not replay committed writes'
  )
  assert.deepEqual(readFontWriteAudit(), committedAudit)
  await screenshot('settings-page-leave-committed-read-recovered.png')
  scenarios.push({
    phase,
    before,
    after: readFonts(),
    transported: receiptSummary(transported),
    queuedWrite,
    prepared,
    persistentReadFault: {
      failuresBeforePreparationProbe,
      failuresBeforeReadyProbe,
      activeUntilPreparedAndCancelled: true
    },
    audit: committedAudit,
    readFailures: committedReadFailures.slice(faultCount),
    form: await formState()
  })
}

async function verifyImmediateSwitches() {
  for (const [source, target, delayMs, value] of [
    ['list', 'month', 0, 17],
    ['month', 'week', 100, 22],
    ['week', 'list', 299, 20]
  ]) {
    phase = `tray-switch-${source}-${target}-${delayMs}ms`
    await waitForView(source)
    await openSettings()
    const before = readFonts()
    const navigationCount = navigations.length
    const inputAt = await inputFont(value, { commit: delayMs !== 0 })
    if (delayMs === 0) {
      assert.equal(
        await js(`document.activeElement.matches(${JSON.stringify(fontSelector)})`),
        true
      )
      assert.deepEqual(
        readFonts(),
        before,
        'focused local text has not been persisted before leave'
      )
    }
    const remaining = inputAt + delayMs - Date.now()
    if (remaining > 0) await wait(remaining)
    const requestedAt = traySwitch(target)
    await waitForView(target)
    const after = readFonts()
    assert.deepEqual(
      after,
      { ...before, [scopes[source]]: value },
      'only originating font scope changed'
    )
    assert.equal(navigations.length, navigationCount + 1, 'exactly one page navigation')
    const write = writes.findLast(
      (entry) => entry.phase === phase && entry.id === 'css.fontSizeBase' && entry.value === value
    )
    assert.equal(write?.status, 'saved', 'real renderer write completed successfully')
    assert.equal(
      write.sourceScope,
      scopes[source],
      'real preload source stayed in originating view'
    )
    assert.ok(
      write.finishedSequence < navigations.at(-1).sequence,
      'write completed before page commit'
    )
    scenarios.push({
      phase,
      requestedDelayMs: delayMs,
      actualDelayMs: requestedAt - inputAt,
      before,
      after,
      write
    })
  }
}

async function verifyFailedNavigationAndHiddenFeedback() {
  phase = 'sql-failure-blocks-visible-navigation'
  await openSettings()
  const before = readFonts()
  const url = current.webContents.getURL()
  const navigationCount = navigations.length
  setSaveFailure(true)
  await inputFont(19)
  traySwitch('month')
  await until(() => exists('.settings-save-error'), 'SQLite failure banner appeared')
  await until(async () => idle() && !(await formState()).inert, 'failed leave restored form')
  const failed = await formState()
  assert.equal(hooks.navigationState().mode, 'list')
  assert.equal(current.webContents.getURL(), url)
  assert.equal(navigations.length, navigationCount)
  assert.deepEqual(readFonts(), before, 'failed persistence changed no source or target scope')
  assert.equal(failed.value, 19, 'failed user intent remains available to retry')
  assert.equal(failed.disabled, false)
  assert.match(failed.error, /字体大小/)
  const rejected = writes.findLast((entry) => entry.phase === phase && entry.value === 19)
  assert.equal(rejected?.status, 'failed')
  assert.match(
    rejected.error,
    /injected page leave setting failure/,
    'actual SQL trigger caused rejection'
  )
  scenarios.push({ phase, before, failed, rejected, url })

  phase = 'hidden-source-failure-reveals-feedback'
  await js('window.api.closeWindow()')
  await until(() => !current.isVisible(), 'real user close hid the window')
  const messageStart = appMessages.length
  const writeCount = writes.length
  traySwitch('month')
  await until(
    () =>
      appMessages.slice(messageStart).some((entry) => /设置尚未保存或未能确认/.test(entry.text)),
    'main guard emitted actionable setting failure feedback'
  )
  await until(
    () =>
      js(
        `Array.from(document.querySelectorAll('.msg-toast')).some(el => el.textContent.includes('设置尚未保存或未能确认'))`
      ),
    'actual renderer toast presented the setting failure'
  )
  await until(
    async () => current.isVisible() && idle() && !(await formState()).inert,
    'hidden failure restored visible editable form'
  )
  const feedback = appMessages
    .slice(messageStart)
    .find((entry) => /设置尚未保存或未能确认/.test(entry.text))
  assert.equal(
    feedback.visible,
    true,
    'failure feedback was emitted after the real window became visible'
  )
  assert.equal(current.webContents.getURL(), url)
  assert.equal(navigations.length, navigationCount)
  assert.deepEqual(readFonts(), before)
  assert.equal(writes.length, writeCount, 'leave never silently retries a retained failed setting')
  assert.equal((await formState()).value, 19)
  assert.equal((await formState()).disabled, false)
  await screenshot('settings-page-leave-hidden-failure.png')
  scenarios.push({ phase, feedback, form: await formState(), navigation: hooks.navigationState() })

  phase = 'explicit-retry-then-real-tray-navigation'
  setSaveFailure(false)
  await click('[data-settings-save-retry]')
  await until(
    async () => !(await exists('.settings-save-error')) && readFonts().main === 19,
    'explicit retry persisted retained intent'
  )
  traySwitch('month')
  await waitForView('month')
  assert.deepEqual(readFonts(), { ...before, main: 19 })
  assert.equal(navigations.length, navigationCount + 1)
  scenarios.push({ phase, fonts: readFonts(), navigation: hooks.navigationState() })
}

async function verifyHideCancelsPendingPreparation() {
  phase = 'user-hide-cancels-pending-setting-prepare'
  await openSettings()
  const before = readFonts()
  const url = current.webContents.getURL()
  const navigationCount = navigations.length
  const gate = { value: 18, release: deferred(), finished: deferred() }
  armedWrite = gate
  await inputFont(gate.value)
  traySwitch('week')
  await until(() => activeWrite === gate, 'actual setting IPC reached test scheduling gate')
  await until(
    async () => (await formState()).inert && hooks.navigationState().checkingDrafts,
    'real navigation waits with settings sealed'
  )
  assert.equal((await formState()).disabled, true)
  assert.deepEqual(readFonts(), before, 'held request has not reached SQLite')
  await js('window.api.closeWindow()')
  await until(
    () => !current.isVisible() && idle(),
    'user hide cancels navigation before write release'
  )
  await until(
    async () => !(await formState()).inert,
    'cancel restored editing before unfinished write resolves'
  )
  assert.equal((await formState()).disabled, false)
  assert.equal(current.webContents.getURL(), url)
  assert.equal(navigations.length, navigationCount)
  gate.release.resolve()
  await until(() => activeWrite !== gate, 'original setting IPC completed after release')
  await until(
    () => readFonts().month === gate.value,
    'original source write completed after cancellation'
  )
  // Allow the old guard, queue continuations and the real 300 ms debounce interval to settle.
  await wait(400)
  assert.equal(current.isVisible(), false, 'late completion cannot undo the user hide')
  assert.equal(
    current.webContents.getURL(),
    url,
    'late completion cannot revive cancelled navigation'
  )
  assert.equal(navigations.length, navigationCount)
  assert.deepEqual(readFonts(), { ...before, month: gate.value })
  assert.equal(idle(), true)
  scenarios.push({
    phase,
    before,
    after: readFonts(),
    form: await formState(),
    hidden: !current.isVisible()
  })

  phase = 'fresh-navigation-after-hide-cancellation'
  await hooks.openMainWindowFromTray()
  await until(() => current.isVisible(), 'explicit tray open reveals source')
  traySwitch('week')
  await waitForView('week')
  assert.equal(
    navigations.length,
    navigationCount + 1,
    'a fresh action succeeds after cancellation'
  )
  assert.deepEqual(readFonts(), { ...before, month: gate.value })
  scenarios.push({ phase, fonts: readFonts(), navigation: hooks.navigationState() })
}

async function run() {
  let completed = false,
    failure = null
  try {
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (win) => !win.isDestroyed() && win.webContents.getURL().endsWith('/index.html')
        ),
      'actual list BrowserWindow loaded'
    )
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    assert.equal(typeof hooks?.getTrayMenuTemplate, 'function')
    assert.equal(typeof hooks?.navigationState, 'function')
    await waitForView('list')
    await until(() => hooks.nativeCaptureState().ready, 'application capture prewarm settled')
    const windowId = current.id
    const hwnd = current.getNativeWindowHandle().toString('hex')
    for (const event of ['show', 'hide'])
      current.on(event, () =>
        windowEvents.push({ event, phase, at: Date.now(), visible: current.isVisible() })
      )
    current.webContents.on('did-navigate', (_event, url) =>
      navigations.push({ url, at: Date.now(), sequence: ++eventSequence, phase })
    )
    const originalSend = current.webContents.send
    current.webContents.send = function (channel, ...args) {
      if (channel === 'app:message')
        appMessages.push({ ...args[0], phase, at: Date.now(), visible: current.isVisible() })
      return originalSend.call(this, channel, ...args)
    }
    restoreSend = () => {
      current.webContents.send = originalSend
    }
    await verifyImmediateSwitches()
    await verifyCommittedReadFailureDoesNotReplay()
    await verifyFailedNavigationAndHiddenFeedback()
    await verifyHideCancelsPendingPreparation()
    assert.equal(current.id, windowId, 'all cases reused the original BrowserWindow')
    assert.equal(
      current.getNativeWindowHandle().toString('hex'),
      hwnd,
      'all cases reused the original HWND'
    )
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    armedWrite?.release.resolve()
    activeWrite?.release.resolve()
    await lifecycle.finish({
      completed,
      error: failure,
      window: current,
      summary: {
        phase,
        scenarios,
        writes,
        navigations,
        windowEvents,
        appMessages,
        screenshots,
        committedReadFailures
      },
      restore: () => {
        clearCommittedReadFailure()
        removeFontWriteAuditTriggers()
        setSaveFailure(false)
        ipcMain.handle = originalHandle
        if (current && !current.isDestroyed()) restoreSend?.()
      }
    })
  }
}

try {
  app.setPath('userData', root)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  const seed = new Database(databasePath)
  try {
    seed.exec(`CREATE TABLE app_settings (
      window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,
      remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))`)
    const insert = seed.prepare(
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
    seed.close()
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
  ipcMain.handle = originalHandle
  void lifecycle.finish({ error })
}
