// Real app motion comparison. No injected stalls or unagreed performance budgets.
import { createHash } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, release } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, contentTracing, dialog, screen } from 'electron'
import koffi from 'koffi'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const gpuReadProbeEnabled = process.env.ABANDON_MOTION_GPU_READ_PROBE === '1'
const gpuQueryBasicSubstitution =
  gpuReadProbeEnabled && process.env.ABANDON_MOTION_GPU_QUERY_LEVEL === 'basic'
const inputTraceEnabled = process.env.ABANDON_MOTION_INPUT_TRACE === '1' || gpuReadProbeEnabled
const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/logging-motion-overhead-electron.mjs',
  mode: gpuReadProbeEnabled
    ? 'electron-real-app-gpu-diagnostic-export-probe'
    : 'electron-real-app-motion-diagnostic-overhead',
  prefix: 'abandon-motion-overhead-',
  timeoutMs: 240000,
  metadata: {
    actualApp: true,
    chromiumMouseInput: false,
    mouseInput: gpuReadProbeEnabled ? 'none' : 'win32-sendinput-absolute-virtual-desktop',
    physicalCursorPositioned: !gpuReadProbeEnabled,
    realNativeEdgeTrigger: !gpuReadProbeEnabled,
    injectedStalls: false,
    performanceBudget: null,
    customerMachineRootCause: false,
    dwmPresentationMeasured: false,
    systemSaveDialog: 'controlled-response',
    fixturePreparation: 'owned-sqlite-before-app-start',
    chromiumInputTrace: inputTraceEnabled,
    gpuReadProbe: gpuReadProbeEnabled,
    testOnlyGpuQuerySubstitution: gpuQueryBasicSubstitution,
    diagnosticOnly: inputTraceEnabled,
    overheadAcceptanceAllowed: !inputTraceEnabled
  }
})
const { assert, root } = lifecycle
const evidenceRoot = process.env.ABANDON_TEST_EVIDENCE_DIR || root
const inputTrace = {
  enabled: inputTraceEnabled,
  diagnosticOnly: inputTraceEnabled,
  overheadAcceptanceAllowed: !inputTraceEnabled,
  recording: false,
  status: inputTraceEnabled ? 'not-started' : 'disabled',
  categories: [
    'input',
    'cc',
    'viz',
    'gpu',
    'toplevel',
    'renderer',
    'disabled-by-default-cc.debug.scheduler',
    'blink.user_timing'
  ],
  recordMode: 'record-until-full',
  phaseMarkers: [],
  pressMarkers: []
}
const require = createRequire(import.meta.url)
const rounds = ['daily', 'deep', 'daily', 'deep', 'daily', 'deep']
const samples = []
const exports = []
const stoppedCollectors = []
const operationTraces = []
const resourceMeasurements = []
const rendererFailures = []
const rendererConsole = []
const preparationChecks = []
const inputStateChecks = []
const routingReadChecks = []
const nativeWindowMessages = []
const electronInputEvents = []
const electronInputObservers = new Map()
const knownLegacyWindows = new Map()
const observedWindowMessages = new Map([
  [0x0200, 'WM_MOUSEMOVE'],
  [0x0201, 'WM_LBUTTONDOWN'],
  [0x0202, 'WM_LBUTTONUP']
])
const user32 = koffi.load('user32.dll')
const getAsyncKeyState = user32.func('short GetAsyncKeyState(int vKey)')
const getSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)')
const mouseInput = koffi.struct({
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t'
})
const win32Input = koffi.struct({
  type: 'uint32_t',
  u: koffi.union({ mi: mouseInput })
})
const sendInput = user32.func('SendInput', 'uint', ['uint', koffi.pointer(win32Input), 'int'])
const nativePoint = koffi.struct({ x: 'long', y: 'long' })
const windowFromPoint = user32.func('WindowFromPoint', 'uintptr_t', [nativePoint])
const getAncestor = user32.func('uintptr_t GetAncestor(uintptr_t hwnd, uint flags)')
const getWindow = user32.func('uintptr_t GetWindow(uintptr_t hwnd, uint command)')
const getParent = user32.func('uintptr_t GetParent(uintptr_t hwnd)')
const isWindow = user32.func('int IsWindow(uintptr_t hwnd)')
const isWindowVisible = user32.func('int IsWindowVisible(uintptr_t hwnd)')
const getClassName = user32.func('int GetClassNameW(uintptr_t hwnd, void *name, int capacity)')
const nativeRect = koffi.struct({ left: 'long', top: 'long', right: 'long', bottom: 'long' })
const getWindowRect = user32.func('GetWindowRect', 'int', [
  'uintptr_t',
  koffi.out(koffi.pointer(nativeRect))
])
const getWindowThreadProcessId = user32.func(
  'uint GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint *processId)'
)
const nativeGuiInfo = koffi.struct({
  cbSize: 'uint32_t',
  flags: 'uint32_t',
  hwndActive: 'uintptr_t',
  hwndFocus: 'uintptr_t',
  hwndCapture: 'uintptr_t',
  hwndMenuOwner: 'uintptr_t',
  hwndMoveSize: 'uintptr_t',
  hwndCaret: 'uintptr_t',
  rcCaret: koffi.struct({ left: 'long', top: 'long', right: 'long', bottom: 'long' })
})
const getGuiThreadInfo = user32.func('GetGUIThreadInfo', 'int', [
  'uint',
  koffi.inout(koffi.pointer(nativeGuiInfo))
])
const getLastError = koffi.load('kernel32.dll').func('uint GetLastError()')
const moveDeltas = [12, 24, 40, 60, 84, 112, 144, 180, 144, 112, 84, 60, 40, 24, 12, 0]
const settings = {
  fixtureNotes: 60,
  windowSize: { width: 480, height: 640 },
  titlebarStyle: 'apple',
  zOrderMode: 'normal',
  blurEnabled: true,
  enabledEdges: ['left'],
  revealHandleMode: 'direct',
  requestedInputIntervalMs: 16,
  measuredDragGestures: 2,
  measuredDockCycles: 2,
  minimumDragPressIntervalMs: 500,
  pollingIntervalMs: 20
}
let currentWindow
let originalCursor
let mouseHeld = false
let lastInput
let nativeDll
let drainNative
let hooks
let fixtureIds = []
let comparison = null
let probeResult = null
let originalGetGpuInfo = null
let tailEvidence = null
let activePhase = 'setup'
let lastDragPressAt = null
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function js(source) {
  const phase = activePhase
  try {
    const result = await currentWindow.webContents.executeJavaScript(`(async () => {
      try { return { ok: true, value: await (${source}) } }
      catch (error) { return { ok: false, error: { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || null } } }
    })()`)
    if (!result.ok) {
      const error = new Error(result.error.message)
      error.name = result.error.name
      error.stack = result.error.stack || error.stack
      throw error
    }
    return result.value
  } catch (error) {
    rendererFailures.push({
      phase,
      at: performance.now(),
      source,
      error: error.stack || error.message
    })
    throw new Error('Renderer evaluation failed in ' + phase + ': ' + error.message, {
      cause: error
    })
  }
}

async function startInputTrace() {
  if (!inputTraceEnabled || inputTrace.recording || inputTrace.status !== 'not-started') return
  inputTrace.status = 'starting'
  await contentTracing.startRecording({
    included_categories: inputTrace.categories,
    record_mode: inputTrace.recordMode
  })
  inputTrace.recording = true
  inputTrace.status = 'recording'
  inputTrace.startedAt = performance.now()
}

function installGpuQuerySubstitution() {
  if (!gpuQueryBasicSubstitution) return
  originalGetGpuInfo = app.getGPUInfo
  app.getGPUInfo = async (requestedLevel) => {
    const effectiveLevel = requestedLevel === 'complete' ? 'basic' : requestedLevel
    const observation = {
      requestedLevel,
      effectiveLevel,
      testOnlySubstitution: true,
      startedAt: performance.now(),
      status: 'running'
    }
    probeResult.gpuQueries.push(observation)
    try {
      const result = await originalGetGpuInfo.call(app, effectiveLevel)
      observation.status = 'complete'
      observation.resultKeys = Object.keys(result)
      return result
    } catch (error) {
      observation.status = 'failed'
      observation.error = error.stack || error.message
      throw error
    } finally {
      observation.elapsedMs = performance.now() - observation.startedAt
    }
  }
}

async function markTracePhase() {
  if (!inputTrace.recording) return
  const marker = { phase: activePhase, mainAt: performance.now() }
  inputTrace.phaseMarkers.push(marker)
  marker.rendererAt = await js(`(() => {
    window.__motionOverheadTracePhase = ${JSON.stringify(activePhase)}
    const at = performance.now()
    performance.mark('motion.phase:' + window.__motionOverheadTracePhase)
    return at
  })()`)
}

async function stopInputTrace() {
  if (!inputTrace.recording) return
  try {
    inputTrace.bufferUsage = await contentTracing.getTraceBufferUsage()
  } catch (error) {
    inputTrace.bufferUsageError = error.message
  }
  try {
    inputTrace.filePath = await contentTracing.stopRecording(
      join(evidenceRoot, 'motion-input-chromium-trace.json')
    )
    const content = await readFile(inputTrace.filePath)
    inputTrace.bytes = content.byteLength
    inputTrace.sha256 = createHash('sha256').update(content).digest('hex')
    inputTrace.status = 'stopped'
  } catch (error) {
    inputTrace.status = 'stop-failed'
    inputTrace.error = error.stack || error.message
    throw error
  } finally {
    inputTrace.recording = false
    inputTrace.finishedAt = performance.now()
  }
}
const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null)
const captureOf = (record) => record.captureId || record.metadata?.captureId
const motionScopes = new Set([
  'performance.window-drag-main',
  'performance.window-drag-renderer',
  'performance.window-dock-animation',
  'performance.window-motion-native'
])

