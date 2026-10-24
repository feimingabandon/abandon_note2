import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain } from 'electron'
import { ReminderWindow } from '../src/main/services/ReminderWindow.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const suite = 'tests/reminder-initialization-electron.mjs'
const mode = 'electron-ready-real-reminder-load-ready-lifecycle'
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = join(workspaceRoot, 'out', 'renderer')
const preloadPath = join(workspaceRoot, 'out', 'preload', 'reminder.js')
const profile = prepareTestProfile({ prefix: 'abandon-reminder-initialization-' })
const fallbackRoot = join(workspaceRoot, 'tmp', 'reminder-initialization-electron')
if (!process.env.ABANDON_TEST_EVIDENCE_DIR) mkdirSync(fallbackRoot, { recursive: true })
const evidenceRoot =
  process.env.ABANDON_TEST_EVIDENCE_DIR || mkdtempSync(join(fallbackRoot, 'run-'))
const recorder = createAssertionRecorder({
  suite,
  mode,
  metadata: {
    service: 'actual-ReminderWindow-with-real-BrowserWindow-and-authorized-ipc',
    renderer: 'formal-built-ReminderApp-and-sandboxed-reminder-preload',
    loadControl: 'same-origin-hidden-iframe-response-delays-native-load-completion',
    readyControl: 'actual-main-frame-invoke-retained-before-original-authorized-handler',
    lateReady: 'retained-main-handler-continuation-not-new-ipc-from-destroyed-renderer',
    lateLoad: 'real-native-abort-after-destruction-no-synthetic-late-fulfilled-promise',
    initializationDeadlineMs: 15000,
    suiteBudgetMs: 120000,
    nativeObservation: 'separate-hidden-powershell-process-at-stable-points',
    productShutdownCovered: false,
    stopPresentationScope: 'actual-narrow-port-not-full-product-onBegin-or-slow-shutdown-stages',
    exitScope: 'service-dispose-http-close-and-normal-fixture-app-quit',
    userDatabaseAccessed: false
  }
})
const { assert } = recorder
const execFileAsync = promisify(execFile)
const contexts = []
const windows = new Map()
const sockets = new Set()
const socketClosures = new Set()
const tails = new Map()
const scenarios = []
const artifacts = [
  'executed-reminder-initialization-electron.mjs',
  'source-hashes.json',
  'formal-reminder.html',
  'events.jsonl',
  'business-result.json',
  'exit-result.json'
]
const startedAt = Date.now()
let sequence = 0
let creatingContext = null
let server = null
let baseUrl = null
let sentinel = null
let sentinelHandle = '0'
let completed = false
let failure = null
let cleanup = { status: 'failed', reason: 'Fixture cleanup has not run' }
let evidence = { status: 'incomplete' }
let exitCode = 0
let reachedWillQuit = false
let sourceBefore = null
let currentScenario = null
let suiteTimedOut = false

app.setPath('userData', profile.directory)
// This fixture owns its shutdown; a deliberately destroyed pending window must
// not make Electron quit before the following recovery scenario can run.
app.on('window-all-closed', () => record('all-windows-closed'))

function errorDetails(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message || String(error),
    stack: error?.stack
  }
}

function record(event, details = {}) {
  const value = {
    sequence: ++sequence,
    time: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    pid: process.pid,
    scenario: currentScenario,
    event,
    ...details
  }
  appendFileSync(join(evidenceRoot, 'events.jsonl'), JSON.stringify(value) + '\n')
  process.stdout.write(JSON.stringify(value) + '\n')
  return value
}

function writeJson(name, value) {
  writeFileSync(join(evidenceRoot, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  })
}

function sourceHashes() {
  const paths = [
    suite,
    'src/main/services/ReminderWindow.js',
    'src/main/ipc/ipc-authorization.js',
    'src/preload/reminder.js',
    'src/renderer/reminder.html',
    'src/renderer/src/ReminderApp.vue',
    'src/renderer/src/reminder-main.js',
    'src/renderer/src/utils/applySettingsSnapshot.js',
    'src/shared/settings-schema.js',
    'tests/helpers/test-result-recorder.cjs',
    relative(workspaceRoot, preloadPath),
    ...filesBelow(rendererRoot).map((path) => relative(workspaceRoot, path))
  ]
  return [...new Set(paths)].sort().map((path) => ({
    path: path.replaceAll('\\', '/'),
    sha256: hash(readFileSync(resolve(workspaceRoot, path)))
  }))
}

const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const nextTurn = () => new Promise((done) => setImmediate(done))
async function until(read, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await wait(20)
  }
  throw new Error('Timed out: ' + description)
}

function handleOf(window) {
  return window.getNativeWindowHandle().readBigUInt64LE().toString()
}

