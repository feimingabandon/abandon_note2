import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { createPackage } from '@electron/asar'
import {
  getImageDimensions,
  getImageThumbnail,
  getImageThumbnailDetails,
  getImageBase64,
  invalidateImageDecodes,
  suspendImageDecodes,
  resumeImageDecodes,
  disposeImageDecodes
} from '../src/main/db/db-images.js'
import {
  resolveImageDecoderGate,
  startImageDecodeChild
} from '../src/main/images/image-decode-child.js'
import { createImageDecodeRuntime } from '../src/main/images/image-decode-runtime.js'
import { createImageDecodeProcessJob } from '../src/main/images/image-decode-process-job.js'
import { registerBusinessIpcHandlers } from '../src/main/ipc/register-business-ipc.js'
import { diagnosticState } from '../src/main/logging/diagnostic-state.js'
import { drainOperationPerformance } from '../src/main/logging/operation-performance.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/image-decode-electron.mjs',
  mode: 'real-electron-owned-image-decode',
  prefix: 'abandon-image-decode-',
  timeoutMs: 120_000,
  metadata: {
    browserWindow: true,
    actualPreload: true,
    thumbnailDetailsTransport: 'production-business-registrar',
    buildAppRequired: true,
    realFiles: true,
    realDecoderChildren: true,
    privateWindowsJob: true,
    nodeModeLaunchGate: true,
    controlledFailureEntry: true,
    builtBootstrap: true,
    ownedAsarBootstrap: true,
    actualPackagedExecutable: false
  }
})
const { assert } = lifecycle
const profileA = lifecycle.root
const evidenceRoot = process.env.ABANDON_TEST_EVIDENCE_DIR || profileA
const fixtureRoot = fileURLToPath(new URL('./fixtures/image-decode/', import.meta.url))
const controlledEntry = join(fixtureRoot, 'controlled-child.mjs')
const sourceGate = fileURLToPath(
  new URL('../src/main/images/image-decode-gate.cjs', import.meta.url)
)
const observations = []
const liveOperations = new Set()
const runtimes = new Set()
const transportChannels = []
const injectedProfiles = new Map()
let fixtureSequence = 0
let heartbeat = 0
let maximumHeartbeatGapMs = 0
let lastHeartbeat = performance.now()
const heartbeatTimer = setInterval(() => {
  const now = performance.now()
  heartbeat++
  maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, now - lastHeartbeat)
  lastHeartbeat = now
}, 20)
app.setPath('userData', profileA)
app.setPath('sessionData', profileA)
app.disableHardwareAcceleration()
// The hidden transport fixture must not end the remaining decoder ownership tests.
app.on('window-all-closed', () => {})

const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
// Electron patches node:fs ASAR paths as virtual directories; hash the archive's physical bytes.
const originalFs = createRequire(import.meta.url)('original-fs')
const physicalDigest = (file) =>
  createHash('sha256').update(originalFs.readFileSync(file)).digest('hex')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
