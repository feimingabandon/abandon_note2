import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { app, BrowserWindow, globalShortcut, nativeImage, screen } from 'electron'
import { captureWindowLayerDiagnostic } from '../src/main/bridge/window-layer-diagnostics.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'

const require = createRequire(import.meta.url)
const { createWin32 } = require('../scripts/prototypes/show-desktop/win32.cjs')
const getOwnedWindowTitle = require('koffi')
  .load('user32.dll')
  .func('int GetWindowTextW(uintptr_t, void *, int)')
const execute = promisify(execFile)
const suite = 'tests/capture-compositor-electron.mjs'
const preconditionDiagnostic = process.argv.includes('--precondition-diagnostic')
const registeredHotkeyDiagnostic = process.argv.includes('--registered-hotkey-diagnostic')
if (preconditionDiagnostic && registeredHotkeyDiagnostic)
  throw new Error('Choose one compositor diagnostic mode at a time')
const diagnosticOnly = preconditionDiagnostic || registeredHotkeyDiagnostic
const registeredAccelerator = 'Control+Alt+Shift+F12'
const registeredKeys = [0x11, 0x12, 0x10, 0x7b]
const mode = registeredHotkeyDiagnostic
  ? 'electron-real-app-capture-compositor-registered-hotkey-diagnostic'
  : preconditionDiagnostic
    ? 'electron-real-app-capture-compositor-precondition-diagnostic'
    : 'electron-real-app-capture-compositor-pixels'
const profile = prepareTestProfile({ prefix: 'abandon-capture-compositor-' })
const evidenceDirectory = resolve(process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory)
const recorder = createAssertionRecorder({
  suite,
  mode,
  metadata: {
    preconditionDiagnostic,
    registeredHotkeyDiagnostic,
    formalCompositorAcceptance: !diagnosticOnly,
    actualApplication: true,
    realPreload: true,
    realNativeCapture: true,
    actualKeyboardInput: true,
    ownedSingleDisplayBackdrop: true,
    controlledSourceActivation: registeredHotkeyDiagnostic
      ? 'Original open/bounds/focus and strict physical marker; no supplemental activation'
      : 'One owned SetForegroundWindow call before each new case',
    limits: [
      'Windows digital composition and actual Qt PNG, not monitor optical scan-out',
      'Keyboard full-display selection, not physical mouse rectangle selection',
      'One machine and one display, not customer-machine, Windows-version or mixed-DPI coverage',
      'Zero-millisecond arms are observations; only the default and already-hidden reference must clear'
    ]
  }
})
const { assert } = recorder
const report = {
  suite,
  mode,
  preconditionDiagnostic,
  registeredHotkeyDiagnostic,
  formalCompositorAcceptance: !diagnosticOnly,
  cases: [],
  phases: [],
  commands: [],
  ownershipChecks: [],
  preparationArtifacts: [],
  preparationDiagnosticErrors: [],
  hotkeyObservationErrors: [],
  cleanup: {}
}
const colors = ['#17385f', '#b96a28', '#267460', '#783c67']
const markerRgb = [213, 47, 151]
const channelTolerance = 6 // Existing real packaged-capture pixel contract uses this tolerance.
const modal = '.app-modal-card[aria-label="截图新建便签"]'
const confirmation = '.confirm-card.active'
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe'
)
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const children = new Set()
const helperPids = new Set()
let current,
  backdrop,
  coordinator,
  hooks,
  win32,
  display,
  physicalDisplay,
  helperIdentity,
  helperOperation,
  helperConnection,
  helperSocket,
  helperJob,
  handoffGeneration,
  originalWait,
  originalBusinessOpen,
  businessOpenObserver,
  cancelHotkeyReady,
  originalCursor,
  activeCase,
  activePreparation,
  normalBounds,
  closing = false,
  allowQuit = false,
  completed = false,
  failure = null,
  reachedWillQuit = false,
  cleanupTimeout,
  quitConfirmationTimer,
  quitQueryPending = false,
  evidenceWritten = false,
  evidence = { status: 'incomplete' }
