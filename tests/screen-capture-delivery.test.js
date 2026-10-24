import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, h } from 'vue'
import {
  createCaptureDeliveryOperation,
  useScreenCapture
} from '../src/renderer/src/composables/useScreenCapture.js'

const identity = { sessionId: 'session-a', deliveryId: 'delivery-a' }
let api, stateListeners, deliveryListeners, finishedListeners
const apps = []
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function listen(listeners) {
  return vi.fn((callback) => {
    listeners.add(callback)
    return vi.fn(() => listeners.delete(callback))
  })
}
function terminal(state, ids = identity) {
  for (const callback of [...stateListeners])
    callback({ ...ids, state, message: 'controlled terminal' })
}
const renderer = createRenderer({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert() {},
  remove() {},
  setText() {},
  setElementText() {},
  patchProp() {},
  parentNode: () => null,
  nextSibling: () => null
})
function mountCapture() {
  let capture
  const app = renderer.createApp({
    setup() {
      capture = useScreenCapture()
      return () => h('div')
    }
  })
  app.mount({})
  apps.push(app)
  return { capture, app }
}
beforeEach(() => {
  stateListeners = new Set()
  deliveryListeners = new Set()
  finishedListeners = new Set()
  api = {
    onScreenshotDeliveryState: listen(stateListeners),
    onScreenshotDelivery: listen(deliveryListeners),
    onScreenshotFinished: listen(finishedListeners),
    reportScreenshotDelivery: vi.fn(async () => true),
    acknowledgeScreenshot: vi.fn(async () => true),
    invalidateScreenshotSource: vi.fn(async () => true),
    captureScreen: vi.fn(async () => ({ status: 'started' }))
  }
  vi.stubGlobal('window', { api })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('capture delivery receiver operation', () => {
  it('uses the actual identity for progress and consumes its final ACK once', async () => {
    const operation = createCaptureDeliveryOperation(identity)
    expect(await operation.report('received')).toBe(true)
    expect(await operation.report('processing')).toBe(true)
    expect(api.reportScreenshotDelivery.mock.calls).toEqual([
      [{ ...identity, state: 'received' }],
      [{ ...identity, state: 'processing' }]
    ])
    expect(await operation.finish(true)).toBe(true)
    expect(await operation.finish(true)).toBe(false)
    expect(api.acknowledgeScreenshot).toHaveBeenCalledExactlyOnceWith({
      ...identity,
      accepted: true,
      message: ''
    })
    expect(stateListeners.size).toBe(0)
  })

  it('ignores other identities and interrupts only its own user wait on rejection', async () => {
    const operation = createCaptureDeliveryOperation(identity)
    const waiting = deferred()
    const result = operation.wait(waiting.promise).catch((error) => error.code)
    terminal('rejected', { ...identity, deliveryId: 'other' })
    expect(operation.isCurrent()).toBe(true)
    terminal('rejected')
    expect(await result).toBe('CAPTURE_DELIVERY_EXPIRED')
    waiting.resolve(true)
    expect(await operation.report('processing')).toBe(false)
    expect(await operation.finish(true)).toBe(false)
    expect(api.acknowledgeScreenshot).not.toHaveBeenCalled()
    expect(stateListeners.size).toBe(0)
  })

  it('does not enter work after a refused or cancelled in-flight received report', async () => {
    const report = deferred()
    api.reportScreenshotDelivery.mockReturnValueOnce(report.promise)
    const operation = createCaptureDeliveryOperation(identity)
    const received = operation.report('received')
    terminal('rejected')
    report.resolve(true)
    expect(await received).toBe(false)
    expect(api.acknowledgeScreenshot).not.toHaveBeenCalled()
    const next = createCaptureDeliveryOperation({ ...identity, deliveryId: 'next' })
    api.reportScreenshotDelivery.mockResolvedValueOnce(false)
    expect(await next.report('received')).toBe(false)
    expect(next.isCurrent()).toBe(false)
    expect(stateListeners.size).toBe(0)
  })

  it('reports a local cancellation once and keeps late terminal messages inert', async () => {
    const operation = createCaptureDeliveryOperation(identity)
    const cancelled = vi.fn()
    operation.onCancel(cancelled)
    operation.cancel('source replaced')
    operation.cancel('duplicate')
    terminal('accepted')
    expect(cancelled).toHaveBeenCalledOnce()
    expect(api.acknowledgeScreenshot).toHaveBeenCalledExactlyOnceWith({
      ...identity,
      accepted: false,
      message: 'source replaced'
    })
    expect(stateListeners.size).toBe(0)
  })

  it('preserves main acceptance received before its invoke response without a second ACK', async () => {
    const acknowledgment = deferred()
    api.acknowledgeScreenshot.mockReturnValueOnce(acknowledgment.promise)
    const operation = createCaptureDeliveryOperation(identity)
    const accepted = operation.finish(true)
    terminal('accepted')
    acknowledgment.resolve(true)
    expect(await accepted).toBe(true)
    operation.cancel('component closed')
    expect(api.acknowledgeScreenshot).toHaveBeenCalledOnce()
    expect(stateListeners.size).toBe(0)
  })

  it('does not retry an ambiguous final invoke failure or leave its listener attached', async () => {
    api.acknowledgeScreenshot.mockRejectedValueOnce(new Error('transport closed'))
    const operation = createCaptureDeliveryOperation(identity)
    expect(await operation.finish(true)).toBe(false)
    expect(operation.isCurrent()).toBe(false)
    expect(api.acknowledgeScreenshot).toHaveBeenCalledOnce()
    expect(stateListeners.size).toBe(0)
  })
})

describe('source capture session ownership', () => {
  it('suppresses an old receiver continuation while a new delivery can finish in the same session', async () => {
    const { capture } = mountCapture()
    const held = deferred()
    const accept = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce(true)
    const finished = capture('note', accept)
    const token = api.captureScreen.mock.calls[0][0].token
    const deliver = [...deliveryListeners][0]
    const first = deliver({ ...identity, action: 'source', token })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    terminal('rejected')
    const nextIdentity = { ...identity, deliveryId: 'delivery-b' }
    await deliver({ ...nextIdentity, action: 'source', token })
    held.resolve(true)
    await first
    expect(api.acknowledgeScreenshot).toHaveBeenCalledExactlyOnceWith({
      ...nextIdentity,
      accepted: true,
      message: ''
    })
    for (const callback of [...finishedListeners]) callback({ token, status: 'delivered' })
    expect(await finished).toEqual({ token, status: 'delivered' })
    expect(deliveryListeners.size).toBe(0)
    expect(finishedListeners.size).toBe(0)
    expect(stateListeners.size).toBe(0)
  })

  it('does not let a late launch response clean a replacement local capture', async () => {
    const launch = deferred()
    api.captureScreen.mockReturnValueOnce(launch.promise)
    const { capture } = mountCapture()
    const first = capture('note', vi.fn())
    const oldToken = api.captureScreen.mock.calls[0][0].token
    capture.invalidate()
    expect(await first).toEqual({ status: 'source-gone' })
    const second = capture('note', vi.fn())
    const token = api.captureScreen.mock.calls[1][0].token
    launch.resolve({ status: 'busy' })
    await Promise.resolve()
    expect(deliveryListeners.size).toBe(1)
    for (const callback of [...finishedListeners])
      callback({ token: oldToken, status: 'cancelled' })
    expect(finishedListeners.size).toBe(1)
    for (const callback of [...finishedListeners]) callback({ token, status: 'cancelled' })
    await second
    expect(deliveryListeners.size).toBe(0)
  })
})
