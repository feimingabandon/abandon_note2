import { createRequire } from 'node:module'
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
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'
import { createFailureDiagnostics } from '../scripts/test-failure-diagnostics.cjs'

const SUITE = 'tests/settings-exit-restart-electron.mjs'
const MODE = 'electron-real-app-settings-exit-restart-two-process'
const SCRIPT = fileURLToPath(import.meta.url)
// Twenty independent child launches; these are declared before the first run.
// An unsuccessful child aborts the matrix. Diagnostic/cleanup time never passes it.
const LIMITS = Object.freeze({
  childMs: 45000,
  readinessMs: 12000,
  queryMs: 12000,
  cleanupMs: 5000,
  totalMs: 840000
})
const INITIAL = Object.freeze({
  main: { fontSizeBase: 16, noteRemarkFontSize: 14 },
  month: { fontSizeBase: 23, noteRemarkFontSize: 20 },
  week: { fontSizeBase: 21, noteRemarkFontSize: 22 }
})
const CASES = ['list', 'month', 'week']
  .flatMap((view) =>
    [0, 100, 299].map((delayMs, index) => ({
      id: `${view}-${delayMs}ms`,
      view,
      scope: view === 'list' ? 'main' : view,
      delayMs,
      values: { fontSizeBase: 17 + index, noteRemarkFontSize: 24 + index }
    }))
  )
  .concat({
    id: 'list-month-0ms-navigation-then-quit',
    view: 'list',
    scope: 'main',
    targetView: 'month',
    delayMs: 0,
    values: { fontSizeBase: 18, noteRemarkFontSize: 25 }
  })
const VIEW_LABELS = { list: '便签列表', month: '月视图', week: '周视图' }
const scopeForView = (view) => (view === 'list' ? 'main' : view)
const finalView = (scenario) => scenario.targetView || scenario.view
const SELECTORS = Object.freeze({
  fontSizeBase: '[data-diagnostic-action="settings.fontSizeBase"] input',
  noteRemarkFontSize: '[data-diagnostic-action="settings.noteRemarkFontSize"] input'
})
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const childRole = process.env.ABANDON_SETTINGS_RESTART_CHILD
const controllerProfile = childRole
  ? null
  : prepareTestProfile({ prefix: 'abandon-settings-restart-' })
if (controllerProfile) {
  const userData = join(controllerProfile.directory, 'controller-user-data')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
}
const json = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })

function expectedValues(scenario) {
  return { ...INITIAL, [scenario.scope]: scenario.values }
}

function readDatabase(profile) {
  const database = new Database(join(profile, 'app.db'), {
    readonly: true,
    fileMustExist: true
  })
  try {
    const values = Object.fromEntries(Object.keys(INITIAL).map((scope) => [scope, {}]))
    for (const row of database
      .prepare(
        `SELECT window_name,key,value FROM app_settings
         WHERE window_name IN ('main','month','week')
         AND key IN ('font_size_base','note_remark_font_size') ORDER BY window_name,key`
      )
      .all())
      values[row.window_name][
        row.key === 'font_size_base' ? 'fontSizeBase' : 'noteRemarkFontSize'
      ] = Number(row.value)
    return {
      values,
      activeView: database
        .prepare(
          "SELECT value FROM app_settings WHERE window_name='application' AND key='active_view'"
        )
        .get()?.value,
      integrity: database.pragma('integrity_check', { simple: true })
    }
  } finally {
    database.close()
  }
}

function seed(profile, scenario) {
  mkdirSync(profile, { recursive: true })
  const database = new Database(join(profile, 'app.db'))
  try {
    createDatabaseSchema(database)
    const insert = database.prepare(`INSERT INTO app_settings
      (window_name,type,key,value,remark,created_at,updated_at)
      VALUES (?,?,?,?,'',?,?)`)
    const now = Date.now()
    for (const row of [
      ['application', 'application', 'active_view', scenario.view],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['application', 'system', 'z_order_mode', 'normal'],
      ...Object.entries(INITIAL).flatMap(([scope, values]) => [
        [scope, 'system', 'blur_enabled', 'false'],
        [scope, 'dock', 'dock_enabled_edges', '[]'],
        [scope, 'css', 'font_size_base', String(values.fontSizeBase)],
        [scope, 'css', 'note_remark_font_size', String(values.noteRemarkFontSize)]
      ])
    ])
      insert.run(...row, now, now)
  } finally {
    database.close()
  }
}

