import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { encodeLogRecord } from '../src/main/logging/log-store.mjs'
import { createLogWriterClient } from '../src/main/logging/log-writer-client.js'
import { drainOperationPerformance } from '../src/main/logging/operation-performance.js'
import { createMainWindowIpc } from '../src/main/ipc/ipc-authorization.js'
import { registerLoggingIpc } from '../src/main/ipc/register-logging-ipc.js'

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-logging-'))
process.env.ABANDON_NOTE_LOG_TEST_USER_DATA = testUserData

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.ABANDON_NOTE_LOG_TEST_USER_DATA,
    getVersion: () => 'test-version',
    getName: () => 'Abandon Note Test',
    on: vi.fn()
  },
  crashReporter: {
    start: vi.fn()
  }
}))

let logging
let windowCapture
let processCapture

beforeAll(async () => {
  logging = await import('../src/main/logging/logger.js')
  windowCapture = await import('../src/main/logging/window-capture.js')
  processCapture = await import('../src/main/logging/process-capture.js')
})

afterAll(async () => {
  if (logging) {
    await logging.closeLogs()
  }
  rmSync(testUserData, { recursive: true, force: true })
  delete process.env.ABANDON_NOTE_LOG_TEST_USER_DATA
})

describe('main-process logging', () => {
  it('measures batches and queue size in memory without recursively writing performance records', async () => {
    await logging.flushLogs()
    drainOperationPerformance()
    for (let i = 0; i < 25; i++)
      logging.writeLog({ scope: 'test.batch', message: 'private-batch-text' })
    await logging.flushLogs()
    const batch = drainOperationPerformance()
    const flush = batch.entries.find((entry) => entry.operation === 'flush')
    const enqueue = batch.entries.find((entry) => entry.operation === 'enqueue')
    expect(flush).toMatchObject({
      metrics: { records: { total: 25 }, errors: { total: 0 } }
    })
    expect(enqueue.count).toBe(25)
    expect(enqueue.metrics.queuedBytes.max).toBeGreaterThan(0)
    expect(JSON.stringify(batch)).not.toContain('private-batch-text')
    await logging.flushLogs()
    expect(drainOperationPerformance().entries).toEqual([])
  })
  it('keeps serializing Electron-like objects when an enumerable getter throws', () => {
    const destroyedWindow = { id: 17 }
    Object.defineProperty(destroyedWindow, 'devToolsWebContents', {
      enumerable: true,
      get() {
        throw new Error('Object has been destroyed')
      }
    })

    expect(logging.loggingInternals.serializeUnknown({ window: destroyedWindow })).toEqual({
      window: {
        id: 17,
        devToolsWebContents: '[accessor omitted]'
      }
    })
  })

  it('keeps the complete encoded JSONL record within the hard byte limit', () => {
    const line = encodeLogRecord({
      id: 'oversized-record',
      time: new Date().toISOString(),
      level: 'error',
      process: 'main',
      scope: '\0'.repeat(20_000),
      message: '\0'.repeat(700_000),
      sessionId: 'test-session',
      pid: process.pid,
      appVersion: 'test-version',
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      error: { stack: 'x'.repeat(700_000) },
      metadata: { payload: 'y'.repeat(700_000) }
    })

    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(32 * 1024)
    expect(JSON.parse(line)).toMatchObject({
      id: 'oversized-record',
      truncation: {
        previewTruncated: true
      }
    })
  })

  it('reads later pages from a stable snapshot while new logs are appended', async () => {
    const marker = `snapshot-${Date.now()}`
    for (const suffix of ['oldest', 'middle', 'newest']) {
      logging.writeLog({
        level: 'info',
        scope: 'test.snapshot',
        message: `${marker}-${suffix}`
      })
    }

    const firstPage = await logging.queryLogs({ search: marker, limit: 2 })
    expect(firstPage.items.map((item) => item.message)).toEqual([
      `${marker}-newest`,
      `${marker}-middle`
    ])
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    logging.writeLog({
      level: 'info',
      scope: 'test.snapshot',
      message: `${marker}-arrived-after-snapshot`
    })
    await logging.flushLogs()

    const secondPage = await logging.queryLogs({
      search: marker,
      limit: 2,
      cursor: firstPage.nextCursor
    })
    expect(secondPage.items.map((item) => item.message)).toEqual([`${marker}-oldest`])
    expect(secondPage.hasMore).toBe(false)
  })

  it('refuses to export over one of the source log files', async () => {
    logging.writeLog({
      level: 'info',
      scope: 'test.export',
      message: 'source-path-protection'
    })
    await logging.flushLogs()
    const [source] = await logging.getLogFiles()

    await expect(logging.exportLogs(source.path)).rejects.toThrow('导出目标不能覆盖现有日志文件')
  })

  it('keeps existing records and appends the current system snapshot as the last JSONL record', async () => {
    const marker = `export-tail-${Date.now()}`
    logging.writeLog({ scope: 'test.export', message: marker })
    const target = join(testUserData, 'diagnostics-export.jsonl')
    const snapshot = {
      capturedAt: new Date().toISOString(),
      displays: [{ scaleFactor: 1.25, scalePercent: 125 }]
    }
    await logging.exportLogs(target, { fixture: true }, snapshot)
    const records = readFileSync(target, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({ type: 'diagnostic-export', metadata: { fixture: true } })
    expect(records.some((record) => record.message === marker)).toBe(true)
    expect(records.at(-1)).toEqual({ type: 'diagnostic-system', schemaVersion: 1, snapshot })
  })

  it('redacts attachment recovery evidence inside the existing diagnostic-system JSONL tail', async () => {
    const target = join(testUserData, 'attachment-recovery-redacted-export.jsonl')
    const privatePath = 'C:\\Users\\Example\\private\\payload.png'
    const counts = {
      completed: 0,
      cleanupPending: 0,
      referenceMissing: 0,
      preservedConflict: 0,
      undetermined: 1
    }
    await logging.exportLogs(
      target,
      { fixture: 'attachment-recovery' },
      {
        capturedAt: '2026-10-23T00:00:00.000Z',
        attachmentRecovery: {
          schemaVersion: 1,
          scope: 'pending-attachment-recovery-round',
          status: 'undetermined',
          phase: 'failed',
          partial: true,
          counts,
          operations: [
            {
              operationId: privatePath,
              operationType: 'unknown',
              status: 'undetermined',
              decision: 'unknown',
              failurePhase: 'read-manifest',
              reason: `Failed ${privatePath} token=private-recovery-token data:image/png;base64,cHJpdmF0ZQ==`
            }
          ]
        }
      }
    )
    const jsonl = readFileSync(target, 'utf8')
    const records = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records.filter((record) => record.type === 'diagnostic-system')).toHaveLength(1)
    expect(records.at(-1)).toMatchObject({ type: 'diagnostic-system', schemaVersion: 1 })
    const report = records.at(-1).snapshot.attachmentRecovery
    expect(report).toMatchObject({
      scope: 'pending-attachment-recovery-round',
      status: 'undetermined',
      phase: 'failed',
      partial: true,
      counts
    })
    expect(report.operations[0].operationId).toContain('[local-path]')
    expect(report.operations[0].reason).toContain('[local-path]')
    expect(report.operations[0].reason).toContain('[redacted]')
    expect(report.operations[0].reason).toContain('[data omitted]')
    expect(jsonl).not.toContain(privatePath)
    expect(jsonl).not.toContain('private-recovery-token')
    expect(jsonl).not.toContain('cHJpdmF0ZQ==')
  })

  it('keeps recovery scope and counts while the existing maxArray budget explicitly omits excess operations', async () => {
    const target = join(testUserData, 'attachment-recovery-array-budget-export.jsonl')
    const counts = {
      completed: 129,
      cleanupPending: 0,
      referenceMissing: 0,
      preservedConflict: 0,
      undetermined: 0
    }
    await logging.exportLogs(
      target,
      { fixture: 'attachment-recovery-budget' },
      {
        attachmentRecovery: {
          schemaVersion: 1,
          scope: 'pending-attachment-recovery-round',
          status: 'completed',
          phase: 'finished',
          partial: false,
          counts,
          operations: Array.from({ length: 129 }, (_, index) => ({
            operationId: `operation-${index}`,
            status: 'completed'
          }))
        },
        largeSystemDetails: Array.from({ length: 128 }, () => 'system-details'.repeat(256))
      }
    )
    const records = readFileSync(target, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records.filter((record) => record.type === 'diagnostic-system')).toHaveLength(1)
    expect(records.at(-1)).toMatchObject({ type: 'diagnostic-system', schemaVersion: 1 })
    const report = records.at(-1).snapshot.attachmentRecovery
    expect(report).toMatchObject({
      scope: 'pending-attachment-recovery-round',
      partial: false,
      counts
    })
    expect(report.operations).toHaveLength(129)
    expect(report.operations[127]).toEqual({ operationId: 'operation-127', status: 'completed' })
    expect(report.operations.at(-1)).toEqual({ omittedItems: 1 })
    expect(JSON.stringify(report)).not.toContain('[budget omitted]')
  })

  it('preserves actual registrar collector errors and recovery summary when large operations exhaust the JSONL budget', async () => {
    const target = join(testUserData, 'registrar-attachment-recovery-budget-export.jsonl')
    const handlers = new Map()
    const window = { webContents: {}, isDestroyed: () => false }
    const ipc = { handle: (channel, handler) => handlers.set(channel, handler) }
    const counts = {
      completed: 0,
      cleanupPending: 0,
      referenceMissing: 0,
      preservedConflict: 0,
      undetermined: 128
    }
    const dispose = registerLoggingIpc({
      mainWindowIpc: createMainWindowIpc(ipc, () => window),
      removeHandler: (channel) => handlers.delete(channel),
      getWindow: () => window,
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) },
      shell: { openPath: async () => '' },
      diagnosticController: {
        freeze: async () => ({ requestId: 'registrar-recovery-budget', complete: true }),
        state: () => ({ mode: 'off' })
      },
      logStore: logging,
      collectSystemDiagnostics: async () => {
        throw new Error('system collector unavailable in budget fixture')
      },
      getAttachmentRecoveryReport: () => ({
        schemaVersion: 1,
        scope: 'pending-attachment-recovery-round',
        status: 'undetermined',
        phase: 'finished',
        partial: false,
        counts,
        operations: Array.from({ length: 128 }, (_, index) => ({
          operationId: `operation-${index}`,
          operationType: 'reset',
          status: 'undetermined',
          decision: 'unknown',
          failurePhase: 'read-manifest',
          reason: 'unavailable-operation-detail-'.repeat(150)
        }))
      }),
      getCrashDumpsPath: () => 'fixture-crash-dumps',
      refreshCrashDumpIndex: async () => [],
      logger: logging.logger
    })
    try {
      await expect(
        handlers.get('logs:export')({ sender: window.webContents }, { range: 'all' })
      ).resolves.toEqual({ canceled: false, filePath: target })
      const records = readFileSync(target, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(records.filter((record) => record.type === 'diagnostic-system')).toHaveLength(1)
      const tail = records.at(-1)
      expect(tail).toMatchObject({ type: 'diagnostic-system', schemaVersion: 1 })
      expect(tail.snapshot.collectionErrors).toEqual([
        { field: 'system', message: 'system collector unavailable in budget fixture' }
      ])
      expect(tail.snapshot.attachmentRecovery).toMatchObject({
        scope: 'pending-attachment-recovery-round',
        partial: false,
        counts
      })
      const operations = tail.snapshot.attachmentRecovery.operations
      expect(operations.length).toBeGreaterThan(1)
      expect(operations.length).toBeLessThan(128)
      expect(operations.at(-1).omittedItems).toBeGreaterThan(0)
    } finally {
      dispose()
    }
    expect(handlers.size).toBe(0)
  })

  it('persists action correlation fields and can export only one run session', async () => {
    const marker = `action-export-${Date.now()}`
    logging.writeLog({
      scope: 'action.note.save',
      message: marker,
      eventName: 'note.save',
      phase: 'failure',
      actionId: 'action-test-42',
      outcome: 'failure',
      durationMs: 17,
      errorCode: 'SAVE_FAILED',
      stage: 'ipc-handler'
    })
    await logging.flushLogs()
    const source = (await logging.getLogFiles())[0]
    writeFileSync(
      source.path,
      `${JSON.stringify({
        time: new Date().toISOString(),
        sessionId: 'foreign-session',
        message: `${marker}-foreign`
      })}\n`,
      { flag: 'a' }
    )

    const target = join(testUserData, 'diagnostics-session-export.jsonl')
    await logging.exportLogs(
      target,
      { fixture: true },
      { capturedAt: new Date().toISOString() },
      { sessionId: logging.getCurrentSessionId() }
    )
    const records = readFileSync(target, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toContainEqual(
      expect.objectContaining({
        schemaVersion: 3,
        message: marker,
        eventName: 'note.save',
        phase: 'failure',
        actionId: 'action-test-42',
        errorCode: 'SAVE_FAILED',
        stage: 'ipc-handler'
      })
    )
    expect(records.some((record) => record.sessionId === 'foreign-session')).toBe(false)
  })

  it('captures the Electron 43 console-message event details object', async () => {
    const marker = `console-event-${Date.now()}`
    const webContents = new EventEmitter()
    webContents.id = 73
    const win = new EventEmitter()
    win.id = 19
    win.webContents = webContents
    win.isDestroyed = () => false
    win.getBounds = () => ({ x: 1, y: 2, width: 300, height: 200 })
    win.isVisible = () => true
    win.isFocused = () => false
    win.isMinimized = () => false
    webContents.getOSProcessId = () => 9876
    webContents.getURL = () => 'app://test-window'

    windowCapture.setWindowLogContext(win, { role: 'test-window' })
    windowCapture.attachWindowLogging(win)
    webContents.emit('console-message', {
      level: 'error',
      message: marker,
      lineNumber: 42,
      sourceId: 'SettingsPanel.vue'
    })

    await new Promise((resolve) => setTimeout(resolve, 1300))
    const result = await logging.queryLogs({ search: marker, limit: 10 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      level: 'error',
      process: 'renderer',
      scope: 'renderer.console',
      message: marker,
      windowRole: 'test-window',
      webContentsId: 73,
      metadata: {
        lineNumber: 42,
        sourceId: 'SettingsPanel.vue',
        windowContext: { role: 'test-window' },
        browserWindowId: 19,
        rendererProcessId: 9876,
        url: 'app://test-window',
        windowState: {
          bounds: { x: 1, y: 2, width: 300, height: 200 },
          visible: true,
          focused: false,
          minimized: false
        }
      }
    })
  })

  it('deduplicates structured renderer console messages without dropping unmatched browser errors', async () => {
    const marker = `structured-console-${Date.now()}`
    const unmatchedMarker = `${marker}-browser-only`
    const webContents = new EventEmitter()
    webContents.id = 75
    const win = new EventEmitter()
    win.webContents = webContents
    win.isDestroyed = () => false

    windowCapture.setWindowLogContext(win, { role: 'main' })
    windowCapture.attachWindowLogging(win)
    windowCapture.noteStructuredRendererConsole(win, {
      level: 'error',
      scope: 'main-renderer.console-error',
      message: marker
    })
    webContents.emit('console-message', {
      level: 'error',
      message: marker,
      lineNumber: 5,
      sourceId: 'NoteEditor.vue'
    })
    webContents.emit('console-message', {
      level: 'error',
      message: unmatchedMarker,
      lineNumber: 6,
      sourceId: 'chromium'
    })

    await new Promise((resolve) => setTimeout(resolve, 1300))
    const result = await logging.queryLogs({ search: marker, limit: 10 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      scope: 'renderer.console',
      message: unmatchedMarker
    })
  })

  for (const flushOnDestroyed of [false, true]) {
    it(`preserves a queued console error after native window getters are destroyed (${flushOnDestroyed ? 'destroyed event' : 'late timer'})`, async () => {
      const marker = `closed-console-${flushOnDestroyed}-${Date.now()}`
      let destroyed = false
      const webContents = new EventEmitter()
      const win = new EventEmitter()
      const readNative = (value) => {
        if (destroyed) throw new TypeError('Object has been destroyed')
        return value
      }
      Object.defineProperties(win, {
        id: { get: () => readNative(81) },
        webContents: { get: () => readNative(webContents) }
      })
      Object.defineProperty(webContents, 'id', { get: () => readNative(82) })
      win.isDestroyed = () => destroyed
      win.getBounds = () => readNative({ x: 0, y: 0, width: 300, height: 200 })
      webContents.getURL = () => readNative('app://closing-window')
      webContents.getOSProcessId = () => readNative(83)
      windowCapture.setWindowLogContext(win, { role: 'closing-window' })
      windowCapture.attachWindowLogging(win)
      webContents.emit('console-message', { level: 'error', message: marker, lineNumber: 1 })
      destroyed = true
      expect(() => windowCapture.getWindowDiagnosticContext(win)).not.toThrow()
      expect(() => windowCapture.getWindowDiagnosticContext(win, webContents)).not.toThrow()
      expect(windowCapture.getWindowDiagnosticContext(win)).toMatchObject({
        browserWindowId: 81,
        rendererProcessId: null,
        url: '',
        windowState: { bounds: null }
      })
      if (flushOnDestroyed) {
        expect(() => webContents.emit('destroyed')).not.toThrow()
        expect(() =>
          webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
        ).not.toThrow()
      }
      await new Promise((resolve) => setTimeout(resolve, 1300))
      const result = await logging.queryLogs({ search: marker, limit: 10 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        scope: 'renderer.console',
        message: marker,
        windowRole: 'closing-window',
        webContentsId: 82,
        metadata: { browserWindowId: 81, windowState: { bounds: null } }
      })
      if (flushOnDestroyed) {
        const exits = await logging.queryLogs({ search: '渲染进程已退出：clean-exit', limit: 20 })
        expect(exits.items).toContainEqual(
          expect.objectContaining({
            scope: 'renderer.render-process-gone',
            webContentsId: 82,
            metadata: expect.objectContaining({
              browserWindowId: 81,
              reason: 'clean-exit',
              exitCode: 0
            })
          })
        )
      }
    })
  }

  it('collects a degraded context when an unattached destroyed window throws on property access', () => {
    const win = {}
    Object.defineProperties(win, {
      id: {
        get() {
          throw new TypeError('Object has been destroyed')
        }
      },
      webContents: {
        get() {
          throw new TypeError('Object has been destroyed')
        }
      }
    })
    expect(windowCapture.getWindowDiagnosticContext(win)).toMatchObject({
      browserWindowId: null,
      rendererProcessId: null,
      url: ''
    })
  })

  it('lists recent Crashpad dumps without reading their contents', async () => {
    const reports = join(testUserData, 'reports')
    mkdirSync(reports, { recursive: true })
    writeFileSync(join(reports, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.dmp'), Buffer.alloc(3))
    writeFileSync(join(reports, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.dmp'), Buffer.alloc(7))
    writeFileSync(join(reports, 'ignored.txt'), 'not a dump')

    await processCapture.refreshCrashDumpIndex()
    expect(processCapture.getRecentCrashDumps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.dmp', size: 3 }),
        expect.objectContaining({ name: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.dmp', size: 7 })
      ])
    )
    expect(processCapture.getRecentCrashDumps().some((item) => item.name === 'ignored.txt')).toBe(
      false
    )
  })

  it('suppresses only Vite development transport noise from renderer console capture', async () => {
    const previousRendererUrl = process.env.ELECTRON_RENDERER_URL
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    const marker = `vite-console-${Date.now()}`
    const webContents = new EventEmitter()
    webContents.id = 74
    const win = new EventEmitter()
    win.webContents = webContents
    win.isDestroyed = () => false

    try {
      windowCapture.setWindowLogContext(win, { role: 'sticky' })
      windowCapture.attachWindowLogging(win)
      webContents.emit('console-message', {
        level: 'info',
        message: `[vite] hot updated: /${marker}.vue`,
        lineNumber: 1,
        sourceId: 'http://localhost:5173/@vite/client'
      })
      webContents.emit('console-message', {
        level: 'error',
        message: `Connecting to 'ws://localhost:5173/?token=${marker}' violates the following Content Security Policy directive: "connect-src 'none'". The action has been blocked.`,
        lineNumber: 2,
        sourceId: 'http://localhost:5173/@vite/client'
      })
      webContents.emit('console-message', {
        level: 'error',
        message: `应用错误 ${marker}`,
        lineNumber: 3,
        sourceId: 'http://localhost:5173/@vite/client'
      })
      webContents.emit('console-message', {
        level: 'error',
        message: `[vite] connection failed ${marker}`,
        lineNumber: 4,
        sourceId: 'http://localhost:5173/@vite/client'
      })

      await new Promise((resolve) => setTimeout(resolve, 1300))
      const result = await logging.queryLogs({ search: marker, limit: 10 })
      const messages = result.items.map((item) => item.message)
      expect(messages).toHaveLength(2)
      expect(messages).toEqual(
        expect.arrayContaining([`应用错误 ${marker}`, `[vite] connection failed ${marker}`])
      )
    } finally {
      if (previousRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
      else process.env.ELECTRON_RENDERER_URL = previousRendererUrl
    }
  })

  it('returns the registered role for structured renderer logs', () => {
    const webContents = new EventEmitter()
    const win = new EventEmitter()
    win.webContents = webContents
    win.isDestroyed = () => false

    windowCapture.setWindowLogContext(win, { role: 'sticky', noteId: 42 })

    expect(windowCapture.getWindowLogContext(win)).toEqual({ role: 'sticky', noteId: 42 })
  })

  it('treats a closed console pipe as an unavailable optional log sink', () => {
    const stream = new EventEmitter()
    stream.writable = true
    stream.writableEnded = false
    stream.destroyed = false

    expect(logging.loggingInternals.installConsoleStreamGuard(stream)).toBe(true)
    expect(logging.loggingInternals.isConsoleStreamAvailable(stream)).toBe(true)
    expect(() => {
      stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    }).not.toThrow()
    expect(logging.loggingInternals.isConsoleStreamAvailable(stream)).toBe(false)
    expect(logging.loggingInternals.installConsoleStreamGuard(stream)).toBe(false)
  })

  it('keeps callers running when log storage is unavailable and writes again after recovery', async () => {
    await logging.flushLogs()
    drainOperationPerformance()
    const directory = logging.getLogDirectory()
    const backup = join(testUserData, 'logs-storage-failure-backup')
    renameSync(directory, backup)
    writeFileSync(directory, 'test-owned file blocks the log directory')
    try {
      expect(() => {
        logging.logger.error('storage-failure-fixture', new Error('expected storage failure'))
      }).not.toThrow()
      await logging.flushLogs()
      const flush = drainOperationPerformance().entries.find((entry) => entry.operation === 'flush')
      expect(flush.metrics.errors.total).toBeGreaterThan(0)
      expect(flush.metrics.droppedRecords.total).toBeGreaterThan(0)
    } finally {
      rmSync(directory)
      renameSync(backup, directory)
    }
    const marker = 'logging-storage-recovered'
    logging.logger.info('storage-recovery-fixture', marker)
    await logging.flushLogs()
    const records = await logging.queryLogs({ search: marker, limit: 10 })
    expect(records.items.some((record) => record.message === marker)).toBe(true)
  })

  it('does not install an unhandledRejection listener that changes Node fatal behavior', async () => {
    const beforeUnhandled = process.listeners('unhandledRejection')
    const beforeMonitor = new Set(process.listeners('uncaughtExceptionMonitor'))
    const beforeWarning = new Set(process.listeners('warning'))
    const { installProcessCapture } = await import('../src/main/logging/process-capture.js')

    installProcessCapture()

    expect(process.listeners('unhandledRejection')).toEqual(beforeUnhandled)
    for (const listener of process.listeners('uncaughtExceptionMonitor')) {
      if (!beforeMonitor.has(listener)) process.removeListener('uncaughtExceptionMonitor', listener)
    }
    for (const listener of process.listeners('warning')) {
      if (!beforeWarning.has(listener)) process.removeListener('warning', listener)
    }
  })

  it('returns one shared close with the normalized flush and actual writer termination result', async () => {
    const closing = logging.closeLogs()
    expect(logging.closeLogs()).toBe(closing)
    const result = await closing
    expect(result.writer.termination).toMatchObject({ confirmed: true, outcome: 'completed' })
    expect(result.writer.termination.exitCode).toEqual(expect.any(Number))
    // The earlier controlled storage failure remains part of this logging session.
    expect(result.flush.incomplete).toBe(true)
    expect(result.outcome).toBe('degraded')
    expect(result.incomplete).toBe(true)
    expect(logging.getLoggingHealth().shutdown).toEqual(result)
  })
})

function completedLogClose(outcome = 'completed') {
  const flush = { status: 'ready', incomplete: outcome !== 'completed', queuedBytes: 0 }
  return {
    outcome,
    flush,
    writer: {
      outcome,
      incomplete: flush.incomplete,
      flush,
      termination: { requested: true, confirmed: true, outcome: 'completed', exitCode: 1 }
    }
  }
}

function logBarrierFixture(overrides = {}) {
  vi.useFakeTimers()
  const app = new EventEmitter()
  app.exit = vi.fn()
  const close = vi.fn(async () => completedLogClose())
  const save = vi.fn()
  const observe = vi.fn()
  const barrier = logging.loggingInternals.installFinalLogBarrier({
    app,
    close,
    save,
    identity: { sessionId: 'controlled-logging-close', pid: 1234 },
    getExitCode: () => 0,
    getProgress: () => ({ status: 'closing', pendingRecords: 2 }),
    onResult: observe,
    ...overrides
  })
  const event = () => {
    const value = { preventDefault: vi.fn() }
    app.emit('will-quit', value)
    return value
  }
  return { app, close, save, observe, barrier, event }
}

describe('final logging quit barrier', () => {
  afterEach(() => vi.useRealTimers())

  it('prevents every reentrant quit event while sharing one close, observation and exit', async () => {
    let release
    const close = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const state = logBarrierFixture({ close })
    const first = state.event(),
      second = state.event()
    await vi.advanceTimersByTimeAsync(0)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(state.app.exit).not.toHaveBeenCalled()
    release(completedLogClose())
    const result = await state.barrier.settled()
    expect(result).toMatchObject({
      schemaVersion: 1,
      sessionId: 'controlled-logging-close',
      pid: 1234,
      outcome: 'completed',
      flush: { incomplete: false },
      reportError: null,
      exitCode: 0
    })
    expect(state.save).toHaveBeenCalledExactlyOnceWith(result)
    expect(state.observe).toHaveBeenCalledExactlyOnceWith(result)
    expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(0)
    const third = state.event()
    expect(third.preventDefault).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2000)
    expect(close).toHaveBeenCalledOnce()
    expect(state.app.exit).toHaveBeenCalledOnce()
  })

  it.each([0, 7])(
    'preserves exit code %i for a degraded flush whose worker termination is confirmed',
    async (exitCode) => {
      const state = logBarrierFixture({
        getExitCode: () => exitCode,
        close: async () => completedLogClose('degraded')
      })
      state.event()
      await vi.advanceTimersByTimeAsync(0)
      const result = await state.barrier.settled()
      expect(result).toMatchObject({ outcome: 'degraded', flush: { incomplete: true }, exitCode })
      expect(result.writer.termination).toMatchObject({ confirmed: true, exitCode: 1 })
      expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(exitCode)
    }
  )

  it('saves a close rejection and still exits through the same final path', async () => {
    const state = logBarrierFixture({
      close: async () => {
        throw Object.assign(new Error('terminate rejected'), { code: 'CONTROLLED' })
      }
    })
    state.event()
    await vi.advanceTimersByTimeAsync(0)
    const result = await state.barrier.settled()
    expect(result).toMatchObject({
      outcome: 'failed',
      writer: null,
      exitCode: 1,
      error: { message: 'terminate rejected', code: 'CONTROLLED' },
      flush: { incomplete: true, reason: 'close-rejected' }
    })
    expect(state.save).toHaveBeenCalledExactlyOnceWith(result)
    expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('does not wait forever for an unknown close and ignores its later successful result', async () => {
    let release
    const state = logBarrierFixture({
      timeoutMs: 2000,
      close: () =>
        new Promise((resolve) => {
          release = resolve
        })
    })
    state.event()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await state.barrier.settled()
    expect(result).toMatchObject({
      outcome: 'timed-out',
      exitCode: 1,
      writer: {
        termination: { requested: null, confirmed: false, outcome: 'timed-out' },
        progress: { pendingRecords: 2 }
      }
    })
    const saved = JSON.stringify(result)
    release(completedLogClose())
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.stringify(state.barrier.snapshot())).toBe(saved)
    expect(state.save).toHaveBeenCalledOnce()
    expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('retains the real flush timeout and confirmed termination at the full combined budget', async () => {
    let writer
    let writerResult
    let terminationStartedAt
    let terminationResolvedAt
    const close = vi.fn(async () => {
      writerResult = await writer.close(1000, { terminateTimeoutMs: 1000 })
      return {
        outcome: writerResult.outcome,
        incomplete: writerResult.incomplete,
        flush: writerResult.flush,
        writer: writerResult
      }
    })
    // Keep the barrier's production default: an earlier outer watchdog must not
    // replace a complete writer result with unknown termination at this edge.
    const state = logBarrierFixture({ close, getProgress: () => writer.snapshot() })
    const startedAt = Date.now()
    const worker = new EventEmitter()
    worker.ref = () => {}
    worker.unref = () => {}
    worker.postMessage = vi.fn()
    worker.terminate = vi.fn(
      () =>
        new Promise((resolve) => {
          terminationStartedAt = Date.now()
          setTimeout(() => {
            terminationResolvedAt = Date.now()
            resolve(1)
          }, 1000)
        })
    )
    writer = createLogWriterClient({
      directory: 'unused',
      workerFile: 'unused',
      createWorker: () => worker
    })
    worker.emit('message', { ready: true })
    expect(writer.enqueue({ id: 'unacknowledged-at-quit', message: 'pending' }, 3)).toBe(true)
    expect(worker.postMessage).toHaveBeenCalledOnce()
    expect(worker.postMessage.mock.calls[0][0].operation).toBe('append')
    // No append acknowledgement: preserve the original flush-timeout result.
    state.event()
    await vi.advanceTimersByTimeAsync(0)
    expect(close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(999)
    expect(worker.terminate).not.toHaveBeenCalled()
    expect(state.app.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(terminationStartedAt - startedAt).toBe(1000)
    await vi.advanceTimersByTimeAsync(999)
    expect(state.app.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(terminationResolvedAt - terminationStartedAt).toBe(1000)
    expect(writerResult).toMatchObject({
      outcome: 'timed-out',
      incomplete: true,
      flush: { incomplete: true, reason: 'flush-timeout', pendingRecords: 1 },
      termination: { requested: true, outcome: 'completed', confirmed: true, exitCode: 1 }
    })
    const result = await state.barrier.settled()
    expect(result).toMatchObject({
      outcome: 'timed-out',
      flush: { incomplete: true, reason: 'flush-timeout', pendingRecords: 1 },
      writer: {
        outcome: 'timed-out',
        termination: { requested: true, outcome: 'completed', confirmed: true, exitCode: 1 }
      },
      exitCode: 1
    })
    expect(state.save).toHaveBeenCalledExactlyOnceWith(result)
    expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('never reports unknown termination as success even if its caller returned completed', async () => {
    const unknown = completedLogClose()
    unknown.writer.termination.confirmed = false
    unknown.writer.termination.outcome = 'timed-out'
    const state = logBarrierFixture({ close: async () => unknown })
    state.event()
    await vi.advanceTimersByTimeAsync(0)
    expect(await state.barrier.settled()).toMatchObject({ outcome: 'timed-out', exitCode: 1 })
    expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('retains an observation failure without waiting for the failed log sink or skipping exit', async () => {
    const state = logBarrierFixture({
      save: () => {
        throw Object.assign(new Error('shutdown-logging EACCES'), { code: 'EACCES' })
      }
    })
    state.event()
    await vi.advanceTimersByTimeAsync(0)
    const result = await state.barrier.settled()
    expect(result).toMatchObject({
      outcome: 'failed',
      exitCode: 1,
      writer: { termination: { confirmed: true } },
      reportError: { message: 'shutdown-logging EACCES', code: 'EACCES' }
    })
    expect(state.observe).toHaveBeenCalledExactlyOnceWith(result)
    expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
  })
})
