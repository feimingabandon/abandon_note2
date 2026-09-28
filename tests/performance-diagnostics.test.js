import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { startPerformanceDiagnostics } from '../src/main/logging/performance-diagnostics.js'
import { createPerformanceAggregates } from '../src/shared/performance-aggregates.js'
import { deepPolicy } from './helpers/diagnostic-mode-fixture.js'
import {
  traceViewRefresh,
  createRefreshCauses
} from '../src/renderer/src/utils/diagnosticEvidence.js'
import {
  installRendererPerformanceDiagnostics,
  flushRendererPerformanceDiagnostics,
  measureRendererLayout,
  recordRefreshDataApplied
} from '../src/renderer/src/utils/performanceDiagnostics.js'

function rendererFixture({ unsupported = false, failObserver = false, mode = 'deep' } = {}) {
  let time = 100
  let nextId = 0
  const frames = new Map()
  const timers = new Map()
  const docEvents = new Map()
  const windowEvents = new Map()
  const register = (map) => (name, callback) => map.set(name, callback)
  const remove = (map) => (name) => map.delete(name)
  const doc = {
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: vi.fn(register(docEvents)),
    removeEventListener: remove(docEvents)
  }
  const win = {
    location: { pathname: '/month.html' },
    requestAnimationFrame: vi.fn((callback) => {
      frames.set(++nextId, callback)
      return nextId
    }),
    cancelAnimationFrame: (id) => frames.delete(id),
    setInterval: (callback) => {
      timers.set(++nextId, callback)
      return nextId
    },
    clearInterval: (id) => timers.delete(id),
    addEventListener: register(windowEvents),
    removeEventListener: remove(windowEvents)
  }
  let longTaskCallback
  let queuedTasks = []
  const disconnect = vi.fn()
  class Observer {
    static supportedEntryTypes = unsupported ? [] : ['longtask']
    constructor(callback) {
      longTaskCallback = callback
    }
    observe() {
      if (failObserver) throw new Error('unsupported')
    }
    takeRecords() {
      const result = queuedTasks
      queuedTasks = []
      return result
    }
    disconnect = disconnect
  }
  const reportLog = vi.fn()
  const policyListeners = new Set()
  const api = {
    reportLog,
    getDiagnosticPolicy: () =>
      mode === 'deep' ? deepPolicy() : { mode: 'daily', policyEpoch: 0, sampleIntervalMs: 30000 },
    onDiagnosticPolicy: (callback) => {
      policyListeners.add(callback)
      return () => policyListeners.delete(callback)
    }
  }
  win.api = api
  const environment = {
    window: win,
    document: doc,
    PerformanceObserver: Observer,
    performance: { now: () => time, timeOrigin: 1790550000000 }
  }
  const monitor = installRendererPerformanceDiagnostics(api, environment)
  return {
    win,
    doc,
    api,
    environment,
    frames,
    timers,
    monitor,
    changeMode: (mode) =>
      policyListeners.forEach((fn) =>
        fn(
          mode === 'deep'
            ? deepPolicy()
            : { mode: 'daily', policyEpoch: 2, sampleIntervalMs: 30000 }
        )
      ),
    disconnect,
    reportLog,
    advance: (ms) => {
      time += ms
    },
    event: (name, props = {}) => docEvents.get(name)?.({ type: name, timeStamp: time, ...props }),
    frame: (ms = 20) => {
      time += ms
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback(time))
    },
    interval: () => [...timers.values()].forEach((callback) => callback()),
    longTask: (duration) => longTaskCallback({ getEntries: () => [{ startTime: time, duration }] }),
    queueLongTask: (duration) => queuedTasks.push({ startTime: time, duration }),
    records: () =>
      reportLog.mock.calls
        .map(([record]) => record)
        .filter((r) => r.scope === 'performance.renderer')
  }
}

