import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, nativeImage, screen } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createFailureDiagnostics } from '../scripts/test-failure-diagnostics.cjs'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const suite = 'tests/settings-operation-quit-electron.mjs'
const script = fileURLToPath(import.meta.url)
const childKind = process.env.ABANDON_OPERATION_QUIT_CHILD
const childCase = process.env.ABANDON_OPERATION_QUIT_CASE
const controllerProfile = childKind
  ? null
  : prepareTestProfile({ prefix: 'abandon-operation-quit-' })
if (controllerProfile) {
  const userData = join(controllerProfile.directory, 'controller-user-data')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
}
const failureMarker = 'settings-operation-quit-child-failed\n'
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase()

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
function ownedPath(root, child) {
  const target = resolve(root, child)
  const suffix = relative(resolve(root), target)
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + sep))
    throw new Error('Evidence or wallpaper path escapes its owned directory')
  return target
}
function storageSnapshot(profile) {
  const database = new Database(join(profile, 'app.db'), { readonly: true, fileMustExist: true })
  let rows
  try {
    rows = {
      integrity: database.pragma('integrity_check', { simple: true }),
      sources: database.prepare('SELECT * FROM wallpaper_sources ORDER BY id').all(),
      wallpapers: database.prepare('SELECT * FROM wallpapers ORDER BY id').all()
    }
  } finally {
    database.close()
  }
  const wallpaperRoot = join(profile, 'wallpapers')
  const files = []
  const visit = (directory) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = ownedPath(wallpaperRoot, relative(wallpaperRoot, join(directory, entry.name)))
      if (entry.isSymbolicLink()) throw new Error('Unexpected link in isolated wallpaper storage')
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        const bytes = readFileSync(path)
        files.push({ path: relative(profile, path), size: bytes.length, sha256: sha256(bytes) })
      }
    }
  }
  visit(wallpaperRoot)
  const staging = join(wallpaperRoot, '.staging')
  return {
    ...rows,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    staging: existsSync(staging) ? readdirSync(staging).sort() : []
  }
}
function shutdownSessions(profile) {
  const logs = join(profile, 'logs')
  if (!existsSync(logs)) return []
  return readdirSync(logs)
    .filter((file) => /^app-.*\.jsonl$/.test(file))
    .sort()
    .flatMap((file) =>
      readFileSync(join(logs, file), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
    .filter((entry) => entry.scope === 'lifecycle.shutdown-complete')
}
function assertStorage(assert, snapshot, name, payload, { stagingEmpty = true } = {}) {
  assert.equal(snapshot.integrity, 'ok')
  if (stagingEmpty)
    assert.deepEqual(snapshot.staging, [], 'no unfinished wallpaper staging operation')
  const count = name === 'save' ? 1 : 0
  assert.equal(snapshot.sources.length, count, 'source row matches transaction outcome')
  assert.equal(snapshot.wallpapers.length, count, 'wallpaper row matches transaction outcome')
  const finalFiles = snapshot.files.filter((file) => !file.path.includes('.staging' + sep))
  if (name === 'rollback') {
    assert.deepEqual(finalFiles, [], 'rollback removed both promoted files without orphaning data')
    if (stagingEmpty) assert.deepEqual(snapshot.files, [])
    return
  }
  const source = snapshot.sources[0]
  const wallpaper = snapshot.wallpapers[0]
  assert.equal(wallpaper.source_id, source.id)
  assert.equal(source.content_hash, sha256(Buffer.from(payload.original.base64, 'base64')))
  assert.equal(source.width, 2)
  assert.equal(source.height, 2)
  assert.equal(wallpaper.target_width, 2)
  assert.equal(wallpaper.target_height, 2)
  assert.deepEqual(
    finalFiles.map((file) => file.path).sort(),
    [source.original_path, wallpaper.cropped_path].sort(),
    'exactly the two committed files exist'
  )
  for (const [path, encoded] of [
    [source.original_path, payload.original.base64],
    [wallpaper.cropped_path, payload.cropped.base64]
  ]) {
    const expected = Buffer.from(encoded, 'base64')
    const actual = finalFiles.find((file) => file.path === path)
    assert.equal(actual?.sha256, sha256(expected), 'stored bytes retain the submitted image hash')
    assert.equal(actual.size, expected.length)
  }
}
function payloadForCase(name) {
  const bitmap =
    name === 'save'
      ? [255, 80, 60, 255, 60, 180, 255, 255, 80, 220, 120, 255, 245, 210, 70, 255]
      : [40, 90, 230, 255, 100, 220, 80, 255, 200, 130, 60, 255, 70, 180, 220, 255]
  const png = nativeImage
    .createFromBitmap(Buffer.from(bitmap), { width: 2, height: 2, scaleFactor: 1 })
    .toPNG()
    .toString('base64')
  return {
    original: { base64: png, ext: 'png' },
    cropped: { base64: png, ext: 'png' },
    crop: { x: 0, y: 0, width: 2, height: 2, scale: 1 }
  }
}
function seed(profile, name) {
  mkdirSync(profile, { recursive: true })
  const database = new Database(join(profile, 'app.db'))
  try {
    createDatabaseSchema(database)
    const insert = database.prepare(`INSERT INTO app_settings
      (window_name,type,key,value,remark,created_at,updated_at) VALUES(?,?,?,?,'',?,?)`)
    const now = Date.now()
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['application', 'system', 'z_order_mode', 'normal'],
      ...['main', 'month', 'week'].flatMap((scope) => [
        [scope, 'system', 'blur_enabled', 'false'],
        [scope, 'dock', 'dock_enabled_edges', '[]']
      ])
    ])
      insert.run(...row, now, now)
    if (name === 'rollback')
      database.exec(`CREATE TRIGGER operation_quit_reject_wallpaper
      BEFORE INSERT ON wallpapers BEGIN
      SELECT RAISE(ABORT,'injected operation quit wallpaper rollback'); END;`)
  } finally {
    database.close()
  }
}

const postcommitCases = new Set(['generic-postcommit', 'geometry-postcommit'])

function seedPostcommit(profile, name) {
  seed(profile, name)
  const database = new Database(join(profile, 'app.db'))
  try {
    const insert = database.prepare(`INSERT INTO app_settings
      (window_name,type,key,value,remark,created_at,updated_at) VALUES(?,?,?,?,'',?,?)`)
    const now = Date.now()
    for (const [index, scope] of ['main', 'month', 'week'].entries()) {
      for (const row of [
        [scope, 'css', 'font_size_base', String(17 + index * 2)],
        [scope, 'geometry', 'pos_x', String(120 + index * 20)],
        [scope, 'geometry', 'pos_y', String(110 + index * 20)],
        [scope, 'geometry', 'width', String(640 + index * 20)],
        [scope, 'geometry', 'height', String(560 + index * 20)]
      ])
        insert.run(...row, now, now)
    }
    database.exec(`
      CREATE TABLE operation_quit_setting_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        window_name TEXT NOT NULL,
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT
      );
      CREATE TRIGGER operation_quit_setting_insert AFTER INSERT ON app_settings BEGIN
        INSERT INTO operation_quit_setting_audit(operation,window_name,type,key,value)
        VALUES('INSERT',NEW.window_name,NEW.type,NEW.key,NEW.value);
      END;
      CREATE TRIGGER operation_quit_setting_update AFTER UPDATE ON app_settings BEGIN
        INSERT INTO operation_quit_setting_audit(operation,window_name,type,key,value)
        VALUES('UPDATE',NEW.window_name,NEW.type,NEW.key,NEW.value);
      END;
      CREATE TRIGGER operation_quit_setting_delete AFTER DELETE ON app_settings BEGIN
        INSERT INTO operation_quit_setting_audit(operation,window_name,type,key,value)
        VALUES('DELETE',OLD.window_name,OLD.type,OLD.key,OLD.value);
      END;
    `)
  } finally {
    database.close()
  }
}

