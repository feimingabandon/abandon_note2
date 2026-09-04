import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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

afterAll(() => {
  if (logging) {
    logging.flushLogs()
    process.removeListener('exit', logging.flushLogs)
  }
  rmSync(testUserData, { recursive: true, force: true })
  delete process.env.ABANDON_NOTE_LOG_TEST_USER_DATA
})

describe('main-process logging', () => {
  it('keeps the complete encoded JSONL record within the hard byte limit', () => {
    const line = logging.loggingInternals.createBoundedLine({
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

    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(512 * 1024)
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
    logging.flushLogs()

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
    logging.flushLogs()
    const [source] = logging.getLogFiles()

    await expect(logging.exportLogs(source.path)).rejects.toThrow('导出目标不能覆盖现有日志文件')
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

  it('lists recent Crashpad dumps without reading their contents', () => {
    const reports = join(testUserData, 'reports')
    mkdirSync(reports, { recursive: true })
    writeFileSync(join(reports, 'older.dmp'), Buffer.alloc(3))
    writeFileSync(join(reports, 'newer.dmp'), Buffer.alloc(7))
    writeFileSync(join(reports, 'ignored.txt'), 'not a dump')

    expect(processCapture.getRecentCrashDumps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'older.dmp', size: 3 }),
        expect.objectContaining({ name: 'newer.dmp', size: 7 })
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
})
