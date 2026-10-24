import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('node:net', () => ({ default: { createConnection: transport.connect } }))
import { CaptureHost } from '../src/main/capture/CaptureHost.js'

class TestSocket extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
    this.setEncoding = vi.fn()
    this.write = vi.fn()
    this.destroy = vi.fn(() => {
      this.destroyed = true
    })
  }
  connect() {
    this.emit('connect')
  }
  data(text) {
    this.emit('data', text)
  }
}

const fixtures = []
function setup() {
  const sockets = []
  transport.connect.mockImplementation(() => {
    const socket = new TestSocket()
    sockets.push(socket)
    return socket
  })
  const host = new CaptureHost({ directory: 'capture', root: 'owned-root' })
  const jobs = []
  const checked = (job) => {
    expect(job).toBeTruthy()
    expect(job.closed).toBe(false)
    return job
  }
  const native = {
    launch: vi.fn(() => {
      const job = { id: jobs.length + 1, closed: false, running: true }
      jobs.push(job)
      return job
    }),
    running: vi.fn((job) => checked(job).running),
    pid: vi.fn((job) => 100 + checked(job).id),
    allowForeground: vi.fn((job) => checked(job)),
    close: vi.fn((job) => {
      checked(job).closed = true
    })
  }
  host.native = native
  const failures = []
  host.on('failure', (error) => failures.push(error))
  const fixture = { host, native, sockets, jobs, failures }
  fixtures.push(fixture)
  return fixture
}
const readyLine = JSON.stringify({ type: 'ready', version: 1 }) + '\n'
async function ready(fixture) {
  const started = fixture.host.start()
  const socket = fixture.sockets.at(-1)
  socket.connect()
  socket.data(readyLine)
  await started
  return socket
}

beforeEach(() => {
  vi.useFakeTimers()
  transport.connect.mockReset()
})
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const job of fixture.jobs) job.running = false
    await fixture.host.dispose()
  }
  vi.useRealTimers()
})

