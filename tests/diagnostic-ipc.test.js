import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticIpcRenderer } from '../src/preload/diagnostic-ipc.js'

describe('preload diagnostic IPC wrapper', () => {
  it('reports broadcast receipt without changing callback arguments or listener removal', () => {
    const raw = { send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    const ipc = createDiagnosticIpcRenderer(raw)
    const listener = vi.fn()
    ipc.on('notes:changed', listener)
    const wrapped = raw.on.mock.calls[0][1]
    const event = {}
    const payload = { id: 9, diagnostic: { actionId: 'source' } }
    wrapped(event, payload)
    expect(listener).toHaveBeenCalledWith(event, payload)
    expect(raw.send).toHaveBeenCalledWith(
      'logs:write',
      expect.objectContaining({
        actionId: 'source',
        eventName: 'broadcast.received',
        level: 'info'
      })
    )
    ipc.removeListener('notes:changed', listener)
    expect(raw.removeListener).toHaveBeenCalledWith('notes:changed', wrapped)
  })
  it('records start and success around a mapped operation and forwards the original result', async () => {
    const sent = []
    const result = { id: 42, status: 'in_progress', content: '不会进入结果日志' }
    const raw = {
      send: vi.fn((...args) => sent.push(args)),
      invoke: vi.fn(async () => result),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const ipc = createDiagnosticIpcRenderer(raw)

    await expect(
      ipc.invoke('notes:save-draft', { id: 42, fields: { content: '正文' } })
    ).resolves.toBe(result)

    const actionLogs = sent
      .filter(([channel]) => channel === 'logs:write')
      .map(([, value]) => value)
    const context = raw.invoke.mock.calls[0].at(-1)
    expect(actionLogs.map((entry) => entry.phase)).toEqual(['start', 'returned'])
    expect(actionLogs[0]).toMatchObject({
      eventName: 'note.save',
      outcome: 'pending',
      metadata: {
        channel: 'notes:save-draft',
        arguments: [{ id: 42, fields: { content: { omitted: true, length: 2 } } }]
      }
    })
    expect(actionLogs[1]).toMatchObject({
      eventName: 'note.save',
      outcome: 'returned',
      metadata: { resultId: 42, resultStatus: 'in_progress' }
    })
    expect(actionLogs[1].metadata).not.toHaveProperty('content')
    expect(context).toMatchObject({
      __abandonDiagnostic: 1,
      channel: 'notes:save-draft',
      actionId: actionLogs[0].actionId
    })
  })

  it('records a stable failure code and rethrows the original error', async () => {
    const sent = []
    const failure = new Error('An object could not be cloned.')
    const raw = {
      send: vi.fn((...args) => sent.push(args)),
      invoke: vi.fn(async () => {
        throw failure
      }),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const ipc = createDiagnosticIpcRenderer(raw)

    await expect(ipc.invoke('notes:create', { content: '正文' })).rejects.toBe(failure)
    const failureLog = sent
      .filter(([channel]) => channel === 'logs:write')
      .map(([, value]) => value)
      .find((entry) => entry.phase === 'failure')
    expect(failureLog).toMatchObject({
      eventName: 'note.create',
      outcome: 'failure',
      errorCode: 'IPC_CLONE_FAILED'
    })
  })

  it('does not let diagnostic transport failures change a successful business result', async () => {
    const raw = {
      send: vi.fn(() => {
        throw new Error('diagnostic channel unavailable')
      }),
      invoke: vi.fn(async () => ({ changed: true })),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const ipc = createDiagnosticIpcRenderer(raw)

    await expect(ipc.invoke('set-setting-value', 'weather.enabled', true)).resolves.toEqual({
      changed: true
    })
    expect(raw.invoke).toHaveBeenCalledOnce()
  })
})