function settingsStorageSnapshot(profile, prepare = Database.prototype.prepare) {
  // A second read-only connection sees committed DML only. Using the original
  // prepare keeps this probe separate from the observed production connection.
  const database = new Database(join(profile, 'app.db'), { readonly: true, fileMustExist: true })
  const query = (sql) => Reflect.apply(prepare, database, [sql]).all()
  try {
    return {
      integrity: database.pragma('integrity_check', { simple: true }),
      rows: query(`SELECT window_name,type,key,value,remark,created_at,updated_at
        FROM app_settings ORDER BY window_name,key`),
      audit: query('SELECT * FROM operation_quit_setting_audit ORDER BY sequence')
    }
  } finally {
    database.close()
  }
}

function assertPostcommitSettings(assert, observed, baseline, expected) {
  assert.equal(observed.integrity, 'ok')
  const baselineSequence = baseline.audit.at(-1)?.sequence || 0
  const changes = observed.audit.filter((entry) => entry.sequence > baselineSequence)
  assert.equal(changes.length, expected.length, 'each target SQL DML occurs exactly once')
  assert.deepEqual(
    changes
      .map(({ window_name, type, key, value }) => ({ window_name, type, key, value }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    expected
      .map((entry) => ({ window_name: 'main', ...entry }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    'only the exact current-view target values were committed'
  )
  for (const change of changes)
    assert.ok(['INSERT', 'UPDATE'].includes(change.operation), 'the target was saved, not deleted')
  assert.deepEqual(
    observed.rows.filter((row) => row.window_name !== 'main'),
    baseline.rows.filter((row) => row.window_name !== 'main'),
    'application, month and week scopes remain unchanged'
  )
  const targetKeys = new Set(expected.map((entry) => entry.key))
  assert.deepEqual(
    observed.rows.filter((row) => row.window_name === 'main' && !targetKeys.has(row.key)),
    baseline.rows.filter((row) => row.window_name === 'main' && !targetKeys.has(row.key)),
    'unrelated current-view settings remain unchanged'
  )
  for (const entry of expected)
    assert.equal(
      observed.rows.find((row) => row.window_name === 'main' && row.key === entry.key)?.value,
      entry.value,
      entry.key + ' retains the committed value'
    )
}

async function child() {
  const profile = process.env.ABANDON_OPERATION_QUIT_PROFILE
  const evidence = process.env.ABANDON_OPERATION_QUIT_EVIDENCE
  const payload = JSON.parse(readFileSync(process.env.ABANDON_OPERATION_QUIT_PAYLOAD, 'utf8'))
  const recorder = createAssertionRecorder({
    suite,
    mode: 'real-app-' + childKind + '-' + childCase,
    metadata: { actualProcessPid: process.pid, reseeded: false },
    env: {}
  })
  const { assert } = recorder
  const require = createRequire(import.meta.url)
  const promises = require('node:fs/promises')
  const rmDescriptor = Object.getOwnPropertyDescriptor(promises, 'rm')
  const prepareDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'prepare')
  const closeDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'close')
  const originalHandle = ipcMain.handle
  const databasePath = join(profile, 'app.db')
  const stagingRoot = join(profile, 'wallpapers', '.staging')
  const trace = {
    kind: childKind,
    case: childCase,
    pid: process.pid,
    events: [],
    firstFailure: null,
    rmHeldCount: 0,
    quitClicks: 0,
    navigations: [],
    filesystemRestored: false,
    descriptorsRestored: false,
    willQuitVerified: false,
    operation: null,
    held: null,
    finalStorage: null
  }
  let eventSequence = 0
  let appDatabase, current, hooks, gateDirectory, gateManifest
  let armed = false
  let readyToQuit = false
  let willQuitAttempted = false
  let failed = false
  let hookError = null
  let releaseGate
  const gate = new Promise((done) => {
    releaseGate = done
  })
  const record = (event, details = {}) => {
    const entry = {
      sequence: ++eventSequence,
      event,
      at: Date.now(),
      pid: process.pid,
      suite,
      ...details
    }
    trace.events.push(entry)
    appendFileSync(join(evidence, 'gui-exit-events.jsonl'), JSON.stringify(entry) + '\n')
    return entry
  }
  const restoreFilesystem = () => {
    if (trace.filesystemRestored) return
    Object.defineProperty(promises, 'rm', rmDescriptor)
    syncBuiltinESMExports()
    trace.filesystemRestored = true
  }
  const restore = () => {
    if (trace.descriptorsRestored) return
    restoreFilesystem()
    Object.defineProperty(Database.prototype, 'prepare', prepareDescriptor)
    Object.defineProperty(Database.prototype, 'close', closeDescriptor)
    ipcMain.handle = originalHandle
    trace.descriptorsRestored = true
  }
  const fail = (error) => {
    process.exitCode = 1
    if (failed) return
    failed = true
    trace.firstFailure = error.stack || String(error)
    clearTimeout(watchdog)
    restore()
    try {
      record('child-failed', { error: error.message || String(error) })
      writeJson(join(evidence, 'child-first-failure.json'), trace)
    } catch (evidenceError) {
      process.stderr.write((evidenceError.stack || String(evidenceError)) + '\n')
    }
    process.stderr.write(trace.firstFailure + '\n')
    // The controller captures Windows evidence before any forced termination. Do not
    // release the observed failure state, destroy a window, or exit from this child.
    process.stdout.write(failureMarker)
  }
  const watchdog = setTimeout(
    () => fail(new Error('Child business deadline exceeded 35 seconds')),
    35000
  )
  async function bounded(promise, label, timeoutMs = 12000) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function until(predicate, label) {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      if (hookError) throw hookError
      if (failed) throw new Error('Child already failed')
      const result = await bounded(Promise.resolve().then(predicate), label)
      if (result) return result
      await wait(20)
    }
    throw new Error(label)
  }
  const js = (source) =>
    bounded(current.webContents.executeJavaScript(source), 'Renderer query timed out')
  const isAppDatabase = (candidate) => candidate.name && samePath(candidate.name, databasePath)
  Object.defineProperty(Database.prototype, 'prepare', {
    ...prepareDescriptor,
    value: function (...args) {
      const statement = Reflect.apply(prepareDescriptor.value, this, args)
      if (isAppDatabase(this) && !appDatabase) {
        appDatabase = this
        record('production-database-observed')
      }
      return statement
    }
  })
  Object.defineProperty(Database.prototype, 'close', {
    ...closeDescriptor,
    value: function (...args) {
      const observed = this === appDatabase
      if (observed) record('production-database-close-start', { open: this.open })
      const result = Reflect.apply(closeDescriptor.value, this, args)
      if (observed) record('production-database-close-complete', { open: this.open })
      return result
    }
  })
  ipcMain.handle = function (channel, listener) {
    if (channel !== 'wallpapers:save') return originalHandle.call(this, channel, listener)
    return originalHandle.call(this, channel, (event, ...args) => {
      const result = listener(event, ...args)
      trace.operation = {
        sourceScope: args[1]?.scope,
        ledgerAtAdmission: hooks.settingsOperationState(),
        returnedPromise: Boolean(result?.then)
      }
      record('wallpaper-handler-admitted', trace.operation)
      return Promise.resolve(result).then(
        (value) => {
          trace.operation.status = 'saved'
          trace.operation.result = value
          record('wallpaper-handler-returned', { status: 'saved' })
          return value
        },
        (error) => {
          trace.operation.status = 'rejected'
          trace.operation.error = error.message
          record('wallpaper-handler-returned', { status: 'rejected', error: error.message })
          throw error
        }
      )
    })
  }
  Object.defineProperty(promises, 'rm', {
    ...rmDescriptor,
    value: async function (directory, options) {
      const path = resolve(String(directory))
      if (
        armed &&
        samePath(dirname(path), stagingRoot) &&
        /^save-[\da-f-]{36}$/i.test(basename(path))
      ) {
        armed = false
        try {
          const manifest = JSON.parse(readFileSync(join(path, 'operation.json'), 'utf8'))
          const expectedOriginal = join(
            profile,
            'wallpapers',
            'originals',
            sha256(Buffer.from(payload.original.base64, 'base64')) + '.png'
          )
          if (
            manifest.version !== 1 ||
            manifest.type !== 'save' ||
            !samePath(ownedPath(profile, manifest.originalPath), expectedOriginal) ||
            !samePath(
              dirname(ownedPath(profile, manifest.cropPath)),
              join(profile, 'wallpapers', 'crops')
            ) ||
            options?.recursive !== true ||
            options?.force !== true
          )
            throw new Error('The save cleanup did not match this exact profile/payload operation')
          gateDirectory = path
          gateManifest = manifest
          trace.rmHeldCount += 1
          record('original-rm-held', { directory: path, manifest, options })
          await gate
          record('original-rm-start', { directory: path })
          const result = await Reflect.apply(rmDescriptor.value, this, [directory, options])
          record('original-rm-complete', { directory: path, exists: existsSync(path) })
          return result
        } catch (error) {
          hookError = error
          throw error
        }
      }
      return Reflect.apply(rmDescriptor.value, this, [directory, options])
    }
  })
  syncBuiltinESMExports()
  app.on('will-quit', () => {
    if (willQuitAttempted) return
    willQuitAttempted = true
    try {
      record('will-quit')
      if (failed) return
      assert.equal(readyToQuit, true)
      assert.equal(trace.quitClicks, 1, 'one production tray quit intent completed')
      assert.deepEqual(trace.navigations, [], 'direct quit did not navigate')
      const shutdown = hooks.shutdownState()
      assert.equal(shutdown.completed, true)
      assert.equal(shutdown.trigger, 'tray-menu')
      for (const [name, stage] of Object.entries(shutdown.stages))
        assert.notEqual(stage.status, 'failed', name + ' shutdown stage failed')
      for (const name of ['settings-operations', 'database', 'tray'])
        assert.equal(shutdown.stages[name]?.status, 'complete')
      assert.equal(hooks.settingsOperationState().pending, 0)
      assert.equal(appDatabase.open, false)
      assert.equal(current.isDestroyed(), true)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      if (childKind === 'write') {
        assert.equal(trace.rmHeldCount, 1)
        assert.equal(trace.operation?.status, childCase === 'save' ? 'saved' : 'rejected')
        if (childCase === 'rollback')
          assert.match(trace.operation.error, /injected operation quit wallpaper rollback/)
        assert.equal(existsSync(gateDirectory), false)
      }
      trace.finalStorage = storageSnapshot(profile)
      assertStorage(assert, trace.finalStorage, childCase, payload)
      trace.shutdown = shutdown
      trace.willQuitVerified = true
    } catch (error) {
      fail(error)
    } finally {
      restore()
    }
  })
  app.once('quit', (_event, code) => {
    clearTimeout(watchdog)
    restore()
    try {
      record('quit', { code })
      assert.equal(code, 0)
      assert.equal(failed, false)
      assert.equal(trace.willQuitVerified, true)
      assert.equal(trace.descriptorsRestored, true)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
    } catch (error) {
      fail(error)
    }
    try {
      writeJson(join(evidence, 'child-trace.json'), trace)
      const result = recorder.finish({
        completed: !failed && trace.willQuitVerified && code === 0,
        error: trace.firstFailure || undefined,
        evidence: { status: 'complete' },
        cleanup: {
          status: failed ? 'failed' : 'complete',
          exitCode: code,
          descriptorsRestored: trace.descriptorsRestored,
          windowsClosed: BrowserWindow.getAllWindows().length === 0
        }
      })
      writeJson(join(evidence, 'child-result.json'), result)
    } catch (error) {
      fail(error)
    }
  })
  function trayQuit() {
    const item = hooks.getTrayMenuTemplate().find((entry) => entry.label === '退出应用')
    assert.equal(typeof item?.click, 'function')
    trace.quitClicks += 1
    record('finish-start', { completed: false, ownedProductQuit: true })
    record('tray-quit-click')
    item.click()
  }
  try {
    app.setPath('userData', profile)
    process.env.ABANDON_INTEGRATION_TEST = '1'
    process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
    process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
    require(resolve('out/main/index.js'))
    const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
      /^index-[\w-]+\.js$/.test(name)
    )
    assert.ok(chunk, 'built main chunk exists')
    require(resolve('out/main/chunks', chunk))
    await until(() => {
      current = BrowserWindow.getAllWindows().find(
        (window) => !window.isDestroyed() && window.webContents.getURL().endsWith('/index.html')
      )
      hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
      return current?.isVisible() && hooks?.nativeCaptureState().ready
    }, 'Real app and native capture prerequisite did not become ready')
    assert.equal(typeof hooks.settingsOperationState, 'function')
    assert.equal(appDatabase?.open, true)
    await until(
      () => js("Boolean(document.querySelector('.app-titlebar'))"),
      'Real renderer titlebar ready'
    )
    current.webContents.on('did-navigate', (_event, url) => trace.navigations.push(url))
    trace.initialWindow = { id: current.id, hwnd: current.getNativeWindowHandle().toString('hex') }
    if (childKind === 'verify') {
      trace.reopenedLibrary = await js('window.api.listWallpapers()')
      assert.equal(trace.reopenedLibrary.length, childCase === 'save' ? 1 : 0)
      assertStorage(assert, storageSnapshot(profile), childCase, payload)
      readyToQuit = true
      trayQuit()
      return
    }
    assert.equal(hooks.settingsOperationState().pending, 0)
    assert.deepEqual(storageSnapshot(profile).wallpapers, [])
    armed = true
    await js(`(() => {
      window.__operationQuitSave = {status:'pending'};
      void window.api.saveWallpaper(${JSON.stringify(payload)}).then(
        result => {window.__operationQuitSave = {status:'saved',result}},
        error => {window.__operationQuitSave = {status:'rejected',error:error.message}});
    })()`)
    await until(
      () => trace.rmHeldCount === 1,
      'Actual wallpaper staging cleanup did not reach the exact rm gate'
    )
    assert.equal(trace.operation.returnedPromise, true)
    assert.equal(trace.operation.sourceScope, 'main')
    assert.equal(trace.operation.ledgerAtAdmission.pending, 1)
    assert.equal(hooks.settingsOperationState().pending, 1)
    assert.equal(hooks.backgroundSettingsState().pendingRequests, 1)
    trace.beforeQuit = storageSnapshot(profile)
    assertStorage(assert, trace.beforeQuit, childCase, payload, { stagingEmpty: false })
    assert.deepEqual(trace.beforeQuit.staging, [basename(gateDirectory)])
    trayQuit()
    await until(
      () => hooks.settingsOperationState().sealed,
      'Direct quit did not seal the full settings operation'
    )
    trace.held = {
      ledger: hooks.settingsOperationState(),
      shutdown: hooks.shutdownState(),
      databaseOpen: appDatabase.open,
      visible: current.isVisible(),
      destroyed: current.isDestroyed(),
      url: current.webContents.getURL(),
      manifest: gateManifest,
      storage: storageSnapshot(profile)
    }
    record('direct-quit-held', trace.held)
    assert.equal(trace.held.ledger.pending, 1)
    assert.equal(trace.held.shutdown.checkingDrafts, true)
    assert.equal(trace.held.shutdown.quitRequested, true)
    assert.equal(trace.held.shutdown.deferredQuit, false, 'this is direct quit without navigation')
    assert.equal(trace.held.shutdown.startedAt, null)
    assert.equal(trace.held.databaseOpen, true, 'the actual production DB connection remains open')
    assert.equal(trace.held.destroyed, false)
    assert.equal(trace.held.visible, true)
    assert.equal(
      trace.events.some((entry) => entry.event === 'production-database-close-start'),
      false
    )
    assert.equal(willQuitAttempted, false)
    assert.equal(await js('window.__operationQuitSave.status'), 'pending')
    assert.equal(existsSync(gateDirectory), true)
    const png = (
      await bounded(current.webContents.capturePage(), 'Held-window screenshot timed out', 3000)
    ).toPNG()
    writeFileSync(join(evidence, 'direct-quit-held.png'), png, { flag: 'wx' })
    trace.screenshotSha256 = sha256(png)
    readyToQuit = true
    restoreFilesystem()
    record('original-rm-release')
    releaseGate()
    // No second quit, app.exit(), or window destruction: the original product quit
    // must wait for the real fs operation and proceed through normal shutdown itself.
  } catch (error) {
    fail(error)
  }
}