describe('CaptureHost startup ownership', () => {
  it('returns the same complete in-flight promise and launches one helper', async () => {
    const f = setup()
    const first = f.host.start()
    expect(f.host.start()).toBe(first)
    expect(f.host.start()).toBe(first)
    expect(f.native.launch).toHaveBeenCalledTimes(1)
    expect(f.host.ready).toBe(false)
    f.sockets[0].connect()
    const hello = JSON.parse(f.sockets[0].write.mock.calls[0][0])
    expect(hello).toMatchObject({ type: 'hello', version: 1 })
    expect(hello.token).toMatch(/^[a-f0-9]{64}$/)
    f.sockets[0].data(readyLine)
    await first
    expect(f.host.ready).toBe(true)
    expect(f.host.starting).toBe(null)
    expect(f.host.pid).toBe(101)
    expect(vi.getTimerCount()).toBe(0)
    await f.host.start()
    expect(f.native.launch).toHaveBeenCalledTimes(1)
  })

  it('settles a never-connecting socket at the original total deadline', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(9999)
    expect(f.sockets[0].destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(f.sockets[0].destroyed).toBe(true)
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(f.host.job).toBe(null)
    expect(f.host.socket).toBe(null)
    expect(f.host.starting).toBe(null)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['error', 'close'])(
    'retries a candidate %s without hanging or renewing the deadline',
    async (event) => {
      const f = setup()
      const started = f.host.start()
      const rejected = expect(started).rejects.toThrow('超时')
      await vi.advanceTimersByTimeAsync(9000)
      f.sockets[0].emit(event, new Error('candidate disconnected'))
      expect(f.sockets[0].destroyed).toBe(true)
      await vi.advanceTimersByTimeAsync(79)
      expect(f.sockets).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(f.sockets).toHaveLength(2)
      f.sockets[1].connect()
      await vi.advanceTimersByTimeAsync(920)
      await rejected
      expect(f.sockets[1].destroyed).toBe(true)
      expect(f.native.close).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('can connect and finish after a retry while ignoring the old candidate callbacks', async () => {
    const f = setup()
    const started = f.host.start()
    const old = f.sockets[0]
    const callbacks = {
      connect: old.listeners('connect')[0],
      error: old.listeners('error')[0],
      close: old.listeners('close')[0],
      data: old.listeners('data')[0]
    }
    old.emit('error', new Error('pipe not listening yet'))
    await vi.advanceTimersByTimeAsync(80)
    const current = f.sockets[1]
    current.connect()
    callbacks.connect()
    callbacks.data(readyLine)
    callbacks.error(new Error('late old error'))
    callbacks.close()
    expect(f.host.ready).toBe(false)
    expect(f.host.socket).toBe(current)
    current.data(readyLine)
    await started
    expect(f.host.ready).toBe(true)
    expect(f.failures).toHaveLength(0)
    expect(f.native.close).not.toHaveBeenCalled()
  })

  it('immediately cancels a pending candidate on dispose and never revives on late connect', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('正在退出')
    const socket = f.sockets[0]
    const lateConnect = socket.listeners('connect')[0]
    const lateData = socket.listeners('data')[0]
    await f.host.dispose()
    await rejected
    lateConnect()
    lateData(readyLine)
    expect(f.host.ready).toBe(false)
    expect(socket.destroyed).toBe(true)
    expect(socket.write).not.toHaveBeenCalled()
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(f.failures).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    await expect(f.host.start()).rejects.toThrow('正在退出')
  })

  it('cancels the retry delay rather than starting another candidate after dispose', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('正在退出')
    f.sockets[0].emit('close')
    await f.host.dispose()
    await rejected
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.sockets).toHaveLength(1)
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('immediately cancels a connected handshake on dispose', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('正在退出')
    f.sockets[0].connect()
    await f.host.dispose()
    await rejected
    expect(f.sockets[0].write).toHaveBeenCalledTimes(1)
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(f.failures).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['error', 'close'])(
    'rejects a disconnected handshake on %s with one failure',
    async (event) => {
      const f = setup()
      const started = f.host.start()
      const rejected = expect(started).rejects.toThrow(
        event === 'error' ? 'handshake lost' : '已退出'
      )
      const socket = f.sockets[0]
      socket.connect()
      const oldClose = socket.listeners('close')[0]
      const oldError = socket.listeners('error')[0]
      socket.emit(event, new Error('handshake lost'))
      oldClose()
      oldError(new Error('late error'))
      await rejected
      expect(f.failures).toHaveLength(1)
      expect(f.native.close).toHaveBeenCalledTimes(1)
      expect(f.host.ready).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('detects helper death while a candidate never emits any connection event', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('异常退出')
    f.jobs[0].running = false
    await vi.advanceTimersByTimeAsync(30)
    await rejected
    expect(f.sockets[0].destroyed).toBe(true)
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a launched job if PID lookup fails', async () => {
    const f = setup()
    f.native.pid.mockImplementation(() => {
      throw new Error('pid lookup failed')
    })
    await expect(f.host.start()).rejects.toThrow('pid lookup failed')
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(f.sockets).toHaveLength(0)
    expect(f.host.job).toBe(null)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects launch failure without opening a socket or retaining timers', async () => {
    const f = setup()
    f.native.launch.mockImplementation((_exe, _name, _token, _root, error) => {
      error[0] = 5
      return null
    })
    await expect(f.host.start()).rejects.toThrow('(5)')
    expect(f.native.close).not.toHaveBeenCalled()
    expect(f.sockets).toHaveLength(0)
    expect(f.host.job).toBe(null)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('CaptureHost ready generation and shutdown', () => {
  it('does not accept ready after invalid protocol in the same chunk', async () => {
    const f = setup()
    const messages = []
    f.host.on('message', (message) => messages.push(message))
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('消息无效')
    f.sockets[0].connect()
    f.sockets[0].data('invalid-json\n' + readyLine)
    await rejected
    expect(f.host.ready).toBe(false)
    expect(messages).toHaveLength(0)
    expect(f.failures).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects ready followed by invalid protocol in the same chunk', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('消息无效')
    f.sockets[0].connect()
    f.sockets[0].data(readyLine + 'invalid-json\n')
    await rejected
    expect(f.host.ready).toBe(false)
    expect(f.failures).toHaveLength(1)
  })

  it('rejects same-turn ready followed by an error before start can report success', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('same-turn error')
    f.sockets[0].connect()
    f.sockets[0].data(readyLine)
    f.sockets[0].emit('error', new Error('same-turn error'))
    await rejected
    expect(f.host.ready).toBe(false)
    expect(f.failures).toHaveLength(1)
  })

  it('rejects queued ready when the connected helper died before the next startup probe', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('异常退出')
    const socket = f.sockets[0]
    socket.connect()
    f.jobs[0].running = false
    socket.data(readyLine)
    await rejected
    expect(f.host.ready).toBe(false)
    expect(f.host.job).toBe(null)
    expect(socket.destroyed).toBe(true)
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(f.failures).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not let old finally or callbacks clear or ready a replacement startup', async () => {
    const f = setup()
    const oldStarted = f.host.start()
    const rejected = expect(oldStarted).rejects.toThrow('first failed')
    const oldSocket = f.sockets[0]
    oldSocket.connect()
    const lateData = oldSocket.listeners('data')[0]
    const lateError = oldSocket.listeners('error')[0]
    oldSocket.emit('error', new Error('first failed'))
    const nextStarted = f.host.start()
    expect(nextStarted).not.toBe(oldStarted)
    const nextSocket = f.sockets[1]
    nextSocket.connect()
    lateData(readyLine)
    lateError(new Error('old failure'))
    await rejected
    expect(f.host.start()).toBe(nextStarted)
    expect(f.host.ready).toBe(false)
    expect(f.host.socket).toBe(nextSocket)
    expect(f.jobs[1].closed).toBe(false)
    nextSocket.data(readyLine)
    await nextStarted
    expect(f.host.ready).toBe(true)
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(f.failures).toHaveLength(1)
  })

  it('holds the original deadline across the connection and a wrong-version ready', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(9990)
    f.sockets[0].connect()
    f.sockets[0].data(JSON.stringify({ type: 'ready', version: 2 }) + '\n')
    await vi.advanceTimersByTimeAsync(10)
    await rejected
    expect(f.host.ready).toBe(false)
    expect(f.native.close).toHaveBeenCalledTimes(1)
  })

  it('rejects a ready frame received after the total deadline even before its timer runs', async () => {
    const f = setup()
    const started = f.host.start()
    const rejected = expect(started).rejects.toThrow('超时')
    f.sockets[0].connect()
    vi.setSystemTime(Date.now() + 10000)
    f.sockets[0].data(readyLine)
    await rejected
    expect(f.host.ready).toBe(false)
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reuses a replacement started by a synchronous stale-connection failure listener', async () => {
    const f = setup()
    const oldSocket = await ready(f)
    oldSocket.destroyed = true
    let replacement
    f.host.once('failure', () => {
      replacement = f.host.start()
    })
    const started = f.host.start()
    expect(started).toBe(replacement)
    expect(f.native.launch).toHaveBeenCalledTimes(2)
    expect(f.jobs[0].closed).toBe(true)
    expect(f.jobs[1].closed).toBe(false)
    const nextSocket = f.sockets[1]
    nextSocket.connect()
    nextSocket.data(readyLine)
    await started
    expect(f.host.ready).toBe(true)
    expect(f.host.socket).toBe(nextSocket)
  })

  it('accepts fragmented frames but enforces the original 64KiB message boundary', async () => {
    const f = setup()
    const socket = await ready(f)
    const messages = []
    f.host.on('message', (message) => messages.push(message))
    socket.data('{"type":"capture')
    socket.data('Ready","sessionId":"owned"}\n')
    expect(messages).toEqual([{ type: 'captureReady', sessionId: 'owned' }])
    socket.data('x'.repeat(65537))
    expect(f.host.ready).toBe(false)
    expect(f.failures[0].message).toContain('消息超限')
    expect(f.native.close).toHaveBeenCalledTimes(1)
  })

  it('preserves send and foreground ownership and rejects sends after teardown', async () => {
    const f = setup()
    const socket = await ready(f)
    f.host.send({ type: 'capture', sessionId: 'owned' })
    expect(f.native.allowForeground).toHaveBeenCalledWith(f.jobs[0])
    expect(JSON.parse(socket.write.mock.calls.at(-1)[0])).toEqual({
      type: 'capture',
      sessionId: 'owned'
    })
    expect(() => f.host.send({ type: 'theme', body: 'x'.repeat(65536) })).toThrow('消息超限')
    socket.emit('close')
    expect(() => f.host.send({ type: 'capture' })).toThrow('连接不可用')
    expect(f.native.allowForeground).toHaveBeenCalledTimes(1)
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(f.failures).toHaveLength(1)
  })

  it('sends shutdown and retains the established two-second graceful-exit budget', async () => {
    const f = setup()
    const socket = await ready(f)
    const disposed = f.host.dispose()
    expect(f.host.dispose()).toBe(disposed)
    expect(JSON.parse(socket.write.mock.calls.at(-1)[0])).toEqual({ type: 'shutdown' })
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.native.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await disposed
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(f.host.ready).toBe(false)
    expect(f.failures).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not poll or close a handle again after socket loss during graceful shutdown', async () => {
    const f = setup()
    const socket = await ready(f)
    const disposed = f.host.dispose()
    socket.emit('close')
    await vi.advanceTimersByTimeAsync(30)
    await disposed
    expect(f.native.close).toHaveBeenCalledTimes(1)
    expect(f.failures).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