function snapshot(info) {
  const window = info.window
  const observe = (read) => {
    try {
      return read()
    } catch (error) {
      return 'unavailable: ' + (error?.message || String(error))
    }
  }
  // webContents can already be destroyed while BrowserWindow still exists.
  // Observation runs before native methods too, so each read must remain inert
  // through that boundary; errors from the native method itself still propagate.
  const destroyed = observe(() => window.isDestroyed())
  const contentsDestroyed = observe(() => info.contents.isDestroyed())
  const windowValue = (read) =>
    destroyed === false ? observe(read) : destroyed === true ? false : destroyed
  return {
    caseId: info.context.caseId,
    document: info.index,
    windowId: info.windowId,
    webContentsId: info.webContentsId,
    handle: info.handle,
    destroyed,
    webContentsDestroyed: contentsDestroyed,
    visible: windowValue(() => window.isVisible()),
    focused: windowValue(() => window.isFocused()),
    loadingMainFrame:
      contentsDestroyed === false
        ? observe(() => info.contents.isLoadingMainFrame())
        : contentsDestroyed === true
          ? false
          : contentsDestroyed,
    nativeFinished: info.nativeFinished,
    loadOutcome: info.loadOutcome,
    calls: { ...info.calls },
    readyCalls: info.readyCalls.map((call) => ({
      id: call.id,
      senderIsMainFrame: call.senderIsMainFrame,
      dispatched: call.dispatched,
      outcome: call.outcome
    }))
  }
}