function bounded(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), ms)
    })
  ]).finally(() => clearTimeout(timer))
}
async function until(test, label, timeoutMs = 4000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const result = test()
    if (result) return result
    await pause(10)
  }
  throw new Error(label + ' timed out')
}
function markerEvents(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
function markerPhase(file, phase) {
  return markerEvents(file).find((event) => event.phase === phase)
}
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
function controlledPayload(mode, token = mode) {
  const marker = join(evidenceRoot, `image-child-${++fixtureSequence}-${mode}.jsonl`)
  return { mode, token, marker, release: marker + '.release' }
}
function ownChild(payload, entry = controlledEntry, childOptions = {}) {
  const events = []
  const gateEntry = childOptions.gateEntry || sourceGate
  const outputFiles = Object.fromEntries(
    ['stdout', 'stderr'].map((name) => {
      const file = join(evidenceRoot, `decoder-${observations.length}-${name}.log`)
      writeFileSync(file, '', { flag: 'wx' })
      return [name, file]
    })
  )
  const operation = startImageDecodeChild(payload, {
    app,
    entry,
    ...childOptions,
    gateEntry,
    onOutput: ({ stream, bytes }) => appendFileSync(outputFiles[stream], bytes),
    onDiagnostic: (details) => {
      events.push({
        at: performance.now(),
        ...details,
        ...(details.error
          ? {
              error: {
                message: details.error.message,
                code: details.error.code,
                activeProcesses: details.error.activeProcesses,
                timeoutMs: details.error.timeoutMs,
                rootPid: details.error.rootPid
              }
            }
          : {})
      })
    }
  })
  const state = {
    payload,
    entry: entry || 'product default entry',
    gateEntry,
    operation,
    events,
    outputFiles,
    outcome: null,
    closed: null
  }
  liveOperations.add(state)
  state.outcomePromise = operation.result.then(
    (value) => (state.outcome = { ok: true, value }),
    (error) => (state.outcome = { ok: false, error: { code: error.code, message: error.message } })
  )
  state.closePromise = operation.closed.then((closed) => {
    state.closed = closed
    liveOperations.delete(state)
    return closed
  })
  void state.closePromise.catch(() => {})
  observations.push(state)
  return state
}
function runtime(options = {}) {
  const starts = []
  const diagnostics = []
  const owner = createImageDecodeRuntime({
    activeTimeoutMs: 5000,
    totalTimeoutMs: 20_000,
    start: (payload) => {
      const state = ownChild(payload)
      starts.push(state)
      return state.operation
    },
    onDiagnostic: (event) => diagnostics.push({ ...event, at: performance.now() }),
    ...options
  })
  runtimes.add(owner)
  return { owner, starts, diagnostics }
}
function assertProcessTreeClosed(state, recoveredJobError = null) {
  const started = state.events.filter((event) => event.code === 'IMAGE_DECODER_STARTED')
  const contained = state.events.filter((event) => event.code === 'IMAGE_DECODER_CONTAINED')
  const closed = state.events.filter((event) => event.code === 'IMAGE_DECODER_CLOSED')
  const empty = state.events.filter((event) => event.code === 'IMAGE_DECODER_JOB_EMPTY')
  const cleanupFailures = state.events.filter(
    (event) => event.code === 'IMAGE_DECODER_JOB_CLEANUP_FAILED'
  )
  assert.equal(started.length, 1)
  assert.equal(contained.length, 1, "The decoder must be verified inside its owner's private Job")
  assert.equal(closed.length, 1)
  assert.equal(empty.length, 1, 'Closed capacity requires an empty Job and closed Job handle')
  assert.ok(Number.isInteger(started[0].pid) && started[0].pid > 0)
  assert.equal(contained[0].pid, started[0].pid)
  assert.ok(Number.isInteger(contained[0].decoderPid) && contained[0].decoderPid > 0)
  assert.notEqual(
    contained[0].decoderPid,
    started[0].pid,
    'Node gate and Electron decoder are distinct processes'
  )
  assert.ok(contained[0].activeProcesses >= 2, 'Gate and decoder are both live Job members')
  for (const event of [contained[0], closed[0], empty[0]]) {
    assert.equal(event.id, started[0].id)
    assert.equal(event.pid, started[0].pid)
    assert.equal(event.decoderPid, contained[0].decoderPid)
  }
  assert.ok(contained[0].at >= started[0].at)
  assert.ok(closed[0].at >= contained[0].at)
  assert.ok(empty[0].at >= closed[0].at, 'Job emptiness is established after the real gate close')
  assert.equal(empty[0].activeProcesses, 0)
  assert.equal(empty[0].jobClosed, true)
  assert.deepEqual(state.closed?.processTree, { activeProcesses: 0, jobClosed: true })
  assert.equal(cleanupFailures.length, recoveredJobError ? 1 : 0)
  if (recoveredJobError) {
    assert.equal(cleanupFailures[0].error.code, recoveredJobError)
    assert.ok(cleanupFailures[0].at >= closed[0].at)
    assert.ok(empty[0].at >= cleanupFailures[0].at)
    assert.equal(empty[0].cleanupError.code, recoveredJobError)
    assert.equal(
      state.closed.cleanupError,
      empty[0].cleanupError,
      'Keep the exact first Job cleanup error after emergency teardown'
    )
  }
  for (const code of [
    'IMAGE_DECODER_GATE_FAILED',
    'IMAGE_DECODER_JOB_CANCEL_FAILED',
    'IMAGE_DECODER_JOB_TEARDOWN_FAILED',
    'IMAGE_DECODER_OWNER_FAILED'
  ])
    assert.equal(
      state.events.some((event) => event.code === code),
      false,
      code
    )
  const received = state.payload.marker && markerPhase(state.payload.marker, 'received')
  if (received) assert.equal(received.pid, contained[0].decoderPid)
}
function assertClosed(state, expectedCode = 0) {
  assertProcessTreeClosed(state)
  assert.equal(
    state.events.some((event) => event.code === 'IMAGE_DECODER_OUTPUT_OBSERVER_FAILED'),
    false
  )
  for (const event of state.events.filter((event) => event.code === 'IMAGE_DECODER_STARTED'))
    assert.equal(
      existsSync(event.profile),
      false,
      'Only the decoder-owned profile is cleaned after close'
    )
  assert.equal(state.closed?.profileCleanup, 'complete')
  assert.deepEqual(state.closed, {
    code: expectedCode,
    signal: null,
    processTree: { activeProcesses: 0, jobClosed: true },
    profileCleanup: 'complete'
  })
  const received = state.payload.marker && markerPhase(state.payload.marker, 'received')
  if (received) {
    assert.notEqual(resolve(received.profile), resolve(profileA))
    assert.equal(
      existsSync(received.profile),
      false,
      'Only the independently owned child profile is removed'
    )
  }
}
function png(width, height, shade = 100) {
  const pixels = Buffer.alloc(width * height * 4, shade)
  for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255
  return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 }).toPNG()
}
function store(profile, name, bytes) {
  const directory = join(profile, 'attachments')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  writeFileSync(path, bytes)
  return { path, relativePath: 'attachments/' + name }
}
function decodeMetric(batch = drainOperationPerformance()) {
  return batch.entries.find(
    (entry) => entry.category === 'image' && entry.operation === 'thumbnail.decode'
  )
}
async function assertRefusedUnchanged(file) {
  const before = digest(file.path)
  assert.equal(await getImageDimensions(file.relativePath), null)
  assert.equal(await getImageThumbnail(file.relativePath), null)
  assert.equal(await getImageThumbnailDetails(file.relativePath, 512), null)
  assert.equal(existsSync(file.path), true)
  assert.equal(
    digest(file.path),
    before,
    'Refusing derived reads never deletes or changes the original'
  )
}