function readShutdownRecords(profile) {
  return readdirSync(join(profile, 'logs'))
    .filter((name) => /^app-.*\.jsonl$/.test(name))
    .flatMap((name) =>
      readFileSync(join(profile, 'logs', name), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
    .filter((record) =>
      ['lifecycle.shutdown-start', 'lifecycle.shutdown-complete'].includes(record.scope)
    )
}

function sourceFingerprints() {
  const files = new Set([
    SUITE,
    'tests/helpers/test-result-recorder.cjs',
    'scripts/test-failure-diagnostics.cjs',
    'scripts/test-failure-windows.ps1',
    'src/main/index.js',
    'src/main/settings/settings-operation-admission.js',
    'src/main/settings/settings-write-source.js',
    'src/main/settings/settings-write-coordinator.js',
    'src/main/application/shutdown-coordinator.js',
    'src/main/windows/editing-draft-guard.js',
    'src/main/windows/main-view-navigation.js',
    'src/main/tray/main-tray-controller.js',
    'src/main/sticky/StickyTrayMenu.js',
    'src/preload/index.js',
    'src/preload/settings-client.js',
    'src/renderer/src/components/system/SettingsPanel.vue',
    'src/renderer/src/components/ui/FontSizeInput.vue',
    'src/renderer/src/composables/useSettingsWriteQueue.js',
    'src/renderer/src/utils/pageLeave.js',
    'src/renderer/src/utils/applySettingsSnapshot.js',
    'native_blur/build/bin/blur_engine.dll'
  ])
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (/\.(?:js|cjs|mjs|html|css)$/.test(entry.name))
        files.add(relative(process.cwd(), file))
    }
  }
  visit(resolve('out'))
  return [...files].sort().map((file) => ({
    file: file.replaceAll('\\', '/'),
    sha256: createHash('sha256')
      .update(readFileSync(resolve(file)))
      .digest('hex')
  }))
}

async function runProcess({ role, scenarioIndex, profile, directory, deadline }) {
  mkdirSync(directory, { recursive: true })
  const env = {
    ...process.env,
    ABANDON_SETTINGS_RESTART_CHILD: role,
    ABANDON_SETTINGS_RESTART_CASE: String(scenarioIndex),
    ABANDON_SETTINGS_RESTART_PROFILE: profile,
    ABANDON_SETTINGS_RESTART_EVIDENCE: directory,
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
    scenario: CASES[scenarioIndex],
    profile,
    spawnedAt: null,
    pid: null,
    timeoutMs: Math.min(LIMITS.childMs, Math.max(1, deadline - Date.now())),
    exit: null,
    close: null,
    firstFailure: null,
    forced: false,
    terminationIncomplete: false,
    logErrors: []
  }
  const descriptors = Object.fromEntries(
    ['stdout', 'stderr'].map((name) => [name, openSync(join(directory, `${name}.log`), 'wx')])
  )
  const firstFailure = (kind, details = {}) => {
    if (result.firstFailure) return
    result.firstFailure = { kind, at: Date.now(), ...details }
    try {
      json(join(directory, 'first-failure.json'), result.firstFailure)
    } catch (error) {
      result.logErrors.push(`first-failure evidence: ${error.message}`)
    }
  }
  let diagnostics
  await new Promise((done) => {
    let child,
      timeout,
      fallback,
      stopping = false,
      finished = false
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
      await diagnostics?.capture(reason)
      if (finished) return
      const running = () => child && child.exitCode === null && child.signalCode === null
      if (running()) {
        result.forced = true
        // Only the still-running child created by this controller authorizes tree cleanup.
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
      } else result.terminationIncomplete = true
      fallback = setTimeout(() => {
        result.terminationIncomplete = true
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        child?.unref()
        finish()
      }, LIMITS.cleanupMs)
    }
    try {
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
        writeEvidence: (name, entry) => json(join(directory, name), entry)
      })
      for (const name of ['stdout', 'stderr']) {
        child[name].on('data', (chunk) => {
          if (finished || result.logErrors.length) return
          try {
            let offset = 0
            while (offset < chunk.length) {
              const written = writeSync(descriptors[name], chunk, offset, chunk.length - offset)
              if (!written) throw new Error('Output write made no progress')
              offset += written
            }
          } catch (error) {
            result.logErrors.push(`${name}: ${error.message}`)
            firstFailure('output-write', { stream: name, error: error.message })
            void stop('output-write')
          }
        })
        child[name].on('error', (error) => {
          result.logErrors.push(`${name}: ${error.message}`)
          firstFailure('output-stream', { stream: name, error: error.message })
          void stop('output-stream')
        })
      }
      child.on('error', (error) => {
        firstFailure('spawn', { error: error.message })
      })
      child.on('exit', (code, signal) => {
        result.exit = { code, signal, at: Date.now() }
        if (code !== 0 || signal) firstFailure('process-exit', { code, signal })
        diagnostics.exited(code, signal)
      })
      child.on('close', (code, signal) => {
        result.close = { code, signal, at: Date.now() }
        finish()
      })
      timeout = setTimeout(() => {
        firstFailure('timeout', { timeoutMs: result.timeoutMs })
        void stop('timeout')
      }, result.timeoutMs)
    } catch (error) {
      firstFailure('launch', { error: error.message })
      if (child?.pid) void stop('launch')
      else finish()
    }
  })
  result.diagnostics = await diagnostics?.finish()
  for (const [name, descriptor] of Object.entries(descriptors)) {
    try {
      closeSync(descriptor)
    } catch (error) {
      result.logErrors.push(`${name}: ${error.message}`)
      firstFailure('output-close', { stream: name, error: error.message })
    }
  }
  result.logsSealedAt = Date.now()
  json(join(directory, 'process.json'), result)
  return result
}

