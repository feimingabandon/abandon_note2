import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPerformanceAggregates } from '../src/shared/performance-aggregates.js'
import {
  drainOperationPerformance,
  measureSyncPerformance
} from '../src/main/logging/operation-performance.js'
import { Scheduler } from '../src/main/services/scheduler.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { queryRecentNotes } from '../src/main/db/db-notes.js'
import { diagnosticState } from '../src/main/logging/diagnostic-state.js'

const { handlers, log } = vi.hoisted(() => ({ handlers: new Map(), log: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  BrowserWindow: { fromWebContents: () => null }
}))
vi.mock('../src/main/logging/logger.js', () => ({
  writeLog: log,
  logger: { warn: log, error: log }
}))
import { ipcMain } from '../src/main/logging/ipc-main.js'

let time = 0
beforeEach(() => {
  time = 0
  vi.stubGlobal('performance', { now: () => time })
  diagnosticState.start()
  drainOperationPerformance()
  handlers.clear()
  log.mockClear()
})
afterEach(() => {
  diagnosticState.stop()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearDb()
})
const event = { sender: { id: 7, getURL: () => 'test.html' } }

describe('bounded performance attribution', () => {
  it('aggregates frequent sub-second operations without storing private values', () => {
    const aggregate = createPerformanceAggregates({ now: () => time, wallNow: () => 10000 + time })
    for (let i = 0; i < 100; i++) {
      const finish = aggregate.begin('database', 'notes.query')
      time += 80
      finish({ resultRows: 3, content: 'private-note', path: 'C:/private-image.png', bytes: NaN })
    }
    const result = aggregate.drain()
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      count: 100,
      totalMs: 8000,
      maxMs: 80,
      over50ms: 100,
      over100ms: 0,
      active: 0,
      peakActive: 1,
      metrics: { resultRows: { total: 300, max: 3 } }
    })
    expect(JSON.stringify(result)).not.toMatch(/private|content|bytes|path/)
    expect(aggregate.drain().entries).toEqual([])
  })

  it('keeps in-flight operations across exports, finalizes once and bounds cardinality', () => {
    const aggregate = createPerformanceAggregates({ now: () => time, maxEntries: 2 })
    const finish = aggregate.begin('ipc', 'notes:query-recent')
    time = 30
    expect(aggregate.drain().entries[0]).toMatchObject({ started: 1, count: 0, active: 1 })
    aggregate.record('image', 'decode', 90)
    for (let i = 0; i < 1000; i++) aggregate.record('image', `other-${i}`, 1)
    time = 180
    finish()
    finish()
    const result = aggregate.drain()
    expect(result.entries).toHaveLength(2)
    expect(result.omitted).toBe(1000)
    expect(result.entries[0]).toMatchObject({ count: 1, active: 0, maxMs: 180 })
  })

  it('preserves results and exceptions when observation fails', () => {
    const value = { content: 'private' }
    expect(
      measureSyncPerformance(
        'database',
        'result',
        () => value,
        () => {
          throw new Error('broken observer')
        }
      )
    ).toBe(value)
    const failure = new Error('original failure')
    expect(() =>
      measureSyncPerformance(
        'database',
        'failure',
        () => {
          throw failure
        },
        null,
        () => {
          throw new Error('broken error observer')
        }
      )
    ).toThrow(failure)
    const aggregate = createPerformanceAggregates({
      now: () => {
        throw failure
      }
    })
    expect(() => aggregate.begin('test', 'broken-clock')()).not.toThrow()
  })

  it('separates handler synchronous work from asynchronous elapsed time and counts concurrency', async () => {
    const releases = []
    ipcMain.handle('notes:query-recent', () => {
      time += 70
      return new Promise((resolve) => releases.push(resolve))
    })
    const first = handlers.get('notes:query-recent')(event)
    const second = handlers.get('notes:query-recent')(event)
    const inFlight = drainOperationPerformance().entries.find((entry) => entry.category === 'ipc')
    expect(inFlight).toMatchObject({ active: 2, peakActive: 2, count: 0 })
    time += 300
    const value = [{ content: 'private-note' }]
    releases[0](value)
    releases[1](value)
    await expect(first).resolves.toBe(value)
    await expect(second).resolves.toBe(value)
    const result = drainOperationPerformance().entries.find((entry) => entry.category === 'ipc')
    expect(result).toMatchObject({
      count: 2,
      active: 0,
      maxMs: 440,
      metrics: {
        handlerSyncMs: { total: 140 },
        asyncRemainderMs: { total: 670 },
        resultRows: { total: 2 }
      }
    })
    expect(log).not.toHaveBeenCalled() // < 2 秒仍会进入内存统计，不逐次写入日志。
    expect(JSON.stringify(result)).not.toContain('private-note')
  })

  it('counts rejected and thrown IPC handlers while keeping diagnostic reads out of business totals', async () => {
    const failure = new Error('same error')
    ipcMain.handle('notes:query-custom-normal', () => {
      time += 120
      throw failure
    })
    expect(() => handlers.get('notes:query-custom-normal')(event)).toThrow(failure)
    ipcMain.handle('images:get-base64', () => Promise.reject(failure))
    await expect(handlers.get('images:get-base64')(event)).rejects.toBe(failure)
    ipcMain.handle('logs:query', () => [])
    handlers.get('logs:query')(event)
    const entries = drainOperationPerformance().entries.filter((entry) => entry.category === 'ipc')
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.active === 0 && entry.metrics.errors.total === 1)).toBe(
      true
    )
  })

  it('attributes successful slow scheduler callbacks and due task counts without console noise', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const scheduler = new Scheduler()
    scheduler.register({
      name: 'activationTask',
      shouldRun: () => {
        time += 60
        return true
      },
      execute: () => {
        time += 180
        return { performanceCounts: { activated: 7 } }
      }
    })
    scheduler.tick({ reason: 'resume' })
    const entries = drainOperationPerformance().entries
    expect(entries.find((entry) => entry.category === 'scheduler')).toMatchObject({
      operation: 'activationTask.resume',
      maxMs: 180,
      metrics: { activated: { total: 7 } }
    })
    expect(entries.find((entry) => entry.category === 'scheduler-check').maxMs).toBe(60)
    expect(spy).not.toHaveBeenCalled()
  })

  it('measures synchronous database reading and hydration without changing DTOs or logging SQL', () => {
    const rows = [{ id: 1, content: 'private-database-note' }]
    setDb({
      prepare: (sql) => ({
        all: () => {
          time += 80
          return sql.includes('SELECT n.*') ? rows : []
        }
      })
    })
    const result = queryRecentNotes({ cutoffTime: 0 })
    expect(result[0].content).toBe('private-database-note')
    const batch = drainOperationPerformance()
    expect(batch.entries.find((entry) => entry.operation === 'queryRecentNotes')).toMatchObject({
      maxMs: 240,
      metrics: { resultRows: { total: 1 } }
    })
    expect(batch.entries.find((entry) => entry.operation === 'toNoteListItems').maxMs).toBe(160)
    expect(JSON.stringify(batch)).not.toMatch(/SELECT|private-database-note/)
  })
})