// Native reads stay outside Electron's window callbacks, where a reentrant
// user32 read could otherwise perturb the HWND being observed.
async function nativeState(info, phase) {
  const popupHandle = info?.handle || '0'
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ReminderInitializationObservation {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
}
'@
$reminderPopupHandle = [IntPtr]::new([long]${popupHandle})
$reminderSentinelHandle = [IntPtr]::new([long]${sentinelHandle})
$reminderForeground = [ReminderInitializationObservation]::GetForegroundWindow()
@{
  nativePopupHandle = $reminderPopupHandle.ToInt64().ToString()
  nativeSentinelHandle = $reminderSentinelHandle.ToInt64().ToString()
  nativeForeground = $reminderForeground.ToInt64().ToString()
  nativePopupVisible = [ReminderInitializationObservation]::IsWindowVisible($reminderPopupHandle)
  nativeSentinelVisible = [ReminderInitializationObservation]::IsWindowVisible($reminderSentinelHandle)
  nativeSentinelEnabled = [ReminderInitializationObservation]::IsWindowEnabled($reminderSentinelHandle)
  nativeForegroundIsPopup = $reminderPopupHandle -ne [IntPtr]::Zero -and $reminderForeground -eq $reminderPopupHandle
  nativeForegroundIsSentinel = $reminderForeground -eq $reminderSentinelHandle
} | ConvertTo-Json -Compress
`
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 }
  )
  return record('native-state', {
    phase,
    ...(info ? snapshot(info) : {}),
    ...JSON.parse(stdout.trim())
  })
}

async function foregroundBaseline(info, phase) {
  sentinel.show()
  sentinel.focus()
  await until(() => sentinel.isFocused(), phase + ': sentinel Electron focus')
  const state = await nativeState(info, phase + ':foreground-baseline')
  assert.equal(sentinel.isVisible(), true, phase + ': sentinel is actually visible to Electron')
  assert.equal(state.nativeSentinelVisible, true, phase + ': sentinel is visible to Windows')
  assert.equal(state.nativeSentinelEnabled, true)
  assert.equal(state.nativeForegroundIsSentinel, true, phase + ': actual foreground baseline')
  assert.notEqual(state.nativeForeground, '0')
  assert.equal(state.nativeForegroundIsPopup, false)
  return state
}

async function assertHidden(info, baseline, phase) {
  await nextTurn()
  const state = await nativeState(info, phase)
  assert.equal(state.visible, false, phase + ': Electron hidden')
  assert.equal(state.focused, false, phase + ': Electron unfocused')
  assert.equal(state.nativePopupVisible, false, phase + ': Windows hidden')
  assert.equal(state.nativeForegroundIsPopup, false, phase + ': no Windows foreground')
  assert.equal(state.nativeForeground, baseline.nativeForeground, phase + ': foreground preserved')
  return state
}

async function assertPassive(info, baseline, phase) {
  const state = await nativeState(info, phase)
  assert.equal(state.visible, true, phase + ': Electron visible')
  assert.equal(state.nativePopupVisible, true, phase + ': Windows visible')
  assert.equal(state.focused, false, phase + ': inactive presentation')
  assert.equal(state.nativeForegroundIsPopup, false)
  assert.equal(state.nativeForeground, baseline.nativeForeground, phase + ': foreground preserved')
  return state
}

function inContext(context, operation) {
  const previous = creatingContext
  creatingContext = context
  try {
    return operation()
  } finally {
    creatingContext = previous
  }
}

app.on('browser-window-created', (_event, window) => {
  const context = creatingContext
  if (!context) return
  const index = context.entries.length
  const plan = context.plans[index]
  if (!plan) throw new Error(context.caseId + ': unexpected extra BrowserWindow')
  const info = {
    context,
    index,
    plan,
    window,
    contents: window.webContents,
    windowId: window.id,
    webContentsId: window.webContents.id,
    handle: handleOf(window),
    frame: null,
    nativeFinished: false,
    loadOutcome: 'pending',
    calls: { showInactive: 0, show: 0, focus: 0, hide: 0, destroy: 0 },
    readyCalls: [],
    documentServed: false,
    tail: null
  }
  context.entries.push(info)
  windows.set(info.webContentsId, info)
  for (const name of Object.keys(info.calls)) {
    const original = window[name]
    window[name] = function (...args) {
      info.calls[name] += 1
      record('window-method', { method: name, ...snapshot(info) })
      return original.apply(this, args)
    }
  }
  const originalLoad = window.loadURL
  window.loadURL = function (...args) {
    record('load-requested', { url: args[0], ...snapshot(info) })
    const result = originalLoad.apply(this, args)
    // Observe the actual returned promise without replacing it or introducing
    // a synthetic fulfilled load after a native window has been destroyed.
    void Promise.resolve(result).then(
      () => {
        info.loadOutcome = 'fulfilled'
        record('load-fulfilled', snapshot(info))
      },
      (error) => {
        info.loadOutcome = 'rejected'
        record('load-rejected', { ...snapshot(info), error: errorDetails(error) })
      }
    )
    return result
  }
  for (const event of ['show', 'hide', 'focus', 'blur', 'closed']) {
    window.on(event, () => record('window-event', { type: event, ...snapshot(info) }))
  }
  window.webContents.on('did-finish-load', () => {
    info.nativeFinished = true
    record('did-finish-load', snapshot(info))
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    record('did-fail-load', { code, description, url, isMainFrame, ...snapshot(info) })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    record('render-process-gone', { details, ...snapshot(info) })
  })
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error')
      record('renderer-console-error', { ...snapshot(info), message: details.message })
  })
  record('window-created', snapshot(info))
})

function makeContext(caseId, plans, { reenterDismiss = false, dismissError = false } = {}) {
  const context = {
    caseId,
    plans,
    entries: [],
    handlers: new Map(),
    readyCalls: [],
    errors: [],
    dismissals: [],
    reenterDismiss,
    dismissError,
    popup: null,
    requestedAt: null,
    rows: [
      {
        id: caseId + '-round',
        note_id: 23,
        content: '正式提醒界面初始化：' + caseId,
        due_at: Date.now() - 1000,
        from_template: 0
      }
    ]
  }
  const ipcAdapter = {
    handle(channel, originalHandler) {
      context.handlers.set(channel, originalHandler)
      ipcMain.handle(channel, (event, ...args) => {
        if (channel !== 'reminders:ready') return originalHandler(event, ...args)
        const info = windows.get(event.sender.id)
        const call = {
          id: context.readyCalls.length + 1,
          event,
          args,
          handler: originalHandler,
          info,
          senderIsMainFrame: event.senderFrame === event.sender.mainFrame,
          dispatched: false,
          outcome: 'pending'
        }
        const promise = new Promise((resolveReady, rejectReady) => {
          call.resolve = resolveReady
          call.reject = rejectReady
        })
        context.readyCalls.push(call)
        if (info) {
          info.frame ||= event.sender.mainFrame
          info.readyCalls.push(call)
        }
        record('ready-invoke-arrived', {
          caseId,
          callId: call.id,
          windowId: info?.windowId ?? null,
          senderIsMainFrame: call.senderIsMainFrame,
          held: Boolean(info?.plan.holdReady && info.readyCalls.length === 1)
        })
        if (!info?.plan.holdReady || info.readyCalls.length !== 1) void dispatchReady(call)
        return promise
      })
    },
    removeHandler(channel) {
      context.handlers.delete(channel)
      ipcMain.removeHandler(channel)
      record('ipc-handler-removed', { caseId, channel })
    }
  }
  context.popup = new ReminderWindow({
    ipcMain: ipcAdapter,
    preloadPath,
    rendererPath: rendererRoot,
    rendererUrl: baseUrl + caseId + '/',
    getSettings: () => ({ values: { appearance: { uiScale: 1 } } }),
    onAction: () => {
      throw new Error('This initialization fixture must not mutate a reminder')
    },
    onDismissAll(ids) {
      context.dismissals.push([...ids])
      record('dismiss-all', { caseId, ids })
      if (context.reenterDismiss) {
        context.popup.sync(context.rows)
        context.popup.focusRound(context.rows[0].id)
      }
      if (context.dismissError) throw new Error('E2.4 controlled synchronous dismiss rejection')
    },
    reportError(message, error) {
      const value = { message, error: errorDetails(error), at: Date.now() }
      context.errors.push(value)
      record('service-error', { caseId, ...value })
    }
  })
  contexts.push(context)
  return context
}

async function dispatchReady(call) {
  if (call.dispatched) throw new Error('A retained ready invoke may only be dispatched once')
  call.dispatched = true
  record('ready-original-handler-before', {
    callId: call.id,
    caseId: call.info?.context.caseId,
    windowId: call.info?.windowId,
    senderIsMainFrame: call.senderIsMainFrame
  })
  try {
    const result = await call.handler(call.event, ...call.args)
    call.outcome = 'fulfilled'
    call.resolve(result)
    record('ready-original-handler-fulfilled', { callId: call.id, result })
    return { ok: true, result }
  } catch (error) {
    call.outcome = 'rejected'
    call.reject(error)
    record('ready-original-handler-rejected', { callId: call.id, error: errorDetails(error) })
    return { ok: false, error: errorDetails(error) }
  }
}

async function js(info, code) {
  info.frame ||= info.window.webContents.mainFrame
  return info.frame.executeJavaScript(code)
}

async function start(context, { focus = false } = {}) {
  context.requestedAt = Date.now()
  inContext(context, () => {
    context.popup.sync(context.rows)
    if (focus) assert.equal(context.popup.focusRound(context.rows[0].id), true)
  })
  const info = context.entries[0]
  assert.ok(info, context.caseId + ': actual reminder BrowserWindow created')
  return info
}

async function firstReady(info, { dispatched = false } = {}) {
  const call = await until(() => info.readyCalls[0], 'formal ReminderApp ready invoke')
  assert.equal(call.senderIsMainFrame, true, 'formal main frame produced ready')
  if (dispatched)
    await until(() => call.outcome === 'fulfilled', 'original authorized ready handler completed')
  const dom = await js(
    info,
    `({cards:document.querySelectorAll('.reminder-card').length,
      text:document.querySelector('.reminder-content')?.textContent,
      custom:!!document.querySelector('.reminder-custom'),
      api:typeof window.reminderAPI?.ready})`
  )
  assert.equal(dom.cards, 1, 'formal renderer accepted the current reminders before ready')
  assert.equal(dom.text, info.context.rows[0].content)
  assert.equal(dom.api, 'function', 'formal sandboxed preload API exists')
  record('formal-dom-before-ready-completion', { ...snapshot(info), dom })
  return call
}

async function settledLoad(info) {
  await until(
    () => info.nativeFinished && info.loadOutcome === 'fulfilled',
    'actual native did-finish-load and original load promise fulfillment'
  )
  await nextTurn()
}

function counts(info) {
  return {
    showInactive: info.calls.showInactive,
    show: info.calls.show,
    focus: info.calls.focus
  }
}

async function repeatReady(info) {
  const before = counts(info)
  const beforeState = await js(info, 'window.reminderAPI.getState()')
  assert.equal(await js(info, 'window.reminderAPI.ready()'), true)
  assert.equal(await js(info, 'window.reminderAPI.ready()'), true)
  const afterState = await js(info, 'window.reminderAPI.getState()')
  assert.deepEqual(counts(info), before, 'duplicate real ready does not repeat presentation')
  assert.equal(afterState.focusRequest, beforeState.focusRequest, 'ready is not a new focus intent')
  record('duplicate-ready-checked', { ...snapshot(info), focusRequest: afterState.focusRequest })
}

async function screenshot(info, name) {
  const bytes = (await info.window.webContents.capturePage()).toPNG()
  writeFileSync(join(evidenceRoot, name), bytes, { flag: 'wx' })
  artifacts.push(name)
  record('screenshot', { name, sha256: hash(bytes), ...snapshot(info) })
}

function disposeContext(context) {
  record('context-dispose-before', {
    caseId: context.caseId,
    windows: context.entries.map(snapshot)
  })
  context.popup.dispose()
  assert.equal(context.handlers.size, 0, context.caseId + ': all IPC handlers released')
  assert.ok(context.entries.every((info) => info.window.isDestroyed()))
  record('context-disposed', { caseId: context.caseId, windows: context.entries.map(snapshot) })
}

function stopContext(context) {
  record('presentation-stop-before', {
    caseId: context.caseId,
    windows: context.entries.map(snapshot)
  })
  context.popup.stopPresentation()
  record('presentation-stop-returned', {
    caseId: context.caseId,
    windows: context.entries.map(snapshot),
    handlersRetainedForDispose: context.handlers.size
  })
}

async function runScenario(name, operation) {
  currentScenario = name
  record('scenario-start')
  await operation()
  scenarios.push({ name, status: 'passed' })
  record('scenario-passed')
}

async function readyBeforeLoad() {
  const baseline = await foregroundBaseline(null, 'ready-before-load')
  const context = makeContext('ready-before-load', [{ tail: true }])
  const info = await start(context)
  await firstReady(info, { dispatched: true })
  const tail = await until(() => info.tail, 'same-origin iframe request is actually held')
  assert.equal(tail.ended, false)
  assert.equal(tail.closed, false)
  assert.equal(info.nativeFinished, false)
  assert.equal(info.loadOutcome, 'pending')
  assert.equal(info.window.webContents.isLoadingMainFrame(), true)
  assert.deepEqual(counts(info), { showInactive: 0, show: 0, focus: 0 })
  await assertHidden(info, baseline, 'ready-arrived-load-still-held')
  // Ending this one response is the intended second half of the contract, only
  // after real ready and the hidden-state assertions. No extra sync is sent.
  finishTail(info)
  await settledLoad(info)
  await until(() => info.window.isVisible(), 'load completion alone presents the ready window')
  assert.deepEqual(counts(info), { showInactive: 1, show: 0, focus: 0 })
  await assertPassive(info, baseline, 'ready-then-load-presented')
  await repeatReady(info)
  await screenshot(info, 'ready-before-load.png')
  disposeContext(context)
}

async function loadBeforeReadyWithFocus() {
  const baseline = await foregroundBaseline(null, 'load-before-ready')
  const context = makeContext('load-before-ready', [{ holdReady: true }])
  const info = await start(context, { focus: true })
  const call = await firstReady(info)
  await settledLoad(info)
  assert.equal(call.dispatched, false)
  assert.deepEqual(counts(info), { showInactive: 0, show: 0, focus: 0 })
  await assertHidden(info, baseline, 'load-arrived-ready-still-held')
  assert.equal((await dispatchReady(call)).ok, true)
  await until(() => info.window.isVisible() && info.window.isFocused(), 'pending focus is consumed')
  assert.deepEqual(counts(info), { showInactive: 0, show: 1, focus: 1 })
  const shown = await nativeState(info, 'load-then-ready-focused')
  assert.equal(shown.nativePopupVisible, true)
  assert.equal(shown.nativeForegroundIsPopup, true)
  assert.equal(await js(info, '!!document.querySelector(".reminder-custom")'), true)
  await js(info, 'document.querySelector(".reminder-actions button").click()')
  await until(
    () => js(info, '!document.querySelector(".reminder-custom")'),
    'user closes the custom time controls'
  )
  await repeatReady(info)
  assert.equal(
    await js(info, '!!document.querySelector(".reminder-custom")'),
    false,
    'duplicate ready does not reopen user-closed controls'
  )
  await screenshot(info, 'load-before-ready-focused.png')
  disposeContext(context)
}

async function hideDuringPendingWithReentry() {
  const baseline = await foregroundBaseline(null, 'hide-reentry')
  const context = makeContext('hide-reentry', [{ holdReady: true }], {
    reenterDismiss: true,
    dismissError: true
  })
  const info = await start(context, { focus: true })
  const call = await firstReady(info)
  await settledLoad(info)
  context.popup.hideAll()
  assert.deepEqual(context.dismissals, [[context.rows[0].id]])
  assert.equal(context.errors.length, 1)
  assert.equal(context.errors[0].message, '[reminders] dismiss failed')
  assert.equal((await dispatchReady(call)).ok, true)
  await js(info, 'window.reminderAPI.getState()')
  assert.deepEqual(counts(info), { showInactive: 0, show: 0, focus: 0 })
  await assertHidden(info, baseline, 'hide-wins-over-sync-focus-and-dismiss-rejection')
  await repeatReady(info)
  await assertHidden(info, baseline, 'late-duplicate-ready-keeps-user-hide')
  inContext(context, () => context.popup.sync(context.rows))
  await until(() => info.window.isVisible(), 'a later independent sync may show reminders again')
  assert.deepEqual(counts(info), { showInactive: 1, show: 0, focus: 0 })
  await assertPassive(info, baseline, 'independent-sync-reopens-without-old-focus')
  disposeContext(context)
}

async function closePendingThenRecover() {
  const baseline = await foregroundBaseline(null, 'close-pending')
  const context = makeContext('close-pending', [{ tail: true, holdReady: true }, {}])
  const old = await start(context, { focus: true })
  const call = await firstReady(old)
  await until(() => old.tail, 'close scenario really holds a load tail')
  old.window.close()
  await until(
    () => old.window.isDestroyed(),
    'native close cancels and destroys the pending window'
  )
  assert.deepEqual(context.dismissals, [[context.rows[0].id]])
  assert.deepEqual(counts(old), { showInactive: 0, show: 0, focus: 0 })
  await assertHidden(old, baseline, 'closed-pending-window-is-inert')
  inContext(context, () => context.popup.sync(context.rows))
  const fresh = context.entries[1]
  assert.ok(fresh)
  await firstReady(fresh, { dispatched: true })
  await settledLoad(fresh)
  await until(() => fresh.window.isVisible(), 'new sync recovers after pending close')
  const rejected = await dispatchReady(call)
  assert.equal(rejected.ok, false)
  assert.match(rejected.error.message, /无权访问便签提醒/)
  await until(() => old.loadOutcome === 'rejected', 'closed native load actually aborts')
  assert.equal(old.tail.ended, false, 'cancellation never releases the held response for success')
  assert.deepEqual(counts(fresh), { showInactive: 1, show: 0, focus: 0 })
  await assertPassive(fresh, baseline, 'old-close-ready-cannot-disrupt-new-window')
  fresh.window.close()
  assert.equal(fresh.window.isDestroyed(), false, 'a successful window still closes by hiding')
  assert.equal(fresh.window.isVisible(), false)
  await repeatReady(fresh)
  await assertHidden(fresh, baseline, 'successful-window-close-is-not-undone-by-ready')
  disposeContext(context)
}

async function destroyThenReplace() {
  const baseline = await foregroundBaseline(null, 'destroy-replace')
  const context = makeContext('destroy-replace', [{ tail: true, holdReady: true }, {}])
  const old = await start(context, { focus: true })
  const call = await firstReady(old)
  await until(() => old.tail, 'destroy scenario really holds a load tail')
  // Recreate in the same JS stack, before the old native load's rejection
  // continuation can run. Its captured window must not destroy the replacement.
  inContext(context, () => {
    old.window.destroy()
    context.popup.sync(context.rows)
  })
  const fresh = context.entries[1]
  assert.ok(fresh)
  await firstReady(fresh, { dispatched: true })
  await settledLoad(fresh)
  await until(() => fresh.window.isVisible(), 'replacement survives the old load abort')
  await until(() => old.loadOutcome === 'rejected', 'destroyed native load actually aborts')
  assert.equal((await dispatchReady(call)).ok, false)
  assert.equal(old.tail.ended, false)
  assert.equal(fresh.window.isDestroyed(), false)
  assert.deepEqual(counts(fresh), { showInactive: 1, show: 0, focus: 0 })
  await assertPassive(fresh, baseline, 'replacement-remains-owned-after-old-callbacks')
  disposeContext(context)
}

async function timeoutThenRecover() {
  const baseline = await foregroundBaseline(null, 'timeout-recover')
  const context = makeContext('timeout-recover', [{ tail: true, holdReady: true }, {}])
  const old = await start(context, { focus: true })
  const call = await firstReady(old)
  await until(() => old.tail, 'timeout scenario really holds a load tail')
  assert.equal(old.tail.ended, false)
  await assertHidden(old, baseline, 'original-fifteen-second-deadline-pending')
  await until(
    () => old.window.isDestroyed(),
    'original 15-second initialization deadline destroys the unavailable window',
    18000
  )
  const timeout = context.errors.find(
    (value) => value.error.code === 'REMINDER_INITIALIZATION_TIMEOUT'
  )
  assert.ok(timeout, 'timeout has its own explicit diagnostic result')
  assert.ok(timeout.at - context.requestedAt >= 15000, 'the product deadline was not shortened')
  assert.equal(
    old.tail.ended,
    false,
    'no response release or synthetic completion bypasses timeout'
  )
  assert.deepEqual(
    context.popup.snapshot().reminders.map((row) => row.id),
    [context.rows[0].id]
  )
  await assertHidden(old, baseline, 'timed-out-window-is-inert')
  inContext(context, () => context.popup.sync(context.rows))
  const fresh = context.entries[1]
  assert.ok(fresh)
  await firstReady(fresh, { dispatched: true })
  await settledLoad(fresh)
  await until(() => fresh.window.isVisible(), 'same reminder recovers on the next sync')
  const rejected = await dispatchReady(call)
  assert.equal(rejected.ok, false)
  assert.match(rejected.error.message, /无权访问便签提醒/)
  await until(() => old.loadOutcome === 'rejected', 'timed-out native load actually aborts')
  assert.deepEqual(counts(old), { showInactive: 0, show: 0, focus: 0 })
  assert.deepEqual(counts(fresh), { showInactive: 1, show: 0, focus: 0 })
  await assertPassive(fresh, baseline, 'timeout-old-ready-and-abort-do-not-affect-recovery')
  disposeContext(context)
}

async function stopPendingPresentation() {
  const baseline = await foregroundBaseline(null, 'stop-pending')
  const context = makeContext('stop-pending', [{ tail: true, holdReady: true }])
  const info = await start(context, { focus: true })
  const call = await firstReady(info)
  await until(() => info.tail, 'stop scenario really holds a load tail')
  stopContext(context)
  stopContext(context)
  await until(() => info.window.isDestroyed(), 'stop cancels pending initialization')
  const outcome = await dispatchReady(call)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error.message, /无权访问便签提醒/)
  inContext(context, () => {
    context.popup.sync(context.rows)
    assert.equal(context.popup.focusRound(context.rows[0].id), false)
  })
  await until(() => info.loadOutcome === 'rejected', 'stop causes a real native load abort')
  assert.equal(context.entries.length, 1, 'shutdown admission cannot create another window')
  assert.deepEqual(counts(info), { showInactive: 0, show: 0, focus: 0 })
  assert.equal(info.tail.ended, false)
  await assertHidden(info, baseline, 'stopped-pending-late-ready-cannot-present')
  disposeContext(context)
}

async function stopReadyAndDisposePending() {
  let baseline = await foregroundBaseline(null, 'stop-ready')
  const ready = makeContext('stop-ready', [{}])
  const info = await start(ready)
  await firstReady(info, { dispatched: true })
  await settledLoad(info)
  await until(() => info.window.isVisible(), 'ready reminder presents before stop')
  await assertPassive(info, baseline, 'ready-window-before-stop')
  ready.popup.hideAll()
  baseline = await foregroundBaseline(info, 'stop-ready-hidden')
  const before = counts(info)
  stopContext(ready)
  assert.equal(info.window.isDestroyed(), false, 'ready window remains for normal dispose')
  inContext(ready, () => {
    ready.popup.sync(ready.rows)
    assert.equal(ready.popup.focusRound(ready.rows[0].id), false)
  })
  await repeatReady(info)
  assert.deepEqual(counts(info), before)
  assert.equal(ready.entries.length, 1)
  await assertHidden(info, baseline, 'stopped-ready-window-cannot-present-again')
  disposeContext(ready)

  baseline = await foregroundBaseline(null, 'dispose-pending')
  const pending = makeContext('dispose-pending', [{ tail: true, holdReady: true }])
  const old = await start(pending, { focus: true })
  const call = await firstReady(old)
  await until(() => old.tail, 'dispose scenario really holds a load tail')
  disposeContext(pending)
  const outcome = await dispatchReady(call)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error.message, /无权访问便签提醒/)
  inContext(pending, () => {
    pending.popup.sync(pending.rows)
    assert.equal(pending.popup.focusRound(pending.rows[0].id), false)
  })
  await until(() => old.loadOutcome === 'rejected', 'dispose causes a real native load abort')
  assert.equal(pending.entries.length, 1)
  assert.deepEqual(counts(old), { showInactive: 0, show: 0, focus: 0 })
  assert.equal(old.tail.ended, false)
  await assertHidden(old, baseline, 'disposed-window-late-ready-is-rejected')
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

function finishTail(info) {
  const tail = info.tail
  assert.ok(tail && !tail.closed && !tail.ended, 'the native load response is still held')
  tail.ended = true
  record('tail-ended-after-real-ready', snapshot(info))
  tail.response.end('</body></html>')
}

async function startServer() {
  const formalHtml = readFileSync(join(rendererRoot, 'reminder.html'), 'utf8')
  writeFileSync(join(evidenceRoot, 'formal-reminder.html'), formalHtml, { flag: 'wx' })
  server = createServer((request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      const parts = path.split('/').filter(Boolean)
      const context = contexts.find((value) => value.caseId === parts[0])
      if (!context) throw new Error('Unknown owned fixture route: ' + path)
      if (parts[1] === '__tail') {
        const info = context.entries[Number(parts[2])]
        if (!info || !info.plan.tail || info.tail) throw new Error('Invalid or duplicate load tail')
        const key = context.caseId + ':' + info.index
        const tail = { key, response, ended: false, closed: false }
        info.tail = tail
        tails.set(key, tail)
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        response.write('<!doctype html><html><body>Controlled native reminder load tail')
        response.on('close', () => {
          tail.closed = true
          tails.delete(key)
          record('tail-response-closed', { key, ended: tail.ended })
        })
        record('tail-request-held', snapshot(info))
        return
      }
      const local = parts.slice(1).join('/')
      if (local === 'reminder.html') {
        const info = context.entries.find((value) => !value.documentServed)
        if (!info) throw new Error('No owned BrowserWindow for reminder document')
        info.documentServed = true
        const html = info.plan.tail
          ? formalHtml.replace(
              '</body>',
              `<iframe hidden aria-hidden="true" tabindex="-1" title="E2.4 controlled load tail" src="/${context.caseId}/__tail/${info.index}"></iframe></body>`
            )
          : formalHtml
        const name = `fixture-${context.caseId}-${info.index}.html`
        writeFileSync(join(evidenceRoot, name), html, { flag: 'wx' })
        artifacts.push(name)
        record('formal-document-served', {
          caseId: context.caseId,
          document: info.index,
          formalSha256: hash(formalHtml),
          servedSha256: hash(html),
          fixture: name,
          cspUnchanged: true,
          injectedSameOriginIframe: Boolean(info.plan.tail)
        })
        response.writeHead(200, { 'Content-Type': mimeTypes['.html'], 'Cache-Control': 'no-store' })
        response.end(html)
        return
      }
      const target = resolve(rendererRoot, local)
      if (!target.startsWith(rendererRoot + sep))
        throw new Error('Static route escapes formal renderer')
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(target)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      })
      response.end(readFileSync(target))
    } catch (error) {
      record('http-fixture-error', { error: errorDetails(error), url: request.url })
      response.writeHead(500, { 'Content-Type': 'text/plain' })
      response.end('Owned reminder fixture failed')
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    const closed = new Promise((done) => {
      socket.once('close', () => {
        sockets.delete(socket)
        socketClosures.delete(closed)
        done()
      })
    })
    socketClosures.add(closed)
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}/`
  record('fixture-http-listening', { baseUrl })
}