async function controller() {
  const recorder = createAssertionRecorder({
    suite: SUITE,
    mode: MODE,
    metadata: {
      realWindows: true,
      realRendererAndPreload: true,
      realDiskDatabase: true,
      mainProcessRestart: true,
      cases: CASES,
      limits: LIMITS,
      reseedBetweenProcesses: false,
      inputPaths: {
        fontSizeBase: 'Enter-committed-model-with-300ms-debounce',
        noteRemarkFontSize: 'focused-local-text-without-Enter'
      },
      timing: 'requested-delays-and-observed-dispatch-status-not-sub-millisecond-certification',
      dispatchObservation:
        'production-main-handler-entry; an in-transit renderer IPC is not observable here',
      quitEntry: 'production-tray-menu-callback',
      combinedNavigation: 'one-open-settings-0ms-list-to-month-success-before-quit-and-restart',
      nativeTrayMouseHitTesting: false,
      failureAndDeferredQuit: 'covered-by-separate-settings-quit-electron-suite',
      nonqueueOperations: 'covered-by-separate-settings-operation-quit-electron-suite'
    }
  })
  const { assert } = recorder
  const profile = controllerProfile
  const output = process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory
  const startedAt = Date.now()
  const deadline = startedAt + LIMITS.totalMs
  const scenarios = []
  let failure = null
  let completed = false
  let evidenceComplete = false
  let fingerprintsWritten = false
  const processes = []
  try {
    assert.equal(process.platform, 'win32', 'This real desktop suite requires Windows')
    json(join(output, 'source-fingerprints.json'), sourceFingerprints())
    fingerprintsWritten = true
    for (const [index, scenario] of CASES.entries()) {
      assert.ok(Date.now() < deadline, 'Declared suite deadline has not elapsed')
      const directory = join(output, scenario.id)
      const childProfile = join(profile.directory, 'profiles', scenario.id)
      mkdirSync(directory, { recursive: true })
      seed(childProfile, scenario)
      const before = readDatabase(childProfile)
      assert.deepEqual(before.values, INITIAL)
      assert.equal(before.activeView, scenario.view)
      assert.equal(before.integrity, 'ok')
      json(join(directory, 'database-before.json'), before)
      const entry = { scenario, profile: childProfile, before, children: [] }
      scenarios.push(entry)
      for (const role of ['writer', 'verifier']) {
        const childDirectory = join(directory, role)
        const processResult = await runProcess({
          role,
          scenarioIndex: index,
          profile: childProfile,
          directory: childDirectory,
          deadline
        })
        processes.push(processResult)
        entry.children.push({ role, directory: childDirectory, process: processResult })
        assert.equal(
          processResult.firstFailure,
          null,
          `${scenario.id} ${role}: first process failure`
        )
        assert.equal(processResult.forced, false, 'Forced cleanup cannot pass normal exit')
        assert.equal(processResult.terminationIncomplete, false, 'Owned process cleanup completed')
        assert.deepEqual(processResult.logErrors, [], 'Both original output streams were sealed')
        assert.equal(processResult.exit?.code, 0, `${scenario.id} ${role}: actual process exit`)
        assert.equal(processResult.exit?.signal, null)
        assert.equal(processResult.close?.code, 0, 'Output pipes closed after process exit')
        assert.ok(processResult.close.at >= processResult.exit.at)
        const report = JSON.parse(readFileSync(join(childDirectory, 'child-result.json'), 'utf8'))
        entry.children.at(-1).report = report
        assert.equal(report.completed, true, `${role}: recorded business assertions completed`)
        assert.equal(report.assertions.failed, 0)
        assert.ok(report.assertions.total > 0)
        assert.equal(report.evidence.status, 'complete')
        assert.equal(report.cleanup.windowsClosed, true)
        assert.equal(report.cleanup.reachedWillQuit, true)
        assert.equal(report.cleanup.forcedExit, false)
        assert.equal(report.metadata.pid, processResult.pid)
        assert.equal(report.metadata.profile, childProfile)
        const database = readDatabase(childProfile)
        json(join(childDirectory, 'database-after-exit.json'), database)
        assert.deepEqual(
          database.values,
          expectedValues(scenario),
          'Only originating scope changed'
        )
        assert.equal(database.activeView, finalView(scenario))
        assert.equal(database.integrity, 'ok', 'Disk database is valid after actual process exit')
        const records = readShutdownRecords(childProfile)
        const previousSessions = new Set(entry.children.slice(0, -1).map((item) => item.sessionId))
        const starts = records.filter(
          (record) =>
            record.scope === 'lifecycle.shutdown-start' && !previousSessions.has(record.sessionId)
        )
        const finishes = records.filter(
          (record) =>
            record.scope === 'lifecycle.shutdown-complete' &&
            !previousSessions.has(record.sessionId)
        )
        assert.equal(starts.length, 1, 'Exactly one new shutdown admission per process')
        assert.equal(finishes.length, 1, 'Exactly one durable completion per process')
        assert.equal(starts[0].sessionId, finishes[0].sessionId)
        assert.equal(finishes[0].metadata.trigger, 'tray-menu')
        for (const name of ['settings-operations', 'database', 'tray'])
          assert.equal(finishes[0].metadata.stages[name]?.status, 'complete')
        for (const [name, stage] of Object.entries(finishes[0].metadata.stages))
          assert.notEqual(stage.status, 'failed', `${name} shutdown stage did not fail`)
        entry.children.at(-1).sessionId = finishes[0].sessionId
        json(join(childDirectory, 'shutdown-records.json'), { starts, finishes })
        if (role === 'writer') {
          entry.writerExitedAt = processResult.exit.at
          entry.writerLogsSealedAt = processResult.logsSealedAt
          entry.afterWriter = database
        } else {
          assert.ok(processResult.spawnedAt >= entry.writerLogsSealedAt)
          assert.notEqual(
            entry.children[0].sessionId,
            finishes[0].sessionId,
            'A new logging session booted'
          )
          // Windows may recycle a numeric PID. Sequential spawn after exit/close,
          // plus a new application session, binds the two distinct lifetimes.
          assert.ok(processResult.spawnedAt >= entry.children[0].process.exit.at)
          if (scenario.targetView) {
            const writerEvidence = JSON.parse(
              readFileSync(join(entry.children[0].directory, 'child-evidence.json'), 'utf8')
            )
            const verifierEvidence = JSON.parse(
              readFileSync(join(childDirectory, 'child-evidence.json'), 'utf8')
            )
            assert.notEqual(
              writerEvidence.sourceBeforeInput.token,
              verifierEvidence.verifiedUi.source.token,
              'Restarted source view owns a new document token'
            )
            assert.notEqual(
              writerEvidence.navigation.targetRuntime.source.token,
              verifierEvidence.reopenedTargetUi.source.token,
              'The saved target really restarted in a different document lifetime'
            )
            assert.equal(
              verifierEvidence.reopenedTargetUi.source.scope,
              scopeForView(scenario.targetView)
            )
          }
          entry.afterVerifier = database
        }
      }
      json(join(directory, 'scenario.json'), entry)
    }
    assert.equal(scenarios.length, 10)
    assert.equal(processes.length, 20)
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  }
  try {
    json(join(output, 'settings-exit-restart-evidence.json'), {
      startedAt,
      finishedAt: Date.now(),
      completed,
      failure: failure?.stack || null,
      limits: LIMITS,
      scenarios,
      processes
    })
    evidenceComplete = fingerprintsWritten
  } catch (error) {
    failure ||= error
    console.error(error)
  }
  const clean = processes.every(
    (item) =>
      item.exit &&
      item.close &&
      !item.forced &&
      !item.terminationIncomplete &&
      !item.logErrors.length
  )
  recorder.finish({
    completed: completed && evidenceComplete && clean,
    error: failure,
    evidence: {
      status: evidenceComplete ? 'complete' : 'incomplete',
      artifacts: [
        ...(fingerprintsWritten ? ['source-fingerprints.json'] : []),
        ...(existsSync(join(output, 'settings-exit-restart-evidence.json'))
          ? ['settings-exit-restart-evidence.json']
          : [])
      ],
      scope:
        'Ten isolated disk profiles, twenty actual app processes, post-exit SQL and reopened UI/CSS'
    },
    profileOwnership: profile.ownership,
    cleanup: {
      status: !clean
        ? 'failed'
        : completed && profile.ownership === 'runner'
          ? 'complete'
          : 'preserved',
      ownedProcessesClosed: clean,
      preservedProfile:
        !completed || profile.ownership === 'script' ? profile.directory : undefined,
      scope:
        'Controller observes child exit and pipe close; runner removes its owned profiles after controller exit'
    }
  })
  // This process is the test controller, never the product process under acceptance.
  app.exit(completed && evidenceComplete && clean && !failure ? 0 : 1)
}

