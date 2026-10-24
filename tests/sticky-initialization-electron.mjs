import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import {
  countDesktopStickyRecords,
  deleteAllDesktopStickyRecords,
  deleteDesktopStickyRecord,
  hasDesktopStickyRecord,
  insertDesktopStickyRecord,
  listDesktopStickyRecords,
  updateDesktopStickyRecord
} from '../src/main/db/db-desktop-stickies.js'
import { getNoteById } from '../src/main/db/db-notes.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { flushLogs } from '../src/main/logging/logger.js'
import { ElectronStickyService } from '../src/main/sticky/ElectronStickyService.js'
import {
  STICKY_BOUNDS_PERSIST_DELAY_MS,
  STICKY_READY_TIMEOUT_MS
} from '../src/main/sticky/stickyConstants.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const suite = 'tests/sticky-initialization-electron.mjs'
const mode = 'electron-ready-controlled-load-sqlite-real-sticky-initialization'
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = prepareTestProfile({ prefix: 'abandon-sticky-initialization-' })
const fallbackEvidenceRoot = join(workspaceRoot, 'tmp', 'sticky-initialization-electron')
if (!process.env.ABANDON_TEST_EVIDENCE_DIR) mkdirSync(fallbackEvidenceRoot, { recursive: true })
const evidenceRoot = process.env.ABANDON_TEST_EVIDENCE_DIR
  ? realpathSync(process.env.ABANDON_TEST_EVIDENCE_DIR)
  : mkdtempSync(join(fallbackEvidenceRoot, 'attempt-'))
const recorder = createAssertionRecorder({
  suite,
  mode,
  metadata: {
    sqlite: 'real-disk-isolated-profile',
    windows: 'real-BrowserWindow-with-visible-presentation',
    ipc: 'real-sandboxed-preload-get-state-and-ready',
    fixture: 'minimal-service-renderer-fills-body-and-appearance-before-ready',
    loadControl: 'HTTP-image-response-held-until-explicit-release-or-window-destruction',
    lateContinuation: 'retained-main-continuation-only; destroyed-renderer-IPC-is-not-simulated',
    productShutdownCovered: false,
    exitScope: 'isolated-service-dispose-and-normal-fixture-app-quit',
    hangOwner: 'runner-external-diagnostics-before-owned-process-cleanup'
  }
})
const { assert } = recorder
const phaseChannel = 'sticky-initialization:phase'
const repeatChannel = 'sticky-initialization:repeat-ready'
const startedAt = Date.now()
const phases = []
const windows = new Map()
const contexts = new Set()
const heldResponses = new Map()
const requestedImages = new Set()
const sockets = new Set()
const socketCloseWaiters = new Set()
const scenarios = []
const artifacts = ['source-hashes.json', 'runtime.json', 'events.jsonl', 'business-result.json']
const noteContent = '真实便利贴初始化：正文已就绪，图片尾段仍在加载。'
let database = null
let server = null
let baseUrl = null
let serverClosing = false
let noteId = null
let businessCompleted = false
let failure = null
let exitCode = 0
let reachedWillQuit = false
let cleanup = { status: 'failed', reason: 'Fixture cleanup has not run' }
let evidence = { status: 'incomplete' }

function errorDetails(error, depth = 0) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message || String(error),
    stack: error?.stack,
    committed: error?.committed === true,
    stickyId: error?.stickyId || null,
    cleanupIncomplete: Boolean(error?.cleanupIncomplete || error?.cleanupError),
    cleanupError: error?.cleanupError || null,
    ...(error?.cause && error.cause !== error && depth < 3
      ? { cause: errorDetails(error.cause, depth + 1) }
      : {})
  }
}

function record(event, details = {}) {
  const value = {
    time: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    pid: process.pid,
    event,
    ...details
  }
  appendFileSync(join(evidenceRoot, 'events.jsonl'), JSON.stringify(value) + '\n')
  console.log(JSON.stringify(value))
  return value
}

