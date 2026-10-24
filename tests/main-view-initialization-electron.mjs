import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createFailureDiagnostics } from '../scripts/test-failure-diagnostics.cjs'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const SUITE = 'tests/main-view-initialization-electron.mjs'
const MODE = 'electron-real-app-main-view-ready-load-lifecycle'
const SCRIPT = fileURLToPath(import.meta.url)
const CASES = ['ready-tail-second-switch-hide', 'ready-timeout-deferred-quit']
const LIMITS = Object.freeze({
  childMs: 60000,
  queryMs: 12000,
  switchMs: 22000,
  cleanupMs: 5000,
  suiteMs: 240000
})
const FONTS = Object.freeze({ main: 16, month: 23, week: 21 })
const FAILURE_MARKER = 'main-view-initialization-first-failure\n'
const childCase = process.env.ABANDON_MAIN_INITIALIZATION_CHILD
const controllerProfile = childCase
  ? null
  : prepareTestProfile({ prefix: 'abandon-main-initialization-' })
if (controllerProfile) {
  const directory = join(controllerProfile.directory, 'controller-user-data')
  mkdirSync(directory, { recursive: true })
  app.setPath('userData', directory)
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const samePath = (a, b) => resolve(String(a)).toLowerCase() === resolve(String(b)).toLowerCase()
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
function deferred() {
  let resolvePromise
  const promise = new Promise((done) => {
    resolvePromise = done
  })
  return { promise, resolve: resolvePromise }
}
function details(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message || String(error),
    stack: error?.stack
  }
}
function ownedPath(root, child) {
  const target = resolve(root, child)
  const suffix = relative(resolve(root), target)
  if (!suffix || suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix))
    throw new Error('Path escapes its test-owned root')
  return target
}
function databaseSnapshot(profile) {
  const db = new Database(join(profile, 'app.db'), { readonly: true, fileMustExist: true })
  try {
    return {
      integrity: db.pragma('integrity_check', { simple: true }),
      activeView: db
        .prepare(
          "SELECT value FROM app_settings WHERE window_name='application' AND key='active_view'"
        )
        .get()?.value,
      fonts: Object.fromEntries(
        db
          .prepare(
            "SELECT window_name,value FROM app_settings WHERE key='font_size_base' AND window_name IN ('main','month','week') ORDER BY window_name"
          )
          .all()
          .map((row) => [row.window_name, Number(row.value)])
      ),
      activeViewWrites: db
        .prepare('SELECT * FROM main_initialization_view_writes ORDER BY sequence')
        .all()
    }
  } finally {
    db.close()
  }
}
function seed(profile) {
  mkdirSync(profile, { recursive: true })
  const db = new Database(join(profile, 'app.db'))
  try {
    createDatabaseSchema(db)
    const statement = db.prepare(
      "INSERT INTO app_settings(window_name,type,key,value,remark,created_at,updated_at) VALUES(?,?,?,?,'',?,?)"
    )
    const now = Date.now()
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['application', 'system', 'z_order_mode', 'normal'],
      ...Object.entries(FONTS).flatMap(([scope, font]) => [
        [scope, 'system', 'blur_enabled', 'false'],
        [scope, 'dock', 'dock_enabled_edges', '[]'],
        [scope, 'css', 'font_size_base', String(font)]
      ])
    ])
      statement.run(...row, now, now)
    db.exec(`CREATE TABLE main_initialization_view_writes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TRIGGER main_initialization_audit_insert AFTER INSERT ON app_settings
      WHEN NEW.window_name='application' AND NEW.key='active_view'
      BEGIN INSERT INTO main_initialization_view_writes(value) VALUES(NEW.value); END;
      CREATE TRIGGER main_initialization_audit_update AFTER UPDATE ON app_settings
      WHEN NEW.window_name='application' AND NEW.key='active_view'
      BEGIN INSERT INTO main_initialization_view_writes(value) VALUES(NEW.value); END;`)
  } finally {
    db.close()
  }
}
function shutdownRecords(profile) {
  const directory = join(profile, 'logs')
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((file) => /^app-.*\.jsonl$/.test(file))
    .sort()
    .flatMap((file) =>
      readFileSync(join(directory, file), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
    .filter((entry) =>
      ['lifecycle.shutdown-start', 'lifecycle.shutdown-complete'].includes(entry.scope)
    )
}
function fingerprints() {
  const files = new Set([
    SUITE,
    'tests/helpers/test-result-recorder.cjs',
    'scripts/test-failure-diagnostics.cjs',
    'scripts/test-failure-windows.ps1',
    'src/main/index.js',
    'src/main/windows/main-view-navigation.js',
    'src/main/windows/main-window-host.js',
    'src/main/windows/editing-draft-guard.js',
    'src/main/settings/settings-write-source.js',
    'src/main/settings/application-settings.js',
    'src/main/application/shutdown-coordinator.js',
    'src/main/settings/settings-operation-admission.js',
    'src/main/db/db-settings-repository.js',
    'src/preload/index.js',
    'src/preload/settings-client.js',
    'src/renderer/src/composables/useWorkspaceRuntime.js',
    'native_blur/build/bin/blur_engine.dll',
    'native_capture/deploy/capture_host.dll',
    'native_capture/deploy/AbandonCapture.exe',
    'package-lock.json'
  ])
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Unexpected link in application build')
      if (entry.isDirectory()) visit(file)
      else if (/\.(?:js|cjs|mjs|html|css)$/.test(entry.name))
        files.add(relative(process.cwd(), file))
    }
  }
  visit(resolve('out'))
  const sourcePaths = [...files].sort()
  return sourcePaths.map((file) => ({
    file: file.replaceAll('\\', '/'),
    sha256: sha256(readFileSync(resolve(file)))
  }))
}

