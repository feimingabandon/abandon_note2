import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
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

beforeAll(async () => {
  logging = await import('../src/main/logging/logger.js')
  windowCapture = await import('../src/main/logging/window-capture.js')
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
    win.webContents = webContents
    win.isDestroyed = () => false

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
        sourceId: 'SettingsPanel.vue'
      }
    })
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
