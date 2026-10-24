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

const SUITE = 'tests/main-view-startup-electron.mjs'
const MODE = 'electron-real-app-main-view-startup-ready-lifecycle'
const SCRIPT = fileURLToPath(import.meta.url)
const CASES = [
  'startup-ready-tail-notification-late-load',
  'startup-ready-timeout-retry',
  'startup-hide-before-ready',
  'startup-quit-before-ready',
  'startup-load-failure-retry-quit',
  'startup-exposed-presentation-failure-draft-quit'
]
const LIMITS = Object.freeze({
  childMs: 45000,
  queryMs: 12000,
  switchMs: 22000,
  cleanupMs: 5000,
  suiteMs: 240000
})
const FONTS = Object.freeze({ main: 16, month: 23, week: 21 })
const FAILURE_MARKER = 'main-view-startup-first-failure\n'
const childCase = process.env.ABANDON_MAIN_STARTUP_CHILD
const controllerProfile = childCase ? null : prepareTestProfile({ prefix: 'abandon-main-startup-' })
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
function persistedNotes(profile) {
  const database = new Database(join(profile, 'app.db'), { readonly: true, fileMustExist: true })
  try {
    return database
      .prepare('SELECT id,content,status,effective_at,is_deleted FROM notes ORDER BY id')
      .all()
  } finally {
    database.close()
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
    'src/main/services/notification-activation.js',
    'src/main/settings/application-settings.js',
    'src/main/application/shutdown-coordinator.js',
    'src/main/settings/settings-operation-admission.js',
    'src/main/db/db-settings-repository.js',
    'src/preload/index.js',
    'src/preload/settings-client.js',
    'src/renderer/src/composables/useWorkspaceRuntime.js',
    'src/renderer/src/composables/useDraftProtection.js',
    'src/renderer/src/components/list/NewNotePanel.vue',
    'src/renderer/src/components/list/ActionBar.vue',
    'src/renderer/src/components/system/EditingDraftDialog.vue',
    'src/renderer/src/components/ui/ConfirmDialog.vue',
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
    allowInitialLoad = name !== CASES[4],
    sequence = 0
  const record = (event, data = {}) => {
    const value = { sequence: ++sequence, at: Date.now(), event, ...data }
    events.push(value)
    appendFileSync(join(directory, 'http-events.jsonl'), JSON.stringify(value) + '\n')
  }
  const state = () => ({
    allowInitialLoad,
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
    if (url.pathname === '/__fixture/allow-load' && request.method === 'POST') {
      allowInitialLoad = true
      record('explicit-user-retry-load-enabled')
      response.writeHead(200)
      response.end('ok')
      return
    }
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
      if (target === join(rendererRoot, 'index.html') && !allowInitialLoad) {
        record('initial-main-document-connection-aborted', { url: url.pathname })
        request.socket.destroy()
        return
      }
      const original = readFileSync(target)
      let bytes = original
      const filename = relative(rendererRoot, target).replaceAll('\\', '/')
      const inject = name === CASES[0] && filename === 'index.html'
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
    ABANDON_MAIN_STARTUP_CHILD: name,
    ABANDON_MAIN_STARTUP_PROFILE: profile,
    ABANDON_MAIN_STARTUP_EVIDENCE: directory,
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

function applicationRecords(profile) {
  const directory = join(profile, 'logs')
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((file) => /^app-.*\.jsonl$/.test(file))
    .sort()
    .flatMap((file) =>
      readFileSync(join(directory, file), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return [] // A live logger may still be appending its final line.
          }
        })
    )
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
      initialDeadlineMs: 15000,
      rendererTransport: 'formal-built-JS-CSS-and-production-preload-over-owned-loopback-http',
      readyTransport: 'retained-real-IPC-event-and-original-source-context-no-forged-sender',
      retry: 'actual-production-open-main-window-tray-callback',
      unavailableQuit: 'actual-single-tray-intent-with-zero-renderer-draft-guard-requests',
      heldImagesReleasedByTest: false,
      nativeToastUiClick: false,
      forcedTerminationCanPass: false
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
    writeFileSync(join(output, 'executed-main-view-startup-electron.mjs'), readFileSync(SCRIPT), {
      flag: 'wx'
    })
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
      if (name === CASES[5]) entry.initialNotes = persistedNotes(profile)
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
        assert.equal(final.activeView, name === CASES[0] ? 'month' : 'list')
        if (name !== CASES[0])
          assert.ok(final.activeViewWrites.every((row) => row.value === 'list'))
        entry.afterExit = final
        if (name === CASES[5]) {
          entry.finalNotes = persistedNotes(profile)
          assert.deepEqual(
            entry.finalNotes,
            entry.initialNotes,
            'Unsaved UI draft never creates or changes persisted business notes'
          )
          assert.equal(trace.injectedPresentationFailure.nativeFocusCalled, false)
          assert.equal(trace.draftQuitConfirmation.clicked, true)
          assert.equal(trace.draftQuitConfirmation.confirmText, '保留并退出')
          assert.equal(trace.draftQuitConfirmation.visible, true)
          assert.equal(trace.draftQuitConfirmation.sameInitialization, true)
          assert.equal(trace.draftQuitConfirmation.sameLoad, true)
          assert.equal(
            sha256(
              readFileSync(join(directory, 'product', 'exposed-failure-draft-confirmation.png'))
            ),
            trace.draftQuitConfirmation.screenshotSha256
          )
        }
        writeJson(join(directory, 'post-exit-database.json'), final)
        const logs = shutdownRecords(profile)
        const starts = logs.filter((row) => row.scope === 'lifecycle.shutdown-start')
        const ends = logs.filter((row) => row.scope === 'lifecycle.shutdown-complete')
        assert.equal(starts.length, 1)
        assert.equal(ends.length, 1)
        assert.equal(starts[0].sessionId, ends[0].sessionId)
        assert.equal(ends[0].pid, result.pid)
        assert.equal(ends[0].metadata.trigger, 'tray-menu')
        for (const stage of ['business-mutations', 'settings-operations', 'database', 'tray'])
          assert.equal(ends[0].metadata.stages[stage]?.status, 'complete')
        for (const stage of Object.values(ends[0].metadata.stages))
          assert.notEqual(stage.status, 'failed')
        entry.shutdownSession = ends[0].sessionId
        writeJson(join(directory, 'shutdown-session.json'), { start: starts[0], complete: ends[0] })
        entry.httpAfterProcess = http.state()
        assert.ok(entry.httpAfterProcess.resources.every((resource) => resource.released === false))
        if (name === CASES[0]) {
          assert.equal(entry.httpAfterProcess.resources.length, 1)
          const shown = applicationRecords(profile).filter(
            (row) => row.scope === 'notification.reveal' && row.metadata?.result === 'shown'
          )
          assert.equal(
            shown.length,
            1,
            'formal notification open completed while its initial load tail was held'
          )
          assert.equal(shown[0].pid, result.pid)
          entry.notificationShown = shown[0]
        }
        if ([CASES[1], CASES[3]].includes(name)) {
          const stale = applicationRecords(profile).filter(
            (row) =>
              row.scope === 'renderer.ready-stale' &&
              row.metadata?.code === 'SETTINGS_SOURCE_EXPIRED'
          )
          assert.ok(
            stale.length > 0,
            'The real old source was rejected by the production IPC entry'
          )
          entry.expiredReadyRejections = stale
        }
        assert.deepEqual(fingerprints(), sources)
      } finally {
        entry.serverCleanup = await http.close()
      }
      assert.deepEqual(entry.serverCleanup, { serverClosed: true, socketsRemaining: 0 })
    }
    assert.equal(cases.length, 6)
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  }
  try {
    writeJson(join(output, 'main-view-startup-summary.json'), {
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
        'executed-main-view-startup-electron.mjs',
        'main-view-startup-summary.json'
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
        'Product child exit and stdio close precede final SQL; controller HTTP sockets close separately'
    }
  })
  // Product children must use exactly one real tray quit, never app.exit or destruction for success.
  app.exit(completed && !failure ? 0 : 1)
}

