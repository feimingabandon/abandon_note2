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
  writeFileSync,
  writeSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createFailureDiagnostics } from '../scripts/test-failure-diagnostics.cjs'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const SUITE = 'tests/sticky-quit-electron.mjs'
const MODE = 'electron-real-app-sticky-initialization-tray-quit-and-reopen'
const SCRIPT = fileURLToPath(import.meta.url)
const CASES = ['new-create', 'startup-restore']
const LIMITS = Object.freeze({
  childMs: 45000,
  businessMs: 35000,
  queryMs: 12000,
  cleanupMs: 5000,
  totalMs: 240000
})
const FAILURE_MARKER = 'sticky-quit-child-first-failure\n'
const childRole = process.env.ABANDON_STICKY_QUIT_CHILD
const childCase = process.env.ABANDON_STICKY_QUIT_CASE
const controllerProfile = childRole ? null : prepareTestProfile({ prefix: 'abandon-sticky-quit-' })
if (controllerProfile) {
  const userData = join(controllerProfile.directory, 'controller-user-data')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const samePath = (left, right) =>
  resolve(String(left)).toLowerCase() === resolve(String(right)).toLowerCase()

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
function ownedPath(root, child) {
  const target = resolve(root, child)
  const suffix = relative(resolve(root), target)
  if (!suffix || suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix))
    throw new Error('Test path escapes its owned root')
  return target
}
function errorDetails(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message || String(error),
    stack: error?.stack
  }
}
function deferred() {
  let resolvePromise
  const promise = new Promise((done) => {
    resolvePromise = done
  })
  return { promise, resolve: resolvePromise }
}
function businessRows(rows) {
  return rows
    .map((row) =>
      Object.fromEntries(
        [
          'id',
          'note_id',
          'content_snapshot',
          'font_size',
          'background_color',
          'corner_radius',
          'always_on_top',
          'created_at'
        ].map((name) => [name, row[name]])
      )
    )
    .sort((a, b) => a.id.localeCompare(b.id))
}
function snapshotDatabase(profile) {
  const database = new Database(join(profile, 'app.db'), { readonly: true, fileMustExist: true })
  try {
    return {
      integrity: database.pragma('integrity_check', { simple: true }),
      rows: database.prepare('SELECT * FROM desktop_stickies ORDER BY created_at, id').all(),
      writes: database.prepare('SELECT * FROM sticky_quit_writes ORDER BY sequence').all(),
      notes: database.prepare('SELECT id, content, is_deleted FROM notes ORDER BY id').all()
    }
  } finally {
    database.close()
  }
}
function insertionIds(snapshot) {
  return snapshot.writes.filter((row) => row.operation === 'insert').map((row) => row.sticky_id)
}
function assertStorage(assert, snapshot, expected) {
  assert.equal(snapshot.integrity, 'ok')
  assert.deepEqual(
    businessRows(snapshot.rows),
    expected.rows,
    'Only the committed sticky identities and content survive'
  )
  assert.deepEqual(
    insertionIds(snapshot),
    expected.insertionIds,
    'Restoration and cancelled initialization never insert a new record'
  )
  assert.deepEqual(
    snapshot.writes.filter((row) => row.operation === 'delete'),
    [],
    'Normal quit preserves every saved sticky'
  )
  assert.equal(snapshot.notes.length, 2)
  assert.ok(snapshot.notes.every((row) => row.is_deleted === 0))
}
function seed(profile, name) {
  mkdirSync(profile, { recursive: true })
  const database = new Database(join(profile, 'app.db'))
  const now = Date.now()
  const notes = [
    { id: 1, content: 'E2.2 已成功创建或恢复的便利贴 A' },
    { id: 2, content: 'E2.2 退出期间取消的新建 B 或既有恢复记录 B' }
  ]
  try {
    createDatabaseSchema(database)
    const setting = database.prepare(`INSERT INTO app_settings
      (window_name,type,key,value,remark,created_at,updated_at) VALUES(?,?,?,?,'',?,?)`)
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
      setting.run(...row, now, now)
    const insertNote = database.prepare(`INSERT INTO notes
      (id,content,status,effective_at,created_at,updated_at) VALUES(?,?,'in_progress',?,?,?)`)
    for (const note of notes) insertNote.run(note.id, note.content, now, now, now)
    database.exec(`CREATE TABLE sticky_quit_writes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, sticky_id TEXT NOT NULL
    );
    CREATE TRIGGER sticky_quit_audit_insert AFTER INSERT ON desktop_stickies
      BEGIN INSERT INTO sticky_quit_writes(operation,sticky_id) VALUES('insert',NEW.id); END;
    CREATE TRIGGER sticky_quit_audit_update AFTER UPDATE ON desktop_stickies
      BEGIN INSERT INTO sticky_quit_writes(operation,sticky_id) VALUES('update',NEW.id); END;
    CREATE TRIGGER sticky_quit_audit_delete AFTER DELETE ON desktop_stickies
      BEGIN INSERT INTO sticky_quit_writes(operation,sticky_id) VALUES('delete',OLD.id); END;`)
    if (name === 'startup-restore') {
      const display = screen.getPrimaryDisplay()
      const area = display.workArea
      const insert = database.prepare(`INSERT INTO desktop_stickies
        (id,note_id,content_snapshot,x,y,width,height,display_id,
        work_area_x,work_area_y,work_area_width,work_area_height,
        font_size,background_color,corner_radius,always_on_top,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const [index, note] of notes.entries())
        insert.run(
          'sticky-quit-existing-' + note.id,
          note.id,
          note.content,
          area.x + 30 + index * 300,
          area.y + 30,
          280,
          260,
          String(display.id),
          area.x,
          area.y,
          area.width,
          area.height,
          16,
          '#FFF2A8',
          0,
          0,
          now + index,
          now + index
        )
    }
  } finally {
    database.close()
  }
  const before = snapshotDatabase(profile)
  return {
    name,
    notes,
    before,
    expected: { rows: businessRows(before.rows), insertionIds: insertionIds(before) }
  }
}
function durableShutdownRecords(profile) {
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
function sourceFingerprints() {
  const files = new Set([
    SUITE,
    'tests/helpers/test-result-recorder.cjs',
    'scripts/test-failure-diagnostics.cjs',
    'scripts/test-failure-windows.ps1',
    'src/main/index.js',
    'src/main/application/feature-runtime.js',
    'src/main/application/business-mutation-admission.js',
    'src/main/application/shutdown-coordinator.js',
    'src/main/sticky/ElectronStickyService.js',
    'src/main/sticky/stickyConstants.js',
    'src/main/db/db-desktop-stickies.js',
    'src/main/db/db-schema.js',
    'src/main/db/db-connection.js',
    'src/main/windows/editing-draft-guard.js',
    'src/main/tray/main-tray-controller.js',
    'src/preload/index.js',
    'src/preload/sticky.js',
    'src/renderer/sticky/sticky.js',
    'src/renderer/sticky.html',
    'package-lock.json',
    'native_blur/build/bin/blur_engine.dll',
    'native_capture/deploy/capture_host.dll',
    'native_capture/deploy/AbandonCapture.exe'
  ])
  // Inspect only the built application tree, never user profiles or Chromium caches.
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Unexpected link in application build evidence')
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

async function runChild(role, name, profile, directory, inputPath, expectedPath, deadlineAt) {
  mkdirSync(directory, { recursive: true })
  const env = {
    ...process.env,
    ABANDON_STICKY_QUIT_CHILD: role,
    ABANDON_STICKY_QUIT_CASE: name,
    ABANDON_STICKY_QUIT_PROFILE: profile,
    ABANDON_STICKY_QUIT_EVIDENCE: directory,
    ABANDON_STICKY_QUIT_INPUT: inputPath,
    ABANDON_STICKY_QUIT_EXPECTED: expectedPath,
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
    role,
    case: name,
    profile,
    pid: null,
    spawnedAt: Date.now(),
    exit: null,
    close: null,
    timeoutMs: Math.min(LIMITS.childMs, Math.max(1, deadlineAt - Date.now())),
    firstFailure: null,
    forced: false,
    terminationIncomplete: false,
    diagnosticsBeforeForce: false,
    logErrors: []
  }
  const descriptors = {}
  let processHandle,
    diagnostics,
    timeout,
    fallback,
    stopping = false,
    finished = false,
    outputTail = ''
  const firstFailure = (kind, details = {}) => {
    if (result.firstFailure) return
    result.firstFailure = { kind, at: Date.now(), ...details }
    try {
      writeJson(join(directory, 'first-failure.json'), result.firstFailure)
    } catch (error) {
      result.logErrors.push('first failure evidence: ' + error.message)
    }
  }
  await new Promise((done) => {
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      clearTimeout(fallback)
      done()
    }
    const stop = async (reason) => {
      if (stopping || finished) return
      stopping = true
      clearTimeout(timeout)
      firstFailure(reason)
      await diagnostics?.capture(reason)
      result.diagnosticsBeforeForce = true
      if (finished) return
      const running = () =>
        processHandle && processHandle.exitCode === null && processHandle.signalCode === null
      if (running()) {
        result.forced = true
        // Only the still-running child spawned here authorizes this tree cleanup.
        const killer = spawn('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.unref()
        killer.on('error', (error) => {
          result.cleanupError = error.message
          if (running()) processHandle.kill()
        })
        killer.on('exit', (code) => {
          result.cleanupExitCode = code
          if (code !== 0 && running()) processHandle.kill()
        })
      } else if (!result.close) result.terminationIncomplete = true
      fallback = setTimeout(() => {
        result.terminationIncomplete = true
        processHandle?.stdout?.destroy()
        processHandle?.stderr?.destroy()
        processHandle?.unref()
        finish()
      }, LIMITS.cleanupMs)
    }
    try {
      for (const stream of ['stdout', 'stderr'])
        descriptors[stream] = openSync(join(directory, stream + '.log'), 'wx')
      result.spawnedAt = Date.now()
      processHandle = spawn(process.execPath, [SCRIPT], {
        cwd: process.cwd(),
        env,
        // Windows launch hiding suppresses GUI show in this Electron child.
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      result.pid = processHandle.pid
      diagnostics = createFailureDiagnostics({
        gui: true,
        directory,
        command: process.execPath,
        args: [SCRIPT],
        spawnedMs: result.spawnedAt,
        pid: result.pid,
        cwd: process.cwd(),
        writeEvidence: (file, value) => writeJson(join(directory, file), value)
      })
      for (const stream of ['stdout', 'stderr']) {
        processHandle[stream].on('data', (chunk) => {
          try {
            let offset = 0
            while (offset < chunk.length) {
              const written = writeSync(descriptors[stream], chunk, offset, chunk.length - offset)
              if (!written) throw new Error('Output write made no progress')
              offset += written
            }
            if (stream === 'stdout') {
              const received = outputTail + chunk.toString('utf8')
              outputTail = received.slice(-FAILURE_MARKER.length)
              if (received.includes(FAILURE_MARKER)) void stop('child-reported-failure')
            }
          } catch (error) {
            result.logErrors.push(stream + ': ' + error.message)
            firstFailure('output-write', { stream, error: error.message })
            void stop('output-write')
          }
        })
        processHandle[stream].on('error', (error) => {
          result.logErrors.push(stream + ': ' + error.message)
          firstFailure('output-stream', { stream, error: error.message })
          void stop('output-stream')
        })
      }
      processHandle.once('error', (error) => firstFailure('spawn', { error: error.message }))
      processHandle.once('exit', (code, signal) => {
        result.exit = { code, signal, at: Date.now() }
        if (code !== 0 || signal) firstFailure('process-exit', { code, signal })
        diagnostics.exited(code, signal)
      })
      processHandle.once('close', (code, signal) => {
        result.close = { code, signal, at: Date.now() }
        finish()
      })
      timeout = setTimeout(() => {
        firstFailure('child-timeout', { timeoutMs: result.timeoutMs })
        void stop('child-timeout')
      }, result.timeoutMs)
    } catch (error) {
      firstFailure('launch', { error: error.message })
      if (processHandle?.pid) void stop('launch')
      else finish()
    }
  })
  result.diagnostics = await diagnostics?.finish()
  for (const [stream, descriptor] of Object.entries(descriptors)) {
    try {
      closeSync(descriptor)
    } catch (error) {
      result.logErrors.push(stream + ' close: ' + error.message)
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
      processes: 4,
      limits: LIMITS,
      quitEntry: 'one-production-tray-menu-template-quit-click-per-product-child',
      nativeTrayMouseHitTesting: false,
      reseedBetweenWriterAndVerifier: false,
      readyGate: 'only-before-original-handler-of-an-actual-received-ready-IPC',
      lateReady:
        'the-already-received-IPC-resumes-after-cancellation; no-new-IPC-from-destroyed-page',
      forcedTerminationCanPass: false
    }
  })
  const { assert } = recorder
  const output = process.env.ABANDON_TEST_EVIDENCE_DIR || controllerProfile.directory
  const deadline = Date.now() + LIMITS.totalMs
  const cases = []
  let failure = null,
    completed = false,
    evidenceStatus = 'complete',
    fingerprints
  try {
    fingerprints = sourceFingerprints()
    writeJson(join(output, 'source-build-hashes.json'), fingerprints)
    for (const name of CASES) {
      const profile = ownedPath(controllerProfile.directory, name)
      const directory = ownedPath(output, 'scenario-' + name)
      mkdirSync(directory, { recursive: true })
      const input = seed(profile, name)
      const inputPath = join(directory, 'case-input.json')
      const expectedPath = join(directory, 'expected-after-writer.json')
      writeJson(inputPath, input)
      const entry = { name, profile, initial: input.before, children: [] }
      cases.push(entry)
      let expected = input.expected
      for (const role of ['writer', 'verifier']) {
        const childDirectory = join(directory, role)
        const priorSessions = new Set(
          durableShutdownRecords(profile).map((record) => record.sessionId)
        )
        const processResult = await runChild(
          role,
          name,
          profile,
          childDirectory,
          inputPath,
          expectedPath,
          deadline
        )
        const child = { role, directory: childDirectory, process: processResult }
        entry.children.push(child)
        assert.equal(processResult.firstFailure, null, name + ' ' + role + ' first failure')
        assert.equal(processResult.forced, false, 'Forced termination cannot pass product exit')
        assert.equal(processResult.terminationIncomplete, false)
        assert.deepEqual(processResult.logErrors, [])
        assert.equal(processResult.exit?.code, 0)
        assert.equal(processResult.exit?.signal, null)
        assert.equal(processResult.close?.code, 0)
        assert.equal(processResult.close?.signal, null)
        assert.ok(processResult.close.at >= processResult.exit.at)
        const report = JSON.parse(readFileSync(join(childDirectory, 'child-result.json'), 'utf8'))
        const trace = JSON.parse(readFileSync(join(childDirectory, 'child-trace.json'), 'utf8'))
        child.report = report
        assert.equal(report.completed, true)
        assert.ok(report.assertions.total > 0)
        assert.equal(report.assertions.failed, 0)
        assert.equal(report.evidence.status, 'complete')
        assert.equal(report.cleanup.status, 'preserved')
        assert.equal(report.cleanup.forcedExit, false)
        assert.equal(report.cleanup.windowsClosed, true)
        assert.equal(trace.firstFailure, null)
        assert.equal(trace.quitClicks, 1)
        assert.equal(trace.willQuitVerified, true)
        assert.equal(trace.descriptorsRestored, true)
        assert.equal(trace.pid, processResult.pid)
        const records = durableShutdownRecords(profile).filter(
          (record) => !priorSessions.has(record.sessionId)
        )
        const starts = records.filter((record) => record.scope === 'lifecycle.shutdown-start')
        const finishes = records.filter((record) => record.scope === 'lifecycle.shutdown-complete')
        assert.equal(starts.length, 1)
        assert.equal(finishes.length, 1)
        assert.ok(typeof finishes[0].sessionId === 'string' && finishes[0].sessionId.length > 0)
        assert.equal(starts[0].sessionId, finishes[0].sessionId)
        assert.equal(finishes[0].pid, processResult.pid)
        assert.equal(finishes[0].metadata.trigger, 'tray-menu')
        for (const stage of ['business-mutations', 'sticky', 'feature-ledger', 'database', 'tray'])
          assert.equal(finishes[0].metadata.stages[stage]?.status, 'complete')
        for (const stage of Object.values(finishes[0].metadata.stages))
          assert.notEqual(stage.status, 'failed')
        child.sessionId = finishes[0].sessionId
        writeJson(join(childDirectory, 'shutdown-session.json'), {
          start: starts[0],
          complete: finishes[0]
        })
        const postExit = snapshotDatabase(profile)
        if (role === 'writer' && name === 'new-create') {
          assert.equal(postExit.rows.length, 1)
          assert.equal(postExit.rows[0].id, trace.successfulCreate.response.sticky.id)
          assert.equal(postExit.rows[0].note_id, input.notes[0].id)
          assert.equal(postExit.rows[0].content_snapshot, input.notes[0].content)
          expected = { rows: businessRows(postExit.rows), insertionIds: [postExit.rows[0].id] }
          assert.equal(
            postExit.rows.some((row) => row.id === trace.held.state.id),
            false
          )
        }
        assertStorage(assert, postExit, expected)
        writeJson(join(childDirectory, 'post-exit-database.json'), postExit)
        if (role === 'writer') {
          writeJson(expectedPath, expected)
          entry.afterWriter = postExit
          assert.equal(trace.held.readyEntered, true)
          assert.equal(trace.lateReady.status, 'rejected')
          assert.equal(trace.heldWindowClosed, true)
          assert.ok(trace.cancelAfterQuitMs >= 0 && trace.cancelAfterQuitMs < 1500)
          assert.ok(
            trace.cancelFromWindowCreationMs < 5000,
            'Cancellation must precede the original initialization deadline'
          )
          assert.equal(trace.held.showEvents, 0)
          assert.equal(trace.atDatabaseClose.business.pending, 0)
          const index = (event) => trace.events.findIndex((value) => value.event === event)
          for (const [before, after] of [
            ['ready-held', 'tray-quit-click'],
            ['tray-quit-click', 'held-window-closed'],
            ['held-window-closed', 'late-ready-released'],
            ['late-ready-released', 'late-ready-rejected'],
            ['late-ready-rejected', 'production-database-close-start'],
            ['production-database-close-start', 'production-database-close-complete'],
            ['production-database-close-complete', 'will-quit'],
            ['will-quit', 'quit']
          ])
            assert.ok(
              index(before) >= 0 && index(after) > index(before),
              before + ' precedes ' + after
            )
          if (name === 'new-create') {
            assert.ok(index('create-cancelled') < index('late-ready-released'))
            assert.equal(trace.creates.length, 2)
            assert.equal(trace.pendingCreate.response.ok, false)
            assert.match(trace.pendingCreate.response.message, /取消/)
            assert.equal(trace.pendingCreate.response.committed, undefined)
            assert.equal(trace.pendingCreate.response.cleanupIncomplete, undefined)
            assert.ok(trace.cancelFromCreateHandlerMs < 5000)
          } else {
            assert.equal(trace.creates.length, 0)
            assert.deepEqual(
              trace.stateRequests.map((value) => value.state.id),
              [input.before.rows[0].id]
            )
            assert.equal(
              trace.stickyWindows.length,
              1,
              'The restore queue must not open its next saved record'
            )
          }
        } else {
          assert.ok(processResult.spawnedAt >= entry.children[0].process.logsSealedAt)
          assert.notEqual(child.sessionId, entry.children[0].sessionId)
          assert.deepEqual(businessRows(postExit.rows), businessRows(entry.afterWriter.rows))
          assert.deepEqual(
            trace.restored.map((value) => value.id).sort(),
            expected.rows.map((row) => row.id).sort()
          )
          assert.ok(trace.restored.every((value) => value.visible && value.contentVerified))
          assert.equal(
            trace.creates.length,
            0,
            'The verifier restores saved rows without creating or reseeding'
          )
          entry.afterVerifier = postExit
        }
        assert.deepEqual(
          sourceFingerprints(),
          fingerprints,
          'The exact source/build remains fixed across child runs'
        )
      }
    }
    assert.equal(cases.length, 2)
    assert.equal(cases.flatMap((entry) => entry.children).length, 4)
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  }
  try {
    writeJson(join(output, 'sticky-quit-summary.json'), {
      completed,
      cases,
      error: failure ? errorDetails(failure) : null,
      fingerprints
    })
  } catch (error) {
    failure ||= error
    completed = false
    evidenceStatus = 'failed'
  }
  const childrenClosed = cases.every((entry) =>
    entry.children.every(
      (child) => child.process.exit && child.process.close && !child.process.terminationIncomplete
    )
  )
  recorder.finish({
    completed,
    error: failure,
    evidence: {
      status: evidenceStatus,
      artifacts: ['source-build-hashes.json', 'sticky-quit-summary.json']
    },
    profileOwnership: controllerProfile.ownership,
    cleanup: {
      status: !childrenClosed
        ? 'failed'
        : controllerProfile.ownership === 'runner'
          ? 'complete'
          : 'preserved',
      childrenClosed,
      preservedProfile:
        controllerProfile.ownership === 'script' || failure
          ? controllerProfile.directory
          : undefined,
      scope:
        'Every product child exit and stdio close observed; owned profiles remain until runner cleanup after controller exit'
    }
  })
  // This is only the test controller, never a product process under acceptance.
  app.exit(completed && !failure ? 0 : 1)
}

async function child() {
  if (!['writer', 'verifier'].includes(childRole) || !CASES.includes(childCase))
    throw new Error('Invalid sticky quit child role/case')
  const profile = resolve(process.env.ABANDON_STICKY_QUIT_PROFILE)
  const output = resolve(process.env.ABANDON_STICKY_QUIT_EVIDENCE)
  const input = JSON.parse(readFileSync(process.env.ABANDON_STICKY_QUIT_INPUT, 'utf8'))
  const expected =
    childRole === 'verifier'
      ? JSON.parse(readFileSync(process.env.ABANDON_STICKY_QUIT_EXPECTED, 'utf8'))
      : input.expected
  const recorder = createAssertionRecorder({
    suite: SUITE,
    mode: MODE + '-' + childRole,
    env: {},
    metadata: { role: childRole, case: childCase, pid: process.pid, profile, reseeded: false }
  })
  const { assert } = recorder
  const require = createRequire(import.meta.url)
  const originalHandle = ipcMain.handle
  const prepareDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'prepare')
  const closeDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'close')
  const databasePath = join(profile, 'app.db')
  const actualWindows = new Map()
  const states = new Map()
  const enteredGate = deferred()
  const releasedGate = deferred()
  const completedLateReady = deferred()
  const trace = {
    pid: process.pid,
    role: childRole,
    case: childCase,
    profile,
    events: [],
    firstFailure: null,
    quitClicks: 0,
    creates: [],
    stateRequests: [],
    readyCalls: [],
    stickyWindows: [],
    restored: [],
    successfulCreate: null,
    pendingCreate: null,
    held: null,
    heldWindowClosed: false,
    lateReady: null,
    descriptorsRestored: false,
    willQuitVerified: false,
    atDatabaseClose: null,
    finalStorage: null
  }
  let sequence = 0,
    appDatabase,
    current,
    hooks,
    armed = childRole === 'writer' && childCase === 'startup-restore'
  let failed = false,
    quittingRequested = false,
    reachedWillQuit = false,
    evidenceWritten = false,
    finalized = false
  let heldWindow = null,
    releaseIssued = false
  const record = (event, details = {}) => {
    const value = { sequence: ++sequence, event, at: Date.now(), pid: process.pid, ...details }
    trace.events.push(value)
    appendFileSync(join(output, 'events.jsonl'), JSON.stringify(value) + '\n')
    return value
  }
  const exitEvent = (event, details = {}) =>
    appendFileSync(
      join(output, 'gui-exit-events.jsonl'),
      JSON.stringify({
        event,
        pid: process.pid,
        suite: SUITE,
        time: new Date().toISOString(),
        ...details
      }) + '\n'
    )
  const restoreDescriptors = () => {
    if (trace.descriptorsRestored) return
    ipcMain.handle = originalHandle
    Object.defineProperty(Database.prototype, 'prepare', prepareDescriptor)
    Object.defineProperty(Database.prototype, 'close', closeDescriptor)
    trace.descriptorsRestored = true
  }
  const fail = (error) => {
    if (failed) return
    failed = true
    clearTimeout(watchdog)
    trace.firstFailure = errorDetails(error)
    process.exitCode = 1
    restoreDescriptors()
    try {
      record('child-first-failure', trace.firstFailure)
      writeJson(join(output, 'child-first-failure.json'), trace)
    } catch (evidenceError) {
      process.stderr.write((evidenceError.stack || String(evidenceError)) + '\n')
    }
    process.stderr.write((error.stack || String(error)) + '\n')
    // Preserve the failure state for the controller's external Windows diagnostics.
    // No second quit, gate release, manual window destruction or app.exit occurs here.
    process.stdout.write(FAILURE_MARKER)
  }
  const watchdog = setTimeout(
    () => fail(new Error('Product-child business deadline exceeded')),
    LIMITS.businessMs
  )
  async function bounded(promise, message, timeoutMs = LIMITS.queryMs) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function until(predicate, message) {
    const deadline = Date.now() + LIMITS.queryMs
    while (Date.now() < deadline) {
      if (failed) throw new Error('This child already failed')
      const value = await bounded(Promise.resolve().then(predicate), message)
      if (value) return value
      await wait(10)
    }
    throw new Error(message)
  }
  const js = (source) =>
    bounded(current.webContents.executeJavaScript(source), 'Main renderer query timed out')
  const infoForSender = (id) => [...actualWindows.values()].find((value) => value.senderId === id)
  const windowSnapshot = (info) => ({
    id: info.id,
    senderId: info.senderId,
    createdAt: info.createdAt,
    sticky: info.sticky,
    roleEvidence: info.roleEvidence,
    destroyed: info.window.isDestroyed(),
    visible: info.window.isDestroyed() ? false : info.window.isVisible(),
    showEvents: info.showEvents,
    closedAt: info.closedAt || null,
    lastBounds: info.lastBounds
  })
  function releaseLateReady(reason) {
    if (releaseIssued || failed) return
    releaseIssued = true
    record('late-ready-released', {
      reason,
      transport: 'resume-original-handler-of-already-received-IPC',
      senderId: trace.held.senderId
    })
    releasedGate.resolve()
  }
  function observeWindow(window) {
    const info = {
      window,
      id: window.id,
      senderId: window.webContents.id,
      createdAt: Date.now(),
      // Construction can precede populated web preferences. Preserve the real
      // window now; the authorized production get-state reply establishes role.
      sticky: null,
      roleEvidence: null,
      showEvents: 0,
      lastBounds: window.getBounds(),
      closedAt: null
    }
    actualWindows.set(info.id, info)
    record('window-created', {
      id: info.id,
      senderId: info.senderId,
      role: 'unclassified-at-construction'
    })
    window.on('show', () => {
      info.showEvents += 1
      record('window-show', { id: info.id, senderId: info.senderId, sticky: info.sticky })
    })
    for (const event of ['move', 'resize'])
      window.on(event, () => {
        if (!window.isDestroyed()) info.lastBounds = window.getBounds()
      })
    window.once('closed', () => {
      info.closedAt = Date.now()
      record('window-closed', { id: info.id, senderId: info.senderId, sticky: info.sticky })
      if (heldWindow !== info) return
      trace.heldWindowClosed = true
      trace.cancelAfterQuitMs = info.closedAt - trace.quitRequestedAt
      trace.cancelFromWindowCreationMs = info.closedAt - info.createdAt
      record('held-window-closed', {
        senderId: info.senderId,
        cancelAfterQuitMs: trace.cancelAfterQuitMs,
        cancelFromWindowCreationMs: trace.cancelFromWindowCreationMs
      })
      if (
        childCase === 'startup-restore' &&
        quittingRequested &&
        hooks.shutdownState().startedAt !== null
      )
        releaseLateReady('held-restoration-window-closed-after-product-shutdown-began')
    })
  }
  app.on('browser-window-created', (_event, window) => observeWindow(window))
  Object.defineProperty(Database.prototype, 'prepare', {
    ...prepareDescriptor,
    value: function (...args) {
      const statement = Reflect.apply(prepareDescriptor.value, this, args)
      if (!appDatabase && this.name && samePath(this.name, databasePath)) {
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
      if (observed) {
        try {
          trace.atDatabaseClose = {
            business: hooks.businessMutationState(),
            shutdown: hooks.shutdownState(),
            features: hooks.featureState(),
            storage: snapshotDatabase(profile)
          }
          record('production-database-close-start', trace.atDatabaseClose)
          assert.equal(trace.atDatabaseClose.business.pending, 0)
          assert.equal(
            trace.atDatabaseClose.shutdown.stages['business-mutations']?.status,
            'complete'
          )
          assert.equal(trace.atDatabaseClose.features.resources.sticky, 'disposed')
          if (childRole === 'writer') {
            assert.equal(trace.heldWindowClosed, true)
            assert.equal(
              trace.lateReady?.status,
              'rejected',
              'The already-received ready completed harmlessly before database close'
            )
            assert.equal(infoForSender(trace.held.senderId).showEvents, 0)
            if (childCase === 'new-create')
              assert.match(trace.pendingCreate.response.message, /取消/)
          }
        } catch (error) {
          fail(error)
        }
      }
      const value = Reflect.apply(closeDescriptor.value, this, args)
      if (observed) record('production-database-close-complete', { open: this.open })
      return value
    }
  })
  ipcMain.handle = function (channel, listener) {
    if (channel === 'sticky:get-state')
      return originalHandle.call(this, channel, (event, ...args) => {
        const state = listener(event, ...args)
        const info = infoForSender(event.sender.id)
        assert.ok(info, 'The authorized sticky sender belongs to an observed real window')
        assert.equal(info.window.webContents, event.sender)
        info.sticky = true
        info.roleEvidence = {
          channel: 'sticky:get-state',
          authorization: 'original-production-handler-returned-state',
          senderId: event.sender.id,
          stickyId: state.id,
          noteId: state.noteId
        }
        record('window-role-confirmed', {
          id: info.id,
          role: 'sticky',
          ...info.roleEvidence
        })
        states.set(event.sender.id, state)
        const value = { senderId: event.sender.id, state }
        trace.stateRequests.push(value)
        record('sticky-state-read', value)
        return state
      })
    if (channel === 'sticky:create')
      return originalHandle.call(this, channel, (event, ...args) => {
        const value = {
          noteId: args[0]?.noteId,
          startedAt: Date.now(),
          senderId: event.sender.id,
          status: 'pending'
        }
        trace.creates.push(value)
        const result = listener(event, ...args)
        value.admission = hooks.businessMutationState()
        record('create-admitted', value)
        return Promise.resolve(result).then(
          (response) => {
            value.response = response
            value.status = response?.ok ? 'succeeded' : 'rejected'
            value.finishedAt = Date.now()
            record('create-returned', value)
            if (
              childRole === 'writer' &&
              childCase === 'new-create' &&
              value.noteId === input.notes[1].id
            ) {
              trace.pendingCreate = value
              trace.cancelFromCreateHandlerMs = value.finishedAt - value.startedAt
              if (!response.ok && /取消/.test(response.message) && quittingRequested) {
                record('create-cancelled', {
                  response,
                  pending: hooks.businessMutationState().pending
                })
                releaseLateReady('original-create-handler-returned-cancelled')
              } else
                fail(
                  new Error('Pending real create did not return cancellation during normal quit')
                )
            }
            return response
          },
          (error) => {
            value.status = 'threw'
            value.error = errorDetails(error)
            fail(error)
            throw error
          }
        )
      })
    if (channel === 'sticky:ready')
      return originalHandle.call(this, channel, async (event, ...args) => {
        const senderId = event.sender.id
        const state = states.get(senderId)
        const call = {
          senderId,
          stickyId: state?.id,
          noteId: state?.noteId,
          receivedAt: Date.now(),
          status: 'received'
        }
        trace.readyCalls.push(call)
        record('ready-received', call)
        const target =
          armed &&
          childRole === 'writer' &&
          (childCase === 'startup-restore'
            ? state?.id === input.before.rows[0].id
            : state?.noteId === input.notes[1].id)
        if (target) {
          armed = false
          heldWindow = infoForSender(senderId)
          trace.held = {
            senderId,
            state,
            heldAt: Date.now(),
            readyEntered: true,
            showEvents: heldWindow.showEvents,
            window: windowSnapshot(heldWindow)
          }
          record('ready-held', trace.held)
          enteredGate.resolve()
          await releasedGate.promise
        }
        try {
          const value = await listener(event, ...args)
          call.status = 'succeeded'
          call.value = value
          record('ready-returned', call)
          if (target) {
            trace.lateReady = { status: 'unexpected-success', value }
            fail(new Error('Cancelled sticky accepted the already-received ready'))
          }
          return value
        } catch (error) {
          call.status = 'rejected'
          call.error = errorDetails(error)
          if (target) {
            trace.lateReady = {
              status: 'rejected',
              error: errorDetails(error),
              transport: 'already-received-IPC-resumed-after-window-destruction'
            }
            record('late-ready-rejected', trace.lateReady)
          } else fail(error)
          throw error
        } finally {
          if (target) completedLateReady.resolve()
        }
      })
    return originalHandle.call(this, channel, listener)
  }
  function trayQuit() {
    const item = hooks.getTrayMenuTemplate().find((candidate) => candidate.label === '退出应用')
    assert.equal(typeof item?.click, 'function')
    assert.equal(trace.quitClicks, 0, 'Exactly one successful product quit intent is permitted')
    quittingRequested = true
    trace.quitClicks += 1
    trace.quitRequestedAt = Date.now()
    record('tray-quit-click', { quitClicks: trace.quitClicks })
    exitEvent('finish-start', { ownedProductQuit: true, case: childCase, role: childRole })
    item.click()
  }
  async function verifyWindow(state, screenshot) {
    const info = infoForSender(state.senderId)
    assert.ok(info)
    assert.equal(info.window.isVisible(), true)
    const expectedNote = input.notes.find((note) => note.id === state.state.noteId)
    const content = await bounded(
      info.window.webContents.executeJavaScript(
        "document.querySelector('[data-content]').textContent"
      ),
      'Real sticky DOM query timed out'
    )
    assert.equal(content, expectedNote.content)
    assert.ok(info.window.getNativeWindowHandle().some((value) => value !== 0))
    const result = {
      id: state.state.id,
      noteId: state.state.noteId,
      visible: info.window.isVisible(),
      contentVerified: content === expectedNote.content,
      window: windowSnapshot(info)
    }
    if (screenshot) {
      const png = (
        await bounded(
          info.window.webContents.capturePage(),
          'Visible sticky screenshot timed out',
          3000
        )
      ).toPNG()
      writeFileSync(join(output, screenshot), png, { flag: 'wx' })
      result.screenshot = { file: screenshot, sha256: sha256(png) }
    }
    return result
  }
  app.on('will-quit', () => {
    if (reachedWillQuit) return
    reachedWillQuit = true
    record('will-quit')
    exitEvent('will-quit')
    try {
      if (failed) return
      assert.equal(quittingRequested, true)
      assert.equal(trace.quitClicks, 1)
      const shutdown = hooks.shutdownState()
      assert.equal(shutdown.completed, true)
      assert.equal(shutdown.trigger, 'tray-menu')
      for (const stage of ['business-mutations', 'sticky', 'feature-ledger', 'database', 'tray'])
        assert.equal(shutdown.stages[stage]?.status, 'complete')
      for (const stage of Object.values(shutdown.stages)) assert.notEqual(stage.status, 'failed')
      assert.equal(hooks.businessMutationState().pending, 0)
      assert.equal(appDatabase.open, false)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      assert.ok([...actualWindows.values()].every((info) => info.window.isDestroyed()))
      trace.shutdown = shutdown
      trace.stickyWindows = [...actualWindows.values()]
        .filter((info) => info.sticky)
        .map(windowSnapshot)
      trace.finalStorage = snapshotDatabase(profile)
      if (childRole === 'writer') {
        assert.equal(trace.heldWindowClosed, true)
        assert.equal(trace.lateReady?.status, 'rejected')
        assert.ok(trace.cancelAfterQuitMs >= 0 && trace.cancelAfterQuitMs < 1500)
        assert.ok(trace.cancelFromWindowCreationMs < 5000)
        assert.equal(heldWindow.showEvents, 0)
        if (childCase === 'new-create') {
          assert.equal(trace.stickyWindows.length, 2)
          assert.equal(trace.finalStorage.rows.length, 1)
          assert.equal(trace.finalStorage.rows[0].id, trace.successfulCreate.response.sticky.id)
          assert.equal(trace.finalStorage.rows[0].note_id, input.notes[0].id)
          assert.equal(trace.finalStorage.rows[0].content_snapshot, input.notes[0].content)
          assert.deepEqual(insertionIds(trace.finalStorage), [
            trace.successfulCreate.response.sticky.id
          ])
          assert.equal(trace.pendingCreate.response.ok, false)
          assert.match(trace.pendingCreate.response.message, /取消/)
          assert.equal(trace.pendingCreate.response.committed, undefined)
          assert.equal(trace.pendingCreate.response.cleanupIncomplete, undefined)
        } else {
          assertStorage(assert, trace.finalStorage, input.expected)
          assert.equal(trace.stickyWindows.length, 1)
          assert.deepEqual(
            trace.stateRequests.map((value) => value.state.id),
            [input.before.rows[0].id]
          )
          assert.equal(trace.creates.length, 0)
        }
      } else {
        assertStorage(assert, trace.finalStorage, expected)
        assert.equal(trace.stickyWindows.length, expected.rows.length)
        assert.equal(trace.creates.length, 0)
        assert.equal(trace.held, null)
      }
      trace.willQuitVerified = true
      evidenceWritten = true
    } catch (error) {
      fail(error)
    } finally {
      restoreDescriptors()
    }
  })
  app.once('quit', (_event, code) => {
    clearTimeout(watchdog)
    restoreDescriptors()
    record('quit', { code })
    exitEvent('quit', { code })
    if (finalized) return
    finalized = true
    try {
      assert.equal(code, 0)
      assert.equal(failed, false)
      assert.equal(trace.willQuitVerified, true)
      assert.equal(trace.descriptorsRestored, true)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
    } catch (error) {
      fail(error)
    }
    try {
      writeJson(join(output, 'child-trace.json'), trace)
      const report = recorder.finish({
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
          reachedWillQuit,
          windowsClosed: BrowserWindow.getAllWindows().length === 0,
          forcedExit: false,
          descriptorsRestored: trace.descriptorsRestored,
          exitCode: code,
          preservedProfile: profile,
          scope:
            'Actual normal product quit; controller retains the same profile for unseeded verification'
        }
      })
      writeJson(join(output, 'child-result.json'), report)
    } catch (error) {
      fail(error)
    }
  })
  async function run() {
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (window) => !window.isDestroyed() && window.webContents.getURL().endsWith('/index.html')
        ),
      'Actual main window did not load'
    )
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    for (const name of [
      'getTrayMenuTemplate',
      'businessMutationState',
      'shutdownState',
      'featureState',
      'nativeCaptureState',
      'trayState'
    ])
      assert.equal(typeof hooks?.[name], 'function')
    await until(
      () => current.isVisible() && hooks.nativeCaptureState().ready && hooks.trayState().created,
      'Actual product startup prerequisites did not complete'
    )
    assert.equal(appDatabase?.open, true)
    await until(
      () => js("Boolean(document.querySelector('.app-titlebar'))"),
      'Actual main renderer was not ready'
    )
    record('full-product-ready', {
      mainWindowId: current.id,
      capture: hooks.nativeCaptureState(),
      tray: hooks.trayState()
    })
    if (childRole === 'verifier') {
      await until(
        () =>
          expected.rows.every(
            (row) =>
              trace.readyCalls.some(
                (call) => call.stickyId === row.id && call.status === 'succeeded'
              ) &&
              [...states.entries()].some(
                ([senderId, state]) =>
                  state.id === row.id && infoForSender(senderId)?.window.isVisible()
              )
          ),
        'Existing sticky records did not restore visibly'
      )
      assertStorage(assert, snapshotDatabase(profile), expected)
      for (const [index, row] of expected.rows.entries()) {
        const [senderId, state] = [...states.entries()].find(([, state]) => state.id === row.id)
        trace.restored.push(
          await verifyWindow({ senderId, state }, index === 0 ? 'restored-visible.png' : null)
        )
      }
      trayQuit()
      return
    }
    if (childCase === 'new-create') {
      assert.deepEqual(snapshotDatabase(profile).rows, [])
      const response = await js(`window.api.createSticky(${input.notes[0].id})`)
      assert.equal(response.ok, true)
      const first = trace.creates.find((value) => value.noteId === input.notes[0].id)
      assert.ok(first)
      const [senderId, state] = [...states.entries()].find(
        ([, state]) => state.id === response.sticky.id
      )
      const visible = await verifyWindow({ senderId, state }, 'successful-visible-A.png')
      trace.successfulCreate = { ...first, response, visible }
      assert.equal(snapshotDatabase(profile).rows.length, 1)
      armed = true
      await js(`(() => { window.__stickyQuitPending = {status:'pending'};
        void window.api.createSticky(${input.notes[1].id}).then(
          response => { window.__stickyQuitPending = {status:'returned',response} },
          error => { window.__stickyQuitPending = {status:'threw',error:error.message} }); })()`)
    }
    await bounded(enteredGate.promise, 'The actual target renderer ready never reached its gate')
    assert.equal(heldWindow.window.isDestroyed(), false)
    assert.equal(heldWindow.window.isVisible(), false)
    assert.equal(heldWindow.showEvents, 0)
    assert.equal(hooks.businessMutationState().pending, 1)
    const beforeQuit = snapshotDatabase(profile)
    if (childCase === 'new-create') assert.equal(beforeQuit.rows.length, 1)
    else assertStorage(assert, beforeQuit, input.expected)
    trace.beforeQuit = {
      storage: beforeQuit,
      business: hooks.businessMutationState(),
      held: windowSnapshot(heldWindow),
      gateAgeMs: Date.now() - trace.held.heldAt
    }
    record('pending-initialization-before-quit', trace.beforeQuit)
    // All prerequisites were observed; no screenshot or artificial wait occurs inside this gate.
    trayQuit()
    await bounded(
      completedLateReady.promise,
      'The already-received ready did not finish after product cancellation'
    )
    // The single tray intent continues through the original product shutdown itself.
  }
  try {
    app.setPath('userData', profile)
    assert.equal(existsSync(databasePath), true, 'Only the controller seeded this exact database')
    require(resolve('out/main/index.js'))
    const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
      /^index-[\w-]+\.js$/.test(name)
    )
    assert.ok(chunk)
    require(resolve('out/main/chunks', chunk))
    app.on('before-quit', () => {
      if (failed || !quittingRequested) return
      const shutdown = hooks.shutdownState()
      if (shutdown.startedAt !== null && !trace.shutdownBegan) {
        trace.shutdownBegan = { shutdown, business: hooks.businessMutationState() }
        record('product-shutdown-began', trace.shutdownBegan)
      }
    })
    if (app.isReady()) void run().catch(fail)
    else app.once('ready', () => void run().catch(fail))
  } catch (error) {
    fail(error)
  }
}

if (childRole) {
  void child().catch((error) => {
    process.stderr.write((error.stack || String(error)) + '\n')
    process.stdout.write(FAILURE_MARKER)
  })
} else {
  app
    .whenReady()
    .then(controller)
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
