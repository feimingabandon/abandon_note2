import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogWriterClient } from '../src/main/logging/log-writer-client.js'
import { DIAGNOSTIC_LIMITS } from '../src/shared/diagnostic-policy.js'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const workers = []
  const createWorker = () => {
    const worker = new EventEmitter()
    worker.ref = () => {}
    worker.unref = () => {}
    worker.terminate = async () => {}
    worker.postMessage = vi.fn()
    workers.push(worker)
    return worker
  }
  const client = createLogWriterClient({ directory: 'unused', workerFile: 'unused', createWorker })
  return { client, workers }
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
    await closing
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
  it('restarts only once per minute and retries one unacknowledged batch with the original event IDs', async () => {
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
    const closing = client.close(0)
    await vi.advanceTimersByTimeAsync(1)
    await closing
  })
})
