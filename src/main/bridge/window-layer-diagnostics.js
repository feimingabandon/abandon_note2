import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)
const MAX_OVERLAYS = 64
const MAX_CHAIN = 256
const MAX_RECORDED_WINDOWS = 8
const hex = (value) => '0x' + BigInt(value || 0).toString(16)
const sameHandle = (left, right) => BigInt(left || 0) === BigInt(right || 0)
const intersects = (left, right) =>
  Boolean(
    left &&
    right &&
    Math.max(left.left, right.left) < Math.min(left.right, right.right) &&
    Math.max(left.top, right.top) < Math.min(left.bottom, right.bottom)
  )

let nativeReader
function getNativeReader() {
  if (nativeReader) return nativeReader
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  const rectType = koffi.struct({
    left: 'int32_t',
    top: 'int32_t',
    right: 'int32_t',
    bottom: 'int32_t'
  })
  const findOverlay = user32.func('uintptr_t FindWindowExA(uintptr_t, uintptr_t, str, str)')
  const getWindow = user32.func('uintptr_t GetWindow(uintptr_t, uint32_t)')
  const isWindow = user32.func('int IsWindow(uintptr_t)')
  const isVisible = user32.func('int IsWindowVisible(uintptr_t)')
  const isIconic = user32.func('int IsIconic(uintptr_t)')
  const getPid = user32.func('uint32_t GetWindowThreadProcessId(uintptr_t, _Out_ uint32_t *)')
  const getClass = user32.func('int GetClassNameA(uintptr_t, _Out_ uint8_t *, int)')
  const getStyle = user32.func('intptr_t GetWindowLongPtrW(uintptr_t, int)')
  const getRect = user32.func('GetWindowRect', 'int', [
    'uintptr_t',
    koffi.out(koffi.pointer(rectType))
  ])
  const getCloaked = dwmapi.func(
    'int32_t DwmGetWindowAttribute(uintptr_t, uint32_t, _Out_ uint32_t *, uint32_t)'
  )
  nativeReader = {
    findOverlay: (after) => findOverlay(0n, after, 'BlurOverlayWindow', null),
    next: (hwnd) => getWindow(hwnd, 2),
    read(hwnd) {
      if (!isWindow(hwnd)) return { hwnd: hex(hwnd), valid: false }
      const pid = [0]
      const tid = getPid(hwnd, pid)
      const buffer = Buffer.alloc(256)
      const length = getClass(hwnd, buffer, buffer.length)
      const rect = {}
      const rectValid = Boolean(getRect(hwnd, rect))
      const style = BigInt(getStyle(hwnd, -20))
      const cloaked = [0]
      const cloakResult = getCloaked(hwnd, 14, cloaked, 4)
      return {
        hwnd: hex(hwnd),
        valid: true,
        pid: pid[0],
        tid,
        className: length > 0 ? buffer.toString('ascii', 0, length) : null,
        topmost: (style & 8n) !== 0n,
        topmostKnown: style !== 0n,
        visible: Boolean(isVisible(hwnd)),
        iconic: Boolean(isIconic(hwnd)),
        cloaked: cloakResult === 0 ? cloaked[0] : null,
        cloakResult,
        owner: hex(getWindow(hwnd, 4)),
        next: hex(getWindow(hwnd, 2)),
        prev: hex(getWindow(hwnd, 3)),
        rectValid,
        rect: rectValid ? rect : null
      }
    }
  }
  return nativeReader
}

