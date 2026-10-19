import { createRequire, syncBuiltinESMExports } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const script = fileURLToPath(import.meta.url)
const childMode = process.env.ABANDON_LIFECYCLE_CHILD
const wait = (ms) => new Promise((complete) => setTimeout(complete, ms))

async function waitUntil(read, description) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await read()) return
    await wait(25)
  }
  throw new Error(description)
}

function seed(directory) {
  mkdirSync(directory, { recursive: true })
  const database = new Database(join(directory, 'app.db'))
  try {
    createDatabaseSchema(database)
    const now = Date.now()
    const insert = database.prepare(`INSERT INTO app_settings
      (window_name, type, key, value, remark, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', ?, ?)`)
    for (const [scope, type, key, value] of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['main', 'system', 'blur_enabled', 'false']
    ])
      insert.run(scope, type, key, value, now, now)
  } finally {
    database.close()
  }
}

async function child() {
  app.setPath('userData', process.env.ABANDON_LIFECYCLE_PROFILE)
  const require = createRequire(import.meta.url)
  if (childMode === 'recovery-failure') {
    await recoveryFailureChild(require)
    return
  }
  const watchdog = setTimeout(() => app.exit(1), 25000)
  require(resolve('out/main/index.js'))
  await waitUntil(() => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      /\/index\.html(?:$|[?#])/.test(item.webContents.getURL())
    )
    return (
      window?.isVisible() && globalThis.__ABANDON_WINDOW_TEST_HOOKS__?.nativeCaptureState().ready
    )
  }, 'Application and capture prerequisites did not become ready')
  process.stdout.write(`lifecycle-child-ready:${childMode}\n`)
  clearTimeout(watchdog)
  app.quit()
  if (childMode === 'reentrant') {
    app.quit()
    app.quit()
  }
}

