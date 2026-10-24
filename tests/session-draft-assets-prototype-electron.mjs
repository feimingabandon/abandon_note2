import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { open as openFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  createSessionDraftAssetStore,
  publicSessionDraftAssetError,
  readSessionDraftAssetPayload
} from '../scripts/prototypes/session-draft-assets/asset-store.mjs'
import { addNoteImages } from '../src/main/notes/note-commands.js'
import { createNote, getNoteById } from '../src/main/db/db-notes.js'
import { closeDatabase, getDb, initDatabase } from '../src/main/db/db.js'
import { resolveImagePath } from '../src/main/db/db-images.js'
import { flushLogs } from '../src/main/logging/logger.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { waitForFixtureFrame } from './helpers/electron-fixture-frame.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/session-draft-assets-prototype-electron.mjs',
  mode: 'electron-session-draft-assets-prototype',
  prefix: 'abandon-session-draft-assets-',
  timeoutMs: 90000,
  metadata: {
    scope: 'isolated session asset mechanism; no production draft integration',
    productionModules: ['useDraftProtection', 'useMessage', 'addNoteImages'],
    renderer: 'localhost exact allowlist, actual Vue module and product composable',
    input: 'controlled DOM input events and actual post watcher; not physical keyboard',
    measurement:
      process.env.ABANDON_DRAFT_PROTOTYPE_SMOKE_ONLY === '1'
        ? 'smoke only: actual IPC, modules and one watcher input per arm; no full acceptance claim'
        : 'actual JSON.stringify and Storage.prototype.setItem; 20 successful inputs per arm',
    memory: 'no renderer memory reduction claim; shared source PNG may remain in fixture/IPC',
    handoff:
      'fixed main callback reads and encodes once per explicit attempt; real SQLite and files',
    boundaries: [
      'E5.4 production leave/busy/clear integration pending',
      'CaptureDelivery and migration pending',
      'same startup reload only'
    ]
  }
})
const { assert, root } = lifecycle
app.setPath('userData', root)
const sessionId = randomUUID()
const assetRoot = join(root, 'prototype-session-assets')
const fixtureRoot = resolve('scripts/prototypes/session-draft-assets')
const startedAt = Date.now()
const businessDeadline = startedAt + 75000
const trace = [],
  invocations = new Set(),
  gates = new Set(),
  sockets = new Set()
const metrics = { writes: [], reads: [], headers: [], handoffs: [], arms: {}, cleanup: {} }
const windowDiagnosticsPath = join(
  process.env.ABANDON_TEST_EVIDENCE_DIR || root,
  'prototype-window-diagnostics.jsonl'
)
const diagnosticWriteErrors = []
let window,
  server,
  fixtureUrl,
  store,
  currentDocument,
  documentGeneration = 0
let ioGate,
  actionGate,
  consumerGate,
  handoffNoteId,
  committedFormal,
  phase = 'startup',
  closing = false