async function until(predicate, message, timeoutMs = 10000) {
  const startedAt = performance.now()
  let polls = 0
  while (performance.now() - startedAt < timeoutMs) {
    polls++
    const result = await predicate()
    if (result) return { result, polls, elapsedMs: performance.now() - startedAt }
    await wait(settings.pollingIntervalMs)
  }
  throw new Error(message)
}

function positionCursor(point) {
  const startedAt = performance.now()
  const physical = screen.dipToScreenPoint(point)
  const virtualScreen = {
    x: getSystemMetrics(76),
    y: getSystemMetrics(77),
    width: getSystemMetrics(78),
    height: getSystemMetrics(79)
  }
  assert.ok(
    virtualScreen.width > 1 && virtualScreen.height > 1,
    'physical virtual desktop is unavailable'
  )
  assert.ok(
    physical.x >= virtualScreen.x &&
      physical.x < virtualScreen.x + virtualScreen.width &&
      physical.y >= virtualScreen.y &&
      physical.y < virtualScreen.y + virtualScreen.height,
    'cursor target lies outside physical virtual desktop'
  )
  const normalized = {
    x: Math.round(((physical.x - virtualScreen.x) * 65535) / (virtualScreen.width - 1)),
    y: Math.round(((physical.y - virtualScreen.y) * 65535) / (virtualScreen.height - 1))
  }
  const flags = 0x0001 | 0x8000 | 0x4000
  const accepted = sendInput(
    1,
    [
      {
        type: 0,
        u: {
          mi: {
            dx: normalized.x,
            dy: normalized.y,
            mouseData: 0,
            dwFlags: flags,
            time: 0,
            dwExtraInfo: 0
          }
        }
      }
    ],
    koffi.sizeof(win32Input)
  )
  const observedDip = screen.getCursorScreenPoint()
  const observedPhysical = screen.dipToScreenPoint(observedDip)
  lastInput = {
    type: 'mouseMove',
    api: 'SendInput',
    requested: 1,
    accepted,
    flags,
    normalized,
    virtualScreen,
    physical,
    observedDip,
    observedPhysical,
    leftButtonDown: (getAsyncKeyState(1) & 0x8000) !== 0
  }
  lastInput.elapsedMs = performance.now() - startedAt
  assert.equal(accepted, 1, 'physical cursor positioning failed')
  assert.ok(
    Math.abs(observedPhysical.x - physical.x) <= 1 &&
      Math.abs(observedPhysical.y - physical.y) <= 1,
    'accepted absolute mouse input did not position physical cursor within one pixel'
  )
  return { dip: point, ...lastInput }
}

function observeNativeInput(includeChildren = false) {
  const startedAt = performance.now()
  const mainHwnd = currentWindow.getNativeWindowHandle().readBigUInt64LE()
  const readWindow = (hwnd) => {
    const processId = [0]
    const threadId = getWindowThreadProcessId(hwnd, processId)
    return {
      hwnd: String(hwnd),
      root: String(getAncestor(hwnd, 2)),
      threadId,
      processId: processId[0]
    }
  }
  const main = readWindow(mainHwnd)
  const cursor = screen.dipToScreenPoint(screen.getCursorScreenPoint())
  const readGui = (threadId) => {
    const info = { cbSize: koffi.sizeof(nativeGuiInfo) }
    const accepted = getGuiThreadInfo(threadId, info)
    const error = accepted ? null : getLastError()
    return {
      accepted,
      error,
      flags: info.flags ?? null,
      active: String(info.hwndActive ?? 0),
      focus: String(info.hwndFocus ?? 0),
      capture: String(info.hwndCapture ?? 0),
      menuOwner: String(info.hwndMenuOwner ?? 0),
      moveSize: String(info.hwndMoveSize ?? 0)
    }
  }
  const observation = {
    main,
    cursor,
    hit: readWindow(windowFromPoint(cursor)),
    foregroundGui: readGui(0),
    mainGui: readGui(main.threadId)
  }
  if (includeChildren) {
    const children = []
    const visited = new Set()
    const readChildren = (parent, depth) => {
      let child = getWindow(parent, 5)
      while (String(child) !== '0' && children.length < 32 && depth < 5) {
        const identity = String(child)
        if (visited.has(identity)) break
        visited.add(identity)
        const name = Buffer.alloc(512)
        const characters = getClassName(child, name, 256)
        const rect = {}
        const rectAccepted = getWindowRect(child, rect)
        const className = name.toString('utf16le', 0, Math.max(0, characters) * 2)
        if (className === 'Chrome_RenderWidgetHostHWND' && !knownLegacyWindows.has(identity))
          knownLegacyWindows.set(identity, {
            hwnd: child,
            firstSeenAt: performance.now(),
            originalParent: String(parent)
          })
        children.push({
          ...readWindow(child),
          parent: String(parent),
          depth,
          className,
          visible: Boolean(isWindowVisible(child)),
          rectAccepted,
          rect
        })
        readChildren(child, depth + 1)
        child = getWindow(child, 2)
      }
    }
    readChildren(mainHwnd, 0)
    observation.children = children
    observation.childrenLimitReached = children.length >= 32
    observation.knownLegacyWindows = [...knownLegacyWindows.values()].map((entry) => {
      const parent = getParent(entry.hwnd)
      const name = Buffer.alloc(512)
      const characters = getClassName(parent, name, 256)
      const rect = {}
      const rectAccepted = getWindowRect(entry.hwnd, rect)
      return {
        hwnd: String(entry.hwnd),
        firstSeenAt: entry.firstSeenAt,
        originalParent: entry.originalParent,
        alive: Boolean(isWindow(entry.hwnd)),
        parent: String(parent),
        parentClass: name.toString('utf16le', 0, Math.max(0, characters) * 2),
        visible: Boolean(isWindowVisible(entry.hwnd)),
        rectAccepted,
        rect
      }
    })
  }
  return { ...observation, startedAt, elapsedMs: performance.now() - startedAt }
}

function physicalButton(down) {
  const startedAt = performance.now()
  const flags = down ? 0x0002 : 0x0004
  const accepted = sendInput(
    1,
    [
      {
        type: 0,
        u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } }
      }
    ],
    koffi.sizeof(win32Input)
  )
  // Track an accepted press before assertions, so every failure releases it in finally.
  if (accepted === 1) mouseHeld = down
  lastInput = {
    type: down ? 'mouseDown' : 'mouseUp',
    api: 'SendInput',
    requested: 1,
    accepted,
    flags,
    cursor: screen.getCursorScreenPoint(),
    leftButtonDown: (getAsyncKeyState(1) & 0x8000) !== 0
  }
  assert.equal(accepted, 1, 'Windows did not accept the physical mouse button input')
  lastInput.elapsedMs = performance.now() - startedAt
  return { ...lastInput }
}

async function observeInputState(label) {
  const startedAt = performance.now()
  const observation = {
    label,
    phase: activePhase,
    startedAt,
    cursor: screen.getCursorScreenPoint(),
    leftButtonDown: (getAsyncKeyState(1) & 0x8000) !== 0,
    lastInput: lastInput ? { ...lastInput } : null
  }
  observation.native = observeNativeInput()
  inputStateChecks.push(observation)
  try {
    observation.renderer = await js(`new Promise((resolve, reject) => {
      const startedAt = performance.now()
      let frame
      const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('input-state observation did not receive two animation frames')) }, 2500)
      frame = requestAnimationFrame(firstAt => { frame = requestAnimationFrame(secondAt => {
        clearTimeout(timer)
        const titlebar = document.querySelector('.app-titlebar')
        resolve({ startedAt, firstAt, secondAt, elapsedMs: performance.now() - startedAt, documentHasFocus: document.hasFocus(), visibilityState: document.visibilityState, pointerCaptured: Boolean(titlebar?.hasPointerCapture(1)), pointers: window.__motionOverheadEvents, hover: window.__motionOverheadHover })
      }) })
    })`)
  } catch (error) {
    observation.error = error.stack || error.message
    throw error
  } finally {
    observation.elapsedMs = performance.now() - startedAt
  }
}

function readFixture() {
  const db = new Database(join(root, 'app.db'), { readonly: true })
  try {
    return db
      .prepare('SELECT id FROM notes ORDER BY id')
      .all()
      .map((row) => row.id)
  } finally {
    db.close()
  }
}

function captureResources() {
  const startedAt = performance.now()
  const metrics = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    creationTime: metric.creationTime,
    type: metric.type,
    name: metric.name || null,
    cumulativeCpuSeconds: metric.cpu?.cumulativeCPUUsage ?? null,
    workingSetKiB: metric.memory?.workingSetSize ?? null,
    privateKiB: metric.memory?.privateBytes ?? null
  }))
  return {
    startedAt,
    finishedAt: performance.now(),
    rendererPid: currentWindow?.webContents.getOSProcessId() ?? null,
    mainCpuMicroseconds: process.cpuUsage(),
    mainMemoryBytes: process.memoryUsage(),
    metrics
  }
}

