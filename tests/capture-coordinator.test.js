import { EventEmitter } from 'node:events'
import { afterEach, describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { CaptureCoordinator } from '../src/main/capture/CaptureCoordinator.js'

const coordinators = []
function setup(options = {}) {
  const frame = { isDestroyed: () => false }
  const sender = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    isDestroyed: () => false,
    mainFrame: frame
  })
  const coordinator = new CaptureCoordinator({
    onCaptureStart: vi.fn(),
    onCaptureEnd: vi.fn(),
    getMainWindow: () => ({ webContents: sender }),
    ...options
  })
  coordinator.host = { start: vi.fn(async () => {}), send: vi.fn(), dispose: vi.fn() }
  coordinator.assets = {
    create: vi.fn(async () => 'session-1'),
    read: vi.fn(async () => ({ dataUrl: 'png' })),
    release: vi.fn(async () => {}),
    dispose: vi.fn()
  }
  coordinators.push(coordinator)
  return { coordinator, sender, frame }
}
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.dispose()))
  vi.useRealTimers()
})

function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
async function startCapture(fixture, options = {}) {
  const started = fixture.coordinator.capture({
    sender: fixture.sender,
    token: 'draft',
    ...options
  })
  await vi.advanceTimersByTimeAsync(80)
  await started
  await fixture.coordinator.message({ type: 'captureReady', sessionId: 'session-1' })
}
function output(coordinator, deliveryId = 'asset', action = 'source') {
  return coordinator.message({ type: 'output', sessionId: 'session-1', deliveryId, action })
}
const identity = (deliveryId = 'asset') => ({ sessionId: 'session-1', deliveryId })
function processing(coordinator, sender, deliveryId = 'asset') {
  expect(coordinator.progress(sender, { ...identity(deliveryId), state: 'received' })).toBe(true)
  expect(coordinator.progress(sender, { ...identity(deliveryId), state: 'processing' })).toBe(true)
}
describe('capture single session and acknowledgements', () => {
  it('keeps the default compositor wait at 80ms and allows an explicit isolated comparison', async () => {
    vi.useFakeTimers()
    const original = setup()
    const started = original.coordinator.capture()
    await vi.advanceTimersByTimeAsync(79)
    expect(original.coordinator.host.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await started).toMatchObject({ status: 'started' })
    expect(original.coordinator.host.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'capture', sessionId: 'session-1' })
    )

    const comparisonWait = vi.fn(async () => {})
    const comparison = setup({ waitForCompositor: comparisonWait })
    expect(await comparison.coordinator.capture()).toMatchObject({ status: 'started' })
    expect(comparisonWait).toHaveBeenCalledTimes(1)
    expect(comparison.coordinator.host.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'capture', sessionId: 'session-1' })
    )
  })
  it('does not freeze a cancelled session after its compositor wait settles late', async () => {
    vi.useFakeTimers()
    const waiting = deferred()
    const { coordinator: c } = setup({ waitForCompositor: () => waiting.promise })
    const started = c.capture()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.active?.id).toBe('session-1')
    c.cancel()
    waiting.resolve()
    expect(await started).toEqual({ status: 'cancelled' })
    expect(c.host.send.mock.calls.some(([message]) => message.type === 'capture')).toBe(false)
  })
  it('sends the explicit copy mode for global capture and keeps a running session mode unchanged', async () => {
    const { coordinator: c } = setup()
    await c.capture({ mode: 'copy-on-select' })
    expect(c.host.send).toHaveBeenLastCalledWith({
      type: 'capture',
      sessionId: 'session-1',
      origin: 'global',
      mode: 'copy-on-select'
    })
    expect(await c.capture({ mode: 'edit' })).toEqual({ status: 'busy' })
    expect(c.active.mode).toBe('copy-on-select')
    c.finish('cancelled')
  })
  it('retains editing for source captures and unknown modes', async () => {
    for (const options of [{ origin: 'note', mode: 'copy-on-select' }, { mode: 'other' }]) {
      const { coordinator: c } = setup()
      await c.capture(options)
      expect(c.active.mode).toBe('edit')
      expect(c.host.send).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'edit' }))
      c.finish('cancelled')
    }
  })
  it('records only bounded numeric monitor metadata for the current capture', async () => {
    const { coordinator: c } = setup()
    c.logger = { info: vi.fn() }
    await c.capture()
    const layout = {
      physical: [-1920, 0, 1920, 1080],
      logical: [-1920, 0, 1536, 864],
      image: 'must not be logged'
    }
    await c.message({ type: 'captureReady', sessionId: 'old', displays: [layout] })
    expect(c.logger.info).not.toHaveBeenCalled()
    await c.message({
      type: 'captureReady',
      sessionId: 'session-1',
      displays: [layout, null, { physical: ['private'], logical: [] }],
      image: 'must not be logged'
    })
    expect(c.logger.info).toHaveBeenLastCalledWith('capture.ready', '截图桌面已冻结', {
      sessionId: 'session-1',
      displays: [{ physical: layout.physical, logical: layout.logical }]
    })
    c.finish('cancelled')
  })
  it('syncs validated host colors only to a ready helper', () => {
    const { coordinator: c } = setup()
    c.getTheme = () => ({ bgColor: '17 24 32', textColor: '#eff5ff' })
    c.syncTheme()
    expect(c.host.send).not.toHaveBeenCalled()
    c.host.ready = true
    c.syncTheme()
    expect(c.host.send).toHaveBeenLastCalledWith({
      type: 'theme',
      theme: { background: '#111820', foreground: '#eff5ff' }
    })
    c.getTheme = () => ({ bgColor: '999 2 3', textColor: 'invalid' })
    c.syncTheme()
    expect(c.host.send).toHaveBeenLastCalledWith({
      type: 'theme',
      theme: { background: '#ffffff', foreground: '#1d1d1f' }
    })
  })
  it('invalidates a source that reloads during helper startup', async () => {
    const { coordinator: c, sender } = setup()
    let ready
    c.host.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve
        })
    )
    const capture = c.capture({ sender, token: 'draft' })
    sender.emit('did-start-navigation', {}, 'app://reload', false, true)
    ready()
    await capture
    expect(c.active.sender).toBeNull()
    c.finish('cancelled')
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
  it('coalesces preparation and ignores late completion while restoring once', async () => {
    const { coordinator: c } = setup()
    const first = c.capture()
    expect(await c.capture()).toEqual({ status: 'busy' })
    await first
    expect(c.onCaptureStart).toHaveBeenCalledTimes(1)
    await c.message({ type: 'captureReady', sessionId: 'session-1' })
    await c.message({ type: 'finished', sessionId: 'old', status: 'copied' })
    expect(c.active).not.toBeNull()
    await c.message({ type: 'finished', sessionId: 'session-1', status: 'copied' })
    c.finish('cancelled')
    expect(c.onCaptureEnd).toHaveBeenCalledTimes(1)
    expect(c.assets.release).toHaveBeenCalledTimes(1)
  })
  it('keeps the capture on failed delivery and accepts only the actual recipient and delivery ID', async () => {
    const { coordinator: c, sender } = setup()
    await c.capture({ sender, token: 'draft' })
    await c.message({ type: 'captureReady', sessionId: 'session-1' })
    await c.message({
      type: 'output',
      action: 'source',
      sessionId: 'session-1',
      deliveryId: 'asset'
    })
    expect(c.active).not.toBeNull()
    expect(c.assets.release).not.toHaveBeenCalled()
    expect(c.ack({}, { sessionId: 'session-1', deliveryId: 'asset', accepted: true })).toBe(false)
    expect(c.ack(sender, { sessionId: 'session-1', deliveryId: 'old', accepted: true })).toBe(false)
    expect(c.ack(sender, { sessionId: 'session-1', deliveryId: 'asset', accepted: false })).toBe(
      true
    )
    expect(c.active).not.toBeNull()
    await c.message({
      type: 'output',
      action: 'source',
      sessionId: 'session-1',
      deliveryId: 'retry'
    })
    processing(c, sender, 'retry')
    expect(c.ack(sender, { sessionId: 'session-1', deliveryId: 'retry', accepted: true })).toBe(
      true
    )
    c.finish('delivered')
    expect(c.onCaptureEnd).toHaveBeenCalledTimes(1)
  })
  it('restores lifecycle state after failed preparation and permits retry', async () => {
    const { coordinator: c } = setup()
    c.onCaptureStart.mockRejectedValueOnce(Error('hide failed'))
    await expect(c.capture()).rejects.toThrow('hide failed')
    expect(c.active).toBeNull()
    expect(c.pending).toBe(false)
    expect(c.onCaptureEnd).toHaveBeenCalledTimes(1)
    await c.capture()
    c.cancel()
    expect(c.onCaptureEnd).toHaveBeenCalledTimes(2)
  })
  it.each(['render-process-gone', 'did-start-navigation', 'destroyed'])(
    'restores the native selection if the receiver emits %s',
    async (event) => {
      const { coordinator: c, sender } = setup()
      await c.capture({ sender, token: 'draft' })
      await c.message({ type: 'captureReady', sessionId: 'session-1' })
      await c.message({
        type: 'output',
        action: 'source',
        sessionId: 'session-1',
        deliveryId: 'asset'
      })
      sender.emit(event, {}, 'app://reload', false, true)
      expect(c.host.send).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'ack', accepted: false, deliveryId: 'asset' })
      )
      expect(c.active.sender).toBeNull()
      expect(c.active.delivery).toBeNull()
      expect(c.active).not.toBeNull()
      c.finish('cancelled')
      for (const name of ['destroyed', 'did-start-navigation', 'render-process-gone'])
        expect(sender.listenerCount(name)).toBe(0)
    }
  )
  it('rejects a stale source after reload but permits same-document navigation', async () => {
    const { coordinator: c, sender } = setup()
    await c.capture({ sender, token: 'draft' })
    await c.message({ type: 'captureReady', sessionId: 'session-1' })
    sender.emit('did-start-navigation', {}, 'app://route', true, true)
    expect(c.active.sender).toBe(sender)
    sender.emit('did-start-navigation', {}, 'app://reload', false, true)
    await c.message({
      type: 'output',
      action: 'source',
      sessionId: 'session-1',
      deliveryId: 'asset'
    })
    expect(c.host.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'ack', accepted: false })
    )
    expect(sender.send).not.toHaveBeenCalledWith('screenshot:delivery', expect.anything())
    c.finish('cancelled')
  })
})