async function cleanupFixture() {
  const errors = []
  for (const context of contexts) {
    try {
      context.popup.dispose()
    } catch (error) {
      errors.push(context.caseId + ': ' + (error.stack || error.message))
    }
    for (const call of context.readyCalls) {
      if (!call.dispatched) await dispatchReady(call)
    }
  }
  if (sentinel && !sentinel.isDestroyed()) sentinel.destroy()
  const serverClosed = server?.listening
    ? new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())))
    : Promise.resolve()
  for (const tail of tails.values()) tail.response.destroy()
  for (const socket of sockets) socket.destroy()
  await serverClosed
  await Promise.all([...socketClosures])
  const state = {
    status: 'complete',
    errors,
    contexts: contexts.map((context) => ({
      caseId: context.caseId,
      handlersRemaining: context.handlers.size,
      windowsDestroyed: context.entries.every((info) => info.window.isDestroyed()),
      readyContinuationsSettled: context.readyCalls.every((call) => call.outcome !== 'pending')
    })),
    browserWindowsRemaining: BrowserWindow.getAllWindows().length,
    sentinelDestroyed: !sentinel || sentinel.isDestroyed(),
    serverClosed: !server?.listening,
    heldResponsesRemaining: tails.size,
    socketsRemaining: sockets.size,
    profileOwnership: profile.ownership,
    scope:
      'Isolated reminder service, IPC handlers, windows and loopback HTTP; no product shutdown claim'
  }
  if (
    errors.length ||
    state.browserWindowsRemaining ||
    !state.sentinelDestroyed ||
    !state.serverClosed ||
    state.heldResponsesRemaining ||
    state.socketsRemaining ||
    state.contexts.some(
      (context) =>
        context.handlersRemaining || !context.windowsDestroyed || !context.readyContinuationsSettled
    )
  )
    state.status = 'failed'
  record('fixture-cleanup', state)
  return state
}