async function child() {
  if (!CASES.includes(childCase)) throw new Error('Invalid startup child case')
  const profile = resolve(process.env.ABANDON_MAIN_STARTUP_PROFILE)
  const output = resolve(process.env.ABANDON_MAIN_STARTUP_EVIDENCE)
  const baseUrl = process.env.ELECTRON_RENDERER_URL
  const recorder = createAssertionRecorder({
    suite: SUITE,
    mode: MODE + '-' + childCase,
    env: {},
    metadata: { fullProduct: true, pid: process.pid, case: childCase, profile }
  })
  const { assert } = recorder
  const require = createRequire(import.meta.url)
  const originalOn = ipcMain.on
  const originalHandle = ipcMain.handle
  const prepareDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'prepare')
  const closeDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'close')
  const windows = new Map(),
    frameRestores = [],
    wrappedFrames = new WeakSet()
  const readyDeliveries = [],
    snapshotDeliveries = []
  const trace = {
    pid: process.pid,
    case: childCase,
    events: [],
    sourceContexts: [],
    readyEvents: [],
    guardRequests: [],
    loads: [],
    quitClicks: 0,
    openClicks: 0,
    firstFailure: null,
    willQuitVerified: false,
    descriptorsRestored: false
  }
  let phase = 'startup',
    current,
    mainInfo,
    hooks,
    appDatabase,
    sequence = 0
  let failed = false,
    reachedWillQuit = false,
    finalized = false,
    evidenceWritten = false
  const holdSnapshots = childCase === CASES[4]
  let databaseCloseLateReady = null,
    hideProcessed = 0
  const readSafely = (read) => {
    try {
      return read()
    } catch (error) {
      return { observationError: error.message }
    }
  }
  function windowState(info = mainInfo) {
    if (!info) return null
    const destroyed = readSafely(() => info.window.isDestroyed())
    const contentsDestroyed = readSafely(() => info.contents.isDestroyed())
    return {
      id: info.id,
      senderId: info.senderId,
      hwnd: info.hwnd,
      destroyed,
      contentsDestroyed,
      visible:
        destroyed === false
          ? readSafely(() => info.window.isVisible())
          : destroyed === true
            ? false
            : destroyed,
      focused:
        destroyed === false
          ? readSafely(() => info.window.isFocused())
          : destroyed === true
            ? false
            : destroyed,
      url: contentsDestroyed === false ? readSafely(() => info.contents.getURL()) : null,
      calls: { ...info.calls },
      documents: info.documents
    }
  }
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
  function restore() {
    if (trace.descriptorsRestored) return
    ipcMain.on = originalOn
    ipcMain.handle = originalHandle
    Object.defineProperty(Database.prototype, 'prepare', prepareDescriptor)
    Object.defineProperty(Database.prototype, 'close', closeDescriptor)
    for (const undo of frameRestores.splice(0)) undo()
    trace.descriptorsRestored = true
  }
  function fail(error) {
    if (failed) return
    failed = true
    trace.firstFailure = details(error)
    process.exitCode = 1
    record('child-first-failure', {
      error: trace.firstFailure,
      window: windowState(),
      navigation: hooks?.navigationState()
    })
    writeJson(join(output, 'child-first-failure.json'), trace)
    process.stderr.write((error.stack || String(error)) + '\n')
    // Preserve the failed product until the parent records external diagnostics.
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
  async function until(read, label, timeoutMs = LIMITS.queryMs) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (failed) throw new Error('This child already failed')
      const value = await bounded(Promise.resolve().then(read), label)
      if (value) return value
      await wait(10)
    }
    throw new Error(phase + ': ' + label)
  }
  const js = (source) =>
    bounded(
      current.webContents.mainFrame.executeJavaScript(source),
      'Captured current-frame query timed out'
    )
  const httpState = () =>
    bounded(
      fetch(baseUrl + '/__fixture/state').then((response) => response.json()),
      'HTTP fixture state query timed out'
    )
  const initialization = () => hooks.navigationState().initialization
  const presentation = () => ({ ...mainInfo.calls })
  function assertUnchangedPresentation(before) {
    assert.deepEqual(presentation(), before, 'late or hidden work must not show/focus')
  }
  function observeFrame(contents) {
    const frame = contents.mainFrame
    if (wrappedFrames.has(frame)) return
    wrappedFrames.add(frame)
    const original = frame.executeJavaScript
    const wrapper = function (source, ...args) {
      if (/__preparePageLeave|__prepareEditingDrafts|__confirmEditingDrafts/.test(source)) {
        const entry = {
          source,
          phase,
          at: Date.now(),
          senderId: contents.id,
          document: mainInfo?.documents
        }
        trace.guardRequests.push(entry)
        record('renderer-guard-request', entry)
      }
      return original.call(this, source, ...args)
    }
    frame.executeJavaScript = wrapper
    frameRestores.push(() => {
      try {
        if (!frame.isDestroyed() && frame.executeJavaScript === wrapper)
          frame.executeJavaScript = original
      } catch {
        /* A destroyed wrapper owns no live renderer work. */
      }
    })
  }
  app.on('browser-window-created', (_event, window) => {
    const contents = window.webContents
    const info = {
      window,
      contents,
      id: window.id,
      senderId: contents.id,
      hwnd: window.getNativeWindowHandle().toString('hex'),
      calls: { show: 0, showInactive: 0, focus: 0 },
      documents: 0
    }
    windows.set(info.id, info)
    for (const method of Object.keys(info.calls)) {
      const original = window[method]
      window[method] = function (...args) {
        info.calls[method] += 1
        record('window-presentation-call', { method, window: windowState(info) })
        if (
          childCase === CASES[5] &&
          method === 'focus' &&
          info.calls.show > 0 &&
          trace.loads.some((load) => load.windowId === info.id && load.url.startsWith(baseUrl)) &&
          !trace.injectedPresentationFailure
        ) {
          const error = Object.assign(
            new Error('E2.5 controlled first native focus failure after exposure'),
            { code: 'E2_5_CONTROLLED_INITIAL_FOCUS_FAILURE' }
          )
          trace.injectedPresentationFailure = {
            at: Date.now(),
            windowId: info.id,
            error: details(error),
            nativeFocusCalled: false
          }
          record(
            'first-focus-after-show-thrown-before-native-call',
            trace.injectedPresentationFailure
          )
          throw error
        }
        return original.apply(this, args)
      }
    }
    for (const event of ['show', 'hide', 'focus', 'blur', 'closed'])
      window.on(event, () => record('window-' + event, { window: windowState(info) }))
    contents.on('did-navigate', (_event, url) => {
      info.documents += 1
      observeFrame(contents)
      record('document-committed', { id: info.id, document: info.documents, url })
    })
    contents.on('did-finish-load', () =>
      record('did-finish-load', {
        id: info.id,
        document: info.documents,
        url: readSafely(() => contents.getURL())
      })
    )
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) =>
      record('did-fail-load', { id: info.id, code, description, url, isMainFrame })
    )
    const originalLoad = window.loadURL
    window.loadURL = function (...args) {
      const entry = {
        id: trace.loads.length + 1,
        windowId: info.id,
        url: args[0],
        requestedAt: Date.now(),
        state: 'pending'
      }
      trace.loads.push(entry)
      record('native-load-request', entry)
      const result = originalLoad.apply(this, args)
      void Promise.resolve(result).then(
        () => {
          entry.state = 'fulfilled'
          entry.settledAt = Date.now()
          record('native-load-fulfilled', { ...entry })
        },
        (error) => {
          entry.state = 'rejected'
          entry.error = details(error)
          entry.settledAt = Date.now()
          record('native-load-rejected', { ...entry })
        }
      )
      return result
    }
    record('window-created', { window: windowState(info) })
  })
  Object.defineProperty(Database.prototype, 'prepare', {
    ...prepareDescriptor,
    value: function (...args) {
      const statement = Reflect.apply(prepareDescriptor.value, this, args)
      if (!appDatabase && this.name && samePath(this.name, join(profile, 'app.db')))
        appDatabase = this
      return statement
    }
  })
  function forwardReady(delivery, label) {
    record('actual-ready-forward-before', {
      label,
      context: delivery.context,
      viewMode: delivery.payload.viewMode,
      capturedUrl: delivery.url,
      navigation: hooks?.navigationState()
    })
    delivery.listener(delivery.event, delivery.payload, delivery.context)
    record('actual-ready-forward-after', {
      label,
      navigation: hooks?.navigationState(),
      window: windowState()
    })
  }
  Object.defineProperty(Database.prototype, 'close', {
    ...closeDescriptor,
    value: function (...args) {
      if (this === appDatabase) {
        try {
          if (databaseCloseLateReady) {
            const before = presentation()
            forwardReady(databaseCloseLateReady, 'after-shutdown-onBegin-before-database-close')
            assertUnchangedPresentation(before)
            assert.equal(hooks.shutdownState().quitting, true)
            assert.equal(initialization().state, 'cancelled')
            trace.lateReadyAtDatabaseClose = true
          }
          trace.atDatabaseClose = {
            navigation: hooks.navigationState(),
            shutdown: hooks.shutdownState(),
            storage: databaseSnapshot(profile)
          }
          record('production-database-close', trace.atDatabaseClose)
        } catch (error) {
          fail(error)
        }
      }
      return Reflect.apply(closeDescriptor.value, this, args)
    }
  })
  ipcMain.handle = function (channel, listener) {
    if (!['settings:write-context', 'get-settings-snapshot'].includes(channel))
      return originalHandle.call(this, channel, listener)
    return originalHandle.call(this, channel, (event, ...args) => {
      const document = windows.get(BrowserWindow.fromWebContents(event.sender)?.id)?.documents
      const result = listener(event, ...args)
      return Promise.resolve(result).then((value) => {
        if (channel === 'settings:write-context') {
          const entry = {
            context: value,
            senderId: event.sender.id,
            document,
            url: event.senderFrame?.url
          }
          trace.sourceContexts.push(entry)
          record('source-context-issued', entry)
        } else if (holdSnapshots) {
          record('real-settings-snapshot-response-held', { senderId: event.sender.id, document })
          return new Promise((done) => snapshotDeliveries.push({ done, value, document }))
        }
        return value
      })
    })
  }
  ipcMain.on = function (channel, listener) {
    if (channel === 'window-close')
      return originalOn.call(this, channel, (event, ...args) => {
        const result = listener(event, ...args)
        hideProcessed += 1
        record('actual-preload-user-hide-processed', { senderId: event.sender.id, hideProcessed })
        return result
      })
    if (channel === 'renderer-ready')
      return originalOn.call(this, channel, (event, payload, context) => {
        try {
          const delivery = { event, payload, context, listener, url: event.senderFrame?.url }
          const observed = {
            senderId: event.sender.id,
            viewMode: payload?.viewMode,
            context,
            url: delivery.url,
            receivedAt: Date.now(),
            mainFrame: event.senderFrame === event.sender.mainFrame
          }
          assert.equal(observed.mainFrame, true)
          trace.readyEvents.push(observed)
          record('real-renderer-ready-arrived', observed)
          if ([CASES[1], CASES[2], CASES[3]].includes(childCase) && payload?.viewMode === 'list') {
            readyDeliveries.push(delivery)
            record('real-renderer-ready-held', observed)
            return
          }
          forwardReady(delivery, 'natural-business-ready')
        } catch (error) {
          fail(error)
        }
      })
    return originalOn.call(this, channel, listener)
  }
  function trayOpen() {
    const item = hooks.getTrayMenuTemplate().find((entry) => entry.label === '打开主窗口')
    assert.equal(typeof item?.click, 'function')
    trace.openClicks += 1
    record('actual-tray-open-intent', { clicks: trace.openClicks })
    item.click()
  }
  function trayQuit() {
    const item = hooks.getTrayMenuTemplate().find((entry) => entry.label === '退出应用')
    assert.equal(typeof item?.click, 'function')
    assert.equal(trace.quitClicks, 0)
    trace.quitClicks += 1
    trace.quitRequestedAt = Date.now()
    record('actual-tray-quit-intent')
    exitEvent('finish-start', { ownedProductQuit: true })
    item.click()
  }
  function assertActualSource(delivery) {
    assert.equal(typeof delivery.context?.token, 'string')
    assert.equal(delivery.context.scope, 'main')
    assert.ok(
      trace.sourceContexts.some(
        (value) => value.context.token === delivery.context.token && value.url === delivery.url
      )
    )
  }
  async function assertHeldTail() {
    const state = await httpState()
    assert.equal(state.resources.length, 1)
    assert.equal(state.resources[0].released, false)
    assert.equal(state.resources[0].closedAt, null)
    assert.equal(trace.loads[0].state, 'pending')
    return state
  }
  async function run() {
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() &&
            trace.loads.some((load) => load.windowId === window.id && load.url.startsWith(baseUrl))
        ),
      'Actual product main window not found through its real owned load request'
    )
    mainInfo = windows.get(current.id)
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    for (const name of [
      'navigationState',
      'shutdownState',
      'getTrayMenuTemplate',
      'nativeCaptureState',
      'notificationActivationState',
      'handleNotificationProtocol',
      'trayState'
    ])
      assert.equal(typeof hooks?.[name], 'function')
    await until(
      () => hooks.nativeCaptureState().ready && hooks.trayState().created,
      'Product tray/capture startup did not settle'
    )
    assert.equal(appDatabase?.open, true)
    assert.equal(initialization()?.kind, 'initial')
    if (childCase === CASES[5]) {
      phase = 'real-exposure-followed-by-one-native-focus-failure'
      await until(
        () => initialization().state === 'failed' && trace.injectedPresentationFailure,
        'The injected first focus failure did not terminate the exposed startup'
      )
      assert.equal(trace.injectedPresentationFailure.windowId, current.id)
      assert.equal(trace.injectedPresentationFailure.nativeFocusCalled, false)
      assert.ok(
        mainInfo.calls.show > 0,
        'The real BrowserWindow was shown before the one focus failure'
      )
      assert.equal(current.isVisible(), false, 'The failed exposed host is hidden')
      assert.equal(hooks.navigationState().unavailable, true)
      await until(
        () => trace.loads[0]?.state === 'fulfilled',
        'The actual original renderer finished loading'
      )
      const originalId = initialization().id
      const originalLoadCount = trace.loads.length
      trace.notesBeforeDirtyForm = persistedNotes(profile)
      phase = 'formal-new-note-form-establishes-dirty-state'
      if (await js('!!document.querySelector(".ab-box-btn[title=新建]")')) {
        await js('document.querySelector(".ab-box-btn[title=新建]").click()')
      }
      await until(
        () =>
          js(
            '!!document.querySelector(".ab-content-layer--expanded.is-visible .nnp-root textarea")'
          ),
        'The formal new-note form did not become the active panel'
      )
      const draftText = 'E2.5 exposed startup failure retains this unsaved UI draft'
      await js(
        `(() => { const input=document.querySelector('.nnp-root textarea'); input.value=${JSON.stringify(draftText)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`
      )
      await until(
        () =>
          js(
            `document.querySelector('.nnp-root textarea')?.value === ${JSON.stringify(draftText)} && document.querySelector('.nnp-submit')?.disabled === false`
          ),
        'The actual new-note form did not accept the unsaved input'
      )
      assert.deepEqual(persistedNotes(profile), trace.notesBeforeDirtyForm)
      assert.equal(trace.guardRequests.length, 0, 'The fixture has not called a draft guard itself')
      phase = 'single-tray-quit-reveals-original-failed-page-and-real-confirmation'
      trayQuit()
      await until(
        () => current.isVisible() && js('!!document.querySelector(".confirm-card.active")'),
        'The real dirty confirmation was not revealed on the original failed host'
      )
      assert.equal(current.isEnabled(), true)
      assert.equal(initialization().id, originalId, 'Guard reveal never retries initialization')
      assert.equal(
        trace.loads.length,
        originalLoadCount,
        'Guard reveal never reloads the dirty page'
      )
      assert.equal(initialization().state, 'failed')
      assert.ok(trace.guardRequests.length > 0)
      await until(
        () =>
          js(
            `(() => { const card=document.querySelector('.confirm-card.active'); return card && parseFloat(getComputedStyle(card).opacity) >= 0.99; })()`
          ),
        'The real confirmation did not reach its visible opacity'
      )
      const confirmation = await js(
        `(() => { const card=document.querySelector('.confirm-card.active'); const button=card?.querySelector('.confirm-actions button:last-child'); const rect=button?.getBoundingClientRect(); const x=rect ? Math.round(rect.left+rect.width/2) : -1; const y=rect ? Math.round(rect.top+rect.height/2) : -1; return {title:card?.querySelector('.confirm-title')?.textContent,confirmText:button?.textContent.trim(),x,y,clickable:!!button && x>=0 && y>=0 && x<innerWidth && y<innerHeight && button.contains(document.elementFromPoint(x,y))}; })()`
      )
      assert.equal(confirmation.title, '保留草稿后继续？')
      assert.equal(confirmation.confirmText, '保留并退出')
      assert.equal(
        confirmation.clickable,
        true,
        'The original renderer confirmation is actually hit-testable'
      )
      const png = (
        await bounded(
          current.webContents.capturePage(),
          'Visible real draft confirmation capture failed',
          3000
        )
      ).toPNG()
      writeFileSync(join(output, 'exposed-failure-draft-confirmation.png'), png, { flag: 'wx' })
      trace.draftQuitConfirmation = {
        ...confirmation,
        visible: current.isVisible(),
        sameInitialization: initialization().id === originalId,
        sameLoad: trace.loads.length === originalLoadCount,
        screenshotSha256: sha256(png),
        clicked: false
      }
      record('actual-failed-host-draft-confirmation-visible', trace.draftQuitConfirmation)
      const coordinates = { x: confirmation.x, y: confirmation.y }
      current.webContents.sendInputEvent({ type: 'mouseMove', ...coordinates })
      current.webContents.sendInputEvent({
        type: 'mouseDown',
        button: 'left',
        clickCount: 1,
        ...coordinates
      })
      current.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...coordinates
      })
      trace.draftQuitConfirmation.clicked = true
      record('one-real-confirm-leave-click-sent')
      return
    }
    if (childCase === CASES[0]) {
      phase = 'startup-ready-before-never-finished-tail'
      await until(
        () => initialization().state === 'succeeded' && current.isVisible(),
        'Initial business ready did not complete independently of load'
      )
      await assertHeldTail()
      assert.equal(await js('!!document.querySelector(".app-titlebar")'), true)
      assert.equal(current.isFocused(), true)
      const first = initialization()
      assert.ok(
        first.deadline - trace.loads[0].requestedAt >= 14900,
        'Original startup deadline retains the full fifteen-second policy'
      )
      assert.ok(first.deadline - trace.loads[0].requestedAt <= 15000)
      assert.equal(first.error, null)
      assert.equal(first.phase, 'ready')
      assert.ok(Number.isSafeInteger(first.documentGeneration) && first.documentGeneration > 0)
      phase = 'formal-notification-open-while-original-load-held'
      await js('window.api.closeWindow()')
      await until(() => !current.isVisible(), 'Official preload user hide did not apply')
      assert.equal(
        hooks.handleNotificationProtocol('abandon-note://notification/open', 'startup-specialty'),
        true
      )
      await until(
        () => current.isVisible() && current.isFocused(),
        'Notification open remained blocked by the original load tail'
      )
      await until(
        () =>
          applicationRecords(profile).some(
            (row) => row.scope === 'notification.reveal' && row.metadata?.result === 'shown'
          ),
        'Notification did not report shown while load was still pending'
      )
      await assertHeldTail()
      trace.notificationBeforeTailCompletion = {
        initialization: first,
        window: windowState(),
        http: await httpState()
      }
      phase = 'real-tray-month-switch-aborts-old-startup-load'
      const view = hooks.getTrayMenuTemplate().find((entry) => entry.label?.startsWith('当前视图'))
      const month = view?.submenu.find((entry) => entry.label === '月视图')
      assert.equal(typeof month?.click, 'function')
      month.click()
      await until(
        () =>
          hooks.navigationState().mode === 'month' &&
          !hooks.navigationState().switching &&
          current.isVisible(),
        'Real month navigation did not complete after early startup ready'
      )
      await until(
        () => trace.loads[0].state === 'rejected',
        'The old held native initial load did not produce its real abort'
      )
      assert.equal(hooks.navigationState().unavailable, false)
      assert.equal(databaseSnapshot(profile).activeView, 'month')
      trace.finalStartupBehavior = { window: windowState(), navigation: hooks.navigationState() }
      trayQuit()
      return
    }
    if (childCase === CASES[4]) {
      phase = 'original-native-load-failure'
      await until(
        () => initialization().state === 'failed' && trace.loads[0]?.state === 'rejected',
        'Original native load failure did not become a failed initialization'
      )
      assert.equal(current.isVisible(), false)
      assert.equal(hooks.navigationState().unavailable, true)
      assert.equal(initialization().error?.code, 'MAIN_VIEW_LOAD_FAILED')
      assert.equal(initialization().phase, 'load')
      assert.equal(trace.guardRequests.length, 0)
      const oldId = initialization().id
      const response = await fetch(baseUrl + '/__fixture/allow-load', { method: 'POST' })
      assert.equal(response.ok, true)
      trayOpen()
      await until(
        () => initialization().id !== oldId && snapshotDeliveries.length > 0,
        'Explicit user retry did not reach the real held settings initialization'
      )
      await until(
        () => trace.loads[1]?.state === 'fulfilled',
        'Retry native load did not complete before core readiness'
      )
      assert.equal(initialization().state, 'pending')
      assert.equal(
        trace.readyEvents.length,
        0,
        'The real renderer has not yet produced business ready'
      )
      assert.equal(current.isVisible(), false)
      assert.equal(
        trace.guardRequests.length,
        0,
        'Unavailable first document must not negotiate renderer guards'
      )
      phase = 'single-quit-during-actually-unavailable-retry'
      trayQuit()
      return
    }
    const original = await until(
      () => readyDeliveries[0],
      'Real initial ready never arrived at its observation gate'
    )
    assertActualSource(original)
    await until(
      () => trace.loads[0]?.state === 'fulfilled',
      'Initial load should complete while ready is held'
    )
    assert.equal(initialization().state, 'pending')
    assert.equal(current.isVisible(), false)
    assert.equal(current.isFocused(), false)
    if (childCase === CASES[1]) {
      phase = 'original-fifteen-second-ready-deadline'
      const first = initialization()
      assert.ok(first.deadline - trace.loads[0].requestedAt >= 14900)
      assert.ok(first.deadline - trace.loads[0].requestedAt <= 15000)
      await until(
        () => initialization().state === 'failed',
        'The original 15-second startup ready deadline did not fail',
        18000
      )
      const expired = initialization()
      assert.equal(expired.id, first.id)
      assert.equal(expired.deadline, first.deadline)
      assert.ok(Date.now() >= first.deadline)
      assert.equal(expired.error?.code, 'MAIN_VIEW_READY_TIMEOUT')
      assert.equal(expired.phase, 'ready')
      assert.ok(expired.error.message.length > 0)
      assert.equal(hooks.navigationState().unavailable, true)
      assert.equal(trace.guardRequests.length, 0)
      const beforeLate = presentation()
      forwardReady(original, 'late-initial-ready-before-user-retry')
      assert.equal(initialization().state, 'failed')
      assertUnchangedPresentation(beforeLate)
      phase = 'actual-user-retry-new-document-same-view'
      trayOpen()
      const fresh = await until(
        () => readyDeliveries[1],
        'Formal tray retry did not produce new actual ready'
      )
      assertActualSource(fresh)
      assert.notEqual(fresh.context.token, original.context.token)
      assert.notEqual(initialization().id, first.id)
      assert.equal(initialization().state, 'pending')
      assert.equal(trace.guardRequests.length, 0)
      forwardReady(original, 'same-view-old-ready-after-new-document-load')
      assert.equal(initialization().state, 'pending')
      assertUnchangedPresentation(beforeLate)
      forwardReady(fresh, 'new-authoritative-document-ready')
      await until(
        () => initialization().state === 'succeeded' && current.isVisible() && current.isFocused(),
        'Fresh authoritative ready did not complete explicit retry'
      )
      assert.ok(
        initialization().documentGeneration > 1,
        'Retry accepted a newer main-issued document generation'
      )
      assert.equal(hooks.navigationState().unavailable, false)
      assert.equal(trace.loads.length, 2)
      phase = 'normal-quit-after-successful-retry'
      trayQuit()
    } else if (childCase === CASES[2]) {
      phase = 'official-user-hide-before-first-core-ready'
      const previousHideCount = hideProcessed
      await js('window.api.closeWindow()')
      await until(
        () => hideProcessed > previousHideCount,
        'The actual hidden-window user-hide IPC was not processed'
      )
      const before = presentation()
      assert.equal(current.isVisible(), false)
      forwardReady(original, 'first-core-ready-after-user-hide')
      await until(
        () => initialization().state === 'succeeded',
        'Hidden startup core ready did not complete'
      )
      assert.equal(current.isVisible(), false)
      assert.equal(current.isFocused(), false)
      assertUnchangedPresentation(before)
      assert.equal(trace.guardRequests.length, 0)
      const loadCount = trace.loads.length
      const token = original.context.token
      trayOpen()
      await until(
        () => current.isVisible() && current.isFocused(),
        'Later explicit user open did not reveal the ready hidden page'
      )
      assert.equal(
        trace.loads.length,
        loadCount,
        'Successful hidden core ready is reused without reload'
      )
      assert.equal(trace.sourceContexts.at(-1).context.token, token)
      phase = 'normal-quit-after-hidden-success'
      trayQuit()
    } else {
      phase = 'single-quit-before-first-ready-is-admitted'
      databaseCloseLateReady = original
      trayQuit()
    }
  }
  app.on('will-quit', () => {
    if (reachedWillQuit) return
    reachedWillQuit = true
    record('will-quit')
    exitEvent('will-quit')
    try {
      if (failed) return
      assert.equal(trace.quitClicks, 1)
      assert.equal(hooks.shutdownState().completed, true)
      assert.equal(hooks.shutdownState().trigger, 'tray-menu')
      assert.equal(appDatabase.open, false)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      if ([CASES[3], CASES[4]].includes(childCase)) {
        assert.equal(
          trace.guardRequests.length,
          0,
          'Unaccepted first startup page must never receive a renderer draft guard'
        )
        assert.equal(trace.atDatabaseClose.navigation.initialization.state, 'cancelled')
        assert.equal(
          trace.atDatabaseClose.navigation.initialization.error.code,
          'MAIN_VIEW_LOAD_CANCELLED'
        )
        assert.equal(
          trace.atDatabaseClose.shutdown.deferredQuit,
          false,
          'Initial pending work must not defer a single user quit'
        )
        assert.equal(mainInfo.calls.show, 0)
        assert.equal(mainInfo.calls.focus, 0)
      } else
        assert.ok(
          trace.guardRequests.length > 0,
          'A successfully opened page retains the original E1 guard on normal quit'
        )
      if (childCase === CASES[3]) assert.equal(trace.lateReadyAtDatabaseClose, true)
      const storage = databaseSnapshot(profile)
      assert.equal(storage.activeView, childCase === CASES[0] ? 'month' : 'list')
      assert.deepEqual(storage.fonts, FONTS)
      trace.finalStorage = storage
      if (childCase === CASES[5]) {
        assert.equal(trace.draftQuitConfirmation.clicked, true)
        assert.equal(trace.loads.length, 1)
        assert.deepEqual(persistedNotes(profile), trace.notesBeforeDirtyForm)
      }
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
      writeJson(join(output, 'child-trace.json'), trace)
      const report = recorder.finish({
        completed: !failed && reachedWillQuit && evidenceWritten && code === 0,
        error: trace.firstFailure ? JSON.stringify(trace.firstFailure) : undefined,
        evidence: {
          status: evidenceWritten ? 'complete' : 'incomplete',
          artifacts: [
            'child-trace.json',
            'events.jsonl',
            'gui-exit-events.jsonl',
            ...(childCase === CASES[5] ? ['exposed-failure-draft-confirmation.png'] : [])
          ]
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
      writeJson(join(output, 'child-result.json'), report)
    } catch (error) {
      fail(error)
    }
  })
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