async function controlledRenderer(name, directory) {
  const rendererRoot = resolve('out/renderer')
  const events = [],
    resources = [],
    sockets = new Set(),
    closeWaiters = new Set()
  let closing = false,
    sequence = 0
  const record = (event, data = {}) => {
    const value = { sequence: ++sequence, at: Date.now(), event, ...data }
    events.push(value)
    appendFileSync(join(directory, 'http-events.jsonl'), JSON.stringify(value) + '\n')
  }
  const state = () => ({
    resources: resources.map(({ id, requestedAt, released, closedAt }) => ({
      id,
      requestedAt,
      released,
      closedAt
    })),
    events: events.map((entry) => ({ ...entry }))
  })
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.json': 'application/json'
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/__fixture/state') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(state()))
      return
    }
    if (url.pathname === '/__fixture/held.png') {
      const resource = {
        id: url.searchParams.get('id'),
        requestedAt: Date.now(),
        released: false,
        closedAt: null,
        response
      }
      resources.push(resource)
      record('held-image-requested', { id: resource.id })
      response.once('close', () => {
        resource.closedAt = Date.now()
        record('held-image-closed', { id: resource.id })
      })
      response.on('error', (error) =>
        record('held-image-error', { id: resource.id, error: details(error) })
      )
      return // No release endpoint exists: the business cases never complete this response.
    }
    try {
      const path = decodeURIComponent(url.pathname)
      const target = ownedPath(rendererRoot, path === '/' ? 'index.html' : path.replace(/^\/+/, ''))
      if (!existsSync(target) || !statSync(target).isFile()) {
        response.writeHead(404)
        response.end()
        return
      }
      const original = readFileSync(target)
      let bytes = original
      const filename = relative(rendererRoot, target).replaceAll('\\', '/')
      const inject = filename === 'month.html' || (name === CASES[0] && filename === 'week.html')
      if (inject) {
        const ordinal =
          events.filter((entry) => entry.event === 'html-served' && entry.file === filename)
            .length + 1
        const id = filename.replace('.html', '') + '-' + ordinal
        const html = original.toString('utf8')
        if (!html.includes('</body>')) throw new Error('Production HTML lacks its body boundary')
        bytes = Buffer.from(
          html.replace(
            '</body>',
            `<img aria-hidden="true" alt="" width="1" height="1" style="position:fixed;opacity:0;pointer-events:none" src="/__fixture/held.png?id=${id}"></body>`
          )
        )
      }
      if (extname(target) === '.html')
        record('html-served', {
          file: filename,
          injectedHeldImage: inject,
          originalSha256: sha256(original),
          servedSha256: sha256(bytes)
        })
      response.writeHead(200, {
        'content-type': types[extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store'
      })
      response.end(bytes)
    } catch (error) {
      record('fixture-server-error', { path: url.pathname, error: details(error) })
      response.writeHead(500)
      response.end('Fixture server failed')
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    let resolveClosed
    const closed = new Promise((done) => {
      resolveClosed = done
    })
    closeWaiters.add(closed)
    socket.once('close', () => {
      sockets.delete(socket)
      closeWaiters.delete(closed)
      resolveClosed()
    })
    if (closing) socket.destroy()
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  record('server-listening', { baseUrl, productRendererRoot: rendererRoot })
  return {
    baseUrl,
    state,
    async close() {
      closing = true
      const closed = new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      )
      for (const resource of resources)
        if (!resource.response.destroyed) resource.response.destroy()
      for (const socket of sockets) socket.destroy()
      await closed
      await Promise.all([...closeWaiters])
      record('server-closed', { socketsRemaining: sockets.size })
      writeJson(join(directory, 'http-result.json'), state())
      return { serverClosed: !server.listening, socketsRemaining: sockets.size }
    }
  }
}