async function postcommitChild() {
  const profile = process.env.ABANDON_OPERATION_QUIT_PROFILE
  const evidence = process.env.ABANDON_OPERATION_QUIT_EVIDENCE
  const recorder = createAssertionRecorder({
    suite,
    mode: 'real-app-' + childCase,
    metadata: {
      actualProcessPid: process.pid,
      realThemeInvocationBeforeGate: true,
      themeHostAcknowledgementInjected: false,
      geometryDirtyFlagDirectlyObserved: false
    },
    env: {}
  })
  const { assert } = recorder
  const require = createRequire(import.meta.url)
  const prepareDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'prepare')
  const closeDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'close')
  const databasePath = join(profile, 'app.db')
  const trace = {
    kind: childKind,
    case: childCase,
    pid: process.pid,
    events: [],
    firstFailure: null,
    themeGateCount: 0,
    realThemeCalls: 0,
    quitClicks: 0,
    navigations: [],
    descriptorsRestored: false,
    willQuitVerified: false,
    expectedSettings: null,
    baseline: null,
    held: null,
    finalSettings: null
  }
  let eventSequence = 0
  let appDatabase, current, hooks, captureCoordinator, syncThemeDescriptor, originalSyncTheme
  let armed = false
  let readyToQuit = false
  let willQuitAttempted = false
  let failed = false
  let hookError = null
  let releaseGate
  const gate = new Promise((done) => {
    releaseGate = done
  })
  const record = (event, details = {}) => {
    const entry = {
      sequence: ++eventSequence,
      event,
      at: Date.now(),
      pid: process.pid,
      suite,
      ...details
    }
    trace.events.push(entry)
    appendFileSync(join(evidence, 'gui-exit-events.jsonl'), JSON.stringify(entry) + '\n')
    return entry
  }
  const restore = () => {
    if (trace.descriptorsRestored) return
    if (captureCoordinator) {
      if (syncThemeDescriptor)
        Object.defineProperty(captureCoordinator, 'syncTheme', syncThemeDescriptor)
      else delete captureCoordinator.syncTheme
    }
    Object.defineProperty(Database.prototype, 'prepare', prepareDescriptor)
    Object.defineProperty(Database.prototype, 'close', closeDescriptor)
    trace.descriptorsRestored = true
  }
  const fail = (error) => {
    process.exitCode = 1
    if (failed) return
    failed = true
    trace.firstFailure = error.stack || String(error)
    clearTimeout(watchdog)
    restore()
    try {
      record('child-failed', { error: error.message || String(error) })
      writeJson(join(evidence, 'child-first-failure.json'), trace)
    } catch (evidenceError) {
      process.stderr.write((evidenceError.stack || String(evidenceError)) + '\n')
    }
    process.stderr.write(trace.firstFailure + '\n')
    // Keep the failed gate/window/DB state for controller-owned diagnostics before
    // termination. A failed child never forces itself through a passing quit.
    process.stdout.write(failureMarker)
  }
  const watchdog = setTimeout(
    () => fail(new Error('Postcommit child business deadline exceeded 35 seconds')),
    35000
  )
  async function bounded(promise, label, timeoutMs = 12000) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function until(predicate, label) {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      if (hookError) throw hookError
      if (failed) throw new Error('Postcommit child already failed')
      const result = await bounded(Promise.resolve().then(predicate), label)
      if (result) return result
      await wait(20)
    }
    throw new Error(label)
  }
  const js = (source) =>
    bounded(current.webContents.executeJavaScript(source), 'Renderer query timed out')
  const readSettings = () => settingsStorageSnapshot(profile, prepareDescriptor.value)
  Object.defineProperty(Database.prototype, 'prepare', {
    ...prepareDescriptor,
    value: function (...args) {
      const statement = Reflect.apply(prepareDescriptor.value, this, args)
      if (!this.readonly && this.name && samePath(this.name, databasePath) && !appDatabase) {
        appDatabase = this
        record('production-database-observed')
      }
      return statement
    }
  })
  Object.defineProperty(Database.prototype, 'close', {
    ...closeDescriptor,
    value: function (...args) {
      const observed = this === appDatabase
      if (observed) record('production-database-close-start', { open: this.open })
      const result = Reflect.apply(closeDescriptor.value, this, args)
      if (observed) record('production-database-close-complete', { open: this.open })
      return result
    }
  })
  app.on('will-quit', () => {
    if (willQuitAttempted) return
    willQuitAttempted = true
    try {
      record('will-quit')
      if (failed) return
      assert.equal(readyToQuit, true)
      assert.equal(trace.quitClicks, 1, 'one original production tray quit intent completed')
      assert.equal(trace.themeGateCount, 1)
      assert.deepEqual(trace.navigations, [])
      const shutdown = hooks.shutdownState()
      assert.equal(shutdown.completed, true)
      assert.equal(shutdown.trigger, 'tray-menu')
      for (const [name, stage] of Object.entries(shutdown.stages))
        assert.notEqual(stage.status, 'failed', name + ' shutdown stage failed')
      for (const name of ['settings-operations', 'geometry', 'database', 'tray'])
        assert.equal(shutdown.stages[name]?.status, 'complete')
      assert.equal(hooks.settingsOperationState().pending, 0)
      assert.equal(appDatabase.open, false)
      assert.equal(current.isDestroyed(), true)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      trace.finalSettings = readSettings()
      assertPostcommitSettings(assert, trace.finalSettings, trace.baseline, trace.expectedSettings)
      assert.deepEqual(
        trace.finalSettings,
        trace.held.settings,
        'normal shutdown did not repeat committed SQL'
      )
      if (childCase === 'geometry-postcommit') {
        // No production dirty-state hook exists. The observable contract is that
        // synchronous geometry SQL completes while its application owner waits,
        // and the later real geometry cleanup must not flush those values again.
        trace.geometryDirtyEvidence = {
          directFlagObserved: false,
          committedWhileApplicationPending: true,
          shutdownGeometryStage: shutdown.stages.geometry.status,
          repeatedDml: trace.finalSettings.audit.length - trace.held.settings.audit.length
        }
        assert.equal(trace.geometryDirtyEvidence.repeatedDml, 0)
      }
      trace.shutdown = shutdown
      trace.willQuitVerified = true
    } catch (error) {
      fail(error)
    } finally {
      restore()
    }
  })
  app.once('quit', (_event, code) => {
    clearTimeout(watchdog)
    restore()
    try {
      record('quit', { code })
      assert.equal(code, 0)
      assert.equal(failed, false)
      assert.equal(trace.willQuitVerified, true)
      assert.equal(trace.descriptorsRestored, true)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
    } catch (error) {
      fail(error)
    }
    try {
      writeJson(join(evidence, 'child-trace.json'), trace)
      const result = recorder.finish({
        completed: !failed && trace.willQuitVerified && code === 0,
        error: trace.firstFailure || undefined,
        evidence: { status: 'complete' },
        cleanup: {
          status: failed ? 'failed' : 'complete',
          exitCode: code,
          descriptorsRestored: trace.descriptorsRestored,
          windowsClosed: BrowserWindow.getAllWindows().length === 0
        }
      })
      writeJson(join(evidence, 'child-result.json'), result)
    } catch (error) {
      fail(error)
    }
  })
  try {
    assert.ok(postcommitCases.has(childCase))
    app.setPath('userData', profile)
    process.env.ABANDON_INTEGRATION_TEST = '1'
    process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
    process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
    require(resolve('out/main/index.js'))
    const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
      /^index-[\w-]+\.js$/.test(name)
    )
    assert.ok(chunk, 'built main chunk exists')
    require(resolve('out/main/chunks', chunk))
    await until(() => {
      current = BrowserWindow.getAllWindows().find(
        (window) => !window.isDestroyed() && window.webContents.getURL().endsWith('/index.html')
      )
      hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
      return current?.isVisible() && hooks?.nativeCaptureState().ready
    }, 'Real app and native capture prerequisite did not become ready')
    assert.equal(typeof hooks.settingsOperationState, 'function')
    assert.equal(typeof hooks.captureCoordinator, 'function')
    assert.equal(appDatabase?.open, true)
    await until(
      () => js("Boolean(document.querySelector('.app-titlebar'))"),
      'Real renderer titlebar ready'
    )
    const initialSnapshot = await js('window.api.getSettingsSnapshot()')
    assert.equal(initialSnapshot.source.scope, 'main')
    current.webContents.on('did-navigate', (_event, url) => trace.navigations.push(url))
    trace.initialWindow = {
      id: current.id,
      hwnd: current.getNativeWindowHandle().toString('hex'),
      bounds: current.getBounds()
    }
    // Observe a quiet startup interval, beyond the real geometry debounce, before
    // defining the target commit. Earlier startup DML remains in the audit.
    let startupAudit = readSettings()
    let quietSince = Date.now()
    await until(() => {
      const observed = readSettings()
      if (
        hooks.settingsOperationState().pending !== 0 ||
        JSON.stringify(observed) !== JSON.stringify(startupAudit)
      ) {
        startupAudit = observed
        quietSince = Date.now()
        return false
      }
      if (Date.now() - quietSince < 700) return false
      trace.baseline = observed
      return true
    }, 'Startup settings and geometry did not reach a stable baseline beyond their debounce')
    assert.equal(hooks.settingsOperationState().sealed, false)
    assert.deepEqual(storageSnapshot(profile).wallpapers, [])
    captureCoordinator = hooks.captureCoordinator()
    originalSyncTheme = captureCoordinator.syncTheme
    syncThemeDescriptor = Object.getOwnPropertyDescriptor(captureCoordinator, 'syncTheme')
    assert.equal(typeof originalSyncTheme, 'function')
    captureCoordinator.syncTheme = async function (...args) {
      try {
        // Invoke the actual host send first. The test only delays this returned
        // dependency Promise; it does not add a host ACK or change its result.
        const result = await Reflect.apply(originalSyncTheme, this, args)
        trace.realThemeCalls += 1
        if (!armed || trace.themeGateCount) return result
        const committed = readSettings()
        const boundary = trace.baseline.audit.at(-1)?.sequence || 0
        const targetKeys = new Set(trace.expectedSettings.map((entry) => entry.key))
        const targetCommitted = committed.audit.some(
          (entry) =>
            entry.sequence > boundary && entry.window_name === 'main' && targetKeys.has(entry.key)
        )
        if (!targetCommitted) return result
        assertPostcommitSettings(assert, committed, trace.baseline, trace.expectedSettings)
        assert.equal(
          appDatabase.inTransaction,
          false,
          'target SQL committed before the application gate'
        )
        assert.equal(
          this,
          captureCoordinator,
          'the wrapper observes the actual production coordinator'
        )
        assert.equal(hooks.nativeCaptureState().ready, true)
        assert.equal(captureCoordinator.stopping, false)
        assert.equal(typeof captureCoordinator.getTheme, 'function')
        armed = false
        trace.themeGateCount += 1
        trace.committedAtGate = committed
        record('real-theme-invoked-postcommit-held', {
          audit: committed.audit,
          databaseInTransaction: appDatabase.inTransaction,
          hostReady: hooks.nativeCaptureState().ready,
          hostAcknowledgementInjected: false
        })
        await gate
        record('postcommit-theme-returned')
        return result
      } catch (error) {
        hookError = error
        throw error
      }
    }
    if (childCase === 'generic-postcommit') {
      trace.expectedSettings = [{ type: 'css', key: 'font_size_base', value: '19' }]
      armed = true
      await js(`(() => {
        window.__operationQuitGeneric = {status:'pending'};
        void window.api.setSettingValue('css.fontSizeBase',19).then(
          result => {window.__operationQuitGeneric = {status:'saved',result}},
          error => {window.__operationQuitGeneric = {status:'rejected',error:error.message}});
      })()`)
    } else {
      const before = current.getBounds()
      const workArea = screen.getDisplayMatching(before).workArea
      const width = Math.max(260, Math.min(before.width - 17, workArea.width - 40))
      const height = Math.max(260, Math.min(before.height - 19, workArea.height - 40))
      const target = {
        x: Math.min(
          Math.max(before.x + 13, workArea.x + 20),
          workArea.x + workArea.width - width - 20
        ),
        y: Math.min(
          Math.max(before.y + 11, workArea.y + 20),
          workArea.y + workArea.height - height - 20
        ),
        width,
        height
      }
      assert.notDeepEqual(target, before, 'the real window geometry must change')
      trace.targetBounds = target
      trace.expectedSettings = [
        { type: 'geometry', key: 'pos_x', value: String(target.x) },
        { type: 'geometry', key: 'pos_y', value: String(target.y) },
        { type: 'geometry', key: 'width', value: String(target.width) },
        { type: 'geometry', key: 'height', value: String(target.height) }
      ]
      armed = true
      await js(`window.api.setWindowBounds(${JSON.stringify(target)})`)
      await until(() => {
        const actual = current.getBounds()
        return ['x', 'y', 'width', 'height'].every((key) => actual[key] === target[key])
      }, 'Real window did not reach target geometry')
      record('real-window-geometry-observed', { bounds: current.getBounds() })
    }
    await until(
      () => trace.themeGateCount === 1,
      'Target committed SQL did not reach the real theme dependency gate'
    )
    // This observation runs after the production callback that schedules/executes
    // synchronous SQL returned. Only its postcommit application Promise is held.
    assert.ok(hooks.settingsOperationState().pending > 0)
    assert.equal(appDatabase.inTransaction, false)
    if (childCase === 'generic-postcommit')
      assert.equal(await js('window.__operationQuitGeneric.status'), 'pending')
    const item = hooks.getTrayMenuTemplate().find((entry) => entry.label === '退出应用')
    assert.equal(typeof item?.click, 'function')
    trace.quitClicks += 1
    record('finish-start', { completed: false, ownedProductQuit: true })
    record('tray-quit-click')
    item.click()
    await until(
      () => hooks.settingsOperationState().sealed,
      'Direct quit did not seal postcommit settings work'
    )
    await wait(300)
    trace.held = {
      ledger: hooks.settingsOperationState(),
      shutdown: hooks.shutdownState(),
      databaseOpen: appDatabase.open,
      databaseInTransaction: appDatabase.inTransaction,
      visible: current.isVisible(),
      destroyed: current.isDestroyed(),
      url: current.webContents.getURL(),
      bounds: current.getBounds(),
      settings: readSettings(),
      willQuitAttempted
    }
    record('direct-quit-held', trace.held)
    assert.ok(
      trace.held.ledger.pending > 0,
      'the actual postcommit owner Promise remains in the settings ledger'
    )
    assert.equal(trace.held.ledger.sealed, true)
    assert.equal(trace.held.shutdown.checkingDrafts, true)
    assert.equal(trace.held.shutdown.quitRequested, true)
    assert.equal(trace.held.shutdown.deferredQuit, false)
    assert.equal(trace.held.shutdown.startedAt, null)
    assert.equal(trace.held.databaseOpen, true)
    assert.equal(trace.held.databaseInTransaction, false)
    assert.equal(trace.held.destroyed, false)
    assert.equal(trace.held.visible, true)
    assert.equal(trace.held.willQuitAttempted, false)
    assert.equal(
      trace.events.some((entry) => entry.event === 'production-database-close-start'),
      false
    )
    assertPostcommitSettings(assert, trace.held.settings, trace.baseline, trace.expectedSettings)
    assert.deepEqual(
      trace.held.settings,
      trace.committedAtGate,
      'waiting for quit did not repeat target SQL'
    )
    if (childCase === 'generic-postcommit')
      assert.equal(await js('window.__operationQuitGeneric.status'), 'pending')
    else assert.deepEqual(trace.held.bounds, trace.targetBounds)
    const png = (
      await bounded(current.webContents.capturePage(), 'Held-window screenshot timed out', 3000)
    ).toPNG()
    writeFileSync(join(evidence, 'direct-quit-held.png'), png, { flag: 'wx' })
    trace.screenshotSha256 = sha256(png)
    readyToQuit = true
    record('postcommit-gate-release')
    releaseGate()
    // The single original production tray request owns all remaining shutdown.
    // No second quit, app.exit(), window destruction, or fabricated host ACK.
  } catch (error) {
    fail(error)
  }
}