async function storedImages() {
  assert.equal(existsSync(sourceGate), true)
  assert.equal(
    resolve(resolveImageDecoderGate(app)),
    resolve(sourceGate),
    'Source launcher resolves its built-in-only source gate'
  )
  diagnosticState.start(1)
  const normal = store(profileA, 'normal.png', png(800, 400))
  drainOperationPerformance()
  const dimensions = getImageDimensions(normal.relativePath)
  assert.equal(typeof dimensions.then, 'function')
  const thumbnail = getImageThumbnail(normal.relativePath)
  assert.equal(
    getImageThumbnail(normal.relativePath),
    thumbnail,
    'Same-key in-flight Promise identity is preserved'
  )
  assert.deepEqual(await dimensions, { width: 800, height: 400 })
  const data = await thumbnail
  assert.match(data, /^data:image\/png;base64,/)
  assert.deepEqual(nativeImage.createFromDataURL(data).getSize(), { width: 240, height: 120 })
  const shared = decodeMetric()
  assert.equal(shared.count, 1, 'Dimensions and default 240 thumbnail share one decode task')
  assert.equal(shared.metrics.cacheMisses.total, 1)
  assert.equal(await getImageThumbnail(normal.relativePath), data)
  assert.equal(decodeMetric().metrics.cacheHits.total, 1)
  assert.deepEqual(
    nativeImage.createFromDataURL(await getImageThumbnail(normal.relativePath, 1)).getSize(),
    { width: 32, height: 16 }
  )
  assert.deepEqual(
    nativeImage.createFromDataURL(await getImageThumbnail(normal.relativePath, 900)).getSize(),
    { width: 512, height: 256 }
  )

  const jpegImage = nativeImage.createFromBitmap(Buffer.alloc(320 * 160 * 4, 255), {
    width: 320,
    height: 160,
    scaleFactor: 1
  })
  const jpeg = store(profileA, 'normal.jpeg', jpegImage.toJPEG(90))
  assert.deepEqual(await getImageDimensions(jpeg.relativePath), { width: 320, height: 160 })
  assert.deepEqual(
    nativeImage.createFromDataURL(await getImageThumbnail(jpeg.relativePath)).getSize(),
    { width: 240, height: 120 }
  )
  // Magic bytes, not the stored extension, determine admission.
  const mismatched = store(profileA, 'png-bytes.jpeg', png(17, 9))
  assert.deepEqual(await getImageDimensions(mismatched.relativePath), { width: 17, height: 9 })

  let coercions = 0
  const coercible = {
    toString() {
      coercions++
      return mismatched.relativePath
    }
  }
  for (const invalid of [
    undefined,
    null,
    {},
    Object(mismatched.relativePath),
    coercible,
    'attachments/' + 'x'.repeat(40_000) + '.png'
  ]) {
    for (const read of [getImageDimensions, getImageThumbnail]) {
      let response
      assert.doesNotThrow(() => {
        response = read(invalid)
      })
      assert.equal(await response, null, 'Invalid source metadata is refused without throwing')
    }
  }
  assert.equal(coercions, 0, 'Objects must not be coerced into queued image metadata')
  assert.deepEqual(await getImageDimensions(mismatched.relativePath), { width: 17, height: 9 })

  writeFileSync(normal.path, png(120, 240, 180))
  assert.deepEqual(await getImageDimensions(normal.relativePath), { width: 120, height: 240 })
  const updated = await getImageThumbnail(normal.relativePath)
  assert.notEqual(updated, data)
  assert.deepEqual(nativeImage.createFromDataURL(updated).getSize(), { width: 120, height: 240 })
  unlinkSync(normal.path)
  assert.equal(await getImageDimensions(normal.relativePath), null)
  assert.equal(await getImageThumbnail(normal.relativePath), null)

  const largeHeader = png(1, 1)
  largeHeader.writeUInt32BE(8192, 16)
  largeHeader.writeUInt32BE(8192, 20)
  largeHeader.writeUInt32BE(crc32(largeHeader.subarray(12, 29)), 29)
  const overPixels = store(profileA, 'over-pixels.png', largeHeader)
  assert.equal(largeHeader.readUInt32BE(29), crc32(largeHeader.subarray(12, 29)))
  await assertRefusedUnchanged(overPixels)
  const direct = ownChild({ path: overPixels.path, size: 240 }, null)
  await direct.outcomePromise
  await direct.closePromise
  assert.deepEqual(direct.outcome, { ok: true, value: null })
  assert.ok(
    direct.events.some((event) => event.code === 'IMAGE_PIXELS_EXCEEDED'),
    'Legal IHDR CRC reaches the pixel budget before full decoding'
  )
  assertClosed(direct)

  const corruptPng = png(2, 2)
  corruptPng[corruptPng.length - 1] ^= 1
  await assertRefusedUnchanged(store(profileA, 'corrupt.png', corruptPng))
  await assertRefusedUnchanged(
    store(profileA, 'corrupt.jpeg', jpegImage.toJPEG(90).subarray(0, 24))
  )
  const provenance = JSON.parse(readFileSync(join(fixtureRoot, 'provenance.json'), 'utf8'))
  for (const fixture of provenance.fixtures) {
    const source = join(fixtureRoot, fixture.file)
    assert.equal(digest(source), fixture.sha256)
    const owned = store(profileA, fixture.file, readFileSync(source))
    assert.equal(digest(owned.path), fixture.sha256)
    await assertRefusedUnchanged(owned)
  }
  writeFileSync(
    join(evidenceRoot, 'image-fixture-provenance.json'),
    JSON.stringify(provenance, null, 2),
    { flag: 'wx' }
  )

  const profileB = join(profileA, 'second-product-profile')
  mkdirSync(profileB)
  const queuedA = store(profileA, 'profile-bound.png', png(77, 11))
  const queuedB = store(profileB, 'profile-bound.png', png(33, 11))
  const blocker = store(profileA, 'profile-blocker.png', png(41, 13))
  const beforeA = digest(queuedA.path)
  const beforeB = digest(queuedB.path)
  drainOperationPerformance()
  const active = getImageThumbnail(blocker.relativePath)
  const queued = getImageDimensions(queuedA.relativePath)
  const queuedOriginal = getImageBase64(queuedA.relativePath)
  app.setPath('userData', profileB)
  assert.equal(await active, null)
  assert.equal(await queued, null, 'Queued metadata stays bound to its original profile')
  assert.equal(await queuedOriginal, null, 'Original reads share the same profile-bound queue')
  assert.equal(digest(queuedA.path), beforeA)
  assert.equal(digest(queuedB.path), beforeB)
  assert.deepEqual(await getImageDimensions(queuedB.relativePath), { width: 33, height: 11 })
  app.setPath('userData', profileA)
  invalidateImageDecodes()
  assert.deepEqual(await getImageDimensions(queuedA.relativePath), { width: 77, height: 11 })

  const suspension = {}
  const pendingBeforeSuspension = getImageThumbnail(jpeg.relativePath, 128)
  await suspendImageDecodes(suspension)
  assert.equal(
    await pendingBeforeSuspension,
    null,
    'Suspend rejects pending derived reads before storage moves'
  )
  assert.equal(await getImageDimensions(queuedA.relativePath), null)
  assert.equal(await getImageThumbnail(queuedA.relativePath), null)
  const originalAttachments = join(profileA, 'attachments')
  const oldAttachments = join(profileA, 'attachments-suspended')
  renameSync(originalAttachments, oldAttachments)
  const afterStorageReset = store(profileA, 'after-storage-reset.png', png(19, 7))
  resumeImageDecodes(suspension)
  assert.deepEqual(await getImageDimensions(afterStorageReset.relativePath), {
    width: 19,
    height: 7
  })
  assert.equal(
    existsSync(join(oldAttachments, 'profile-bound.png')),
    true,
    'Suspended source remains owned and retained'
  )
}