describe('renderer performance diagnostics', () => {
  it('uses at most one frame probe per second without DOM scans daily and cancels deep frames on stop', () => {
    const f = rendererFixture({ mode: 'daily' })
    f.doc.querySelectorAll = vi.fn()
    f.event('wheel')
    f.frame()
    for (let i = 0; i < 100; i++) f.event('wheel')
    expect(f.frames.size).toBe(0)
    expect(f.win.requestAnimationFrame).toHaveBeenCalledTimes(1)
    recordRefreshDataApplied('list', f.win)
    f.monitor.flush()
    expect(f.doc.querySelectorAll).not.toHaveBeenCalled()
    f.changeMode('deep')
    f.event('wheel')
    f.frame()
    expect(f.frames.size).toBe(1)
    f.changeMode('daily')
    expect(f.frames.size).toBe(0)
    expect(f.timers.size).toBe(1)
    f.monitor.dispose()
    expect(f.timers.size).toBe(0)
  })
  it('observes input passively, aggregates slow frames and never reads user content', () => {
    const f = rendererFixture()
    expect(f.frames.size).toBe(0)
    const target = {
      get textContent() {
        throw new Error('must not inspect content')
      }
    }
    const preventDefault = vi.fn()
    for (let i = 0; i < 100; i++) f.event('wheel', { target, preventDefault, timeStamp: 1 })
    expect(f.frames.size).toBe(1)
    f.frame(20)
    f.frame(180)
    f.event('scroll', { target })
    f.longTask(170)
    expect(f.records()).toHaveLength(0)
    f.interval()
    const record = f.records()[0]
    expect(record.level).toBe('warn')
    expect(record.metadata).toMatchObject({
      wheelEvents: 100,
      scrollEvents: 1,
      frameIntervals: { count: 1, maxMs: 180, over100ms: 1 },
      inputDelay: { count: 100, maxMs: 99 },
      longTasks: { count: 1, maxMs: 170 }
    })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(f.doc.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), {
      passive: true,
      capture: true
    })
    expect(JSON.stringify(record)).not.toContain('textContent')
    f.monitor.dispose()
  })

  it('stops frame sampling when idle and ignores hidden-window time', () => {
    const f = rendererFixture()
    f.event('wheel')
    f.frame()
    f.doc.visibilityState = 'hidden'
    f.event('visibilitychange')
    expect(f.frames.size).toBe(0)
    f.advance(60000)
    f.event('wheel')
    f.longTask(30000)
    f.interval()
    expect(f.records()).toHaveLength(1)
    f.doc.visibilityState = 'visible'
    f.event('visibilitychange')
    f.event('wheel')
    for (let i = 0; i < 80; i++) f.frame()
    expect(f.frames.size).toBe(0)
    f.interval()
    expect(f.records().at(-1).metadata.frameIntervals.maxMs).toBe(20)
    f.monitor.dispose()
  })

  it('keeps unexplained long gaps separate from slow frames and resets the batch after export', () => {
    const f = rendererFixture()
    f.event('wheel')
    f.frame()
    f.frame(60000)
    f.queueLongTask(90)
    flushRendererPerformanceDiagnostics('export', f.win)
    const record = f.records()[0]
    expect(record.level).toBe('info')
    expect(record.metadata).toMatchObject({
      reason: 'export',
      samplingGaps: 1,
      maxSamplingGapMs: 60000,
      interrupted: true,
      frameIntervals: { count: 0 },
      longTasks: { count: 1 }
    })
    f.interval()
    expect(f.records()).toHaveLength(1)
    f.monitor.dispose()
  })

  it('installs once, tolerates missing observers and tears down listeners and timers', () => {
    for (const options of [{ unsupported: true }, { failObserver: true }]) {
      const f = rendererFixture(options)
      expect(installRendererPerformanceDiagnostics(f.api, f.environment)).toBe(f.monitor)
      expect(f.timers.size).toBe(1)
      f.event('wheel')
      f.monitor.dispose()
      expect(f.frames.size).toBe(0)
      expect(f.timers.size).toBe(0)
      f.event('wheel')
      expect(f.frames.size).toBe(0)
      expect(f.reportLog.mock.calls[0][0].metadata.longTaskObserver).toBe(
        options.unsupported ? 'unsupported' : 'unavailable'
      )
    }
  })

  it('does not propagate a reporting failure into input or export', () => {
    const f = rendererFixture()
    f.reportLog.mockImplementation(() => {
      throw new Error('IPC unavailable')
    })
    f.event('wheel')
    f.frame(200)
    expect(() => flushRendererPerformanceDiagnostics('export', f.win)).not.toThrow()
    f.monitor.dispose()
  })
})

function mainFixture(options = {}) {
  let time = 0
  let cpu = 10
  let pid = 1
  let creationTime = 1
  let anchorApplyCount = 2
  let tick
  const app = new EventEmitter()
  app.getAppMetrics = vi.fn(() => [
    {
      pid,
      creationTime,
      type: 'GPU',
      cpu: { cumulativeCPUUsage: cpu, percentCPUUsage: 999 },
      memory: { workingSetSize: 1024, privateBytes: 768 }
    }
  ])
  const powerMonitor = new EventEmitter()
  const window = { id: 10, visible: true, minimized: false, zOrderMode: 'normal' }
  const readNativeState = vi.fn(() => ({ enabled: false, anchorApplyCount, syncRequestCount: 10 }))
  const writeLog = vi.fn()
  const clearTimer = vi.fn()
  const monitor = startPerformanceDiagnostics({
    app,
    powerMonitor,
    readWindowState: () => ({ ...window }),
    readNativeState,
    writeLog,
    state: { get: deepPolicy, subscribe: () => () => {} },
    now: () => time,
    wallNow: () => 1790550000000 + time,
    setTimer: (callback) => {
      tick = callback
      return { unref() {} }
    },
    clearTimer,
    ...options
  })
  return {
    app,
    powerMonitor,
    window,
    readNativeState,
    writeLog,
    monitor,
    clearTimer,
    tick: (ms = 1000) => {
      time += ms
      tick()
    },
    setCpu: (value) => {
      cpu = value
    },
    replacePid: () => {
      pid++
      creationTime++
    },
    applyNative: () => {
      anchorApplyCount++
    },
    records: () =>
      writeLog.mock.calls.map(([record]) => record).filter((r) => r.scope === 'performance.main')
  }
}

