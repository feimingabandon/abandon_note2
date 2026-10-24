import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { app, BrowserWindow } from 'electron'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import {
  createNativeProbe,
  measureProbeCall,
  probeClock
} from './fixtures/native-async-prototype/worker.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/native-async-prototype-electron.mjs',
  mode: 'electron-worker-native-lifecycle-prototype',
  prefix: 'abandon-native-async-prototype-',
  // The focused runner's 180s deadline must diagnose a stuck FFI first; this
  // fallback must not destroy its HWND or quit before owned worker cleanup.
  timeoutMs: 200000,
  metadata: {
    scope: 'Isolated Init/Destroy worker prototype; unchanged synchronous ABI',
    fullApplicationBootstrap: false,
    nativeAbi: NATIVE_ABI_VERSION,
    ffiCancellation: 'not supported; delivery gate follows actual FFI return',
    sleepControl: 'kernel32.Sleep(120), separate from natural Init/Destroy timings',
    limitations: [
      'single machine',
      'few cycles',
      'no production integration or customer attribution'
    ]
  }
})
const { assert } = lifecycle
app.setPath('userData', lifecycle.root)
const evidence = process.env.ABANDON_TEST_EVIDENCE_DIR || lifecycle.root
const eventsFile = join(evidence, 'native-async-events.jsonl')
writeFileSync(eventsFile, '', { flag: 'wx' })
const record = (event, details = {}) =>
  appendFileSync(eventsFile, JSON.stringify({ at: probeClock(), event, ...details }) + '\n')
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
const summary = {
  actualCalls: [],
  controls: [],
  terminalObservations: [],
  publications: [],
  retiredCandidates: [],
  resourceSamples: [],
  limitations: [
    'Cancellation happens after real Init returns and before result delivery',
    'Sleep measures controlled FFI isolation, not a natural Init/Destroy stall',
    'Short operations may have no heartbeat inside their measured interval',
    'No production protocol, input/focus behavior, timeout/detach or long-run claim'
  ]
}
let probe
let parent
let worker
let workerExit
let workerExited = false
let workerExitCode
let workerFatal
let workerStopped
let cleanupPromise
let cleanupResult
let ending = false
let requestId = 0
let generation = 0
const requests = new Map()
const retainedSta = new Set()
const beats = []
let lastBeat = probeClock()
const heartbeat = setInterval(() => {
  const at = probeClock()
  if (beats.length < 4096) beats.push({ at, gapMs: at - lastBeat })
  lastBeat = at
}, 5)

function observeHeartbeat(call) {
  const inside = beats.filter((beat) => beat.at >= call.startedAt && beat.at <= call.returnedAt)
  const crossing = beats.filter(
    (beat) => beat.at >= call.startedAt && beat.at - beat.gapMs <= call.returnedAt
  )
  return {
    ticksDuringFfi: inside.length,
    maximumIntersectingGapMs: Math.max(0, ...crossing.map((beat) => beat.gapMs)),
    samples: crossing
  }
}

function retainSta(overlays, label) {
  assert.equal(overlays.length, 1, 'Init must create exactly one owned overlay')
  const overlay = overlays[0]
  assert.equal(overlay.pid, process.pid)
  assert.notEqual(overlay.tid, probe.currentThread(), 'Overlay must belong to a separate STA')
  const handle = probe.openSta(overlay.tid)
  assert.notEqual(handle, 0n, 'Retain the exact STA before Destroy; thread IDs may be reused')
  const observation = { handle, label, overlay }
  retainedSta.add(observation)
  return observation
}

function terminal(observation, window = parent, mayBeClosed = false) {
  const result = {
    label: observation.label,
    overlay: observation.overlay,
    staExited: probe.staExited(observation.handle),
    remainingOverlays: probe.overlays(),
    state: probe.state(),
    parentDestroyed: window.isDestroyed(),
    parentIntact: mayBeClosed || (!window.isDestroyed() && probe.isWindow(hwnd(window)))
  }
  summary.terminalObservations.push(result)
  record('native-terminal', result)
  assert.equal(result.staExited, true, 'Destroy must confirm exact real STA exit')
  assert.equal(result.remainingOverlays.length, 0, 'Destroy must release the owned overlay')
  assert.deepEqual(result.state, { initialized: false, healthy: false })
  assert.equal(result.parentIntact, true)
  assert.equal(probe.closeHandle(observation.handle), true, 'Close owned STA observation HANDLE')
  retainedSta.delete(observation)
}