async function originalPreviewReads() {
  // Preserve original animated/vector bytes; this checks the real read boundary,
  // not a second format matrix or a claim about SVG internal allocation.
  for (const [name, mime, bytes] of [
    [
      'original-animation.gif',
      'image/gif',
      readFileSync(
        new URL('./fixtures/image-preview-budget/gif-restore-previous.gif', import.meta.url)
      )
    ],
    ['original-vector.svg', 'image/svg+xml', readFileSync(join(fixtureRoot, 'unsupported.svg'))]
  ]) {
    const owned = store(profileA, name, bytes)
    assert.equal(
      await getImageBase64(owned.relativePath),
      `data:${mime};base64,${bytes.toString('base64')}`,
      'Original preview must retain the admitted source bytes and format'
    )
    assert.equal(digest(owned.path), createHash('sha256').update(bytes).digest('hex'))
  }
  const overHeader = png(1, 1)
  overHeader.writeUInt32BE(8192, 16)
  overHeader.writeUInt32BE(4097, 20)
  overHeader.writeUInt32BE(crc32(overHeader.subarray(12, 29)), 29)
  const overPixels = store(profileA, 'original-over-budget.png', overHeader)
  const before = digest(overPixels.path)
  assert.equal(await getImageBase64(overPixels.relativePath), null)
  assert.equal(digest(overPixels.path), before, 'Admission failure must retain the original asset')
}