async function runProcess(name, profile, directory, baseUrl, deadline) {
  mkdirSync(directory, { recursive: true })
  const env = {
    ...process.env,
    ABANDON_MAIN_INITIALIZATION_CHILD: name,
    ABANDON_MAIN_INITIALIZATION_PROFILE: profile,
    ABANDON_MAIN_INITIALIZATION_EVIDENCE: directory,
    ELECTRON_RENDERER_URL: baseUrl,
    ABANDON_INTEGRATION_TEST: '1',
    ABANDON_INTEGRATION_APP_ROOT: process.cwd(),
    ABANDON_INTEGRATION_NATIVE_DLL: resolve('native_blur/build/bin/blur_engine.dll')
  }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ABANDON_TEST_RESULT_FILE',
    'ABANDON_TEST_RUN_TOKEN',
    'ABANDON_TEST_USER_DATA',
    'ABANDON_TEST_EVIDENCE_DIR'
  ])
    delete env[key]
  const result = {
    name,
    profile,
    pid: null,
    spawnedAt: Date.now(),
    exit: null,
    close: null,
    timeoutMs: Math.min(LIMITS.childMs, Math.max(1, deadline - Date.now())),
    firstFailure: null,
    forced: false,
    terminationIncomplete: false,
    diagnosticBeforeForce: false,
    outputErrors: []
  }
  const descriptors = {}
  let child,
    diagnostics,
    timer,
    fallback,
    stopping = false,
    finished = false,
    outputTail = ''
  const firstFailure = (kind, data = {}) => {
    if (result.firstFailure) return
    result.firstFailure = { kind, at: Date.now(), ...data }
    try {
      writeJson(join(directory, 'process-first-failure.json'), result.firstFailure)
    } catch (error) {
      result.outputErrors.push(error.message)
    }
  }
  await new Promise((done) => {
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(fallback)
      done()
    }
    const stop = async (reason) => {
      if (stopping || finished) return
      stopping = true
      clearTimeout(timer)
      firstFailure(reason)
      await diagnostics?.capture(reason)
      result.diagnosticBeforeForce = true
      if (finished) return
      const running = () => child && child.exitCode === null && child.signalCode === null
      if (running()) {
        result.forced = true
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.unref()
        killer.on('error', (error) => {
          result.cleanupError = error.message
          if (running()) child.kill()
        })
        killer.on('exit', (code) => {
          result.cleanupExitCode = code
          if (code !== 0 && running()) child.kill()
        })
      } else if (!result.close) result.terminationIncomplete = true
      fallback = setTimeout(() => {
        result.terminationIncomplete = true
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        child?.unref()
        finish()
      }, LIMITS.cleanupMs)
    }
    try {
      for (const stream of ['stdout', 'stderr'])
        descriptors[stream] = openSync(join(directory, stream + '.log'), 'wx')
      result.spawnedAt = Date.now()
      child = spawn(process.execPath, [SCRIPT], {
        cwd: process.cwd(),
        env,
        // Windows launch hiding suppresses GUI show in this Electron child.
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      result.pid = child.pid
      diagnostics = createFailureDiagnostics({
        gui: true,
        directory,
        command: process.execPath,
        args: [SCRIPT],
        spawnedMs: result.spawnedAt,
        pid: child.pid,
        cwd: process.cwd(),
        writeEvidence: (file, value) => writeJson(join(directory, file), value)
      })
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (chunk) => {
          try {
            let offset = 0
            while (offset < chunk.length) {
              const written = writeSync(descriptors[stream], chunk, offset, chunk.length - offset)
              if (!written) throw new Error('Output write made no progress')
              offset += written
            }
            if (stream === 'stdout') {
              const text = outputTail + chunk.toString('utf8')
              outputTail = text.slice(-FAILURE_MARKER.length)
              if (text.includes(FAILURE_MARKER)) void stop('child-reported-failure')
            }
          } catch (error) {
            result.outputErrors.push(stream + ': ' + error.message)
            firstFailure('output-write', details(error))
            void stop('output-write')
          }
        })
        child[stream].on('error', (error) => {
          result.outputErrors.push(stream + ': ' + error.message)
          firstFailure('output-stream', details(error))
          void stop('output-stream')
        })
      }
      child.once('error', (error) => firstFailure('spawn', details(error)))
      child.once('exit', (code, signal) => {
        result.exit = { code, signal, at: Date.now() }
        if (code !== 0 || signal) firstFailure('process-exit', { code, signal })
        diagnostics.exited(code, signal)
      })
      child.once('close', (code, signal) => {
        result.close = { code, signal, at: Date.now() }
        finish()
      })
      timer = setTimeout(() => {
        firstFailure('timeout', { timeoutMs: result.timeoutMs })
        void stop('timeout')
      }, result.timeoutMs)
    } catch (error) {
      firstFailure('launch', details(error))
      if (child?.pid) void stop('launch')
      else finish()
    }
  })
  result.diagnostics = await diagnostics?.finish()
  for (const [stream, descriptor] of Object.entries(descriptors)) {
    try {
      closeSync(descriptor)
    } catch (error) {
      result.outputErrors.push(stream + ': ' + error.message)
    }
  }
  result.logsSealedAt = Date.now()
  writeJson(join(directory, 'process-result.json'), result)
  return result
}