const suiteWatchdog = setTimeout(() => {
  suiteTimedOut = true
  exitCode = 1
  failure ||= new Error('The initial 120-second reminder fixture budget was exceeded')
  record('suite-budget-exceeded', { timeoutMs: 120000, owner: 'runner-external-diagnostics' })
  process.exitCode = 1
  // Keep the failed process intact for the runner's external diagnostics. A
  // watchdog never destroys product windows and then reports a successful exit.
}, 120000)

async function runTests() {
  try {
    assert.equal(process.platform, 'win32')
    assert.equal(process.arch, 'x64')
    sourceBefore = sourceHashes()
    writeJson('source-hashes.json', sourceBefore)
    writeFileSync(
      join(evidenceRoot, 'executed-reminder-initialization-electron.mjs'),
      readFileSync(fileURLToPath(import.meta.url)),
      { flag: 'wx' }
    )
    await startServer()
    sentinel = new BrowserWindow({
      width: 260,
      height: 130,
      x: 30,
      y: 50,
      show: false,
      title: 'Reminder initialization foreground sentinel',
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
    })
    sentinelHandle = handleOf(sentinel)
    await sentinel.loadURL(
      'data:text/html,<title>Reminder foreground sentinel</title>Foreground sentinel'
    )
    await runScenario('ready-before-load', readyBeforeLoad)
    await runScenario('load-before-ready-pending-focus', loadBeforeReadyWithFocus)
    await runScenario('hide-reentry-and-dismiss-failure', hideDuringPendingWithReentry)
    await runScenario('pending-close-and-ready-close', closePendingThenRecover)
    await runScenario('destroy-and-immediate-replacement', destroyThenReplace)
    await runScenario('original-timeout-and-next-sync-recovery', timeoutThenRecover)
    await runScenario('stop-pending-presentation', stopPendingPresentation)
    await runScenario('stop-ready-and-dispose-pending', stopReadyAndDisposePending)
    assert.equal(scenarios.length, 8)
    assert.ok(scenarios.every((scenario) => scenario.status === 'passed'))
    assert.equal(suiteTimedOut, false, 'the initial suite budget was not exceeded')
    assert.deepEqual(sourceHashes(), sourceBefore, 'executed source and products remain unchanged')
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    const details = {
      error: errorDetails(error),
      scenario: currentScenario,
      windows: [...windows.values()].map(snapshot),
      contexts: contexts.map((context) => ({ caseId: context.caseId, errors: context.errors }))
    }
    writeJson('first-failure.json', details)
    artifacts.push('first-failure.json')
    record('business-failure', details)
    console.error(error)
    try {
      const last = contexts.at(-1)?.entries.at(-1)
      if (sentinel) await nativeState(last, 'first-failure-before-owned-cleanup')
    } catch (diagnosticError) {
      record('first-failure-native-diagnostic-failed', { error: errorDetails(diagnosticError) })
    }
  } finally {
    clearTimeout(suiteWatchdog)
    try {
      cleanup = await cleanupFixture()
      if (cleanup.status !== 'complete') exitCode = 1
    } catch (error) {
      cleanup = { status: 'failed', error: errorDetails(error) }
      exitCode = 1
      console.error(error)
    }
    if (profile.ownership === 'script') {
      cleanup.preservedProfile = profile.directory
      if (cleanup.status === 'complete') cleanup.status = 'preserved'
    }
    try {
      writeJson('business-result.json', {
        suite,
        mode,
        completed,
        failure: failure ? errorDetails(failure) : null,
        assertions: recorder.report({ cleanup }).assertions,
        scenarios,
        cleanup,
        profile: profile.directory,
        profileOwnership: profile.ownership,
        productShutdownCovered: false,
        sourcesUnchanged: sourceBefore
          ? JSON.stringify(sourceHashes()) === JSON.stringify(sourceBefore)
          : false
      })
      evidence = {
        status: 'complete',
        artifacts,
        scope: 'Raw real-window events, business assertions and fixture exit'
      }
    } catch (error) {
      evidence = { status: 'failed', error: errorDetails(error), artifacts }
      exitCode = 1
      console.error(error)
    }
    record('fixture-normal-quit-requested', { exitCode, completed, cleanup, evidence })
    process.exitCode = exitCode
    app.quit()
  }
}

app.once('will-quit', () => {
  reachedWillQuit = true
  record('fixture-will-quit', { exitCode })
})
app.once('quit', (_event, code) => {
  try {
    const exit = { requestedExitCode: exitCode, observedQuitCode: code, reachedWillQuit }
    record('fixture-quit', exit)
    writeJson('exit-result.json', exit)
    if (!exitCode) {
      assert.equal(reachedWillQuit, true)
      assert.equal(code, 0)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
    }
    recorder.finish({
      completed,
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