const hwnd = (window) => window.getNativeWindowHandle().readBigUInt64LE(0)
const makeParent = () =>
  new BrowserWindow({
    show: false,
    width: 320,
    height: 220,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false }
  })

function request(operation, details = {}, onHeld) {
  if (workerFatal || workerExited) return Promise.reject(workerFatal || new Error('Worker exited'))
  if (ending && operation !== 'stop') return Promise.reject(new Error('Prototype is closing'))
  const id = ++requestId
  return new Promise((resolveRequest, reject) => {
    requests.set(id, { resolve: resolveRequest, reject, onHeld, details })
    worker.postMessage({ type: 'run', id, operation, ...details })
  })
}

function startWorker(dllPath) {
  let resolveReady
  let rejectReady
  const ready = new Promise((resolveWait, reject) => {
    resolveReady = resolveWait
    rejectReady = reject
  })
  worker = new Worker(new URL('./fixtures/native-async-prototype/worker.mjs', import.meta.url), {
    workerData: { dllPath, expectedAbi: NATIVE_ABI_VERSION }
  })
  workerExit = new Promise((resolveExit) =>
    worker.once('exit', (code) => {
      workerExited = true
      workerExitCode = code
      record('worker-exit', { code })
      for (const pending of requests.values()) pending.reject(new Error(`Worker exited ${code}`))
      requests.clear()
      rejectReady(new Error(`Worker exited ${code} before ready`))
      resolveExit(code)
    })
  )
  worker.on('error', (error) => {
    workerFatal = error
    record('worker-error', { error: error.stack || error.message })
    rejectReady(error)
    for (const pending of requests.values()) pending.reject(error)
    requests.clear()
  })
  worker.on('message', (message) => {
    record('worker-message', { message })
    if (message.type === 'ready') resolveReady(message)
    else if (message.type === 'fatal') {
      workerFatal = new Error(message.error)
      rejectReady(workerFatal)
    } else if (message.type === 'stopped') workerStopped = message
    else if (message.type === 'held') {
      const pending = requests.get(message.id)
      try {
        if (!pending?.onHeld) throw new Error('Unexpected held prototype candidate')
        pending.onHeld(message)
      } catch (error) {
        if (pending) pending.gateError = error
      } finally {
        // A failed parent assertion still releases the gate toward real Destroy.
        worker.postMessage({ type: 'release', id: message.id, cancelled: true })
      }
    } else if (message.type === 'result') {
      const pending = requests.get(message.id)
      if (!pending) return
      requests.delete(message.id)
      if (pending.gateError || message.error)
        pending.reject(pending.gateError || new Error(message.error))
      else pending.resolve(message.result)
    }
  })
  return ready
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise
  ending = true
  cleanupPromise = (async () => {
    const errors = []
    try {
      if (worker && !workerExited && !workerFatal) {
        for (const [id, pending] of requests)
          if (pending.details.holdResult)
            worker.postMessage({ type: 'release', id, cancelled: true })
        await request('stop')
      }
      if (workerExit) await workerExit
      // No concurrent singleton access: fallback/final repeat Destroy follows the
      // worker's actual exit, never a timeout, cancellation flag or terminate().
      if (probe) {
        probe.native.destroy()
        for (const observation of retainedSta) {
          if (!probe.staExited(observation.handle))
            errors.push(`${observation.label}: STA not exited`)
          if (!probe.closeHandle(observation.handle))
            errors.push('STA observation CloseHandle failed')
        }
        retainedSta.clear()
        if (probe.overlays().length) errors.push('Owned overlay remains')
        if (probe.state().initialized || probe.state().healthy)
          errors.push('Engine remains published')
      }
    } catch (error) {
      errors.push(error.stack || error.message)
    }
    // Retain the separate parent/observer for the GUI helper's final screenshot.
    // The helper owns its ordinary window destruction and normal app.quit().
    clearInterval(heartbeat)
    cleanupResult = { confirmed: errors.length === 0, errors, workerExited, workerExitCode }
    record('cleanup-result', cleanupResult)
    return cleanupResult
  })()
  return cleanupPromise
}

