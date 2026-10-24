import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWallpaperRetirement } from '../src/main/settings/wallpaper-retirement.js'

const owners = []
function fixture() {
  const source = { token: 'wallpaper-document', scope: 'main' }
  let current = true
  const frame = { isDestroyed: () => false }
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn()
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false)
  })
  const owner = createWallpaperRetirement({
    getMainWindow: () => window,
    isSourceCurrent: (candidate) =>
      current && candidate.token === source.token && candidate.scope === source.scope
  })
  owners.push(owner)
  return {
    owner,
    source,
    frame,
    contents,
    window,
    event: { sender: contents, senderFrame: frame },
    expire: () => {
      current = false
    }
  }
}
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.stop())
  vi.useRealTimers()
})
describe('wallpaper visual retirement ownership', () => {
  it('shares one pending ticket and consumes only its matching document ACK once', async () => {
    const f = fixture()
    const first = f.owner.begin(f.source)
    const second = f.owner.begin({ ...f.source })
    expect(second).toBe(first)
    expect(second.finished).toBe(first.finished)
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith('wallpapers:retirement-request', {
      id: first.id,
      source: f.source
    })
    expect(f.owner.acknowledge(f.event, { id: first.id, outcome: 'left' }, f.source)).toEqual({
      accepted: true
    })
    await expect(first.finished).resolves.toEqual({
      id: first.id,
      status: 'completed',
      outcome: 'left'
    })
    expect(f.owner.acknowledge(f.event, { id: first.id, outcome: 'left' }, f.source)).toEqual({
      accepted: false
    })
    expect(f.owner.snapshot()).toEqual({ stopped: false, pending: null, timers: 0, listeners: 0 })
    expect(f.window.eventNames()).toEqual([])
    expect(f.contents.eventNames()).toEqual([])
  })

  it('does not consume the current ticket for a foreign sender/frame/source/id/outcome', async () => {
    const f = fixture()
    const ticket = f.owner.begin(f.source)
    for (const [event, payload, source] of [
      [{ ...f.event, sender: {} }, { id: ticket.id, outcome: 'left' }, f.source],
      [{ ...f.event, senderFrame: {} }, { id: ticket.id, outcome: 'left' }, f.source],
      [f.event, { id: ticket.id, outcome: 'left' }, { ...f.source, token: 'old' }],
      [f.event, { id: ticket.id, outcome: 'left' }, { ...f.source, scope: 'week' }],
      [f.event, { id: 'old-ticket', outcome: 'left' }, f.source],
      [f.event, { id: ticket.id, outcome: 'requested-false' }, f.source]
    ])
      expect(f.owner.acknowledge(event, payload, source)).toEqual({ accepted: false })
    expect(f.owner.snapshot().pending.id).toBe(ticket.id)
    f.owner.acknowledge(f.event, { id: ticket.id, outcome: 'absent' }, f.source)
    await expect(ticket.finished).resolves.toMatchObject({ status: 'completed', outcome: 'absent' })
  })

  it.each([
    ['window', 'hide', 'hidden'],
    ['window', 'minimize', 'minimized'],
    ['window', 'closed', 'window-closed'],
    ['contents', 'did-navigate', 'document-replaced'],
    ['contents', 'render-process-gone', 'renderer-gone'],
    ['contents', 'destroyed', 'renderer-destroyed']
  ])('settles and releases all resources on %s %s', async (target, event, reason) => {
    vi.useFakeTimers()
    const f = fixture()
    const ticket = f.owner.begin(f.source)
    f[target].emit(event)
    await expect(ticket.finished).resolves.toEqual({ id: ticket.id, status: 'cancelled', reason })
    expect(f.owner.snapshot()).toMatchObject({ pending: null, timers: 0, listeners: 0 })
    expect(vi.getTimerCount()).toBe(0)
    expect(f.contents.send).toHaveBeenLastCalledWith('wallpapers:retirement-cancel', {
      id: ticket.id,
      source: f.source,
      reason
    })
  })

  it('ignores subframe/in-place navigation and cancels actual main-document navigation', async () => {
    const f = fixture()
    const ticket = f.owner.begin(f.source)
    f.contents.emit('did-start-navigation', {}, 'https://example.test', false, false)
    f.contents.emit('did-start-navigation', {}, 'https://example.test/#a', true, true)
    expect(f.owner.snapshot().pending.id).toBe(ticket.id)
    f.contents.emit('did-start-navigation', {}, 'https://example.test/new', false, true)
    await expect(ticket.finished).resolves.toMatchObject({
      status: 'cancelled',
      reason: 'navigation'
    })
    // A prevented navigation can retain the same source for a fresh request.
    expect(f.owner.begin(f.source).id).not.toBe(ticket.id)
  })

  it('uses one finite deadline without extending it when another blur shares the wait', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const ticket = f.owner.begin(f.source)
    await vi.advanceTimersByTimeAsync(4000)
    expect(f.owner.begin(f.source)).toBe(ticket)
    await vi.advanceTimersByTimeAsync(999)
    expect(f.owner.snapshot().pending.id).toBe(ticket.id)
    await vi.advanceTimersByTimeAsync(1)
    await expect(ticket.finished).resolves.toEqual({
      id: ticket.id,
      status: 'failed',
      reason: 'timeout'
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not send or leave resources when begin is hidden or its send throws', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.window.isVisible.mockReturnValueOnce(false)
    expect(() => f.owner.begin(f.source)).toThrow('窗口不可见')
    expect(f.contents.send).not.toHaveBeenCalled()
    f.contents.send.mockImplementationOnce(() => {
      throw new Error('send unavailable')
    })
    expect(() => f.owner.begin(f.source)).toThrow('send unavailable')
    expect(f.owner.snapshot()).toMatchObject({ pending: null, timers: 0, listeners: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects expired sources and replacement main frames without consuming a valid successor', async () => {
    const f = fixture()
    const ticket = f.owner.begin(f.source)
    f.contents.mainFrame = { isDestroyed: () => false }
    expect(f.owner.acknowledge(f.event, { id: ticket.id, outcome: 'left' }, f.source)).toEqual({
      accepted: false
    })
    f.contents.emit('did-navigate')
    await ticket.finished
    f.expire()
    expect(() => f.owner.begin(f.source)).toThrow('页面已失效')
    expect(f.owner.snapshot().pending).toBeNull()
  })

  it('keeps cancellation reversible, ignores stale handles, and permanently stops only on stop', async () => {
    const f = fixture()
    const first = f.owner.begin(f.source)
    f.owner.cancelSource({ ...f.source, token: 'other' }, 'wrong-source')
    expect(f.owner.snapshot().pending.id).toBe(first.id)
    f.owner.cancelAll('quit-confirmation')
    await first.finished
    const second = f.owner.begin(f.source)
    first.cancel('late-cancel')
    expect(f.owner.snapshot().pending.id).toBe(second.id)
    f.owner.stop('shutdown')
    await expect(second.finished).resolves.toMatchObject({
      status: 'cancelled',
      reason: 'shutdown'
    })
    expect(() => f.owner.begin(f.source)).toThrow('页面已失效')
    expect(f.owner.snapshot()).toMatchObject({
      stopped: true,
      pending: null,
      timers: 0,
      listeners: 0
    })
  })
})
