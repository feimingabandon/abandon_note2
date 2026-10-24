import { promises as fs, appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { app, BrowserWindow } from 'electron'
import { CaptureHost } from '../src/main/capture/CaptureHost.js'
import { coverCaptureTestDesktop } from './helpers/capture-test-desktop.mjs'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const suite = 'tests/capture-lifecycle-electron.mjs'
const mode = 'electron-ready-capture-overlay-lifecycle'
const prefix = 'abandon-capture-e2e-'
const metadata = {
  actualApplication: false,
  realCaptureHost: true,
  realOverlay: true,
  ownedDesktopCover: true,
  physicalInput: false,
  clipboard: false,
  ownedAbruptFixture: true
}
const evidenceScope =
  'Recorded real native overlay captureReady/cancel and helper/owner lifecycle; no physical mouse selection, pixel-retirement or full-product shutdown proof'
let uncover = null,
  pendingCover = null,
  creatingCover = false
const ownedCoverWindows = new Set()
const trackCoverWindow = (_event, window) => {
  if (!creatingCover) return
  ownedCoverWindows.add(window)
  report.desktopCover.windowIds.push(window.id)
  if (closing && !window.isDestroyed()) window.destroy()
}
async function startDesktopCover() {
  report.desktopCover = { state: 'pending', windowIds: [] }
  creatingCover = true
  app.on('browser-window-created', trackCoverWindow)
  pendingCover = coverCaptureTestDesktop()
    .then((release) => {
      if (closing) {
        release()
        report.desktopCover.state = 'late-release-cleaned'
      } else {
        uncover = release
        report.desktopCover.state = 'ready'
      }
    })
    .catch((error) => {
      report.desktopCover.state = 'failed'
      report.desktopCover.error = error.stack || error.message
      throw error
    })
    .finally(() => {
      creatingCover = false
    })
  await pendingCover
}
async function restoreDesktop() {
  uncover?.()
  uncover = null
  for (const window of ownedCoverWindows) if (!window.isDestroyed()) window.destroy()
  // Destroying an in-flight fixture window ends loadURL. The original failure
  // stays in desktopCover; cancellation must also consume the late release.
  if (pendingCover)
    await pendingCover.catch((error) => {
      report.desktopCover.cleanupObservedError = error.stack || error.message
    })
  uncover?.()
  uncover = null
  app.removeListener('browser-window-created', trackCoverWindow)
}

const profile = prepareTestProfile({ prefix })
app.setPath('userData', profile.directory)
const evidenceDirectory = resolve(process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory)
const root = join(profile.directory, 'capture-owned')
const ownerRoot = join(profile.directory, 'abrupt-owner')
const directory = resolve(process.env.ABANDON_CAPTURE_TEST_DIRECTORY || 'native_capture/deploy')
await Promise.all([fs.mkdir(root, { recursive: true }), fs.mkdir(ownerRoot, { recursive: true })])
const recorder = createAssertionRecorder({ suite, mode, metadata })
const { assert } = recorder
const host = new CaptureHost({ directory, root })
const report = {
  suite,
  mode,
  root,
  directory,
  profile: profile.directory,
  messages: [],
  failures: [],
  pids: [],
  owner: null
}
const cleanupErrors = []
const eventFile = join(evidenceDirectory, 'capture-exit-events.jsonl')
const ownerStdout = join(evidenceDirectory, 'capture-owner-stdout.log')
const ownerStderr = join(evidenceDirectory, 'capture-owner-stderr.log')
for (const file of [eventFile, ownerStdout, ownerStderr]) writeFileSync(file, '', { flag: 'wx' })
let sequence = 0,
  closing = false,
  completed = false,
  failure = null,
  owner = null
let reachedWillQuit = false,
  ownedCleanupComplete = false,
  allowQuit = false,
  cleanupTimeout
let evidence = { status: 'incomplete' },
  evidenceWritten = false
function record(event, details = {}) {
  appendFileSync(
    eventFile,
    JSON.stringify({
      sequence: ++sequence,
      at: new Date().toISOString(),
      pid: process.pid,
      event,
      ...details
    }) + '\n'
  )
}
function checkRunning() {
  if (closing) throw new Error('Capture suite is finishing')
}
function phase(name) {
  report.phase = name
  record('phase', { name })
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, label, cleanup = false) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (!cleanup) checkRunning()
    if (await check()) return
    await wait(25)
  }
  throw new Error(label)
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function rememberPid(pid) {
  assert.ok(
    Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid,
    'Helper PID must identify a test-created process'
  )
  if (!report.pids.includes(pid)) report.pids.push(pid)
  return pid
}
host.on('message', (message) => report.messages.push(message))
host.on('failure', (error) => report.failures.push(error.message))
async function launchOwner() {
  phase('abrupt-owner-start')
  const child = spawn(process.execPath, ['tests/helpers/capture-owner.cjs', ownerRoot, directory], {
    cwd: resolve('.'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  owner = {
    child,
    output: '',
    error: null,
    state: {
      pid: child.pid,
      exit: null,
      close: null,
      terminationRequested: false,
      stdoutBytes: 0,
      stderrBytes: 0
    }
  }
  const owned = owner
  report.owner = owned.state
  child.on('error', (error) => {
    owned.error = error
    owned.state.error = error.stack || error.message
  })
  child.on('exit', (code, signal) => {
    owned.state.exit = { code, signal }
    record('owner-exit', owned.state.exit)
  })
  child.on('close', (code, signal) => {
    owned.state.close = { code, signal }
    record('owner-close', owned.state.close)
  })
  child.stdout.on('data', (chunk) => {
    owned.output += chunk.toString()
    owned.state.stdoutBytes += chunk.length
    appendFileSync(ownerStdout, chunk)
  })
  child.stderr.on('data', (chunk) => {
    owned.state.stderrBytes += chunk.length
    appendFileSync(ownerStderr, chunk)
    process.stderr.write(chunk)
  })
  await until(() => {
    if (owned.error) throw owned.error
    if (owned.output.includes('\n')) return true
    if (owned.state.exit || owned.state.close)
      throw new Error('Owner exited before reporting its helper')
    return false
  }, 'Owner fixture did not report its helper')
  const identity = JSON.parse(owned.output.slice(0, owned.output.indexOf('\n')))
  assert.equal(identity.ownerPid, child.pid, 'Owner report must belong to the spawned fixture')
  assert.equal(identity.parentPid, process.pid, 'Owner fixture must belong to this test')
  assert.equal(resolve(identity.root).toLowerCase(), (await fs.realpath(ownerRoot)).toLowerCase())
  assert.equal(
    resolve(identity.directory).toLowerCase(),
    (await fs.realpath(directory)).toLowerCase()
  )
  owned.state.identity = identity
  return rememberPid(identity.enginePid)
}
async function stopOwner(cleanup = false) {
  if (!owner) return
  const owned = owner
  if (!owned.state.exit && !owned.error) {
    owned.state.terminationRequested = true
    if (!owned.child.kill()) throw new Error('Test-owned fixture could not be terminated')
  }
  await until(() => Boolean(owned.state.close), 'Owner stdout/stderr pipes did not close', cleanup)
  if (owned.error) throw owned.error
  if (!owned.state.exit) throw new Error('Owner close was observed without process exit')
  if (owned.state.identity)
    await until(
      () => !alive(owned.state.identity.enginePid),
      'Helper survived abrupt fixture-owner exit',
      cleanup
    )
}
async function cleanupOwned() {
  // start() may reject after native launch but before its successful await can
  // call rememberPid. This host belongs only to this suite; record that launch
  // before dispose closes its Job. A failed start ends this suite immediately.
  const launchedPid = host.pid
  if (Number.isSafeInteger(launchedPid) && launchedPid > 0 && launchedPid !== process.pid) {
    if (!report.pids.includes(launchedPid)) report.pids.push(launchedPid)
    record('cleanup-observed-helper', { pid: launchedPid })
  }
  const results = await Promise.allSettled([host.dispose(), stopOwner(true)])
  for (const result of results)
    if (result.status === 'rejected')
      cleanupErrors.push(result.reason?.stack || String(result.reason))
  try {
    await until(
      () => report.pids.every((pid) => !alive(pid)),
      'A test-created helper survived cleanup',
      true
    )
  } catch (error) {
    cleanupErrors.push(error.stack || error.message)
  }
  try {
    await restoreDesktop()
  } catch (error) {
    cleanupErrors.push(error.stack || error.message)
  }
  const windowsClosed = BrowserWindow.getAllWindows().every((window) => window.isDestroyed())
  const hostReleased = !host.ready && !host.socket && !host.job && !host.starting
  const ownerClosed = !owner || Boolean(owner.state.exit && owner.state.close)
  const ownerHelperConfirmed =
    !owner || Boolean(owner.state.identity && !alive(owner.state.identity.enginePid))
  report.cleanup = {
    hostReleased,
    ownerClosed,
    ownerHelperConfirmed,
    windowsClosed,
    liveHelpers: report.pids.filter(alive),
    errors: cleanupErrors
  }
  ownedCleanupComplete =
    hostReleased &&
    ownerClosed &&
    ownerHelperConfirmed &&
    windowsClosed &&
    report.cleanup.liveHelpers.length === 0 &&
    cleanupErrors.length === 0
}
function writeEvidence() {
  if (evidenceWritten) return
  evidenceWritten = true
  try {
    writeFileSync(
      join(evidenceDirectory, 'capture-evidence.json'),
      JSON.stringify(
        { ...report, completed, error: failure?.stack || failure?.message || null },
        null,
        2
      ),
      { flag: 'wx' }
    )
    evidence = {
      status: 'complete',
      artifacts: [
        'capture-evidence.json',
        'capture-exit-events.jsonl',
        'capture-owner-stdout.log',
        'capture-owner-stderr.log'
      ],
      scope: evidenceScope
    }
  } catch (error) {
    evidence = { status: 'failed', error: error.stack || error.message }
    process.exitCode = 1
  }
}
async function finish(error = null, businessCompleted = false) {
  if (closing) return
  closing = true
  completed = businessCompleted && !error
  failure = error
  clearTimeout(suiteTimeout)
  process.exitCode = error ? 1 : 0
  record('finish-start', { completed, error: error?.message || null })
  cleanupTimeout = setTimeout(() => {
    completed = false
    failure ||= new Error('Owned capture cleanup timed out')
    cleanupErrors.push(failure.message)
    record('cleanup-watchdog-fired')
    writeEvidence()
    app.exit(1)
  }, 12000)
  await cleanupOwned()
  if (!ownedCleanupComplete) process.exitCode = 1
  writeEvidence()
  allowQuit = true
  record('app-quit-before', { ownedCleanupComplete })
  app.quit()
  record('app-quit-after')
}
const suiteTimeout = setTimeout(() => void finish(new Error(suite + ' timed out')), 90000)
app.on('window-all-closed', () => {})
app.on('before-quit', (event) => {
  if (allowQuit) return
  event.preventDefault()
  if (!closing) void finish(new Error('Unexpected application quit before suite finalization'))
})
app.on('will-quit', () => {
  reachedWillQuit = true
  record('will-quit')
})
app.on('quit', (_event, code) => {
  clearTimeout(suiteTimeout)
  clearTimeout(cleanupTimeout)
  record('quit', { code, reachedWillQuit, ownedCleanupComplete })
  try {
    recorder.finish({
      completed,
      error: failure,
      evidence,
      profileOwnership: profile.ownership,
      cleanup: {
        status:
          reachedWillQuit && ownedCleanupComplete
            ? profile.ownership === 'runner'
              ? 'complete'
              : 'preserved'
            : 'failed',
        reachedWillQuit,
        ownedCleanupComplete,
        exitCode: code,
        errors: cleanupErrors,
        preservedProfile: profile.ownership === 'script' || failure ? profile.directory : undefined,
        scope:
          'Only this test-created Host, abrupt-owner child, helper Jobs and fixture windows; runner owns profile deletion after normal exit'
      }
    })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
})

async function run() {
  try {
    phase('desktop-cover')
    await startDesktopCover()
    checkRunning()
    phase('prewarm')
    const firstStart = host.start(),
      secondStart = host.start(),
      thirdStart = host.start()
    assert.strictEqual(secondStart, firstStart)
    assert.strictEqual(thirdStart, firstStart)
    await Promise.all([firstStart, secondStart, thirdStart])
    checkRunning()
    const firstPid = rememberPid(host.pid)
    assert.equal(host.ready, true)
    assert.equal(alive(firstPid), true)
    const sessionId = '11111111-1111-1111-1111-111111111111'
    await fs.mkdir(join(root, sessionId))
    checkRunning()
    phase('desktop-capture')
    host.send({ type: 'capture', origin: 'global', sessionId })
    await until(
      () =>
        report.messages.some(
          (message) => message.type === 'captureReady' && message.sessionId === sessionId
        ),
      'Real desktop overlay never became ready'
    )
    assert.equal(
      report.messages.filter(
        (message) => message.type === 'captureReady' && message.sessionId === sessionId
      ).length,
      1
    )
    host.send({ type: 'capture', origin: 'global', sessionId })
    host.send({ type: 'cancel', sessionId })
    await until(
      () =>
        report.messages.some(
          (message) => message.type === 'finished' && message.sessionId === sessionId
        ),
      'Capture did not cancel'
    )
    assert.equal(report.messages.filter((message) => message.type === 'finished').length, 1)
    assert.equal(report.messages.find((message) => message.type === 'finished').status, 'cancelled')
    // The current test-owned Job must still identify this exact helper before fault injection.
    assert.ok(host.job)
    assert.equal(host.native.pid(host.job), firstPid)
    assert.equal(host.native.running(host.job), 1)
    phase('owned-helper-crash')
    process.kill(firstPid)
    await until(() => report.failures.length === 1, 'Engine exit was not observed')
    assert.equal(host.ready, false)
    await host.start()
    checkRunning()
    const secondPid = rememberPid(host.pid)
    assert.notEqual(secondPid, firstPid)
    assert.equal(host.ready, true)
    phase('ipc-disconnect')
    host.socket.destroy()
    await until(() => !alive(secondPid) && !host.ready && !host.job, 'Engine survived IPC loss')
    assert.equal(report.failures.length, 2)

    const ownedPid = await launchOwner()
    assert.equal(alive(ownedPid), true)
    await stopOwner()
    assert.ok(owner.state.terminationRequested)
    assert.ok(owner.state.exit, 'Abrupt owner process exit must be observed')
    assert.ok(owner.state.close, 'Abrupt owner pipes must close')
    assert.equal(alive(ownedPid), false)
    await host.start()
    checkRunning()
    const finalPid = rememberPid(host.pid)
    phase('explicit-dispose')
    await host.dispose()
    await until(() => !alive(finalPid), 'Owned engine survived explicit shutdown')
    assert.equal(host.ready, false)
    assert.equal(host.job, null)
    assert.equal(report.failures.length, 2, 'Normal disposal must not emit a crash failure')
    await finish(null, true)
  } catch (error) {
    console.error(error)
    await finish(error)
  }
}
app
  .whenReady()
  .then(run)
  .catch((error) => void finish(error))
