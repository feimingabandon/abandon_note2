import { createRequire } from 'node:module'
import { readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/settings-snapshot-read-electron.mjs',
  mode: 'electron-real-app-read-only-settings-snapshot',
  prefix: 'abandon-settings-snapshot-read-',
  destroyWindowsBeforeQuit: false,
  metadata: {
    realWindows: true,
    realRendererAndPreload: true,
    sqlite: 'real-disk',
    readFailure: 'temporarily-rename-real-settings-table-and-restore-in-finally',
    canonicalObservation: 'integration-only-snapshot-without-refresh-before-public-getter',
    serviceObservation: 'real-capture-syncTheme-and-window-mutation-methods',
    compactResize: 'real-BrowserWindow-resize-and-production-300ms-save',
    ordinaryGeometryTimer: 'hold-compact-past-existing-500ms-debounce',
    osAutoStartModified: false,
    nativeBlurEnableVerified: false,
    mainProcessRestart: false
  }
})
const { assert, root } = lifecycle
const databasePath = join(root, 'app.db')
const unavailableTable = 'snapshot_read_unavailable'
const timeline = [],
  scenarios = [],
  reads = [],
  effects = [],
  publications = [],
  restorers = []
const originalHandle = ipcMain.handle
let current, hooks, capture, activeRead
let phase = 'startup',
  sequence = 0,
  closing = false,
  schemaUnavailable = false

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
function record(event, details = {}) {
  const entry = { sequence: ++sequence, at: Date.now(), phase, event, ...details }
  timeline.push(entry)
  return entry
}
function summary(snapshot) {
  return {
    source: snapshot?.source,
    revision: snapshot?.revision,
    font: snapshot?.values?.css?.fontSizeBase,
    geometry: snapshot?.values?.geometry,
    compactWidth: snapshot?.values?.window?.compactWidth,
    compactHeight: snapshot?.values?.window?.compactHeight
  }
}
function withDatabase(operation, { readonly = true } = {}) {
  const database = new Database(databasePath, { readonly, fileMustExist: true })
  try {
    return operation(database)
  } finally {
    database.close()
  }
}
const audit = () =>
  withDatabase((database) =>
    database.prepare('SELECT * FROM snapshot_read_dml ORDER BY sequence').all()
  )
const rows = () =>
  withDatabase((database) =>
    database.prepare('SELECT * FROM app_settings ORDER BY window_name,key').all()
  )
function schema() {
  return withDatabase((database) => ({
    columns: database.pragma('table_info(app_settings)'),
    foreignKeys: database.pragma('foreign_key_list(app_settings)'),
    indexes: database.pragma('index_list(app_settings)'),
    objects: database
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='app_settings' ORDER BY type,name"
      )
      .all()
  }))
}
function normalizedSchema(value) {
  return {
    ...value,
    // SQLite quotes this table identifier when rewriting ALTER TABLE metadata.
    // Keep raw before/after schemas in evidence and normalize only that quoting.
    objects: value.objects.map((object) => ({
      ...object,
      sql: object.sql?.replaceAll('"app_settings"', 'app_settings') ?? null
    }))
  }
}
function setFont(value) {
  const before = audit()
  withDatabase(
    (database) => {
      const result = database
        .prepare(
          "UPDATE app_settings SET value=? WHERE window_name='main' AND key='font_size_base'"
        )
        .run(String(value))
      assert.equal(result.changes, 1, 'fixture changes one existing real SQLite font row')
    },
    { readonly: false }
  )
  const fixtureDml = audit().slice(before.length)
  assert.equal(fixtureDml.length, 1, 'the external fixture has one separately recorded DML row')
  assert.equal(fixtureDml[0].window_name, 'main')
  assert.equal(fixtureDml[0].key, 'font_size_base')
  assert.equal(fixtureDml[0].new_value, String(value))
  record('fixture-font-committed', { value, fixtureDml })
}
function setSchemaUnavailable(unavailable) {
  if (schemaUnavailable === unavailable) return
  const sql = unavailable
    ? `ALTER TABLE app_settings RENAME TO ${unavailableTable}`
    : `ALTER TABLE ${unavailableTable} RENAME TO app_settings`
  const entry = record('real-sqlite-table-rename-start', { sql })
  try {
    withDatabase((database) => database.exec(sql), { readonly: false })
  } catch (error) {
    entry.error = error.stack || error.message
    record('real-sqlite-table-rename-failed', { sql, error: entry.error })
    throw error
  }
  schemaUnavailable = unavailable
  entry.completed = record(
    unavailable ? 'real-sqlite-read-fault-armed' : 'real-sqlite-table-restored',
    { sql }
  ).sequence
}
function js(code) {
  if (closing) throw new Error('Snapshot read suite is finishing')
  return current.webContents.executeJavaScript(code)
}
async function until(predicate, message) {
  const deadline = Date.now() + 12000
  while (!closing && Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(25)
  }
  throw new Error(phase + ': ' + message)
}
const publicSnapshot = () => js('window.api.getSettingsSnapshot()')
const applicationState = () => js('window.api.getSettingsApplicationState()')
const cssFont = () =>
  js("getComputedStyle(document.documentElement).getPropertyValue('--font-size-base').trim()")

