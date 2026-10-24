// A native error box intentionally blocks this test's disposable Electron child.
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} = require('node:fs')
const { join, resolve } = require('node:path')
const { createAssertionRecorder } = require('./helpers/test-result-recorder.cjs')
const { collectWindowsFailure } = require('../scripts/test-failure-diagnostics.cjs')
const { runJob } = require('../scripts/test-runner.cjs')

const recorder = createAssertionRecorder({
  suite: 'tests/test-failure-diagnostics-win.cjs',
  mode: 'node-windows-failure-diagnostics'
})
const assert = recorder.assert
const executable = require('electron')
const ownerMarker = `owned-native-error-${randomUUID()}`
const siblingMarker = `excluded-sibling-window-${randomUUID()}`
const originalError = 'original-native-modal-failure: 对象已销毁，保留首次错误'
const nativeText = `受控原生错误框：对象已销毁。${ownerMarker}`
let control
let controlExited = false
let directory
let failure
let controlExit
let controlStopFile

function waitForControl(child) {
  return new Promise((done, reject) => {
    let output = ''
    let errors = ''
    const timer = setTimeout(
      () => reject(new Error('Sibling fixture did not become ready')),
      10_000
    )
    child.stderr.on('data', (chunk) => (errors += chunk.toString('utf8')))
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      if (!output.includes('CONTROL_READY\n')) return
      clearTimeout(timer)
      done()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (!output.includes('CONTROL_READY\n'))
        reject(new Error(`Sibling fixture exited before ready: ${code}/${signal}; ${errors}`))
    })
  })
}

