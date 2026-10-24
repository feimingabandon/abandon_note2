import { createHash } from 'node:crypto'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'
import { waitForFixtureFrame } from './helpers/electron-fixture-frame.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/settings-application-ui-electron.mjs',
  mode: 'electron-real-app-settings-application-state-and-retry',
  prefix: 'abandon-settings-application-ui-',
  metadata: {
    realRendererAndPreload: true,
    realDiskDatabase: true,
    themeFault:
      'one false after the real syncTheme invocation and second-connection proof of committed font DML',
    themeConfirmation:
      'production void invocation remains unconfirmed; no native host ACK is synthesized',
    heldRetry:
      'one wrapper completion Promise after a real theme invocation; not a held native ACK',
    sqlAudit: 'all app_settings INSERT/UPDATE/DELETE, including repeated same-value DML',
    visualScope:
      'actual Chromium pixels with temporary DOM CSS; native blur/GPU/DPI and wallpaper storage are not certified',
    platforms: 'Windows 10/11 x64',
    osAutoStartModified: false,
    mainProcessRestart: false
  }
})
const { assert, root } = lifecycle
const databasePath = join(root, 'app.db')
const output = process.env.ABANDON_TEST_EVIDENCE_DIR || root
const fontSelector = '[data-diagnostic-action="settings.fontSizeBase"] input'
const statusSelector = '[data-settings-application-status]'
const retrySelector = '[data-settings-application-retry]'
const exactThemeTarget = { domains: [], dependencies: ['theme'] }
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const q = JSON.stringify
const calls = [],
  themeCalls = [],
  scenarios = [],
  screenshots = [],
  readFailures = [],
  inputActions = [],
  visualMetrics = [],
  settingsPublications = [],
  frameObservations = []
let phase = 'startup',
  sequence = 0
let current, hooks, capture, originalTheme, activeSave, themeFault, heldTheme
let originalPrepare, readFault, originalSettingsSend
const originalHandle = ipcMain.handle

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function dbRead(sql, parameters = [], prepare = originalPrepare || Database.prototype.prepare) {
  const database = new Database(databasePath, { readonly: true })
  try {
    return prepare.call(database, sql).all(...parameters)
  } finally {
    database.close()
  }
}
const audit = () => dbRead('SELECT * FROM settings_application_dml ORDER BY sequence')
const font = () =>
  Number(
    dbRead("SELECT value FROM app_settings WHERE window_name='main' AND key='font_size_base'")[0]
      ?.value
  )