async function recoveryFailureChild(require) {
  const profile = process.env.ABANDON_LIFECYCLE_PROFILE
  const databasePath = resolve(profile, 'app.db')
  const tracePath = join(profile, 'recovery-failure-trace.json')
  const promises = require('node:fs/promises')
  const readdirDescriptor = Object.getOwnPropertyDescriptor(promises, 'readdir')
  const prepareDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'prepare')
  const closeDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'close')
  const trace = {
    mode: 'real-app-database-with-controlled-recovery-filesystem-scheduling',
    simulation: { wallpaperReaddirEacces: true, attachmentReaddirDelay: true },
    events: [],
    errorsInjected: 0,
    windowsCreated: 0,
    descriptorsRestored: false,
    error: null
  }
  let paused = false
  let database = null
  let releaseRead
  const released = new Promise((complete) => (releaseRead = complete))
  const record = (event, details = {}) => trace.events.push({ event, ...details })
  const isApplicationDb = (candidate) => candidate.name && resolve(candidate.name) === databasePath
  const restore = () => {
    if (trace.descriptorsRestored) return
    Object.defineProperty(promises, 'readdir', readdirDescriptor)
    Object.defineProperty(Database.prototype, 'prepare', prepareDescriptor)
    Object.defineProperty(Database.prototype, 'close', closeDescriptor)
    syncBuiltinESMExports()
    trace.descriptorsRestored = true
  }
  const windowCreated = () => (trace.windowsCreated += 1)
  let watchdog
  const finish = (reason, error) => {
    if (error) trace.error ||= error.stack || String(error)
    trace.terminal ||= reason
    record(reason, error ? { error: error.message || String(error) } : {})
    restore()
    clearTimeout(watchdog)
    app.removeListener('browser-window-created', windowCreated)
    writeFileSync(tracePath, JSON.stringify(trace, null, 2))
  }
  const onQuit = () => finish('will-quit')
  const onExit = (code) => finish('process-exit', code ? new Error(`Process exited ${code}`) : null)
  app.on('browser-window-created', windowCreated)
  app.once('will-quit', onQuit)
  process.once('exit', onExit)
  watchdog = setTimeout(() => {
    finish('watchdog', new Error('Recovery failure child exceeded its deadline'))
    app.exit(1)
  }, 25000)
  try {
    Object.defineProperty(promises, 'readdir', {
      ...readdirDescriptor,
      value: async function (directory, ...args) {
        const target = resolve(String(directory))
        if (target === resolve(profile, 'wallpapers', '.staging') && trace.errorsInjected === 0) {
          trace.errorsInjected += 1
          record('wallpaper-readdir-eacces')
          throw Object.assign(new Error('Controlled wallpaper recovery staging EACCES'), {
            code: 'EACCES',
            path: target
          })
        }
        if (target === resolve(profile, '.attachments-staging') && !paused) {
          paused = true
          record('attachment-readdir-paused')
          await released
          const entries = await Reflect.apply(readdirDescriptor.value, this, [directory, ...args])
          record('attachment-readdir-completed', { entries: entries.map((entry) => entry.name) })
          return entries
        }
        return Reflect.apply(readdirDescriptor.value, this, [directory, ...args])
      }
    })
    Object.defineProperty(Database.prototype, 'prepare', {
      ...prepareDescriptor,
      value: function (...args) {
        const statement = Reflect.apply(prepareDescriptor.value, this, args)
        if (isApplicationDb(this)) {
          database = this
          if (/SELECT 1 FROM note_attachments WHERE file_path/.test(String(args[0]))) {
            record('attachment-query-prepared', { databaseOpen: this.open })
          }
        }
        return statement
      }
    })
    Object.defineProperty(Database.prototype, 'close', {
      ...closeDescriptor,
      value: function (...args) {
        const owned = isApplicationDb(this)
        if (owned) record('database-close-start', { databaseOpen: this.open })
        const result = Reflect.apply(closeDescriptor.value, this, args)
        if (owned) record('database-close-complete', { databaseOpen: this.open })
        return result
      }
    })
    syncBuiltinESMExports()
    require(resolve('out/main/index.js'))
    await waitUntil(
      () => paused && trace.errorsInjected === 1,
      'Both recovery branches were not entered'
    )
    record('quit-requested')
    app.quit()
    await wait(100)
    trace.duringPause = {
      databaseOpen: database?.open === true,
      windowCount: BrowserWindow.getAllWindows().length,
      windowsCreated: trace.windowsCreated,
      databaseClosed: trace.events.some((event) => event.event === 'database-close-start')
    }
    writeFileSync(tracePath, JSON.stringify(trace, null, 2))
    process.stdout.write('lifecycle-recovery-child-armed\n')
    record('attachment-readdir-release')
    releaseRead()
    await waitUntil(
      () => trace.events.some((event) => event.event === 'database-close-complete'),
      'Application did not close the real database after recovery settled'
    )
    finish('database-close-observed')
  } catch (error) {
    finish('scenario-failed', error)
    throw error
  } finally {
    releaseRead()
    restore()
  }
}

function runChild(mode, profile) {
  return new Promise((complete, reject) => {
    const env = {
      ...process.env,
      ABANDON_LIFECYCLE_CHILD: mode,
      ABANDON_LIFECYCLE_PROFILE: profile,
      ABANDON_INTEGRATION_TEST: '1',
      ABANDON_INTEGRATION_APP_ROOT: process.cwd(),
      ABANDON_INTEGRATION_NATIVE_DLL: resolve('native_blur/build/bin/blur_engine.dll')
    }
    for (const name of [
      'ELECTRON_RUN_AS_NODE',
      'ABANDON_TEST_RESULT_FILE',
      'ABANDON_TEST_RUN_TOKEN',
      'ABANDON_TEST_USER_DATA'
    ])
      delete env[name]
    const processHandle = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    processHandle.stdout.on('data', (chunk) => (stdout += chunk))
    processHandle.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => {
      timedOut = true
      processHandle.kill()
    }, 30000)
    processHandle.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    processHandle.once('exit', (code, signal) => {
      clearTimeout(timer)
      complete({ code, signal, timedOut, pid: processHandle.pid, stdout, stderr })
    })
  })
}