describe('renderer work attribution', () => {
  it('distinguishes superseded updates from applied data and schedules no frame for them', async () => {
    const f = rendererFixture()
    vi.stubGlobal('window', f.win)
    try {
      let currentChecks = 0
      await traceViewRefresh(
        'week',
        {},
        async () => ({ status: 'success' }),
        () => ({ count: 5 }),
        () => ++currentChecks === 1
      )
      f.interval()
      const record = f.reportLog.mock.calls
        .map(([value]) => value)
        .find((value) => value.scope === 'performance.render-work')
      expect(
        record.metadata.entries.some((entry) => entry.operation === 'refresh.superseded.week')
      ).toBe(true)
      expect(
        record.metadata.entries.some((entry) => entry.operation === 'refresh.applied.week')
      ).toBe(false)
      expect(f.frames.size).toBe(0)
    } finally {
      f.monitor.dispose()
      vi.unstubAllGlobals()
    }
  })
  it('aggregates refreshes and layout work, snapshots only structural counts and does not await a paint', async () => {
    const f = rendererFixture()
    f.doc.querySelectorAll = vi.fn((selector) => ({ length: selector === '.nl-card' ? 9 : 12 }))
    f.doc.images = [{}, {}]
    vi.stubGlobal('window', f.win)
    try {
      const causes = createRefreshCauses('list')
      causes.add({ reason: 'private-reason-not-in-performance' })
      causes.add({})
      causes.defer('status-transition')
      causes.take()
      for (let i = 0; i < 100; i++)
        measureRendererLayout('layout.note-card-overflow', () => f.advance(1))
      expect(f.doc.querySelectorAll).not.toHaveBeenCalled()
      await traceViewRefresh(
        'list',
        {},
        async () => {
          f.advance(120)
          return { status: 'success' }
        },
        () => ({ count: 9 })
      )
      expect(f.frames.size).toBe(1)
      recordRefreshDataApplied('list', f.win)
      f.frame(22)
      f.interval()
      const records = f.reportLog.mock.calls
        .map(([record]) => record)
        .filter((record) => record.scope === 'performance.render-work')
      expect(records).toHaveLength(1)
      const { entries, dom } = records[0].metadata
      expect(dom).toEqual({ noteCards: 9, calendarSegments: 12, images: 2 })
      expect(
        entries.find((entry) => entry.operation === 'layout.note-card-overflow')
      ).toMatchObject({ count: 100, totalMs: 100 })
      expect(entries.find((entry) => entry.operation === 'refresh.work.list').maxMs).toBe(120)
      expect(entries.find((entry) => entry.operation === 'refresh.next-frame.list')).toMatchObject({
        maxMs: 22,
        metrics: { coalesced: { total: 1 } }
      })
      expect(entries.find((entry) => entry.operation === 'refresh.queued.list')).toMatchObject({
        count: 2,
        metrics: { coalesced: { total: 1 } }
      })
      expect(JSON.stringify(records)).not.toContain('private-reason')
    } finally {
      f.monitor.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('cancels pending refresh frames on hiding and exports the interruption', () => {
    const f = rendererFixture()
    recordRefreshDataApplied('month', f.win)
    f.advance(20)
    f.doc.visibilityState = 'hidden'
    f.event('visibilitychange')
    expect(f.frames.size).toBe(0)
    const record = f.reportLog.mock.calls
      .map(([value]) => value)
      .find((value) => value.scope === 'performance.render-work')
    expect(record.metadata.entries[0]).toMatchObject({
      active: 0,
      metrics: { interrupted: { total: 1 } }
    })
    f.monitor.dispose()
  })
})

describe('main performance diagnostics', () => {
  it('keeps a valid CPU baseline across normal 30-second daily samples', () => {
    const f = mainFixture({
      state: { get: () => ({ mode: 'daily', sampleIntervalMs: 30000 }), subscribe: () => () => {} }
    })
    f.tick()
    f.setCpu(10.3)
    for (let i = 0; i < 29; i++) f.tick()
    expect(f.app.getAppMetrics).toHaveBeenCalledTimes(1)
    f.tick()
    expect(f.app.getAppMetrics).toHaveBeenCalledTimes(2)
    expect(f.records().at(-1).metadata.processes[0].cpuPercentOneCore).toBe(1)
    f.monitor.stop()
  })
  it('flushes operation evidence even inside the resource sampling limit and bounds export history', () => {
    const aggregates = createPerformanceAggregates()
    const f = mainFixture({ drainOperations: () => aggregates.drain() })
    f.tick()
    const before = f.app.getAppMetrics.mock.calls.length
    for (let i = 0; i < 10; i++) {
      aggregates.record('database', 'read', 150, { resultRows: 3 })
      f.monitor.flush()
    }
    expect(f.app.getAppMetrics.mock.calls.length).toBe(before)
    expect(f.monitor.snapshot().recentOperations).toHaveLength(3)
    expect(
      f.writeLog.mock.calls.filter(([record]) => record.scope === 'performance.operations')
    ).toHaveLength(10)
    f.monitor.stop()
  })
  it('samples CPU deltas and real native counters, limits activity writes and retains bounded history', () => {
    const f = mainFixture()
    f.tick()
    expect(f.records()[0].metadata.processes[0].cpuPercentOneCore).toBeNull()
    f.setCpu(12.5)
    f.applyNative()
    for (let i = 0; i < 100; i++) f.monitor.observeRenderer({ scope: 'performance.renderer' }, 7)
    for (let i = 0; i < 5; i++) f.tick()
    expect(f.app.getAppMetrics).toHaveBeenCalledTimes(2)
    expect(f.records()).toHaveLength(2)
    expect(f.records()[1].metadata).toMatchObject({
      sampleDurationMs: 5000,
      processes: [{ cpuPercentOneCore: 50, workingSetKiB: 1024 }],
      nativeZOrder: { enabled: false },
      nativeCounterDelta: { anchorApplyCount: 1 },
      lastRendererReport: { webContentsId: 7 }
    })
    for (let i = 0; i < 100; i++) f.tick()
    expect(f.monitor.snapshot().recentSamples).toHaveLength(12)
    expect(f.records().length).toBeLessThan(8)
    f.monitor.stop()
  })

  it('reports a main-thread stall but resets baselines across sleep and process replacement', () => {
    const f = mainFixture()
    f.tick()
    f.tick(6000)
    expect(f.records().at(-1)).toMatchObject({
      level: 'warn',
      metadata: { mainLoopDelay: { maxMs: 5000 } }
    })
    f.powerMonitor.emit('suspend')
    f.tick(60000)
    f.powerMonitor.emit('resume')
    f.replacePid()
    f.setCpu(0.1)
    f.tick()
    const resumed = f.monitor.snapshot().recentSamples.at(-1)
    expect(resumed.processes[0].cpuPercentOneCore).toBeNull()
    expect(resumed.mainLoopDelay.maxMs).toBe(0)
    f.tick(60000)
    expect(f.writeLog.mock.calls.some(([r]) => r.scope === 'performance.observation-gap')).toBe(
      true
    )
    expect(f.monitor.snapshot().recentSamples.at(-1).mainLoopDelay.maxMs).toBe(0)
    f.monitor.stop()
  })

  it('does not sample hidden windows or locked sessions and removes lifecycle listeners', () => {
    const f = mainFixture()
    f.window.visible = false
    for (let i = 0; i < 12; i++) f.tick()
    expect(f.app.getAppMetrics).not.toHaveBeenCalled()
    expect(f.readNativeState).not.toHaveBeenCalled()
    f.window.visible = true
    f.powerMonitor.emit('lock-screen')
    f.tick(30000)
    expect(f.app.getAppMetrics).not.toHaveBeenCalled()
    f.powerMonitor.emit('unlock-screen')
    f.tick()
    expect(f.app.getAppMetrics).toHaveBeenCalledTimes(1)
    f.app.emit('will-quit')
    expect(f.clearTimer).toHaveBeenCalledTimes(1)
    expect(f.powerMonitor.listenerCount('resume')).toBe(0)
    f.tick(5000)
    expect(f.app.getAppMetrics).toHaveBeenCalledTimes(1)
  })

  it('keeps exports usable when resource and native collection fail', () => {
    const f = mainFixture()
    f.app.getAppMetrics.mockImplementation(() => {
      throw new Error('process unavailable')
    })
    f.readNativeState.mockImplementation(() => {
      throw new Error('native unavailable')
    })
    expect(() => f.monitor.flush()).not.toThrow()
    expect(f.monitor.snapshot().recentSamples[0]).toMatchObject({
      processes: null,
      nativeZOrder: null,
      collectionErrors: [{ field: 'processes' }, { field: 'nativeZOrder' }]
    })
    f.writeLog.mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => f.tick(5000)).not.toThrow()
    f.monitor.stop()
  })
})