async function normalWorkerCycle(label) {
  const captured = ++generation
  const initialized = await request('init', { hwnd: hwnd(parent), generation: captured })
  assert.equal(initialized.candidate.call.value, 1)
  assert.equal(initialized.candidate.healthy, true)
  assert.notEqual(initialized.candidate.overlays[0]?.tid, initialized.candidate.call.callerOsThread)
  assert.equal(captured, generation)
  assert.equal(parent.isDestroyed(), false)
  summary.publications.push({ label, generation: captured })
  const sta = retainSta(initialized.candidate.overlays, label)
  const destroyed = await request('destroy')
  await wait(10)
  for (const call of [initialized.candidate.call, destroyed.call])
    summary.actualCalls.push({ label, mode: 'worker', ...call, heartbeat: observeHeartbeat(call) })
  terminal(sta)
  summary.resourceSamples.push({ label, ...probe.resources() })
}

async function lateCandidate(label, closeTarget) {
  const target = closeTarget ? makeParent() : parent
  const captured = ++generation
  const before = summary.publications.length
  let sta
  let cancelledAt
  const retired = await request(
    'init',
    { hwnd: hwnd(target), generation: captured, holdResult: true },
    (held) => {
      assert.equal(held.generation, captured)
      assert.equal(held.candidate.call.value, 1)
      assert.notEqual(held.candidate.overlays[0]?.tid, held.candidate.call.callerOsThread)
      sta = retainSta(held.candidate.overlays, label)
      cancelledAt = probeClock()
      generation++
      if (closeTarget) {
        target.destroy()
        assert.equal(target.isDestroyed(), true)
      }
      record('candidate-invalidated', {
        label,
        captured,
        generation,
        cancelledAt,
        targetDestroyed: target.isDestroyed(),
        nativeReturnedAt: held.candidate.call.returnedAt,
        phase: 'after-native-return-before-result-delivery'
      })
    }
  )
  // This is the parent's only publication point; a retired generation cannot
  // expose a late initialized resource even if its real Init had succeeded.
  if (captured === generation && !target.isDestroyed() && !retired.retired)
    summary.publications.push({ label, generation: captured })
  assert.equal(retired.retired, true)
  assert.equal(retired.cancellationPhase, 'after-native-return-before-result-delivery')
  assert.ok(cancelledAt >= retired.candidate.call.returnedAt)
  assert.equal(summary.publications.length, before)
  assert.deepEqual(retired.terminal, { initialized: false, healthy: false, overlays: [] })
  terminal(sta, target, closeTarget)
  await wait(10)
  for (const call of [retired.candidate.call, retired.cleanup])
    summary.actualCalls.push({ label, mode: 'worker', ...call, heartbeat: observeHeartbeat(call) })
  summary.retiredCandidates.push({ label, captured, cancelledAt, result: retired })
  summary.resourceSamples.push({ label, ...probe.resources() })
}