// Observe the original handler, including its original authorization and SQLite failure.
// No handler result, source context, platform result or renderer ACK is substituted.
ipcMain.handle = function (channel, listener) {
  if (channel !== 'get-settings-snapshot') return originalHandle.call(this, channel, listener)
  return originalHandle.call(this, channel, (event, ...args) => {
    const entry = record('public-getter-start', { source: args[0] })
    reads.push(entry)
    const previous = activeRead
    activeRead = entry
    try {
      const result = listener(event, ...args)
      entry.result = summary(result)
      entry.completed = record('public-getter-return', entry.result).sequence
      return result
    } catch (error) {
      entry.error = error.message
      entry.failed = record('public-getter-rejected', { error: error.message }).sequence
      throw error
    } finally {
      activeRead = previous
    }
  })
}

function observeMethod(target, name, label) {
  const original = target[name]
  assert.equal(typeof original, 'function', label + ' is a real product method')
  target[name] = function (...args) {
    effects.push(record('product-action', { label, getter: activeRead?.sequence ?? null }))
    return original.apply(this, args)
  }
  restorers.push(() => {
    target[name] = original
  })
}
function observeProduct() {
  const originalSend = current.webContents.send
  current.webContents.send = function (channel, ...args) {
    if (['settings:changed', 'settings:application-changed'].includes(channel))
      publications.push(
        record('settings-publication', {
          channel,
          getter: activeRead?.sequence ?? null,
          ...(channel === 'settings:changed'
            ? summary(args[0])
            : { ledgerRevision: args[0]?.ledgerRevision })
        })
      )
    return originalSend.call(this, channel, ...args)
  }
  restorers.push(() => {
    if (!current.webContents.isDestroyed()) current.webContents.send = originalSend
  })
  observeMethod(capture, 'syncTheme', 'capture.syncTheme')
  for (const name of [
    'setMovable',
    'setAlwaysOnTop',
    'setBounds',
    'setPosition',
    'show',
    'hide',
    'focus'
  ])
    observeMethod(current, name, 'mainWindow.' + name)
}
async function settleStartup() {
  let last = '',
    quietSince = Date.now()
  await until(() => {
    const state = {
      dml: audit(),
      bounds: current.getBounds(),
      pending: hooks.settingsOperationState().pending,
      effects: effects.length,
      publications: publications.length
    }
    const serialized = JSON.stringify(state)
    if (serialized !== last || state.pending !== 0) {
      last = serialized
      quietSince = Date.now()
      record('startup-observation-changed', state)
    }
    return Date.now() - quietSince >= 700
  }, 'startup settings/geometry did not remain quiet beyond the existing debounce')
  record('startup-quiescent', { quietMs: Date.now() - quietSince })
}
async function readBoundary() {
  return {
    dml: audit(),
    ledger: await applicationState(),
    effects: effects.length,
    publications: publications.length,
    reads: reads.length,
    bounds: current.getBounds(),
    dockResources: hooks.dockCommands.resources(),
    capture: hooks.nativeCaptureState(),
    font: await cssFont()
  }
}
async function assertPureRead(before) {
  await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  assert.equal(reads.length, before.reads + 1, 'one action performs exactly one real public getter')
  assert.deepEqual(audit(), before.dml, 'the getter performs no app_settings DML')
  assert.deepEqual(await applicationState(), before.ledger, 'the getter does not mutate the ledger')
  assert.equal(
    effects.length,
    before.effects,
    'the getter invokes no observed service/window action'
  )
  assert.equal(publications.length, before.publications, 'the getter publishes no settings events')
  assert.deepEqual(
    current.getBounds(),
    before.bounds,
    'the getter does not move or resize the window'
  )
  assert.deepEqual(
    hooks.dockCommands.resources(),
    before.dockResources,
    'Dock resources stay owned'
  )
  assert.deepEqual(hooks.nativeCaptureState(), before.capture, 'capture runtime stays unchanged')
  assert.equal(await cssFont(), before.font, 'a raw read does not implicitly publish renderer CSS')
}