function resourceDelta(before, after) {
  const elapsedMs = after.startedAt - before.startedAt
  const previous = new Map(before.metrics.map((metric) => [metric.pid, metric]))
  const next = new Set(after.metrics.map((metric) => metric.pid))
  const processChanges = []
  const processes = after.metrics.map((metric) => {
    const old = previous.get(metric.pid)
    let unavailableReason = null
    if (!old) unavailableReason = 'new-process'
    else if (old.creationTime !== metric.creationTime) unavailableReason = 'pid-reused'
    else if (
      !Number.isFinite(old.cumulativeCpuSeconds) ||
      !Number.isFinite(metric.cumulativeCpuSeconds)
    )
      unavailableReason = 'cpu-counter-unavailable'
    else if (metric.cumulativeCpuSeconds < old.cumulativeCpuSeconds)
      unavailableReason = 'cpu-counter-regressed'
    if (unavailableReason) processChanges.push({ pid: metric.pid, reason: unavailableReason })
    const cpuSeconds = unavailableReason
      ? null
      : metric.cumulativeCpuSeconds - old.cumulativeCpuSeconds
    const memoryDelta = (key) =>
      old?.creationTime === metric.creationTime &&
      Number.isFinite(old[key]) &&
      Number.isFinite(metric[key])
        ? metric[key] - old[key]
        : null
    return {
      pid: metric.pid,
      creationTime: metric.creationTime,
      type: metric.type,
      cpuSeconds,
      cpuPercentOneCore: cpuSeconds === null ? null : round((cpuSeconds * 100000) / elapsedMs),
      unavailableReason,
      workingSetDeltaKiB: memoryDelta('workingSetKiB'),
      privateDeltaKiB: memoryDelta('privateKiB')
    }
  })
  for (const metric of before.metrics) {
    if (!next.has(metric.pid)) processChanges.push({ pid: metric.pid, reason: 'process-exited' })
  }
  const knownCpuSeconds = processes.reduce((sum, metric) => sum + (metric.cpuSeconds ?? 0), 0)
  const mainCpu = Object.fromEntries(
    ['user', 'system'].map((key) => [
      key,
      after.mainCpuMicroseconds[key] - before.mainCpuMicroseconds[key]
    ])
  )
  const renderer =
    before.rendererPid === after.rendererPid
      ? processes.find((metric) => metric.pid === after.rendererPid)
      : null
  return {
    elapsedMs,
    cpuUnit: 'percent-of-one-logical-core',
    allProcessesCpuComplete: processChanges.length === 0,
    knownProcessesCpuSeconds: knownCpuSeconds,
    allProcessesCpuPercentOneCore:
      processChanges.length === 0 ? round((knownCpuSeconds * 100000) / elapsedMs) : null,
    mainCpuMicroseconds: mainCpu,
    mainCpuPercentOneCore: round(((mainCpu.user + mainCpu.system) / (elapsedMs * 1000)) * 100),
    rendererCpuPercentOneCore: renderer?.cpuPercentOneCore ?? null,
    rendererWorkingSetDeltaKiB: renderer?.workingSetDeltaKiB ?? null,
    rendererPrivateDeltaKiB: renderer?.privateDeltaKiB ?? null,
    mainMemoryDeltaBytes: Object.fromEntries(
      Object.keys(after.mainMemoryBytes).map((key) => [
        key,
        after.mainMemoryBytes[key] - before.mainMemoryBytes[key]
      ])
    ),
    processChanges,
    processes
  }
}

async function measure(operation) {
  const before = captureResources()
  const startedAt = performance.now()
  const measurement = { phase: activePhase, status: 'running', startedAt, before }
  resourceMeasurements.push(measurement)
  try {
    const result = await operation()
    const finishedAt = performance.now()
    const after = captureResources()
    Object.assign(measurement, {
      status: 'complete',
      finishedAt,
      elapsedMs: finishedAt - startedAt,
      after,
      resources: resourceDelta(before, after)
    })
    return { ...measurement, result }
  } catch (error) {
    measurement.status = 'partial'
    measurement.finishedAt = performance.now()
    measurement.error = error.stack || error.message
    throw error
  }
}

async function logInventory() {
  // query uses the production writer barrier; disk reads occur outside motion timing.
  await js('window.api.queryLogs({ limit: 1 })')
  const directory = join(root, 'logs')
  const files = []
  for (const name of (await readdir(directory)).sort()) {
    if (!/^(app|detail)-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(name)) continue
    const content = await readFile(join(directory, name))
    const lines = content.toString('utf8').split('\n').filter(Boolean)
    for (const line of lines) JSON.parse(line)
    files.push({
      name,
      bytes: content.byteLength,
      records: lines.length,
      sha256: createHash('sha256').update(content).digest('hex')
    })
  }
  return {
    capturedAt: new Date().toISOString(),
    files,
    bytes: files.reduce((n, file) => n + file.bytes, 0),
    records: files.reduce((n, file) => n + file.records, 0)
  }
}

function inventoryDelta(before, after) {
  const previous = new Map(before.files.map((file) => [file.name, file]))
  const current = new Set(after.files.map((file) => file.name))
  return {
    bytes: after.bytes - before.bytes,
    records: after.records - before.records,
    removedFiles: before.files.filter((file) => !current.has(file.name)).map((file) => file.name),
    files: after.files.map((file) => ({
      name: file.name,
      bytes: file.bytes - (previous.get(file.name)?.bytes || 0),
      records: file.records - (previous.get(file.name)?.records || 0)
    })),
    interval: 'motion plus production end-export/freeze/flush; warmup and pre-export excluded'
  }
}

async function exportLogs(name) {
  const filePath = join(evidenceRoot, name + '.jsonl')
  const original = dialog.showSaveDialog
  const startedAt = performance.now()
  if (inputTrace.recording)
    await js(`performance.mark(${JSON.stringify('motion.export.begin:' + name)})`)
  try {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    const response = await js('window.api.exportLogs({ range: "all" })')
    assert.equal(response.filePath, filePath, 'production log export did not use owned target')
  } finally {
    dialog.showSaveDialog = original
    if (inputTrace.recording)
      await js(`performance.mark(${JSON.stringify('motion.export.end:' + name)})`)
  }
  const elapsedMs = performance.now() - startedAt
  const content = await readFile(filePath)
  const records = content.toString('utf8').trim().split('\n').map(JSON.parse)
  const systemRecord = records.find((record) => record.type === 'diagnostic-system')
  const snapshot = systemRecord?.snapshot
  assert.ok(
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot),
    name + ': production system snapshot missing'
  )
  const graphics = snapshot.graphics
  assert.ok(
    graphics && typeof graphics === 'object' && !Array.isArray(graphics),
    name + ': production graphics snapshot missing'
  )
  assert.equal(graphics.collectionLevel, 'basic', name + ': graphics collection level differs')
  assert.equal(
    graphics.adapterSelection,
    'not-collected',
    name + ': graphics adapter selection must remain uncollected'
  )
  assert.equal(graphics.auxiliary, null, name + ': graphics auxiliary defaults must be omitted')
  assert.equal(
    graphics.auxiliaryStatus,
    'not-collected',
    name + ': graphics auxiliary collection status differs'
  )
  assert.ok(Array.isArray(graphics.devices), name + ': graphics devices must be an array')
  assert.ok(
    graphics.devices.some(
      (device) =>
        device &&
        (['vendorId', 'deviceId'].some((key) => Number.isInteger(device[key]) && device[key] > 0) ||
          (typeof device.deviceString === 'string' && device.deviceString.trim().length > 0))
    ),
    name + ': graphics devices lack a valid device identifier or name'
  )
  assert.ok(
    graphics.devices.every(
      (device) =>
        device &&
        typeof device === 'object' &&
        !Array.isArray(device) &&
        !Object.hasOwn(device, 'active')
    ),
    name + ': basic graphics devices must not report active adapter state'
  )
  assert.ok(
    graphics.featureStatus &&
      typeof graphics.featureStatus === 'object' &&
      !Array.isArray(graphics.featureStatus),
    name + ': graphics feature status must be an object'
  )
  const completion = records.find((record) => record.type === 'diagnostic-complete')
  assert.equal(completion?.complete, true, name + ': production export was incomplete')
  assert.equal(completion.exportFinished, true, name + ': export did not finish')
  assert.ok(
    completion.manifest.capture.windows.some(
      (entry) => entry.webContentsId === currentWindow.webContents.id && entry.status === 'complete'
    ),
    name + ': main renderer tail unconfirmed'
  )
  const summary = {
    name,
    filePath,
    elapsedMs,
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    graphics,
    completion
  }
  exports.push(summary)
  return { ...summary, records }
}

async function stateFor(mode) {
  const state = await js('window.api.getDiagnosticState()')
  assert.equal(
    state.mode,
    mode,
    'mode changed during controlled workload: ' +
      JSON.stringify({ reason: state.reason, mode: state.mode })
  )
  assert.equal(state.diagnostics.writer.status, 'ready', 'writer unavailable')
  for (const key of ['droppedRecords', 'writeErrors']) {
    assert.equal(Number(state.diagnostics.writer[key] || 0), 0, 'writer ' + key)
  }
  for (const key of ['rejectedBatches', 'rejectedRecords']) {
    assert.equal(Number(state.transport[key] || 0), 0, 'transport ' + key)
  }
  const producer = state.producers.find(
    (entry) => entry.webContentsId === currentWindow.webContents.id
  )
  assert.ok(producer, 'main diagnostic producer missing')
  assert.equal(producer.appliedEpoch, state.policyEpoch, 'main producer policy epoch differs')
  assert.equal(Number(producer.health?.droppedRecords || 0), 0, 'renderer dropped records')
  return state
}