let databaseOpen = false
const q = JSON.stringify
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function deferred() {
  let resolveGate
  const promise = new Promise((done) => {
    resolveGate = done
  })
  return { promise, resolve: resolveGate }
}
function gate(kind) {
  const value = { kind, entered: deferred(), release: deferred(), captured: false }
  gates.add(value)
  return value
}
function release(value) {
  if (!value) return
  value.release.resolve()
  gates.delete(value)
  if (ioGate === value) ioGate = null
  if (actionGate === value) actionGate = null
  if (consumerGate === value) consumerGate = null
}
function record(event, details = {}) {
  const entry = { sequence: trace.length + 1, at: Date.now(), phase, event, ...details }
  trace.push(entry)
  return entry
}
function windowState() {
  if (!window) return { created: false }
  const state = { created: true, destroyed: window.isDestroyed() }
  if (state.destroyed) return state
  for (const [key, read] of [
    ['visible', () => window.isVisible()],
    ['minimized', () => window.isMinimized()],
    ['focused', () => window.isFocused()],
    ['bounds', () => window.getBounds()],
    ['contentBounds', () => window.getContentBounds()],
    ['contentsDestroyed', () => window.webContents.isDestroyed()],
    ['loading', () => window.webContents.isLoading()],
    ['url', () => window.webContents.getURL()],
    ['rendererPid', () => window.webContents.getOSProcessId()]
  ]) {
    try {
      state[key] = read()
    } catch (error) {
      state[key] = { error: error.message }
    }
  }
  return state
}
function diagnose(event, details = {}) {
  const entry = record(event, { window: windowState(), ...details })
  try {
    appendFileSync(windowDiagnosticsPath, JSON.stringify(entry) + '\n', 'utf8')
  } catch (error) {
    diagnosticWriteErrors.push(error.message)
    console.error('[prototype-window-diagnostics]', error)
  }
}
function observeWindowEvidence() {
  for (const name of [
    'show',
    'hide',
    'minimize',
    'restore',
    'focus',
    'blur',
    'ready-to-show',
    'closed'
  ])
    window.on(name, () => diagnose('window-' + name))
  const contents = window.webContents
  for (const name of ['dom-ready', 'did-finish-load', 'unresponsive', 'responsive', 'destroyed'])
    contents.on(name, () => diagnose('renderer-' + name))
  contents.on('render-process-gone', (_event, details) =>
    diagnose('renderer-process-gone', details)
  )
  contents.on('did-fail-load', (_event, code, description, url, main) =>
    diagnose('renderer-load-failed', { code, description, url, main })
  )
  app.on('child-process-gone', (_event, details) => diagnose('child-process-gone', details))
  app.on('gpu-info-update', () =>
    diagnose('gpu-info-update', { features: app.getGPUFeatureStatus() })
  )
  // The lifecycle still performs its one real capture with its original deadline.
  // This instance observer preserves the exact arguments, image and rejection.
  const originalDescriptor = Object.getOwnPropertyDescriptor(contents, 'capturePage')
  const originalCapture = contents.capturePage
  const restore = () => {
    if (originalDescriptor) Object.defineProperty(contents, 'capturePage', originalDescriptor)
    else delete contents.capturePage
  }
  Object.defineProperty(contents, 'capturePage', {
    configurable: true,
    writable: true,
    value: function (...args) {
      const started = performance.now()
      diagnose('final-capture-start', { argumentCount: args.length })
      let actual
      try {
        actual = Reflect.apply(originalCapture, this, args)
      } catch (error) {
        restore()
        diagnose('final-capture-rejected', {
          ms: performance.now() - started,
          error: error.stack || error.message
        })
        throw error
      }
      return actual.then(
        (image) => {
          restore()
          diagnose('final-capture-resolved', {
            ms: performance.now() - started,
            empty: image.isEmpty(),
            size: image.getSize()
          })
          assert.equal(image.isEmpty(), false, 'final evidence requires a nonempty real screenshot')
          return image
        },
        (error) => {
          restore()
          diagnose('final-capture-rejected', {
            ms: performance.now() - started,
            error: error.stack || error.message
          })
          throw error
        }
      )
    }
  })
  diagnose('window-evidence-observer-installed', { gpuFeatures: app.getGPUFeatureStatus() })
}
async function prepareFinalEvidenceFrame() {
  assert.ok(
    window && !window.isDestroyed() && !window.webContents.isDestroyed(),
    'final screenshot requires a live prototype window'
  )
  const { width, height } = await window.webContents.executeJavaScript(
    '({ width: innerWidth, height: innerHeight })'
  )
  const bytes = randomBytes(3)
  const marker = [32 + (bytes[0] % 48), 112 + (bytes[1] % 48), 192 + (bytes[2] % 48)]
  const contents = window.webContents
  const subscriptionDescriptor = Object.getOwnPropertyDescriptor(contents, 'beginFrameSubscription')
  const originalSubscribe = contents.beginFrameSubscription
  metrics.subscriptionFrames = []
  Object.defineProperty(contents, 'beginFrameSubscription', {
    configurable: true,
    writable: true,
    value: function (onlyDirty, callback) {
      return Reflect.apply(originalSubscribe, this, [
        onlyDirty,
        (image, dirtyRect) => {
          if (metrics.subscriptionFrames.length < 3) {
            const name = `prototype-subscription-frame-${metrics.subscriptionFrames.length + 1}.png`
            const png = image.toPNG()
            try {
              writeFileSync(join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, name), png, {
                flag: 'wx'
              })
            } catch (error) {
              diagnosticWriteErrors.push(error.stack || error.message)
            }
            metrics.subscriptionFrames.push({
              name,
              at: Date.now(),
              size: image.getSize(),
              sha256: hash(png)
            })
          }
          return callback(image, dirtyRect)
        }
      ])
    }
  })
  let frame
  try {
    frame = waitForFixtureFrame({
      webContents: window.webContents,
      name: 'session-draft-prototype-after-dispose',
      marker,
      palette: 'white',
      viewport: { width, height }
    })
  } finally {
    if (subscriptionDescriptor)
      Object.defineProperty(contents, 'beginFrameSubscription', subscriptionDescriptor)
    else delete contents.beginFrameSubscription
  }
  metrics.finalFrame = frame.trace
  metrics.finalFrame.suiteDeadlineMs = 2000
  let deadline, preparationFailure
  try {
    const expired = new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error('Final prototype marker was not presented within 2000ms')),
        2000
      )
    })
    const presented = Promise.race([frame.ready, expired])
    // This handler is installed before the renderer operation can fail.
    presented.catch(() => {})
    metrics.finalRenderer = await Promise.race([
      window.webContents.executeJavaScript(`window.fixture?.prepareFinalEvidence(${q(marker)})`),
      expired
    ])
    diagnose('final-renderer-marker-requested', { renderer: metrics.finalRenderer, marker })
    await presented
    diagnose('final-marker-presented', { frame: frame.trace })
    assert.ok(frame.trace.selected, 'final screenshot requires a presented post-dispose frame')
  } catch (error) {
    preparationFailure = error
    diagnose('final-marker-failed', { error: error.stack || error.message, frame: frame.trace })
  } finally {
    clearTimeout(deadline)
    frame.close()
    try {
      metrics.finalEvidenceAnimationStop = await window.webContents.executeJavaScript(
        'window.fixture?.stopFinalEvidence()'
      )
      diagnose('final-marker-animation-stopped', { animation: metrics.finalEvidenceAnimationStop })
      assert.equal(metrics.finalEvidenceAnimationStop.active, false)
      assert.equal(metrics.finalEvidenceAnimationStop.scheduled, false)
      if (metrics.finalRenderer?.evidenceAnimation?.active)
        assert.equal(metrics.finalEvidenceAnimationStop.cancelledRequests, 1)
      assert.deepEqual(
        await window.webContents.executeJavaScript('window.fixture?.evidenceAnimationState()'),
        metrics.finalEvidenceAnimationStop,
        'stopped damage cue must retain no scheduled animation or later ticks'
      )
    } catch (error) {
      metrics.finalEvidenceAnimationStopError = error.stack || error.message
      diagnose('final-marker-animation-stop-failed', {
        error: metrics.finalEvidenceAnimationStopError
      })
      preparationFailure ||= error
    }
  }
  if (preparationFailure) throw preparationFailure
}
async function until(read, label) {
  while (!closing && Date.now() < businessDeadline) {
    const value = await read()
    if (value) return value
    await new Promise((done) => setTimeout(done, 15))
  }
  throw new Error(phase + ': ' + label)
}
const js = (code) => {
  if (closing) throw new Error('Prototype is shutting down')
  return window.webContents.executeJavaScript(code)
}
async function ready() {
  await until(() => js('Boolean(window.fixture?.ready)'), 'Vue fixture did not become ready')
}
async function reload() {
  const oldGeneration = documentGeneration
  const loaded = new Promise((done, reject) => {
    const failed = (_event, code, description, _url, main) => {
      if (main) {
        cleanup()
        reject(new Error(`Reload failed ${code}: ${description}`))
      }
    }
    const complete = () => {
      cleanup()
      done()
    }
    const cleanup = () => {
      window.webContents.removeListener('did-fail-load', failed)
      window.webContents.removeListener('did-finish-load', complete)
    }
    window.webContents.once('did-finish-load', complete)
    window.webContents.on('did-fail-load', failed)
  })
  window.webContents.reload()
  await loaded
  await ready()
  assert.ok(documentGeneration > oldGeneration, 'reload must commit a new document identity')
}
function isCurrent(document) {
  return (
    document === currentDocument &&
    Boolean(document) &&
    !window.isDestroyed() &&
    window.webContents.mainFrame.url === fixtureUrl
  )
}
function authorize(event) {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== fixtureUrl ||
    !isCurrent(currentDocument)
  )
    throw Object.assign(new Error('Untrusted prototype document'), {
      code: 'DRAFT_DOCUMENT_EXPIRED'
    })
  return currentDocument
}
async function observedIo(method, original, args) {
  const entry = {
    method,
    startedAt: performance.now(),
    bytes: method === 'writeFile' ? args[1].byteLength : null
  }
  const held = ioGate?.kind === method && !ioGate.captured ? ioGate : null
  if (held) {
    held.captured = true
    held.entered.resolve()
    await held.release.promise
  }
  const started = performance.now()
  try {
    const result = await Reflect.apply(original, undefined, args)
    entry.ms = performance.now() - started
    entry.heldMs = started - entry.startedAt
    entry.success = true
    if (method === 'readFile') entry.bytes = result.byteLength
    return result
  } catch (error) {
    entry.ms = performance.now() - started
    entry.success = false
    entry.error = error.code || error.message
    throw error
  } finally {
    metrics[method === 'writeFile' ? 'writes' : 'reads'].push(entry)
  }
}
async function consumeAssets(descriptors) {
  const entry = {
    attempt: metrics.handoffs.length + 1,
    assets: descriptors.length,
    reads: [],
    transcodes: []
  }
  metrics.handoffs.push(entry)
  const held = consumerGate
  if (held) {
    held.captured = true
    held.entered.resolve()
    await held.release.promise
  }
  if (closing) throw new Error('Prototype closing before handoff')
  const images = []
  for (const descriptor of descriptors) {
    let started = performance.now()
    // The production asset file includes an ownership header. This main-only
    // reader validates that header and returns only image payload bytes.
    const bytes = await readSessionDraftAssetPayload(descriptor)
    entry.reads.push({ bytes: bytes.length, ms: performance.now() - started, sha256: hash(bytes) })
    assert.equal(hash(bytes), descriptor.sha256)
    started = performance.now()
    const base64 = bytes.toString('base64')
    entry.transcodes.push({
      bytes: bytes.length,
      base64Bytes: base64.length,
      ms: performance.now() - started
    })
    images.push({ base64, ext: descriptor.ext, name: descriptor.name })
  }
  const db = getDb()
  const originalDescriptor = Object.getOwnPropertyDescriptor(db, 'transaction')
  const originalTransaction = db.transaction
  const commandStarted = performance.now()
  let transactionEnded
  // Timing-only observer invokes the original real transaction including rollback.
  // The first span includes preflight and formal asynchronous stage; it is not a
  // claimed pure filesystem stage microbenchmark.
  Object.defineProperty(db, 'transaction', {
    configurable: true,
    writable: true,
    value: function (...args) {
      const actual = Reflect.apply(originalTransaction, this, args)
      return new Proxy(actual, {
        apply(target, receiver, parameters) {
          entry.preflightAndFormalStageMs = performance.now() - commandStarted
          const started = performance.now()
          try {
            return Reflect.apply(target, receiver, parameters)
          } finally {
            transactionEnded = performance.now()
            entry.sqlAndRenameMs = transactionEnded - started
          }
        }
      })
    }
  })
  try {
    const result = await addNoteImages({ noteId: handoffNoteId, images })
    entry.success = true
    return result
  } catch (error) {
    entry.success = false
    entry.error = error.message
    throw error
  } finally {
    const ended = performance.now()
    entry.commandTotalMs = ended - commandStarted
    entry.postTransactionCleanupMs =
      transactionEnded === undefined ? null : ended - transactionEnded
    if (originalDescriptor) Object.defineProperty(db, 'transaction', originalDescriptor)
    else delete db.transaction
  }
}
function registerIpc() {
  ipcMain.handle('draft-prototype:invoke', (event, request) => {
    const entry = record('ipc', {
      action: request?.action,
      operationId: request?.operationId || null,
      status: 'pending'
    })
    const started = performance.now()
    const task = (async () => {
      try {
        const document = authorize(event)
        entry.documentGeneration = document.generation
        const { action, lease, assetId, assetIds, operationId } = request
        let value
        if (action === 'open') value = store.openOwner(document, request.key, request.resume)
        else if (action === 'stage') {
          entry.base64Bytes = Buffer.byteLength(request.image.base64)
          value = await store.stage(document, lease, request.image)
          entry.decodedBytes = value.size
        } else if (action === 'preview') {
          value = await store.preview(document, lease, assetId)
          entry.previewBytes = value.size
        } else if (action === 'release') {
          const held = actionGate?.kind === 'release' ? actionGate : null
          if (held) {
            held.captured = true
            held.entered.resolve()
            await held.release.promise
          }
          value = await store.release(document, lease, assetIds)
        } else if (action === 'cancel') value = await store.cancelOwner(document, lease)
        else if (action === 'handoff')
          value = store.beginHandoff(document, lease, assetIds, consumeAssets)
        else if (action === 'wait') value = await store.waitHandoff(document, lease, operationId)
        else if (action === 'operation') value = store.operationState(document, lease, operationId)
        else throw new Error('Unsupported isolated action')
        entry.status = 'fulfilled'
        return { ok: true, value }
      } catch (error) {
        entry.status = 'rejected'
        entry.code = error.code || null
        entry.message = error.message
        entry.mainError = {
          name: error.name,
          code: error.code || null,
          message: error.message,
          stack: error.stack || null
        }
        entry.publicError = publicSessionDraftAssetError(error)
        return { ok: false, error: entry.publicError }
      } finally {
        entry.ms = performance.now() - started
      }
    })()
    invocations.add(task)
    task.finally(() => invocations.delete(task))
    return task
  })
}
async function startServer() {
  const allowed = new Map([
    ['/fixture.html', [join(fixtureRoot, 'fixture.html'), 'text/html; charset=utf-8']],
    [
      '/vendor/vue.js',
      [resolve('node_modules/vue/dist/vue.esm-browser.js'), 'text/javascript; charset=utf-8']
    ],
    [
      '/product/useDraftProtection.js',
      [
        resolve('src/renderer/src/composables/useDraftProtection.js'),
        'text/javascript; charset=utf-8'
      ]
    ],
    [
      '/product/useMessage.js',
      [resolve('src/renderer/src/composables/useMessage.js'), 'text/javascript; charset=utf-8']
    ]
  ])
  server = createServer((request, response) => {
    const resource = allowed.get(request.url)
    if (request.method !== 'GET' || !resource) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': resource[1],
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:"
    })
    response.end(readFileSync(resource[0]))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture.html`
}
function assertInputs(report, count, finalValue) {
  assert.equal(report.inputs.length, count)
  assert.equal(report.stringify.length, count, 'only one actual stringify per watcher input')
  assert.equal(report.storage.length, count, 'only one actual storage write per watcher input')
  assert.equal(report.storage.filter((entry) => entry.success).length, count)
  assert.equal(report.finalValue, finalValue)
  for (const entry of [...report.stringify, ...report.storage]) {
    assert.ok(Number.isFinite(entry.ms) && entry.ms >= 0)
    assert.ok(entry.utf16Bytes > 0 && entry.utf8Bytes > 0)
  }
}
const assetIdentity = (snapshot) =>
  snapshot.assets.map(({ assetId, ownerId, generation, status, path, size, pins, sha256 }) => ({
    assetId,
    ownerId,
    generation,
    status,
    path,
    size,
    pins,
    sha256
  }))
const ioCounts = () => ({
  writes: metrics.writes.length,
  reads: metrics.reads.length,
  stageIpc: trace.filter((entry) => entry.event === 'ipc' && entry.action === 'stage').length,
  previewIpc: trace.filter((entry) => entry.event === 'ipc' && entry.action === 'preview').length
})
const ioDelta = (before) =>
  Object.fromEntries(Object.entries(ioCounts()).map(([key, value]) => [key, value - before[key]]))
async function filesUnder(directory) {
  if (!existsSync(directory)) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]
    )
  )
  return nested.flat().sort()
}
function assertFormalStageEmpty() {
  const directory = join(root, '.attachments-staging')
  assert.deepEqual(
    existsSync(directory) ? readdirSync(directory) : [],
    [],
    'formal compensation must finish before startup recovery'
  )
}
async function lateDocumentCase(action, image) {
  phase = 'reload-late-' + action
  const before = assetIdentity(store.snapshot())
  const owner = await js('window.fixture.snapshot().owner')
  const ids = await js('window.fixture.snapshot().assetIds')
  const held = gate(
    action === 'stage' ? 'writeFile' : action === 'preview' ? 'readFile' : 'release'
  )
  if (action === 'release') actionGate = held
  else ioGate = held
  const firstSequence = trace.length
  const call =
    action === 'stage'
      ? `window.draftApi.stage(${q(owner)}, ${q(image)})`
      : action === 'preview'
        ? `window.draftApi.preview(${q(owner)}, ${q(ids[0])})`
        : `window.draftApi.release(${q(owner)}, ${q(ids)})`
  await js(`void (${call}).catch(() => {}); true`)
  await until(() => held.captured, action + ' did not reach its owned held boundary')
  await reload()
  assert.deepEqual(
    await js('window.fixture.snapshot().owner'),
    owner,
    'resume must retain generation metadata'
  )
  release(held)
  const result = await until(
    () =>
      trace
        .slice(firstSequence)
        .find(
          (entry) => entry.event === 'ipc' && entry.action === action && entry.status !== 'pending'
        ),
    'old document operation did not settle'
  )
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'DRAFT_DOCUMENT_EXPIRED')
  assert.deepEqual(
    assetIdentity(store.snapshot()),
    before,
    'late old-document operation changed original asset records'
  )
  assert.equal(store.snapshot().pending, 0)
}
async function finish(error = null) {
  if (closing) return
  closing = true
  clearTimeout(businessTimer)
  for (const held of [...gates]) release(held)
  await lifecycle.finish({
    completed: !error,
    error,
    window,
    summary: { phase, startedAt, businessDeadline, sessionId, metrics, trace },
    restore: async () => {
      const cleanupErrors = []
      const cleanupStep = async (label, operation) => {
        try {
          await operation()
        } catch (failure) {
          cleanupErrors.push({ label, message: failure.stack || failure.message })
        }
      }
      for (const held of [...gates]) release(held)
      await Promise.allSettled([...invocations])
      await cleanupStep('renderer', async () => {
        if (window && !window.isDestroyed()) {
          metrics.cleanup.renderer = await window.webContents.executeJavaScript(
            'window.fixture?.dispose()'
          )
          if (metrics.cleanup.renderer) {
            assert.equal(metrics.cleanup.renderer.liveUrls, 0)
            assert.equal(metrics.cleanup.renderer.prototypeKeys, 0)
          }
        }
      })
      await cleanupStep('store', async () => {
        if (store) {
          await store.dispose()
          metrics.cleanup.remainingOwnedFiles = await filesUnder(assetRoot)
          assert.deepEqual(metrics.cleanup.remainingOwnedFiles, [])
          assert.equal(store.snapshot().pending, 0)
          if (committedFormal) {
            metrics.cleanup.formalSha256 = hash(readFileSync(committedFormal.path))
            assert.equal(
              metrics.cleanup.formalSha256,
              committedFormal.sha256,
              'dispose must retain formal attachment bytes'
            )
          }
        }
      })
      ipcMain.removeHandler('draft-prototype:invoke')
      metrics.cleanup.ipcRemoved = true
      await cleanupStep('server', async () => {
        if (server) {
          const ended = new Promise((done, reject) =>
            server.close((failure) => {
              record('server-close-callback', { sockets: sockets.size })
              if (failure) reject(failure)
              else done()
            })
          )
          const ownedSockets = [...sockets]
          metrics.cleanup.socketsBeforeDestroy = ownedSockets.map((socket) => ({
            destroyed: socket.destroyed,
            readableEnded: socket.readableEnded,
            writableFinished: socket.writableFinished
          }))
          // The server close callback can precede each Socket's close event.
          // Retain the zero-socket assertion and await those actual owned events.
          const socketClosures = ownedSockets.map(
            (socket) =>
              new Promise((done) =>
                socket.once('close', () => {
                  record('owned-socket-close', { remaining: sockets.size })
                  done()
                })
              )
          )
          for (const socket of ownedSockets) socket.destroy()
          await Promise.all([ended, ...socketClosures])
          metrics.cleanup.serverListening = server.listening
          metrics.cleanup.socketsAfterClose = sockets.size
          assert.equal(server.listening, false)
          assert.equal(sockets.size, 0)
        }
      })
      await cleanupStep('database', async () => {
        if (databaseOpen) {
          closeDatabase()
          databaseOpen = false
        }
      })
      await cleanupStep('logs', async () => {
        const logs = await flushLogs()
        assert.equal(logs.incomplete, false)
      })
      metrics.cleanup.gates = gates.size
      metrics.cleanup.invocations = invocations.size
      await cleanupStep('pending', async () => {
        assert.equal(gates.size, 0)
        assert.equal(invocations.size, 0)
      })
      metrics.cleanup.errors = cleanupErrors
      await cleanupStep('final-frame', prepareFinalEvidenceFrame)
      await cleanupStep('window-diagnostics', async () =>
        assert.deepEqual(diagnosticWriteErrors, [])
      )
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors.map((failure) => new Error(failure.label + ': ' + failure.message)),
          'Prototype cleanup incomplete'
        )
    }
  })
}
const businessTimer = setTimeout(
  () => void finish(new Error(phase + ': 75000ms business deadline exceeded')),
  75000
)

async function run() {
  initDatabase()
  databaseOpen = true
  store = createSessionDraftAssetStore({
    root: assetRoot,
    sessionId,
    isDocumentCurrent: isCurrent,
    io: {
      async open(...args) {
        const handle = await openFile(...args)
        // Observe the real per-file header write/flush separately from the
        // existing payload write port; no process-wide filesystem replacement.
        for (const method of ['writeFile', 'sync']) {
          const original = handle[method]
          Object.defineProperty(handle, method, {
            configurable: true,
            value: async function (...parameters) {
              const started = performance.now()
              const entry = {
                method,
                bytes: method === 'writeFile' ? parameters[0].byteLength : null
              }
              try {
                const result = await Reflect.apply(original, this, parameters)
                entry.success = true
                return result
              } catch (error) {
                entry.success = false
                entry.error = error.code || error.message
                throw error
              } finally {
                entry.ms = performance.now() - started
                metrics.headers.push(entry)
              }
            }
          })
        }
        return handle
      },
      writeFile: (...args) => observedIo('writeFile', writeFile, args),
      readFile: (...args) => observedIo('readFile', readFile, args)
    }
  })
  await startServer()
  registerIpc()
  window = new BrowserWindow({
    width: 900,
    height: 600,
    show: true,
    title: 'Isolated session draft asset prototype',
    webPreferences: {
      preload: join(fixtureRoot, 'preload.cjs'),
      additionalArguments: ['--prototype-session=' + sessionId],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  // The isolated fixture has no menu workflow. Remove Electron's default native
  // menu before navigation so its late installation cannot resize/letterbox the
  // subscribed surface relative to the renderer's CSS marker coordinates.
  window.removeMenu()
  observeWindowEvidence()
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, main) => {
    if (main && !inPlace) {
      currentDocument = null
      record('document-invalidated')
    }
  })
  window.webContents.on('did-navigate', (_event, url) => {
    currentDocument =
      url === fixtureUrl
        ? Object.freeze({
            generation: ++documentGeneration,
            url,
            webContentsId: window.webContents.id,
            processId: window.webContents.mainFrame.processId,
            routingId: window.webContents.mainFrame.routingId
          })
        : null
    record('document-committed', { generation: currentDocument?.generation, url })
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== fixtureUrl) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('console-message', (_event, level, message) =>
    record('renderer-console', { level, message: message.slice(0, 800) })
  )
  await window.loadURL(fixtureUrl)
  await ready()

  const pixels = randomBytes(576 * 576 * 4)
  for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255
  const png = nativeImage.createFromBitmap(pixels, { width: 576, height: 576 }).toPNG()
  assert.equal(nativeImage.createFromBuffer(png).isEmpty(), false)
  assert.ok(png.length > 700000 && png.length < 1500000)
  const image = {
    base64: png.toString('base64'),
    ext: 'png',
    name: 'shared-valid-random.png',
    size: png.length
  }
  metrics.source = {
    bytes: png.length,
    sha256: hash(png),
    width: 576,
    height: 576,
    sameBothArms: true
  }
  const smokeOnly = process.env.ABANDON_DRAFT_PROTOTYPE_SMOKE_ONLY === '1'
  metrics.smokeOnly = smokeOnly

  phase = 'legacy-smoke-and-20-watchers'
  await js(`window.fixture.legacy(${q(image)})`)
  metrics.arms.legacySmoke = await js('window.fixture.runInputs(1, "legacy-smoke")')
  assertInputs(metrics.arms.legacySmoke, 1, 'legacy-smoke-1')
  const writesBeforeA = metrics.writes.length,
    readsBeforeA = metrics.reads.length
  if (!smokeOnly) {
    const beforeLegacyLoop = ioCounts()
    metrics.arms.legacy = await js('window.fixture.runInputs(20, "legacy-input")')
    assertInputs(metrics.arms.legacy, 20, 'legacy-input-20')
    assert.equal(metrics.writes.length, writesBeforeA)
    assert.equal(metrics.reads.length, readsBeforeA)
    metrics.arms.legacyLoopIo = ioDelta(beforeLegacyLoop)
    assert.deepEqual(metrics.arms.legacyLoopIo, { writes: 0, reads: 0, stageIpc: 0, previewIpc: 0 })
  }
  const persistedLegacyImage = await js(
    'JSON.parse(window.fixture.snapshot().stored).data.images[0]'
  )
  metrics.arms.legacyImageSha256 = hash(Buffer.from(persistedLegacyImage.base64, 'base64'))
  assert.equal(
    metrics.arms.legacyImageSha256,
    hash(png),
    'legacy arm must serialize the same actual PNG'
  )

  phase = 'asset-stage-smoke-and-20-watchers'
  metrics.initialStage = await js(`window.fixture.asset(${q(image)})`)
  assert.equal(metrics.initialStage.asset.sha256, hash(png))
  assert.equal(metrics.initialStage.asset.size, png.length)
  assert.equal(
    metrics.writes.length,
    writesBeforeA + 1,
    'one payload write; ownership header IO is separate'
  )
  assert.equal(metrics.headers.filter((entry) => entry.method === 'writeFile').length, 1)
  assert.equal(metrics.headers.filter((entry) => entry.method === 'sync').length, 1)
  assert.equal(metrics.headers.find((entry) => entry.method === 'writeFile').bytes, 512)
  metrics.arms.assetSmoke = await js('window.fixture.runInputs(1, "asset-smoke")')
  assertInputs(metrics.arms.assetSmoke, 1, 'asset-smoke-1')
  if (smokeOnly) {
    phase = 'smoke-only-complete-no-20-input-claim'
    await finish()
    return
  }
  const writesBeforeB = metrics.writes.length,
    readsBeforeB = metrics.reads.length
  const beforeAssetLoop = ioCounts()
  metrics.arms.asset = await js('window.fixture.runInputs(20, "asset-input")')
  assertInputs(metrics.arms.asset, 20, 'asset-input-20')
  assert.equal(metrics.writes.length, writesBeforeB, 'text loop must not stage again')
  assert.equal(metrics.reads.length, readsBeforeB, 'text loop must not read originals')
  metrics.arms.assetLoopIo = ioDelta(beforeAssetLoop)
  assert.deepEqual(metrics.arms.assetLoopIo, { writes: 0, reads: 0, stageIpc: 0, previewIpc: 0 })
  assert.ok(metrics.arms.legacy.stringify.every((entry) => entry.utf8Bytes > png.length))
  assert.ok(metrics.arms.asset.stringify.every((entry) => entry.utf8Bytes < 4096))
  let saved = await js('window.fixture.snapshot()')
  assert.equal(saved.stored.includes('capability'), false)
  assert.equal(saved.stored.includes(image.base64.slice(0, 64)), false)
  assert.deepEqual(JSON.parse(saved.stored).data.assetIds, [metrics.initialStage.asset.assetId])

  phase = 'blob-preview-revoke'
  metrics.preview = await js('window.fixture.preview()')
  assert.equal(metrics.preview.size, png.length)
  assert.equal(metrics.preview.sha256, hash(png))
  assert.equal(metrics.preview.width, 576)
  assert.equal(metrics.preview.liveUrls, 1)
  await js('window.fixture.closePreview()')
  saved = await js('window.fixture.snapshot()')
  assert.equal(saved.liveUrls, 0)
  assert.deepEqual(
    saved.urlEvents.map((event) => event.action),
    ['create', 'revoke']
  )

  phase = 'lease-and-resume-negative-probes'
  const stableAssets = assetIdentity(store.snapshot())
  for (const field of ['sessionId', 'ownerId', 'generation', 'capability']) {
    const result = await js(
      `window.draftApi.invalidLeaseProbe(window.fixture.snapshot().owner, ${q(field)}, window.fixture.snapshot().assetIds[0])`
    )
    assert.equal(result.code, 'DRAFT_LEASE_INVALID')
    assert.deepEqual(assetIdentity(store.snapshot()), stableAssets)
  }
  const owner = saved.owner
  for (const patch of [
    { sessionId: 'wrong-session' },
    { ownerId: 'wrong-owner' },
    { generation: owner.generation + 1 }
  ]) {
    const result = await js(
      `window.draftApi.invalidResumeProbe('prototype:asset', ${q({ ...owner, ...patch })})`
    )
    assert.equal(result.code, 'DRAFT_OWNER_RESUME_INVALID')
    assert.deepEqual(assetIdentity(store.snapshot()), stableAssets)
  }

  phase = 'actual-storage-quota'
  metrics.quota = await js('window.fixture.quota()')
  assert.equal(metrics.quota.oversizeProbe.name, 'QuotaExceededError')
  assert.equal(metrics.quota.nativeQuotaBytes, 100 * 1024 * 1024)
  assert.equal(metrics.quota.headroomBytes, 512 * 1024)
  metrics.quota.basis = {
    electron: process.versions.electron,
    source:
      'https://github.com/electron/electron/blob/v43.4.0/patches/chromium/dom_storage_limits.patch'
  }
  assert.equal(metrics.quota.storage.length, 1)
  assert.equal(metrics.quota.storage[0].success, false)
  assert.equal(metrics.quota.storage[0].error.name, 'QuotaExceededError')
  assert.ok(metrics.quota.storage[0].utf16Bytes > 0)
  assert.equal(metrics.quota.preserved, true)
  assert.equal(metrics.quota.previousValue, 'asset-input-20')
  metrics.quota.comparisonExcluded =
    'failure experiment is separate from the successful 20/20 A/B arms'

  phase = 'same-startup-reload-resume'
  await reload()
  saved = await js('window.fixture.snapshot()')
  assert.equal(saved.content, 'asset-input-20')
  assert.deepEqual(saved.owner, owner)
  assert.deepEqual(assetIdentity(store.snapshot()), stableAssets)
  for (const action of ['stage', 'preview', 'release']) await lateDocumentCase(action, image)

  phase = 'cancel-interleaves-held-stage'
  const cancelOwner = await js("window.draftApi.openOwner('prototype:cancel-held')")
  const cancelledBefore = assetIdentity(store.snapshot())
  const heldCancel = gate('writeFile')
  ioGate = heldCancel
  const cancelSequence = trace.length
  await js(`void window.draftApi.stage(${q(cancelOwner)}, ${q(image)}).catch(() => {}); true`)
  await until(() => heldCancel.captured, 'cancel stage did not enter owned write')
  await js(`void window.draftApi.cancelOwner(${q(cancelOwner)}).catch(() => {}); true`)
  await until(
    () => trace.slice(cancelSequence).some((entry) => entry.action === 'cancel'),
    'cancel command did not enter'
  )
  release(heldCancel)
  const cancelledStage = await until(
    () =>
      trace
        .slice(cancelSequence)
        .find((entry) => entry.action === 'stage' && entry.status !== 'pending'),
    'cancelled stage did not settle'
  )
  assert.equal(cancelledStage.status, 'rejected')
  await until(
    () =>
      trace
        .slice(cancelSequence)
        .some((entry) => entry.action === 'cancel' && entry.status === 'fulfilled'),
    'cancel did not drain its write'
  )
  assert.deepEqual(assetIdentity(store.snapshot()), cancelledBefore)
  assert.equal(store.snapshot().pending, 0)

  phase = 'pinned-handoff-reload-failure-retains-draft'
  handoffNoteId = createNote({ content: 'actual isolated prototype handoff target' }).id
  getDb().exec(
    "CREATE TRIGGER prototype_reject_attachment BEFORE INSERT ON note_attachments BEGIN SELECT RAISE(ABORT, 'prototype actual handoff SQL failure'); END"
  )
  const pinnedBefore = assetIdentity(store.snapshot())
  const heldConsumer = gate('consumer')
  consumerGate = heldConsumer
  const failedOperation = await js('window.fixture.beginHandoff()')
  await until(() => heldConsumer.captured, 'handoff did not pin before consumer')
  assert.equal(store.snapshot().assets[0].pins, 1)
  assert.equal((await js(`window.fixture.operation(${q(failedOperation)})`)).status, 'pending')
  await reload()
  assert.equal((await js(`window.fixture.operation(${q(failedOperation)})`)).status, 'pending')
  release(heldConsumer)
  const failedHandoff = await js(
    `window.fixture.waitHandoff(${q(failedOperation)}).then(() => ({ok:true}), error => ({message:error.message}))`
  )
  const publicSqlFailure = {
    code: 'SQLITE_CONSTRAINT_TRIGGER',
    message: '草稿附件提交未完成，请保留草稿后重试'
  }
  assert.equal(failedHandoff.message, publicSqlFailure.message)
  const failedPublicState = await js(`window.fixture.operation(${q(failedOperation)})`)
  assert.equal(failedPublicState.status, 'failed')
  assert.deepEqual(failedPublicState.error, publicSqlFailure)
  const failedMainWait = trace.find(
    (entry) =>
      entry.event === 'ipc' && entry.action === 'wait' && entry.operationId === failedOperation
  )
  assert.equal(failedMainWait.status, 'rejected')
  assert.equal(failedMainWait.code, 'SQLITE_CONSTRAINT_TRIGGER')
  assert.match(failedMainWait.message, /prototype actual handoff SQL failure/)
  assert.deepEqual(failedMainWait.publicError, publicSqlFailure)
  assert.match(metrics.handoffs[0].error, /prototype actual handoff SQL failure/)
  assert.match(
    store.snapshot().operations.find((operation) => operation.operationId === failedOperation).error
      .message,
    /prototype actual handoff SQL failure/
  )
  metrics.publicSqlFailure = { waitMessage: failedHandoff.message, operation: failedPublicState }
  assert.deepEqual(assetIdentity(store.snapshot()), pinnedBefore)
  assert.equal(getNoteById(handoffNoteId).attachments.length, 0)
  const failedFormalDirectory = join(root, 'attachments', 'images', String(handoffNoteId))
  assert.deepEqual(existsSync(failedFormalDirectory) ? readdirSync(failedFormalDirectory) : [], [])
  assertFormalStageEmpty()
  assert.equal((await js('window.fixture.snapshot()')).content, 'asset-input-20')
  assert.ok((await js('window.fixture.snapshot()')).stored)

  phase = 'explicit-handoff-retry-preserves-formal-attachment'
  getDb().exec('DROP TRIGGER prototype_reject_attachment')
  const retryOperation = await js('window.fixture.beginHandoff()')
  const committedRows = await js(`window.fixture.waitHandoff(${q(retryOperation)})`)
  assert.equal(committedRows.length, 1)
  assert.equal((await js(`window.fixture.operation(${q(retryOperation)})`)).status, 'committed')
  const formal = getNoteById(handoffNoteId).attachments
  assert.equal(formal.length, 1)
  const formalPath = resolveImagePath(formal[0].file_path)
  assert.equal(hash(readFileSync(formalPath)), hash(png))
  assert.equal(formal[0].file_size, png.length)
  committedFormal = { path: formalPath, sha256: hash(png) }
  assert.equal(store.snapshot().assetCount, 0)
  assert.equal((await js('window.fixture.snapshot()')).stored, null)
  assertFormalStageEmpty()
  assert.equal(metrics.handoffs.length, 2)
  for (const attempt of metrics.handoffs) {
    assert.equal(attempt.reads.length, 1)
    assert.equal(attempt.transcodes.length, 1)
    assert.ok(attempt.preflightAndFormalStageMs >= 0)
    assert.ok(attempt.sqlAndRenameMs >= 0)
    assert.ok(attempt.postTransactionCleanupMs >= 0)
  }

  phase = 'clear-interleaves-held-stage'
  const clearOwner = await js("window.draftApi.openOwner('prototype:clear-held')")
  const heldClear = gate('writeFile')
  ioGate = heldClear
  const clearSequence = trace.length
  await js(`void window.draftApi.stage(${q(clearOwner)}, ${q(image)}).catch(() => {}); true`)
  await until(() => heldClear.captured, 'clear stage did not enter write')
  const clearing = store.clear()
  const clearOutcome = clearing.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  release(heldClear)
  const clearedStage = await until(
    () =>
      trace
        .slice(clearSequence)
        .find((entry) => entry.action === 'stage' && entry.status !== 'pending'),
    'cleared stage did not settle'
  )
  assert.equal(clearedStage.status, 'rejected')
  const clearResult = await clearOutcome
  assert.ifError(clearResult.error)
  assert.equal(clearResult.value, true)
  assert.equal(store.snapshot().assetCount, 0)
  assert.equal(store.snapshot().pending, 0)
  assert.deepEqual(await filesUnder(assetRoot), [])
  assert.equal(
    hash(readFileSync(formalPath)),
    hash(png),
    'draft clear must retain committed formal bytes'
  )
  metrics.final = {
    formalAttachments: formal.length,
    formalSha256: hash(readFileSync(formalPath)),
    store: store.snapshot(),
    documentGenerations: documentGeneration
  }
  phase = 'complete'
  await finish()
}

void app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error)
    void finish(error)
  })
