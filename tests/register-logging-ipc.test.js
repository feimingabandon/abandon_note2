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
  const attachmentRecovery = {
    schemaVersion: 1,
    scope: 'pending-attachment-recovery-round',
    status: 'cleanupPending',
    phase: 'finished',
    partial: false,
    roundId: 'recovery-round-at-click',
    counts: {
      completed: 0,
      cleanupPending: 1,
      referenceMissing: 0,
      preservedConflict: 0,
      undetermined: 0
    },
    operations: [{ operationId: 'retained-operation', status: 'cleanupPending' }]
  }
  const options = {
    mainWindowIpc: createMainWindowIpc(ipc, () => window),
    removeHandler: ipc.removeHandler,
    getWindow: () => window,
    dialog,
    shell,
    diagnosticController,
    logStore,
    collectSystemDiagnostics: vi.fn(async () => ({ runtime: { view: 'list' } })),
    getAttachmentRecoveryReport: vi.fn(() => attachmentRecovery),
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
    attachmentRecovery,
    advanceClock: (ms) => (clockAt += ms),
    event: { sender: window.webContents }
  }
}

describe('owned logging transport', () => {
  it('authorizes the current live main sender before querying, opening or freezing', () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    for (const channel of [
      'logs:query',
      'logs:attachment-recovery',
      'logs:open-folder',
      'logs:export'
    ])
      expect(() => f.handlers.get(channel)({ sender: {} })).toThrow('无权访问')
    expect(f.options.logStore.queryLogs).not.toHaveBeenCalled()
    expect(f.options.logStore.flushLogs).not.toHaveBeenCalled()
    expect(f.options.diagnosticController.freeze).not.toHaveBeenCalled()
    expect(f.options.getAttachmentRecoveryReport).not.toHaveBeenCalled()
    f.window.isDestroyed = () => true
    expect(() => f.handlers.get('logs:export')(f.event)).toThrow('无权访问')
    expect(() => f.handlers.get('logs:attachment-recovery')(f.event)).toThrow('无权访问')
    expect(f.options.getAttachmentRecoveryReport).not.toHaveBeenCalled()
  })

  it('requires the report getter before registering any owned handler', () => {
    const f = fixture()
    delete f.options.getAttachmentRecoveryReport
    expect(() => registerLoggingIpc(f.options)).toThrow('附件恢复报告读取器不可用')
    expect([...f.handlers.keys()]).toEqual(['unrelated'])
    expect(f.ipc.removeHandler).not.toHaveBeenCalled()
  })

  it('queries only the fixed report, rejects every supplied argument and preserves getter errors', () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    const query = f.handlers.get('logs:attachment-recovery')
    const report = query(f.event)
    expect(report).toEqual(f.attachmentRecovery)
    report.operations[0].status = 'completed'
    expect(f.attachmentRecovery.operations[0].status).toBe('cleanupPending')
    expect(f.options.getAttachmentRecoveryReport).toHaveBeenCalledWith()
    for (const argument of [undefined, null, {}, { userDataPath: 'renderer-profile' }])
      expect(() => query(f.event, argument)).toThrow('不接受参数')
    expect(f.options.getAttachmentRecoveryReport).toHaveBeenCalledTimes(1)
    expect(f.options.logStore.freezeLogSnapshot).not.toHaveBeenCalled()
    expect(f.options.diagnosticController.freeze).not.toHaveBeenCalled()
    const error = new Error('report source unavailable')
    f.options.getAttachmentRecoveryReport.mockImplementationOnce(() => {
      throw error
    })
    expect(() => query(f.event)).toThrow(error)
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
      const atClick = structuredClone(f.attachmentRecovery)
      let releaseFreeze
      f.options.diagnosticController.freeze.mockImplementationOnce(() => {
        f.attachmentRecovery.roundId = 'changed-during-freeze-call'
        return new Promise((resolve) => (releaseFreeze = resolve))
      })
      f.options.dialog.showSaveDialog.mockImplementationOnce(async () => {
        f.advanceClock(120_000)
        f.attachmentRecovery.operations[0].status = 'completed'
        f.attachmentRecovery.counts.cleanupPending = 0
        return { canceled: false, filePath: 'delayed-dialog.jsonl' }
      })
      const exporting = f.handlers.get('logs:export')(f.event, { range })
      expect(f.options.getAttachmentRecoveryReport).toHaveBeenCalledTimes(1)
      expect(f.options.getAttachmentRecoveryReport.mock.invocationCallOrder[0]).toBeLessThan(
        f.options.diagnosticController.freeze.mock.invocationCallOrder[0]
      )
      f.attachmentRecovery.roundId = 'changed-during-first-await'
      releaseFreeze(f.frozen)
      expect(await exporting).toEqual({
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
      expect(system).toEqual({ runtime: { view: 'list' }, attachmentRecovery: atClick })
      expect(Object.keys(system)[0]).toBe('attachmentRecovery')
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
    expect(f.options.getAttachmentRecoveryReport).toHaveBeenCalledTimes(1)
    cancelDialog({ canceled: true })
    expect(await exporting).toEqual({ canceled: true })
    expect(f.options.collectSystemDiagnostics).not.toHaveBeenCalled()
    expect(f.options.logStore.exportLogs).not.toHaveBeenCalled()
    expect(f.options.logStore.releaseLogSnapshot).toHaveBeenCalledWith('file-snapshot')
    await expect(f.handlers.get('logs:export')(f.event)).resolves.toMatchObject({ canceled: false })
    expect(f.options.getAttachmentRecoveryReport).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid ranges before capture and releases admission for the next request', async () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    await expect(f.handlers.get('logs:export')(f.event, { range: 'invalid' })).rejects.toThrow(
      '不支持的日志导出范围'
    )
    expect(f.options.diagnosticController.freeze).not.toHaveBeenCalled()
    expect(f.options.getAttachmentRecoveryReport).not.toHaveBeenCalled()
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
      collectionErrors: [{ field: 'system', message: 'unavailable collector' }],
      attachmentRecovery: f.attachmentRecovery
    })
    expect(Object.keys(f.options.logStore.exportLogs.mock.calls[0][2]).slice(0, 2)).toEqual([
      'collectionErrors',
      'attachmentRecovery'
    ])
    f.options.logStore.exportLogs.mockRejectedValueOnce(new Error('disk write failed'))
    await expect(f.handlers.get('logs:export')(f.event)).rejects.toThrow('disk write failed')
    expect(f.options.logStore.releaseLogSnapshot).toHaveBeenCalledTimes(2)
    expect(f.options.logger.info).toHaveBeenCalledTimes(1)
    await expect(f.handlers.get('logs:export')(f.event)).resolves.toMatchObject({ canceled: false })
  })

  it('releases export admission when the first awaited capture fails', async () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    const error = new Error('capture freeze failed')
    f.options.diagnosticController.freeze.mockRejectedValueOnce(error)
    await expect(f.handlers.get('logs:export')(f.event)).rejects.toBe(error)
    expect(f.options.getAttachmentRecoveryReport).toHaveBeenCalledTimes(1)
    expect(f.options.logStore.freezeLogSnapshot).not.toHaveBeenCalled()
    expect(f.options.dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(f.options.logStore.releaseLogSnapshot).toHaveBeenCalledWith(undefined)
    await expect(f.handlers.get('logs:export')(f.event)).resolves.toMatchObject({ canceled: false })
    expect(f.options.getAttachmentRecoveryReport).toHaveBeenCalledTimes(2)
  })

  it('preserves both collection errors when the report read and system collector fail', async () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    f.options.getAttachmentRecoveryReport.mockImplementationOnce(() => {
      throw new Error('recovery snapshot unavailable')
    })
    f.options.collectSystemDiagnostics.mockRejectedValueOnce(new Error('system unavailable'))
    await f.handlers.get('logs:export')(f.event)
    expect(f.options.logStore.exportLogs.mock.calls[0][2]).toEqual({
      capturedAt: new Date(f.requestedAt).toISOString(),
      collectionErrors: [
        { field: 'system', message: 'system unavailable' },
        { field: 'attachmentRecovery', message: 'recovery snapshot unavailable' }
      ]
    })
    expect(f.options.logStore.releaseLogSnapshot).toHaveBeenCalledWith('file-snapshot')
    await f.handlers.get('logs:export')(f.event)
    expect(f.options.logStore.exportLogs.mock.calls[1][2]).toEqual({
      runtime: { view: 'list' },
      attachmentRecovery: f.attachmentRecovery
    })
  })

  it('records cloning failures alongside existing collection errors without inventing a report', async () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    f.options.getAttachmentRecoveryReport.mockReturnValueOnce({ notCloneable() {} })
    f.options.collectSystemDiagnostics.mockResolvedValueOnce({
      runtime: { view: 'month' },
      attachmentRecovery: { roundId: 'later-collector-round-must-not-substitute' },
      collectionErrors: [{ field: 'display', message: 'display unavailable' }]
    })
    await f.handlers.get('logs:export')(f.event)
    expect(f.options.logStore.exportLogs.mock.calls[0][2]).toEqual({
      runtime: { view: 'month' },
      collectionErrors: [
        { field: 'display', message: 'display unavailable' },
        { field: 'attachmentRecovery', message: expect.any(String) }
      ]
    })
  })

  it('places existing collector errors before the report and large system fields without mutating the collector result', async () => {
    const f = fixture()
    registerLoggingIpc(f.options)
    const system = {
      runtime: { view: 'list' },
      collectionErrors: [{ field: 'windows', message: 'window state unavailable' }],
      largeSystemDetails: ['retained-detail']
    }
    f.options.collectSystemDiagnostics.mockResolvedValueOnce(system)
    await f.handlers.get('logs:export')(f.event)
    const exported = f.options.logStore.exportLogs.mock.calls[0][2]
    expect(Object.keys(exported)).toEqual([
      'collectionErrors',
      'attachmentRecovery',
      'runtime',
      'largeSystemDetails'
    ])
    expect(exported.collectionErrors).toEqual(system.collectionErrors)
    expect(exported.attachmentRecovery).toEqual(f.attachmentRecovery)
    expect(system).not.toHaveProperty('attachmentRecovery')
    expect(Object.keys(system)).toEqual(['runtime', 'collectionErrors', 'largeSystemDetails'])
  })

  it('removes only owned registrations and rolls back partial install without deleting existing handlers', () => {
    const f = fixture()
    const dispose = registerLoggingIpc(f.options)
    expect(() => registerLoggingIpc(f.options)).toThrow('duplicate registration')
    expect(f.handlers.size).toBe(5)
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