async function controller() {
  const recorder = createAssertionRecorder({
    suite: 'tests/application-lifecycle-electron.mjs',
    mode: 'electron-main-app-shutdown-three-process',
    metadata: {
      browserWindow: true,
      mainProcessRestart: true,
      scenarios: ['normal', 'reentrant', 'recovery-failure'],
      simulation: { recoveryFailure: 'filesystem EACCES and delayed readdir; real app/SQLite' }
    }
  })
  const { assert } = recorder
  const profile = prepareTestProfile({ prefix: 'abandon-lifecycle-' })
  const evidence = process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory
  const sessions = []
  const pids = []
  let completed = false
  let failure
  let exitCode = 0
  try {
    for (const mode of ['normal', 'reentrant']) {
      const childProfile = join(profile.directory, mode)
      seed(childProfile)
      const result = await runChild(mode, childProfile)
      writeFileSync(join(evidence, `${mode}-process.json`), JSON.stringify(result, null, 2))
      assert.equal(result.timedOut, false, `${mode} process timed out`)
      assert.equal(result.code, 0, `${mode} process did not exit successfully: ${result.stderr}`)
      assert.ok(
        result.stdout.includes(`lifecycle-child-ready:${mode}`),
        'The real application did not reach readiness'
      )
      pids.push(result.pid)
      const records = readdirSync(join(childProfile, 'logs'))
        .filter((name) => /^app-.*\.jsonl$/.test(name))
        .flatMap((name) =>
          readFileSync(join(childProfile, 'logs', name), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        )
      const starts = records.filter((record) => record.scope === 'lifecycle.shutdown-start')
      const finishes = records.filter((record) => record.scope === 'lifecycle.shutdown-complete')
      assert.equal(starts.length, 1, 'Re-entry duplicated shutdown admission')
      assert.equal(
        finishes.length,
        1,
        'The final shutdown record was not durably written exactly once'
      )
      assert.equal(finishes[0].sessionId, starts[0].sessionId)
      sessions.push(finishes[0].sessionId)
      for (const name of [
        'capture',
        'remote-session',
        'diagnostic',
        'database',
        'native-blur',
        'tray'
      ])
        assert.equal(
          finishes[0].metadata.stages[name].status,
          'complete',
          `${name} did not reach its terminal state`
        )
      assert.equal(finishes[0].metadata.stages['remote-session'].result, 'completed')
      assert.equal(finishes[0].metadata.stages.diagnostic.result.complete, true)
      const database = new Database(join(childProfile, 'app.db'))
      try {
        assert.equal(database.pragma('integrity_check', { simple: true }), 'ok')
      } finally {
        database.close()
      }
      writeFileSync(
        join(evidence, `${mode}-shutdown-records.json`),
        JSON.stringify({ starts, finishes }, null, 2)
      )
    }
    assert.notEqual(pids[0], pids[1], 'The two scenarios must use separate main processes')
    assert.notEqual(
      sessions[0],
      sessions[1],
      'The logging session must be renewed in another process'
    )
    const recoveryProfile = join(profile.directory, 'recovery-failure')
    seed(recoveryProfile)
    const recoveryDirectory = join(recoveryProfile, '.attachments-staging', 'delete-operation')
    mkdirSync(recoveryDirectory, { recursive: true })
    writeFileSync(
      join(recoveryDirectory, 'operation.json'),
      JSON.stringify({
        version: 1,
        type: 'image-delete',
        relativePath: 'attachments/images/1/controlled-snapshot.png'
      })
    )
    writeFileSync(join(recoveryDirectory, 'payload'), 'controlled recovery bytes')
    const recovery = await runChild('recovery-failure', recoveryProfile)
    writeFileSync(
      join(evidence, 'recovery-failure-process.json'),
      JSON.stringify(recovery, null, 2)
    )
    assert.equal(recovery.timedOut, false, 'Recovery failure process timed out')
    assert.equal(
      recovery.code,
      0,
      `Recovery failure process exited unsuccessfully: ${recovery.stderr}`
    )
    assert.ok(recovery.stdout.includes('lifecycle-recovery-child-armed'))
    assert.ok(!pids.includes(recovery.pid), 'Recovery failure must use another main process')
    const trace = JSON.parse(
      readFileSync(join(recoveryProfile, 'recovery-failure-trace.json'), 'utf8')
    )
    writeFileSync(join(evidence, 'recovery-failure-trace.json'), JSON.stringify(trace, null, 2))
    assert.equal(trace.error, null)
    assert.equal(trace.descriptorsRestored, true)
    assert.equal(trace.errorsInjected, 1)
    assert.equal(trace.duringPause.databaseOpen, true)
    assert.equal(trace.duringPause.databaseClosed, false)
    assert.equal(trace.duringPause.windowCount, 0)
    assert.equal(trace.windowsCreated, 0)
    const eventIndex = (name) => trace.events.findIndex((event) => event.event === name)
    assert.ok(eventIndex('attachment-readdir-paused') >= 0)
    assert.ok(eventIndex('attachment-query-prepared') > eventIndex('attachment-readdir-release'))
    assert.ok(eventIndex('database-close-start') > eventIndex('attachment-query-prepared'))
    assert.equal(
      trace.events.filter((event) => event.event === 'database-close-complete').length,
      1
    )
    assert.equal(
      trace.events.find((event) => event.event === 'attachment-query-prepared').databaseOpen,
      true
    )
    assert.equal(
      trace.events.find((event) => event.event === 'database-close-complete').databaseOpen,
      false
    )
    const recoveryRecords = readdirSync(join(recoveryProfile, 'logs'))
      .filter((name) => /^app-.*\.jsonl$/.test(name))
      .flatMap((name) =>
        readFileSync(join(recoveryProfile, 'logs', name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      )
    const recoveryFinishes = recoveryRecords.filter(
      (record) => record.scope === 'lifecycle.shutdown-complete'
    )
    assert.equal(recoveryFinishes.length, 1)
    assert.equal(recoveryFinishes[0].metadata.stages['startup-settlement'].status, 'complete')
    assert.equal(recoveryFinishes[0].metadata.stages.database.status, 'complete')
    for (const name of ['capture', 'remote-session', 'diagnostic']) {
      assert.equal(recoveryFinishes[0].metadata.stages[name].status, 'not-created')
    }
    assert.ok(
      recoveryRecords.some(
        (record) =>
          record.scope === 'storage.attachment-recovery' &&
          record.metadata.operationId === 'delete-operation' &&
          record.metadata.action === 'committed-cleanup'
      ),
      'Production attachment recovery did not finish its real query and filesystem cleanup'
    )
    const recoveredDatabase = new Database(join(recoveryProfile, 'app.db'))
    try {
      assert.equal(recoveredDatabase.pragma('integrity_check', { simple: true }), 'ok')
    } finally {
      recoveredDatabase.close()
    }
    writeFileSync(
      join(evidence, 'recovery-failure-shutdown-records.json'),
      JSON.stringify({ finishes: recoveryFinishes }, null, 2)
    )
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
  }
  let cleanup = { status: 'complete' }
  if (profile.ownership === 'script' && completed) {
    try {
      rmSync(profile.directory, { recursive: true, force: true })
    } catch (error) {
      cleanup = { status: 'failed', error: error.message }
      exitCode = 1
    }
  } else if (!completed) cleanup = { status: 'preserved', preservedProfile: profile.directory }
  recorder.finish({
    completed,
    error: failure,
    evidence: { status: 'complete' },
    profileOwnership: profile.ownership,
    cleanup
  })
  app.exit(exitCode)
}

if (childMode)
  void child().catch((error) => {
    process.stderr.write(`${error.stack}\n`)
    app.exit(1)
  })
else
  void app
    .whenReady()
    .then(controller)
    .catch((error) => {
      process.stderr.write(`${error.stack}\n`)
      app.exit(1)
    })