function writeJson(name, value) {
  writeFileSync(join(evidenceRoot, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

async function waitUntil(read, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await wait(20)
  }
  throw new Error(description)
}

function windowInfo(entry) {
  const value = [...windows.values()].find(
    (candidate) => candidate.webContentsId === entry.webContentsId
  )
  if (!value) throw new Error('The real sticky window was not observed')
  return value
}

function entrySnapshot(entry) {
  const destroyed = entry.window.isDestroyed()
  return {
    id: entry.id,
    webContentsId: entry.webContentsId,
    initializationState: entry.initialization?.state,
    initializationDeadline: entry.initialization?.deadline,
    initializationError: entry.initialization?.error
      ? errorDetails(entry.initialization.error)
      : null,
    ready: entry.ready,
    persisted: entry.persisted,
    readyTimerCleared: entry.readyTimer == null,
    boundsTimerCleared: entry.boundsPersistTimer == null,
    destroyed,
    visible: destroyed ? false : entry.window.isVisible(),
    loadFinished: windowInfo(entry).didFinishLoad,
    showEvents: windowInfo(entry).showEvents,
    loadFailures: windowInfo(entry).loadFailures
  }
}

app.setPath('userData', profile.directory)
app.on('window-all-closed', () => {})
app.on('browser-window-created', (_event, window) => {
  const information = {
    window,
    id: window.id,
    webContentsId: window.webContents.id,
    showEvents: 0,
    didFinishLoad: false,
    loadFailures: []
  }
  windows.set(window.id, information)
  record('window-created', { windowId: window.id, webContentsId: information.webContentsId })
  window.on('show', () => {
    information.showEvents += 1
    record('window-show', { windowId: window.id, visible: window.isVisible() })
  })
  window.once('closed', () => record('window-closed', { windowId: information.id }))
  window.webContents.on('dom-ready', () => record('dom-ready', { windowId: information.id }))
  window.webContents.on('did-finish-load', () => {
    information.didFinishLoad = true
    record('did-finish-load', { windowId: information.id })
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    const value = { code, description, url, isMainFrame }
    information.loadFailures.push(value)
    record('did-fail-load', { windowId: information.id, ...value })
  })
  window.webContents.once('destroyed', () =>
    record('web-contents-destroyed', { windowId: information.id })
  )
})

function onFixturePhase(event, payload) {
  const information = [...windows.values()].find(
    (candidate) => candidate.webContentsId === event.sender.id
  )
  if (!information || !payload || typeof payload.phase !== 'string') {
    record('unrecognized-fixture-message', { webContentsId: event.sender.id })
    return
  }
  const value = {
    ...payload,
    windowId: information.id,
    webContentsId: information.webContentsId
  }
  phases.push(value)
  record('renderer-phase', value)
}

function waitPhase(entry, phase) {
  return waitUntil(
    () =>
      phases.find(
        (candidate) => candidate.webContentsId === entry.webContentsId && candidate.phase === phase
      ),
    'Fixture did not report ' + phase + ' for ' + entry.id
  )
}

async function startServer() {
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
    'base64'
  )
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const caseId = url.searchParams.get('case')
    response.on('error', (error) =>
      record('fixture-response-error', { caseId, ...errorDetails(error) })
    )
    if (url.pathname === '/held.png') {
      requestedImages.add(caseId)
      heldResponses.set(caseId, { response, pixel })
      response.once('close', () => {
        if (heldResponses.get(caseId)?.response === response) heldResponses.delete(caseId)
        record('held-resource-closed', { caseId })
      })
      record('held-resource-requested', { caseId })
      return
    }
    if (url.pathname === '/failed.html') {
      record('main-resource-failure-injected', { caseId, method: 'truncated-HTTP-body' })
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': '65536',
        'cache-control': 'no-store'
      })
      response.flushHeaders()
      response.write('<')
      response.socket.destroy()
      return
    }
    if (url.pathname !== '/sticky.html') {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    })
    response.end(`<!doctype html><html><head><meta charset="utf-8">
      <title>Isolated sticky initialization fixture</title>
      <style>html,body{margin:0;min-height:100%;}body{box-sizing:border-box;padding:22px;
      font-family:"Segoe UI",sans-serif;overflow:hidden;}[data-content]{white-space:pre-wrap;
      line-height:1.5;}[data-palette]{display:flex;gap:5px;margin-top:22px;}
      [data-palette] span{width:15px;height:15px;display:block;}</style></head><body>
      <div data-content></div><div data-palette></div>
      <img alt="Controlled load tail" width="1" height="1" src="/held.png?case=${encodeURIComponent(caseId)}">
      </body></html>`)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    let resolveClosed
    const closed = new Promise((resolveSocketClosed) => {
      resolveClosed = resolveSocketClosed
    })
    socketCloseWaiters.add(closed)
    socket.once('close', () => {
      sockets.delete(socket)
      socketCloseWaiters.delete(closed)
      resolveClosed()
    })
    if (serverClosing) socket.destroy()
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  baseUrl = 'http://127.0.0.1:' + server.address().port
  record('fixture-server-listening', { baseUrl })
}

