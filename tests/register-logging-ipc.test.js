import { describe, expect, it, vi } from 'vitest'
import { createMainWindowIpc } from '../src/main/ipc/ipc-authorization.js'
import { registerLoggingIpc } from '../src/main/ipc/register-logging-ipc.js'

function fixture() {
  const handlers = new Map([['unrelated', () => 'unrelated']])
  const window = { webContents: {}, isDestroyed: () => false }
  const ipc = {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error('duplicate registration')
      handlers.set(channel, handler)
    },
    removeHandler: vi.fn((channel) => handlers.delete(channel))
  }
  const requestedAt = Date.parse('2026-10-10T04:00:00.000Z')
  let clockAt = requestedAt
  const frozen = { requestId: 'capture-request', windows: [] }
  const diagnosticController = {
    freeze: vi.fn(async () => frozen),
    state: vi.fn(() => ({ mode: 'deep' }))
  }
  const logStore = {
    queryLogs: vi.fn(async () => ({ items: ['retained-record'] })),
    flushLogs: vi.fn(async () => {}),
    freezeLogSnapshot: vi.fn(async () => ({ id: 'file-snapshot' })),
    releaseLogSnapshot: vi.fn(async () => {}),
    getLogDirectory: vi.fn(() => 'fixture-logs'),
    exportLogs: vi.fn(async () => {})
  }
  const dialog = {
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: 'diagnostics.jsonl' }))
  }
  const shell = { openPath: vi.fn(async () => '') }
  const options = {
    mainWindowIpc: createMainWindowIpc(ipc, () => window),
    removeHandler: ipc.removeHandler,
    getWindow: () => window,
    dialog,
    shell,
    diagnosticController,
    logStore,
    collectSystemDiagnostics: vi.fn(async () => ({ runtime: { view: 'list' } })),
    getCrashDumpsPath: () => 'fixture-crash-dumps',
    refreshCrashDumpIndex: vi.fn(async () => ['retained-dump']),
    logger: { info: vi.fn() },
    now: () => clockAt
  }
  return {
    handlers,
    window,
    ipc,
    options,
    requestedAt,
    frozen,
    advanceClock: (ms) => (clockAt += ms),
    event: { sender: window.webContents }
  }
}

