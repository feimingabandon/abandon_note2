import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiagnosticTransport } from '../src/preload/diagnostic-transport.js'
import { dailyDiagnosticPolicy } from '../src/shared/diagnostic-policy.js'

const transports = []
afterEach(() => {
  transports.splice(0).forEach((t) => t.dispose())
  vi.useRealTimers()
})
function fixture(ack = true, options = {}) {
  vi.useFakeTimers()
  const listeners = new Map()
  const packets = []
  const raw = {
    on: (key, callback) => listeners.set(key, callback),
    removeListener: (key) => listeners.delete(key),
    send: (channel, payload) => {
      packets.push({ channel, payload })
      if (ack && channel === 'logs:batch')
        queueMicrotask(() =>
          listeners.get('logs:ack')?.({}, { batchId: payload.batchId, accepted: true })
        )
    }
  }
  const transport = createDiagnosticTransport(raw, {
    autoConnect: false,
    clock: Date.now,
    ...options
  })
  transport.applyPolicy({ ...dailyDiagnosticPolicy(), transportBytes: 32768 })
  transports.push(transport)
  return { transport, packets, emit: (channel, payload) => listeners.get(channel)({}, payload) }
}
describe('bounded preload transport', () => {
  it('bounds close waiting and reports an unconfirmed final batch', async () => {
    const f = fixture(false)
    f.transport.report({ level: 'error', message: 'pending' })
    const closing = f.transport.prepareForUnload('close', 800)
    await vi.advanceTimersByTimeAsync(801)
    expect(await closing).toMatchObject({ incomplete: true, reason: 'transport-timeout' })
    expect(f.packets.at(-1)).toMatchObject({
      channel: 'logs:ending',
      payload: { incomplete: true, producerSeq: 1 }
    })
  })
  it('submits pagehide summaries and disposes timers and listeners', async () => {
    const target = new EventTarget()
    const f = fixture(false, { eventTarget: target })
    f.transport.onFlush(() => f.transport.report({ scope: 'performance.renderer' }))
    target.dispatchEvent(new Event('pagehide'))
    expect(f.packets.some((packet) => packet.channel === 'logs:batch')).toBe(true)
    expect(f.packets.at(-1)).toMatchObject({
      channel: 'logs:ending',
      payload: { reason: 'pagehide', producerSeq: 1 }
    })
    expect(f.transport.report({ message: 'after-unload' })).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('gates noise, batches frequent events and includes unacknowledged bytes in quota', async () => {
    const f = fixture(false)
    expect(f.transport.report({ level: 'debug', message: 'not-collected' })).toBe(false)
    for (let i = 0; i < 1000; i++)
      f.transport.report({ scope: 'diagnostic.test', message: 'x'.repeat(300) })
    expect(f.packets.filter((p) => p.channel === 'logs:batch')).toHaveLength(1)
    expect(f.transport.health().queuedBytes).toBeLessThanOrEqual(32768)
    expect(f.transport.health().droppedRecords).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(6000)
    expect(f.transport.health().ackTimeouts).toBeGreaterThan(0)
  })
  it('waits for acknowledgements and labels freeze summaries with their request', async () => {
    const f = fixture()
    f.transport.onFlush(() =>
      f.transport.report({ scope: 'performance.renderer', metadata: { count: 3 } })
    )
    const pending = f.emit('logs:freeze', { requestId: 'freeze-test', cutoff: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    await pending
    const packet = f.packets.find((p) => p.channel === 'logs:batch')
    expect(packet.payload.records[0].exportRequestId).toBe('freeze-test')
    expect(f.packets.at(-1)).toMatchObject({
      channel: 'logs:frozen',
      payload: { incomplete: false, producerSeq: 1 }
    })
    expect(f.transport.health().queuedBytes).toBe(0)
  })
  it('expires locally and reports changed capabilities and rejected batches as partial', async () => {
    const f = fixture(false)
    f.transport.applyPolicy({
      mode: 'deep',
      policyEpoch: 2,
      expiresAt: Date.now() + 2000,
      remainingMs: 2000,
      transportBytes: 32768
    })
    f.transport.capability('renderer-performance')
    expect(f.packets.at(-1).payload.capabilities).toContain('renderer-performance')
    f.transport.report({ message: 'one' })
    const packet = f.packets.find((p) => p.channel === 'logs:batch')
    f.emit('logs:ack', { batchId: packet.payload.batchId, accepted: false })
    expect((await f.transport.flush()).incomplete).toBe(true)
    await vi.advanceTimersByTimeAsync(2001)
    expect(f.transport.getPolicy().mode).toBe('daily')
    expect(f.transport.health().queuedBytes).toBe(0)
  })
})
