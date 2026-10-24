import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/settings-snapshot-ordering-electron.mjs',
  mode: 'electron-real-app-settings-snapshot-ordering-and-intents',
  prefix: 'abandon-settings-ordering-',
  destroyWindowsBeforeQuit: false,
  metadata: {
    realWindows: true,
    realRendererAndPreload: true,
    sqlite: 'real-disk',
    readOrdering: 'hold-original-handler-result-before-reply',
    writeOrdering: 'hold-original-committed-font-result-before-reply',
    failure: 'real-font-insert-and-update-SQLite-triggers',
    providerObservation: 'tagged-NoteCard-inline-note-text-color',
    source: 'same-URL-reload-then-old-token-high-revision-injection',
    timingBoundary: 'actual-300ms-debounce-and-recorded-causal-sequences-no-retry',
    viewModes: ['list'],
    osAutoStartModified: false,
    nativeBlurEnableVerified: false,
    mainProcessRestart: false
  }
})
const { assert, root } = lifecycle
const databasePath = join(root, 'app.db')
const fontSelector = '[data-diagnostic-action="settings.fontSizeBase"] input'
const timeline = [],
  scenarios = [],
  readReplies = [],
  writes = []
const activeGates = new Set()
const startedAt = Date.now()
const businessDeadline = startedAt + 75000
let current, readPlan, fontPlan, restoreSend, noteId
let phase = 'startup-old-read',
  sequence = 0,
  closing = false

function record(event, details = {}) {
  const entry = { sequence: ++sequence, time: Date.now(), phase, event, ...details }
  timeline.push(entry)
  return entry
}
function deferred() {
  let resolveGate
  const promise = new Promise((done) => {
    resolveGate = done
  })
  return { promise, resolve: resolveGate }
}
function armRead(outcome) {
  const plan = { outcome, release: deferred(), captured: [], finished: 0 }
  readPlan = plan
  activeGates.add(plan)
  return plan
}
function release(plan) {
  if (readPlan === plan) readPlan = null
  if (fontPlan === plan) fontPlan = null
  plan.release.resolve()
  activeGates.delete(plan)
}
function summary(snapshot) {
  return {
    source: snapshot?.source,
    revision: snapshot?.revision,
    font: snapshot?.values?.css?.fontSizeBase,
    tagColor: snapshot?.values?.notes?.tagColorEnabled
  }
}

// The production handlers still validate source, perform SQLite work and broadcast.
// Gates delay only their already-computed replies, never their actual business work.
const originalHandle = ipcMain.handle
ipcMain.handle = function (channel, listener) {
  if (!['get-settings-snapshot', 'set-setting-value'].includes(channel))
    return originalHandle.call(this, channel, listener)
  return originalHandle.call(this, channel, async (event, ...args) => {
    const plan = channel === 'get-settings-snapshot' ? readPlan : null
    const fontGate =
      channel === 'set-setting-value' &&
      args[0] === 'css.fontSizeBase' &&
      args[1] === fontPlan?.value
        ? fontPlan
        : null
    if (fontGate) fontPlan = null
    const entry = record('handler-start', { channel, id: args[0], value: args[1] })
    if (channel === 'set-setting-value') writes.push(entry)
    try {
      const result = await listener(event, ...args)
      entry.actual = record('handler-actual-complete', { channel, ...summary(result) }).sequence
      entry.result = summary(result)
      if (plan) {
        plan.captured.push(result)
        readReplies.push(entry)
        await plan.release.promise
        if (plan.outcome === 'error')
          throw new Error('injected completed initial snapshot reply failure')
      }
      if (fontGate) {
        fontGate.result = result
        fontGate.entry = entry
        fontGate.captured = true
        await fontGate.release.promise
      }
      entry.delivered = record('handler-reply', { channel, ...summary(result) }).sequence
      return result
    } catch (error) {
      entry.error = error.message
      entry.rejected = record('handler-rejected', { channel, error: error.message }).sequence
      throw error
    } finally {
      if (plan) plan.finished += 1
    }
  })
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
function js(code) {
  if (closing) return Promise.reject(new Error('Ordering suite is finishing'))
  return current.webContents.executeJavaScript(code)
}
async function until(predicate, label) {
  const deadline = Math.min(businessDeadline, Date.now() + 12000)
  while (!closing && Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await wait(20)
  }
  throw new Error(phase + ': ' + label)
}
function readFont() {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    return Number(
      db
        .prepare("SELECT value FROM app_settings WHERE window_name='main' AND key='font_size_base'")
        .get()?.value
    )
  } finally {
    db.close()
  }
}
function setSaveFailure(enabled) {
  const db = new Database(databasePath)
  try {
    db.exec(`DROP TRIGGER IF EXISTS ordering_reject_font_insert;
      DROP TRIGGER IF EXISTS ordering_reject_font_update;`)
    if (enabled)
      db.exec(`
      CREATE TRIGGER ordering_reject_font_insert BEFORE INSERT ON app_settings
      WHEN NEW.window_name='main' AND NEW.key='font_size_base'
      BEGIN SELECT RAISE(ABORT,'ordering fixture font save failed'); END;
      CREATE TRIGGER ordering_reject_font_update BEFORE UPDATE ON app_settings
      WHEN NEW.window_name='main' AND NEW.key='font_size_base'
      BEGIN SELECT RAISE(ABORT,'ordering fixture font save failed'); END;`)
  } finally {
    db.close()
  }
}
const exists = (selector) => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
const backendSnapshot = () => js('window.api.getSettingsSnapshot()')
const write = (id, value) =>
  js(`window.api.setSettingValue(${JSON.stringify(id)},${JSON.stringify(value)})`)