async function thumbnailDetailsTransport() {
  const input = store(profileA, 'picker-details.png', png(800, 400))
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: resolve('out/preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  let authorized = true
  registerBusinessIpcHandlers({
    ipcMain: {
      handle(channel, handler) {
        ipcMain.handle(channel, handler)
        transportChannels.push(channel)
      }
    },
    getMainWindow: () => (authorized ? window : null)
  })
  await window.loadURL('data:text/html,<html><body>thumbnail details transport</body></html>')
  const read = () =>
    window.webContents.executeJavaScript(
      `window.api.getImageThumbnailDetails(${JSON.stringify(input.relativePath)}, 512)`
    )
  drainOperationPerformance()
  const [details, duplicate, legacy] = await window.webContents.executeJavaScript(
    `Promise.all([
      window.api.getImageThumbnailDetails(${JSON.stringify(input.relativePath)}, 512),
      window.api.getImageThumbnailDetails(${JSON.stringify(input.relativePath)}, 512),
      window.api.getImageThumbnail(${JSON.stringify(input.relativePath)}, 512)
    ])`
  )
  assert.deepEqual(duplicate, details)
  assert.equal(legacy, details.data)
  assert.deepEqual(Object.keys(details).sort(), ['data', 'height', 'width'])
  assert.equal(details.width, 800)
  assert.equal(details.height, 400)
  assert.deepEqual(nativeImage.createFromDataURL(details.data).getSize(), {
    width: 512,
    height: 256
  })
  const coldBatch = drainOperationPerformance()
  const cold = decodeMetric(coldBatch)
  assert.equal(cold.count, 1, 'Actual 512px consumer gets thumbnail and dimensions from one decode')
  assert.equal(cold.metrics.cacheMisses.total, 1)
  const queue = coldBatch.entries.find((entry) => entry.operation === 'thumbnail.queue')
  assert.equal(queue.count, 1, 'Combined reads retain total wait telemetry once per shared task')
  assert.equal(queue.metrics.queueDepth.max, 1)
  assert.equal(
    coldBatch.entries.find((entry) => entry.operation === 'thumbnail.deduplicated').count,
    2,
    'Both APIs share in-flight work and retain deduplication telemetry'
  )
  assert.deepEqual(await read(), details)
  assert.equal(decodeMetric().metrics.cacheHits.total, 1)
  // Same path with new bytes must not reuse geometry or pixels from the earlier file.
  writeFileSync(input.path, png(400, 800))
  const changed = await read()
  assert.equal(changed.width, 400)
  assert.equal(changed.height, 800)
  assert.deepEqual(nativeImage.createFromDataURL(changed.data).getSize(), {
    width: 256,
    height: 512
  })
  assert.equal(decodeMetric().metrics.cacheMisses.total, 1)
  authorized = false
  await assert.rejects(read(), /无权访问便签业务数据/)
  authorized = true
  unlinkSync(input.path)
  assert.equal(await read(), null, 'Missing derived image retains the nullable read contract')
}

async function bootstrapBranches() {
  const input = store(profileA, 'bootstrap.png', png(16, 8))
  const builtEntry = resolve('out/main/index.js')
  const builtGate = resolve('out/main/image-decode-gate.js')
  assert.equal(
    existsSync(builtEntry),
    true,
    'Focused suite requires its registered build-app dependency'
  )
  assert.equal(existsSync(builtGate), true, 'Fresh build-app must emit its Node-mode gate entry')
  const built = ownChild({ path: input.path, size: 240 }, builtEntry, { gateEntry: builtGate })
  await built.outcomePromise
  await built.closePromise
  assert.equal(built.outcome.ok, true)
  assert.equal(built.outcome.value.width, 16)
  assert.equal(built.outcome.value.height, 8)
  assert.match(built.outcome.value.data, /^data:image\/png;base64,/)
  assertClosed(built)

  const stage = join(profileA, 'owned-asar-stage')
  mkdirSync(stage)
  cpSync(resolve('out/main'), stage, { recursive: true })
  writeFileSync(
    join(stage, 'package.json'),
    JSON.stringify({ name: 'image-decode-bootstrap-fixture', main: 'index.js' }),
    { flag: 'wx' }
  )
  const archive = join(profileA, 'owned-image-bootstrap.asar')
  await createPackage(stage, archive)
  const archivedGate = join(archive, 'image-decode-gate.js')
  assert.equal(existsSync(archivedGate), true, 'Owned ASAR contains its own Node-mode gate entry')
  assert.equal(digest(archivedGate), digest(builtGate), 'ASAR gate matches the current built gate')
  const archived = ownChild({ path: input.path, size: 240 }, archive, { gateEntry: archivedGate })
  await archived.outcomePromise
  await archived.closePromise
  assert.equal(archived.outcome.ok, true)
  assert.equal(archived.outcome.value.width, 16)
  assert.equal(archived.outcome.value.height, 8)
  assert.match(archived.outcome.value.data, /^data:image\/png;base64,/)
  assertClosed(archived)
  writeFileSync(
    join(evidenceRoot, 'image-bootstrap-smoke.json'),
    JSON.stringify(
      {
        builtEntry,
        builtSha256: digest(builtEntry),
        sourceGate,
        sourceGateSha256: digest(sourceGate),
        builtGate,
        builtGateSha256: digest(builtGate),
        archivedGate,
        archivedGateSha256: digest(archivedGate),
        archiveSha256: physicalDigest(archive),
        workerBranches: ['built bootstrap', 'owned ASAR bootstrap'],
        actualPackagedExe: false,
        productProfileContents:
          'Not observed before owner cleanup; normal PNG reply plus exit/close0 demonstrates worker routing',
        processDescendants:
          'Private Windows Job membership, zero active members and closed handle are asserted; no external descendant snapshot'
      },
      null,
      2
    ),
    { flag: 'wx' }
  )
}

async function processOwnership() {
  const heldPayload = controlledPayload('hold-result')
  const held = ownChild(heldPayload)
  await until(() => markerPhase(heldPayload.marker, 'result-sent'), 'controlled response delivery')
  assert.equal(
    held.outcome,
    null,
    'A raw child response cannot publish before actual successful close'
  )
  assert.equal(held.closed, null)
  held.operation.cancel()
  await held.outcomePromise
  await held.closePromise
  assert.equal(held.outcome.ok, false)
  assert.equal(held.outcome.error.code, 'IMAGE_DECODE_CANCELLED')
  assertClosed(held, 1)

  const failed = ownChild(controlledPayload('fault'))
  await failed.outcomePromise
  await failed.closePromise
  assert.equal(failed.outcome.ok, false)
  assert.equal(failed.outcome.error.code, 'IMAGE_DECODER_EXIT')
  assert.equal(failed.closed.code, 7)
  assertClosed(failed, 7)

  const queued = runtime()
  const busyPayload = controlledPayload('busy')
  const first = queued.owner.request('timeout', busyPayload)
  await until(() => markerPhase(busyPayload.marker, 'busy-ready'), 'controlled busy readiness')
  const heartbeatAtBusy = heartbeat
  const second = queued.owner.request('after-timeout', controlledPayload('normal', 'after-timeout'))
  assert.equal(queued.starts.length, 1)
  assert.equal(await first, null)
  const afterTimeout = await second
  assert.equal(afterTimeout.token, 'after-timeout')
  assert.equal(queued.starts.length, 2)
  assert.ok(
    heartbeat - heartbeatAtBusy >= 5,
    'Real Electron parent keeps scheduling while its child main blocks'
  )
  assert.ok(queued.diagnostics.some((event) => event.type === 'active-timeout'))
  assertClosed(queued.starts[0], 1)
  assertClosed(queued.starts[1])
  const processTreeClosed = queued.starts[0].events.find(
    (event) => event.code === 'IMAGE_DECODER_JOB_EMPTY'
  ).at
  const nextStart = queued.starts[1].events.find(
    (event) => event.code === 'IMAGE_DECODER_STARTED'
  ).at
  assert.ok(
    nextStart >= processTreeClosed,
    'Next work cannot start before the previous Job is empty and its handle is closed'
  )
  await queued.owner.dispose()

  const late = runtime()
  const oldPayload = controlledPayload('wait-release', 'old-source')
  let current = true
  const old = late.owner.request('old-source', oldPayload, () => current)
  await until(() => markerPhase(oldPayload.marker, 'waiting-release'), 'old source readiness')
  const fresh = late.owner.request('fresh-source', controlledPayload('normal', 'fresh-source'))
  current = false
  writeFileSync(oldPayload.release, 'release', { flag: 'wx' })
  assert.equal(
    await old,
    null,
    'The original late result is rejected after source generation invalidation'
  )
  assert.equal((await fresh).token, 'fresh-source')
  assert.equal(late.starts[0].outcome.ok, true)
  assert.equal(
    late.starts[0].outcome.value.token,
    'old-source',
    'The child really produced the discarded old result'
  )
  assertClosed(late.starts[0])
  assertClosed(late.starts[1])
  await late.owner.dispose()

  const disposal = runtime()
  const disposingPayload = controlledPayload('busy')
  const active = disposal.owner.request('dispose-active', disposingPayload)
  await until(() => markerPhase(disposingPayload.marker, 'busy-ready'), 'dispose active readiness')
  const waiting = disposal.owner.request('dispose-queued', controlledPayload('normal'))
  const disposed = disposal.owner.dispose()
  assert.equal(disposal.owner.dispose(), disposed)
  assert.equal(disposal.owner.snapshot().sealed, true)
  assert.equal(await waiting, null)
  assert.equal(await active, null)
  await disposed
  assert.equal(disposal.starts.length, 1)
  assertClosed(disposal.starts[0], 1)
  assert.equal(disposal.owner.snapshot().busy, false)
  assert.equal(await disposal.owner.request('after-dispose', controlledPayload('normal')), null)
  assert.equal(
    existsSync(profileA),
    true,
    'Decoder cleanup never removes the suite/product profile'
  )
}

async function detachedDescendantOwnership() {
  const queue = runtime()
  const payload = controlledPayload('detached-descendant')
  const first = queue.owner.request('detached-descendant', payload)
  const state = queue.starts[0]
  const descendantReady = await until(
    () => markerPhase(payload.marker, 'descendant-ready'),
    'controlled detached descendant readiness'
  )
  const received = markerPhase(payload.marker, 'received')
  assert.ok(Number.isInteger(descendantReady.descendant.pid) && descendantReady.descendant.pid > 0)
  assert.notEqual(descendantReady.descendant.pid, received.pid)
  assert.equal(descendantReady.descendant.parentPid, received.pid)
  assert.equal(descendantReady.descendant.mode, '1')
  assert.equal(descendantReady.descendant.processType, 'undefined')
  assert.equal(descendantReady.descendant.electronVersion, process.versions.electron)
  assert.equal(descendantReady.descendant.nodeOptions, null)
  assert.equal(descendantReady.descendant.nodePath, null)
  await until(() => !processAlive(received.pid), 'decoder real exit before descendant cancellation')
  assert.ok(
    markerPhase(payload.marker, 'result-sent'),
    'The decoder really sent a successful response'
  )
  assert.equal(
    processAlive(descendantReady.descendant.pid),
    true,
    'The real detached descendant outlives its decoder'
  )
  assert.equal(
    queue.diagnostics.some((event) => event.type === 'active-timeout'),
    false
  )
  assert.equal(
    state.outcome,
    null,
    'A raw successful response cannot escape the still-owned process tree'
  )
  assert.equal(state.closed, null)
  const second = queue.owner.request(
    'after-detached-descendant',
    controlledPayload('normal', 'after-detached-descendant')
  )
  assert.equal(
    queue.starts.length,
    1,
    'The occupied descendant/transport retains the single execution slot'
  )
  assert.equal(await first, null)
  assert.equal((await second).token, 'after-detached-descendant')
  assert.equal(queue.starts.length, 2)
  assert.equal(
    queue.diagnostics.filter(
      (event) => event.type === 'active-timeout' && event.key === 'detached-descendant'
    ).length,
    1
  )
  assert.equal(state.outcome.ok, false)
  assert.equal(state.outcome.error.code, 'IMAGE_DECODE_CANCELLED')
  assertClosed(state, 1)
  assertClosed(queue.starts[1])
  assert.equal(
    processAlive(descendantReady.descendant.pid),
    false,
    'Job cancellation ends the actual detached descendant'
  )
  const treeClosed = state.events.find((event) => event.code === 'IMAGE_DECODER_JOB_EMPTY')
  const nextStart = queue.starts[1].events.find((event) => event.code === 'IMAGE_DECODER_STARTED')
  assert.ok(
    nextStart.at >= treeClosed.at,
    'Next work starts only after real close, Job zero and handle close'
  )
  assert.equal(queue.owner.snapshot().cleanupFailures, 0)
  assert.equal(queue.owner.snapshot().busy, false)
  assert.equal(existsSync(profileA), true)
  await queue.owner.dispose()
  writeFileSync(
    join(evidenceRoot, 'image-detached-descendant-timeout.json'),
    JSON.stringify(
      {
        payload,
        descendantReady,
        diagnostics: queue.diagnostics,
        outcome: state.outcome,
        closed: state.closed,
        treeClosed,
        nextStart,
        contract:
          'A real detached descendant/transport keeps capacity owned after decoder exit; fixed active timeout cancels the complete Job before the next task'
      },
      null,
      2
    ),
    { flag: 'wx' }
  )
}

async function injectedJobWaitFailureOwnership() {
  const injectedError = Object.assign(
    new Error('Controlled first Job wait failure; no natural Win32 failure is claimed'),
    {
      code: 'E831_INJECTED_JOB_WAIT_FAILURE',
      provenance: 'test-only delegated real Job first-wait injection'
    }
  )
  const calls = []
  const starts = []
  const diagnostics = []
  let waitCalls = 0
  const owner = createImageDecodeRuntime({
    activeTimeoutMs: 5000,
    totalTimeoutMs: 20_000,
    start(payload) {
      const first = starts.length === 0
      const state = ownChild(
        payload,
        controlledEntry,
        first
          ? {
              createProcessJob() {
                const realJob = createImageDecodeProcessJob()
                return {
                  ...realJob,
                  waitForEmpty(options) {
                    const call = ++waitCalls
                    calls.push({
                      type: call === 1 ? 'wait-injected' : 'wait-real',
                      options,
                      activeProcesses: realJob.activeProcesses()
                    })
                    if (call === 1) throw injectedError
                    return realJob.waitForEmpty(options)
                  },
                  terminate(exitCode) {
                    calls.push({ type: 'terminate-real', exitCode })
                    return realJob.terminate(exitCode)
                  },
                  close() {
                    const value = realJob.close()
                    calls.push({ type: 'close-real', value })
                    return value
                  }
                }
              }
            }
          : {}
      )
      starts.push(state)
      return state.operation
    },
    onDiagnostic: (event) => diagnostics.push({ ...event, at: performance.now() })
  })
  runtimes.add(owner)
  const first = owner.request('injected-job-wait', controlledPayload('normal', 'injected-job-wait'))
  const next = owner.request(
    'after-injected-job-wait',
    controlledPayload('normal', 'after-injected-job-wait')
  )
  assert.equal(
    await first,
    null,
    'A successful raw response is not published after the injected first cleanup failure'
  )
  assert.equal((await next).token, 'after-injected-job-wait')
  assert.equal(starts.length, 2)
  const state = starts[0]
  assert.ok(
    markerPhase(state.payload.marker, 'result-sent'),
    'The controlled decoder sent its original successful response'
  )
  assert.equal(state.outcome.ok, false)
  assert.equal(state.outcome.error.code, injectedError.code)
  assert.equal(state.outcome.error.message, injectedError.message)
  assertProcessTreeClosed(state, injectedError.code)
  assert.equal(state.closed.code, 0)
  assert.equal(state.closed.signal, null)
  assert.equal(state.closed.profileCleanup, 'complete')
  assert.equal(
    state.closed.cleanupError,
    injectedError,
    'The first injected Error object survives real emergency teardown'
  )
  const started = state.events.find((event) => event.code === 'IMAGE_DECODER_STARTED')
  assert.equal(state.closed.profile, started.profile)
  assert.equal(existsSync(state.closed.profile), false)
  assert.equal(waitCalls, 2)
  assert.deepEqual(
    calls.map((call) => call.type),
    ['wait-injected', 'terminate-real', 'wait-real', 'close-real']
  )
  for (const call of calls.filter((call) => call.type.startsWith('wait-')))
    assert.deepEqual(call.options, { timeoutMs: 2000, pollIntervalMs: 10 })
  assert.equal(calls.find((call) => call.type === 'terminate-real').exitCode, 1)
  assert.deepEqual(calls.find((call) => call.type === 'close-real').value, {
    closed: true,
    activeProcesses: 0
  })
  assertClosed(starts[1])
  const treeClosed = state.events.find((event) => event.code === 'IMAGE_DECODER_JOB_EMPTY')
  const nextStart = starts[1].events.find((event) => event.code === 'IMAGE_DECODER_STARTED')
  assert.ok(nextStart.at >= treeClosed.at)
  assert.equal(
    diagnostics.filter((event) => event.type === 'result-error' && event.error === injectedError)
      .length,
    1
  )
  assert.equal(
    diagnostics.filter((event) => event.type === 'cleanup-error' && event.error === injectedError)
      .length,
    1
  )
  assert.equal(owner.snapshot().cleanupFailures, 1)
  assert.equal(owner.snapshot().busy, false)
  assert.equal(owner.snapshot().blocked, false)
  await assert.rejects(owner.dispose(), (error) => error === injectedError)
  assert.equal(
    owner.snapshot().cleanupFailures,
    1,
    'Late disposal retains the independently verified first cleanup error'
  )
  runtimes.delete(owner)
  writeFileSync(
    join(evidenceRoot, 'image-injected-job-wait-cleanup.json'),
    JSON.stringify(
      {
        firstError: {
          ...injectedError,
          message: injectedError.message,
          stack: injectedError.stack
        },
        calls,
        outcome: state.outcome,
        closed: state.closed,
        diagnostics,
        treeClosed,
        nextStart,
        contract:
          'Test-only first wait injection delegates attach, membership, terminate, second wait and close to the real Windows Job; it does not reproduce a natural Win32 or not-empty failure'
      },
      null,
      2
    ),
    { flag: 'wx' }
  )
}

async function cleanupInjectedProfiles() {
  for (const [target, injection] of injectedProfiles) {
    const expectedParent = resolve(await realpath(tmpdir()))
    const ownedStart = injection.state.events.find(
      (event) => event.code === 'IMAGE_DECODER_STARTED' && resolve(event.profile) === target
    )
    const received = markerPhase(injection.state.payload.marker, 'received')
    assert.ok(ownedStart, "Manual cleanup requires this invocation's exact child ownership record")
    assert.equal(injection.state.closed?.profileCleanup, 'failed')
    assert.equal(injection.state.closed?.code, 0)
    assert.equal(resolve(received.profile), target)
    assert.notEqual(target, resolve(profileA))
    assert.equal(dirname(target), expectedParent)
    assert.ok(basename(target).startsWith('abandon-image-decode-'))
    const info = await lstat(target)
    assert.equal(info.isDirectory(), true)
    assert.equal(info.isSymbolicLink(), false)
    assert.equal(resolve(await realpath(target)), target)
    // Preserve the original failure before separately cleaning only this injected leftover.
    writeFileSync(
      join(evidenceRoot, 'image-profile-cleanup-original.json'),
      JSON.stringify(
        {
          target,
          originalError: injection.error,
          originalClosed: injection.state.closed,
          ownedStart,
          received,
          manualCleanup: 'not-yet-attempted'
        },
        null,
        2
      ),
      { flag: 'wx' }
    )
    await rm(target, { recursive: true })
    assert.equal(existsSync(target), false)
    writeFileSync(
      join(evidenceRoot, 'image-profile-cleanup-manual.json'),
      JSON.stringify(
        {
          target,
          manualCleanup: 'complete',
          originalProfileCleanup: 'failed',
          scope:
            'Only the exact independently owned profile deliberately retained by this injected failure'
        },
        null,
        2
      ),
      { flag: 'wx' }
    )
    injectedProfiles.delete(target)
  }
}

async function cleanupFailureOwnership() {
  const starts = []
  let removeCalls = 0
  const cleanupError = Object.assign(new Error('Controlled decoder profile cleanup failure'), {
    code: 'E831_PROFILE_CLEANUP_FAILED'
  })
  const owner = createImageDecodeRuntime({
    activeTimeoutMs: 5000,
    totalTimeoutMs: 20_000,
    start(payload) {
      const first = starts.length === 0
      let state
      state = ownChild(
        payload,
        controlledEntry,
        first
          ? {
              removeProfile: async (target) => {
                removeCalls++
                const error = {
                  code: cleanupError.code,
                  message: cleanupError.message,
                  stack: cleanupError.stack
                }
                injectedProfiles.set(resolve(target), { state, error })
                writeFileSync(
                  join(evidenceRoot, 'image-profile-cleanup-injection.json'),
                  JSON.stringify(
                    {
                      target,
                      originalError: error,
                      removeCalls,
                      at: new Date().toISOString()
                    },
                    null,
                    2
                  ),
                  { flag: 'wx' }
                )
                throw cleanupError
              }
            }
          : {}
      )
      starts.push(state)
      return state.operation
    }
  })
  runtimes.add(owner)
  try {
    const first = owner.request('cleanup-failed', controlledPayload('normal', 'cleanup-failed'))
    const next = owner.request(
      'after-cleanup-failure',
      controlledPayload('normal', 'after-cleanup-failure')
    )
    assert.equal(
      (await first).token,
      'cleanup-failed',
      'Cleanup failure does not erase a successful business result'
    )
    assert.equal(
      (await next).token,
      'after-cleanup-failure',
      'Actual close permits the next independent task'
    )
    assert.equal(removeCalls, 1)
    assert.equal(starts.length, 2)
    assert.equal(starts[0].outcome.ok, true)
    assert.equal(starts[0].closed.code, 0)
    assert.equal(starts[0].closed.signal, null)
    assertProcessTreeClosed(starts[0])
    assert.equal(starts[0].closed.profileCleanup, 'failed')
    assert.equal(starts[0].closed.cleanupError.code, cleanupError.code)
    assert.equal(starts[0].closed.cleanupError.message, cleanupError.message)
    assert.equal(existsSync(starts[0].closed.profile), true)
    assert.equal(owner.snapshot().busy, false)
    assert.equal(owner.snapshot().cleanupFailures, 1)
    assertClosed(starts[1])
    await assert.rejects(owner.dispose(), (error) => error.code === cleanupError.code)
    assert.equal(
      owner.snapshot().cleanupFailures,
      1,
      'Disposal must retain the original historical cleanup failure'
    )
    // The expected disposal rejection was independently asserted; do not conceal it in restore.
    runtimes.delete(owner)
  } finally {
    if (starts[0]?.closed) await cleanupInjectedProfiles()
  }
}

async function restore() {
  for (const channel of transportChannels.splice(0)) ipcMain.removeHandler(channel)
  app.setPath('userData', profileA)
  for (const owner of runtimes) void owner.dispose().catch(() => {})
  for (const state of liveOperations) state.operation.cancel()
  const shutdown = await bounded(
    Promise.allSettled([
      ...[...runtimes].map((owner) => owner.dispose()),
      ...[...liveOperations].map((state) => state.closePromise),
      disposeImageDecodes()
    ]),
    10_000,
    'owned decoder shutdown'
  )
  await cleanupInjectedProfiles()
  assert.equal(liveOperations.size, 0)
  diagnosticState.stop('image-decode-test-complete')
  diagnosticState.dispose()
  clearInterval(heartbeatTimer)
  const failed = shutdown.find((result) => result.status === 'rejected')
  if (failed) throw failed.reason
}

app
  .whenReady()
  .then(async () => {
    let failure
    try {
      await storedImages()
      await thumbnailDetailsTransport()
      await originalPreviewReads()
      await processOwnership()
      await detachedDescendantOwnership()
      await injectedJobWaitFailureOwnership()
      await cleanupFailureOwnership()
      await bootstrapBranches()
    } catch (error) {
      failure = error
      console.error(error)
    }
    const summary = () => ({
      maximumHeartbeatGapMs,
      heartbeat,
      children: observations.map((state) => ({
        payload: state.payload,
        entry: state.entry,
        gateEntry: state.gateEntry,
        events: state.events,
        outputFiles: state.outputFiles,
        outcome: state.outcome,
        closed: state.closed
      })),
      limitations: [
        'Built/owned-ASAR bootstrap only, no actual packaged executable',
        'No complete regression',
        'No EXIF/ICC/complete format matrix, physical low memory or decoder exploit acceptance'
      ]
    })
    await lifecycle.finish({
      completed: !failure,
      error: failure,
      summary: summary(),
      restore: async () => {
        await restore()
        writeFileSync(
          join(evidenceRoot, 'image-decode-children.json'),
          JSON.stringify(summary(), null, 2),
          { flag: 'wx' }
        )
      }
    })
  })
  .catch((error) => void lifecycle.finish({ error, restore }))
