import { describe, expect, it } from 'vitest'
import {
  captureWindowLayerDiagnostic,
  captureWindowLayerSnapshot
} from '../src/main/bridge/window-layer-diagnostics.js'
import { sanitizeDiagnosticValue } from '../src/shared/diagnostic-sanitize.js'
import { encodeLogRecord } from '../src/main/logging/log-store.mjs'

function fixture() {
  const state = (hwnd, extra = {}) => ({
    hwnd: '0x' + hwnd.toString(16),
    valid: true,
    pid: 17,
    tid: 23,
    className: hwnd === 2 ? 'BlurOverlayWindow' : 'ExampleWindow',
    topmost: false,
    topmostKnown: true,
    visible: true,
    iconic: false,
    cloaked: 0,
    cloakResult: 0,
    owner: '0x0',
    next: '0x2',
    prev: '0x1',
    rectValid: true,
    rect: { left: 10, top: 10, right: 100, bottom: 100 },
    ...extra
  })
  const states = new Map([
    [1, state(1)],
    [2, state(2)],
    [3, state(3, { visible: false })]
  ])
  const next = new Map([
    [1, 3n],
    [3, 2n],
    [2, 0n]
  ])
  const overlays = [2n]
  const reader = {
    read: (hwnd) => ({ ...states.get(Number(hwnd)) }),
    next: (hwnd) => next.get(Number(hwnd)) ?? 0n,
    findOverlay: (after) => overlays[overlays.indexOf(BigInt(after)) + 1] ?? 0n
  }
  const capture = () => captureWindowLayerSnapshot(reader, { parentHwnd: 1n, pid: 17 })
  return { states, state, next, overlays, reader, capture }
}