const cssFont = () =>
  js("getComputedStyle(document.documentElement).getPropertyValue('--font-size-base').trim()")
const formFont = () => js(`Number(document.querySelector(${JSON.stringify(fontSelector)})?.value)`)
const providerColor = () =>
  js(
    `document.querySelector('.nl-card[data-note-id="${noteId}"]')?.style.getPropertyValue('--note-text-color').trim()`
  )
async function rendered(font, colored) {
  const color = colored ? '#3478ab' : 'var(--text-color)'
  await until(
    async () => (await cssFont()) === `${font}rem` && (await providerColor()) === color,
    'CSS and the real NoteCard provider did not converge together'
  )
  assert.equal(await cssFont(), `${font}rem`)
  assert.equal(await providerColor(), color)
}
async function form(font) {
  await until(
    async () => (await formFont()) === font && (await cssFont()) === `${font}rem`,
    'font form and applied CSS did not preserve the latest local intent'
  )
  assert.equal(await formFont(), font)
  assert.equal(await cssFont(), `${font}rem`)
}
async function editFont(value) {
  await js(`(() => {
    const input=document.querySelector(${JSON.stringify(fontSelector)});
    input.value=${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  })()`)
  const accepted = await js(`({
    form:Number(document.querySelector(${JSON.stringify(fontSelector)})?.value),
    css:getComputedStyle(document.documentElement).getPropertyValue('--font-size-base').trim()
  })`)
  record('font-input-accepted', { requested: value, ...accepted })
  assert.equal(
    accepted.form,
    value,
    'real font control accepts the requested legal value before broadcasting'
  )
  assert.equal(accepted.css, `${value}rem`, 'accepted font model updates CSS before broadcasting')
}
async function recordFontInputRange() {
  await click('[data-diagnostic-action="settings.fontSizeBase"] .fsi-arrow-btn')
  await until(() => exists('.fsi-panel-wrap .fsi-option'), 'real font presets did not open')
  const bounds = await js(`(() => {
    const input=document.querySelector(${JSON.stringify(fontSelector)});
    return {
      inputType:input.type,minAttribute:input.getAttribute('min'),maxAttribute:input.getAttribute('max'),
      presets:[...document.querySelectorAll('.fsi-panel-wrap .fsi-option:not(:disabled)')]
        .map(option=>Number(option.lastElementChild.textContent.trim()))
    }
  })()`)
  record('real-list-font-input-range', bounds)
  assert.equal(bounds.inputType, 'text')
  assert.deepEqual(
    bounds.presets,
    [14, 15, 16, 17, 18, 19, 20, 21, 22],
    'actual list control exposes its 14–22 range before any queued edit begins'
  )
  await js(`document.querySelector(${JSON.stringify(fontSelector)}).dispatchEvent(
    new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await until(async () => !(await exists('.fsi-panel-wrap')), 'font preset panel did not close')
}
async function rendererTurn() {
  await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
}
async function observedBroadcast(snapshot, font, colored) {
  const observed = await until(
    () =>
      js(`globalThis.__orderingEvents.find(value=>
    value.source.token===${JSON.stringify(snapshot.source.token)}&&value.revision===${snapshot.revision})`),
    'real broadcast was not observed in its renderer event turn'
  )
  assert.equal(observed.css, `${font}rem`, 'CSS retains local intent in the broadcast event turn')
  assert.equal(observed.form, font, 'form retains local intent in the broadcast event turn')
  assert.equal(
    observed.color,
    colored ? '#3478ab' : 'var(--text-color)',
    'unrelated real provider update remains visible in that same event turn'
  )
  return observed
}

async function verifyInitialRead(plan, font, colored) {
  await until(() => plan.captured.length, 'real initial snapshot did not reach the reply gate')
  const held = plan.captured[0]
  assert.notEqual(
    held.values.css.fontSizeBase,
    font,
    'held reply contains the older persisted font'
  )
  assert.notEqual(
    held.values.notes.tagColorEnabled,
    colored,
    'held reply contains the older provider value'
  )
  const changedFont = await write('css.fontSizeBase', font)
  const changedProvider = await write('notes.tagColorEnabled', colored)
  assert.ok(
    changedProvider.revision > held.revision,
    'new broadcast is newer than held actual read'
  )
  await until(
    async () => (await cssFont()) === `${font}rem`,
    'new broadcast did not apply before the held read'
  )
  const beforeRelease = record('new-broadcast-before-held-read-release', summary(changedProvider))
  assert.equal(plan.finished, 0, 'initial read replies remain deterministically held')
  release(plan)
  await until(() => plan.finished === plan.captured.length, 'held read replies did not finish')
  await until(() => current.isVisible(), 'renderer-ready did not show the real main window')
  await rendered(font, colored)
  assert.equal(readFont(), font)
  scenarios.push({
    phase,
    held: summary(held),
    changedFont: summary(changedFont),
    newest: summary(changedProvider),
    beforeRelease: beforeRelease.sequence,
    outcome: plan.outcome,
    replies: plan.finished
  })
  return changedProvider
}

async function verifyPanelOrdering() {
  phase = 'panel-queued-and-held-reply'
  await click('.titlebar-btn-settings')
  await until(
    () => exists('.settings-panel.active ' + fontSelector),
    'real settings panel did not open'
  )
  await form(19)
  await recordFontInputRange()
  const gate = { value: 21, release: deferred(), captured: false }
  activeGates.add(gate)
  fontPlan = gate
  const beforeCount = writes.filter((entry) => entry.id === 'css.fontSizeBase').length
  await editFont(21)
  const queuedBroadcast = await write('notes.tagColorEnabled', true)
  const otherEntry = writes.findLast(
    (entry) => entry.phase === phase && entry.id === 'notes.tagColorEnabled' && entry.value === true
  )
  const queuedObservation = await observedBroadcast(queuedBroadcast, 21, true)
  await form(21)
  await until(() => gate.captured, 'real font write did not reach its post-commit reply gate')
  assert.ok(
    otherEntry.actual < gate.entry.sequence,
    'unrelated real broadcast must complete while the original 300ms font edit is still queued'
  )
  assert.equal(readFont(), 21, 'held setter has already performed its real SQL commit')
  await editFont(22)
  const inFlightBroadcast = await write('appearance.iconColor', 'white')
  const heldObservation = await observedBroadcast(inFlightBroadcast, 22, true)
  await form(22)
  assert.equal(readFont(), 21, 'newer same-ID intent waits for the older held reply')
  assert.equal(writes.filter((entry) => entry.id === 'css.fontSizeBase').length, beforeCount + 1)
  release(gate)
  await until(
    () => readFont() === 22,
    'latest same-ID edit did not persist after older reply release'
  )
  await until(
    () =>
      writes.findLast((entry) => entry.id === 'css.fontSizeBase' && entry.value === 22)?.delivered,
    'latest font reply did not return to the real queue'
  )
  await form(22)
  await rendererTurn()
  assert.equal((await backendSnapshot()).values.css.fontSizeBase, 22)
  assert.equal(
    writes.filter((entry) => entry.id === 'css.fontSizeBase').length,
    beforeCount + 2,
    'external snapshot assignments must not echo extra ordinary writes'
  )
  scenarios.push({
    phase,
    queuedBroadcast: summary(queuedBroadcast),
    inFlightBroadcast: summary(inFlightBroadcast),
    queuedObservation,
    heldObservation,
    heldSetter: gate.entry,
    finalSql: readFont()
  })

  phase = 'panel-failed-intent-and-retry'
  setSaveFailure(true)
  await editFont(18)
  await until(() => exists('.settings-save-error'), 'real SQLite failure did not expose retry UI')
  assert.equal(readFont(), 22, 'failed font save leaves the last committed SQL value intact')
  const failedBroadcast = await write('notes.tagColorEnabled', false)
  const failedObservation = await observedBroadcast(failedBroadcast, 18, false)
  await form(18)
  await until(
    async () => (await providerColor()) === 'var(--text-color)',
    'unrelated provider broadcast was lost'
  )
  assert.equal(readFont(), 22)
  setSaveFailure(false)
  await click('[data-settings-save-retry]')
  await until(
    async () => readFont() === 18 && !(await exists('.settings-save-error')),
    'explicit retry did not commit the retained font intent'
  )
  await form(18)
  assert.equal((await backendSnapshot()).values.css.fontSizeBase, 18)
  scenarios.push({
    phase,
    failedBroadcast: summary(failedBroadcast),
    failedObservation,
    finalSql: readFont()
  })
  await click('.panel-close-btn')
  await until(
    async () => !(await exists('.settings-panel')),
    'successful panel close did not unmount'
  )
}

async function finish(error = null) {
  if (closing) return
  closing = true
  clearTimeout(businessTimer)
  for (const gate of activeGates) release(gate)
  await lifecycle.finish({
    completed: !error,
    error,
    window: current,
    summary: {
      phase,
      startedAt,
      businessDeadline,
      scenarios,
      timeline,
      reads: readReplies,
      writes
    },
    restore: () => {
      setSaveFailure(false)
      ipcMain.handle = originalHandle
      restoreSend?.()
    }
  })
}
const businessTimer = setTimeout(
  () => void finish(new Error(phase + ': 75000ms business deadline exceeded')),
  75000
)

async function run() {
  try {
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
        ),
      'actual application main window did not load'
    )
    const originalSend = current.webContents.send
    current.webContents.send = function (channel, ...args) {
      if (channel === 'settings:changed') record('settings-broadcast', summary(args[0]))
      return originalSend.call(this, channel, ...args)
    }
    restoreSend = () => {
      if (!current.webContents.isDestroyed()) current.webContents.send = originalSend
    }
    await until(
      () => exists('.titlebar-btn-settings'),
      'real root did not mount before initial read completion'
    )
    const first = await verifyInitialRead(readPlan, 20, false)
    await write('notes.tagColorEnabled', true)
    await rendered(20, true)

    phase = 'same-url-reload-initial-read-error'
    const url = current.webContents.getURL()
    const failedInitial = armRead('error')
    current.webContents.reload()
    await until(() => failedInitial.captured.length, 'reload initial read did not reach the gate')
    assert.equal(current.webContents.getURL(), url)
    assert.notEqual(
      failedInitial.captured[0].source.token,
      first.source.token,
      'same-URL reload must issue a fresh document token'
    )
    const fresh = await verifyInitialRead(failedInitial, 19, false)

    phase = 'old-source-high-revision'
    await js(`globalThis.__orderingEvents=[];
      globalThis.__stopOrderingEvents=window.api.onSettingsChanged(value=>
        Promise.resolve().then(()=>globalThis.__orderingEvents.push({
          source:value.source,revision:value.revision,
          css:getComputedStyle(document.documentElement).getPropertyValue('--font-size-base').trim(),
          form:Number(document.querySelector(${JSON.stringify(fontSelector)})?.value),
          color:document.querySelector('.nl-card[data-note-id="${noteId}"]')?.style.getPropertyValue('--note-text-color').trim()
        }))); void 0`)
    const old = {
      ...first,
      revision: Number.MAX_SAFE_INTEGER,
      values: {
        ...first.values,
        css: { ...first.values.css, fontSizeBase: 14 },
        notes: { ...first.values.notes, tagColorEnabled: true }
      }
    }
    current.webContents.send('settings:changed', old)
    current.webContents.send('settings:changed', fresh)
    await until(
      () =>
        js(`globalThis.__orderingEvents.some(value=>
      value.source.token===${JSON.stringify(fresh.source.token)}&&value.revision===${fresh.revision})`),
      'current-source sentinel did not follow the injected obsolete broadcast'
    )
    const observed = await js('globalThis.__orderingEvents')
    assert.equal(
      observed.some((value) => value.source.token === first.source.token),
      false,
      'real preload subscription rejects the obsolete source despite its larger revision'
    )
    await rendererTurn()
    await rendered(19, false)
    scenarios.push({ phase, old: summary(old), sentinel: summary(fresh), observed })
    await verifyPanelOrdering()
    phase = 'native-disabled-config-canonical-reply'
    const requestedBlur = { enabled: false, radius: 15, saturation: 1.1, cornerRadius: 18 }
    const native = await js(`window.api.setBlurConfig(${JSON.stringify(requestedBlur)})`)
    assert.equal(native.success, true)
    assert.equal(native.runtime.effectiveEnabled, false, 'fixture never enables native glass')
    assert.deepEqual(
      native.snapshot.source,
      fresh.source,
      'nested native snapshot belongs to this document'
    )
    assert.deepEqual(native.snapshot.values.blur, requestedBlur)
    assert.deepEqual(
      native.snapshot.runtime.blur,
      native.runtime,
      'domain runtime retains its original shape'
    )
    await until(
      () => js("document.documentElement.style.getPropertyValue('--window-radius')==='18px'"),
      'real canonical native broadcast did not apply its corner radius to CSS'
    )
    scenarios.push({
      phase,
      requested: requestedBlur,
      snapshot: summary(native.snapshot),
      runtime: native.runtime
    })
    await js('void globalThis.__stopOrderingEvents()')
    await finish()
  } catch (error) {
    console.error(error)
    await finish(error)
  }
}

try {
  app.setPath('userData', root)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  const seed = new Database(databasePath)
  try {
    createDatabaseSchema(seed)
    const put = seed.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['application', 'system', 'z_order_mode', 'normal'],
      ['application', 'shortcuts', 'view_visibility', ''],
      ['application', 'shortcuts', 'screenshot', ''],
      ['application', 'shortcuts', 'screenshot_copy', ''],
      ['application', 'notes', 'tag_color_enabled', 'true'],
      ['application', 'weather', 'enabled', 'false'],
      ['application', 'almanac', 'almanac_enabled', 'false'],
      ['main', 'system', 'blur_enabled', 'false'],
      ['main', 'dock', 'dock_enabled_edges', '[]'],
      ['main', 'css', 'font_size_base', '16']
    ])
      put.run(...row)
    const now = Date.now()
    noteId = Number(
      seed
        .prepare(
          `INSERT INTO notes(content,status,effective_at,created_at,updated_at)
      VALUES('snapshot ordering provider fixture','in_progress',?,?,?)`
        )
        .run(now, now, now).lastInsertRowid
    )
    const tagId = seed
      .prepare("INSERT INTO tags(name,color,created_at) VALUES('ordering fixture','#3478ab',?)")
      .run(now).lastInsertRowid
    seed.prepare('INSERT INTO note_tags(note_id,tag_id) VALUES(?,?)').run(noteId, tagId)
  } finally {
    seed.close()
  }
  armRead('success')
  const require = createRequire(import.meta.url)
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'fresh built main chunk exists')
  require(resolve('out/main/chunks', chunk))
  app.once('ready', () => void run())
} catch (error) {
  console.error(error)
  void finish(error)
}