const lastAuditSequence = () => audit().at(-1)?.sequence || 0
function installAudit() {
  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE settings_application_dml (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL,
        window_name TEXT NOT NULL, key TEXT NOT NULL, old_value TEXT, new_value TEXT);
      CREATE TRIGGER application_ui_audit_insert AFTER INSERT ON app_settings BEGIN
        INSERT INTO settings_application_dml(operation,window_name,key,new_value)
        VALUES('INSERT',NEW.window_name,NEW.key,NEW.value); END;
      CREATE TRIGGER application_ui_audit_update AFTER UPDATE ON app_settings BEGIN
        INSERT INTO settings_application_dml(operation,window_name,key,old_value,new_value)
        VALUES('UPDATE',NEW.window_name,NEW.key,OLD.value,NEW.value); END;
      CREATE TRIGGER application_ui_audit_delete AFTER DELETE ON app_settings BEGIN
        INSERT INTO settings_application_dml(operation,window_name,key,old_value)
        VALUES('DELETE',OLD.window_name,OLD.key,OLD.value); END;`)
  } finally {
    database.close()
  }
}
function rejectFontWrites(enabled) {
  if (!existsSync(databasePath)) return
  const database = new Database(databasePath)
  try {
    database.exec(
      'DROP TRIGGER IF EXISTS application_ui_reject_insert; DROP TRIGGER IF EXISTS application_ui_reject_update;'
    )
    if (enabled)
      database.exec(`
      CREATE TRIGGER application_ui_reject_insert BEFORE INSERT ON app_settings
      WHEN NEW.window_name='main' AND NEW.key='font_size_base'
      BEGIN SELECT RAISE(ABORT,'injected application UI SQL rejection'); END;
      CREATE TRIGGER application_ui_reject_update BEFORE UPDATE ON app_settings
      WHEN NEW.window_name='main' AND NEW.key='font_size_base'
      BEGIN SELECT RAISE(ABORT,'injected application UI SQL rejection'); END;`)
  } finally {
    database.close()
  }
}
function removeAuditTriggers() {
  if (!existsSync(databasePath)) return
  const database = new Database(databasePath)
  try {
    database.exec(`DROP TRIGGER IF EXISTS application_ui_audit_insert;
    DROP TRIGGER IF EXISTS application_ui_audit_update;
    DROP TRIGGER IF EXISTS application_ui_audit_delete;`)
  } finally {
    database.close()
  }
}

// Observe the actual authorized production handlers. Retry targets and source
// cross the real contextBridge; no application result is replaced here.
ipcMain.handle = function (channel, listener) {
  if (
    ![
      'set-setting-value',
      'get-settings-snapshot',
      'settings:retry-application',
      'settings:application-state'
    ].includes(channel)
  )
    return originalHandle.call(this, channel, listener)
  return originalHandle.call(this, channel, async (event, ...args) => {
    const entry = {
      channel,
      phase,
      sequence: ++sequence,
      args: structuredClone(args),
      url: event.senderFrame?.url,
      startedAt: Date.now()
    }
    calls.push(entry)
    if (channel === 'set-setting-value') activeSave = entry
    try {
      const result = await listener(event, ...args)
      entry.result = result
      entry.status = 'returned'
      return result
    } catch (error) {
      entry.status = 'rejected'
      entry.error = error.message
      throw error
    } finally {
      if (activeSave === entry) activeSave = null
      entry.finishedSequence = ++sequence
      entry.finishedAt = Date.now()
    }
  })
}

const js = (source) => current.webContents.executeJavaScript(source)
const exists = (selector) => js(`Boolean(document.querySelector(${q(selector)}))`)
const click = (selector) => js(`document.querySelector(${q(selector)}).click()`)
async function until(predicate, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(20)
  }
  throw new Error(phase + ': ' + label)
}
async function state() {
  return js('window.api.getSettingsApplicationState()')
}
async function ui() {
  return js(`(() => {
    const root=document.querySelector(${q(statusSelector)}), button=document.querySelector(${q(retrySelector)});
    return { state:root?.dataset.state, text:root?.textContent.trim() || '',
      theme:root?.querySelector('[data-application-target="dependency:theme"]')?.textContent.trim() || '',
      unsaved:document.querySelector('.settings-save-error')?.textContent.trim() || '',
      inert:document.querySelector('.settings-panel')?.inert,
      font:Number(document.querySelector(${q(fontSelector)})?.value),
      retryDisabled:button?.disabled };
  })()`)
}
async function openPanel() {
  if (!(await exists('.settings-panel'))) await click('.titlebar-btn-settings')
  await until(() => exists('.settings-panel.active'), 'real SettingsPanel opened')
  await until(async () => (await ui()).font === font(), 'panel loaded actual committed font')
  await until(async () => !(await ui()).retryDisabled, 'application state read completed')
}
async function inputFont(value) {
  await js(`(() => { const input=document.querySelector(${q(fontSelector)});
    if (!input || input.disabled || input.closest('[inert]')) throw new Error('Font input is not editable');
    input.focus(); })()`)
  await js(`(() => { const input=document.querySelector(${q(fontSelector)});
    if (input.getAttribute('aria-expanded')!=='true') input.closest('.fsi-wrapper').querySelector('.fsi-arrow-btn').click(); })()`)
  const allowed = await js(
    `Array.from(document.querySelectorAll('[role="listbox"][aria-label="字号预设"] [role="option"]:not(:disabled)'),option=>Number(option.querySelector('span:last-child').textContent.trim()))`
  )
  inputActions.push({ phase, value, allowed })
  assert.ok(allowed.includes(value), 'font fixture uses an enabled preset in the actual view')
  await js(`(() => { const input=document.querySelector(${q(fontSelector)});
    if (!input || input.disabled || input.closest('[inert]')) throw new Error('Font input is not editable');
    input.focus(); input.value=${q(String(value))};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  })()`)
}
async function screenshot(file, detail = {}, presentedImage = null) {
  const captured = presentedImage || (await current.webContents.capturePage())
  const png = captured.toPNG()
  const size = captured.getSize(),
    bitmap = captured.toBitmap()
  const point = { x: Math.floor(size.width * 0.05), y: Math.floor(size.height * 0.2) }
  const offset = (point.y * size.width + point.x) * 4
  const sample = {
    size,
    point,
    bitmapBytes: bitmap.length,
    colorBytes: Array.from(bitmap.subarray(offset, offset + 3))
  }
  writeFileSync(join(output, file), png, { flag: 'wx' })
  const evidence = {
    phase,
    file,
    sha256: createHash('sha256').update(png).digest('hex'),
    sample,
    ...detail
  }
  screenshots.push(evidence)
  return evidence
}
async function captureFirstFailure(error) {
  const captured = {
    phase,
    at: new Date().toISOString(),
    error: error.stack || String(error),
    beforeGateReleaseAndRestore: true,
    heldTheme: heldTheme ? { entered: heldTheme.entered } : null,
    calls: structuredClone(calls),
    themeCalls: structuredClone(themeCalls),
    inputActions: structuredClone(inputActions),
    visualMetrics: structuredClone(visualMetrics),
    settingsPublications: structuredClone(settingsPublications),
    frameObservations: structuredClone(frameObservations),
    observations: {},
    captureErrors: []
  }
  async function observe(name, read, timeoutMs = 2500) {
    let timer
    try {
      captured.observations[name] = await Promise.race([
        Promise.resolve().then(read),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(name + ' failure capture timed out')),
            timeoutMs
          )
        })
      ])
    } catch (captureError) {
      captured.captureErrors.push({ name, error: captureError.stack || String(captureError) })
    } finally {
      clearTimeout(timer)
    }
  }
  await observe('settingsOperations', () => hooks?.settingsOperationState())
  await observe('navigation', () => hooks?.navigationState())
  await observe('dml', () => audit())
  if (current && !current.isDestroyed()) {
    await observe('ui', ui)
    await observe('pageLeave', () => js('window.__applicationLeaveProbe || null'))
    await observe('keyboard', async () => ({
      windowFocused: current.isFocused(),
      webContentsFocused: current.webContents.isFocused(),
      visible: current.isVisible(),
      renderer: await js(
        `({focused:document.hasFocus(),events:window.__applicationKeyboardEvents || []})`
      )
    }))
    await observe(
      'screenshot',
      async () => {
        const bytes = (await current.webContents.capturePage()).toPNG()
        const file = 'application-first-failure.png'
        writeFileSync(join(output, file), bytes, { flag: 'wx' })
        return { file, sha256: createHash('sha256').update(bytes).digest('hex') }
      },
      3000
    )
  }
  writeFileSync(join(output, 'application-first-failure.json'), JSON.stringify(captured, null, 2), {
    flag: 'wx'
  })
  return captured
}
async function prepareAndCancel(id) {
  const result = await js(`window.__preparePageLeave(${q(id)})`)
  assert.equal(result.ready, true, 'saved application failure does not block page leave')
  assert.equal((await ui()).inert, true)
  await js(`window.__cancelPageLeave(${q(id)})`)
  await until(async () => !(await ui()).inert, 'cancelled preparation restored editing')
  return result
}
function installThemeObservation() {
  capture = hooks.captureCoordinator()
  assert.equal(typeof capture?.syncTheme, 'function')
  originalTheme = capture.syncTheme
  capture.syncTheme = async function (...args) {
    const entry = {
      phase,
      sequence: ++sequence,
      at: Date.now(),
      hostReady: Boolean(this.host?.ready),
      originalInvocation: true
    }
    themeCalls.push(entry)
    const actual = originalTheme.apply(this, args)
    entry.originalReturnType = typeof actual
    await actual
    if (
      themeFault &&
      activeSave?.args[0] === 'css.fontSizeBase' &&
      activeSave.args[1] === themeFault.value
    ) {
      const committed = audit().filter((row) => row.sequence > themeFault.afterSequence)
      assert.equal(
        font(),
        themeFault.value,
        'second SQLite connection sees committed target font before injection'
      )
      assert.ok(
        committed.some(
          (row) =>
            row.window_name === 'main' &&
            row.key === 'font_size_base' &&
            Number(row.new_value) === themeFault.value
        )
      )
      entry.injectedFalse = true
      entry.committedDml = committed
      themeFault = null
      return false
    }
    if (heldTheme && !heldTheme.entered) {
      const gate = heldTheme
      gate.entered = true
      entry.heldCompletion = true
      await gate.release.promise
      entry.releasedAt = Date.now()
    }
    return actual
  }
}

async function waitForStartupSettingsSettlement() {
  phase = 'startup-geometry-settlement'
  const observations = []
  let previous = null,
    quietSince = Date.now()
  await until(() => {
    const observation = {
      audit: audit(),
      bounds: current.getBounds(),
      settingsOperations: hooks.settingsOperationState()
    }
    const signature = JSON.stringify(observation)
    if (signature !== previous) {
      observations.push({ at: Date.now(), ...observation })
      previous = signature
      quietSince = Date.now()
      return false
    }
    // Startup show/move can schedule the production 500ms geometry debounce.
    // Observe unchanged SQL, bounds and admission beyond that interval before
    // arming the font-specific fault; do not attribute startup DML to reopening.
    return observation.settingsOperations.pending === 0 && Date.now() - quietSince >= 700
  }, 'startup SQL, actual bounds and application work settle beyond the geometry debounce')
  scenarios.push({
    phase,
    observations,
    settledAt: Date.now(),
    quietIntervalMs: Date.now() - quietSince
  })
}

async function verifySavedFailureAndRetry() {
  phase = 'font-save-committed-theme-fault'
  const before = lastAuditSequence()
  themeFault = { value: 22, afterSequence: before }
  await inputFont(22)
  await until(async () => (await ui()).state === 'failed', 'saved application failure appears')
  const failed = await state(),
    form = await ui(),
    committed = audit()
  assert.equal(themeFault, null, 'exact target injection was consumed once')
  assert.equal(themeCalls.filter((entry) => entry.injectedFalse).length, 1)
  assert.equal(font(), 22)
  assert.equal(form.font, 22)
  assert.equal(form.unsaved, '')
  assert.match(form.text, /设置已保存/)
  assert.match(form.theme, /应用失败/)
  assert.equal(failed.ledger.dependencies.theme.status, 'failed')
  const write = calls.findLast(
    (entry) => entry.channel === 'set-setting-value' && entry.args[1] === 22
  )
  assert.equal(write.result.persistence.status, 'saved')
  assert.equal(write.result.application.dependencies.theme.status, 'failed')
  assert.deepEqual(write.args[2], failed.source)
  assert.equal(failed.source.scope, 'main')
  await screenshot('application-saved-failed.png')
  await prepareAndCancel('application-failed-can-leave')
  assert.deepEqual(audit(), committed, 'leave does not repeat saved SQL')
  phase = 'close-reopen-retains-application-ledger'
  await click('.panel-close-btn')
  await until(async () => !(await exists('.settings-panel')), 'panel closed normally')
  await openPanel()
  const reopened = await state()
  assert.equal(reopened.ledger.commitId, failed.ledger.commitId)
  assert.equal(reopened.ledger.dependencies.theme.status, 'failed')
  assert.ok(reopened.ledgerRevision >= failed.ledgerRevision)
  assert.deepEqual(audit(), committed, 'panel remount performs no setting DML')
  phase = 'exact-theme-ui-retry-uses-saved-values'
  const themeBefore = themeCalls.length,
    callBefore = calls.length
  await click(retrySelector)
  await until(
    async () => (await ui()).state === 'unconfirmed' && !(await ui()).retryDisabled,
    'production void theme result remains unconfirmed'
  )
  const retry = calls
    .slice(callBefore)
    .find((entry) => entry.channel === 'settings:retry-application')
  assert.deepEqual(retry.args[0], exactThemeTarget)
  assert.deepEqual(retry.args[1], failed.source)
  assert.equal(retry.result.persistence.status, 'unchanged')
  assert.deepEqual(Object.keys(retry.result.application.dependencies), ['theme'])
  assert.deepEqual(Object.keys(retry.result.application.domains), [])
  assert.equal(retry.result.application.dependencies.theme.status, 'unconfirmed')
  assert.equal(themeCalls.length, themeBefore + 1)
  assert.equal(themeCalls.at(-1).originalReturnType, 'undefined')
  assert.deepEqual(audit(), committed, 'application retry performs zero INSERT/UPDATE/DELETE')
  assert.equal(font(), 22)
  assert.doesNotMatch((await ui()).text, /已保存，已应用/)
  scenarios.push({ phase, failed, reopened, retry, committedDml: committed, ui: await ui() })
}

async function verifyHeldRetryAndKeyboard() {
  phase = 'keyboard-theme-retry-and-page-leave-rendezvous'
  const committed = audit(),
    before = calls.length
  heldTheme = { entered: false, release: deferred() }
  const keyboard = await js(`(() => {
    window.__applicationKeyboardEvents=[];
    const trace=(event,capture)=>window.__applicationKeyboardEvents.push({type:event.type,capture,
      key:event.key,code:event.code,isTrusted:event.isTrusted,defaultPrevented:event.defaultPrevented,
      retryTarget:event.target.matches(${q(retrySelector)}),focused:document.hasFocus()});
    const entries=[];
    for(const type of ['keydown','keypress','keyup','click']) for(const capture of [true,false]) {
      const listener=event=>trace(event,capture); document.addEventListener(type,listener,capture);
      entries.push([type,listener,capture]);
    }
    window.__stopApplicationKeyboard=()=>entries.forEach(args=>document.removeEventListener(...args));
    const button=document.querySelector(${q(retrySelector)});
    button.scrollIntoView({block:'nearest'});
    const focusable=[...button.closest('.settings-panel').querySelectorAll('button,input,select,textarea,[tabindex]')]
      .filter(el=>!el.disabled && el.tabIndex>=0 && el.getClientRects().length && !el.closest('[inert]'));
    const index=focusable.indexOf(button);
    if(index<1) throw new Error('Retry button has no preceding keyboard target');
    focusable[index-1].focus(); return { prior:document.activeElement.tagName, index };
  })()`)
  current.focus()
  current.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  current.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await until(
    async () =>
      current.isFocused() &&
      current.webContents.isFocused() &&
      (await js(`document.hasFocus() && document.activeElement.matches(${q(retrySelector)})`)),
    'native Tab reaches application retry'
  )
  keyboard.beforeEnter = {
    windowFocused: current.isFocused(),
    webContentsFocused: current.webContents.isFocused(),
    visible: current.isVisible(),
    renderer: await js(
      `({focused:document.hasFocus(),retryFocused:document.activeElement.matches(${q(retrySelector)})})`
    )
  }
  assert.equal(keyboard.beforeEnter.windowFocused, true)
  assert.equal(keyboard.beforeEnter.webContentsFocused, true)
  assert.equal(keyboard.beforeEnter.visible, true)
  assert.deepEqual(keyboard.beforeEnter.renderer, { focused: true, retryFocused: true })
  // Electron sendInputEvent does not synthesize char from keyDown/keyUp. The
  // isolated three-protocol diagnostic proves native button activation needs CR.
  current.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  current.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  current.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await until(() => heldTheme.entered, 'keyboard Enter invoked a real held theme retry')
  keyboard.events = await js('window.__applicationKeyboardEvents')
  for (const type of ['keydown', 'keypress', 'click'])
    assert.ok(
      keyboard.events.some(
        (event) =>
          event.type === type &&
          (type === 'click' || event.key === 'Enter') &&
          event.isTrusted &&
          event.retryTarget &&
          event.focused &&
          !event.defaultPrevented
      ),
      'trusted ' + type + ' reached the focused retry button'
    )
  assert.ok(
    keyboard.events.some(
      (event) => event.type === 'keyup' && event.key === 'Enter' && event.isTrusted && event.focused
    ),
    'trusted Enter keyup is delivered after the retry button becomes disabled'
  )
  assert.equal(
    calls.slice(before).filter((entry) => entry.channel === 'settings:retry-application').length,
    1
  )
  await js('window.__stopApplicationKeyboard()')
  await js(`(() => { window.__applicationLeaveProbe={done:false};
    void window.__preparePageLeave('held-application-retry').then(
      value=>Object.assign(window.__applicationLeaveProbe,{done:true,value}),
      error=>Object.assign(window.__applicationLeaveProbe,{done:true,error:error.message})); })()`)
  await until(async () => (await ui()).inert, 'actual page participant sealed editing')
  await wait(100)
  assert.equal(
    await js('window.__applicationLeaveProbe.done'),
    false,
    'page leave waits for the in-flight retry completion rather than only SQL queues'
  )
  assert.deepEqual(audit(), committed)
  heldTheme.release.resolve()
  await until(
    () => js('window.__applicationLeaveProbe.done'),
    'leave completes after the exact retry resolves'
  )
  const prepared = await js('window.__applicationLeaveProbe')
  assert.deepEqual(prepared.value, { ready: true })
  assert.equal(prepared.error, undefined)
  await js("window.__cancelPageLeave('held-application-retry')")
  await until(
    async () => !(await ui()).inert && !(await ui()).retryDisabled,
    'editing and retry restored after cancellation'
  )
  const retry = calls.slice(before).find((entry) => entry.channel === 'settings:retry-application')
  assert.deepEqual(retry.args[0], exactThemeTarget)
  assert.equal(retry.result.application.dependencies.theme.status, 'unconfirmed')
  assert.deepEqual(audit(), committed)
  heldTheme = null
  scenarios.push({ phase, keyboard, prepared, retry, dml: committed })
}

async function verifySqlFailureStillBlocksLeave() {
  phase = 'sql-rejection-remains-unsaved-and-blocks-leave'
  const committed = audit(),
    before = font()
  rejectFontWrites(true)
  await inputFont(21)
  await until(() => exists('.settings-save-error'), 'real SQL rejection is retained as unsaved')
  const blocked = await js(`window.__preparePageLeave('rejected-sql').then(
    value=>({ready:true,value}),error=>({ready:false,error:error.message}))`)
  assert.equal(blocked.ready, false)
  assert.match(blocked.error, /injected application UI SQL rejection/)
  assert.equal((await ui()).state, 'unsaved')
  assert.equal((await ui()).font, 21)
  assert.equal(font(), before)
  assert.deepEqual(audit(), committed, 'rejected transaction left no app_settings DML')
  assert.equal((await ui()).inert, false)
  await screenshot('application-sql-unsaved.png')
  rejectFontWrites(false)
  await click('[data-settings-save-retry]')
  await until(
    async () =>
      font() === 21 &&
      !(await exists('.settings-save-error')) &&
      (await ui()).state === 'unconfirmed',
    'only explicit save retry submits the retained failed intent'
  )
  const newRows = audit().filter((row) => row.sequence > (committed.at(-1)?.sequence || 0))
  assert.equal(
    newRows.filter((row) => row.key === 'font_size_base' && row.window_name === 'main').length,
    1
  )
  scenarios.push({ phase, blocked, before, after: font(), recoveredDml: newRows })
}

async function verifyReadingSurfaces() {
  phase = 'white-black-complex-and-narrow-reading-surfaces'
  const baseline = audit()
  for (const variant of [
    { name: 'white', bg: '255 255 255', text: '#1d1d1f', backdrop: '#fff', marker: 37 },
    { name: 'black', bg: '0 0 0', text: '#f5f5f7', backdrop: '#000', marker: 73 },
    {
      name: 'complex',
      bg: '255 255 255',
      text: '#1d1d1f',
      marker: 109,
      backdrop: 'repeating-conic-gradient(#063b72 0% 25%, #f7c957 0% 50%) 0 0 / 80px 80px'
    },
    {
      name: 'narrow-large',
      bg: '255 255 255',
      text: '#1d1d1f',
      backdrop: '#fff',
      narrow: true,
      marker: 149
    }
  ]) {
    const paint = waitForFixtureFrame({
      webContents: current.webContents,
      name: variant.name,
      marker: [variant.marker, variant.marker, variant.marker],
      palette:
        variant.name === 'black' ? 'black' : variant.name === 'complex' ? 'complex' : 'white',
      viewport: await js('({width:innerWidth,height:innerHeight})')
    })
    frameObservations.push(paint.trace)
    try {
      await js(`(() => {
      document.getElementById('application-test-visual')?.remove();
      document.getElementById('application-paint-marker')?.remove();
      const style=document.createElement('style');style.id='application-test-visual';
      style.textContent=${q(`:root{--bg-color:${variant.bg}!important;--text-color:${variant.text}!important;}
        body{background:${variant.backdrop}!important;}.settings-wrapper{background:${variant.backdrop}!important;}
        /* Test-only drawing probe marks this compositor generation outside the panel. */
        #application-paint-marker{position:fixed;left:8px;top:160px;width:4px;height:4px;pointer-events:none;z-index:var(--z-global-critical);background:rgb(${variant.marker} ${variant.marker} ${variant.marker})!important;}
        ${variant.narrow ? '.settings-panel{width:340px!important;max-width:100%!important;left:0!important;right:auto!important;--font-size-base:28rem!important;--fs-secondary:16px!important;}' : ''}`)};
      document.head.append(style);
      const marker=document.createElement('div');marker.id='application-paint-marker';document.body.append(marker);
      const root=document.querySelector(${q(statusSelector)}),button=document.querySelector(${q(retrySelector)});
      root.scrollTop=root.scrollHeight;button.scrollIntoView({block:'nearest'});
    })()`)
      const presentedImage = await paint.ready
      assert.equal(paint.trace.cleanupError, undefined, 'frame subscription ended normally')
      const metrics = await js(`(() => {
      const root=document.querySelector(${q(statusSelector)}),button=document.querySelector(${q(retrySelector)});
      const rect=button.getBoundingClientRect(),readingRect=root.getBoundingClientRect(),panel=button.closest('.settings-panel'),surface=getComputedStyle(panel);
      return {button:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}, viewport:{width:innerWidth,height:innerHeight},
        reading:{top:readingRect.top,bottom:readingRect.bottom},
        panelWidth:panel.getBoundingClientRect().width,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,
        validBackground:CSS.supports('color',${q('rgb(' + variant.bg + ')')}),
        backgroundToken:getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim(),
        panelBackground:surface.backgroundColor,textColor:getComputedStyle(root).color,
        titleColor:getComputedStyle(root.querySelector('.status-title')).color,
        fontSize:getComputedStyle(root).fontSize,enabled:!button.disabled,label:button.textContent.trim(),
        hitStack:document.elementsFromPoint(rect.x+rect.width/2,rect.y+rect.height/2).slice(0,8).map(el=>({
          tag:el.tagName,class:el.className,html:el.outerHTML.slice(0,800),pointerEvents:getComputedStyle(el).pointerEvents,
          position:getComputedStyle(el).position,zIndex:getComputedStyle(el).zIndex})),
        buttonPointerEvents:getComputedStyle(button).pointerEvents,
        ancestors:Array.from((function*(el){while(el){yield el;el=el.parentElement}})(button)).map(el=>({
          tag:el.tagName,class:el.className,inert:el.inert,rect:(()=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})(),
          pointerEvents:getComputedStyle(el).pointerEvents,overflow:getComputedStyle(el).overflow})),
        hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest(${q(retrySelector)})===button};
    })()`)
      visualMetrics.push({ variant: variant.name, metrics })
      assert.equal(
        metrics.validBackground,
        true,
        variant.name + ' fixture supplies RGB channels used by the shared color token'
      )
      assert.equal(
        metrics.backgroundToken.toLowerCase(),
        variant.bg,
        variant.name + ' actual background token matches the fixture'
      )
      assert.equal(metrics.enabled, true, variant.name + ' retry remains usable')
      assert.equal(metrics.hit, true, variant.name + ' retry has a visible unoccluded hit target')
      assert.ok(metrics.button.width > 0 && metrics.button.height > 0)
      assert.ok(
        metrics.button.x >= 0 &&
          metrics.button.x + metrics.button.width <= metrics.viewport.width + 1
      )
      assert.ok(
        metrics.button.y >= 0 &&
          metrics.button.y + metrics.button.height <= metrics.viewport.height + 1
      )
      assert.ok(
        metrics.button.y >= metrics.reading.top - 1 &&
          metrics.button.y + metrics.button.height <= metrics.reading.bottom + 1,
        variant.name + ' complete retry button remains inside its scrollable reading surface'
      )
      assert.equal(metrics.label, '重试应用')
      assert.ok(
        metrics.scrollWidth <= metrics.clientWidth + 1,
        variant.name + ' application status does not overflow horizontally'
      )
      assert.notEqual(metrics.panelBackground, 'rgba(0, 0, 0, 0)')
      if (variant.narrow) assert.ok(metrics.panelWidth <= 341)
      const captured = await screenshot(
        'application-status-' + variant.name + '.png',
        {
          variant: variant.name,
          metrics
        },
        presentedImage
      )
      assert.equal(
        captured.sample.bitmapBytes,
        captured.sample.size.width * captured.sample.size.height * 4
      )
      const colors = captured.sample.colorBytes
      if (variant.name === 'black')
        assert.ok(Math.max(...colors) < 60, 'black fixture reached the captured pixels')
      else if (variant.name === 'complex')
        assert.ok(
          Math.max(...colors) - Math.min(...colors) > 50,
          'complex colored backdrop reached the captured pixels'
        )
      else
        assert.ok(
          Math.min(...colors) > 150,
          variant.name + ' white backdrop reached the captured pixels'
        )
    } finally {
      paint.close()
      await js("document.getElementById('application-paint-marker')?.remove()")
    }
  }
  await js("document.getElementById('application-test-visual')?.remove()")
  assert.deepEqual(audit(), baseline, 'visual fixtures use DOM CSS without writing settings')
  scenarios.push({
    phase,
    visualBoundary:
      'CSS-constrained 340px panel and 16px status text; actual native viewport/DPI unchanged'
  })
}

function armCommittedReadFault(value) {
  originalPrepare = Database.prototype.prepare
  readFault = { value, afterSequence: lastAuditSequence() }
  const repositorySelect =
    'SELECT type, key, value, remark, created_at, updated_at FROM app_settings WHERE window_name = ?'
  Database.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql),
      connection = this
    if (
      typeof sql !== 'string' ||
      sql.replace(/\s+/g, ' ').trim() !== repositorySelect ||
      resolve(connection.name).toLowerCase() !== resolve(databasePath).toLowerCase()
    )
      return statement
    const all = statement.all
    statement.all = function (...args) {
      if (
        readFault &&
        args[0] === 'application' &&
        !connection.inTransaction &&
        font() === readFault.value &&
        audit().some(
          (row) =>
            row.sequence > readFault.afterSequence &&
            row.key === 'font_size_base' &&
            Number(row.new_value) === readFault.value
        )
      ) {
        readFailures.push({
          phase,
          sequence: ++sequence,
          inTransaction: connection.inTransaction,
          value: font()
        })
        throw new Error('injected application UI committed read unavailable')
      }
      return all.apply(this, args)
    }
    return statement
  }
}
function clearReadFault() {
  readFault = null
  if (originalPrepare) Database.prototype.prepare = originalPrepare
  originalPrepare = null
}
async function verifySavedOnlyReadback() {
  phase = 'saved-only-canonical-readback-unavailable'
  const before = lastAuditSequence()
  armCommittedReadFault(20)
  await inputFont(20)
  await until(
    async () => (await ui()).text.includes('设置已保存，当前值尚待确认'),
    'saved-only state is readable in actual Panel'
  )
  const write = calls.findLast(
    (entry) => entry.channel === 'set-setting-value' && entry.args[1] === 20
  )
  assert.equal(write.result.persistence.status, 'saved')
  assert.equal(write.result.snapshot, null)
  assert.equal(Object.hasOwn(write.result, 'values'), false)
  assert.ok(readFailures.length > 0)
  assert.equal((await ui()).font, 20)
  assert.equal((await ui()).unsaved, '')
  assert.equal(font(), 20)
  const committed = audit()
  assert.equal(
    committed.filter((row) => row.sequence > before && row.key === 'font_size_base').length,
    1
  )
  await prepareAndCancel('saved-only-application-can-leave')
  assert.deepEqual(audit(), committed)
  await screenshot('application-saved-only-readback.png')
  clearReadFault()
  const beforeRecovery = calls.length
  await click('[data-settings-canonical-read]')
  await until(
    async () => !(await exists('[data-settings-canonical-read]')) && (await ui()).font === 20,
    'fresh canonical read converges without resaving'
  )
  const recoveryReads = calls
    .slice(beforeRecovery)
    .filter((entry) => entry.channel === 'get-settings-snapshot')
  assert.equal(
    recoveryReads.length,
    1,
    'one explicit canonical-read action makes one raw getter request'
  )
  assert.equal(recoveryReads[0].status, 'returned')
  assert.equal(recoveryReads[0].result.values.css.fontSizeBase, 20)
  assert.deepEqual(audit(), committed)
  scenarios.push({
    phase,
    write,
    committedDml: committed,
    ui: await ui(),
    recoveryReads,
    broadcastsBeforeReadReply: settingsPublications.filter(
      (event) =>
        event.sequence > recoveryReads[0].sequence &&
        event.sequence < recoveryReads[0].finishedSequence
    )
  })
}

async function run() {
  let completed = false,
    failure = null,
    firstFailureCapture = null
  try {
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (win) => !win.isDestroyed() && win.webContents.getURL().endsWith('/index.html')
        ),
      'actual list BrowserWindow loaded'
    )
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    assert.equal(typeof hooks?.captureCoordinator, 'function')
    await until(
      () => current.isVisible() && !hooks.navigationState().pendingReady,
      'real initial renderer ready'
    )
    await until(() => hooks.nativeCaptureState().ready, 'real capture host prewarm ready')
    const dismissedShortcutNotice = await dismissStartupShortcutNotice(current)
    const startupModalPresent = await exists('[aria-label="快捷键启用提示"]')
    assert.equal(
      startupModalPresent,
      false,
      'real startup shortcut notice completed before settings interaction'
    )
    scenarios.push({
      phase: 'startup-shortcut-notice',
      dismissedShortcutNotice,
      startupModalPresent
    })
    await openPanel()
    await js(`(() => { window.__applicationEvents=[];
      window.__stopApplicationEvents=window.api.onSettingsApplicationChanged(value=>window.__applicationEvents.push(value)); })()`)
    installAudit()
    await waitForStartupSettingsSettlement()
    originalSettingsSend = current.webContents.send
    current.webContents.send = function (channel, ...args) {
      if (channel === 'settings:changed')
        settingsPublications.push({
          phase,
          sequence: ++sequence,
          snapshot: structuredClone(args[0])
        })
      return originalSettingsSend.call(this, channel, ...args)
    }
    installThemeObservation()
    await verifySavedFailureAndRetry()
    await verifyHeldRetryAndKeyboard()
    await verifySqlFailureStillBlocksLeave()
    await verifyReadingSurfaces()
    await verifySavedOnlyReadback()
    const publications = await js('window.__applicationEvents')
    assert.ok(publications.length > 0, 'real application metadata transport delivered events')
    const finalState = await state()
    for (const publication of publications) {
      assert.deepEqual(
        publication.source,
        finalState.source,
        'metadata publication retains the current document source'
      )
      assert.equal(Number.isSafeInteger(publication.ledgerRevision), true)
    }
    for (let index = 1; index < publications.length; index++)
      assert.ok(
        publications[index].ledgerRevision >= publications[index - 1].ledgerRevision,
        'application ledger publications do not move backwards'
      )
    scenarios.push({
      phase: 'final-application-state',
      state: finalState,
      publications,
      dml: audit()
    })
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
    try {
      firstFailureCapture = await captureFirstFailure(error)
    } catch (captureError) {
      firstFailureCapture = {
        error: captureError.stack || String(captureError),
        beforeGateReleaseAndRestore: true
      }
      console.error('First failure capture incomplete:', captureError)
    }
  } finally {
    heldTheme?.release.resolve()
    await lifecycle.finish({
      completed,
      error: failure,
      window: current,
      summary: {
        phase,
        scenarios,
        calls,
        themeCalls,
        screenshots,
        readFailures,
        inputActions,
        visualMetrics,
        settingsPublications,
        frameObservations,
        firstFailureCapture,
        finalScreenshotBoundary:
          'gui-final is the final lifecycle evidence after restoration; application-first-failure is captured before gate release/restore on failure'
      },
      restore: async () => {
        clearReadFault()
        if (capture && originalTheme) capture.syncTheme = originalTheme
        rejectFontWrites(false)
        removeAuditTriggers()
        ipcMain.handle = originalHandle
        if (current && !current.isDestroyed() && originalSettingsSend)
          current.webContents.send = originalSettingsSend
        if (current && !current.isDestroyed())
          await js(`(() => {
          window.__stopApplicationEvents?.();window.__stopApplicationKeyboard?.();document.getElementById('application-test-visual')?.remove();document.getElementById('application-paint-marker')?.remove();
          window.__cancelPageLeave?.('held-application-retry');window.__cancelPageLeave?.('rejected-sql');
          window.__cancelPageLeave?.('saved-only-application-can-leave');
        })()`)
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
    seed.exec(`CREATE TABLE app_settings(window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,
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
      ['main', 'css', 'font_size_base', '16']
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
  clearReadFault()
  ipcMain.handle = originalHandle
  void lifecycle.finish({ error })
}