async function controller() {
  const recorder = createAssertionRecorder({
    suite: SUITE,
    mode: MODE,
    metadata: {
      realProductMainRendererPreload: true,
      realDiskSQLite: true,
      cases: CASES,
      limits: LIMITS,
      rendererTransport:
        'unchanged-built-JS-CSS-and-production-preload-served-from-test-local-HTTP',
      htmlInjection: 'only-one-same-origin-passive-hidden-image-per-controlled-target-response',
      switchCompletion: 'actual-hooks.switchMainView-promise; not-renderer-IPC-request-ACK',
      readyTransport: 'actual-production-ready-event-with-unchanged-third-argument-source-context',
      heldImagesReleasedByTest: false,
      forcedTerminationCanPass: false,
      settingFormAndFocusedInputMatrix: 'separate-settings-page-leave-electron-suite'
    }
  })
  const { assert } = recorder
  const output = process.env.ABANDON_TEST_EVIDENCE_DIR || controllerProfile.directory
  const deadline = Date.now() + LIMITS.suiteMs
  const cases = []
  let failure = null,
    completed = false,
    sources,
    evidenceStatus = 'complete'
  try {
    writeFileSync(
      join(output, 'executed-main-view-initialization-electron.mjs'),
      readFileSync(SCRIPT),
      { flag: 'wx' }
    )
    sources = fingerprints()
    writeJson(join(output, 'source-build-hashes.json'), sources)
    for (const name of CASES) {
      const profile = ownedPath(controllerProfile.directory, name)
      const directory = ownedPath(output, 'scenario-' + name)
      mkdirSync(directory, { recursive: true })
      seed(profile)
      const entry = {
        name,
        profile,
        before: databaseSnapshot(profile),
        process: null,
        serverCleanup: null
      }
      cases.push(entry)
      const http = await controlledRenderer(name, directory)
      try {
        entry.process = await runProcess(
          name,
          profile,
          join(directory, 'product'),
          http.baseUrl,
          deadline
        )
        entry.httpAfterProcess = http.state()
        const result = entry.process
        assert.equal(result.firstFailure, null)
        assert.equal(result.forced, false)
        assert.equal(result.terminationIncomplete, false)
        assert.deepEqual(result.outputErrors, [])
        assert.equal(result.exit?.code, 0)
        assert.equal(result.exit?.signal, null)
        assert.equal(result.close?.code, 0)
        assert.equal(result.close?.signal, null)
        assert.ok(result.close.at >= result.exit.at)
        const report = JSON.parse(
          readFileSync(join(directory, 'product', 'child-result.json'), 'utf8')
        )
        const trace = JSON.parse(
          readFileSync(join(directory, 'product', 'child-trace.json'), 'utf8')
        )
        entry.report = report
        assert.equal(report.completed, true)
        assert.ok(report.assertions.total > 0)
        assert.equal(report.assertions.failed, 0)
        assert.equal(report.evidence.status, 'complete')
        assert.equal(report.cleanup.status, 'preserved')
        assert.equal(report.cleanup.windowsClosed, true)
        assert.equal(report.cleanup.forcedExit, false)
        assert.equal(trace.pid, result.pid)
        assert.equal(trace.quitClicks, 1)
        assert.equal(trace.willQuitVerified, true)
        assert.equal(trace.firstFailure, null)
        const final = databaseSnapshot(profile)
        assert.equal(final.integrity, 'ok')
        assert.deepEqual(final.fonts, FONTS)
        assert.equal(final.activeView, name === CASES[0] ? 'week' : 'list')
        if (name === CASES[1])
          assert.equal(
            final.activeViewWrites.some((row) => row.value === 'month'),
            false
          )
        entry.afterExit = final
        writeJson(join(directory, 'post-exit-database.json'), final)
        const logs = shutdownRecords(profile)
        const starts = logs.filter((row) => row.scope === 'lifecycle.shutdown-start')
        const ends = logs.filter((row) => row.scope === 'lifecycle.shutdown-complete')
        assert.equal(starts.length, 1)
        assert.equal(ends.length, 1)
        assert.ok(typeof ends[0].sessionId === 'string' && ends[0].sessionId.length > 0)
        assert.equal(starts[0].sessionId, ends[0].sessionId)
        assert.equal(ends[0].pid, result.pid)
        assert.equal(ends[0].metadata.trigger, 'tray-menu')
        for (const stage of Object.values(ends[0].metadata.stages))
          assert.notEqual(stage.status, 'failed')
        for (const stage of ['business-mutations', 'settings-operations', 'database', 'tray'])
          assert.equal(ends[0].metadata.stages[stage]?.status, 'complete')
        entry.shutdownSession = ends[0].sessionId
        writeJson(join(directory, 'shutdown-session.json'), { start: starts[0], complete: ends[0] })
        assert.ok(entry.httpAfterProcess.resources.length >= (name === CASES[0] ? 2 : 1))
        assert.ok(entry.httpAfterProcess.resources.every((resource) => resource.released === false))
        assert.deepEqual(fingerprints(), sources)
      } finally {
        entry.serverCleanup = await http.close()
      }
      assert.deepEqual(entry.serverCleanup, { serverClosed: true, socketsRemaining: 0 })
    }
    assert.equal(cases.length, 2)
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  }
  try {
    writeJson(join(output, 'main-view-initialization-summary.json'), {
      completed,
      cases,
      error: failure ? details(failure) : null
    })
  } catch (error) {
    failure ||= error
    completed = false
    evidenceStatus = 'failed'
  }
  const childrenClosed = cases.every(
    (entry) =>
      !entry.process ||
      (entry.process.exit && entry.process.close && !entry.process.terminationIncomplete)
  )
  const serversClosed = cases.every(
    (entry) => entry.serverCleanup?.serverClosed && entry.serverCleanup?.socketsRemaining === 0
  )
  recorder.finish({
    completed,
    error: failure,
    evidence: {
      status: evidenceStatus,
      artifacts: [
        'source-build-hashes.json',
        'executed-main-view-initialization-electron.mjs',
        'main-view-initialization-summary.json'
      ]
    },
    profileOwnership: controllerProfile.ownership,
    cleanup: {
      status:
        !childrenClosed || !serversClosed
          ? 'failed'
          : controllerProfile.ownership === 'runner'
            ? 'complete'
            : 'preserved',
      childrenClosed,
      serversClosed,
      preservedProfile:
        controllerProfile.ownership === 'script' || failure
          ? controllerProfile.directory
          : undefined,
      scope:
        'Product child exit and stdio close precede final SQL; controller HTTP resources close separately; runner removes its profile after controller exit'
    }
  })
  // Only the controller exits explicitly. Every product child must use its single real tray intent.
  app.exit(completed && !failure ? 0 : 1)
}

