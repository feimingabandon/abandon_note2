import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { records, handlers, writeLog } = vi.hoisted(() => {
  const records = []
  return { records, handlers: new Map(), writeLog: vi.fn((entry) => records.push(entry)) }
})
vi.mock('../src/main/logging/logger.js', () => ({
  writeLog,
  logger: { warn: vi.fn(), error: vi.fn() }
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
  BrowserWindow: { fromWebContents: () => null }
}))
import { ipcMain } from '../src/main/logging/ipc-main.js'
import { createDiagnosticIpcRenderer } from '../src/preload/diagnostic-ipc.js'
import { currentOperation, withOperation } from '../src/main/logging/operation-context.js'
import {
  observeNoteMutation,
  readSettingEvidence,
  reportSettingEvidence
} from '../src/main/logging/persistence-evidence.js'
import { diagnosticOutcome, summarizeDiagnosticResult } from '../src/shared/diagnostic-actions.js'
import {
  createRefreshCauses,
  traceViewRefresh,
  installInteractionEvidence
} from '../src/renderer/src/utils/diagnosticEvidence.js'

const event = { sender: { id: 9, getURL: () => 'test' } }
const context = (actionId, channel = 'notes:update') => ({
  __abandonDiagnostic: 1,
  channel,
  actionId
})
beforeEach(() => {
  records.length = 0
  handlers.clear()
  writeLog.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('operation evidence, not inferred success', () => {
  it('preserves sync return and false without declaring failure or success', () => {
    ipcMain.handle('notes:update', (_event, payload) => {
      expect(payload).toEqual({ id: 1 })
      return false
    })
    expect(handlers.get('notes:update')(event, { id: 1 }, context('sync'))).toBe(false)
    expect(records.map((row) => row.phase)).toEqual(['received', 'returned'])
    expect(records.at(-1)).toMatchObject({ outcome: 'returned', metadata: { resultValue: false } })
    expect(diagnosticOutcome({ success: false })).toBe('rejected')
    expect(diagnosticOutcome({ canceled: true })).toBe('canceled')
    expect(diagnosticOutcome({ changed: false })).toBe('no-change')
    expect(summarizeDiagnosticResult(null)).toEqual({ resultType: 'null' })
  })

  it('keeps concurrent invocation identities isolated after a cloning failure', async () => {
    const releases = []
    ipcMain.handle('notes:update', async (_event, payload) => {
      const initial = currentOperation().actionId
      await new Promise((resolve) => releases.push(resolve))
      expect(currentOperation().actionId).toBe(initial)
      return payload.id
    })
    const raw = {
      send: vi.fn(),
      invoke: vi.fn((channel, ...args) => {
        structuredClone(args) // 实际克隆失败，而非仅伪造日志结果。
        return handlers.get(channel)(event, ...args)
      })
    }
    const api = createDiagnosticIpcRenderer(raw)
    await expect(api.invoke('notes:update', { id: 0, invalid: () => {} })).rejects.toThrow()
    const a = api.invoke('notes:update', { id: 1 })
    const b = api.invoke('notes:update', { id: 2 })
    releases[1]()
    releases[0]()
    expect(await Promise.all([a, b])).toEqual([1, 2])
    const [failed, first, second] = raw.invoke.mock.calls.map((args) => args.at(-1).actionId)
    expect(records.some((row) => row.actionId === failed)).toBe(false)
    expect(records.filter((row) => row.phase === 'returned').map((row) => row.actionId)).toEqual([
      second,
      first
    ])
    expect(currentOperation()).toBeNull()
  })

  it('reports outstanding calls and clears their timer on return', async () => {
    vi.useFakeTimers()
    let release
    ipcMain.handle(
      'notes:update',
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const request = handlers.get('notes:update')(event, {}, context('pending'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(records.at(-1).phase).toBe('pending')
    release(true)
    await request
    expect(records.at(-1).phase).toBe('returned')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not replace a business return or exception when logging fails', async () => {
    writeLog.mockImplementationOnce(() => {
      throw new Error('disk unavailable')
    })
    ipcMain.handle('notes:update', () => true)
    expect(handlers.get('notes:update')(event, {}, context('logger-fails'))).toBe(true)
    const failure = new Error('save failed')
    ipcMain.handle('notes:update', () => {
      throw failure
    })
    expect(() => handlers.get('notes:update')(event, {}, context('failure'))).toThrow(failure)
  })
})

describe('database evidence', () => {
  it('distinguishes SQL NULL from a missing row and does not report a missing row as verified', () => {
    const entries = [{ id: 'nullable', type: 'test', key: 'nullable', value: null }]
    const read = () => [{ type: 'test', key: 'nullable', value: null }]
    reportSettingEvidence(null, readSettingEvidence(entries, read, new Set(), 'week'))
    expect(records.at(-1).outcome).toBe('verified')
    reportSettingEvidence(
      null,
      readSettingEvidence(entries, () => [], new Set(), 'week')
    )
    expect(records.at(-1).outcome).toBe('mismatch')
  })

  it('detects a silently ignored content edit even when the timestamp changes', () => {
    let row = { id: 1, content: 'before', updated_at: 1 }
    observeNoteMutation(
      () => {
        row = { ...row, updated_at: 2 }
        return row
      },
      () => row,
      event,
      [{ id: 1, fields: { content: 'after!' } }],
      'notes:update'
    )
    expect(records.at(-1)).toMatchObject({
      outcome: 'mismatch',
      metadata: { dataChanged: false, mismatchedFields: ['content'] }
    })
  })

  it('detects silently ignored setting writes from independent readback', () => {
    const entries = [
      { id: 'notes.tagColorEnabled', type: 'notes', key: 'tag_color_enabled', value: 'false' }
    ]
    const read = vi.fn(() => [{ type: 'notes', key: 'tag_color_enabled', value: 'true' }])
    const snapshot = readSettingEvidence(entries, read, new Set(['notes.tagColorEnabled']), 'month')
    withOperation({ actionId: 'setting' }, () => reportSettingEvidence(snapshot, snapshot))
    expect(read).toHaveBeenCalledWith('application')
    expect(records.at(-1)).toMatchObject({
      actionId: 'setting',
      outcome: 'mismatch',
      metadata: { matches: false, changed: false }
    })
  })

  it('detects changed content of equal length, no-op, deletion and unavailable reads', () => {
    let row = {
      id: 1,
      content: '原始',
      status: 'in_progress',
      content_color_ranges: '[{"text":"原始","color":"#abc"}]'
    }
    const read = () => row
    observeNoteMutation(
      () => {
        row = { ...row, content: '变更' }
        return row
      },
      read,
      event,
      [{ id: 1 }]
    )
    expect(records.at(-1)).toMatchObject({
      outcome: 'changed',
      metadata: { changedFields: ['content'] }
    })
    expect(JSON.stringify(records)).not.toMatch(/原始|变更/)
    observeNoteMutation(() => row, read, event, [{ id: 1 }])
    expect(records.at(-1).outcome).toBe('no-change')
    observeNoteMutation(
      () => {
        row = null
        return true
      },
      read,
      event,
      [{ id: 1 }]
    )
    expect(records.at(-1).metadata.after).toBeNull()
    expect(
      observeNoteMutation(
        () => false,
        () => {
          throw new Error('db unavailable')
        },
        event,
        [{ id: 1 }]
      )
    ).toBe(false)
    expect(records.at(-1).outcome).toBe('unavailable')
  })
})

describe('renderer evidence', () => {
  it('does not acknowledge another refresh as this request after it is superseded', async () => {
    const logs = []
    vi.stubGlobal('window', { api: { reportLog: (entry) => logs.push(entry) } })
    const read = vi.fn()
    await traceViewRefresh(
      'list',
      {},
      async () => ({ status: 'success' }),
      read,
      () => false
    )
    expect(read).not.toHaveBeenCalled()
    expect(logs.at(-1).outcome).toBe('stale')
  })

  it('keeps a refresh result when renderer log transport and evidence reads fail', async () => {
    vi.stubGlobal('window', {
      api: {
        reportLog: () => {
          throw new Error('transport gone')
        }
      }
    })
    const result = { status: 'success' }
    await expect(
      traceViewRefresh(
        'list',
        {},
        async () => result,
        () => {
          throw new Error('unavailable')
        }
      )
    ).resolves.toBe(result)
  })

  it('retains merged causes and never reports stale/failed refreshes as applied', async () => {
    const logs = []
    vi.stubGlobal('window', { api: { reportLog: (entry) => logs.push(entry) } })
    const causes = createRefreshCauses('month')
    causes.add({ diagnostic: { actionId: 'one' } })
    causes.add({ diagnostic: { actionId: 'two' } })
    const merged = causes.take()
    expect(merged.causeActionIds).toEqual(['one', 'two'])
    const read = vi.fn(() => ({ count: 1 }))
    await traceViewRefresh('month', merged, async () => ({ status: 'cancelled' }), read)
    await traceViewRefresh('month', merged, async () => ({ status: 'error' }), read)
    expect(read).not.toHaveBeenCalled()
    await traceViewRefresh('month', merged, async () => ({ status: 'success' }), read)
    expect(logs.at(-1)).toMatchObject({
      eventName: 'view.data-applied',
      metadata: { causeActionIds: ['one', 'two'], count: 1 }
    })
    expect(causes.take().causeActionIds).toEqual([])
  })

  it('records a click even if no business IPC fires, without reading entered text', () => {
    const listeners = new Map()
    const target = {
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: vi.fn()
    }
    const reportLog = vi.fn()
    const stop = installInteractionEvidence({ reportLog }, target)
    const control = {
      tagName: 'INPUT',
      type: 'text',
      closest: () => null,
      getAttribute: (key) => (key === 'data-diagnostic-action' ? 'note.save' : ''),
      get value() {
        throw new Error('must not read')
      },
      get textContent() {
        throw new Error('must not read')
      }
    }
    listeners.get('click')({ target: { closest: () => control }, type: 'click', isTrusted: true })
    expect(reportLog).toHaveBeenCalledWith(expect.objectContaining({ eventName: 'ui.interaction' }))
    stop()
    expect(target.removeEventListener).toHaveBeenCalledTimes(4)
  })
})