async function setMode(mode) {
  const current = await js('window.api.getDiagnosticState()')
  if (current.mode === 'deep') await stopDeep()
  if (mode === 'deep') await js('window.api.startDeepDiagnostics()')
  await until(
    async () => {
      const state = await js('window.api.getDiagnosticState()')
      return (
        state.mode === mode &&
        state.producers.some(
          (entry) =>
            entry.webContentsId === currentWindow.webContents.id &&
            entry.appliedEpoch === state.policyEpoch
        )
      )
    },
    'renderer did not apply ' + mode + ' policy'
  )
  return stateFor(mode)
}

async function stopDeep() {
  const stopped = await js('window.api.stopDeepDiagnostics()')
  assert.equal(stopped.mode, 'daily', 'deep stop did not restore daily')
  // Only drain after the product stop/freeze has submitted its tail. Preserve any residue.
  const raw = drainNative()
  const parsed = JSON.parse(raw)
  stoppedCollectors.push({ capturedAt: new Date().toISOString(), state: stopped, raw, parsed })
  assert.equal(parsed.enabled, false, 'native collector remained enabled after stop')
  return stopped
}

async function resetWindow(base) {
  await js('window.api.setDockConfig({ enabledEdges: [], revealHandleMode: "direct" })')
  currentWindow.setBounds(base)
  currentWindow.show()
  currentWindow.focus()
  await until(
    () => currentWindow.isFocused() && currentWindow.isVisible(),
    'foreground main window unavailable'
  )
  await js('window.api.setDockConfig({ enabledEdges: ["left"], revealHandleMode: "direct" })')
  const content = { x: base.x + 100, y: base.y + 130 }
  positionCursor(content)
  await wait(100)
  // Configuration toasts naturally leave before timing begins; never hide them or bypass hit testing.
  const preparation = { phase: activePhase, startedAt: performance.now(), lastBlocked: null }
  preparationChecks.push(preparation)
  const ready = await until(async () => {
    const hit = await js(`(() => {
      const surface = document.querySelector('.app-titlebar-interaction-surface')
      if (!surface) return { ready: false, reason: 'titlebar missing' }
      const rect = surface.getBoundingClientRect()
      const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      const target = document.elementFromPoint(point.x, point.y)
      const toastCount = document.querySelectorAll('.msg-toast').length
      return { ready: toastCount === 0 && surface.contains(target), point, toastCount, target: target ? { tag: target.tagName, className: String(target.className) } : null }
    })()`)
    if (!hit.ready) preparation.lastBlocked = hit
    return hit.ready && hit
  }, 'configuration overlay did not release actual titlebar drag origin')
  Object.assign(preparation, {
    finishedAt: performance.now(),
    polls: ready.polls,
    ready: ready.result
  })
  // Observe compositor frame resumption after docking before steady-workload timing.
  // Retain this preparation wait separately rather than treating it as a motion sample.
  const frameStartedAt = performance.now()
  try {
    preparation.frameReady = await js(`new Promise((resolve, reject) => {
    const startedAt = performance.now()
    let frame
    const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('visible renderer did not resume two animation frames')) }, 2500)
    frame = requestAnimationFrame(firstAt => {
      frame = requestAnimationFrame(secondAt => {
        clearTimeout(timer)
        resolve({ startedAt, firstAt, secondAt, elapsedMs: performance.now() - startedAt, visibilityState: document.visibilityState, documentHasFocus: document.hasFocus() })
      })
    })
    })`)
  } catch (error) {
    preparation.frameFailure = {
      elapsedMs: performance.now() - frameStartedAt,
      error: error.stack || error.message
    }
    throw error
  }
}

async function fixedConfiguration() {
  const snapshot = await js('window.api.getSettingsSnapshot()')
  const values = snapshot.values
  assert.equal(values.appearance.titlebarStyle, settings.titlebarStyle)
  assert.equal(values.window.zOrderMode, settings.zOrderMode)
  assert.equal(values.blur.enabled, true)
  assert.deepEqual(values.dock.enabledEdges, settings.enabledEdges)
  assert.equal(values.dock.revealHandleMode, settings.revealHandleMode)
  assert.equal(currentWindow.isAlwaysOnTop(), false, 'normal HWND became topmost')
  const nativeZOrder = hooks.getWindowZOrderStatus()
  assert.equal(nativeZOrder.supported, true, 'native z-order status unavailable')
  assert.equal(nativeZOrder.enabled, false, 'normal window gained bottom anchoring')
  return { values, actualTopmost: currentWindow.isAlwaysOnTop(), nativeZOrder }
}

async function dragOnce({ activeExportName } = {}) {
  // Separate ordinary gestures from the product's intentional 420 ms double-click action.
  const pacingStartedAt = performance.now()
  const requestedPacingMs =
    lastDragPressAt === null
      ? 0
      : Math.max(0, settings.minimumDragPressIntervalMs - (pacingStartedAt - lastDragPressAt))
  if (requestedPacingMs > 0) await wait(requestedPacingMs)
  const pacingElapsedMs = performance.now() - pacingStartedAt
  const point = await js(`(() => {
    const surface = document.querySelector('.app-titlebar-interaction-surface')
    const rect = surface.getBoundingClientRect()
    const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    if (!surface.contains(document.elementFromPoint(point.x, point.y))) throw new Error('drag origin is occluded')
    window.__motionOverheadEvents = []
    window.__motionOverheadFrames = []
    window.__motionOverheadLongTasks = []
    window.__motionOverheadGestureStartedAt = performance.now()
    return point
  })()`)
  const start = currentWindow.getBounds()
  const origin = { x: start.x + point.x, y: start.y + point.y }
  const rawInput = []
  const trace = {
    phase: activePhase,
    operation: 'drag',
    status: 'running',
    start,
    origin,
    nativeMessageStartIndex: nativeWindowMessages.length,
    gesturePacing: { requestedPacingMs, elapsedMs: pacingElapsedMs },
    rawInput
  }
  trace.nativeBeforePress = observeNativeInput(true)
  operationTraces.push(trace)
  positionCursor(origin)
  await wait(40)
  trace.nativeAtPress = {
    ...observeNativeInput(),
    focused: currentWindow.isFocused(),
    leftButtonDown: (getAsyncKeyState(1) & 0x8000) !== 0,
    expectedCursor: screen.dipToScreenPoint(origin)
  }
  const pressState = trace.nativeAtPress
  const interference = []
  if (!pressState.focused) interference.push('owned window lost focus')
  if (pressState.foregroundGui.active !== pressState.main.hwnd)
    interference.push('foreign active HWND')
  if (pressState.foregroundGui.focus !== pressState.main.hwnd)
    interference.push('foreign focus HWND')
  if (pressState.hit.root !== pressState.main.hwnd) interference.push('foreign hit-test root HWND')
  if (
    Math.abs(pressState.cursor.x - pressState.expectedCursor.x) > 1 ||
    Math.abs(pressState.cursor.y - pressState.expectedCursor.y) > 1
  )
    interference.push('physical cursor moved from the owned drag origin')
  if (pressState.leftButtonDown) interference.push('physical left button already held')
  trace.pressGuard = { accepted: interference.length === 0, interference }
  if (interference.length) {
    trace.status = 'environment-interference'
    trace.refusedPhysicalPress = true
  }
  assert.deepEqual(
    interference,
    [],
    'environment-interference: refusing physical press without owned foreground/focus/hit/cursor; no focus recovery or input retry'
  )
  assert.equal(
    (getAsyncKeyState(1) & 0x8000) !== 0,
    false,
    'physical left mouse button already held; refusing test press'
  )
  const pressedAt = performance.now()
  trace.pressToPressMs = lastDragPressAt === null ? null : pressedAt - lastDragPressAt
  if (trace.pressToPressMs !== null)
    assert.ok(
      trace.pressToPressMs >= settings.minimumDragPressIntervalMs,
      'ordinary drag input would overlap the titlebar double-click interval'
    )
  trace.press = physicalButton(true)
  if (inputTrace.recording)
    inputTrace.pressMarkers.push({ phase: activePhase, mainAt: pressedAt, input: trace.press })
  lastDragPressAt = pressedAt
  await until(
    () =>
      hooks.dockCommands.resources().attached &&
      hooks.getDockRuntimeState().interactionSuspendCount > 0,
    'actual titlebar drag did not begin'
  )
  trace.nativeAfterBegin = observeNativeInput(true)
  const startedAt = performance.now()
  for (const delta of moveDeltas) {
    const target = { x: origin.x + delta, y: origin.y + Math.round(delta / 2) }
    const cursor = positionCursor(target)
    const sentAt = performance.now()
    rawInput.push({
      delta,
      sentAt,
      elapsedMs: sentAt - startedAt,
      cursor,
      input: { ...lastInput },
      native: observeNativeInput(),
      actualBounds: currentWindow.getBounds()
    })
    await wait(settings.requestedInputIntervalMs)
    rawInput.at(-1).observedAfterInterval = currentWindow.getBounds()
  }
  const movedThroughPath = rawInput.some((entry) => entry.observedAfterInterval.x - start.x >= 100)
  if (!movedThroughPath) {
    await recordMotionFailure(
      trace,
      new Error('gesture input completed without actual path movement')
    )
    // Observe Chromium's delayed input fallback without submitting another move or
    // treating any eventual delivery as a successful fixed-pace gesture.
    const firstMoveAt = rawInput[0].sentAt
    const lastMoveAt = rawInput.at(-1).sentAt
    const observation = {
      phase: activePhase + '/post-failure-observation',
      status: 'running',
      firstMoveAt,
      lastMoveAt,
      minimumElapsedSinceFirstMoveMs: 5300,
      minimumElapsedSinceLastMoveMs: 5300,
      noAdditionalInput: true,
      originalPathFailurePreserved: true,
      samples: []
    }
    trace.postFailureObservation = observation
    const read = async () => {
      const at = performance.now()
      observation.samples.push({
        at,
        elapsedSinceFirstMoveMs: at - firstMoveAt,
        elapsedSinceLastMoveMs: at - lastMoveAt,
        leftButtonDown: (getAsyncKeyState(1) & 0x8000) !== 0,
        cursor: screen.getCursorScreenPoint(),
        bounds: currentWindow.getBounds(),
        renderer: await js(`(() => ({
          at: performance.now(),
          pointerCount: window.__motionOverheadEvents.length,
          pointers: window.__motionOverheadEvents.slice(-10),
          frameCount: window.__motionOverheadFrames.length,
          lastFrame: window.__motionOverheadFrames.at(-1) || null,
          longTasks: window.__motionOverheadLongTasks,
          documentHasFocus: document.hasFocus(),
          visibilityState: document.visibilityState,
          pointerCaptured: Boolean(document.querySelector('.app-titlebar')?.hasPointerCapture(1))
        }))()`)
      })
    }
    try {
      while (performance.now() - lastMoveAt < observation.minimumElapsedSinceLastMoveMs) {
        await read()
        await wait(
          Math.min(
            250,
            Math.max(
              1,
              observation.minimumElapsedSinceLastMoveMs - (performance.now() - lastMoveAt)
            )
          )
        )
      }
      await read()
      observation.status = 'complete'
    } catch (error) {
      observation.status = 'observation-failed'
      observation.error = error.stack || error.message
    } finally {
      observation.finishedAt = performance.now()
      observation.elapsedSinceFirstMoveMs = observation.finishedAt - firstMoveAt
      observation.elapsedSinceLastMoveMs = observation.finishedAt - lastMoveAt
    }
  }
  assert.ok(
    movedThroughPath,
    'fixed-pace gesture returned to start without actually moving through its path'
  )
  await until(() => {
    const current = currentWindow.getBounds()
    return Math.abs(current.x - start.x) <= 1 && Math.abs(current.y - start.y) <= 1
  }, 'fixed-pace drag did not converge to its final input')
  let activeExport
  if (activeExportName) activeExport = await exportLogs(activeExportName)
  trace.release = physicalButton(false)
  await until(
    () =>
      js(
        'window.__motionOverheadEvents.some(event => event.type === "pointerup" && event.trusted)'
      ),
    'trusted pointerup missing'
  )
  const events = await js('window.__motionOverheadEvents')
  const rendererTiming = await js(
    '({ frames: window.__motionOverheadFrames, longTasks: window.__motionOverheadLongTasks, longTaskSupported: window.__motionOverheadLongTaskSupported })'
  )
  assert.ok(
    events.some(
      (event) =>
        event.type === 'pointermove' &&
        event.trusted &&
        (event.buttons & 1) === 1 &&
        event.screen.x - origin.x >= 100
    ),
    'trusted held-button movement did not follow the actual drag path'
  )
  assert.ok(
    events.some((event) => event.type === 'pointerdown' && event.trusted),
    'trusted pointerdown missing'
  )
  assert.equal(
    events.some((event) => event.type === 'pointercancel'),
    false,
    'native pointer canceled'
  )
  await until(
    () => hooks.getDockRuntimeState().interactionSuspendCount === 0,
    'drag did not release dock suspension'
  )
  const final = hooks.getDockRuntimeState()
  assert.equal(final.interactionSuspendCount, 0, 'drag did not release dock suspension')
  Object.assign(trace, {
    status: 'complete',
    finalBounds: currentWindow.getBounds(),
    events,
    rendererTiming,
    nativeWindowMessages: nativeWindowMessages.slice(trace.nativeMessageStartIndex)
  })
  return {
    start,
    finalBounds: currentWindow.getBounds(),
    rawInput,
    events,
    finalDock: final,
    activeExport
  }
}