function rendererUrl(caseId, rendererMode = 'early-ready', path = '/sticky.html') {
  return `${baseUrl}${path}?case=${encodeURIComponent(caseId)}&mode=${rendererMode}`
}

async function assertHeldLoad(entry, caseId) {
  await waitUntil(
    () => heldResponses.has(caseId),
    'The controlled image request did not remain held for ' + caseId
  )
  assert.equal(requestedImages.has(caseId), true)
  assert.equal(windowInfo(entry).didFinishLoad, false, 'The real page load must remain incomplete')
  assert.equal(entry.window.webContents.isLoading(), true)
}

function releaseImage(caseId) {
  const resource = heldResponses.get(caseId)
  if (!resource) throw new Error('No held image response for ' + caseId)
  record('held-resource-released', { caseId })
  resource.response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
  resource.response.end(resource.pixel)
}

function auditWrites() {
  return database.prepare('SELECT * FROM sticky_initialization_writes ORDER BY sequence').all()
}

function createContext(caseId, rendererMode, path) {
  const admission = createBusinessMutationAdmission()
  const context = {
    caseId,
    admission,
    service: null,
    entries: [],
    insertCalls: 0,
    updateCalls: 0,
    lastWriteAt: 0,
    errors: [],
    disposed: false
  }
  const mutate =
    (name, operation) =>
    (...args) =>
      admission.run(() => {
        if (name === 'insert') context.insertCalls += 1
        if (name === 'update') context.updateCalls += 1
        context.lastWriteAt = Date.now()
        record('repository-command', { caseId, name, stickyId: args[0]?.id || args[0] || null })
        return operation(...args)
      })
  context.service = new ElectronStickyService({
    getMainWindow: () => null,
    getNoteById,
    getDefaultAppearance: () => ({
      fontSize: 16,
      backgroundColor: '#FFF2A8',
      cornerRadius: 0,
      alwaysOnTop: false
    }),
    preloadPath: join(workspaceRoot, 'tests', 'fixtures', 'sticky-initialization', 'preload.cjs'),
    rendererUrl: rendererUrl(caseId, rendererMode, path),
    stickyRepository: {
      list: listDesktopStickyRecords,
      count: countDesktopStickyRecords,
      exists: hasDesktopStickyRecord,
      insert: mutate('insert', insertDesktopStickyRecord),
      update: mutate('update', updateDesktopStickyRecord),
      delete: mutate('delete', deleteDesktopStickyRecord),
      deleteAll: mutate('deleteAll', deleteAllDesktopStickyRecords)
    },
    runMutation: admission.run,
    bindMutationContinuation: admission.bindContinuation,
    onError: (message) => {
      context.errors.push(message)
      record('service-error', { caseId, message })
    }
  })
  contexts.add(context)
  context.service.initialize()
  return context
}

function beginCreation(context) {
  const creationStartedAt = Date.now()
  const creation = context.admission.run(() => context.service.create({ noteId }))
  const entry = [...context.service.registry.values()].at(-1)
  assert.ok(entry, 'Creation must synchronously register its real window before waiting')
  context.entries.push(entry)
  const outcome = Promise.resolve(creation).then(
    (value) => {
      const result = { ok: true, value, elapsedMs: Date.now() - creationStartedAt }
      record('creation-settled', { caseId: context.caseId, ...result, entry: entrySnapshot(entry) })
      return result
    },
    (error) => {
      const result = {
        ok: false,
        error: errorDetails(error),
        elapsedMs: Date.now() - creationStartedAt
      }
      record('creation-settled', { caseId: context.caseId, ...result, entry: entrySnapshot(entry) })
      return result
    }
  )
  return { entry, outcome, creationStartedAt, queuedContinuation: entry.completeReady }
}

async function assertDrained(context) {
  let finished = false
  await context.admission.drain().then(() => {
    finished = true
  })
  assert.equal(finished, true, 'The existing business admission drain must finish')
  assert.equal(context.admission.snapshot().pending, 0)
  record('business-admission-drained', { caseId: context.caseId, ...context.admission.snapshot() })
}