function runChild(kind, name, profile, evidence, payloadPath) {
  mkdirSync(evidence, { recursive: true })
  const environment = {
    ...process.env,
    ABANDON_OPERATION_QUIT_CHILD: kind,
    ABANDON_OPERATION_QUIT_CASE: name,
    ABANDON_OPERATION_QUIT_PROFILE: profile,
    ABANDON_OPERATION_QUIT_EVIDENCE: evidence,
    ABANDON_OPERATION_QUIT_PAYLOAD: payloadPath
  }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ABANDON_TEST_RESULT_FILE',
    'ABANDON_TEST_RUN_TOKEN',
    'ABANDON_TEST_USER_DATA',
    'ABANDON_TEST_EVIDENCE_DIR'
  ])
    delete environment[key]
  return new Promise((done) => {
    const result = {
      kind,
      case: name,
      code: null,
      signal: null,
      exitObserved: false,
      closeObserved: false,
      forcedTermination: false,
      terminationIncomplete: false,
      timedOut: false,
      firstFailure: null,
      outputErrors: [],
      diagnosticBeforeForce: false
    }
    const descriptors = {}
    let processHandle,
      diagnostics,
      deadline,
      killFallback,
      stopping = false,
      finished = false
    let outputTail = ''
    const firstFailure = (kind, details = {}) => {
      result.firstFailure ||= { kind, at: Date.now(), ...details }
    }
    const finish = async () => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      clearTimeout(killFallback)
      result.diagnostics = await diagnostics?.finish()
      for (const [name, fd] of Object.entries(descriptors)) {
        try {
          closeSync(fd)
        } catch (error) {
          result.outputErrors.push(name + ': ' + error.message)
        }
      }
      try {
        writeJson(join(evidence, 'process-result.json'), result)
      } catch (error) {
        result.outputErrors.push(error.message)
      }
      done(result)
    }
    const stop = async (reason) => {
      if (stopping || finished) return
      stopping = true
      clearTimeout(deadline)
      firstFailure(reason)
      await diagnostics?.capture(reason)
      result.diagnosticBeforeForce = true
      if (finished) return
      const running = () => processHandle.exitCode === null && processHandle.signalCode === null
      if (running()) {
        result.forcedTermination = true
        const killer = spawn('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.unref()
        killer.on('error', (error) => {
          result.killError = error.message
          if (running()) processHandle.kill()
        })
        killer.on('exit', (code) => {
          if (code !== 0 && running()) processHandle.kill()
        })
      } else result.terminationIncomplete = true
      killFallback = setTimeout(() => {
        result.terminationIncomplete = true
        processHandle.stdout?.destroy()
        processHandle.stderr?.destroy()
        processHandle.unref()
        void finish()
      }, 5000)
    }
    try {
      for (const stream of ['stdout', 'stderr'])
        descriptors[stream] = openSync(join(evidence, stream + '.log'), 'wx')
      const spawnedMs = Date.now()
      processHandle = spawn(process.execPath, [script], {
        cwd: process.cwd(),
        env: environment,
        // Windows launch hiding suppresses GUI show in this Electron child.
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      result.pid = processHandle.pid
      result.spawnedMs = spawnedMs
      diagnostics = createFailureDiagnostics({
        gui: true,
        directory: evidence,
        command: process.execPath,
        args: [script],
        spawnedMs,
        pid: processHandle.pid,
        cwd: process.cwd(),
        writeEvidence: (name, entry) => writeJson(join(evidence, name), entry)
      })
      for (const stream of ['stdout', 'stderr']) {
        processHandle[stream].on('data', (chunk) => {
          try {
            let offset = 0
            while (offset < chunk.length) {
              const count = writeSync(descriptors[stream], chunk, offset, chunk.length - offset)
              if (!count) throw new Error('Output write made no progress')
              offset += count
            }
            if (stream === 'stdout') {
              const received = outputTail + chunk.toString('utf8')
              outputTail = received.slice(-failureMarker.length)
              if (received.includes(failureMarker)) void stop('child-reported-failure')
            }
          } catch (error) {
            result.outputErrors.push(stream + ': ' + error.message)
            firstFailure('output-write', { stream, error: error.message })
            void stop('output-write')
          }
        })
        processHandle[stream].on('error', (error) => {
          result.outputErrors.push(stream + ': ' + error.message)
          firstFailure('output-stream', { stream, error: error.message })
          void stop('output-stream')
        })
      }
      processHandle.once('error', (error) => {
        firstFailure('launch-error', { error: error.message })
      })
      processHandle.once('exit', (code, signal) => {
        result.exitObserved = true
        result.exit = { code, signal, at: Date.now() }
        if (code !== 0 || signal) firstFailure('process-exit', { code, signal })
        diagnostics.exited(code, signal)
      })
      processHandle.once('close', (code, signal) => {
        result.closeObserved = true
        result.code = code
        result.signal = signal
        result.closedAt = Date.now()
        void finish()
      })
      deadline = setTimeout(() => {
        result.timedOut = true
        firstFailure('timeout', { timeoutMs: 45000 })
        void stop('timeout')
      }, 45000)
    } catch (error) {
      firstFailure('launch-error', { error: error.message })
      if (processHandle?.pid) void stop('launch-error')
      else void finish()
    }
  })
}

async function controller() {
  const recorder = createAssertionRecorder({
    suite,
    mode: 'electron-wallpaper-operation-direct-quit-save-rollback-and-reopen',
    metadata: {
      coverageCases: ['save', 'rollback', 'generic-postcommit', 'geometry-postcommit'],
      adapterModeCompatibility:
        'existing registered mode retained; metadata names the expanded coverage',
      realRendererAndPreload: true,
      realDiskDatabaseAndFiles: true,
      processes:
        'isolated save and rollback writers with unseeded verifiers, plus independent generic and internal geometry postcommit apps',
      quitEntry: 'production-tray-menu-template-quit-item-click',
      nativeTrayMouseHitTesting: false,
      navigationUsed: false,
      timingInjection:
        'only this payload operation final fs/promises.rm of its own save-UUID staging directory is delayed; original rm/SQL commit/rollback execute unchanged',
      postcommitTimingInjection:
        'real CaptureCoordinator.syncTheme executes first; only one exact independently committed target then awaits a test-owned dependency Promise, without adding host ACK',
      internalGeometryObservation:
        'real preload bounds change and production debounce, committed four-key SQL while owner pending, then no repeated DML from normal geometry cleanup; no direct dirty flag hook',
      rollbackInjection: 'real BEFORE INSERT ON wallpapers SQLite trigger',
      verificationBoundary:
        'controller waits for both child exit and stdio close before read-only SQL/file checks',
      forcedTerminationCanPass: false
    }
  })
  const { assert } = recorder
  const profile = controllerProfile
  const evidence = process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory
  const cases = []
  let failure = null
  let completed = false
  try {
    for (const name of ['save', 'rollback', 'generic-postcommit', 'geometry-postcommit']) {
      const postcommit = postcommitCases.has(name)
      const caseProfile = ownedPath(profile.directory, name)
      const caseEvidence = ownedPath(evidence, 'operation-' + name)
      mkdirSync(caseEvidence, { recursive: true })
      const payload = postcommit ? { case: name } : payloadForCase(name)
      const payloadPath = join(caseEvidence, 'payload.json')
      writeJson(payloadPath, payload)
      if (postcommit) seedPostcommit(caseProfile, name)
      else seed(caseProfile, name)
      const record = { name, profile: caseProfile, processes: [] }
      cases.push(record)
      for (const kind of postcommit ? ['postcommit'] : ['write', 'verify']) {
        const childEvidence = join(caseEvidence, kind)
        const priorSessions = new Set(shutdownSessions(caseProfile).map((entry) => entry.sessionId))
        const processResult = await runChild(kind, name, caseProfile, childEvidence, payloadPath)
        record.processes.push(processResult)
        assert.equal(processResult.exitObserved, true, 'child process actually exited')
        assert.equal(
          processResult.closeObserved,
          true,
          'child process output pipes actually closed'
        )
        assert.equal(
          processResult.forcedTermination,
          false,
          'forced termination never counts as passing'
        )
        assert.equal(processResult.terminationIncomplete, false)
        assert.equal(processResult.timedOut, false)
        assert.equal(processResult.firstFailure, null)
        assert.deepEqual(processResult.outputErrors, [])
        assert.equal(processResult.code, 0)
        assert.equal(processResult.signal, null)
        const childResult = JSON.parse(
          readFileSync(join(childEvidence, 'child-result.json'), 'utf8')
        )
        const trace = JSON.parse(readFileSync(join(childEvidence, 'child-trace.json'), 'utf8'))
        assert.equal(childResult.completed, true)
        assert.ok(childResult.assertions.total > 0)
        assert.equal(childResult.assertions.failed, 0)
        assert.equal(childResult.cleanup.status, 'complete')
        assert.equal(trace.firstFailure, null)
        assert.equal(trace.descriptorsRestored, true)
        assert.equal(trace.willQuitVerified, true)
        assert.equal(trace.quitClicks, 1)
        assert.deepEqual(trace.navigations, [])
        const sessions = shutdownSessions(caseProfile).filter(
          (entry) => !priorSessions.has(entry.sessionId)
        )
        assert.equal(sessions.length, 1, 'Exactly one new durable shutdown session exists')
        assert.equal(typeof sessions[0].sessionId, 'string')
        assert.ok(sessions[0].sessionId.length > 0)
        assert.equal(sessions[0].pid, processResult.pid, 'Durable log belongs to this child')
        assert.equal(trace.pid, processResult.pid)
        assert.equal(sessions[0].metadata.trigger, 'tray-menu')
        processResult.sessionId = sessions[0].sessionId
        writeJson(join(childEvidence, 'shutdown-session.json'), sessions[0])
        if (postcommit) {
          const postExit = settingsStorageSnapshot(caseProfile)
          assertPostcommitSettings(assert, postExit, trace.baseline, trace.expectedSettings)
          assert.deepEqual(
            postExit,
            trace.finalSettings,
            'independent post-exit DB retains the verified normal-quit state'
          )
          assert.deepEqual(
            postExit,
            trace.held.settings,
            'normal quit did not reissue any committed target SQL'
          )
          assertStorage(assert, storageSnapshot(caseProfile), 'rollback', payload)
          writeJson(join(childEvidence, 'post-exit-settings.json'), postExit)
          assert.equal(trace.themeGateCount, 1)
          assert.ok(trace.realThemeCalls >= 1)
          assert.equal(trace.held.databaseOpen, true)
          assert.equal(trace.held.databaseInTransaction, false)
          assert.ok(trace.held.ledger.pending > 0)
          assert.equal(trace.held.ledger.sealed, true)
          assert.equal(trace.held.willQuitAttempted, false)
          assert.equal(trace.held.shutdown.deferredQuit, false)
          if (name === 'geometry-postcommit') {
            assert.deepEqual(trace.held.bounds, trace.targetBounds)
            assert.equal(trace.geometryDirtyEvidence.committedWhileApplicationPending, true)
            assert.equal(trace.geometryDirtyEvidence.shutdownGeometryStage, 'complete')
            assert.equal(trace.geometryDirtyEvidence.repeatedDml, 0)
          }
          const index = (event) => trace.events.findIndex((entry) => entry.event === event)
          for (const [before, after] of [
            ['real-theme-invoked-postcommit-held', 'tray-quit-click'],
            ['tray-quit-click', 'direct-quit-held'],
            ['direct-quit-held', 'postcommit-gate-release'],
            ['postcommit-gate-release', 'postcommit-theme-returned'],
            ['postcommit-theme-returned', 'production-database-close-start'],
            ['production-database-close-start', 'production-database-close-complete'],
            ['production-database-close-complete', 'will-quit'],
            ['will-quit', 'quit']
          ])
            assert.ok(
              index(before) >= 0 && index(after) > index(before),
              before + ' precedes ' + after
            )
          assert.equal(
            trace.events.filter((entry) => entry.event === 'production-database-close-complete')
              .length,
            1
          )
          record.afterWrite = postExit
          continue
        }
        const postExit = storageSnapshot(caseProfile)
        assertStorage(assert, postExit, name, payload)
        writeJson(join(childEvidence, 'post-exit-storage.json'), postExit)
        if (kind === 'write') {
          assert.equal(trace.rmHeldCount, 1)
          assert.equal(trace.held.databaseOpen, true)
          assert.equal(trace.held.ledger.pending, 1)
          assert.equal(trace.held.ledger.sealed, true)
          assert.equal(trace.held.shutdown.deferredQuit, false)
          const index = (event) => trace.events.findIndex((entry) => entry.event === event)
          for (const [before, after] of [
            ['original-rm-held', 'tray-quit-click'],
            ['tray-quit-click', 'direct-quit-held'],
            ['direct-quit-held', 'original-rm-release'],
            ['original-rm-release', 'original-rm-start'],
            ['original-rm-start', 'original-rm-complete'],
            ['original-rm-complete', 'wallpaper-handler-returned'],
            ['wallpaper-handler-returned', 'production-database-close-start'],
            ['production-database-close-start', 'production-database-close-complete'],
            ['production-database-close-complete', 'will-quit'],
            ['will-quit', 'quit']
          ])
            assert.ok(
              index(before) >= 0 && index(after) > index(before),
              before + ' precedes ' + after
            )
          assert.equal(
            trace.events.filter((entry) => entry.event === 'production-database-close-complete')
              .length,
            1
          )
          record.afterWrite = postExit
        } else {
          assert.ok(
            processResult.spawnedMs >= record.processes[0].closedAt,
            'verification started after the writer exited and its pipes closed'
          )
          assert.notEqual(
            record.processes[0].sessionId,
            processResult.sessionId,
            'verification booted a distinct main logging session'
          )
          assert.deepEqual(
            postExit,
            record.afterWrite,
            'unseeded restart preserved committed or rolled-back state'
          )
          assert.equal(trace.reopenedLibrary.length, name === 'save' ? 1 : 0)
          if (name === 'save') assert.equal(trace.reopenedLibrary[0].id, postExit.wallpapers[0].id)
          record.afterReopen = postExit
        }
      }
    }
    completed = true
  } catch (error) {
    failure = error
    process.stderr.write((error.stack || String(error)) + '\n')
  }
  let evidenceStatus = 'complete'
  try {
    writeJson(join(evidence, 'settings-operation-quit-summary.json'), {
      completed,
      cases,
      error: failure?.stack || null
    })
  } catch (error) {
    failure ||= error
    completed = false
    evidenceStatus = 'failed'
  }
  const processesClosed = cases.every((entry) =>
    entry.processes.every(
      (result) => result.exitObserved && result.closeObserved && !result.terminationIncomplete
    )
  )
  recorder.finish({
    completed,
    error: failure,
    evidence: {
      status: evidenceStatus,
      artifacts: ['settings-operation-quit-summary.json'],
      scope:
        'Original per-child stdout/stderr, actual assertion reports, read-only post-exit SQL/file hashes and DML audit, unseeded wallpaper reopen, and pre-force Windows diagnostics on failure'
    },
    profileOwnership: profile.ownership,
    cleanup: {
      status: !processesClosed
        ? 'failed'
        : completed && profile.ownership === 'runner'
          ? 'complete'
          : 'preserved',
      ownedProcessesClosed: processesClosed,
      preservedProfile:
        !completed || profile.ownership === 'script' ? profile.directory : undefined,
      scope:
        'Controller retains failed profiles; the runner removes its successful owned profile after process exit'
    }
  })
  // This process is a windowless test controller; product children exit only via their real tray lifecycle.
  app.exit(completed && !failure ? 0 : 1)
}

if (childKind)
  void (childKind === 'postcommit' ? postcommitChild() : child()).catch((error) => {
    process.exitCode = 1
    process.stderr.write((error.stack || String(error)) + '\n')
    process.stdout.write(failureMarker)
  })
else
  void app
    .whenReady()
    .then(controller)
    .catch((error) => {
      process.stderr.write((error.stack || String(error)) + '\n')
      app.exit(1)
    })