describe('owned logging transport', () => {
  it('authorizes the current live main sender before querying, opening or freezing', () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    for (const channel of ['logs:query', 'logs:open-folder', 'logs:export'])
      expect(() => f.handlers.get(channel)({ sender: {} })).toThrow('无权访问')
    expect(f.options.logStore.queryLogs).not.toHaveBeenCalled()
    expect(f.options.logStore.flushLogs).not.toHaveBeenCalled()
    expect(f.options.diagnosticController.freeze).not.toHaveBeenCalled()
    f.window.isDestroyed = () => true
    expect(() => f.handlers.get('logs:export')(f.event)).toThrow('无权访问')
  })

  it('preserves query arguments and flushes before opening the directory, including errors', async () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    const query = { search: 'retained', limit: 20 }
    expect(await f.handlers.get('logs:query')(f.event, query)).toEqual({
      items: ['retained-record']
    })
    expect(f.options.logStore.queryLogs).toHaveBeenCalledWith(query)
    expect(await f.handlers.get('logs:open-folder')(f.event)).toBe(true)
    expect(f.options.logStore.flushLogs.mock.invocationCallOrder[0]).toBeLessThan(
      f.options.shell.openPath.mock.invocationCallOrder[0]
    )
    expect(f.options.shell.openPath).toHaveBeenCalledWith('fixture-logs')
    f.options.shell.openPath.mockResolvedValueOnce('Windows could not open the directory')
    await expect(f.handlers.get('logs:open-folder')(f.event)).rejects.toThrow(
      'Windows could not open the directory'
    )
  })

  it.each(['all', 'last-hour'])(
    'freezes %s at click time and retains capture and file identities',
    async (range) => {
      const f = fixture()
      registerLoggingIpc(f.options)
      f.options.dialog.showSaveDialog.mockImplementationOnce(async () => {
        f.advanceClock(120_000)
        return { canceled: false, filePath: 'delayed-dialog.jsonl' }
      })
      expect(await f.handlers.get('logs:export')(f.event, { range })).toEqual({
        canceled: false,
        filePath: 'delayed-dialog.jsonl'
      })
      expect(f.options.diagnosticController.freeze).toHaveBeenCalledWith('export', f.requestedAt)
      expect(f.options.diagnosticController.freeze.mock.invocationCallOrder[0]).toBeLessThan(
        f.options.logStore.freezeLogSnapshot.mock.invocationCallOrder[0]
      )
      expect(f.options.logStore.freezeLogSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
        f.options.dialog.showSaveDialog.mock.invocationCallOrder[0]
      )
      const [target, metadata, system, selection, manifest] =
        f.options.logStore.exportLogs.mock.calls[0]
      expect(target).toBe('delayed-dialog.jsonl')
      expect(metadata).toMatchObject({
        logDirectory: 'fixture-logs',
        crashDumpsPath: 'fixture-crash-dumps',
        recentCrashDumps: ['retained-dump'],
        exportScope: range === 'all' ? 'all-retained-logs' : 'last-hour'
      })
      expect(system).toEqual({ runtime: { view: 'list' } })
      expect(selection).toEqual({
        requestId: 'capture-request',
        snapshotId: 'file-snapshot',
        to: f.requestedAt,
        ...(range === 'last-hour' ? { from: f.requestedAt - 3_600_000 } : {})
      })
      expect(manifest).toEqual({ capture: f.frozen, controller: { mode: 'deep' } })
      expect(f.options.logStore.releaseLogSnapshot).toHaveBeenCalledWith('file-snapshot')
    }
  )

  it('rejects a second export while the save dialog is open and permits retry after cancellation', async () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    let cancelDialog
    f.options.dialog.showSaveDialog.mockImplementationOnce(
      () => new Promise((resolve) => (cancelDialog = resolve))
    )
    const exporting = f.handlers.get('logs:export')(f.event)
    await vi.waitFor(() => expect(cancelDialog).toBeTypeOf('function'))
    await expect(f.handlers.get('logs:export')(f.event)).rejects.toThrow('已有诊断日志正在导出')
    expect(f.options.diagnosticController.freeze).toHaveBeenCalledTimes(1)
    cancelDialog({ canceled: true })
    expect(await exporting).toEqual({ canceled: true })
    expect(f.options.collectSystemDiagnostics).not.toHaveBeenCalled()
    expect(f.options.logStore.exportLogs).not.toHaveBeenCalled()
    expect(f.options.logStore.releaseLogSnapshot).toHaveBeenCalledWith('file-snapshot')
    await expect(f.handlers.get('logs:export')(f.event)).resolves.toMatchObject({ canceled: false })
  })

  it('rejects invalid ranges before capture and releases admission for the next request', async () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    await expect(f.handlers.get('logs:export')(f.event, { range: 'invalid' })).rejects.toThrow(
      '不支持的日志导出范围'
    )
    expect(f.options.diagnosticController.freeze).not.toHaveBeenCalled()
    expect(f.options.logStore.releaseLogSnapshot).toHaveBeenCalledWith(undefined)
    await expect(f.handlers.get('logs:export')(f.event, null)).resolves.toMatchObject({
      canceled: false
    })
  })

  it('exports collection errors as evidence while preserving export failures and retry', async () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    f.options.collectSystemDiagnostics.mockRejectedValueOnce(new Error('unavailable collector'))
    await f.handlers.get('logs:export')(f.event)
    expect(f.options.logStore.exportLogs.mock.calls[0][2]).toEqual({
      capturedAt: new Date(f.requestedAt).toISOString(),
      collectionErrors: [{ field: 'system', message: 'unavailable collector' }]
    })
    f.options.logStore.exportLogs.mockRejectedValueOnce(new Error('disk write failed'))
    await expect(f.handlers.get('logs:export')(f.event)).rejects.toThrow('disk write failed')
    expect(f.options.logStore.releaseLogSnapshot).toHaveBeenCalledTimes(2)
    expect(f.options.logger.info).toHaveBeenCalledTimes(1)
    await expect(f.handlers.get('logs:export')(f.event)).resolves.toMatchObject({ canceled: false })
  })

  it('removes only owned registrations and rolls back partial install without deleting existing handlers', () => {
    const f = fixture()
    const dispose = registerLoggingIpc(f.options)
    expect(() => registerLoggingIpc(f.options)).toThrow('duplicate registration')
    expect(f.handlers.size).toBe(4)
    dispose()
    dispose()
    expect([...f.handlers.keys()]).toEqual(['unrelated'])
    const existing = () => 'existing folder handler'
    f.handlers.set('logs:open-folder', existing)
    expect(() => registerLoggingIpc(f.options)).toThrow('duplicate registration')
    expect([...f.handlers.keys()]).toEqual(['unrelated', 'logs:open-folder'])
    expect(f.handlers.get('logs:open-folder')).toBe(existing)
  })
})