async function recordMotionFailure(trace, error) {
  trace.status = 'failed'
  trace.error = error.stack || error.message
  const observation = {
    at: performance.now(),
    lastInput,
    mouseHeld,
    leftButtonDown: (getAsyncKeyState(1) & 0x8000) !== 0
  }
  observation.native = observeNativeInput(true)
  observation.nativeWindowMessages = nativeWindowMessages.slice(trace.nativeMessageStartIndex ?? 0)
  observation.electronInputEvents = electronInputEvents.filter(
    (entry) => entry.phase === trace.phase
  )
  trace.failureObservation = observation
  for (const [name, read] of Object.entries({
    bounds: () => currentWindow.getBounds(),
    cursor: () => screen.getCursorScreenPoint(),
    resources: () => hooks.dockCommands.resources(),
    runtime: () => hooks.getDockRuntimeState(),
    blur: () => hooks.getBlurRuntimeHealth()
  })) {
    try {
      observation[name] = read()
    } catch (readError) {
      observation[name] = { observationError: readError.stack || readError.message }
    }
  }
  try {
    observation.renderer = await js(`(async () => ({
      hover: window.__motionOverheadHover,
      pointers: window.__motionOverheadEvents,
      frames: window.__motionOverheadFrames,
      longTasks: window.__motionOverheadLongTasks,
      longTaskSupported: window.__motionOverheadLongTaskSupported,
      documentHasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      modalLabels: [...document.querySelectorAll('.app-modal-card')].map(modal => modal.getAttribute('aria-label')),
      diagnosticState: await window.api.getDiagnosticState()
    }))()`)
  } catch (readError) {
    observation.renderer = { observationError: readError.stack || readError.message }
  }
}

async function dockCycle(workArea, base) {
  const trace = { phase: activePhase, operation: 'dock-hide-reveal', status: 'running' }
  operationTraces.push(trace)
  currentWindow.setBounds({ ...base, x: workArea.x })
  const inside = {
    x: workArea.x + Math.floor(base.width / 2),
    y: base.y + Math.floor(base.height / 2)
  }
  trace.insideCursor = positionCursor(inside)
  await wait(100)
  trace.hoverBeforeLeave = await js('window.__motionOverheadHover')
  const beforeEvents = trace.hoverBeforeLeave.length
  const outside = { x: workArea.x + workArea.width - 30, y: base.y + Math.floor(base.height / 2) }
  const hideStartedAt = performance.now()
  const leaveCursor = positionCursor(outside)
  // One Windows input stream supplies both actual cursor movement and trusted hover.
  Object.assign(trace, { hideStartedAt, leaveCursor, leaveInput: { ...lastInput } })
  let hiddenWait
  try {
    hiddenWait = await until(() => {
      const bounds = currentWindow.getBounds()
      return (
        !hooks.dockCommands.resources().slideTimer &&
        bounds.x + bounds.width <= workArea.x &&
        bounds
      )
    }, 'real cursor leave did not finish dock hide')
  } catch (error) {
    await recordMotionFailure(trace, error)
    throw error
  }
  const hideElapsedMs = performance.now() - hideStartedAt
  const hidden = hooks.dockCommands.snapshot()
  Object.assign(trace, { hidden, hideElapsedMs, hiddenPolls: hiddenWait.polls })
  assert.equal(hidden.isDockHidden, true, 'window left screen without a hidden dock session')
  assert.equal(hidden.mainAtHiddenTarget, true, 'native hidden endpoint does not match')
  assert.equal(hidden.edgeMonitor.workerAlive, true, 'edge monitor did not remain alive')
  assert.equal(
    hidden.edgeMonitor.generation,
    hidden.sessionGeneration,
    'edge monitor generation differs'
  )
  const hover = (await js('window.__motionOverheadHover')).slice(beforeEvents)
  assert.ok(
    hover.some((event) => event.type === 'mouseleave' && event.trusted),
    'dock hide did not follow trusted mouseleave'
  )
  // Direct mode uses the real work-area edge. No hide/show or hover IPC invocation.
  const edge = { x: workArea.x, y: inside.y }
  const showStartedAt = performance.now()
  const edgeCursor = positionCursor(edge)
  Object.assign(trace, { showStartedAt, edgeCursor, hover })
  let shownWait
  try {
    shownWait = await until(() => {
      const bounds = currentWindow.getBounds()
      return (
        !hooks.dockCommands.resources().slideTimer && Math.abs(bounds.x - workArea.x) <= 1 && bounds
      )
    }, 'physical edge cursor did not finish native reveal')
  } catch (error) {
    await recordMotionFailure(trace, error)
    throw error
  }
  const showElapsedMs = performance.now() - showStartedAt
  const shown = hooks.dockCommands.snapshot()
  Object.assign(trace, { shown, showElapsedMs, shownPolls: shownWait.polls })
  assert.equal(shown.isDockHidden, false, 'dock stayed hidden after native reveal')
  assert.equal(shown.isSliding, false, 'dock reveal animation still running')
  assert.equal(shown.hasDockMotionSession, false, 'dock reveal did not release its session')
  assert.equal(shown.edgeMonitor.workerAlive, false, 'dock reveal left monitor alive')
  positionCursor(inside)
  trace.status = 'complete'
  return {
    hideElapsedMs,
    showElapsedMs,
    hideStartedAt,
    showStartedAt,
    hiddenPolls: hiddenWait.polls,
    shownPolls: shownWait.polls,
    leaveCursor,
    edgeCursor,
    hover,
    hidden,
    shown
  }
}