const cleanupErrors = []
const eventFile = join(evidenceDirectory, 'capture-compositor-events.jsonl')
const hwnd = (window) => Number(window.getNativeWindowHandle().readBigUInt64LE())
const js = (source) => current.webContents.executeJavaScript(source)
const rgb = (hex) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
const matches = (actual, expected) =>
  actual.every((value, index) => Math.abs(value - expected[index]) <= channelTolerance)
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function record(event, details = {}) {
  const entry = { at: new Date().toISOString(), event, ...details }
  report.phases.push(entry)
  appendFileSync(eventFile, JSON.stringify(entry) + '\n')
  console.log('[capture-compositor-phase]', event, JSON.stringify(details))
}
function checkRunning() {
  if (closing) throw new Error('Capture compositor suite is finishing')
}
async function until(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    checkRunning()
    const value = await check()
    if (value) return value
    await wait(20)
  }
  throw new Error(label)
}
function ownFile(root, file) {
  const actual = realpathSync(file),
    child = relative(root, actual)
  if (
    !child ||
    child === '..' ||
    child.startsWith('..' + sep) ||
    isAbsolute(child) ||
    !statSync(actual).isFile()
  )
    throw new Error('Evidence source escapes its owned root: ' + file)
  return actual
}
async function command(executable, args, label) {
  checkRunning()
  const observation = { label, executable, args, startedAt: new Date().toISOString() }
  report.commands.push(observation)
  const pending = execute(executable, args, {
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8'
  })
  const owned = { child: pending.child, closed: false }
  children.add(owned)
  owned.child.once('close', () => {
    owned.closed = true
  })
  let result, commandError, evidenceError
  try {
    result = await pending
    Object.assign(observation, {
      code: 0,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr
    })
  } catch (error) {
    commandError = error
    Object.assign(observation, {
      code: error.code ?? null,
      signal: error.signal ?? null,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      error: error.stack || error.message,
      killed: error.killed || false
    })
  }
  observation.endedAt = new Date().toISOString()
  try {
    writeFileSync(
      join(evidenceDirectory, 'command-' + report.commands.indexOf(observation) + '.json'),
      JSON.stringify(observation, null, 2),
      { flag: 'wx' }
    )
  } catch (error) {
    evidenceError = error
    observation.evidenceError = error.stack || error.message
  }
  if (commandError) throw commandError
  if (evidenceError) throw evidenceError
  return result
}
async function queryProcess(pid, label) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid)
  const code = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop;if($null -eq $taskProcess){'null'}else{@{pid=[int]$taskProcess.ProcessId;parentPid=[int]$taskProcess.ParentProcessId;executable=[string]$taskProcess.ExecutablePath;creationTime=$taskProcess.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`
  const result = await command(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(code, 'utf16le').toString('base64')
    ],
    label
  )
  return JSON.parse(result.stdout.trim())
}
async function assertOwnedHelper(label) {
  assert.ok(coordinator.host.job)
  assert.equal(coordinator.host.native.pid(coordinator.host.job), helperIdentity.pid)
  assert.equal(coordinator.host.native.running(coordinator.host.job), 1)
  const observed = await queryProcess(helperIdentity.pid, label + '-owner')
  report.ownershipChecks.push({ label, expected: helperIdentity, observed })
  assert.deepEqual(
    observed,
    helperIdentity,
    'Native input still targets the exact test-owned helper generation'
  )
  const overlays = win32.enumerate().filter((window) => {
    if (window.pid !== helperIdentity.pid || !window.visible) return false
    const title = Buffer.alloc(160)
    const length = getOwnedWindowTitle(window.hwnd, title, 80)
    return title.subarray(0, length * 2).toString('utf16le') === 'Abandon 截图'
  })
  assert.ok(overlays.length > 0, 'The current helper still owns a visible overlay')
  const inputTarget = overlays.find((window) => {
    const r = window.rect
    if (!r) return false
    const point = { x: r.left + 20, y: r.top + 120 },
      at = win32.windowFromPoint(point),
      pid = [0]
    win32.getPid(at, pid)
    return pid[0] === helperIdentity.pid && Number(win32.getAncestor(at, 2)) === window.hwnd
  })
  assert.ok(
    inputTarget,
    'The driver fallback click point is exposed on a test-owned native overlay'
  )
  report.ownershipChecks.push({
    label: label + '-overlay-point',
    hwnd: inputTarget.hwnd,
    rect: inputTarget.rect
  })
}
async function press(key, ctrl = false) {
  await assertOwnedHelper(activeCase.name + '-' + key)
  await command(
    report.driver.file,
    [String(helperIdentity.pid), key, ...(ctrl ? ['ctrl'] : [])],
    activeCase.name + '-input-' + key
  )
  checkRunning()
}
function expectedBackdrop(point) {
  const horizontal = point.x - physicalDisplay.x >= physicalDisplay.width / 2 ? 1 : 0
  const vertical = point.y - physicalDisplay.y >= physicalDisplay.height / 2 ? 2 : 0
  return rgb(colors[horizontal + vertical])
}
function markerPoints() {
  const bounds = current.getContentBounds()
  return [0.25, 0.5, 0.75].flatMap((x) =>
    [0.25, 0.5, 0.75].map((y) =>
      screen.dipToScreenPoint({
        x: Math.floor(bounds.x + bounds.width * x),
        y: Math.floor(bounds.y + bounds.height * y)
      })
    )
  )
}
function desktopSamples(points) {
  return points.map((point) => {
    const pixel = win32.pixel(point.x, point.y),
      at = win32.windowFromPoint(point),
      pid = [0]
    win32.getPid(at, pid)
    return {
      point,
      rgb: [pixel.r, pixel.g, pixel.b],
      hit: Number(at),
      root: Number(win32.getAncestor(at, 2)),
      pid: pid[0]
    }
  })
}
function sourcePresented(foreground, samples, sourceHwnd) {
  return (
    foreground?.root === sourceHwnd &&
    foreground.pid === process.pid &&
    samples?.length === 9 &&
    samples.every(
      (sample) =>
        sample.root === sourceHwnd && sample.pid === process.pid && matches(sample.rgb, markerRgb)
    )
  )
}
function normalOwnedPair(layers, sourceHwnd) {
  return Boolean(
    layers?.pairStable === true &&
    layers.adjacencyObserved === true &&
    layers.parent?.hwnd === '0x' + BigInt(sourceHwnd).toString(16) &&
    layers.overlay?.className === 'BlurOverlayWindow' &&
    [layers.parent, layers.overlay].every(
      (layer) =>
        layer?.valid &&
        layer.pid === process.pid &&
        layer.visible &&
        !layer.iconic &&
        layer.topmostKnown &&
        layer.topmost === false &&
        layer.rectValid &&
        layer.rect.right > layer.rect.left &&
        layer.rect.bottom > layer.rect.top
    )
  )
}
function backdropState() {
  const target = hwnd(backdrop),
    pid = [0],
    extendedStyle = BigInt(win32.getStyle(target, -20))
  win32.getPid(target, pid)
  return {
    hwnd: target,
    valid: Boolean(win32.isWindow(target)),
    pid: pid[0],
    visible: Boolean(win32.isVisible(target)),
    topmostKnown: extendedStyle !== 0n,
    topmost: (extendedStyle & 8n) !== 0n,
    rect: win32.rect(target)
  }
}
function assertBackdrop(state, targetHwnd) {
  assert.equal(state.hwnd, targetHwnd)
  assert.equal(state.valid, true)
  assert.equal(state.pid, process.pid, 'Only the exact test-owned backdrop may be moved')
  assert.equal(state.visible, true)
  assert.equal(state.topmostKnown, true)
  assert.equal(state.topmost, false)
  assert.deepEqual(state.rect, {
    left: physicalDisplay.x,
    top: physicalDisplay.y,
    right: physicalDisplay.x + physicalDisplay.width,
    bottom: physicalDisplay.y + physicalDisplay.height
  })
}
function assertForegroundHandoff(message, reason, sessionId) {
  const host = coordinator.host
  assert.ok(host.operation === helperOperation, 'The initial owned Host operation is unchanged')
  assert.ok(host.operation?.connection === helperConnection)
  assert.ok(host.operation?.socket === helperSocket && host.socket === helperSocket)
  assert.ok(helperConnection?.socket === helperSocket && !helperSocket.destroyed)
  assert.ok(host.operation?.job === helperJob && host.job === helperJob)
  assert.equal(host.operation?.closed, false)
  assert.equal(host.ready, true)
  assert.equal(host.operation?.pid, helperIdentity.pid)
  assert.equal(host.pid, helperIdentity.pid)
  assert.equal(host.native.pid(helperJob), helperIdentity.pid)
  assert.equal(host.native.running(helperJob), 1)
  assert.equal(message?.sessionId, sessionId)
  const handoff = message?.foregroundHandoff
  assert.ok(
    handoff && typeof handoff === 'object',
    'The native result retains foreground handoff evidence'
  )
  assert.equal(handoff.attempted, true)
  assert.equal(
    handoff.pid,
    process.pid,
    'The authenticated native pipe peer is this Electron process'
  )
  assert.ok(Number.isSafeInteger(handoff.generation) && handoff.generation > 0)
  assert.equal(handoff.sessionId, sessionId)
  assert.equal(handoff.reason, reason)
  assert.equal(handoff.granted, true)
  assert.equal(handoff.win32Error, 0)
  if (handoffGeneration === undefined) {
    // Startup pipe retries can advance Qt's socketGeneration before ready.
    // Bind its first observed value to the exact verified Host objects above.
    handoffGeneration = handoff.generation
    report.foregroundHandoffBinding = {
      helperPid: helperIdentity.pid,
      electronPid: process.pid,
      nativeGeneration: handoffGeneration,
      firstSessionId: sessionId,
      source: 'First valid native DTO on the unchanged initial Host operation/connection/socket/job'
    }
  }
  assert.equal(handoff.generation, handoffGeneration)
}
function preparationState(entry) {
  const result = { at: new Date().toISOString(), lastMarkerPoll: entry.markerPoll || null }
  try {
    const foreground = win32.getForeground(),
      pid = [0]
    win32.getPid(foreground, pid)
    result.foreground = {
      hwnd: Number(foreground),
      root: Number(win32.getAncestor(foreground, 2)),
      pid: pid[0],
      className: win32.className(foreground),
      rect: win32.rect(foreground)
    }
    const ownedPids = new Set([process.pid, helperIdentity?.pid, coordinator?.host?.pid])
    result.ownedZOrder = win32
      .enumerate()
      .map((window, index) => ({ index, ...window }))
      .filter((window) => ownedPids.has(window.pid))
    result.backdropHwnd = backdrop && !backdrop.isDestroyed() ? hwnd(backdrop) : null
    result.waitIsOriginal = coordinator?.waitForCompositor === originalWait
    result.dock = hooks?.getDockRuntimeState?.()
    result.presentation = hooks?.getPresentationModeState?.()
    if (current && !current.isDestroyed()) {
      result.window = {
        hwnd: hwnd(current),
        visible: current.isVisible(),
        focused: current.isFocused(),
        minimized: current.isMinimized(),
        bounds: current.getBounds(),
        contentBounds: current.getContentBounds()
      }
      result.layers = captureWindowLayerDiagnostic(current)
      if (entry.markerPoints) result.desktopSamples = desktopSamples(entry.markerPoints)
    }
  } catch (error) {
    result.nativeError = error.stack || error.message
  }
  return result
}
function observeHotkeyPhase(entry, phase, details = {}) {
  if (!registeredHotkeyDiagnostic || !entry) return
  try {
    const state = preparationState(entry)
    entry.hotkeyObservations ||= []
    entry.hotkeyObservations.push({
      phase,
      sessionId: coordinator?.active?.id || entry.started?.sessionId,
      ...details,
      state
    })
    if (state.nativeError) report.hotkeyObservationErrors.push(phase + ': ' + state.nativeError)
  } catch (error) {
    report.hotkeyObservationErrors.push(phase + ': ' + (error.stack || error.message))
  }
}
function installBusinessOpenObserver() {
  originalBusinessOpen = coordinator.onBusinessOpen
  assert.equal(typeof originalBusinessOpen, 'function')
  businessOpenObserver = function (...args) {
    const entry = activeCase
    if (entry) entry.businessOpenCalls = (entry.businessOpenCalls || 0) + 1
    observeHotkeyPhase(entry, 'onBusinessOpen-before', { argumentCount: args.length })
    let returned
    try {
      returned = Reflect.apply(originalBusinessOpen, this, args)
    } catch (error) {
      observeHotkeyPhase(entry, 'onBusinessOpen-sync-throw', {
        error: error.stack || error.message
      })
      throw error
    }
    const observedReturn = (phase, value) =>
      observeHotkeyPhase(entry, phase, {
        resultType: typeof value,
        returned: typeof value === 'boolean' ? value : undefined
      })
    try {
      if (returned && typeof returned.then === 'function') {
        // Observe beside the original Promise, which is returned unchanged.
        // The product call keeps its exact this, arguments and return identity.
        returned.then(
          (value) => observedReturn('onBusinessOpen-fulfilled', value),
          (error) =>
            observeHotkeyPhase(entry, 'onBusinessOpen-rejected', {
              error: error?.stack || error?.message || String(error)
            })
        )
      } else observedReturn('onBusinessOpen-sync-return', returned)
    } catch (error) {
      report.hotkeyObservationErrors.push('onBusinessOpen-return-observation: ' + error.message)
    }
    return returned
  }
  coordinator.onBusinessOpen = businessOpenObserver
}
async function persistPreparationFailure(entry, error) {
  if (!entry) return
  if (entry.diagnosticPromise) return entry.diagnosticPromise
  const pending = (async () => {
    // Preserve the failed GDI/foreground/window facts before asking Chromium to
    // subscribe to frames or capturePage, either of which may affect rendering.
    const diagnostic = {
      name: entry.name,
      error: error?.stack || error?.message || String(error),
      originalFailureState: preparationState(entry),
      note: 'All renderer/frame/screenshot diagnostics below happen after the failed precondition; later repaint cannot replace the original desktop samples'
    }
    entry.preparationFailure = diagnostic
    // Commit the untouched native observation before renderer diagnostics can
    // trigger repaint or stall. Later diagnostics never rewrite this original.
    const originalFile = entry.name + '-preparation-original.json'
    writeFileSync(join(evidenceDirectory, originalFile), JSON.stringify(diagnostic, null, 2), {
      flag: 'wx'
    })
    report.preparationArtifacts.push(originalFile)
    const savePng = (image, suffix) => {
      const file = entry.name + '-preparation-' + suffix + '.png',
        bytes = image.toPNG()
      writeFileSync(join(evidenceDirectory, file), bytes, { flag: 'wx' })
      report.preparationArtifacts.push(file)
      return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    if (current && !current.isDestroyed()) {
      let queryTimer
      try {
        diagnostic.renderer = await Promise.race([
          js(
            `(() => {const marker=document.getElementById('capture-compositor-marker');const r=marker?.getBoundingClientRect(),style=marker?getComputedStyle(marker):null;return {visibility:document.visibilityState,focused:document.hasFocus(),viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},marker:marker?{connected:marker.isConnected,rect:{x:r.x,y:r.y,width:r.width,height:r.height},computed:{display:style.display,visibility:style.visibility,opacity:style.opacity,background:style.backgroundColor,zIndex:style.zIndex,position:style.position,pointerEvents:style.pointerEvents}}:null};})()`
          ),
          new Promise((_, reject) => {
            queryTimer = setTimeout(
              () => reject(new Error('Preparation DOM diagnostic timed out')),
              2000
            )
          })
        ])
      } catch (queryError) {
        diagnostic.rendererError = queryError.stack || queryError.message
      } finally {
        clearTimeout(queryTimer)
      }
      let lastImage = null,
        subscribed = false
      const frames = {
        startedAt: new Date().toISOString(),
        received: 0,
        firstFrames: [],
        lastFrame: null
      }
      diagnostic.postFailureFrames = frames
      try {
        current.webContents.beginFrameSubscription(false, (image, dirtyRect) => {
          try {
            const size = image.getSize(),
              bytes = image.toBitmap()
            const samples = [0.25, 0.5, 0.75].flatMap((x) =>
              [0.25, 0.5, 0.75].map((y) => {
                const offset =
                  (Math.floor(y * size.height) * size.width + Math.floor(x * size.width)) * 4
                return {
                  fraction: { x, y },
                  rgb: [bytes[offset + 2], bytes[offset + 1], bytes[offset]]
                }
              })
            )
            const frame = { sequence: ++frames.received, at: Date.now(), size, dirtyRect, samples }
            if (frames.firstFrames.length < 8) frames.firstFrames.push(frame)
            frames.lastFrame = frame
            lastImage = image
          } catch (readError) {
            frames.readError = readError.stack || readError.message
          }
        })
        subscribed = true
        await wait(500)
      } catch (subscribeError) {
        frames.subscriptionError = subscribeError.stack || subscribeError.message
      } finally {
        if (subscribed && !current.isDestroyed()) {
          try {
            current.webContents.endFrameSubscription()
          } catch (closeError) {
            frames.cleanupError = closeError.stack || closeError.message
          }
        }
        frames.finishedAt = new Date().toISOString()
      }
      if (lastImage) {
        try {
          diagnostic.postFailurePresented = savePng(lastImage, 'post-failure-presented')
        } catch (imageError) {
          diagnostic.postFailurePresentedError = imageError.stack || imageError.message
        }
      }
      let screenshotTimer
      try {
        const image = await Promise.race([
          current.webContents.capturePage(),
          new Promise((_, reject) => {
            screenshotTimer = setTimeout(
              () => reject(new Error('Preparation renderer screenshot timed out')),
              2000
            )
          })
        ])
        diagnostic.rendererSnapshot = {
          ...savePng(image, 'renderer-snapshot'),
          scope:
            'Requested after failure; capturePage can render an occluded page and is not original desktop presentation proof'
        }
      } catch (screenshotError) {
        diagnostic.rendererSnapshotError = screenshotError.stack || screenshotError.message
      } finally {
        clearTimeout(screenshotTimer)
      }
    }
    diagnostic.afterRendererDiagnostics = preparationState(entry)
    try {
      const file = entry.name + '-preparation-diagnostic.json'
      writeFileSync(join(evidenceDirectory, file), JSON.stringify(diagnostic, null, 2), {
        flag: 'wx'
      })
      report.preparationArtifacts.push(file)
    } catch (writeError) {
      report.preparationDiagnosticErrors.push(writeError.stack || writeError.message)
    }
  })()
  Object.defineProperty(entry, 'diagnosticPromise', { value: pending })
  return pending
}
function samplePoints(rectangles) {
  const points = new Map()
  for (const rect of rectangles) {
    const left = Math.max(physicalDisplay.x + 2, rect.left - 24)
    const right = Math.min(physicalDisplay.x + physicalDisplay.width - 2, rect.right + 24)
    const top = Math.max(physicalDisplay.y + 2, rect.top - 24)
    const bottom = Math.min(physicalDisplay.y + physicalDisplay.height - 2, rect.bottom + 24)
    for (let y = top + 3; y < bottom; y += 8)
      for (let x = left + 3; x < right; x += 8) {
        if (
          Math.abs(x - physicalDisplay.x - physicalDisplay.width / 2) < 6 ||
          Math.abs(y - physicalDisplay.y - physicalDisplay.height / 2) < 6
        )
          continue
        points.set(x + ',' + y, { x, y })
      }
  }
  return [...points.values()]
}
function compareImage(image, points, expectation) {
  const size = image.getSize(),
    bytes = image.toBitmap()
  assert.equal(bytes.length, size.width * size.height * 4)
  assert.ok(
    points.every(
      (point) =>
        point.x >= physicalDisplay.x &&
        point.y >= physicalDisplay.y &&
        point.x < physicalDisplay.x + size.width &&
        point.y < physicalDisplay.y + size.height
    )
  )
  const mismatches = []
  let mismatchCount = 0
  for (const point of points) {
    const x = point.x - physicalDisplay.x,
      y = point.y - physicalDisplay.y
    const offset = (y * size.width + x) * 4
    const actual = [bytes[offset + 2], bytes[offset + 1], bytes[offset]]
    const expected = expectation(point)
    if (!matches(actual, expected)) {
      mismatchCount += 1
      if (mismatches.length < 64) mismatches.push({ point, actual, expected })
    }
  }
  return {
    clear: mismatchCount === 0,
    sampleCount: points.length,
    mismatchCount,
    channelTolerance,
    firstMismatches: mismatches
  }
}
function tap(message) {
  if (!activeCase) return
  if (
    registeredHotkeyDiagnostic &&
    message.type === 'finished' &&
    message.sessionId === coordinator.active?.id
  )
    observeHotkeyPhase(activeCase, 'qt-finished-prepend-before-product-end')
  if (['captureReady', 'error', 'finished'].includes(message.type)) {
    const { type, sessionId, status, displays, foregroundHandoff, message: description } = message
    activeCase.messages.push({
      type,
      sessionId,
      status,
      displays,
      foregroundHandoff,
      message: description
    })
  }
  if (message.type !== 'output') return
  activeCase.nativeOutput = message
  try {
    if (
      message.sessionId !== coordinator.active?.id ||
      (activeCase.started && message.sessionId !== activeCase.started.sessionId)
    )
      throw new Error('Native output belongs to another capture session')
    assert.match(message.sessionId, /^[a-f0-9-]{36}$/)
    assert.match(message.deliveryId, /^[a-f0-9-]{36}$/)
    const file = ownFile(
      coordinator.assets.root,
      join(coordinator.assets.root, message.sessionId, message.deliveryId + '.png')
    )
    const bytes = readFileSync(file)
    if (bytes.length > 50 * 1024 * 1024)
      throw new Error('Native PNG exceeds the product asset limit')
    const target = activeCase.name + '-qt-output.png'
    // Qt has already frozen and saved the image. Read synchronously before the
    // existing product listener can accept the delivery and remove its PNG.
    writeFileSync(join(evidenceDirectory, target), bytes, { flag: 'wx' })
    const image = nativeImage.createFromBuffer(bytes)
    activeCase.output = {
      sessionId: message.sessionId,
      deliveryId: message.deliveryId,
      action: message.action,
      file: target,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: image.getSize()
    }
    observeHotkeyPhase(activeCase, 'qt-output-prepend-before-business-open')
    activeCase.comparison = compareImage(image, activeCase.grid, expectedBackdrop)
    activeCase.markerComparison = compareImage(image, activeCase.markerPoints, () => markerRgb)
  } catch (error) {
    activeCase.outputError = error.stack || error.message
  }
}
async function clickControl(selector) {
  await until(
    () =>
      js(
        `(() => {const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled||button.closest('[inert]'))return false;const r=button.getBoundingClientRect();return r.width>0&&r.height>0&&button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`
      ),
    'Actual product control is not exposed: ' + selector
  )
  await js(`document.querySelector(${JSON.stringify(selector)}).click();true`)
}
async function discardCaptureDraft() {
  await until(
    () => js(`document.querySelectorAll(${JSON.stringify(modal + ' .ip-thumb')}).length===1`),
    'The real screenshot editor did not receive exactly one image'
  )
  assert.equal((await js('window.__prepareEditingDrafts()')).dirty, true)
  await clickControl(modal + ' .app-modal-close')
  await until(
    () =>
      js(
        `Boolean(document.querySelector('.confirm-card.active[aria-label="放弃这张便签草稿？"]'))`
      ),
    'The actual screenshot discard confirmation did not appear'
  )
  const clicked = await js(
    `(() => {const card=document.querySelector(${JSON.stringify(confirmation)}),button=Array.from(card?.querySelectorAll('button')||[]).find(node=>node.textContent.trim()==='放弃草稿');if(!button||button.disabled||button.closest('[inert]'))return false;const r=button.getBoundingClientRect();if(!button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))return false;button.click();return true;})()`
  )
  assert.equal(clicked, true)
  await until(
    () =>
      js(
        `!document.querySelector(${JSON.stringify(modal)})&&window.__prepareEditingDrafts().then(state=>!state.dirty&&!state.blocked)`
      ),
    'The test screenshot draft did not discard through normal product controls'
  )
}
async function createBackdrop() {
  backdrop = new BrowserWindow({
    ...display.bounds,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: colors[0],
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  await backdrop.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="margin:0;width:100vw;height:100vh;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;overflow:hidden">' +
          colors.map((color) => '<div style="background:' + color + '"></div>').join('') +
          '</body>'
      )
  )
  checkRunning()
  backdrop.setBounds(display.bounds)
  backdrop.showInactive()
  assert.equal(backdrop.isAlwaysOnTop(), false)
  const png = (await backdrop.webContents.capturePage()).toPNG()
  writeFileSync(join(evidenceDirectory, 'owned-backdrop-reference.png'), png, { flag: 'wx' })
  report.backdrop = {
    windowId: backdrop.id,
    hwnd: hwnd(backdrop),
    bounds: backdrop.getBounds(),
    physicalRect: win32.rect(hwnd(backdrop)),
    sha256: createHash('sha256').update(png).digest('hex'),
    note: 'This capturePage reference describes the owned drawing; real desktop visibility is checked separately with GetPixel and actual Qt PNG.'
  }
}
async function prepareCase(name, { hide, zero = false, alreadyHidden = false }) {
  checkRunning()
  const entry = {
    name,
    hide,
    wait: zero ? 'candidate-0ms' : 'default-80ms',
    alreadyHidden,
    phase: 'preparing',
    waitAssigned: false,
    messages: []
  }
  report.cases.push(entry)
  activePreparation = entry
  entry.preparationBeforeOpen = preparationState(entry)
  try {
    record('prepare-case', { name, hide, zero, alreadyHidden })
    entry.openReturned = await hooks.openMainWindowFromTray()
    entry.preparationAfterOpen = preparationState(entry)
    current.setBounds(normalBounds, false)
    current.focus()
    entry.preparationAfterBoundsAndFocus = preparationState(entry)
    // open/focus does not promise Win32 foreground ownership. Establish this
    // experiment's source visibility once, before capture; never repair a
    // failed marker poll or the unassisted cancellation-restoration assertion.
    const targetHwnd = hwnd(current),
      targetPid = [0]
    win32.getPid(targetHwnd, targetPid)
    assert.equal(targetPid[0], process.pid, 'Only this test-owned source may be activated')
    if (!registeredHotkeyDiagnostic) {
      entry.nativeActivation = {
        at: new Date().toISOString(),
        targetHwnd,
        targetPid: targetPid[0],
        returned: win32.setForeground(targetHwnd),
        observed: preparationState(entry)
      }
      assert.notEqual(
        entry.nativeActivation.returned,
        0,
        'Single owned-source activation must succeed'
      )
      assert.equal(entry.nativeActivation.observed.foreground.root, targetHwnd)
      assert.equal(entry.nativeActivation.observed.foreground.pid, process.pid)
    }
    await js(`window.api.setSettingValue('interaction.hideMainViewDuringScreenshot',${hide})`)
    await until(
      () => hooks.getBlurRuntimeHealth()?.healthy,
      'The actual blur layer is not healthy before capture'
    )
    await js(
      `(() => {document.getElementById('capture-compositor-marker')?.remove();const marker=document.createElement('div');marker.id='capture-compositor-marker';marker.style.cssText='position:fixed;inset:0;z-index:2147483000;pointer-events:none;background:rgb(213 47 151)';/* Test-only drawing marker, removed before product controls are exercised. */document.body.append(marker);return true;})()`
    )
    const points = markerPoints()
    entry.markerPoints = points
    entry.markerPoll = { count: 0, lastSamples: null }
    const visible = await until(() => {
      const samples = desktopSamples(points),
        foregroundHwnd = win32.getForeground(),
        foregroundPid = [0]
      win32.getPid(foregroundHwnd, foregroundPid)
      const foreground = {
          hwnd: Number(foregroundHwnd),
          root: Number(win32.getAncestor(foregroundHwnd, 2)),
          pid: foregroundPid[0]
        },
        layers = captureWindowLayerDiagnostic(current)
      entry.markerPoll = {
        count: entry.markerPoll.count + 1,
        at: new Date().toISOString(),
        lastSamples: samples,
        foreground,
        layers
      }
      if (entry.markerPoll.count === 1) entry.markerFirstPoll = preparationState(entry)
      return sourcePresented(foreground, samples, targetHwnd) && normalOwnedPair(layers, targetHwnd)
        ? samples
        : null
    }, 'The owned foreground source, nine physical marker pixels and stable normal main/blur pair were not ready')
    const backdropHwnd = hwnd(backdrop),
      placement = {
        before: preparationState(entry),
        backdropBefore: backdropState(),
        hwnd: backdropHwnd,
        flags: 0x0001 | 0x0002 | 0x0010,
        callCount: 0
      }
    entry.backdropPlacement = placement
    assert.ok(
      sourcePresented(placement.before.foreground, placement.before.desktopSamples, targetHwnd)
    )
    assert.ok(normalOwnedPair(placement.before.layers, targetHwnd))
    assertBackdrop(placement.backdropBefore, backdropHwnd)
    placement.insertAfter = Number(BigInt(placement.before.layers.overlay.hwnd))
    placement.at = new Date().toISOString()
    placement.callCount = 1
    // Only the owned backdrop moves, once, behind the settled actual blur.
    // NOMOVE | NOSIZE | NOACTIVATE preserves geometry and source activation.
    placement.returned = win32.setPosition(
      backdropHwnd,
      placement.insertAfter,
      0,
      0,
      0,
      0,
      placement.flags
    )
    placement.after = preparationState(entry)
    placement.backdropAfter = backdropState()
    placement.overlayNext = Number(win32.getWindow(placement.insertAfter, 2))
    assert.notEqual(placement.returned, 0, 'The single owned backdrop insertion must succeed')
    assert.equal(placement.overlayNext, backdropHwnd)
    assert.ok(normalOwnedPair(placement.after.layers, targetHwnd))
    assert.equal(placement.after.layers.overlay.hwnd, placement.before.layers.overlay.hwnd)
    assert.ok(
      sourcePresented(placement.after.foreground, placement.after.desktopSamples, targetHwnd)
    )
    assertBackdrop(placement.backdropAfter, backdropHwnd)
    assert.deepEqual(placement.backdropAfter.rect, placement.backdropBefore.rect)
    const layers = placement.after.layers
    assert.equal(layers.parent?.pid, process.pid)
    assert.equal(layers.overlay?.pid, process.pid)
    assert.equal(
      layers.overlay?.visible,
      true,
      'The real blur overlay participates in the old-window region'
    )
    assert.ok(layers.parent?.rectValid && layers.overlay?.rectValid)
    const grid = samplePoints([layers.parent.rect, layers.overlay.rect])
    assert.ok(grid.length > 100, 'A dense old-window/blur/edge region is actually sampled')
    Object.assign(entry, {
      markerBefore: visible,
      layersBefore: layers,
      regionSampling: {
        rectangles: [layers.parent.rect, layers.overlay.rect],
        expansionPx: 24,
        stridePx: 8,
        sampleCount: grid.length,
        excludedBackdropSeamPx: 6
      },
      blurBefore: hooks.getBlurRuntimeHealth()
    })
    Object.defineProperty(entry, 'grid', { value: grid })
    activeCase = entry
    coordinator.waitForCompositor = zero ? () => Promise.resolve() : originalWait
    entry.waitAssigned = true
    if (alreadyHidden) {
      current.focus()
      assert.equal(
        current.isFocused(),
        true,
        'The ordinary visibility toggle starts from a focused source'
      )
      hooks.triggerViewVisibilityShortcut()
      await until(
        () => !current.isVisible(),
        'The ordinary visibility action did not hide the source'
      )
      entry.hiddenDesktopReference = await until(() => {
        const referencePoints = grid.filter((_, index) => index % Math.ceil(grid.length / 64) === 0)
        const samples = desktopSamples(referencePoints)
        entry.hiddenDesktopReferencePoll = {
          count: (entry.hiddenDesktopReferencePoll?.count || 0) + 1,
          at: new Date().toISOString(),
          lastSamples: samples
        }
        return samples.every(
          (sample) =>
            sample.root === backdropHwnd &&
            sample.pid === process.pid &&
            matches(sample.rgb, expectedBackdrop(sample.point))
        )
          ? {
              sampleCount: samples.length,
              selection:
                'Uniformly distributed points across the declared dense region; actual Qt output retains the complete dense comparison',
              samples
            }
          : null
      }, 'The already-hidden reference did not expose the real backdrop before capture')
    }
    win32.setCursor(
      physicalDisplay.x + Math.floor(physicalDisplay.width / 2),
      physicalDisplay.y + Math.floor(physicalDisplay.height / 2)
    )
    entry.phase = 'ready'
    entry.preparationReady = preparationState(entry)
    return entry
  } catch (error) {
    entry.phase = 'preparation-failed'
    await persistPreparationFailure(entry, error)
    throw error
  } finally {
    if (activePreparation === entry) activePreparation = null
  }
}
async function startRegisteredHotkey(entry) {
  assert.equal(Boolean(coordinator.active || coordinator.pending), false)
  const snapshot = hooks.getResolvedSettingsSnapshot()
  entry.hotkeyRegistration = {
    at: new Date().toISOString(),
    accelerator: registeredAccelerator,
    configuredValue: snapshot.values.shortcuts.screenshot,
    runtime: snapshot.runtime.shortcuts.screenshot,
    registeredByThisProcess: globalShortcut.isRegistered(registeredAccelerator)
  }
  assert.equal(entry.hotkeyRegistration.configuredValue, registeredAccelerator)
  assert.ok(entry.hotkeyRegistration.runtime, 'The actual product shortcut runtime must exist')
  assert.equal(entry.hotkeyRegistration.runtime.configured, registeredAccelerator)
  assert.equal(entry.hotkeyRegistration.runtime.error, null)
  assert.equal(entry.hotkeyRegistration.runtime.enabled, true)
  assert.equal(entry.hotkeyRegistration.runtime.capturing, false)
  assert.equal(entry.hotkeyRegistration.runtime.registered, true)
  assert.equal(entry.hotkeyRegistration.registeredByThisProcess, true)
  entry.hotkeyTrigger = {
    accelerator: registeredAccelerator,
    keys: registeredKeys,
    fixedKeyStates: registeredKeys.map((key) => ({ key, state: win32.keyState(key) })),
    beforeSessionId: coordinator.active?.id || null,
    dispatchCount: 0
  }
  assert.ok(
    entry.hotkeyTrigger.fixedKeyStates.every(({ state }) => (state & 0x8000) === 0),
    'The diagnostic will not send or release a fixed chord key already held by the user'
  )
  await new Promise((resolveReady, rejectReady) => {
    let settled = false
    const finishReady = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      coordinator.host.removeListener('message', onMessage)
      coordinator.host.removeListener('failure', onFailure)
      cancelHotkeyReady = null
      if (error) rejectReady(error)
      else resolveReady()
    }
    const onFailure = (error) => finishReady(error)
    const onMessage = (message) => {
      try {
        if (['error', 'finished'].includes(message.type))
          throw new Error(
            'Registered-hotkey capture ended before ready: ' + JSON.stringify(message)
          )
        if (message.type !== 'captureReady') return
        const active = coordinator.active
        assert.ok(active, 'The registered-hotkey ready event must have a real active capture')
        assert.equal(message.sessionId, active.id)
        assert.notEqual(active.id, entry.hotkeyTrigger.beforeSessionId)
        assert.equal(active.origin, 'global')
        assert.equal(active.mode, 'edit')
        entry.started = {
          sessionId: active.id,
          origin: active.origin,
          mode: active.mode,
          identitySource: 'actual coordinator active session at native captureReady'
        }
        finishReady()
      } catch (error) {
        finishReady(error)
      }
    }
    const timer = setTimeout(
      () => finishReady(new Error('The registered-hotkey capture did not report captureReady')),
      10000
    )
    cancelHotkeyReady = finishReady
    coordinator.host.on('message', onMessage)
    coordinator.host.on('failure', onFailure)
    try {
      entry.hotkeyTrigger.dispatchCount = 1
      entry.hotkeyTrigger.dispatchedAt = new Date().toISOString()
      win32.chord(registeredKeys)
      entry.hotkeyTrigger.completeChordSent = true
    } catch (error) {
      finishReady(error)
    }
  })
}
async function startCase(entry) {
  // The persistent observer is installed before dispatch. No sampling, waits,
  // flushes or extra awaits are inserted between product hide and Qt BitBlt.
  if (registeredHotkeyDiagnostic) await startRegisteredHotkey(entry)
  else {
    entry.started = await hooks.startNativeCapture()
    assert.equal(entry.started.status, 'started')
  }
  await until(() => {
    const messages = entry.messages.filter(
      (message) => message.sessionId === entry.started.sessionId
    )
    const terminal =
      entry.messages.find(
        (message) =>
          message.type === 'error' &&
          (!message.sessionId || message.sessionId === entry.started.sessionId)
      ) || messages.find((message) => message.type === 'finished')
    if (terminal)
      throw new Error('Capture ended before its ready event: ' + JSON.stringify(terminal))
    return messages.find((message) => message.type === 'captureReady')
  }, 'The current real Qt capture did not report captureReady')
  entry.ready = entry.messages.find(
    (message) => message.type === 'captureReady' && message.sessionId === entry.started.sessionId
  )
  assert.equal(entry.ready.displays.length, 1)
  assert.deepEqual(entry.ready.displays[0].physical, [
    physicalDisplay.x,
    physicalDisplay.y,
    physicalDisplay.width,
    physicalDisplay.height
  ])
  assert.equal(current.isVisible(), !entry.hide && !entry.alreadyHidden)
  record('capture-ready', {
    name: entry.name,
    sessionId: entry.started.sessionId,
    hidden: !current.isVisible()
  })
}
async function deliverCase(entry, { requiredClear = false, negative = false } = {}) {
  await startCase(entry)
  await press('F')
  await press('N', true)
  await until(() => entry.output || entry.outputError, 'The actual Qt output was not observed')
  assert.equal(entry.outputError, undefined)
  assert.equal(entry.output.sessionId, entry.started.sessionId)
  assert.equal(entry.output.action, 'note')
  assertForegroundHandoff(entry.nativeOutput, 'note', entry.started.sessionId)
  assert.deepEqual(entry.output.size, {
    width: physicalDisplay.width,
    height: physicalDisplay.height
  })
  if (negative) {
    assert.equal(
      entry.markerComparison.clear,
      true,
      'hide=false negative control must contain the physically visible old-window marker'
    )
    assert.equal(
      entry.comparison.clear,
      false,
      'The same old-window region detector must notice the negative-control marker'
    )
  }
  if (requiredClear)
    assert.equal(
      entry.comparison.clear,
      true,
      'The default or already-hidden reference must restore the backdrop across the old window, blur and edges'
    )
  await until(
    () => !hooks.nativeCaptureState().active,
    'The real screenshot business ACK did not finish this capture'
  )
  entry.afterFinished = preparationState(entry)
  const finished = entry.messages.filter(
    (message) => message.type === 'finished' && message.sessionId === entry.started.sessionId
  )
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'delivered')
  assert.equal(
    finished[0].foregroundHandoff,
    undefined,
    'Generic delivery finish does not grant foreground again'
  )
  assert.equal(coordinator.deliverySnapshot().state, 'accepted')
  assert.equal(coordinator.deliverySnapshot().sessionId, entry.started.sessionId)
  assert.equal(coordinator.deliverySnapshot().deliveryId, entry.output.deliveryId)
  assert.equal(
    current.isVisible(),
    true,
    'Accepted business delivery intentionally reveals its real editor'
  )
  const sourceHwnd = hwnd(current)
  entry.businessPresentationPoll = { count: 0, last: null }
  entry.businessPresentation = await until(() => {
    const foreground = win32.getForeground(),
      pid = [0]
    win32.getPid(foreground, pid)
    const observation = {
      at: new Date().toISOString(),
      sourceHwnd,
      foreground: {
        hwnd: Number(foreground),
        root: Number(win32.getAncestor(foreground, 2)),
        pid: pid[0]
      },
      samples: desktopSamples(entry.markerPoints)
    }
    entry.businessPresentationPoll = {
      count: entry.businessPresentationPoll.count + 1,
      last: observation
    }
    return observation.foreground.root === sourceHwnd &&
      observation.foreground.pid === process.pid &&
      observation.samples.length === 9 &&
      observation.samples.every(
        (sample) =>
          sample.root === sourceHwnd && sample.pid === process.pid && matches(sample.rgb, markerRgb)
      )
      ? observation
      : null
  }, 'Accepted screenshot business did not physically present the owned main window and marker without intervention')
  assert.equal(entry.businessPresentation.samples.length, 9)
  // The marker proves native source-window presentation. The original real
  // editor image/dirty/control assertions below still verify business content.
  await js(`document.getElementById('capture-compositor-marker')?.remove();true`)
  await discardCaptureDraft()
  entry.afterDraftClosed = preparationState(entry)
  record('case-complete', {
    name: entry.name,
    output: entry.output,
    comparison: entry.comparison,
    markerComparison: entry.markerComparison
  })
}
async function restoreOwned() {
  const attempt = async (action) => {
    try {
      await action()
    } catch (error) {
      cleanupErrors.push(error.stack || error.message)
      process.exitCode = 1
    }
  }
  coordinator ||= globalThis.__ABANDON_WINDOW_TEST_HOOKS__?.captureCoordinator?.()
  const helperPid = coordinator?.host?.pid
  if (Number.isSafeInteger(helperPid) && helperPid > 0 && helperPid !== process.pid)
    helperPids.add(helperPid)
  await attempt(() =>
    cancelHotkeyReady?.(new Error('Registered-hotkey ready observation ended during cleanup'))
  )
  await attempt(() => coordinator?.cancel())
  await attempt(() => {
    if (coordinator && originalWait) coordinator.waitForCompositor = originalWait
    coordinator?.host.removeListener('message', tap)
    if (coordinator && businessOpenObserver) {
      coordinator.onBusinessOpen = originalBusinessOpen
      report.cleanup.hotkeyBusinessOpenObserverRestored =
        coordinator.onBusinessOpen === originalBusinessOpen
    }
  })
  await attempt(async () => {
    if (current && !current.isDestroyed())
      await js(`document.getElementById('capture-compositor-marker')?.remove();true`)
  })
  await attempt(() => {
    if (backdrop && !backdrop.isDestroyed()) backdrop.destroy()
  })
  await attempt(() => {
    if (originalCursor && win32 && !win32.setCursor(originalCursor.x, originalCursor.y))
      throw new Error('Original cursor could not be restored')
  })
  for (const owned of children) if (!owned.closed) await attempt(() => owned.child.kill())
  const deadline = Date.now() + 2000
  while ([...children].some((owned) => !owned.closed) && Date.now() < deadline) await wait(20)
  if ([...children].some((owned) => !owned.closed)) {
    cleanupErrors.push('A test-created command process did not close')
    process.exitCode = 1
  }
  report.cleanup.ownedBackdropClosed = !backdrop || backdrop.isDestroyed()
  report.cleanup.commandProcessesClosed = [...children].every((owned) => owned.closed)
  // On failure the real product may still own a durable screenshot draft.
  // Preserve that journal and use only its ordinary quit confirmation.
  quitConfirmationTimer = setInterval(() => {
    if (quitQueryPending || !current || current.isDestroyed()) return
    quitQueryPending = true
    void js(
      `(() => {const card=document.querySelector('.confirm-card.active'),button=Array.from(card?.querySelectorAll('button')||[]).find(node=>node.textContent.trim()==='保留并退出');if(!button||button.disabled)return false;button.click();return true;})()`
    )
      .catch(() => {})
      .finally(() => {
        quitQueryPending = false
      })
  }, 50)
}
function writeEvidence() {
  if (evidenceWritten) return
  evidenceWritten = true
  report.cleanup.errors = [...cleanupErrors]
  try {
    writeFileSync(
      join(evidenceDirectory, 'capture-compositor-evidence.json'),
      JSON.stringify(
        { ...report, completed, error: failure?.stack || failure?.message || null },
        null,
        2
      ),
      { flag: 'wx' }
    )
    evidence = {
      status:
        report.preparationDiagnosticErrors.length || report.hotkeyObservationErrors.length
          ? 'failed'
          : 'complete',
      artifacts: [
        'capture-compositor-evidence.json',
        'capture-compositor-events.jsonl',
        ...report.preparationArtifacts,
        ...report.cases.flatMap((entry) => (entry.output ? [entry.output.file] : [])),
        ...report.commands.map((_, index) => 'command-' + index + '.json'),
        ...(report.backdrop ? ['owned-backdrop-reference.png'] : [])
      ],
      scope:
        'Actual full application, native Qt PNG, verified test-owned keyboard driver, dense region comparisons and normal product quit; zero-delay candidate pixel outcomes are observations'
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
    failure ||= new Error('Owned compositor cleanup timed out')
    cleanupErrors.push(failure.message)
    record('cleanup-watchdog-fired')
    writeEvidence()
    app.exit(1)
  }, 12000)
  if (activePreparation) {
    try {
      await persistPreparationFailure(
        activePreparation,
        failure || new Error('Suite ended during preparation')
      )
    } catch (diagnosticError) {
      report.preparationDiagnosticErrors.push(diagnosticError.stack || diagnosticError.message)
    }
  }
  try {
    await restoreOwned()
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError.stack || cleanupError.message)
    process.exitCode = 1
  }
  writeEvidence()
  allowQuit = true
  record('app-quit-before')
  app.quit()
  record('app-quit-after')
}
const suiteTimeout = setTimeout(() => void finish(new Error(suite + ' timed out')), 90000)
app.on('before-quit', (event) => {
  if (allowQuit) return
  event.preventDefault()
  if (!closing) void finish(new Error('Unexpected quit before compositor suite completed'))
})
app.on('will-quit', () => {
  reachedWillQuit = true
  record('will-quit')
})
app.on('quit', (_event, code) => {
  clearTimeout(suiteTimeout)
  clearTimeout(cleanupTimeout)
  clearInterval(quitConfirmationTimer)
  const windowsClosed = BrowserWindow.getAllWindows().every((window) => window.isDestroyed())
  const liveHelperPids = [...helperPids].filter(alive)
  const helperExited = liveHelperPids.length === 0
  const hostReleased =
    !coordinator ||
    (!coordinator.host.job && !coordinator.host.socket && !coordinator.host.starting)
  const clean =
    reachedWillQuit && windowsClosed && helperExited && hostReleased && cleanupErrors.length === 0
  record('quit', {
    code,
    reachedWillQuit,
    windowsClosed,
    helperExited,
    hostReleased,
    helperPids: [...helperPids],
    liveHelperPids
  })
  recorder.finish({
    completed,
    error: failure,
    evidence,
    profileOwnership: profile.ownership,
    cleanup: {
      status: clean ? (profile.ownership === 'runner' ? 'complete' : 'preserved') : 'failed',
      reachedWillQuit,
      windowsClosed,
      helperExited,
      hostReleased,
      helperPids: [...helperPids],
      liveHelperPids,
      errors: cleanupErrors,
      exitCode: code,
      preservedProfile: profile.ownership === 'script' || failure ? profile.directory : undefined,
      scope:
        'Normal full-product quit plus this suite-owned backdrop, cursor, observer, driver/query commands and native helper; runner owns profile deletion'
    }
  })
})

mkdirSync(profile.directory, { recursive: true })
const seed = new Database(join(profile.directory, 'app.db'))
seed.exec(
  'CREATE TABLE app_settings (window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,remark TEXT DEFAULT "",created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))'
)
const insert = seed.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
for (const [type, key, value] of [
  ['application', 'active_view', 'month'],
  ['remote', 'receive_notices', 'false'],
  ['remote', 'upload_device_info', 'false'],
  ['onboarding', 'first_use_notice_version', '1'],
  ...['screenshot', 'screenshot_copy', 'clipboard_pin', 'toggle_pins', 'view_visibility'].map(
    (key) => [
      'shortcuts',
      key,
      registeredHotkeyDiagnostic && key === 'screenshot' ? registeredAccelerator : ''
    ]
  )
])
  insert.run('application', type, key, value)
seed.close()
app.setPath('userData', profile.directory)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
require(resolve('out/main/chunks', chunk))

app
  .whenReady()
  .then(async () => {
    try {
      record('startup')
      assert.equal(process.platform, 'win32')
      assert.equal(process.arch, 'x64')
      const driver = process.env.ABANDON_CAPTURE_INPUT_DRIVER
      assert.ok(
        driver && isAbsolute(driver),
        'The current capture build must supply an explicit input-driver path'
      )
      const driverFile = ownFile(realpathSync(process.cwd()), driver),
        driverBytes = readFileSync(driverFile)
      report.driver = {
        file: driverFile,
        bytes: driverBytes.length,
        sha256: createHash('sha256').update(driverBytes).digest('hex')
      }
      const displays = screen.getAllDisplays()
      assert.equal(displays.length, 1, 'This pixel/input fixture is bounded to one actual display')
      display = displays[0]
      physicalDisplay = screen.dipToScreenRect(null, display.bounds)
      report.display = { display, physicalDisplay }
      win32 = createWin32()
      originalCursor = win32.cursor()
      current = await until(
        () =>
          BrowserWindow.getAllWindows().find((window) =>
            /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
          ),
        'The actual month application window did not appear'
      )
      await until(() => current.isVisible(), 'The actual main window did not become visible')
      hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
      await until(
        () => hooks.nativeCaptureState().ready,
        'The actual native capture helper did not become ready'
      )
      coordinator = hooks.captureCoordinator()
      originalWait = coordinator.waitForCompositor
      assert.equal(typeof originalWait, 'function')
      helperIdentity = await queryProcess(coordinator.host.pid, 'initial-helper-identity')
      assert.ok(helperIdentity)
      assert.equal(helperIdentity.parentPid, process.pid)
      assert.equal(
        resolve(helperIdentity.executable).toLowerCase(),
        realpathSync(join(coordinator.host.directory, 'AbandonCapture.exe')).toLowerCase()
      )
      report.helper = helperIdentity
      helperPids.add(helperIdentity.pid)
      helperOperation = coordinator.host.operation
      helperConnection = helperOperation?.connection
      helperSocket = coordinator.host.socket
      helperJob = coordinator.host.job
      assert.ok(helperOperation && helperConnection && helperSocket && helperJob)
      assert.ok(helperOperation.socket === helperSocket && helperConnection.socket === helperSocket)
      assert.ok(helperOperation.job === helperJob && !helperSocket.destroyed)
      assert.equal(helperOperation.pid, helperIdentity.pid)
      coordinator.host.prependListener('message', tap)
      if (registeredHotkeyDiagnostic) installBusinessOpenObserver()
      await dismissStartupShortcutNotice(current)
      const zOrder = await js("window.api.setWindowZOrderMode('normal')")
      assert.equal(zOrder.mode, 'normal')
      report.zOrderMode = 'normal'
      const blur = await js('window.api.setBlurConfig({enabled:true})')
      assert.equal(blur.success, true)
      assert.equal(blur.runtime.effectiveEnabled, true)
      report.blurReceipt = blur
      await until(
        () => hooks.getBlurRuntimeHealth()?.healthy,
        'The real blur runtime is not healthy'
      )
      assert.equal((await js('window.api.getSettingsSnapshot()')).values.blur.enabled, true)
      normalBounds = current.getBounds()
      await createBackdrop()
      if (registeredHotkeyDiagnostic) {
        const baseline = await prepareCase('registered-hotkey-hidden-default80', { hide: true })
        await deliverCase(baseline, { requiredClear: true })
        assert.equal(baseline.hotkeyTrigger.dispatchCount, 1)
        assert.equal(baseline.hotkeyTrigger.completeChordSent, true)
        assert.equal(baseline.businessOpenCalls, 1)
        assert.equal(report.hotkeyObservationErrors.length, 0)
        for (const phase of [
          'qt-output-prepend-before-business-open',
          'onBusinessOpen-before',
          'qt-finished-prepend-before-product-end'
        ])
          assert.equal(
            baseline.hotkeyObservations.filter((entry) => entry.phase === phase).length,
            1
          )
        assert.equal(
          baseline.hotkeyObservations.filter((entry) =>
            ['onBusinessOpen-fulfilled', 'onBusinessOpen-sync-return'].includes(entry.phase)
          ).length,
          1,
          'One side observation records the original business-open result without replacing it'
        )
        assert.equal(coordinator.host.pid, helperIdentity.pid)
        assert.equal(hooks.nativeCaptureState().active, false)
        assert.equal(hooks.getDockRuntimeState().screenshotCaptureActive, false)
        report.diagnostic = {
          status: 'completed',
          scope:
            'One default80 hidden-source arm triggered through the actual registered global accelerator using SendInput, with required unassisted business-window presentation; not full E7.4 or hardware-user focus acceptance',
          accelerator: registeredAccelerator,
          case: baseline.name,
          casesCompleted: 1,
          candidateCaptureSent: false,
          cancellationTested: false
        }
        record('registered-hotkey-diagnostic-complete', report.diagnostic)
        await finish(null, true)
        return
      }
      const negative = await prepareCase('negative-visible-default80', { hide: false })
      await deliverCase(negative, { negative: true })
      const baseline = await prepareCase('hidden-default80', { hide: true })
      await deliverCase(baseline, { requiredClear: true })
      const candidate = await prepareCase('hidden-candidate0', { hide: true, zero: true })
      if (preconditionDiagnostic) {
        report.diagnostic = {
          status: 'completed',
          scope:
            'Actual negative/default80 prefix and next candidate preparation only; no candidate capture or full E7.4 acceptance',
          prefixCases: [negative.name, baseline.name],
          candidatePreparation: candidate.name,
          candidateCaptureSent: false
        }
        assert.equal(candidate.started, undefined)
        assert.equal(coordinator.host.pid, helperIdentity.pid)
        assert.equal(hooks.nativeCaptureState().active, false)
        assert.equal(hooks.getDockRuntimeState().screenshotCaptureActive, false)
        record('precondition-diagnostic-complete', report.diagnostic)
        await finish(null, true)
        return
      }
      await deliverCase(candidate)
      const hiddenReference = await prepareCase('already-hidden-reference0', {
        hide: true,
        zero: true,
        alreadyHidden: true
      })
      await deliverCase(hiddenReference, { requiredClear: true })
      const cancelled = await prepareCase('cancel-candidate0', { hide: true, zero: true })
      await startCase(cancelled)
      await press('F')
      await press('AltF4')
      await until(
        () => !hooks.nativeCaptureState().active,
        'The real Alt+F4 cancellation did not finish'
      )
      await until(
        () => current.isVisible(),
        'Cancellation did not restore the originally visible source'
      )
      const restored = await until(() => {
        const samples = desktopSamples(cancelled.markerPoints)
        return samples.every((sample) => matches(sample.rgb, markerRgb)) ? samples : null
      }, 'Cancellation did not physically restore the original main-window marker')
      cancelled.restoredDesktop = restored
      assert.equal(cancelled.output, undefined)
      assert.equal(
        cancelled.messages.filter(
          (message) =>
            message.type === 'finished' && message.sessionId === cancelled.started.sessionId
        ).length,
        1
      )
      assert.equal(
        cancelled.messages.find(
          (message) =>
            message.type === 'finished' && message.sessionId === cancelled.started.sessionId
        ).status,
        'cancelled'
      )
      assert.equal(hooks.getDockRuntimeState().screenshotCaptureActive, false)
      assertForegroundHandoff(
        cancelled.messages.find(
          (message) =>
            message.type === 'finished' && message.sessionId === cancelled.started.sessionId
        ),
        'cancelled',
        cancelled.started.sessionId
      )
      await js("document.getElementById('capture-compositor-marker')?.remove();true")
      const next = await prepareCase('after-cancel-candidate0', { hide: true, zero: true })
      await deliverCase(next)
      report.comparison = {
        default80: baseline.comparison,
        candidate0: candidate.comparison,
        alreadyHidden0: hiddenReference.comparison,
        afterCancel0: next.comparison,
        candidateClearOnObservedRuns: candidate.comparison.clear && next.comparison.clear,
        scope:
          'Single-machine numerical comparison; no automatic authorization to remove the default wait'
      }
      assert.equal(coordinator.host.pid, helperIdentity.pid)
      assert.equal(hooks.getDockRuntimeState().screenshotCaptureActive, false)
      await finish(null, true)
    } catch (error) {
      console.error(error)
      await finish(error)
    }
  })
  .catch((error) => void finish(error))