/** Bounded observations only: no setter, wait, queue acknowledgement, title or content read. */
export function captureWindowLayerSnapshot(reader, { parentHwnd, pid }) {
  const started = performance.now()
  const result = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    nonAtomicReads: true,
    nativeQueueAcknowledgement: 'unavailable',
    limits: {
      overlayEnumeration: MAX_OVERLAYS,
      orderChain: MAX_CHAIN,
      recordedWindows: MAX_RECORDED_WINDOWS
    },
    classification: 'unknown',
    adjacencyObserved: null,
    pairStable: null,
    parent: null,
    overlay: null,
    blocker: null,
    parentAfter: null,
    overlayAfter: null,
    chain: null
  }
  try {
    result.parent = reader.read(parentHwnd)
    if (!result.parent.valid || result.parent.pid !== pid) {
      result.classification = 'invalid-parent'
      return result
    }
    const seenOverlays = new Set()
    const matches = []
    let after = 0n
    let enumeration = 'limit'
    for (let count = 0; count < MAX_OVERLAYS; count++) {
      const candidate = reader.findOverlay(after)
      if (!BigInt(candidate || 0)) {
        enumeration = 'end'
        break
      }
      const key = hex(candidate)
      if (seenOverlays.has(key)) {
        enumeration = 'cycle'
        break
      }
      seenOverlays.add(key)
      const state = reader.read(candidate)
      if (state.valid && state.pid === pid && state.className === 'BlurOverlayWindow')
        matches.push(state)
      after = candidate
    }
    result.overlayEnumeration = {
      termination: enumeration,
      observed: seenOverlays.size,
      matches: matches.length
    }
    if (enumeration !== 'end' || matches.length !== 1) {
      result.classification =
        enumeration !== 'end'
          ? 'overlay-enumeration-incomplete'
          : matches.length
            ? 'multiple-overlay-matches'
            : 'no-overlay-match'
      return result
    }
    result.overlay = matches[0]
    const overlayHwnd = BigInt(result.overlay.hwnd)
    result.chain = { visited: 0, termination: 'end', firstWindows: [] }
    const seen = new Set()
    let candidate = reader.next(parentHwnd)
    let reached = false
    while (BigInt(candidate || 0)) {
      const key = hex(candidate)
      if (seen.has(key)) {
        result.chain.termination = 'cycle'
        break
      }
      if (seen.size >= MAX_CHAIN) {
        result.chain.termination = 'limit'
        break
      }
      seen.add(key)
      if (sameHandle(candidate, overlayHwnd)) {
        reached = true
        result.chain.termination = 'overlay-reached'
        break
      }
      const state = reader.read(candidate)
      if (result.chain.firstWindows.length < MAX_RECORDED_WINDOWS)
        result.chain.firstWindows.push({
          hwnd: state.hwnd,
          pid: state.pid,
          className: state.className?.slice(0, 80) ?? null,
          visible: state.visible
        })
      if (
        !result.blocker &&
        state.valid &&
        state.visible &&
        state.rectValid &&
        intersects(result.parent.rect, state.rect)
      )
        result.blocker = state
      candidate = reader.next(candidate)
    }
    result.chain.visited = seen.size
    result.parentAfter = reader.read(parentHwnd)
    result.overlayAfter = reader.read(overlayHwnd)
    result.pairStable =
      JSON.stringify(result.parent) === JSON.stringify(result.parentAfter) &&
      JSON.stringify(result.overlay) === JSON.stringify(result.overlayAfter)
    if (!result.pairStable) result.classification = 'pair-changed-during-observation'
    else if (!result.parent.rectValid) result.classification = 'invalid-parent-rect'
    else if (result.parent.topmostKnown === false || result.overlay.topmostKnown === false)
      result.classification = 'window-style-read-inconclusive'
    else if (result.parent.topmost !== result.overlay.topmost) {
      result.classification = 'topmost-band-mismatch'
      result.adjacencyObserved = false
    } else if (result.blocker) {
      // Mirrors the current native predicate. Cloaked/iconic are evidence, not a rule change.
      result.classification = 'visible-intersecting-window-before-overlay'
      result.adjacencyObserved = false
    } else if (reached) {
      result.classification = 'overlay-reached-without-visible-intersecting-blocker'
      result.adjacencyObserved = true
    } else if (result.chain.termination === 'end') {
      result.classification = 'overlay-not-below-parent'
      result.adjacencyObserved = false
    } else result.classification = 'order-chain-incomplete'
    return result
  } catch (error) {
    result.classification = 'observation-failed'
    result.adjacencyObserved = null
    result.error = error?.message || String(error)
    return result
  } finally {
    result.finishedAt = new Date().toISOString()
    result.durationMs = Math.round((performance.now() - started) * 1000) / 1000
  }
}

/** Called once, before rollback, only after the original confirmation has already failed. */
export function captureWindowLayerDiagnostic(window) {
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64')
      return { classification: 'unsupported' }
    if (!window || window.isDestroyed()) return { classification: 'window-unavailable' }
    const parentHwnd = window.getNativeWindowHandle().readBigUInt64LE(0)
    return captureWindowLayerSnapshot(getNativeReader(), { parentHwnd, pid: process.pid })
  } catch (error) {
    return {
      classification: 'observation-failed',
      adjacencyObserved: null,
      error: error?.message || String(error)
    }
  }
}