async function stopControl() {
  if (!control || controlExited) return { status: 'complete' }
  writeFileSync(controlStopFile, 'quit\n', { flag: 'wx' })
  let timer
  const stopped = await Promise.race([
    controlExit.then(() => true),
    new Promise((done) => (timer = setTimeout(() => done(false), 5000)))
  ])
  clearTimeout(timer)
  if (stopped) return { status: 'complete' }
  // Only this exact spawned fixture tree is eligible for fallback cleanup.
  const killer = spawn('taskkill.exe', ['/PID', String(control.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  await new Promise((done) => {
    const limit = setTimeout(done, 5000)
    killer.once('error', done)
    killer.once('exit', () => {
      clearTimeout(limit)
      done()
    })
  })
  return { status: 'failed', reason: 'Sibling fixture required forced cleanup' }
}

async function main() {
  assert.equal(process.platform, 'win32')
  const root = process.env.ABANDON_TEST_EVIDENCE_DIR || resolve('tmp/test-failure-diagnostics-win')
  mkdirSync(root, { recursive: true })
  directory = mkdtempSync(join(root, 'native-dialog-'))
  const fixture = join(directory, 'fixture.cjs')
  const controlProfile = join(directory, 'sibling-profile')
  controlStopFile = join(directory, 'stop-sibling')
  mkdirSync(controlProfile)
  writeFileSync(
    fixture,
    `const { app, BrowserWindow, dialog } = require('electron')
const { appendFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
app.setPath('userData', process.env.ABANDON_TEST_USER_DATA)
app.whenReady().then(async () => {
  if (process.argv[2] !== 'hidden') {
    global.fixture = new BrowserWindow({ show: false, title: 'Diagnostic fixture', width: 280, height: 160 })
    await global.fixture.loadURL('data:text/html;charset=utf-8,<title>Diagnostic fixture</title><p>Disposable diagnostic test window</p>')
    global.fixture.showInactive()
    if (!global.fixture.isVisible()) global.fixture.showInactive()
  }
  if (process.argv[2] === 'control') {
    global.fixture.setTitle(${JSON.stringify(siblingMarker)})
    setInterval(() => {
      if (!existsSync(${JSON.stringify(controlStopFile)})) return
      process.stdout.write('CONTROL_QUIT\\n')
      global.fixture.destroy()
      app.quit()
    }, 50)
    process.stdout.write('CONTROL_READY\\n')
    return
  }
  if (global.fixture) global.fixture.setTitle(${JSON.stringify(ownerMarker)})
  process.stderr.write(${JSON.stringify(originalError + '\n')})
  appendFileSync(join(process.env.ABANDON_TEST_EVIDENCE_DIR, 'gui-exit-events.jsonl'), JSON.stringify({ pid: process.pid, event: 'finish-start' }) + '\\n')
  dialog.showErrorBox(${JSON.stringify(ownerMarker)}, ${JSON.stringify(nativeText)})
  process.stdout.write('UNEXPECTED_MODAL_RETURN\\n')
  app.exit(93)
})
`,
    { flag: 'wx' }
  )
  const controlSpawnedMs = Date.now()
  const controlEnv = { ...process.env, ABANDON_TEST_USER_DATA: controlProfile }
  delete controlEnv.ELECTRON_RUN_AS_NODE
  control = spawn(executable, [fixture, 'control'], {
    env: controlEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  control.stdin.on('error', () => {})
  for (const name of ['stdout', 'stderr'])
    control[name].on('data', (chunk) =>
      appendFileSync(join(directory, `sibling-${name}.log`), chunk)
    )
  controlExit = new Promise((done) =>
    control.once('exit', (code, signal) => {
      controlExited = true
      done({ code, signal })
    })
  )
  await waitForControl(control)
  const controlObservation = await collectWindowsFailure({
    version: 1,
    runnerPid: process.pid,
    rootPid: control.pid,
    command: executable,
    args: [fixture, 'control'],
    spawnedMs: controlSpawnedMs,
    focusPid: control.pid
  })
  writeFileSync(
    join(directory, 'sibling-precondition.json'),
    JSON.stringify(controlObservation, null, 2),
    {
      flag: 'wx'
    }
  )
  const siblingSnapshot = controlObservation.partial || controlObservation
  assert.ok(
    siblingSnapshot.windows?.some((entry) => entry.Text === siblingMarker && entry.Visible),
    JSON.stringify(controlObservation)
  )
  const refused = await collectWindowsFailure({
    version: 1,
    runnerPid: process.pid,
    rootPid: control.pid,
    command: executable,
    args: [fixture, 'control'],
    spawnedMs: controlSpawnedMs,
    focusPid: process.pid
  })
  writeFileSync(join(directory, 'unowned-focus.json'), JSON.stringify(refused, null, 2), {
    flag: 'wx'
  })
  assert.equal(refused.status, 'refused-or-unavailable', JSON.stringify(refused))
  assert.match(refused.reason, /not a verified descendant/)
  assert.equal(refused.windows, undefined)
  // Keep the no-BrowserWindow scene as an explicit boundary. A hidden native
  // dialog may expose only its Error caption; that must remain text-unavailable.
  for (const mode of ['hidden', 'modal']) {
    const result = await runJob(
      {
        id: `known-native-${mode}`,
        command: executable,
        gui: true,
        timeoutMs: 8000,
        prepare: ({ directory: evidence }) => ({
          args: [fixture, mode],
          env: { ABANDON_TEST_EVIDENCE_DIR: evidence }
        })
      },
      { directory }
    )
    writeFileSync(
      join(directory, `${mode}-expected-failure.json`),
      JSON.stringify(result, null, 2),
      {
        flag: 'wx'
      }
    )
    assert.equal(result.accepted, false)
    assert.equal(result.processResult.status, 'timeout')
    assert.equal(result.firstFailure.kind, 'timeout')
    assert.equal(result.firstFailure.timeoutMs, 8000)
    assert.equal(result.processResult.terminationIncomplete, false)
    assert.ok(existsSync(result.preservedTemporary))
    assert.ok(readFileSync(join(result.directory, 'stderr.log'), 'utf8').includes(originalError))
    assert.ok(
      !readFileSync(join(result.directory, 'stdout.log'), 'utf8').includes(
        'UNEXPECTED_MODAL_RETURN'
      )
    )
    const collections = result.failureDiagnostics.collections
    assert.ok(collections.some((entry) => entry.trigger === 'exit-pending'))
    const observations = collections.map((entry) => entry.observation.partial || entry.observation)
    const serialized = JSON.stringify(observations)
    if (mode === 'modal') {
      assert.ok(serialized.includes(ownerMarker), serialized)
      assert.ok(serialized.includes('受控原生错误框：对象已销毁'), serialized)
    }
    assert.ok(!serialized.includes(siblingMarker), 'An unrelated sibling window must never be read')
    for (const observation of observations) {
      assert.ok(['complete', 'partial'].includes(observation.status), JSON.stringify(observation))
      assert.equal(observation.readOnly, true)
      assert.ok(!observation.processes.some((entry) => entry.pid === control.pid))
      assert.ok(!observation.windows.some((entry) => entry.ProcessId === control.pid))
      assert.ok(observation.dialogAutomation.length > 0)
      for (const dialog of observation.dialogAutomation) {
        const native = observation.windows.find((window) => window.Handle === dialog.handle)
        assert.equal(dialog.visible, native.Visible)
        if (!dialog.textAvailable) {
          assert.equal(dialog.status, 'text-unavailable')
          assert.ok(dialog.reason.length > 0)
        } else if (mode === 'modal') assert.equal(dialog.status, 'complete')
      }
    }
    assert.doesNotThrow(() => process.kill(control.pid, 0))
    const unavailable = observations
      .flatMap((item) => item.dialogAutomation)
      .filter((item) => !item.textAvailable).length
    console.log(
      `PASS ${mode} modal kept timeout/failed; body-unavailable snapshots: ${unavailable}`
    )
  }
  console.log(`PASS native diagnostic boundaries; evidence: ${directory}`)
}

main()
  .catch((error) => {
    failure = error
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    const cleanup = await stopControl()
    if (cleanup.status !== 'complete') process.exitCode = 1
    const result = recorder.finish({
      completed: !failure && cleanup.status === 'complete',
      cleanup,
      evidence: { status: failure ? 'failed' : 'complete', directory },
      ...(failure ? { error: failure } : {})
    })
    if (directory)
      writeFileSync(join(directory, 'native-result.json'), JSON.stringify(result, null, 2), {
        flag: 'wx'
      })
  })
