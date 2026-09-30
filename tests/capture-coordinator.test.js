import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { CaptureCoordinator } from '../src/main/capture/CaptureCoordinator.js'

function setup() {
  const sender = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })
  const coordinator = new CaptureCoordinator({
    onCaptureStart: vi.fn(),
    onCaptureEnd: vi.fn(),
    getMainWindow: () => ({ webContents: sender })
  })
  coordinator.host = { start: vi.fn(async () => {}), send: vi.fn(), dispose: vi.fn() }
  coordinator.assets = {
    create: vi.fn(async () => 'session-1'),
    read: vi.fn(async () => ({ dataUrl: 'png' })),
    release: vi.fn(async () => {}),
    dispose: vi.fn()
  }
  return { coordinator, sender }
}
describe('capture single session and acknowledgements', () => {
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