async function child() {
  const scenarioIndex = Number(process.env.ABANDON_SETTINGS_RESTART_CASE)
  if (!Number.isInteger(scenarioIndex) || !CASES[scenarioIndex])
    throw new Error('Invalid scenario index')
  if (!['writer', 'verifier'].includes(childRole)) throw new Error('Invalid child role')
  const scenario = CASES[scenarioIndex]
  const profile = resolve(process.env.ABANDON_SETTINGS_RESTART_PROFILE)
  const output = resolve(process.env.ABANDON_SETTINGS_RESTART_EVIDENCE)
  const recorder = createAssertionRecorder({
    suite: SUITE,
    mode: `${MODE}-${childRole}`,
    env: {},
    metadata: { role: childRole, pid: process.pid, profile, scenario }
  })
  const { assert } = recorder
  const events = [],
    writes = [],
    navigations = []
  let sequence = 0,
    phase = 'startup',
    firstFailure = null
  let current, hooks, input, initialUi, verifiedUi, shutdown
  let sourceBeforeInput, navigation, reopenedTargetUi
  let quitRequested = false,
    reachedWillQuit = false,
    evidenceWritten = false,
    finalized = false
  let productQuitAt = null
  const record = (event, details = {}) => {
    const value = {
      sequence: ++sequence,
      event,
      phase,
      at: Date.now(),
      pid: process.pid,
      ...details
    }
    events.push(value)
    appendFileSync(join(output, 'events.jsonl'), JSON.stringify(value) + '\n')
    return value
  }
  const exitEvent = (event, details = {}) =>
    appendFileSync(
      join(output, 'gui-exit-events.jsonl'),
      JSON.stringify({
        event,
        pid: process.pid,
        time: new Date().toISOString(),
        suite: SUITE,
        ...details
      }) + '\n'
    )
  function fail(error) {
    if (!firstFailure) {
      firstFailure = error instanceof Error ? error : new Error(String(error))
      process.stderr.write(firstFailure.stack + '\n')
      json(join(output, 'child-first-failure.json'), {
        phase,
        error: firstFailure.stack,
        events,
        writes,
        input,
        initialUi,
        verifiedUi,
        sourceBeforeInput,
        navigation,
        reopenedTargetUi,
        navigations
      })
    }
    process.exitCode = 1
    // The controller owns the external watchdog and diagnostics; no in-process kill.
    app.quit()
  }
  async function bounded(promise, label, timeoutMs = LIMITS.queryMs) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${phase}: ${label}`)), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function until(predicate, label) {
    const deadline = Date.now() + LIMITS.readinessMs
    while (Date.now() < deadline) {
      const value = await bounded(Promise.resolve().then(predicate), label)
      if (value) return value
      await wait(20)
    }
    throw new Error(`${phase}: ${label}`)
  }
  const js = (source) =>
    bounded(current.webContents.executeJavaScript(source), 'Renderer query timed out')
  function formStateSource() {
    return `(() => {
      const panel=document.querySelector('.settings-panel.active');
      const base=document.querySelector(${JSON.stringify(SELECTORS.fontSizeBase)});
      const remark=document.querySelector(${JSON.stringify(SELECTORS.noteRemarkFontSize)});
      const styles=getComputedStyle(document.documentElement);
      return { present:Boolean(panel&&base&&remark), inert:panel?.inert,
        values:{fontSizeBase:Number(base?.value),noteRemarkFontSize:Number(remark?.value)},
        css:{fontSizeBase:styles.getPropertyValue('--font-size-base').trim(),
          noteRemarkFontSize:styles.getPropertyValue('--note-remark-font-size').trim()},
        focusedRemark:document.activeElement===remark,
        error:document.querySelector('.settings-save-error')?.textContent.trim()||'' };
    })()`
  }
  const runtimeState = () =>
    js(`(async () => {
    const snapshot=await window.api.getSettingsSnapshot();
    const styles=getComputedStyle(document.documentElement);
    return {source:snapshot.source,values:{
      fontSizeBase:snapshot.values.css.fontSizeBase,
      noteRemarkFontSize:snapshot.values.css.noteRemarkFontSize},
      css:{fontSizeBase:styles.getPropertyValue('--font-size-base').trim(),
        noteRemarkFontSize:styles.getPropertyValue('--note-remark-font-size').trim()}};
  })()`)
  function trayViewItem(mode) {
    const menu = hooks.getTrayMenuTemplate().find((item) => item.label?.startsWith('当前视图：'))
    const item = menu?.submenu.find((candidate) => candidate.label === VIEW_LABELS[mode])
    assert.equal(typeof item?.click, 'function', 'Production tray view callback exists')
    return item
  }
  async function waitForView(mode) {
    const filename = mode === 'list' ? 'index' : mode
    await until(() => {
      const state = hooks.navigationState()
      return (
        current.webContents.getURL().endsWith(`/${filename}.html`) &&
        state.mode === mode &&
        !state.switching &&
        !state.checkingDrafts &&
        !state.pendingReady &&
        !state.queuedTarget &&
        current.isVisible()
      )
    }, 'Actual renderer-ready view navigation completed: ' + mode)
    await until(
      () => js('Boolean(document.querySelector(".titlebar-btn-settings"))'),
      'Target view settings control ready'
    )
  }
  async function openSettingsFor(values) {
    await js('document.querySelector(".titlebar-btn-settings").click()')
    return until(async () => {
      const state = await js(formStateSource())
      return (
        state.present &&
        !state.inert &&
        Object.entries(values).every(([field, value]) => state.values[field] === value) &&
        state
      )
    }, 'Real settings form loaded its actual snapshot')
  }
  const originalHandle = ipcMain.handle
  ipcMain.handle = function (channel, listener) {
    if (channel !== 'set-setting-value') return originalHandle.call(this, channel, listener)
    return originalHandle.call(this, channel, async (event, id, value, source) => {
      const entry = record('setting-main-handler-entered', {
        id,
        value,
        sourceScope: source?.scope,
        sourceToken: source?.token
      })
      writes.push(entry)
      try {
        const result = await listener(event, id, value, source)
        entry.status = 'saved'
        return result
      } catch (error) {
        entry.status = 'failed'
        entry.error = error.message
        throw error
      } finally {
        entry.finishedSequence = record('setting-settled', {
          id,
          value,
          status: entry.status,
          error: entry.error
        }).sequence
      }
    })
  }

  app.on('will-quit', () => {
    if (reachedWillQuit) return
    reachedWillQuit = true
    const observation = record('will-quit')
    exitEvent('will-quit')
    try {
      if (firstFailure) return
      assert.equal(
        quitRequested,
        true,
        'The only successful exit was requested by the real tray callback'
      )
      shutdown = hooks.shutdownState()
      assert.equal(shutdown.completed, true)
      assert.equal(shutdown.trigger, 'tray-menu')
      assert.equal(hooks.settingsOperationState().pending, 0)
      assert.equal(hooks.settingsOperationState().stopped, true)
      for (const name of ['settings-operations', 'database', 'tray'])
        assert.equal(shutdown.stages[name]?.status, 'complete')
      for (const [name, stage] of Object.entries(shutdown.stages))
        assert.notEqual(stage.status, 'failed', `${name} stage completed without failure`)
      assert.equal(current.isDestroyed(), true)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      if (childRole === 'writer') {
        assert.equal(writes.length, 2, 'Only the two intentional generic settings writes occurred')
        for (const [field, value] of Object.entries(scenario.values)) {
          const matching = writes.filter(
            (entry) => entry.id === `css.${field}` && entry.value === value
          )
          assert.equal(matching.length, 1, 'Exactly one final write for each changed setting')
          assert.equal(matching[0].status, 'saved')
          assert.equal(matching[0].sourceScope, scenario.scope)
          if (scenario.targetView) assert.equal(matching[0].sourceToken, sourceBeforeInput.token)
          assert.ok(matching[0].finishedSequence < observation.sequence)
          if (field === 'noteRemarkFontSize' && !scenario.targetView)
            assert.ok(
              matching[0].sequence > input.quitSequence,
              'Uncommitted text was dispatched by leave preparation'
            )
        }
        assert.equal(input.focusedRemark, true)
        if (scenario.targetView) {
          assert.equal(input.settingsPanelOpen, true)
          assert.equal(input.remarkMainHandlerEnteredBeforeNavigation, false)
          const committed = navigations.find((entry) => entry.url.endsWith('/month.html'))
          assert.ok(committed, 'The target document really committed before quit')
          for (const write of writes) assert.ok(write.finishedSequence < committed.sequence)
          const remark = writes.find((entry) => entry.id === 'css.noteRemarkFontSize')
          assert.ok(remark.sequence > input.navigationSequence)
          assert.ok(committed.sequence < input.quitSequence)
          assert.equal(navigation.targetRuntime.source.scope, scopeForView(scenario.targetView))
        } else assert.equal(input.remarkMainHandlerEnteredBeforeQuit, false)
      } else {
        assert.equal(writes.length, 0, 'Reopened UI verification did not write or reseed settings')
        assert.deepEqual(verifiedUi.values, scenario.values)
      }
      json(join(output, 'child-evidence.json'), {
        role: childRole,
        scenario,
        profile,
        pid: process.pid,
        input,
        initialUi,
        verifiedUi,
        sourceBeforeInput,
        navigation,
        reopenedTargetUi,
        navigations,
        events,
        writes,
        shutdown,
        productQuitAt
      })
      evidenceWritten = true
    } catch (error) {
      if (!firstFailure) {
        firstFailure = error
        process.stderr.write(error.stack + '\n')
        process.exitCode = 1
        json(join(output, 'child-first-failure.json'), {
          phase,
          error: error.stack,
          input,
          initialUi,
          verifiedUi,
          events,
          writes,
          shutdown
        })
      }
    }
  })
  app.once('quit', (_event, code) => {
    ipcMain.handle = originalHandle
    exitEvent('quit', { code })
    if (finalized) return
    finalized = true
    const windowsClosed = BrowserWindow.getAllWindows().length === 0
    try {
      assert.equal(code, 0, 'Product quit reported zero exit status')
      assert.equal(windowsClosed, true)
      assert.equal(reachedWillQuit, true)
      assert.equal(evidenceWritten, true)
    } catch (error) {
      firstFailure ||= error
      process.exitCode = 1
    }
    const report = recorder.finish({
      completed:
        !firstFailure &&
        quitRequested &&
        reachedWillQuit &&
        evidenceWritten &&
        windowsClosed &&
        code === 0,
      error: firstFailure,
      evidence: {
        status: evidenceWritten ? 'complete' : 'incomplete',
        artifacts: ['child-evidence.json', 'events.jsonl', 'gui-exit-events.jsonl']
      },
      profileOwnership: 'script',
      cleanup: {
        status: windowsClosed && reachedWillQuit ? 'preserved' : 'failed',
        reachedWillQuit,
        windowsClosed,
        forcedExit: false,
        exitCode: code,
        preservedProfile: profile,
        scope: 'Controller retains this exact profile for the second process'
      }
    })
    json(join(output, 'child-result.json'), report)
  })

  async function run() {
    const bootView = childRole === 'verifier' ? finalView(scenario) : scenario.view
    const page = bootView === 'list' ? 'index' : bootView
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (window) => !window.isDestroyed() && window.webContents.getURL().endsWith(`/${page}.html`)
        ),
      'Actual requested view loaded'
    )
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    for (const name of [
      'getTrayMenuTemplate',
      'settingsOperationState',
      'shutdownState',
      'navigationState',
      'nativeCaptureState'
    ])
      assert.equal(typeof hooks?.[name], 'function', `${name} observation exists`)
    await until(
      () => current.isVisible() && hooks.nativeCaptureState().ready,
      'Application and capture prerequisite ready'
    )
    await until(
      () => js('Boolean(document.querySelector(".titlebar-btn-settings"))'),
      'Settings button ready'
    )
    assert.equal(hooks.navigationState().mode, bootView)
    current.webContents.on('did-navigate', (_event, url) => {
      navigations.push(record('document-committed', { url }))
    })
    const expected = childRole === 'writer' ? INITIAL : expectedValues(scenario)
    const database = readDatabase(profile)
    assert.deepEqual(
      database.values,
      expected,
      'Startup reads the expected disk database without reseeding'
    )
    assert.equal(database.integrity, 'ok')
    initialUi = await openSettingsFor(expected[scopeForView(bootView)])
    assert.equal(initialUi.error, '')
    const quitItem = hooks.getTrayMenuTemplate().find((item) => item.label === '退出应用')
    assert.equal(typeof quitItem?.click, 'function', 'Production tray quit callback exists')
    assert.equal(writes.length, 0, 'Startup and opening settings did not persist defaults')
    if (childRole === 'writer') {
      const targetItem = scenario.targetView ? trayViewItem(scenario.targetView) : null
      if (scenario.targetView) {
        sourceBeforeInput = (await runtimeState()).source
        assert.equal(sourceBeforeInput.scope, scenario.scope)
        assert.equal(typeof sourceBeforeInput.token, 'string')
      }
      phase = scenario.targetView ? 'input-navigation-and-quit' : 'input-and-direct-quit'
      input = await js(`(async () => {
        const base=document.querySelector(${JSON.stringify(SELECTORS.fontSizeBase)});
        const remark=document.querySelector(${JSON.stringify(SELECTORS.noteRemarkFontSize)});
        if (!base || !remark || base.closest('.settings-panel').inert) throw new Error('Settings are not editable');
        base.focus(); base.value=${JSON.stringify(String(scenario.values.fontSizeBase))};
        const baseInputAt=Date.now();
        base.dispatchEvent(new Event('input',{bubbles:true}));
        base.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        remark.focus(); remark.value=${JSON.stringify(String(scenario.values.noteRemarkFontSize))};
        const localInputAt=Date.now();
        remark.dispatchEvent(new Event('input',{bubbles:true}));
        await Promise.resolve();
        const styles=getComputedStyle(document.documentElement);
        return {baseInputAt,localInputAt,focusedRemark:document.activeElement===remark,
          settingsPanelOpen:Boolean(document.querySelector('.settings-panel.active')),
          baseCss:styles.getPropertyValue('--font-size-base').trim(),
          remarkCss:styles.getPropertyValue('--note-remark-font-size').trim(),
          baseText:base.value,remarkText:remark.value};
      })()`)
      const remaining = input.baseInputAt + scenario.delayMs - Date.now()
      if (remaining > 0) await wait(remaining)
      // No screenshots, assertions, SQL reads, explicit flush, or focus changes in this interval.
      input.requestedDelayMs = scenario.delayMs
      if (scenario.targetView) {
        input.remarkMainHandlerEnteredBeforeNavigation = writes.some(
          (entry) => entry.id === 'css.noteRemarkFontSize'
        )
        input.navigationSequence = ++sequence
        const requested = {
          sequence: input.navigationSequence,
          event: 'tray-view-request',
          phase,
          at: Date.now(),
          sourceView: scenario.view,
          targetView: scenario.targetView,
          pid: process.pid
        }
        input.actualInputToNavigationMs = requested.at - input.baseInputAt
        events.push(requested)
        targetItem.click()
        appendFileSync(join(output, 'events.jsonl'), JSON.stringify(requested) + '\n')
        await waitForView(scenario.targetView)
        navigation = {
          request: requested,
          targetRuntime: await runtimeState(),
          database: readDatabase(profile)
        }
        assert.equal(navigation.database.activeView, scenario.targetView)
        assert.deepEqual(navigation.database.values, expectedValues(scenario))
        assert.equal(navigation.targetRuntime.source.scope, scopeForView(scenario.targetView))
        assert.notEqual(navigation.targetRuntime.source.token, sourceBeforeInput.token)
        assert.deepEqual(
          navigation.targetRuntime.values,
          INITIAL[scopeForView(scenario.targetView)]
        )
        assert.equal(
          navigation.targetRuntime.css.fontSizeBase,
          `${INITIAL[scopeForView(scenario.targetView)].fontSizeBase}rem`
        )
        assert.equal(
          navigation.targetRuntime.css.noteRemarkFontSize,
          `${INITIAL[scopeForView(scenario.targetView)].noteRemarkFontSize}rem`
        )
      }
      input.baseMainHandlerEnteredBeforeQuit = writes.some(
        (entry) => entry.id === 'css.fontSizeBase'
      )
      input.remarkMainHandlerEnteredBeforeQuit = writes.some(
        (entry) => entry.id === 'css.noteRemarkFontSize'
      )
      input.quitSequence = ++sequence
      quitRequested = true
      productQuitAt = Date.now()
      input.actualBaseDelayMs = productQuitAt - input.baseInputAt
      input.actualLocalTextDelayMs = productQuitAt - input.localInputAt
      const requested = {
        sequence: input.quitSequence,
        event: 'tray-quit-request',
        phase,
        at: productQuitAt,
        pid: process.pid,
        ...input
      }
      events.push(requested)
      quitItem.click()
      appendFileSync(join(output, 'events.jsonl'), JSON.stringify(requested) + '\n')
      exitEvent('finish-start', { role: childRole, scenario: scenario.id })
      // Validate the already-captured input evidence without delaying the quit request.
      assert.equal(
        input.baseCss,
        `${scenario.values.fontSizeBase}rem`,
        'Enter committed the base model before exit'
      )
      assert.equal(
        input.remarkCss,
        `${INITIAL[scenario.scope].noteRemarkFontSize}rem`,
        'Focused remark text was not yet committed'
      )
      assert.equal(input.baseText, String(scenario.values.fontSizeBase))
      assert.equal(input.remarkText, String(scenario.values.noteRemarkFontSize))
      assert.equal(input.focusedRemark, true)
    } else {
      phase = 'reopened-ui-verification'
      if (scenario.targetView) {
        reopenedTargetUi = { ...initialUi, source: (await runtimeState()).source }
        assert.deepEqual(reopenedTargetUi.values, INITIAL[scopeForView(scenario.targetView)])
        assert.equal(
          reopenedTargetUi.css.fontSizeBase,
          `${INITIAL[scopeForView(scenario.targetView)].fontSizeBase}rem`
        )
        assert.equal(
          reopenedTargetUi.css.noteRemarkFontSize,
          `${INITIAL[scopeForView(scenario.targetView)].noteRemarkFontSize}rem`
        )
        assert.equal(reopenedTargetUi.source.scope, scopeForView(scenario.targetView))
        trayViewItem(scenario.view).click()
        await waitForView(scenario.view)
        await openSettingsFor(scenario.values)
      }
      verifiedUi = await js(formStateSource())
      if (scenario.targetView) {
        verifiedUi.source = (await runtimeState()).source
        assert.equal(verifiedUi.source.scope, scenario.scope)
      }
      assert.deepEqual(verifiedUi.values, scenario.values)
      assert.equal(verifiedUi.css.fontSizeBase, `${scenario.values.fontSizeBase}rem`)
      assert.equal(verifiedUi.css.noteRemarkFontSize, `${scenario.values.noteRemarkFontSize}rem`)
      assert.equal(verifiedUi.error, '')
      const png = (
        await bounded(current.webContents.capturePage(), 'Reopened UI screenshot', 3000)
      ).toPNG()
      writeFileSync(join(output, 'reopened-ui.png'), png, { flag: 'wx' })
      verifiedUi.screenshotSha256 = createHash('sha256').update(png).digest('hex')
      if (scenario.targetView) {
        trayViewItem(scenario.targetView).click()
        await waitForView(scenario.targetView)
        navigation = { restoredTargetRuntime: await runtimeState() }
        assert.deepEqual(
          navigation.restoredTargetRuntime.values,
          INITIAL[scopeForView(scenario.targetView)]
        )
        assert.equal(
          navigation.restoredTargetRuntime.source.scope,
          scopeForView(scenario.targetView)
        )
      }
      productQuitAt = Date.now()
      record('tray-quit-request')
      quitRequested = true
      exitEvent('finish-start', { role: childRole, scenario: scenario.id })
      quitItem.click()
    }
  }
  try {
    app.setPath('userData', profile)
    assert.equal(
      existsSync(join(profile, 'app.db')),
      true,
      'Controller seeded the disk database once'
    )
    const require = createRequire(import.meta.url)
    require(resolve('out/main/index.js'))
    const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
      /^index-[\w-]+\.js$/.test(name)
    )
    assert.ok(chunk, 'Built production main chunk exists')
    require(resolve('out/main/chunks', chunk))
    if (app.isReady()) void run().catch(fail)
    else app.once('ready', () => void run().catch(fail))
  } catch (error) {
    fail(error)
  }
}

if (childRole) {
  void child().catch((error) => {
    process.stderr.write((error.stack || String(error)) + '\n')
    process.exitCode = 1
    app.quit()
  })
} else {
  void app
    .whenReady()
    .then(controller)
    .catch((error) => {
      process.stderr.write((error.stack || String(error)) + '\n')
      app.exit(1)
    })
}