async function finishContext(context) {
  context.service.dispose()
  context.disposed = true
  await assertDrained(context)
  assert.equal(context.service.registry.size, 0)
  assert.equal(context.service.byWebContentsId.size, 0)
  assert.ok(context.entries.every((entry) => entry.window.isDestroyed()))
  assert.ok(context.entries.every((entry) => entry.readyTimer == null))
  assert.ok(context.entries.every((entry) => entry.boundsPersistTimer == null))
  record('scenario-service-disposed', { caseId: context.caseId })
}

async function assertInertQueuedContinuation(context, creation) {
  const before = {
    writes: auditWrites().length,
    insertCalls: context.insertCalls,
    updateCalls: context.updateCalls,
    shows: windowInfo(creation.entry).showEvents
  }
  // This is a retained main-process callback, not an IPC from the destroyed renderer.
  const value = creation.queuedContinuation()
  assert.equal(value, false)
  await Promise.resolve()
  assert.deepEqual(
    {
      writes: auditWrites().length,
      insertCalls: context.insertCalls,
      updateCalls: context.updateCalls,
      shows: windowInfo(creation.entry).showEvents
    },
    before,
    'An invalidated queued main continuation must not persist or present a window'
  )
  assert.equal(creation.entry.window.isDestroyed(), true)
  record('late-main-queued-continuation', {
    caseId: context.caseId,
    transport: 'direct-retained-main-callback; no-renderer-IPC',
    value,
    entry: entrySnapshot(creation.entry),
    ...before
  })
}

async function scenario(name, operation) {
  const result = { name, status: 'running', startedAt: new Date().toISOString() }
  scenarios.push(result)
  record('scenario-start', { name })
  try {
    result.details = await operation()
    result.status = 'passed'
    record('scenario-passed', { name, details: result.details })
  } catch (error) {
    result.status = 'failed'
    result.error = errorDetails(error)
    record('scenario-failed', { name, error: result.error })
    throw error
  } finally {
    result.finishedAt = new Date().toISOString()
  }
}

function assertFailedEntry(context, creation, expectedState) {
  const snapshot = entrySnapshot(creation.entry)
  assert.equal(snapshot.initializationState, expectedState)
  assert.equal(snapshot.destroyed, true)
  assert.equal(snapshot.ready, false)
  assert.equal(snapshot.readyTimerCleared, true)
  assert.equal(snapshot.boundsTimerCleared, true)
  assert.equal(snapshot.showEvents, 0)
  assert.equal(context.service.registry.size, 0)
  assert.equal(context.service.byWebContentsId.size, 0)
  return snapshot
}

function assertOriginalDeadline(creation, outcome) {
  assert.equal(STICKY_READY_TIMEOUT_MS, 5000)
  assert.ok(outcome.elapsedMs >= STICKY_READY_TIMEOUT_MS - 100, 'The timeout must not fire early')
  assert.ok(
    outcome.elapsedMs <= STICKY_READY_TIMEOUT_MS + 1500,
    'A held page load must not extend the original five-second initialization deadline'
  )
  assert.ok(Number.isFinite(creation.entry.initialization?.deadline))
}

