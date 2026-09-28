import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
const fixtures = vi.hoisted(() => ({
  records: [],
  flush: vi.fn(async () => ({ status: 'ready', incomplete: false }))
}))
vi.mock('../src/main/logging/logger.js', () => ({
  getLoggingHealth: () => ({ writer: { status: 'ready' } }),
  flushLogs: fixtures.flush,
  saveRecentDiagnostics: () => ({ incomplete: false }),
  normalizeRendererLog: (record) => record,
  writeLog: (record) => fixtures.records.push(record)
}))
vi.mock('../src/main/logging/window-capture.js', () => ({
  getWindowLogContext: (win) => ({ role: win.role }),
  getWindowDiagnosticContext: () => ({}),
  noteStructuredRendererConsole: () => {}
}))
import { registerDiagnosticController } from '../src/main/logging/diagnostic-controller.js'
import { diagnosticState } from '../src/main/logging/diagnostic-state.js'
import { createDiagnosticTransport } from '../src/preload/diagnostic-transport.js'

const cleanups = []
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  diagnosticState.stop()
  fixtures.records.length = 0
  vi.useRealTimers()
})
function fixture() {
  const handlers = new Map()
  const mainEvents = new Map()
  const windows = []
  const ipcMain = {
    handle: (name, fn) => handlers.set(name, fn),
    on: (name, fn) => mainEvents.set(name, fn)
  }
  const BrowserWindow = {
    getAllWindows: () => windows,
    fromWebContents: (sender) => windows.find((win) => win.webContents === sender)
  }
  const controller = registerDiagnosticController({ ipcMain, controls: ipcMain, BrowserWindow })
  cleanups.push(() => controller.dispose())
  function add(role, respond = true) {
    const events = new Map()
    const sender = new EventEmitter()
    Object.assign(sender, {
      id: windows.length + 1,
      isDestroyed: () => false,
      getOSProcessId: () => 42,
      mainFrame: {}
    })
    const event = { sender, senderFrame: sender.mainFrame }
    const win = { role, id: sender.id, webContents: sender, isDestroyed: () => false }
    windows.push(win)
    sender.send = (channel, payload) => {
      if (respond) void events.get(channel)?.({}, payload)
    }
    const raw = {
      invoke: async (channel, payload) => handlers.get(channel)(event, payload),
      on: (channel, fn) => events.set(channel, fn),
      removeListener: (channel) => events.delete(channel),
      send: (channel, payload) => mainEvents.get(channel)?.(event, payload)
    }
    const transport = createDiagnosticTransport(raw)
    cleanups.push(() => transport.dispose())
    return {
      event,
      transport,
      win,
      destroy() {
        win.isDestroyed = () => true
        sender.isDestroyed = () => true
        sender.emit('destroyed')
      }
    }
  }
  return { handlers, mainEvents, controller, add, windows }
}
describe('diagnostic multi-window controller', () => {
  it('submits throttled errors before close and retains the confirmed final producer sequence', async () => {
    const f = fixture()
    const sticky = f.add('sticky')
    await Promise.resolve()
    sticky.transport.report({ scope: 'prime', message: 'first' })
    sticky.transport.report({ level: 'error', scope: 'closing-error', message: 'last' })
    expect(sticky.transport.health().queuedBytes).toBeGreaterThan(0)
    await sticky.transport.prepareForUnload('sticky:close')
    sticky.destroy()
    const capture = await f.controller.freeze()
    expect(fixtures.records.some((item) => item.scope === 'closing-error')).toBe(true)
    expect(capture).toMatchObject({
      complete: true,
      windows: [{ status: 'complete', lifecycle: 'destroyed' }]
    })
  })
  it('keeps forced destruction and subsequent activity after a final flush explicitly partial', async () => {
    const f = fixture()
    const forced = f.add('sticky')
    await Promise.resolve()
    forced.transport.report({ scope: 'prime' })
    forced.transport.report({ scope: 'unsent' })
    forced.destroy()
    const resumed = f.add('sticky')
    await Promise.resolve()
    await resumed.transport.prepareForUnload()
    resumed.transport.report({ scope: 'new-after-final-flush' })
    resumed.destroy()
    const capture = await f.controller.freeze()
    expect(capture.complete).toBe(false)
    expect(capture.windows.map((item) => item.status)).toEqual(['partial', 'partial'])
  })
  it('bounds retired producers while retaining omitted loss counts', async () => {
    const f = fixture()
    for (let i = 0; i < 66; i++) {
      const win = f.add('sticky')
      await Promise.resolve()
      win.destroy()
    }
    const capture = await f.controller.freeze()
    expect(capture.windows).toHaveLength(64)
    expect(capture).toMatchObject({
      complete: false,
      retiredOmitted: 2,
      retiredIncompleteOmitted: 2
    })
  })
  it('ends deep collection when a producer repeatedly exceeds its transport budget', async () => {
    const f = fixture()
    const known = f.add('main')
    await Promise.resolve()
    await f.handlers.get('logs:mode-start')()
    for (let sequence = 1; sequence <= 3; sequence++) {
      f.mainEvents.get('logs:batch')(known.event, {
        producerId: known.transport.producerId,
        batchId: `pressure-${sequence}`,
        records: [],
        health: { droppedRecords: sequence * 10 }
      })
    }
    expect(f.controller.state()).toMatchObject({ mode: 'daily', reason: 'queue-budget' })
  })
  it('synchronizes current policy with new windows and freezes every registered producer', async () => {
    const f = fixture()
    const first = f.add('month')
    await Promise.resolve()
    first.transport.onFlush(() =>
      first.transport.report({ scope: 'performance.renderer', metadata: { count: 2 } })
    )
    const deep = await f.handlers.get('logs:mode-start')()
    expect(deep.producers[0].quota).toBe(256 * 1024)
    expect(deep.mode).toBe('deep')
    expect(first.transport.getPolicy().mode).toBe('deep')
    const sticky = f.add('sticky')
    await Promise.resolve()
    expect(sticky.transport.getPolicy().mode).toBe('deep')
    expect(
      f.controller.state().producers.reduce((sum, producer) => sum + producer.quota, 0)
    ).toBeLessThanOrEqual(1024 * 1024)
    const result = await f.controller.freeze()
    expect(result.complete).toBe(true)
    expect(result.windows).toHaveLength(2)
    expect(fixtures.records.some((r) => r.exportRequestId === result.requestId)).toBe(true)
    await f.handlers.get('logs:mode-stop')()
    expect(first.transport.getPolicy().mode).toBe('daily')
    expect(sticky.transport.getPolicy().mode).toBe('daily')
  })
  it('reports missing acknowledgements and unsupported windows instead of a complete export', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.add('main', false)
    await Promise.resolve()
    f.windows.push({
      id: 99,
      webContents: { id: 99 },
      role: 'unsupported',
      isDestroyed: () => false
    })
    const pending = f.controller.freeze()
    await vi.advanceTimersByTimeAsync(1001)
    const result = await pending
    expect(result.complete).toBe(false)
    expect(result.windows.map((w) => w.status).sort()).toEqual(['timeout', 'unsupported'])
  })
  it('rejects non-application and child frames, deduplicates producer sequences, and replaces reloaded producers', async () => {
    const f = fixture()
    const known = f.add('main')
    await Promise.resolve()
    expect(() =>
      f.handlers.get('logs:policy-get')({ sender: {} }, { producerId: 'foreign' })
    ).toThrow('无权')
    expect(() =>
      f.handlers.get('logs:policy-get')(
        { ...known.event, senderFrame: {} },
        { producerId: 'subframe' }
      )
    ).toThrow('无权')
    const batch = {
      producerId: known.transport.producerId,
      batchId: 'batch',
      records: [{ scope: 'test', producerSeq: 1, message: 'one' }]
    }
    f.mainEvents.get('logs:batch')(known.event, batch)
    f.mainEvents.get('logs:batch')(known.event, batch)
    expect(fixtures.records).toHaveLength(1)
    f.handlers.get('logs:policy-get')(known.event, { producerId: 'replacement' })
    f.mainEvents.get('logs:batch')(known.event, batch)
    expect(fixtures.records.filter((item) => item.scope === 'test')).toHaveLength(1)
    expect(f.controller.state().producers).toHaveLength(1)
    expect(f.controller.state().retiredProducers).toMatchObject([
      { lifecycle: 'reloaded', status: 'partial' }
    ])
  })
})