describe('failure-only window layer observations', () => {
  it('preserves the cause and pair evidence through the existing warn-record budget', () => {
    const f = fixture()
    f.next.set(1, 10n)
    for (let index = 10; index <= 18; index++) {
      f.states.set(
        index,
        f.state(index, {
          visible: index === 18,
          className: 'ExampleAuxiliaryWindowClassWithDetailedName'
        })
      )
      f.next.set(index, index === 18 ? 2n : BigInt(index + 1))
    }
    const captured = f.capture()
    const logged = sanitizeDiagnosticValue(
      { mode: 'top', lastCheckedAt: captured.at, windowLayers: captured },
      { maxBytes: 8192, maxDepth: 6, maxArray: 32, maxNodes: 256 }
    )
    expect(logged.windowLayers).toMatchObject({
      classification: 'visible-intersecting-window-before-overlay',
      adjacencyObserved: false,
      pairStable: true,
      blocker: { hwnd: '0x12', cloaked: 0 },
      parentAfter: { hwnd: '0x1' },
      overlayAfter: { hwnd: '0x2' }
    })
    const line = encodeLogRecord({
      schemaVersion: 3,
      id: 'diagnostic-test-record',
      time: captured.at,
      receivedAt: captured.at,
      monotonicMs: 100,
      level: 'warn',
      process: 'main',
      scope: 'window.z-order-layers',
      message: '窗口层级核验失败时的只读窗口观察',
      kind: 'event',
      sessionId: 'diagnostic-test-session',
      pid: 17,
      appVersion: '1.3.0',
      platform: 'win32',
      arch: 'x64',
      versions: { electron: '43.4.0', chrome: '150.0.7871.224', node: '24.18.1' },
      mode: 'daily',
      policyEpoch: 0,
      receiptPolicyEpoch: 0,
      captureId: null,
      storage: 'app',
      metadata: logged
    })
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(8192)
    expect(JSON.parse(line).metadata.windowLayers).toMatchObject({
      pairStable: true,
      blocker: { hwnd: '0x12' },
      overlayAfter: { hwnd: '0x2' }
    })
  })
  it('ignores invisible auxiliary HWNDs and requires the exact same-process Overlay', () => {
    const f = fixture()
    f.overlays.unshift(9n)
    f.states.set(9, f.state(9, { pid: 90, className: 'BlurOverlayWindow' }))
    expect(f.capture()).toMatchObject({
      classification: 'overlay-reached-without-visible-intersecting-blocker',
      adjacencyObserved: true,
      overlayEnumeration: { termination: 'end', matches: 1 },
      pairStable: true,
      chain: { termination: 'overlay-reached' },
      nativeQueueAcknowledgement: 'unavailable'
    })
  })

  it('distinguishes a band mismatch from an intersecting intervening window', () => {
    const f = fixture()
    f.states.get(1).topmost = true
    expect(f.capture()).toMatchObject({
      classification: 'topmost-band-mismatch',
      adjacencyObserved: false
    })
    f.states.get(1).topmostKnown = false
    expect(f.capture()).toMatchObject({
      classification: 'window-style-read-inconclusive',
      adjacencyObserved: null
    })
    f.states.get(1).topmostKnown = true
    f.states.get(2).topmost = true
    f.states.get(3).visible = true
    expect(f.capture()).toMatchObject({
      classification: 'visible-intersecting-window-before-overlay',
      adjacencyObserved: false,
      blocker: { hwnd: '0x3' }
    })
  })

  it('records cloaked and iconic blockers without changing the native visibility predicate', () => {
    const f = fixture()
    Object.assign(f.states.get(3), { visible: true, cloaked: 1, iconic: true })
    expect(f.capture()).toMatchObject({
      classification: 'visible-intersecting-window-before-overlay',
      blocker: { cloaked: 1, iconic: true },
      adjacencyObserved: false
    })
  })

  it('does not choose among multiple Overlays or classify missing candidates as adjacency failure', () => {
    const f = fixture()
    f.overlays.push(4n)
    f.states.set(4, f.state(4, { className: 'BlurOverlayWindow' }))
    expect(f.capture()).toMatchObject({
      classification: 'multiple-overlay-matches',
      adjacencyObserved: null
    })
    f.overlays.length = 0
    expect(f.capture()).toMatchObject({
      classification: 'no-overlay-match',
      adjacencyObserved: null
    })
  })

  it('bounds cyclic and truncated chains, retains eight samples, and preserves unknown', () => {
    const f = fixture()
    f.next.set(3, 3n)
    expect(f.capture()).toMatchObject({
      classification: 'order-chain-incomplete',
      adjacencyObserved: null,
      chain: { termination: 'cycle' }
    })
    f.next.set(1, 10n)
    for (let index = 10; index <= 300; index++) {
      f.states.set(index, f.state(index, { visible: false }))
      f.next.set(index, BigInt(index + 1))
    }
    const snapshot = f.capture()
    expect(snapshot).toMatchObject({
      classification: 'order-chain-incomplete',
      adjacencyObserved: null,
      chain: { termination: 'limit', visited: 256 }
    })
    expect(snapshot.chain.firstWindows).toHaveLength(8)
  })

  it('does not infer a unique match when exact enumeration repeats a handle or reaches its limit', () => {
    const f = fixture()
    f.reader.findOverlay = () => 2n
    expect(f.capture()).toMatchObject({
      classification: 'overlay-enumeration-incomplete',
      adjacencyObserved: null,
      overlayEnumeration: { termination: 'cycle' }
    })
    f.reader.findOverlay = (after) => BigInt(after) + 1n
    f.reader.read = (hwnd) => f.state(Number(hwnd), { className: 'BlurOverlayWindow' })
    expect(f.capture()).toMatchObject({
      classification: 'overlay-enumeration-incomplete',
      adjacencyObserved: null,
      overlayEnumeration: { termination: 'limit', observed: 64 }
    })
  })

  it('marks a changing pair and native read errors as unknown without throwing', () => {
    const f = fixture()
    const read = f.reader.read
    let parentReads = 0
    f.reader.read = (hwnd) => ({
      ...read(hwnd),
      ...(hwnd === 1n && ++parentReads > 1 ? { topmost: true } : {})
    })
    expect(f.capture()).toMatchObject({
      classification: 'pair-changed-during-observation',
      adjacencyObserved: null
    })
    f.reader.read = () => {
      throw new Error('read failed')
    }
    expect(f.capture()).toMatchObject({
      classification: 'observation-failed',
      adjacencyObserved: null,
      error: 'read failed'
    })
    expect(
      captureWindowLayerDiagnostic({
        isDestroyed: () => false,
        getNativeWindowHandle: () => {
          throw new Error('handle failed')
        }
      })
    ).toMatchObject({
      classification: process.platform === 'win32' ? 'observation-failed' : 'unsupported'
    })
  })
})