async function runScenarios() {
  await scenario('ready-before-load-and-duplicate-ready', async () => {
    const context = createContext('early-ready', 'early-ready')
    const creation = beginCreation(context)
    const rendered = await waitPhase(creation.entry, 'state-filled')
    const outcome = await creation.outcome
    const ready = await waitPhase(creation.entry, 'ready-result')
    assert.equal(outcome.ok, true)
    assert.equal(ready.ok, true)
    assert.equal(ready.value, true)
    assert.equal(rendered.renderedContent, noteContent)
    assert.equal(rendered.paletteSize, 8)
    assert.equal(rendered.fontSize, '16px')
    assert.equal(rendered.stateId, creation.entry.id)
    await assertHeldLoad(creation.entry, 'early-ready')
    assert.ok(outcome.elapsedMs < STICKY_READY_TIMEOUT_MS)
    assert.equal(creation.entry.initialization?.state, 'succeeded')
    assert.equal(creation.entry.window.isVisible(), true, 'The actual sticky must be visible')
    assert.ok(windowInfo(creation.entry).showEvents >= 1)
    assert.ok(creation.entry.window.getNativeWindowHandle().some((value) => value !== 0))
    assert.equal(countDesktopStickyRecords(), 1)
    assert.equal(listDesktopStickyRecords()[0].content, noteContent)
    await assertDrained(context)
    // Wait for real OS geometry/debounce writes to become quiet before isolating a duplicate ready.
    await waitUntil(
      () => Date.now() - context.lastWriteAt >= STICKY_BOUNDS_PERSIST_DELAY_MS + 100,
      'Real sticky bounds writes did not become quiet'
    )
    const writesBeforeDuplicate = auditWrites()
    const insertsBeforeDuplicate = context.insertCalls
    const updatesBeforeDuplicate = context.updateCalls
    creation.entry.window.webContents.send(repeatChannel, { caseId: 'early-ready' })
    const duplicate = await waitPhase(creation.entry, 'duplicate-ready-result')
    assert.equal(duplicate.ok, true)
    assert.equal(duplicate.value, true)
    assert.deepEqual(
      auditWrites(),
      writesBeforeDuplicate,
      'Duplicate real ready IPC must not write'
    )
    assert.equal(context.insertCalls, insertsBeforeDuplicate)
    assert.equal(context.updateCalls, updatesBeforeDuplicate)
    assert.equal(context.insertCalls, 1)
    assert.equal(countDesktopStickyRecords(), 1)
    assert.equal(creation.entry.window.isVisible(), true)
    await assertHeldLoad(creation.entry, 'early-ready')
    const image = await creation.entry.window.webContents.capturePage()
    const pixels = image.toBitmap()
    const png = image.toPNG()
    assert.equal(image.isEmpty(), false)
    assert.ok(image.getSize().width >= 180 && image.getSize().height >= 140)
    assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 0))
    const screenshot = 'early-ready-visible.png'
    writeFileSync(join(evidenceRoot, screenshot), png, { flag: 'wx' })
    artifacts.push(screenshot)
    const beforeRelease = entrySnapshot(creation.entry)
    record('visible-before-load-tail-release', {
      entry: beforeRelease,
      screenshot,
      screenshotSha256: createHash('sha256').update(png).digest('hex')
    })
    releaseImage('early-ready')
    await waitUntil(
      () => windowInfo(creation.entry).didFinishLoad,
      'Released load tail did not finish'
    )
    assert.equal(creation.entry.initialization?.state, 'succeeded')
    assert.equal(countDesktopStickyRecords(), 1)
    await finishContext(context)
    deleteAllDesktopStickyRecords()
    return { outcome, ready, duplicate, rendered, beforeRelease, screenshot }
  })

  await scenario('never-ready-held-load-original-deadline', async () => {
    const context = createContext('never-ready', 'never-ready')
    const creation = beginCreation(context)
    await waitPhase(creation.entry, 'state-filled')
    await assertHeldLoad(creation.entry, 'never-ready')
    assert.equal(context.admission.snapshot().pending, 1)
    assert.equal(countDesktopStickyRecords(), 0)
    assert.equal(creation.entry.window.isVisible(), false)
    // Intentionally await the real service promise; a regression is diagnosed by the external runner.
    const outcome = await creation.outcome
    assert.equal(outcome.ok, false)
    assertOriginalDeadline(creation, outcome)
    const terminal = assertFailedEntry(context, creation, 'failed')
    assert.equal(countDesktopStickyRecords(), 0)
    await assertDrained(context)
    await assertInertQueuedContinuation(context, creation)
    assert.equal(countDesktopStickyRecords(), 0)
    await finishContext(context)
    return { outcome, terminal, realLateRendererIpc: 'not-possible-after-window-destruction' }
  })

  await scenario('close-before-ready-settles-immediately', async () => {
    const context = createContext('close-before-ready', 'never-ready')
    const creation = beginCreation(context)
    await waitPhase(creation.entry, 'state-filled')
    await assertHeldLoad(creation.entry, 'close-before-ready')
    const closedAt = Date.now()
    creation.entry.window.close()
    const outcome = await creation.outcome
    const afterCloseMs = Date.now() - closedAt
    assert.equal(outcome.ok, false)
    assert.ok(
      afterCloseMs < 1000,
      'Closing a pending sticky must end creation without waiting for ready'
    )
    assert.ok(Date.now() < creation.entry.initialization.deadline)
    const terminal = assertFailedEntry(context, creation, 'cancelled')
    assert.equal(countDesktopStickyRecords(), 0)
    await assertDrained(context)
    await assertInertQueuedContinuation(context, creation)
    await finishContext(context)
    return { outcome, afterCloseMs, terminal }
  })

  await scenario('restore-timeout-preserves-existing-record', async () => {
    const display = screen.getPrimaryDisplay()
    const timestamp = Date.now()
    insertDesktopStickyRecord({
      id: 'sticky-existing-timeout-record',
      noteId,
      content: noteContent,
      bounds: { x: display.workArea.x + 30, y: display.workArea.y + 30, width: 280, height: 260 },
      displayId: display.id,
      workArea: { ...display.workArea },
      fontSize: 16,
      backgroundColor: '#FFF2A8',
      cornerRadius: 0,
      pinned: false,
      createdAt: timestamp,
      updatedAt: timestamp
    })
    const before = listDesktopStickyRecords()
    const writesBefore = auditWrites()
    const context = createContext('restore-timeout', 'never-ready')
    const restoreStartedAt = Date.now()
    const restoration = context.admission.run(() =>
      context.service.restoreMissing({ source: 'formal-initialization-timeout-test' })
    )
    const entry = context.service.registry.get(before[0].id)
    assert.ok(entry)
    context.entries.push(entry)
    const creation = { entry, queuedContinuation: entry.completeReady }
    await waitPhase(entry, 'state-filled')
    await assertHeldLoad(entry, 'restore-timeout')
    assert.equal(await restoration, 0)
    const outcome = { elapsedMs: Date.now() - restoreStartedAt }
    assertOriginalDeadline(creation, outcome)
    const terminal = assertFailedEntry(context, creation, 'failed')
    assert.deepEqual(
      listDesktopStickyRecords(),
      before,
      'A failed restore must retain its saved row'
    )
    assert.deepEqual(auditWrites(), writesBefore)
    assert.equal(context.insertCalls, 0)
    assert.ok(context.errors.some((message) => message.includes('恢复失败')))
    await assertDrained(context)
    await assertInertQueuedContinuation(context, creation)
    await finishContext(context)
    assert.deepEqual(listDesktopStickyRecords(), before)
    deleteAllDesktopStickyRecords()
    return { outcome, terminal, savedRecord: before[0] }
  })

  await scenario('main-load-failure-then-successful-next-create', async () => {
    const context = createContext('load-failure', 'never-ready', '/failed.html')
    const failed = beginCreation(context)
    const firstOutcome = await failed.outcome
    assert.equal(firstOutcome.ok, false)
    assert.match(firstOutcome.error.message, /加载失败/)
    const firstTerminal = assertFailedEntry(context, failed, 'failed')
    assert.ok(firstTerminal.loadFailures.some((value) => value.isMainFrame))
    assert.equal(countDesktopStickyRecords(), 0)
    await assertDrained(context)
    await assertInertQueuedContinuation(context, failed)
    // Exercise the same initialized service with its existing injectable renderer endpoint.
    context.service.rendererUrl = rendererUrl('load-failure-recovery')
    const recovered = beginCreation(context)
    const secondOutcome = await recovered.outcome
    const ready = await waitPhase(recovered.entry, 'ready-result')
    assert.equal(secondOutcome.ok, true)
    assert.equal(ready.ok, true)
    assert.equal(ready.value, true)
    assert.equal(recovered.entry.initialization?.state, 'succeeded')
    await assertHeldLoad(recovered.entry, 'load-failure-recovery')
    assert.equal(recovered.entry.window.isVisible(), true)
    assert.equal(countDesktopStickyRecords(), 1)
    assert.equal(context.insertCalls, 1)
    await assertDrained(context)
    releaseImage('load-failure-recovery')
    await waitUntil(
      () => windowInfo(recovered.entry).didFinishLoad,
      'Recovered page did not finish'
    )
    await finishContext(context)
    deleteAllDesktopStickyRecords()
    return { firstOutcome, firstTerminal, secondOutcome, ready }
  })

  await scenario('real-sqlite-insert-failure-invalidates-ready', async () => {
    database.exec(`CREATE TRIGGER reject_sticky_initialization_insert
      BEFORE INSERT ON desktop_stickies
      BEGIN SELECT RAISE(ABORT, 'injected sticky initialization INSERT failure'); END`)
    const context = createContext('sql-insert-failure', 'early-ready')
    const creation = beginCreation(context)
    const rendered = await waitPhase(creation.entry, 'state-filled')
    const outcome = await creation.outcome
    assert.equal(rendered.renderedContent, noteContent)
    assert.equal(outcome.ok, false)
    assert.match(outcome.error.message, /保存失败|初始化失败/)
    const terminal = assertFailedEntry(context, creation, 'failed')
    assert.equal(
      context.insertCalls,
      1,
      'Real ready IPC must attempt the actual rejected SQLite insert'
    )
    assert.equal(countDesktopStickyRecords(), 0)
    assert.equal(outcome.error.committed, false)
    await assertDrained(context)
    await assertInertQueuedContinuation(context, creation)
    await finishContext(context)
    database.exec('DROP TRIGGER reject_sticky_initialization_insert')
    return { rendered, outcome, terminal }
  })
}