function verifyMotionRecords(mode, beforeExport, afterExport, captureId) {
  const previousIds = new Set(beforeExport.records.map((record) => record.id).filter(Boolean))
  const fresh = afterExport.records.filter((record) => record.id && !previousIds.has(record.id))
  const motion = fresh.filter((record) => motionScopes.has(record.scope))
  if (mode === 'daily')
    assert.equal(motion.length, 0, 'daily movement emitted detailed motion records')
  else {
    for (const scope of motionScopes) {
      assert.ok(
        motion.some((record) => record.scope === scope && captureOf(record) === captureId),
        'deep movement omitted ' + scope
      )
    }
    const native = motion.filter(
      (record) =>
        record.scope === 'performance.window-motion-native' && captureOf(record) === captureId
    )
    assert.ok(
      native.every(
        (record) => record.metadata.enabled === true && record.metadata.observations > 0
      ),
      'native collector status or observations missing'
    )
    assert.ok(
      native.some(
        (record) =>
          record.metadata.stages.move?.count > 0 && record.metadata.stages.staGeometry?.count > 0
      ),
      'actual paired native motion was not collected'
    )
  }
  return {
    freshRecords: fresh.length,
    motionRecords: motion,
    producerTail: afterExport.completion.manifest.capture,
    nativeCoverage: motion
      .filter((record) => record.scope === 'performance.window-motion-native')
      .map((record) => record.metadata.coverage),
    nativeCoverageComplete:
      mode === 'daily'
        ? null
        : motion
            .filter((record) => record.scope === 'performance.window-motion-native')
            .every((record) =>
              [
                'droppedMoves',
                'droppedGeometry',
                'droppedSnapshots',
                'associationContention'
              ].every((key) => record.metadata.coverage?.[key] === 0)
            )
  }
}

function buildComparison() {
  const selectors = {
    motionElapsedMs: (sample) => sample.motion.elapsedMs,
    dragElapsedMs: (sample) => sample.motion.result.drag.elapsedMs,
    dockElapsedMs: (sample) => sample.motion.result.dock.elapsedMs,
    mainCpuPercentOneCore: (sample) => sample.motion.resources.mainCpuPercentOneCore,
    allProcessesCpuPercentOneCore: (sample) =>
      sample.motion.resources.allProcessesCpuPercentOneCore,
    rendererCpuPercentOneCore: (sample) => sample.motion.resources.rendererCpuPercentOneCore,
    rendererWorkingSetDeltaKiB: (sample) => sample.motion.resources.rendererWorkingSetDeltaKiB,
    rendererPrivateDeltaKiB: (sample) => sample.motion.resources.rendererPrivateDeltaKiB,
    mainRssDeltaBytes: (sample) => sample.motion.resources.mainMemoryDeltaBytes.rss,
    logBytes: (sample) => sample.logs.delta.bytes,
    logRecords: (sample) => sample.logs.delta.records,
    exportElapsedMs: (sample) => sample.postExport.elapsedMs
  }
  const statistics = (values) => {
    const valid = values.filter(Number.isFinite).sort((a, b) => a - b)
    if (!valid.length)
      return { count: 0, missing: values.length, mean: null, median: null, min: null, max: null }
    const mid = Math.floor(valid.length / 2)
    return {
      count: valid.length,
      missing: values.length - valid.length,
      mean: round(valid.reduce((n, value) => n + value, 0) / valid.length),
      median: round(valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2),
      min: round(valid[0]),
      max: round(valid.at(-1))
    }
  }
  return Object.fromEntries(
    Object.entries(selectors).map(([key, select]) => {
      const daily = statistics(samples.filter((sample) => sample.mode === 'daily').map(select))
      const deep = statistics(samples.filter((sample) => sample.mode === 'deep').map(select))
      const delta =
        daily.median === null || deep.median === null ? null : round(deep.median - daily.median)
      const pairs = [0, 2, 4].map((index) => {
        const a = select(samples[index])
        const b = select(samples[index + 1])
        return {
          dailyRound: index + 1,
          deepRound: index + 2,
          daily: a,
          deep: b,
          delta: Number.isFinite(a) && Number.isFinite(b) ? round(b - a) : null
        }
      })
      return [
        key,
        {
          daily,
          deep,
          medianDelta: delta,
          medianRatio:
            daily.median > 0 && deep.median !== null ? round(deep.median / daily.median) : null,
          pairs
        }
      ]
    })
  )
}

function persistSamples(extra = {}) {
  writeFileSync(
    join(evidenceRoot, 'motion-overhead-samples.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        platform: process.platform,
        windows: release(),
        versions: process.versions,
        cpu: cpus()[0]?.model || null,
        logicalCores: cpus().length,
        nativeAbi: NATIVE_ABI_VERSION,
        settings,
        fixtureIds,
        displays: screen.getAllDisplays(),
        rounds,
        samples,
        operationTraces,
        resourceMeasurements,
        rendererFailures,
        rendererConsole,
        preparationChecks,
        inputStateChecks,
        routingReadChecks,
        nativeWindowMessages,
        electronInputEvents,
        inputTrace,
        probeResult,
        exports,
        stoppedCollectors,
        tailEvidence,
        ...extra
      },
      null,
      2
    )
  )
}

async function restore() {
  if (currentWindow && !currentWindow.isDestroyed()) {
    for (const [name, observer] of electronInputObservers)
      currentWindow.webContents.off(name, observer)
    for (const messageId of observedWindowMessages.keys())
      currentWindow.unhookWindowMessage(messageId)
    if (mouseHeld) physicalButton(false)
    const cleanup = []
    for (const source of [
      'window.api.stopDeepDiagnostics()',
      'window.api.setDockConfig({ enabledEdges: [], revealHandleMode: "direct" })',
      `(() => { window.__motionOverheadObserveHeld = false; cancelAnimationFrame(window.__motionOverheadFrame); window.__motionOverheadLongTaskObserver?.disconnect(); for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) window.removeEventListener(name, window.__recordMotionOverhead, true); for (const name of ['mouseenter', 'mouseleave']) document.removeEventListener(name, window.__recordMotionHover); })()`
    ]) {
      try {
        await js(source)
      } catch (error) {
        cleanup.push(error.message)
      }
    }
    if (originalCursor && !gpuReadProbeEnabled) positionCursor(originalCursor)
    if (cleanup.length) throw new Error('motion overhead cleanup failed: ' + cleanup.join('; '))
  } else {
    if (mouseHeld) physicalButton(false)
    if (originalCursor && !gpuReadProbeEnabled) positionCursor(originalCursor)
  }
}