async function verifyFreshRead() {
  phase = 'fresh-sqlite-read-without-application'
  const cached = hooks.getResolvedSettingsSnapshot()
  setFont(19)
  assert.notEqual(cached.values.css.fontSizeBase, 19)
  const before = await readBoundary()
  const actual = await publicSnapshot()
  assert.equal(actual.values.css.fontSizeBase, 19, 'getter reads the external real SQLite change')
  assert.deepEqual(actual.source, cached.source, 'read retains the actual current document source')
  assert.ok(actual.revision > cached.revision, 'fresh canonical values advance their revision')
  await assertPureRead(before)
  const repeated = await readBoundary()
  const unchanged = await publicSnapshot()
  assert.equal(unchanged.revision, actual.revision, 'an unchanged read does not invent a revision')
  assert.deepEqual(unchanged.values, actual.values)
  await assertPureRead(repeated)
  scenarios.push({ phase, before: summary(cached), actual: summary(actual) })
}

async function verifySqliteFailureAndRecovery() {
  phase = 'real-sqlite-read-failure-and-recovery'
  const cached = hooks.getResolvedSettingsSnapshot()
  setFont(20)
  const preserved = rows()
  const schemaBefore = schema()
  const before = await readBoundary()
  setSchemaUnavailable(true)
  try {
    await assert.rejects(publicSnapshot(), /no such table: app_settings/i)
    assert.equal(reads.at(-1).error?.includes('no such table: app_settings'), true)
    assert.deepEqual(
      summary(hooks.getResolvedSettingsSnapshot()),
      summary(cached),
      'failed resolution does not publish partial values or a new revision'
    )
    assert.deepEqual(
      hooks.getResolvedSettingsSnapshot().values,
      cached.values,
      'every canonical field stays unchanged after the real SQLite read failure'
    )
    await assertPureRead(before)
  } finally {
    setSchemaUnavailable(false)
  }
  assert.deepEqual(rows(), preserved, 'restoring the real table retains every original setting row')
  const schemaAfter = schema()
  assert.deepEqual(normalizedSchema(schemaAfter), normalizedSchema(schemaBefore))
  assert.deepEqual(
    schemaAfter.objects.filter((object) => object.type === 'trigger').map((object) => object.name),
    ['snapshot_read_audit_delete', 'snapshot_read_audit_insert', 'snapshot_read_audit_update'],
    'all original DML audit triggers remain attached to app_settings after real recovery'
  )
  const recovering = await readBoundary()
  const recovered = await publicSnapshot()
  assert.equal(
    recovered.values.css.fontSizeBase,
    20,
    'recovery reads the actual unconsumed SQL value'
  )
  assert.ok(recovered.revision > cached.revision)
  await assertPureRead(recovering)
  assert.equal(
    withDatabase((database) => database.pragma('integrity_check', { simple: true })),
    'ok'
  )
  scenarios.push({
    phase,
    failed: reads.at(-2),
    recovered: summary(recovered),
    schemaBefore,
    schemaAfter
  })
}