function writeSourceEvidence() {
  const files = [
    suite,
    'tests/fixtures/sticky-initialization/preload.cjs',
    'tests/helpers/test-result-recorder.cjs',
    'src/main/sticky/ElectronStickyService.js',
    'src/main/sticky/StickyService.js',
    'src/main/sticky/StickyDisplayManager.js',
    'src/main/sticky/stickyConstants.js',
    'src/main/sticky/stickyUtils.js',
    'src/main/application/business-mutation-admission.js',
    'src/main/db/db-connection.js',
    'src/main/db/db-schema.js',
    'src/main/db/db-desktop-stickies.js',
    'src/main/db/db-notes.js',
    'package-lock.json'
  ]
  writeJson(
    'source-hashes.json',
    Object.fromEntries(
      files.map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(workspaceRoot, file)))
          .digest('hex')
      ])
    )
  )
  writeJson('runtime.json', {
    suite,
    mode,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    profile: profile.directory,
    profileOwnership: profile.ownership,
    evidenceRoot,
    userDatabaseAccessed: false,
    productShutdownCovered: false,
    watchdog: 'external runner only; no forced successful exit or internal retry'
  })
}

async function cleanupFixture() {
  const errors = []
  for (const context of contexts) {
    try {
      if (!context.disposed) context.service.dispose()
    } catch (error) {
      errors.push('service ' + context.caseId + ': ' + (error.stack || error.message))
    }
  }
  const serviceWindowsDestroyed = [...windows.values()].every((value) => value.window.isDestroyed())
  const registriesEmpty = [...contexts].every(
    (context) => context.service.registry.size === 0 && context.service.byWebContentsId.size === 0
  )
  if (!serviceWindowsDestroyed || !registriesEmpty) {
    errors.push('The service did not release every real window/registry entry')
    // Preserve ownership and let the runner collect external diagnostics before any owned cleanup.
    record('fixture-resource-cleanup-incomplete', { serviceWindowsDestroyed, registriesEmpty })
  }
  ipcMain.removeListener(phaseChannel, onFixturePhase)
  serverClosing = true
  const serverClosed = server?.listening
    ? new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      )
    : Promise.resolve()
  for (const { response } of heldResponses.values()) response.destroy()
  heldResponses.clear()
  for (const socket of sockets) socket.destroy()
  await serverClosed
  // The server callback and individual socket close events have separate queues.
  // Observe actual socket close completion rather than guessing their ordering.
  await Promise.all([...socketCloseWaiters])
  let integrity = null
  try {
    if (database?.open) {
      integrity = database.pragma('integrity_check', { simple: true })
      writeJson('database-snapshot.json', {
        integrity,
        rows: listDesktopStickyRecords(),
        writes: auditWrites(),
        userDatabaseAccessed: false
      })
      artifacts.push('database-snapshot.json')
      if (integrity !== 'ok') errors.push('Isolated SQLite integrity_check: ' + integrity)
    }
  } catch (error) {
    errors.push('database evidence: ' + (error.stack || error.message))
  }
  clearDb()
  try {
    database?.close()
  } catch (error) {
    errors.push('database close: ' + (error.stack || error.message))
  }
  const snapshot = {
    status: errors.length ? 'failed' : 'complete',
    errors,
    serviceWindowsDestroyed,
    registriesEmpty,
    browserWindowsRemaining: BrowserWindow.getAllWindows().length,
    heldResponsesRemaining: heldResponses.size,
    socketsRemaining: sockets.size,
    serverClosed: !server?.listening,
    sqliteClosed: !database?.open,
    integrity,
    pendingBusinessMutations: [...contexts].map((context) => ({
      caseId: context.caseId,
      pending: context.admission.snapshot().pending
    })),
    profileOwnership: profile.ownership,
    productShutdownCovered: false,
    scope: 'Explicit isolated-service disposal, real windows, HTTP sockets and SQLite handle'
  }
  if (snapshot.pendingBusinessMutations.some((value) => value.pending !== 0)) {
    snapshot.status = 'failed'
    errors.push('Business admission still owns pending operations')
  }
  if (snapshot.socketsRemaining !== 0) {
    snapshot.status = 'failed'
    errors.push('The fixture HTTP server still owns sockets')
  }
  record('fixture-cleanup', snapshot)
  return snapshot
}