describe('segmented capture delivery ownership', () => {
  it('requires real progress and notifies acceptance before the same Qt bool ACK', async () => {
    vi.useFakeTimers()
    const f = setup()
    const c = f.coordinator
    await startCapture(f)
    await output(c)
    expect(c.deliverySnapshot()).toMatchObject({ state: 'sent', timerActive: true, sent: true })
    expect(c.ack(f.sender, { ...identity(), accepted: true })).toBe(false)
    processing(c, f.sender)
    expect(c.ack(f.sender, { ...identity(), accepted: true })).toBe(true)
    expect(c.deliverySnapshot()).toMatchObject({
      state: 'accepted',
      reason: 'accepted',
      timerActive: false,
      observingReceiver: false,
      deadlineAt: null
    })
    expect(f.sender.send).toHaveBeenLastCalledWith('screenshot:delivery-state', {
      ...identity(),
      state: 'accepted',
      message: ''
    })
    expect(c.host.send).toHaveBeenLastCalledWith({
      type: 'ack',
      ...identity(),
      accepted: true,
      message: ''
    })
    expect(f.sender.send.mock.invocationCallOrder.at(-1)).toBeLessThan(
      c.host.send.mock.invocationCallOrder.at(-1)
    )
    expect(c.active).not.toBeNull()
    expect(c.active.delivery).toBeNull()
    expect(c.assets.release).not.toHaveBeenCalled()
    expect(c.ack(f.sender, { ...identity(), accepted: true })).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an unreceived delivery after the product sent deadline and permits a fresh delivery', async () => {
    vi.useFakeTimers()
    const f = setup()
    const c = f.coordinator
    await startCapture(f)
    await output(c)
    await vi.advanceTimersByTimeAsync(4999)
    expect(c.deliverySnapshot().state).toBe('sent')
    expect(c.progress(f.sender, { ...identity(), state: 'processing' })).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.deliverySnapshot()).toMatchObject({
      state: 'rejected',
      reason: 'sent-timeout',
      timerActive: false,
      observingReceiver: false
    })
    expect(c.host.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'ack', ...identity(), accepted: false })
    )
    expect(c.active).not.toBeNull()
    expect(c.assets.release).not.toHaveBeenCalled()
    await output(c, 'retry')
    processing(c, f.sender, 'retry')
    expect(c.ack(f.sender, { ...identity('retry'), accepted: true })).toBe(true)
  })

  it('starts the processing budget and receiver observation before image reading', async () => {
    vi.useFakeTimers()
    const f = setup({ deliveryTimeouts: { processing: 100 } })
    const c = f.coordinator
    const reading = deferred()
    c.assets.read.mockReturnValueOnce(reading.promise)
    await startCapture(f)
    const delivering = output(c)
    expect(c.deliverySnapshot()).toMatchObject({
      state: 'preparing',
      sent: false,
      timerActive: true,
      observingReceiver: true,
      processingRemainingMs: 100
    })
    await vi.advanceTimersByTimeAsync(100)
    await delivering
    expect(c.deliverySnapshot()).toMatchObject({ state: 'rejected', reason: 'processing-timeout' })
    reading.resolve({ dataUrl: 'late-image' })
    await Promise.resolve()
    expect(f.sender.send).not.toHaveBeenCalledWith('screenshot:delivery', expect.anything())
    expect(c.active.delivery).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps one cumulative work budget across main reading, progress and one long user confirmation', async () => {
    vi.useFakeTimers()
    const f = setup({ deliveryTimeouts: { sent: 5000, processing: 100 } })
    const c = f.coordinator
    const reading = deferred()
    c.assets.read.mockReturnValueOnce(reading.promise)
    await startCapture(f)
    const delivering = output(c)
    await vi.advanceTimersByTimeAsync(40)
    reading.resolve({ dataUrl: 'image' })
    await delivering
    await vi.advanceTimersByTimeAsync(20)
    processing(c, f.sender)
    const deadline = c.deliverySnapshot().deadlineAt
    await vi.advanceTimersByTimeAsync(20)
    expect(c.progress(f.sender, { ...identity(), state: 'received' })).toBe(false)
    expect(c.progress(f.sender, { ...identity(), state: 'processing' })).toBe(false)
    expect(c.deliverySnapshot().deadlineAt).toBe(deadline)
    expect(c.progress(f.sender, { ...identity(), state: 'awaiting-user' })).toBe(true)
    expect(c.deliverySnapshot()).toMatchObject({
      state: 'awaiting-user',
      timerActive: false,
      deadlineAt: null,
      remainingMs: null,
      processingRemainingMs: 40,
      awaitingUserUsed: true
    })
    await vi.advanceTimersByTimeAsync(100000)
    expect(c.deliverySnapshot().state).toBe('awaiting-user')
    expect(c.progress(f.sender, { ...identity(), state: 'awaiting-user' })).toBe(false)
    expect(c.progress(f.sender, { ...identity(), state: 'processing' })).toBe(true)
    expect(c.progress(f.sender, { ...identity(), state: 'awaiting-user' })).toBe(false)
    await vi.advanceTimersByTimeAsync(39)
    expect(c.deliverySnapshot().state).toBe('processing')
    await vi.advanceTimersByTimeAsync(1)
    expect(c.deliverySnapshot()).toMatchObject({ state: 'rejected', reason: 'processing-timeout' })
    expect(c.ack(f.sender, { ...identity(), accepted: true })).toBe(false)
  })

  it('does not let a foreign sender, frame, session or delivery refresh or complete the owner', async () => {
    vi.useFakeTimers()
    const f = setup()
    const c = f.coordinator
    await startCapture(f)
    await output(c)
    const deadline = c.deliverySnapshot().deadlineAt
    for (const [sender, data, frame] of [
      [{ mainFrame: f.frame }, identity(), f.frame],
      [f.sender, identity(), {}],
      [f.sender, { ...identity(), sessionId: 'old-session' }, f.frame],
      [f.sender, identity('old-delivery'), f.frame]
    ]) {
      expect(c.progress(sender, { ...data, state: 'received' }, frame)).toBe(false)
      expect(c.ack(sender, { ...data, accepted: false }, frame)).toBe(false)
    }
    expect(c.deliverySnapshot()).toMatchObject({ state: 'sent', deadlineAt: deadline })
    f.sender.mainFrame = { isDestroyed: () => false }
    expect(c.progress(f.sender, { ...identity(), state: 'received' }, f.frame)).toBe(false)
    expect(c.deliverySnapshot()).toMatchObject({ state: 'rejected', reason: 'document-invalid' })
  })

  it('invalidates a pending business opening before it can send and exposes the same guard to its callback', async () => {
    vi.useFakeTimers()
    const opening = deferred()
    const entered = deferred()
    let businessGuard
    const f = setup({
      onBusinessOpen: vi.fn(({ isCurrent }) => {
        businessGuard = isCurrent
        entered.resolve()
        return opening.promise
      })
    })
    const c = f.coordinator
    await startCapture(f, { sender: null, origin: 'global' })
    const delivering = output(c, 'asset', 'note')
    await entered.promise
    expect(c.onBusinessOpen).toHaveBeenCalledOnce()
    expect(businessGuard()).toBe(true)
    f.sender.emit('did-start-navigation', {}, 'app://next-document', false, true)
    expect(businessGuard()).toBe(false)
    await delivering
    opening.resolve()
    await Promise.resolve()
    expect(c.deliverySnapshot()).toMatchObject({ state: 'rejected', reason: 'document-invalid' })
    expect(f.sender.send).not.toHaveBeenCalledWith('screenshot:delivery', expect.anything())
    expect(c.active.delivery).toBeNull()
  })

  it('keeps old read failure and duplicate output from touching a successor delivery', async () => {
    vi.useFakeTimers()
    const f = setup({ deliveryTimeouts: { processing: 100 } })
    const c = f.coordinator
    const reading = deferred()
    c.assets.read.mockReturnValueOnce(reading.promise)
    await startCapture(f)
    const oldDelivery = output(c, 'old')
    await vi.advanceTimersByTimeAsync(100)
    await oldDelivery
    await output(c, 'new')
    reading.reject(new Error('old decoder failed late'))
    await Promise.resolve()
    await Promise.resolve()
    expect(c.active.delivery).toBe('new')
    expect(c.deliverySnapshot()).toMatchObject({ deliveryId: 'new', state: 'sent' })
    expect(c.ack(f.sender, { ...identity('old'), accepted: false })).toBe(false)
    processing(c, f.sender, 'new')
    c.ack(f.sender, { ...identity('new'), accepted: true })
    await output(c, 'old')
    await output(c, 'new')
    expect(c.assets.read).toHaveBeenCalledTimes(2)
    expect(c.deliverySnapshot()).toMatchObject({ deliveryId: 'new', state: 'accepted' })
  })

  it.each(['cancel', 'finish', 'dispose'])(
    'rejects a global receiver and clears an indefinite user wait on %s',
    async (ending) => {
      vi.useFakeTimers()
      const f = setup()
      const c = f.coordinator
      await startCapture(f, { sender: null, origin: 'global' })
      await output(c, 'asset', 'note')
      processing(c, f.sender)
      c.progress(f.sender, { ...identity(), state: 'awaiting-user' })
      if (ending === 'finish') c.finish('failed')
      else await c[ending]()
      expect(c.active).toBeNull()
      expect(c.deliverySnapshot()).toMatchObject({
        state: 'rejected',
        reason: ending === 'cancel' ? 'cancelled' : ending === 'dispose' ? 'disposed' : 'finished',
        timerActive: false,
        observingReceiver: false
      })
      expect(f.sender.send).toHaveBeenCalledWith(
        'screenshot:delivery-state',
        expect.objectContaining({ ...identity(), state: 'rejected' })
      )
      for (const event of [
        'did-start-navigation',
        'did-navigate',
        'render-process-gone',
        'destroyed'
      ])
        expect(f.sender.listenerCount(event)).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('clears the owner even when renderer terminal delivery and Qt negative ACK both throw', async () => {
    vi.useFakeTimers()
    const f = setup({ deliveryTimeouts: { sent: 100 } })
    const c = f.coordinator
    c.logger = { error: vi.fn() }
    await startCapture(f)
    await output(c)
    f.sender.send.mockImplementationOnce(() => {
      throw new Error('renderer send failed')
    })
    c.host.send.mockImplementationOnce(() => {
      throw new Error('Qt socket unavailable')
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(c.deliverySnapshot()).toMatchObject({
      state: 'rejected',
      timerActive: false,
      observingReceiver: false
    })
    expect(c.active.delivery).toBeNull()
    expect(c.logger.error).toHaveBeenCalledWith('capture.delivery-state', expect.any(Error))
    expect(c.logger.error).toHaveBeenCalledWith('capture.delivery-ack', expect.any(Error))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('routes initial delivery send failure through the same rejected terminal', async () => {
    vi.useFakeTimers()
    const f = setup()
    const c = f.coordinator
    await startCapture(f)
    f.sender.send.mockImplementationOnce(() => {
      throw new Error('delivery send failed')
    })
    await output(c)
    expect(c.deliverySnapshot()).toMatchObject({ state: 'rejected', reason: 'send-failed' })
    expect(c.host.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'ack',
        ...identity(),
        accepted: false,
        message: 'delivery send failed'
      })
    )
    expect(c.active.delivery).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