async function run() {
  let failure
  try {
    assert.equal(process.platform, 'win32')
    assert.equal(process.arch, 'x64')
    const dllPath = resolve('native_blur/build/bin/blur_engine.dll')
    summary.dll = {
      path: dllPath,
      sha256: createHash('sha256').update(readFileSync(dllPath)).digest('hex'),
      expectedAbi: NATIVE_ABI_VERSION
    }
    probe = createNativeProbe(dllPath, NATIVE_ABI_VERSION)
    summary.mainOsThread = probe.currentThread()
    parent = makeParent()
    const parentReady = new Promise((resolveReady) => parent.once('ready-to-show', resolveReady))
    await parent.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent('<title>Native async prototype</title><body>Owned E9.2 observer</body>')
    )
    await parentReady
    assert.equal(probe.isWindow(hwnd(parent)), true)
    assert.deepEqual(probe.overlays(), [])
    summary.resourceSamples.push({ label: 'before-sync', ...probe.resources() })
    await wait(25)
    for (let round = 0; round < 2; round++) {
      const label = `sync-${round}`
      record('sync-init-enter', { label })
      const initialized = measureProbeCall(probe, 'Blur_Init', () =>
        probe.native.initialize(hwnd(parent))
      )
      record('sync-init-return', { label, call: initialized })
      assert.equal(initialized.value, 1)
      assert.deepEqual(probe.state(), { initialized: true, healthy: true })
      const sta = retainSta(probe.overlays(), label)
      record('sync-destroy-enter', { label })
      const destroyed = measureProbeCall(probe, 'Blur_Destroy', () => probe.native.destroy())
      record('sync-destroy-return', { label, call: destroyed })
      terminal(sta)
      await wait(10)
      for (const call of [initialized, destroyed])
        summary.actualCalls.push({
          label,
          mode: 'main',
          ...call,
          heartbeat: observeHeartbeat(call)
        })
      summary.resourceSamples.push({ label, ...probe.resources() })
    }
    const syncControl = measureProbeCall(probe, 'kernel32.Sleep(120)', () => probe.sleep(120))
    await wait(10)
    const syncBeats = observeHeartbeat(syncControl)
    assert.equal(syncBeats.ticksDuringFfi, 0)
    assert.ok(syncControl.durationMs >= 100)
    summary.controls.push({ mode: 'main', ...syncControl, heartbeat: syncBeats })
    const ready = await startWorker(dllPath)
    assert.equal(ready.abi, NATIVE_ABI_VERSION)
    assert.notEqual(ready.callerOsThread, summary.mainOsThread)
    assert.notEqual(ready.nodeThreadId, 0)
    summary.workerReady = ready
    // Exactly two outstanding fixed commands exercise the same serial owner;
    // invalid Init must not prevent the following successful real cycle.
    const [workerControl, invalid] = await Promise.all([
      request('sleep-control'),
      request('invalid-init')
    ])
    await wait(10)
    const workerBeats = observeHeartbeat(workerControl.call)
    assert.ok(workerControl.call.durationMs >= 100)
    assert.ok(workerBeats.ticksDuringFfi >= 3, 'Main heartbeat must progress during controlled FFI')
    assert.equal(workerControl.maximumActive, 1)
    assert.equal(invalid.maximumActive, 1)
    assert.ok(invalid.enteredAt >= workerControl.returnedAt)
    assert.equal(invalid.call.value, 0)
    assert.equal(invalid.error.code, 2)
    assert.deepEqual(invalid.terminal, { initialized: false, healthy: false, overlays: [] })
    summary.controls.push({ mode: 'worker', ...workerControl.call, heartbeat: workerBeats })
    summary.invalidInit = invalid
    for (let round = 0; round < 2; round++) await normalWorkerCycle(`worker-${round}`)
    await lateCandidate('cancel-delivery', false)
    await lateCandidate('close-delivery', true)
    await normalWorkerCycle('after-retirement')
  } catch (error) {
    failure = error
    record('business-failure', { error: error.stack || error.message })
    console.error(error)
  } finally {
    const cleaned = await cleanup()
    try {
      assert.equal(cleaned.confirmed, true, 'Native cleanup must be independently confirmed')
      if (worker) {
        assert.equal(workerExitCode, 0, 'Worker must exit naturally with code 0')
        assert.equal(workerStopped?.maximumActive, 1)
        assert.deepEqual(workerStopped?.terminal, {
          initialized: false,
          healthy: false,
          overlays: []
        })
        for (let index = 1; index < workerStopped.entries.length; index++)
          assert.ok(
            workerStopped.entries[index].enteredAt >= workerStopped.entries[index - 1].returnedAt,
            'All worker operations, including held Init cleanup, must remain serial'
          )
      }
    } catch (error) {
      failure ||= error
      console.error(error)
    }
    summary.nativeCleanup = cleaned
    summary.workerStopped = workerStopped
    summary.heartbeatSampleCount = beats.length
    if (cleaned.confirmed && probe)
      summary.resourceSamples.push({ label: 'after-worker-exit', ...probe.resources() })
    // The observer is separate from the destroyed close-case target. Its hidden
    // document reached ready-to-show before native work; show it without focus
    // only after native/worker drain so the existing helper can capture it.
    if (parent && !parent.isDestroyed()) parent.showInactive()
    await lifecycle.finish({
      completed: !failure,
      error: failure,
      window: parent,
      summary,
      restore: () => {
        if (!cleaned.confirmed) throw new Error('Owned native/worker cleanup is unconfirmed')
      }
    })
  }
}
app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error)
    void lifecycle.finish({ error, restore: cleanup })
  })