async function runTests() {
  try {
    writeSourceEvidence()
    assert.equal(process.platform, 'win32')
    assert.equal(process.arch, 'x64')
    ipcMain.on(phaseChannel, onFixturePhase)
    database = new Database(join(profile.directory, 'sticky-initialization.sqlite'))
    database.pragma('foreign_keys = ON')
    createDatabaseSchema(database)
    setDb(database)
    database.exec(`CREATE TABLE sticky_initialization_writes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, sticky_id TEXT NOT NULL
    );
    CREATE TRIGGER audit_sticky_initialization_insert AFTER INSERT ON desktop_stickies
      BEGIN INSERT INTO sticky_initialization_writes(operation, sticky_id) VALUES ('insert', NEW.id); END;
    CREATE TRIGGER audit_sticky_initialization_update AFTER UPDATE ON desktop_stickies
      BEGIN INSERT INTO sticky_initialization_writes(operation, sticky_id) VALUES ('update', NEW.id); END;
    CREATE TRIGGER audit_sticky_initialization_delete AFTER DELETE ON desktop_stickies
      BEGIN INSERT INTO sticky_initialization_writes(operation, sticky_id) VALUES ('delete', OLD.id); END;`)
    const timestamp = Date.now()
    noteId = Number(
      database
        .prepare(
          `INSERT INTO notes (content, status, effective_at, created_at, updated_at)
        VALUES (?, 'in_progress', ?, ?, ?)`
        )
        .run(noteContent, timestamp, timestamp, timestamp).lastInsertRowid
    )
    await startServer()
    await runScenarios()
    assert.equal(scenarios.length, 6)
    assert.ok(scenarios.every((value) => value.status === 'passed'))
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    assert.equal(countDesktopStickyRecords(), 0)
    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok')
    businessCompleted = true
  } catch (error) {
    failure = error
    exitCode = 1
    record('business-failure', errorDetails(error))
    console.error(error)
  } finally {
    try {
      cleanup = await cleanupFixture()
      if (cleanup.status !== 'complete') exitCode = 1
    } catch (error) {
      cleanup = { status: 'failed', error: errorDetails(error) }
      exitCode = 1
      console.error(error)
    }
    try {
      const flush = await flushLogs()
      evidence = { status: flush.incomplete ? 'incomplete' : 'complete', flush, artifacts }
      if (evidence.status !== 'complete') exitCode = 1
    } catch (error) {
      evidence = { status: 'failed', error: errorDetails(error), artifacts }
      exitCode = 1
    }
    if (profile.ownership === 'script') {
      cleanup.preservedProfile = profile.directory
      if (cleanup.status === 'complete') cleanup.status = 'preserved'
    }
    try {
      writeJson('business-result.json', {
        suite,
        mode,
        completed: businessCompleted,
        error: failure ? errorDetails(failure) : null,
        assertions: recorder.report({ cleanup }).assertions,
        scenarios,
        cleanup,
        evidence,
        profile: profile.directory,
        profileOwnership: profile.ownership,
        userDatabaseAccessed: false,
        productShutdownCovered: false
      })
    } catch (error) {
      evidence = { status: 'failed', error: errorDetails(error), artifacts }
      exitCode = 1
      console.error(error)
    }
    record('fixture-normal-quit-requested', { exitCode, businessCompleted, cleanup, evidence })
    process.exitCode = exitCode
    app.quit()
  }
}

app.once('will-quit', () => {
  reachedWillQuit = true
  record('fixture-will-quit', { exitCode, productShutdownCovered: false })
})
app.once('quit', (_event, code) => {
  try {
    const exit = {
      requestedExitCode: exitCode,
      observedQuitCode: code,
      reachedWillQuit,
      productShutdownCovered: false
    }
    record('fixture-quit', exit)
    writeJson('exit-result.json', exit)
    artifacts.push('exit-result.json')
    if (!exitCode) {
      assert.equal(reachedWillQuit, true)
      assert.equal(code, 0)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
    }
    recorder.finish({
      completed: businessCompleted,
      error: failure,
      evidence,
      profileOwnership: profile.ownership,
      cleanup: { ...cleanup, reachedWillQuit, observedQuitCode: code }
    })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
})
app.once('ready', () => void runTests())