async function run() {
  let completed = false
  let failure = null
  try {
    assert.equal(process.platform, 'win32')
    assert.equal(process.arch, 'x64')
    assert.equal(koffi.sizeof(win32Input), 40, 'Windows x64 INPUT ABI differs')
    if (!gpuReadProbeEnabled) {
      assert.equal(
        (getAsyncKeyState(1) & 0x8000) !== 0,
        false,
        'physical left mouse button already held; refusing GUI input'
      )
      originalCursor = screen.getCursorScreenPoint()
    }
    currentWindow = (
      await until(
        () =>
          BrowserWindow.getAllWindows().find(
            (window) =>
              !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
          ),
        'actual list main window missing'
      )
    ).result
    currentWindow.webContents.on('console-message', (details) => {
      if (rendererConsole.length >= 50) return
      rendererConsole.push({
        phase: activePhase,
        at: performance.now(),
        level: details.level,
        message: details.message,
        lineNumber: details.lineNumber,
        sourceId: details.sourceId
      })
    })
    for (const name of ['before-mouse-event', 'input-event']) {
      const observer = (event, input) => {
        if (electronInputEvents.length >= 6000) return
        const entry = {
          observer: name,
          phase: activePhase,
          at: performance.now(),
          type: input.type,
          x: input.x ?? null,
          y: input.y ?? null,
          globalX: input.globalX ?? null,
          globalY: input.globalY ?? null,
          modifiers: input.modifiers ?? null,
          defaultPrevented: Boolean(event.defaultPrevented)
        }
        electronInputEvents.push(entry)
        queueMicrotask(() => {
          entry.defaultPreventedAfterListeners = Boolean(event.defaultPrevented)
        })
      }
      electronInputObservers.set(name, observer)
      currentWindow.webContents.on(name, observer)
    }
    for (const [messageId, message] of observedWindowMessages) {
      assert.equal(
        currentWindow.isWindowMessageHooked(messageId),
        false,
        'owned message observer would replace an existing hook'
      )
      currentWindow.hookWindowMessage(messageId, (wParam, lParam) => {
        if (nativeWindowMessages.length >= 4000) return
        nativeWindowMessages.push({
          phase: activePhase,
          message,
          at: performance.now(),
          keys: Number(wParam.readBigUInt64LE()),
          client: { x: lParam.readInt16LE(0), y: lParam.readInt16LE(2) }
        })
      })
    }
    await until(
      () =>
        js(
          'Boolean(window.api?.getDiagnosticState && document.querySelector(".app-titlebar-interaction-surface"))'
        ),
      'actual preload/titlebar not ready'
    )
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    assert.ok(hooks?.dockCommands, 'actual dock owner hooks missing')
    await until(
      () => hooks.nativeCaptureState()?.ready === true,
      'real app capture bootstrap prerequisite did not become ready'
    )
    nativeDll = koffi.load(process.env.ABANDON_INTEGRATION_NATIVE_DLL)
    const getAbi = nativeDll.func('AbandonNative_GetAbiVersion', 'int', [])
    assert.equal(getAbi(), NATIVE_ABI_VERSION, 'native ABI differs')
    drainNative = nativeDll.func('WindowMotion_DrainDiagnosticsJson', 'str', [])
    await setMode('daily')
    await js('window.api.setSettingValue("appearance.titlebarStyle", "apple")')
    await js('window.api.setWindowZOrderMode("normal")')
    await js('window.api.setBlurConfig({ enabled: true })')
    await until(
      () => hooks.getBlurRuntimeHealth()?.healthy,
      'real native blur did not become healthy'
    )
    // Existing persisted notes are the motion fixture. Creating sixty notes in milliseconds
    // floods normal renderer broadcasts and tests burst ingestion instead of motion overhead.
    assert.equal(fixtureIds.length, settings.fixtureNotes)
    assert.deepEqual(
      readFixture(),
      [...fixtureIds].sort((a, b) => a - b),
      'real SQLite fixture differs'
    )
    await until(
      () => js(`Boolean(document.querySelector('[data-note-id="${fixtureIds.at(-1)}"]'))`),
      'actual list did not apply fixture'
    )
    await js(`(() => {
      window.__motionOverheadEvents = []; window.__motionOverheadHover = []; window.__motionOverheadFrames = []; window.__motionOverheadLongTasks = []
      window.__motionInputTraceEnabled = ${inputTraceEnabled}
      window.__recordMotionOverheadFrame = frameAt => {
        if (!window.__motionOverheadObserveHeld) return
        const startedAt = performance.now()
        const entry = { frameAt, observedAt: startedAt, documentHasFocus: document.hasFocus(), visibilityState: document.visibilityState, pointerCaptured: Boolean(document.querySelector('.app-titlebar')?.hasPointerCapture(1)), pointerEvents: window.__motionOverheadEvents.length }
        window.__motionOverheadFrames.push(entry)
        entry.elapsedMs = performance.now() - startedAt
        if (window.__motionOverheadFrames.length < 240) window.__motionOverheadFrame = requestAnimationFrame(window.__recordMotionOverheadFrame)
      }
      window.__recordMotionOverhead = event => {
        window.__motionOverheadEvents.push({ type: event.type, trusted: event.isTrusted, at: performance.now(), pointerId: event.pointerId, screen: { x: event.screenX, y: event.screenY }, client: { x: event.clientX, y: event.clientY }, buttons: event.buttons, captured: Boolean(document.querySelector('.app-titlebar')?.hasPointerCapture(event.pointerId)) })
        if (event.type === 'pointerdown') { if (window.__motionInputTraceEnabled) performance.mark('motion.press:' + (window.__motionOverheadTracePhase || 'before-trace'), { detail: { screenX: event.screenX, screenY: event.screenY, buttons: event.buttons } }); window.__motionOverheadObserveHeld = true; cancelAnimationFrame(window.__motionOverheadFrame); window.__motionOverheadFrame = requestAnimationFrame(window.__recordMotionOverheadFrame) }
        if (event.type === 'pointerup' || event.type === 'pointercancel') { window.__motionOverheadObserveHeld = false; cancelAnimationFrame(window.__motionOverheadFrame) }
      }
      window.__motionOverheadLongTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask')
      if (window.__motionOverheadLongTaskSupported) {
        window.__motionOverheadLongTaskObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) if (entry.startTime >= (window.__motionOverheadGestureStartedAt || 0) && window.__motionOverheadLongTasks.length < 100) window.__motionOverheadLongTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name })
        })
        window.__motionOverheadLongTaskObserver.observe({ type: 'longtask' })
      }
      window.__recordMotionHover = event => window.__motionOverheadHover.push({ type: event.type, trusted: event.isTrusted, at: performance.now(), screen: { x: event.screenX, y: event.screenY }, buttons: event.buttons })
      for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) window.addEventListener(name, window.__recordMotionOverhead, true)
      for (const name of ['mouseenter', 'mouseleave']) document.addEventListener(name, window.__recordMotionHover)
    })()`)
    const display = screen.getDisplayMatching(currentWindow.getBounds())
    const workArea = display.workArea
    assert.ok(
      workArea.width >= 900 && workArea.height >= 760,
      'work area insufficient for fixed motion fixture'
    )
    const base = { ...settings.windowSize, x: workArea.x + 80, y: workArea.y + 60 }
    if (gpuReadProbeEnabled) {
      probeResult = {
        mode: 'electron-real-app-gpu-diagnostic-export-probe',
        diagnosticOnly: true,
        normalMotionSuiteExecuted: false,
        overheadAcceptanceAllowed: false,
        physicalInputSubmitted: false,
        testOnlyGpuQuerySubstitution: gpuQueryBasicSubstitution,
        substitutedResponseBoundary: gpuQueryBasicSubstitution
          ? 'Basic response defaults are not verified live graphics state'
          : null,
        gpuQueries: [],
        status: 'running',
        exports: []
      }
      installGpuQuerySubstitution()
      await startInputTrace()
      activePhase = 'gpu-read-probe/basic-query'
      await markTracePhase()
      const queryStartedAt = performance.now()
      const basic = await app.getGPUInfo('basic')
      probeResult.basicQuery = {
        startedAt: queryStartedAt,
        elapsedMs: performance.now() - queryStartedAt,
        resultKeys: Object.keys(basic),
        deviceCount: basic.gpuDevice?.length ?? null
      }
      for (let index = 1; index <= 2; index++) {
        activePhase = 'gpu-read-probe/real-export-' + index
        await markTracePhase()
        const exported = await exportLogs('gpu-read-probe-export-' + index)
        probeResult.exports.push({
          name: exported.name,
          filePath: exported.filePath,
          elapsedMs: exported.elapsedMs,
          bytes: exported.bytes,
          complete: exported.completion.complete
        })
        await observeInputState('gpu-read-probe/after-export-' + index)
      }
      activePhase = 'gpu-read-probe/async-gpu-tail'
      await markTracePhase()
      const tailStartedAt = performance.now()
      await wait(2500)
      probeResult.asyncTail = { requestedMs: 2500, elapsedMs: performance.now() - tailStartedAt }
      await observeInputState('gpu-read-probe/after-async-tail')
      await stopInputTrace()
      probeResult.status = 'diagnostic-probe-complete'
      completed = true
      return
    }
    // Unmeasured routing controls isolate export and docking from the six comparison rounds.
    // Every control retains actual HWND travel and trusted pointer assertions; no recovery retry.
    activePhase = 'routing-control/no-export-baseline/prepare'
    if (inputTrace.recording) await markTracePhase()
    await resetWindow(base)
    activePhase = 'routing-control/no-export-baseline/first-drag'
    if (inputTrace.recording) await markTracePhase()
    await dragOnce()
    activePhase = 'routing-control/no-export-baseline/second-drag'
    if (inputTrace.recording) await markTracePhase()
    await dragOnce()
    activePhase = 'routing-control/export-before-drag/prepare'
    if (inputTrace.recording) await markTracePhase()
    await exportLogs('routing-control-before-drag')
    await observeInputState('routing-control/after-export')
    activePhase = 'routing-control/export-before-drag'
    if (inputTrace.recording) await markTracePhase()
    await dragOnce()
    activePhase = 'routing-control/dock-before-drag/prepare'
    if (inputTrace.recording) await markTracePhase()
    await resetWindow(base)
    await dockCycle(workArea, base)
    await resetWindow(base)
    activePhase = 'routing-control/dock-before-drag'
    if (inputTrace.recording) await markTracePhase()
    await dragOnce()
    for (const strategy of ['split-reads', 'combined-reads']) {
      const control = 'routing-control/full-preparation/' + strategy
      if (strategy === 'split-reads') await startInputTrace()
      activePhase = control + '/prepare-warmup'
      if (inputTrace.recording) await markTracePhase()
      await resetWindow(base)
      activePhase = control + '/warmup'
      if (inputTrace.recording) await markTracePhase()
      await measure(async () => ({ drag: await dragOnce(), dock: await dockCycle(workArea, base) }))
      activePhase = control + '/prepare-drag'
      if (inputTrace.recording) await markTracePhase()
      await resetWindow(base)
      await observeInputState(control + '/before-export')
      await exportLogs('routing-control-full-preparation-' + strategy)
      await observeInputState(control + '/after-export')
      if (strategy === 'split-reads') {
        activePhase = control + '/baseline-drag'
        if (inputTrace.recording) await markTracePhase()
        await dragOnce()
        const reads = [
          ['stateFor', () => stateFor('daily')],
          ['logInventory', () => logInventory()],
          ['getSettingsSnapshot', () => js('window.api.getSettingsSnapshot()')],
          ['getWindowZOrderStatus', () => hooks.getWindowZOrderStatus()],
          ['getBlurRuntimeHealth', () => hooks.getBlurRuntimeHealth()]
        ]
        for (const [name, read] of reads) {
          activePhase = control + '/read-' + name
          if (inputTrace.recording) await markTracePhase()
          const startedAt = performance.now()
          const observation = { phase: activePhase, startedAt }
          routingReadChecks.push(observation)
          observation.result = await read()
          observation.elapsedMs = performance.now() - startedAt
          activePhase = control + '/after-' + name
          if (inputTrace.recording) await markTracePhase()
          await dragOnce()
        }
      } else {
        await stateFor('daily')
        await logInventory()
        await fixedConfiguration()
        const blur = hooks.getBlurRuntimeHealth()
        assert.equal(blur?.healthy, true, 'routing control lost native blur health')
        assert.equal(
          blur.zOrderSynchronized,
          true,
          'routing control lost paired blur synchronization'
        )
        activePhase = control + '/drag'
        if (inputTrace.recording) await markTracePhase()
        await dragOnce()
      }
    }
    for (const [index, mode] of rounds.entries()) {
      const label = String(index + 1).padStart(2, '0') + '-' + mode
      const currentDisplay = screen
        .getAllDisplays()
        .find((candidate) => candidate.id === display.id)
      assert.deepEqual(
        { scaleFactor: currentDisplay?.scaleFactor, workArea: currentDisplay?.workArea },
        { scaleFactor: display.scaleFactor, workArea },
        'display/DPI changed during comparison'
      )
      const modeStarted = await setMode(mode)
      activePhase = label + '/prepare-warmup'
      if (inputTrace.recording) await markTracePhase()
      await resetWindow(base)
      activePhase = label + '/warmup'
      if (inputTrace.recording) await markTracePhase()
      const warmup = await measure(async () => ({
        drag: await dragOnce(),
        dock: await dockCycle(workArea, base)
      }))
      activePhase = label + '/prepare-measured'
      if (inputTrace.recording) await markTracePhase()
      await resetWindow(base)
      await observeInputState(label + '/before-export')
      const preExport = await exportLogs(label + '-warmup')
      await observeInputState(label + '/after-export')
      const preState = await stateFor(mode)
      const beforeLogs = await logInventory()
      const configurationBefore = await fixedConfiguration()
      const blurBefore = hooks.getBlurRuntimeHealth()
      assert.equal(blurBefore?.healthy, true, 'native blur changed before sample')
      assert.equal(
        blurBefore.zOrderSynchronized,
        true,
        'paired blur layer not synchronized before sample'
      )
      activePhase = label + '/measured'
      if (inputTrace.recording) await markTracePhase()
      const motion = await measure(async () => {
        const drag = await measure(async () => {
          const gestures = []
          for (let n = 0; n < settings.measuredDragGestures; n++) gestures.push(await dragOnce())
          return gestures
        })
        const dock = await measure(async () => {
          const cycles = []
          for (let n = 0; n < settings.measuredDockCycles; n++)
            cycles.push(await dockCycle(workArea, base))
          return cycles
        })
        return { drag, dock }
      })
      const postState = await stateFor(mode)
      const configurationAfter = await fixedConfiguration()
      const blurAfter = hooks.getBlurRuntimeHealth()
      assert.equal(blurAfter?.healthy, true, 'native blur changed during sample')
      assert.equal(
        blurAfter.zOrderSynchronized,
        true,
        'paired blur layer not synchronized after sample'
      )
      assert.deepEqual(
        readFixture(),
        [...fixtureIds].sort((a, b) => a - b),
        'fixture changed during sample'
      )
      const postExport = await exportLogs(label + '-measured')
      const collected = verifyMotionRecords(mode, preExport, postExport, modeStarted.captureId)
      const afterLogs = await logInventory()
      samples.push({
        round: index + 1,
        mode,
        captureId: modeStarted.captureId,
        display,
        base,
        warmup,
        preState,
        postState,
        blurBefore,
        blurAfter,
        configurationBefore,
        configurationAfter,
        motion,
        collected,
        preExport: { ...preExport, records: undefined },
        postExport: { ...postExport, records: undefined },
        logs: { before: beforeLogs, after: afterLogs, delta: inventoryDelta(beforeLogs, afterLogs) }
      })
      persistSamples({ completedRounds: samples.length })
    }
    // Separate export-under-active-drag oracle. Export/WMI time is never a motion sample.
    const activeCapture = await setMode('deep')
    activePhase = 'active-export-tail/prepare'
    if (inputTrace.recording) await markTracePhase()
    await resetWindow(base)
    activePhase = 'active-export-tail/unmeasured'
    if (inputTrace.recording) await markTracePhase()
    const tail = await dragOnce({ activeExportName: 'active-drag-tail' })
    const requestId = tail.activeExport.completion.manifest.capture.requestId
    const activeRecords = tail.activeExport.records.filter(
      (record) =>
        captureOf(record) === activeCapture.captureId && record.exportRequestId === requestId
    )
    for (const scope of [
      'performance.window-drag-main',
      'performance.window-drag-renderer',
      'performance.window-motion-native'
    ]) {
      assert.ok(
        activeRecords.some((record) => record.scope === scope),
        'active export omitted current tail: ' + scope
      )
    }
    tailEvidence = {
      captureId: activeCapture.captureId,
      requestId,
      input: { ...tail, activeExport: undefined },
      records: activeRecords,
      export: { ...tail.activeExport, records: undefined }
    }
    await stopDeep()
    await setMode('daily')
    activePhase = 'after-stop/prepare'
    if (inputTrace.recording) await markTracePhase()
    await resetWindow(base)
    const dailyBefore = await exportLogs('stopped-daily-before')
    activePhase = 'after-stop/unmeasured'
    if (inputTrace.recording) await markTracePhase()
    await dragOnce()
    await dockCycle(workArea, base)
    const dailyAfter = await exportLogs('stopped-daily-after')
    verifyMotionRecords('daily', dailyBefore, dailyAfter, null)
    assert.equal(samples.filter((sample) => sample.mode === 'daily').length, 3)
    assert.equal(samples.filter((sample) => sample.mode === 'deep').length, 3)
    comparison = {
      schemaVersion: 1,
      settings,
      samplesPerMode: 3,
      order: rounds,
      performanceBudget: null,
      resultMeaning:
        'Valid same-machine controlled motion measurements; no customer root cause or performance budget verdict',
      comparison: inputTraceEnabled ? null : buildComparison(),
      diagnosticOnly: inputTraceEnabled,
      overheadAcceptanceAllowed: !inputTraceEnabled,
      limitations: [
        'Fixed 60 short notes on current machine; no weak-machine soak',
        'Controlled Win32 cursor/button input, not natural user stutter',
        'Window/HWND state, not DWM presented pixels',
        'Observation/polling has common cost and finite resolution',
        'Main/process resource samples are endpoints, not interval peaks',
        'Log quantity includes production post-export tail flush',
        'Native coverage is recorded independently of export completeness',
        'Process changes and unavailable CPU counters remain null',
        'No real mixed DPI/multi-monitor or Windows hardware comparison'
      ]
    }
    writeFileSync(
      join(evidenceRoot, 'motion-overhead-comparison.json'),
      JSON.stringify(comparison, null, 2)
    )
    completed = true
  } catch (error) {
    failure = error
    process.stderr.write('[motion-overhead] ' + (error.stack || error.message) + '\n')
  } finally {
    if (originalGetGpuInfo) {
      app.getGPUInfo = originalGetGpuInfo
      originalGetGpuInfo = null
      if (probeResult) probeResult.gpuQueryMethodRestored = true
    }
    try {
      await stopInputTrace()
    } catch (error) {
      failure ||= error
      completed = false
    }
    try {
      persistSamples({ completed, error: failure?.stack || null })
    } catch (error) {
      failure ||= error
      completed = false
    }
    await lifecycle.finish({
      completed,
      error: failure,
      window: currentWindow,
      summary: {
        measuredRounds: samples.length,
        diagnosticOnly: inputTraceEnabled,
        normalMotionSuiteExecuted: !gpuReadProbeEnabled,
        overheadAcceptanceAllowed: !inputTraceEnabled,
        probeResult,
        comparison,
        exports: exports.map((item) => item.name + '.jsonl'),
        artifacts: [
          'motion-overhead-samples.json',
          ...(inputTrace.filePath ? ['motion-input-chromium-trace.json'] : []),
          ...(comparison ? ['motion-overhead-comparison.json'] : [])
        ],
        tailEvidence: tailEvidence
          ? { captureId: tailEvidence.captureId, requestId: tailEvidence.requestId }
          : null
      },
      restore
    })
  }
}

try {
  app.setPath('userData', root)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  const db = new Database(join(root, 'app.db'))
  try {
    createDatabaseSchema(db)
    const insert = db.prepare(
      "INSERT INTO app_settings (window_name,type,key,value,remark,created_at,updated_at) VALUES (?,?,?,?,'',?,?)"
    )
    const now = Date.now()
    for (const [scope, type, key, value] of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['main', 'system', 'blur_enabled', 'false'],
      ['main', 'dock', 'dock_enabled_edges', '[]']
    ])
      insert.run(scope, type, key, value, now, now)
    const insertFixture = db.prepare(
      `INSERT INTO notes (content,status,effective_at,finished_at,created_at,updated_at)
       VALUES (?, 'in_progress', ?, ?, ?, ?)`
    )
    db.transaction(() => {
      for (let index = 0; index < settings.fixtureNotes; index++)
        fixtureIds.push(
          Number(
            insertFixture.run('motion overhead note ' + index, now, now, now, now).lastInsertRowid
          )
        )
    })()
  } finally {
    db.close()
  }
  app.once('ready', () => void run())
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'actual main chunk missing')
  require(resolve('out/main/chunks', chunk))
} catch (error) {
  void lifecycle.finish({ error, restore })
}