function storedGeometry() {
  return withDatabase((database) =>
    Object.fromEntries(
      database
        .prepare("SELECT key,value FROM app_settings WHERE window_name='main' AND type='geometry'")
        .all()
        .map(({ key, value }) => [key, Number(value)])
    )
  )
}
function geometry(bounds) {
  return { posX: bounds.x, posY: bounds.y, width: bounds.width, height: bounds.height }
}
const geometryDml = (entries) =>
  entries.filter(
    (row) => row.window_name === 'main' && ['pos_x', 'pos_y', 'width', 'height'].includes(row.key)
  )
async function verifyCompactCanonical() {
  phase = 'compact-geometry-canonical-without-public-getter'
  const publicReads = reads.length
  const cached = hooks.getResolvedSettingsSnapshot()
  const originalHandle = current.getNativeWindowHandle().toString('hex')
  const workArea = screen.getDisplayMatching(current.getBounds()).workArea
  const expanded = {
    x: workArea.x + 40,
    y: workArea.y + 40,
    width: Math.min(workArea.width - 80, Math.max(300, current.getBounds().width + 17)),
    height: Math.min(workArea.height - 80, Math.max(300, current.getBounds().height + 19))
  }
  const before = audit().length
  current.setBounds(expanded, false)
  const actualExpanded = current.getBounds()
  assert.notDeepEqual(geometry(actualExpanded), {
    posX: cached.values.geometry.posX,
    posY: cached.values.geometry.posY,
    width: cached.values.geometry.width,
    height: cached.values.geometry.height
  })
  await hooks.enterCompactPresentation({
    x: actualExpanded.x + Math.round(actualExpanded.width / 2),
    y: actualExpanded.y + 24
  })
  assert.equal(hooks.getPresentationModeState().mode, 'compact')
  assert.equal(
    hooks.getPresentationModeState().operation,
    null,
    'real compact renderer ACK settled'
  )
  assert.equal(await js("Boolean(document.querySelector('.compact-island'))"), true)
  const canonical = hooks.getResolvedSettingsSnapshot()
  for (const [key, value] of Object.entries(geometry(actualExpanded)))
    assert.equal(canonical.values.geometry[key], value, 'compact commit resolves canonical ' + key)
  assert.ok(canonical.revision > cached.revision)
  assert.deepEqual(storedGeometry(), {
    pos_x: actualExpanded.x,
    pos_y: actualExpanded.y,
    width: actualExpanded.width,
    height: actualExpanded.height
  })
  const committed = geometryDml(audit().slice(before))
  assert.equal(committed.length, 4, 'compact entry commits one complete expanded geometry batch')
  // A pre-existing ordinary timer is suppressed while compact/busy. This checks
  // that actual interval, without claiming cancellation or a rapid-roundtrip bug.
  await wait(700)
  assert.deepEqual(geometryDml(audit().slice(before)), committed)
  assert.equal(reads.length, publicReads, 'no public getter rescued the compact geometry cache')

  const resized = { ...current.getBounds(), width: 256, height: 64 }
  current.setBounds(resized, false)
  await until(() => {
    const snapshot = hooks.getResolvedSettingsSnapshot()
    return (
      snapshot.values.window.compactWidth === resized.width &&
      snapshot.values.window.compactHeight === resized.height &&
      hooks.settingsOperationState().pending === 0
    )
  }, 'real compact resize did not refresh canonical values through its own commit owner')
  const compactRows = withDatabase((database) =>
    database
      .prepare(
        "SELECT key,value FROM app_settings WHERE window_name='application' AND key IN ('compact_width','compact_height') ORDER BY key"
      )
      .all()
  )
  assert.deepEqual(compactRows, [
    { key: 'compact_height', value: '64' },
    { key: 'compact_width', value: '256' }
  ])
  assert.equal(reads.length, publicReads, 'compact size persistence also needs no public getter')
  await hooks.exitCompactPresentation()
  assert.equal(hooks.getPresentationModeState().mode, 'expanded')
  assert.equal(hooks.getPresentationModeState().operation, null)
  assert.deepEqual(current.getBounds(), actualExpanded)
  assert.equal(current.getNativeWindowHandle().toString('hex'), originalHandle)
  assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 0)
  scenarios.push({ phase, cached: summary(cached), canonical: summary(canonical), compactRows })
}