async function child() {
  if (!CASES.includes(childCase)) throw new Error('Invalid main initialization child case')
  const profile = resolve(process.env.ABANDON_MAIN_INITIALIZATION_PROFILE)
  const output = resolve(process.env.ABANDON_MAIN_INITIALIZATION_EVIDENCE)
  const baseUrl = process.env.ELECTRON_RENDERER_URL
  const recorder = createAssertionRecorder({
    suite: SUITE,
    mode: MODE + '-' + childCase,
    env: {},
    metadata: {
      pid: process.pid,
      profile,
      case: childCase,
      fullProduct: true,
      heldImagesReleasedByTest: false
    }
  })
  const { assert } = recorder
  const require = createRequire(import.meta.url)
  const originalHandle = ipcMain.handle
  const originalOn = ipcMain.on
  const prepareDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'prepare')
  const closeDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'close')
  const windows = new Map(),
    readyGate = deferred(),
    hideProcessed = deferred()
  const trace = {
    pid: process.pid,
    case: childCase,
    events: [],
    sourceContexts: [],
    settingsSnapshots: [],
    readyEvents: [],
    switches: [],
    loadFinished: [],
    loadFailures: [],
    quitClicks: 0,
    firstFailure: null,
    heldReady: null,
    lateReady: null,
    firstVisible: null,
    secondHidden: null,
    deferredQuit: null,
    rollbackBeforeLate: null,
    rollbackAfterLate: null,
    atDatabaseClose: null,
    descriptorsRestored: false,
    willQuitVerified: false
  }
  let sequence = 0,
    phase = 'startup',
    current,
    mainInfo,
    hooks,
    appDatabase,
    heldDelivery
  let failed = false,
    reachedWillQuit = false,
    finalized = false,
    evidenceWritten = false
  const record = (event, value = {}) => {
    const entry = { sequence: ++sequence, event, at: Date.now(), phase, pid: process.pid, ...value }
    trace.events.push(entry)
    appendFileSync(join(output, 'events.jsonl'), JSON.stringify(entry) + '\n')
    return entry
  }
  const exitEvent = (event, value = {}) =>
    appendFileSync(
      join(output, 'gui-exit-events.jsonl'),
      JSON.stringify({
        event,
        pid: process.pid,
        suite: SUITE,
        time: new Date().toISOString(),
        ...value
      }) + '\n'
    )
  const restore = () => {
    if (trace.descriptorsRestored) return
    ipcMain.handle = originalHandle
    ipcMain.on = originalOn
    Object.defineProperty(Database.prototype, 'prepare', prepareDescriptor)
    Object.defineProperty(Database.prototype, 'close', closeDescriptor)
    trace.descriptorsRestored = true
  }
  const fail = (error) => {
    if (failed) return
    failed = true
    trace.firstFailure = details(error)
    process.exitCode = 1
    restore()
    try {
      record('child-first-failure', trace.firstFailure)
      writeJson(join(output, 'child-first-failure.json'), trace)
    } catch (evidenceError) {
      process.stderr.write((evidenceError.stack || String(evidenceError)) + '\n')
    }
    process.stderr.write((error.stack || String(error)) + '\n')
    // The controller obtains external diagnostics before owned cleanup. Never
    // release a failed gate, destroy a product window, retry, or issue another quit.
    process.stdout.write(FAILURE_MARKER)
  }
  async function bounded(promise, label, timeoutMs = LIMITS.queryMs) {
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
  async function until(read, label) {
    const deadline = Date.now() + LIMITS.queryMs
    while (Date.now() < deadline) {
      if (failed) throw new Error('This child already failed')
      const value = await bounded(Promise.resolve().then(read), label)
      if (value) return value
      await wait(10)
    }
    throw new Error(phase + ': ' + label)
  }
  // WebContents.executeJavaScript implicitly waits for load completion. This test
  // queries the actual current frame, so its own observations cannot release or wait on the tail.
  const js = (source) =>
    bounded(
      current.webContents.mainFrame.executeJavaScript(source),
      'Current main-frame query timed out'
    )
  const httpState = () =>
    bounded(
      fetch(baseUrl + '/__fixture/state').then((response) => {
        if (!response.ok) throw new Error('HTTP fixture state unavailable')
        return response.json()
      }),
      'HTTP state query timed out'
    )
  const windowState = () => ({
    id: mainInfo.id,
    senderId: mainInfo.senderId,
    hwnd: mainInfo.hwnd,
    destroyed: current.isDestroyed(),
    visible: current.isDestroyed() ? false : current.isVisible(),
    focused: current.isDestroyed() ? false : current.isFocused(),
    showEvents: mainInfo.showEvents,
    focusEvents: mainInfo.focusEvents,
    url: current.isDestroyed() ? null : current.webContents.getURL()
  })
  function observeWindow(window) {
    const info = {
      window,
      id: window.id,
      senderId: window.webContents.id,
      hwnd: window.getNativeWindowHandle().toString('hex'),
      showEvents: 0,
      focusEvents: 0
    }
    windows.set(info.id, info)
    record('window-created', {
      id: info.id,
      senderId: info.senderId,
      role: 'unclassified-at-construction'
    })
    for (const event of ['show', 'hide', 'focus', 'blur'])
      window.on(event, () => {
        if (event === 'show') info.showEvents += 1
        if (event === 'focus') info.focusEvents += 1
        record('window-' + event, { id: info.id, senderId: info.senderId })
      })
    window.once('closed', () => record('window-closed', { id: info.id, senderId: info.senderId }))
    window.webContents.on('did-navigate', (_event, url) =>
      record('did-navigate', { senderId: info.senderId, url })
    )
    window.webContents.on('did-finish-load', () => {
      const value = { senderId: info.senderId, url: window.webContents.getURL() }
      trace.loadFinished.push(value)
      record('did-finish-load', value)
    })
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      const value = { senderId: info.senderId, code, description, url, isMainFrame }
      trace.loadFailures.push(value)
      record('did-fail-load', value)
    })
  }
  app.on('browser-window-created', (_event, window) => observeWindow(window))
  Object.defineProperty(Database.prototype, 'prepare', {
    ...prepareDescriptor,
    value: function (...args) {
      const statement = Reflect.apply(prepareDescriptor.value, this, args)
      if (!appDatabase && this.name && samePath(this.name, join(profile, 'app.db'))) {
        appDatabase = this
        record('production-database-observed')
      }
      return statement
    }
  })
  Object.defineProperty(Database.prototype, 'close', {
    ...closeDescriptor,
    value: function (...args) {
      const owned = this === appDatabase
      if (owned) {
        try {
          trace.atDatabaseClose = {
            window: windowState(),
            navigation: hooks.navigationState(),
            shutdown: hooks.shutdownState(),
            storage: databaseSnapshot(profile)
          }
          record('production-database-close-start', trace.atDatabaseClose)
          assert.equal(
            trace.atDatabaseClose.storage.activeView,
            childCase === CASES[0] ? 'week' : 'list'
          )
          if (childCase === CASES[1]) assert.equal(trace.lateReady?.completed, true)
        } catch (error) {
          fail(error)
        }
      }
      const result = Reflect.apply(closeDescriptor.value, this, args)
      if (owned) record('production-database-close-complete', { open: this.open })
      return result
    }
  })
  ipcMain.handle = function (channel, listener) {
    if (!['settings:write-context', 'get-settings-snapshot'].includes(channel))
      return originalHandle.call(this, channel, listener)
    return originalHandle.call(this, channel, (event, ...args) => {
      const result = listener(event, ...args)
      const observed = (value) => {
        const base = { senderId: event.sender.id, url: event.senderFrame?.url }
        if (channel === 'settings:write-context') {
          const entry = { ...base, context: value }
          trace.sourceContexts.push(entry)
          record('source-context-issued', entry)
        } else {
          const entry = { ...base, fontSize: value?.values?.css?.fontSizeBase }
          trace.settingsSnapshots.push(entry)
          record('settings-snapshot-returned', entry)
        }
        return value
      }
      return result && typeof result.then === 'function' ? result.then(observed) : observed(result)
    })
  }
  function forwardReady(delivery, stale = false) {
    record(stale ? 'late-ready-forwarded' : 'ready-forwarded', {
      viewMode: delivery.payload.viewMode,
      context: delivery.context,
      capturedUrl: delivery.url,
      transport: 'original-already-received-IPC-event'
    })
    try {
      const value = delivery.listener(delivery.event, delivery.payload, delivery.context)
      return Promise.resolve(value).then(
        (result) => {
          record(stale ? 'late-ready-returned' : 'ready-returned', {
            viewMode: delivery.payload.viewMode
          })
          return { returned: true, result }
        },
        (error) => {
          record(stale ? 'late-ready-rejected' : 'ready-rejected', details(error))
          if (!stale) throw error
          return { returned: false, error: details(error) }
        }
      )
    } catch (error) {
      record(stale ? 'late-ready-rejected' : 'ready-rejected', details(error))
      if (!stale) return Promise.reject(error)
      return Promise.resolve({ returned: false, error: details(error) })
    }
  }
  ipcMain.on = function (channel, listener) {
    if (channel === 'renderer-ready')
      return originalOn.call(this, channel, (event, payload, context) => {
        const value = {
          senderId: event.sender.id,
          viewMode: payload?.viewMode,
          context,
          url: event.senderFrame?.url,
          receivedAt: Date.now()
        }
        trace.readyEvents.push(value)
        record('renderer-ready-received', value)
        const delivery = { listener, event, payload, context, url: value.url }
        const holdMode = childCase === CASES[0] ? 'week' : 'month'
        if (payload?.viewMode === holdMode && !heldDelivery) {
          heldDelivery = delivery
          trace.heldReady = value
          record('renderer-ready-held', value)
          readyGate.resolve()
          return
        }
        void forwardReady(delivery).catch(fail)
      })
    if (channel === 'window-close')
      return originalOn.call(this, channel, (event, ...args) => {
        const result = listener(event, ...args)
        record('production-preload-hide-processed', { senderId: event.sender.id })
        hideProcessed.resolve()
        return result
      })
    return originalOn.call(this, channel, listener)
  }
  function startSwitch(mode) {
    const value = { target: mode, startedAt: Date.now(), settled: false }
    trace.switches.push(value)
    record('switch-started', value)
    const outcome = Promise.resolve(hooks.switchMainView(mode)).then(
      (result) => {
        value.result = result
        value.settled = true
        value.elapsedMs = Date.now() - value.startedAt
        record('switch-returned', { ...value, navigation: hooks.navigationState() })
        return value
      },
      (error) => {
        value.error = details(error)
        value.settled = true
        record('switch-threw', value)
        throw error
      }
    )
    return { value, outcome }
  }
  function trayQuit() {
    const item = hooks.getTrayMenuTemplate().find((value) => value.label === '退出应用')
    assert.equal(typeof item?.click, 'function')
    assert.equal(trace.quitClicks, 0)
    trace.quitClicks += 1
    trace.quitRequestedAt = Date.now()
    record('tray-quit-click', { quitClicks: trace.quitClicks })
    exitEvent('finish-start', { ownedProductQuit: true })
    item.click()
  }
  function assertSource(mode) {
    const scope = mode === 'list' ? 'main' : mode
    const ready = trace.readyEvents.findLast((value) => value.viewMode === mode)
    assert.ok(ready)
    assert.equal(typeof ready.context?.token, 'string')
    assert.equal(ready.context.scope, scope)
    const issued = trace.sourceContexts.findLast(
      (value) => value.senderId === ready.senderId && value.context?.token === ready.context.token
    )
    assert.ok(issued, 'The real ready uses the actual cached context issued to this document')
    assert.equal(issued.context.scope, scope)
    assert.ok(
      trace.settingsSnapshots.some(
        (value) => value.url === ready.url && value.fontSize === FONTS[scope]
      )
    )
    return ready
  }
  async function assertHeld(id) {
    const state = await until(async () => {
      const value = await httpState()
      return (
        value.resources.some((resource) => resource.id === id && resource.closedAt === null) &&
        value
      )
    }, 'Actual HTTP image response is not held: ' + id)
    assert.equal(state.resources.find((resource) => resource.id === id).released, false)
    assert.equal(current.webContents.isLoading(), true)
    assert.equal(
      trace.loadFinished.some(
        (value) =>
          new URL(value.url).pathname === (id.startsWith('month') ? '/month.html' : '/week.html')
      ),
      false
    )
    return state
  }
  async function domState() {
    return js(`(() => ({title:document.title, appChildren:document.querySelector('#app')?.children.length,
      titlebar:Boolean(document.querySelector('.app-titlebar')),
      font:getComputedStyle(document.documentElement).getPropertyValue('--font-size-base').trim()}))()`)
  }
  app.on('will-quit', () => {
    if (reachedWillQuit) return
    reachedWillQuit = true
    record('will-quit')
    exitEvent('will-quit')
    try {
      if (failed) return
      assert.equal(trace.quitClicks, 1)
      const shutdown = hooks.shutdownState()
      assert.equal(shutdown.completed, true)
      assert.equal(shutdown.trigger, 'tray-menu')
      for (const value of Object.values(shutdown.stages)) assert.notEqual(value.status, 'failed')
      for (const stage of ['business-mutations', 'settings-operations', 'database', 'tray'])
        assert.equal(shutdown.stages[stage]?.status, 'complete')
      assert.equal(appDatabase.open, false)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      assert.ok([...windows.values()].every((value) => value.window.isDestroyed()))
      const final = databaseSnapshot(profile)
      assert.equal(final.integrity, 'ok')
      assert.deepEqual(final.fonts, FONTS)
      assert.equal(final.activeView, childCase === CASES[0] ? 'week' : 'list')
      if (childCase === CASES[0]) {
        assert.equal(trace.switches.length, 2)
        assert.ok(trace.switches.every((value) => value.result === true))
        assert.equal(trace.secondHidden.window.visible, false)
        assert.equal(trace.secondHidden.window.focused, false)
      } else {
        assert.equal(trace.switches[0].result, false)
        assert.equal(trace.lateReady?.completed, true)
        assert.equal(
          final.activeViewWrites.some((row) => row.value === 'month'),
          false
        )
        assert.equal(trace.deferredQuit.deferredQuit, true)
      }
      trace.finalStorage = final
      trace.shutdown = shutdown
      trace.willQuitVerified = true
      evidenceWritten = true
    } catch (error) {
      fail(error)
    } finally {
      restore()
    }
  })
  app.once('quit', (_event, code) => {
    restore()
    record('quit', { code })
    exitEvent('quit', { code })
    if (finalized) return
    finalized = true
    try {
      assert.equal(code, 0)
      assert.equal(failed, false)
      assert.equal(trace.willQuitVerified, true)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
    } catch (error) {
      fail(error)
    }
    try {
      writeJson(join(output, 'child-trace.json'), trace)
      const result = recorder.finish({
        completed:
          !failed && evidenceWritten && reachedWillQuit && trace.quitClicks === 1 && code === 0,
        error: trace.firstFailure ? JSON.stringify(trace.firstFailure) : undefined,
        evidence: {
          status: evidenceWritten ? 'complete' : 'incomplete',
          artifacts: ['child-trace.json', 'events.jsonl', 'gui-exit-events.jsonl']
        },
        profileOwnership: 'script',
        cleanup: {
          status: !failed && reachedWillQuit ? 'preserved' : 'failed',
          windowsClosed: BrowserWindow.getAllWindows().length === 0,
          forcedExit: false,
          reachedWillQuit,
          exitCode: code,
          descriptorsRestored: trace.descriptorsRestored,
          preservedProfile: profile
        }
      })
      writeJson(join(output, 'child-result.json'), result)
    } catch (error) {
      fail(error)
    }
  })
  async function run() {
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() &&
            window.webContents.getURL().startsWith(baseUrl) &&
            new URL(window.webContents.getURL()).pathname === '/'
        ),
      'The actual HTTP-served main window did not load'
    )
    mainInfo = windows.get(current.id)
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    for (const name of [
      'switchMainView',
      'navigationState',
      'shutdownState',
      'getTrayMenuTemplate',
      'nativeCaptureState',
      'trayState'
    ])
      assert.equal(typeof hooks?.[name], 'function')
    await until(
      () => current.isVisible() && hooks.nativeCaptureState().ready && hooks.trayState().created,
      'Full product startup prerequisites did not complete'
    )
    await until(
      async () => (await domState()).titlebar,
      'The actual production list renderer was not ready'
    )
    await until(
      () => trace.readyEvents.some((value) => value.viewMode === 'list'),
      'The actual initial list ready event was not observed'
    )
    assert.equal(appDatabase?.open, true)
    assertSource('list')
    const initial = databaseSnapshot(profile)
    assert.equal(initial.activeView, 'list')
    assert.deepEqual(initial.fonts, FONTS)
    trace.originalWindow = windowState()
    if (childCase === CASES[0]) {
      phase = 'first-ready-before-held-load'
      const first = startSwitch('month')
      assert.equal(
        (
          await bounded(
            first.outcome,
            'First real switch remained blocked by its load tail',
            LIMITS.switchMs
          )
        ).result,
        true
      )
      const held = await assertHeld('month-1')
      assertSource('month')
      const dom = await domState()
      assert.equal(dom.titlebar, true)
      assert.ok(dom.appChildren > 0)
      assert.equal(dom.font, '23rem')
      await until(
        () => current.isFocused(),
        'Actual ready presentation did not focus the visible main window'
      )
      assert.equal(current.isVisible(), true)
      assert.equal(current.id, trace.originalWindow.id)
      assert.equal(current.getNativeWindowHandle().toString('hex'), trace.originalWindow.hwnd)
      assert.equal(databaseSnapshot(profile).activeView, 'month')
      trace.firstVisible = {
        window: windowState(),
        dom,
        http: held,
        storage: databaseSnapshot(profile)
      }
      record('first-ready-visible-with-load-held', trace.firstVisible)
      phase = 'second-switch-before-first-tail-release'
      const second = startSwitch('week')
      const boundary = await bounded(
        Promise.race([
          readyGate.promise.then(() => ({ held: true })),
          second.outcome.then((value) => ({ held: false, value }))
        ]),
        'Second switch neither reached ready nor settled',
        LIMITS.switchMs
      )
      if (!boundary.held)
        assert.equal(
          boundary.value.result,
          true,
          'A second effective switch must work while the first load tail remains unreleased'
        )
      assert.equal(
        boundary.held,
        true,
        'The actual second renderer ready must be observed before business completion'
      )
      assert.equal(second.value.settled, false)
      assertSource('week')
      await assertHeld('week-1')
      await js('window.api.closeWindow()')
      await bounded(hideProcessed.promise, 'The real preload user-hide request did not run')
      assert.equal(current.isVisible(), false)
      assert.equal(current.isFocused(), false)
      const afterHide = windowState()
      record('user-hidden-before-second-ready', afterHide)
      await forwardReady(heldDelivery)
      assert.equal(
        (
          await bounded(
            second.outcome,
            'Hidden target ready did not settle the real second switch',
            LIMITS.switchMs
          )
        ).result,
        true
      )
      assert.equal(current.isVisible(), false)
      assert.equal(current.isFocused(), false)
      assert.equal(mainInfo.showEvents, afterHide.showEvents)
      assert.equal(mainInfo.focusEvents, afterHide.focusEvents)
      const secondDom = await domState()
      assert.equal(secondDom.titlebar, true)
      assert.equal(secondDom.font, '21rem')
      const storage = databaseSnapshot(profile)
      assert.equal(storage.activeView, 'week')
      assert.deepEqual(storage.fonts, FONTS)
      const http = await httpState()
      assert.ok(http.resources.every((value) => value.released === false))
      trace.secondHidden = { window: windowState(), dom: secondDom, storage, http }
      record('second-switch-hidden-complete', trace.secondHidden)
      phase = 'normal-quit-with-second-load-tail-held'
      trayQuit()
    } else {
      phase = 'ready-and-load-held-before-deferred-quit'
      const switching = startSwitch('month')
      await bounded(readyGate.promise, 'Actual month ready did not reach its test gate')
      await assertHeld('month-1')
      assertSource('month')
      assert.equal(switching.value.settled, false)
      trayQuit()
      trace.deferredQuit = hooks.shutdownState()
      record('single-quit-deferred-by-navigation', trace.deferredQuit)
      assert.equal(trace.deferredQuit.quitRequested, true)
      assert.equal(trace.deferredQuit.deferredQuit, true)
      assert.equal(trace.deferredQuit.quitting, false)
      assert.equal(trace.deferredQuit.startedAt, null)
      phase = 'original-fifteen-second-deadline-and-rollback'
      const result = await bounded(
        switching.outcome,
        'Original navigation deadline did not fail and roll back',
        LIMITS.switchMs
      )
      assert.equal(result.result, false)
      assert.ok(result.elapsedMs >= 14900, 'The original 15-second deadline must not be shortened')
      assert.ok(
        result.elapsedMs <= 18000,
        'Held load must not extend the original initialization deadline'
      )
      trace.rollbackBeforeLate = {
        window: windowState(),
        navigation: hooks.navigationState(),
        storage: databaseSnapshot(profile)
      }
      assert.equal(trace.rollbackBeforeLate.navigation.mode, 'list')
      assert.equal(trace.rollbackBeforeLate.storage.activeView, 'list')
      assert.equal(
        trace.rollbackBeforeLate.storage.activeViewWrites.some((row) => row.value === 'month'),
        false
      )
      assert.deepEqual(trace.rollbackBeforeLate.storage.fonts, FONTS)
      record('rollback-committed-before-old-ready', trace.rollbackBeforeLate)
      phase = 'old-ready-after-rollback-and-dispose'
      const outcome = await forwardReady(heldDelivery, true)
      trace.lateReady = {
        completed: true,
        outcome,
        context: heldDelivery.context,
        transport: 'original-already-received-month-IPC-after-rollback; no-new-page-send'
      }
      trace.rollbackAfterLate = {
        window: windowState(),
        navigation: hooks.navigationState(),
        storage: databaseSnapshot(profile)
      }
      assert.equal(
        trace.rollbackAfterLate.window.showEvents,
        trace.rollbackBeforeLate.window.showEvents
      )
      assert.equal(
        trace.rollbackAfterLate.window.focusEvents,
        trace.rollbackBeforeLate.window.focusEvents
      )
      assert.equal(trace.rollbackAfterLate.storage.activeView, 'list')
      assert.equal(
        trace.rollbackAfterLate.storage.activeViewWrites.some((row) => row.value === 'month'),
        false
      )
      record('old-ready-has-no-presentation-or-commit-effect', {
        lateReady: trace.lateReady,
        after: trace.rollbackAfterLate
      })
      // The one deferred production tray intent resumes automatically. No second quit or manual destruction.
    }
  }
  try {
    app.setPath('userData', profile)
    assert.equal(existsSync(join(profile, 'app.db')), true)
    require(resolve('out/main/index.js'))
    const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
      /^index-[\w-]+\.js$/.test(name)
    )
    assert.ok(chunk)
    require(resolve('out/main/chunks', chunk))
    if (app.isReady()) void run().catch(fail)
    else app.once('ready', () => void run().catch(fail))
  } catch (error) {
    fail(error)
  }
}

if (childCase)
  void child().catch((error) => {
    process.stderr.write((error.stack || String(error)) + '\n')
    process.stdout.write(FAILURE_MARKER)
  })
else
  app
    .whenReady()
    .then(controller)
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
