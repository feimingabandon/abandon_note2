import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogWriterClient } from '../src/main/logging/log-writer-client.js'
import { DIAGNOSTIC_LIMITS } from '../src/shared/diagnostic-policy.js'

afterEach(() => vi.useRealTimers())
function fixture({ failStarts = [], terminate = async () => 0 } = {}) {
  vi.useFakeTimers()
  const workers = []
  let attempts = 0
  const createWorker = () => {
    if (failStarts.includes(++attempts)) throw new Error('worker startup failed')
    const worker = new EventEmitter()
    const index = workers.length
    worker.ref = () => {}
    worker.unref = () => {}
    worker.terminate = vi.fn(() => terminate(index))
    worker.postMessage = vi.fn()
    workers.push(worker)
    return worker
  }
  const client = createLogWriterClient({ directory: 'unused', workerFile: 'unused', createWorker })
  return { client, workers, attempts: () => attempts }
}
describe('log writer backpressure and failures', () => {
  it('includes queued and in-flight payloads in a hard bound while reserving space for errors', async () => {
    const { client, workers } = fixture()
    workers[0].emit('message', { ready: true })
    for (let i = 0; i < 2000; i++) client.enqueue({ message: 'x'.repeat(2000), id: i }, 0)
    expect(client.snapshot().queuedBytes).toBeLessThanOrEqual(
      DIAGNOSTIC_LIMITS.writerBytes - DIAGNOSTIC_LIMITS.reservedBytes
    )
    expect(client.enqueue({ level: 'error', message: 'important' }, 3)).toBe(true)
    expect(client.snapshot().queuedBytes).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.writerBytes)
    const closing = client.close(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(await closing).toMatchObject({
      outcome: 'timed-out',
      incomplete: true,
      flush: { incomplete: true, reason: 'flush-timeout' },
      termination: { requested: true, outcome: 'completed', confirmed: true }
    })
  })
  it('waits for startup readiness even with no queued events and times out a stuck writer', async () => {
    const { client, workers } = fixture()
    const flushed = client.flush(50)
    await vi.advanceTimersByTimeAsync(51)
    expect(await flushed).toMatchObject({ incomplete: true, reason: 'flush-timeout' })
    workers[0].emit('message', { ready: true })
    expect((await client.flush()).status).toBe('ready')
    await client.close()
  })
  it('keeps recovering once per minute and retries one unacknowledged batch with the original event IDs', async () => {
    const { client, workers } = fixture()
    workers[0].emit('message', { ready: true })
    client.enqueue({ id: 'stable-id', message: 'saved' }, 3)
    workers[0].emit('error', new Error('worker crash'))
    await vi.advanceTimersByTimeAsync(1100)
    expect(workers).toHaveLength(2)
    workers[1].emit('message', { ready: true })
    const sent = workers[1].postMessage.mock.calls[0][0]
    expect(sent.payload[0].id).toBe('stable-id')
    workers[1].emit('message', { id: sent.id, result: { records: 1, bytes: 100 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.snapshot().queuedBytes).toBe(0)
    workers[1].emit('error', new Error('second crash'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(workers).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(57899)
    expect(workers).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(workers).toHaveLength(3)
    workers[2].emit('message', { ready: true })
    workers[2].emit('error', new Error('third crash'))
    await vi.advanceTimersByTimeAsync(59999)
    expect(workers).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(workers).toHaveLength(4)
    workers[3].emit('message', { ready: true })
    expect(client.snapshot()).toMatchObject({ status: 'ready', workerRestarts: 3 })
    await client.close()
  })
  it('schedules one recovery after an error plus exit and cancels pending recovery on close', async () => {
    const { client, workers } = fixture()
    workers[0].emit('message', { ready: true })
    workers[0].emit('error', new Error('worker crash'))
    workers[0].emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(workers).toHaveLength(2)
    workers[1].emit('message', { ready: true })
    workers[1].emit('error', new Error('second crash'))
    const closing = client.close(0)
    await vi.advanceTimersByTimeAsync(1)
    await closing
    await vi.advanceTimersByTimeAsync(60000)
    expect(workers).toHaveLength(2)
    expect(client.snapshot().status).toBe('closed')
  })
  it('keeps a future recovery scheduled when the restart constructor also fails', async () => {
    const { client, workers, attempts } = fixture({ failStarts: [1, 2] })
    expect(attempts()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(59999)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts()).toBe(3)
    workers[0].emit('message', { ready: true })
    expect(client.snapshot()).toMatchObject({ status: 'ready', workerRestarts: 2 })
    await client.close()
  })
})

describe('log writer close ownership', () => {
  it('shares one close promise, seals enqueue immediately and returns the same final result', async () => {
    const { client, workers } = fixture()
    workers[0].emit('message', { ready: true })
    const first = client.close(50)
    const second = client.close(0, { terminateTimeoutMs: 0 })
    expect(first).toBe(second)
    expect(client.enqueue({ message: 'after close' }, 3)).toBe(false)
    const result = await first
    expect(result).toMatchObject({
      outcome: 'completed',
      incomplete: false,
      flush: { status: 'ready', pendingRecords: 0 },
      termination: { requested: true, outcome: 'completed', confirmed: true, exitCode: 0 }
    })
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
    expect(client.close()).toBe(first)
    expect(await second).toBe(result)
    expect(client.snapshot().status).toBe('closed')
  })

  it('preserves a failed append result instead of reporting a complete flush', async () => {
    const { client, workers } = fixture()
    workers[0].emit('message', { ready: true })
    client.enqueue({ message: 'not saved' }, 3)
    const request = workers[0].postMessage.mock.calls[0][0]
    const closing = client.close(50)
    workers[0].emit('message', {
      id: request.id,
      error: { code: 'EIO', message: 'write failed' }
    })
    expect(await closing).toMatchObject({
      outcome: 'degraded',
      incomplete: true,
      flush: { status: 'degraded', droppedRecords: 1, writeErrors: 1 },
      termination: { outcome: 'completed', confirmed: true },
      droppedRecords: 1,
      writeErrors: 1
    })
    expect(client.snapshot().status).toBe('closed')
  })

  it('retains unacknowledged records after the flush budget expires without inventing write errors', async () => {
    const { client, workers } = fixture()
    workers[0].emit('message', { ready: true })
    client.enqueue({ id: 'unconfirmed', message: 'pending' }, 3)
    const queuedBytes = client.snapshot().queuedBytes
    const closing = client.close(25)
    await vi.advanceTimersByTimeAsync(25)
    expect(await closing).toMatchObject({
      outcome: 'timed-out',
      incomplete: true,
      flush: { incomplete: true, reason: 'flush-timeout', queuedBytes, pendingRecords: 1 },
      termination: { outcome: 'completed', confirmed: true },
      queuedBytes,
      pendingRecords: 1,
      droppedRecords: 0,
      writeErrors: 0
    })
    workers[0].emit('message', { ready: true })
    workers[0].emit('error', new Error('late worker event'))
    await vi.advanceTimersByTimeAsync(60000)
    expect(client.snapshot()).toMatchObject({
      status: 'closed',
      queuedBytes,
      pendingRecords: 1,
      droppedRecords: 0,
      writeErrors: 0
    })
    expect(workers).toHaveLength(1)
  })

  it('reports termination rejection as unconfirmed and keeps a stable close result', async () => {
    const failure = Object.assign(new Error('terminate failed'), { code: 'TERMINATE_FAILED' })
    const { client, workers } = fixture({ terminate: () => Promise.reject(failure) })
    workers[0].emit('message', { ready: true })
    const closing = client.close()
    expect(await closing).toMatchObject({
      outcome: 'failed',
      incomplete: true,
      termination: {
        requested: true,
        outcome: 'failed',
        confirmed: false,
        error: { code: 'TERMINATE_FAILED', message: 'terminate failed' }
      }
    })
    expect(client.snapshot().status).toBe('closed-incomplete')
    expect(client.close()).toBe(closing)
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  })

  it('bounds a pending termination to the default extra 1000ms budget', async () => {
    let resolveTermination
    const { client, workers } = fixture({
      terminate: () => new Promise((resolve) => (resolveTermination = resolve))
    })
    workers[0].emit('message', { ready: true })
    let settled = false
    const closing = client.close()
    void closing.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await closing
    expect(result).toMatchObject({
      outcome: 'timed-out',
      incomplete: true,
      termination: { requested: true, outcome: 'timed-out', confirmed: false }
    })
    expect(client.snapshot().status).toBe('closed-incomplete')
    resolveTermination(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(await client.close()).toBe(result)
    expect(result.termination.confirmed).toBe(false)
    expect(client.snapshot().status).toBe('closed-incomplete')
  })

  it('waits for old and current pending terminations together within one shared budget', async () => {
    const { client, workers } = fixture({ terminate: () => new Promise(() => {}) })
    workers[0].emit('message', { ready: true })
    workers[0].emit('error', new Error('old worker failed'))
    await vi.advanceTimersByTimeAsync(1000)
    workers[1].emit('message', { ready: true })
    let settled = false
    const closing = client.close(50, { terminateTimeoutMs: 100 })
    void closing.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
    expect(workers[1].terminate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(99)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await closing).toMatchObject({
      outcome: 'timed-out',
      termination: { outcome: 'timed-out', confirmed: false }
    })
    expect(client.snapshot().status).toBe('closed-incomplete')
    await vi.advanceTimersByTimeAsync(60000)
    expect(workers).toHaveLength(2)
  })

  it('retains an old termination failure after its worker field has been replaced', async () => {
    const { client, workers } = fixture({
      terminate: (index) =>
        index === 0 ? Promise.reject(new Error('old termination failed')) : Promise.resolve(0)
    })
    workers[0].emit('message', { ready: true })
    workers[0].emit('error', new Error('old worker failed'))
    await vi.advanceTimersByTimeAsync(1000)
    workers[1].emit('message', { ready: true })
    expect(await client.close()).toMatchObject({
      outcome: 'failed',
      termination: {
        requested: true,
        outcome: 'failed',
        confirmed: false,
        error: { message: 'old termination failed' }
      }
    })
    expect(client.snapshot().status).toBe('closed-incomplete')
  })

  it('waits for an old pending owner even when the current worker has already terminated', async () => {
    let resolveOldTermination
    const { client, workers } = fixture({
      terminate: (index) =>
        index === 0
          ? new Promise((resolve) => (resolveOldTermination = resolve))
          : Promise.resolve(0)
    })
    workers[0].emit('message', { ready: true })
    workers[0].emit('error', new Error('old worker failed'))
    await vi.advanceTimersByTimeAsync(1000)
    workers[1].emit('message', { ready: true })
    let settled = false
    const closing = client.close(50, { terminateTimeoutMs: 100 })
    void closing.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    expect(workers[1].terminate).toHaveBeenCalledTimes(1)
    resolveOldTermination(1)
    expect(await closing).toMatchObject({
      outcome: 'completed',
      incomplete: false,
      termination: { requested: true, outcome: 'completed', confirmed: true }
    })
    expect(client.snapshot().status).toBe('closed')
  })

  it('distinguishes a worker that was never created from an unconfirmed termination', async () => {
    const { client, workers, attempts } = fixture({ failStarts: [1] })
    const closing = client.close(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(await closing).toMatchObject({
      outcome: 'timed-out',
      incomplete: true,
      flush: { incomplete: true, reason: 'flush-timeout' },
      termination: { requested: false, outcome: 'not-created', confirmed: true }
    })
    expect(client.snapshot().status).toBe('closed')
    await vi.advanceTimersByTimeAsync(60000)
    expect(attempts()).toBe(1)
    expect(workers).toHaveLength(0)
  })
})