async function finish(error = null) {
  if (closing) return
  closing = true
  clearTimeout(businessTimer)
  if (error) {
    console.error(error)
    try {
      writeFileSync(
        join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, 'snapshot-read-first-failure.json'),
        JSON.stringify({ phase, error: error.stack, schemaUnavailable, timeline, reads }, null, 2),
        { flag: 'wx' }
      )
    } catch (diagnosticError) {
      console.error(diagnosticError)
    }
  }
  await lifecycle.finish({
    completed: !error,
    error,
    window: current,
    summary: { phase, scenarios, reads, effects, publications, timeline },
    restore: () => {
      setSchemaUnavailable(false)
      for (const restore of restorers.reverse()) restore()
      ipcMain.handle = originalHandle
    }
  })
}

// Route the business deadline through this suite's schema restoration before
// the lifecycle helper's independent final evidence/shutdown watchdog can fire.
const businessTimer = setTimeout(
  () => void finish(new Error(phase + ': 75000ms business deadline exceeded')),
  75000
)

async function run() {
  try {
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    assert.equal(typeof hooks?.getResolvedSettingsSnapshot, 'function')
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
        ),
      'actual list document did not load'
    )
    await until(() => {
      const navigation = hooks.navigationState()
      return (
        navigation.initialization?.state === 'succeeded' &&
        navigation.initialization.phase === 'ready' &&
        navigation.pendingReady === null &&
        current.isVisible()
      )
    }, 'production renderer-ready did not complete initial presentation')
    await until(
      () => js("Boolean(document.querySelector('.app-titlebar'))"),
      'actual list root did not mount'
    )
    await until(
      () => hooks.nativeCaptureState().ready,
      'real capture theme host did not become ready'
    )
    await dismissStartupShortcutNotice(current)
    capture = hooks.captureCoordinator()
    observeProduct()
    await settleStartup()
    await verifyFreshRead()
    await verifySqliteFailureAndRecovery()
    await verifyCompactCanonical()
    await finish()
  } catch (error) {
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
      ['application', 'weather', 'enabled', 'false'],
      ['application', 'almanac', 'almanac_enabled', 'false'],
      ['main', 'system', 'blur_enabled', 'false'],
      ['main', 'dock', 'dock_enabled_edges', '[]'],
      ['main', 'css', 'font_size_base', '16']
    ])
      put.run(...row)
    seed.exec(`CREATE TABLE snapshot_read_dml (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL,
      window_name TEXT NOT NULL, key TEXT NOT NULL, old_value TEXT, new_value TEXT);
      CREATE TRIGGER snapshot_read_audit_insert AFTER INSERT ON app_settings BEGIN
        INSERT INTO snapshot_read_dml(operation,window_name,key,new_value)
        VALUES('INSERT',NEW.window_name,NEW.key,NEW.value); END;
      CREATE TRIGGER snapshot_read_audit_update AFTER UPDATE ON app_settings BEGIN
        INSERT INTO snapshot_read_dml(operation,window_name,key,old_value,new_value)
        VALUES('UPDATE',NEW.window_name,NEW.key,OLD.value,NEW.value); END;
      CREATE TRIGGER snapshot_read_audit_delete AFTER DELETE ON app_settings BEGIN
        INSERT INTO snapshot_read_dml(operation,window_name,key,old_value)
        VALUES('DELETE',OLD.window_name,OLD.key,OLD.value); END;`)
  } finally {
    seed.close()
  }
  app.once('ready', () => void run())
  const require = createRequire(import.meta.url)
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'fresh built main chunk exists')
  require(resolve('out/main/chunks', chunk))
} catch (error) {
  void finish(error)
}
