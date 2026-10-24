import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createApplicationBootstrap,
  settleStartupRecoveries
} from '../src/main/application/bootstrap.js'
import { createShutdownCoordinator } from '../src/main/application/shutdown-coordinator.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

afterEach(() => vi.useRealTimers())

async function drain() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

function shutdownFixture(overrides = {}) {
  let beforeQuit
  const event = { preventDefault: vi.fn() }
  const app = {
    on: vi.fn((_name, listener) => (beforeQuit = listener)),
    quit: vi.fn(() => beforeQuit(event)),
    exit: vi.fn()
  }
  const logger = { info: vi.fn(), error: vi.fn() }
  const onBegin = vi.fn()
  const order = []
  const runtime = createShutdownCoordinator({
    app,
    logger,
    getWindow: () => null,
    confirmDrafts: vi.fn(async () => true),
    isViewDraftCheckActive: () => false,
    onBegin,
    hasRemoteSession: () => false,
    stages: ['capture', 'remote', 'diagnostic'].map((name) => ({
      name,
      enabled: () => true,
      run: () => order.push(name)
    })),
    cleanup: ['geometry', 'services', 'database', 'native', 'tray'].map((name) => ({
      name,
      run: () => order.push(name)
    })),
    flushLogs: vi.fn(async () => order.push('logs')),
    ...overrides
  })
  return { runtime, app, logger, onBegin, order, event }
}

describe('application startup admission', () => {
  it('returns successful parallel recovery values in callback order', async () => {
    const first = deferred()
    const secondStarted = vi.fn(() => 'wallpapers')
    const recovering = settleStartupRecoveries([() => first.promise, secondStarted])
    await drain()
    expect(secondStarted).toHaveBeenCalledOnce()
    first.resolve('attachments')
    await expect(recovering).resolves.toEqual(['attachments', 'wallpapers'])
  })

  it('captures synchronous and asynchronous failures after all remaining recoveries settle', async () => {
    const remaining = deferred()
    const synchronousFailure = new Error('staging root EACCES')
    const asynchronousFailure = new Error('attachment readdir failed')
    const asynchronousRecovery = vi.fn(() => Promise.reject(asynchronousFailure))
    const lastRecovery = vi.fn(() => remaining.promise)
    let outcome
    let settled = false
    try {
      const recovering = settleStartupRecoveries([
        () => {
          throw synchronousFailure
        },
        asynchronousRecovery,
        lastRecovery
      ])
      outcome = Promise.resolve(recovering).then(
        (value) => ({ value }),
        (error) => ({ error })
      )
    } catch (error) {
      outcome = Promise.resolve({ error })
    }
    outcome.then(() => (settled = true))
    await drain()
    expect(asynchronousRecovery).toHaveBeenCalledOnce()
    expect(lastRecovery).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    remaining.resolve('last recovery finished')
    const result = await outcome
    expect(result.error).toBeInstanceOf(AggregateError)
    expect(result.error.errors).toEqual([synchronousFailure, asynchronousFailure])
  })

  it('preserves the recover-and-continue startup policy only after the sibling recovery finishes', async () => {
    const sibling = deferred()
    const failure = new Error('wallpaper staging failed')
    const recoveriesFailed = vi.fn()
    const createWindow = vi.fn()
    const onFailure = vi.fn()
    const runtime = createApplicationBootstrap({
      whenReady: async () => {},
      start: async ({ runStage, checkpoint }) => {
        try {
          await runStage('storage-recovery', () =>
            settleStartupRecoveries([() => Promise.reject(failure), () => sibling.promise])
          )
        } catch (error) {
          recoveriesFailed(error)
        }
        checkpoint()
        createWindow()
      },
      onFailure
    })
    const starting = runtime.start()
    await drain()
    expect(createWindow).not.toHaveBeenCalled()
    expect(recoveriesFailed).not.toHaveBeenCalled()
    sibling.resolve()
    await starting
    expect(recoveriesFailed.mock.calls[0][0].errors).toEqual([failure])
    expect(createWindow).toHaveBeenCalledOnce()
    expect(onFailure).not.toHaveBeenCalled()
    expect(runtime.snapshot()).toMatchObject({
      phase: 'ready',
      stages: { 'storage-recovery': 'failed' }
    })
  })

  it('starts once and records completed resource stages in their actual order', async () => {
    const onFailure = vi.fn()
    const runtime = createApplicationBootstrap({
      whenReady: async () => {},
      start: async ({ runStage }) => {
        await runStage('database', () => 'connection')
        await runStage('services', () => 'services')
      },
      onFailure
    })
    const starting = runtime.start()
    expect(runtime.start()).toBe(starting)
    await starting
    expect(runtime.snapshot()).toEqual({
      phase: 'ready',
      stopping: false,
      stages: { database: 'created', services: 'created' }
    })
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('does not create resources when quitting before Electron ready', async () => {
    const ready = deferred()
    const start = vi.fn()
    const runtime = createApplicationBootstrap({
      whenReady: () => ready.promise,
      start,
      onFailure: vi.fn()
    })
    const starting = runtime.start()
    runtime.cancel()
    ready.resolve()
    await starting
    expect(start).not.toHaveBeenCalled()
    expect(runtime.snapshot()).toMatchObject({ phase: 'cancelled', stages: {} })
  })

  it('waits for an entered stage but prevents its late continuation from creating more resources', async () => {
    const pending = deferred()
    const entered = deferred()
    const lateResource = vi.fn()
    const onFailure = vi.fn()
    const runtime = createApplicationBootstrap({
      whenReady: async () => {},
      start: async ({ runStage }) => {
        await runStage('recovery', () => {
          entered.resolve()
          return pending.promise
        })
        await runStage('window', lateResource)
      },
      onFailure
    })
    runtime.start()
    await entered.promise
    runtime.cancel()
    let settled = false
    runtime.settled().then(() => (settled = true))
    await drain()
    expect(settled).toBe(false)
    pending.resolve()
    await runtime.settled()
    expect(lateResource).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
    expect(runtime.snapshot()).toMatchObject({
      phase: 'cancelled',
      stages: { recovery: 'created' }
    })
  })

  it('keeps the created ledger on partial startup failure for owned-resource cleanup', async () => {
    const failure = new Error('service failed')
    const onFailure = vi.fn()
    const runtime = createApplicationBootstrap({
      whenReady: async () => {},
      start: async ({ runStage }) => {
        await runStage('database', () => ({}))
        await runStage('services', () => {
          throw failure
        })
      },
      onFailure
    })
    await runtime.start()
    expect(onFailure).toHaveBeenCalledWith(failure)
    expect(runtime.snapshot()).toMatchObject({
      phase: 'failed',
      stages: { database: 'created', services: 'failed' }
    })
  })
})

describe('application shutdown admission and ownership', () => {
  it('waits for the remaining recovery after a sibling fails before closing storage during quit', async () => {
    const sibling = deferred()
    const entered = deferred()
    const events = []
    const closeDatabase = vi.fn(() => events.push('database-closed'))
    const createWindow = vi.fn()
    const onFailure = vi.fn()
    const runtime = createApplicationBootstrap({
      whenReady: async () => {},
      start: async ({ runStage, checkpoint }) => {
        try {
          await runStage('storage-recovery', () =>
            settleStartupRecoveries([
              () => Promise.reject(new Error('first recovery failed')),
              async () => {
                entered.resolve()
                await sibling.promise
                expect(closeDatabase).not.toHaveBeenCalled()
                events.push('sibling-storage-access')
              }
            ])
          )
        } catch (error) {
          events.push(error.message)
        }
        checkpoint()
        createWindow()
      },
      onFailure
    })
    runtime.start()
    await entered.promise
    const state = shutdownFixture({
      onBegin: () => runtime.cancel(),
      stages: [{ name: 'startup-settlement', enabled: () => true, run: runtime.settled }],
      cleanup: [{ name: 'database', run: closeDatabase }]
    })
    state.runtime.requestQuit('startup-recovery-failure')
    await drain()
    expect(closeDatabase).not.toHaveBeenCalled()
    expect(state.runtime.snapshot().completed).toBe(false)
    sibling.resolve()
    await runtime.settled()
    await drain()
    expect(events[0]).toBe('sibling-storage-access')
    expect(events.at(-1)).toBe('database-closed')
    expect(closeDatabase).toHaveBeenCalledOnce()
    expect(createWindow).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
    expect(runtime.snapshot().phase).toBe('cancelled')
    expect(state.runtime.snapshot().completed).toBe(true)
  })

  it('keeps draft cancellation ahead of all cleanup, then permits a later approved quit', async () => {
    const decision = deferred()
    const confirmDrafts = vi.fn().mockReturnValueOnce(decision.promise).mockResolvedValueOnce(true)
    const state = shutdownFixture({
      getWindow: () => ({ isDestroyed: () => false }),
      confirmDrafts
    })
    state.runtime.requestQuit('tray-menu')
    state.app.quit()
    await drain()
    expect(confirmDrafts).toHaveBeenCalledOnce()
    expect(state.onBegin).not.toHaveBeenCalled()
    expect(state.runtime.isQuitting()).toBe(false)
    expect(state.runtime.snapshot()).toMatchObject({ quitRequested: true, deferredQuit: false })
    decision.resolve(false)
    await drain()
    expect(state.runtime.isQuitting()).toBe(false)
    expect(state.runtime.isCheckingDrafts()).toBe(false)
    expect(state.runtime.snapshot()).toMatchObject({ quitRequested: false, deferredQuit: false })
    expect(state.order).toEqual([])
    state.runtime.requestQuit('tray-menu')
    await drain()
    await drain()
    expect(state.order).toEqual([
      'capture',
      'remote',
      'diagnostic',
      'geometry',
      'services',
      'database',
      'native',
      'tray',
      'logs'
    ])
    expect(state.onBegin).toHaveBeenCalledOnce()
  })

  it('defers one quit intent until the complete navigation owner releases it', async () => {
    let navigating = true
    const decision = deferred()
    const confirmDrafts = vi.fn(() => decision.promise)
    const state = shutdownFixture({
      getWindow: () => ({ isDestroyed: () => false }),
      // Renderer-ready can end draft inspection before the outer navigation settles.
      isViewDraftCheckActive: () => false,
      getViewNavigationActive: () => navigating,
      confirmDrafts
    })
    state.runtime.requestQuit('tray-menu')
    state.runtime.requestQuit('tray-menu')
    await drain()
    expect(confirmDrafts).not.toHaveBeenCalled()
    expect(state.onBegin).not.toHaveBeenCalled()
    expect(state.runtime.isQuitting()).toBe(false)
    expect(state.runtime.isCheckingDrafts()).toBe(true)
    expect(state.runtime.snapshot()).toMatchObject({
      quitRequested: true,
      deferredQuit: true,
      checkingDrafts: false,
      startedAt: null
    })
    expect(state.runtime.resumeDeferredQuit()).toBe(false)
    navigating = false
    expect(state.runtime.resumeDeferredQuit()).toBe(true)
    expect(state.runtime.resumeDeferredQuit()).toBe(false)
    state.runtime.requestQuit('tray-menu')
    await drain()
    expect(confirmDrafts).toHaveBeenCalledOnce()
    expect(state.runtime.isQuitting()).toBe(false)
    expect(state.runtime.snapshot()).toMatchObject({ deferredQuit: false, checkingDrafts: true })
    decision.resolve(true)
    await drain()
    await drain()
    expect(state.onBegin).toHaveBeenCalledOnce()
    expect(state.runtime.snapshot()).toMatchObject({
      quitting: true,
      quitRequested: true,
      deferredQuit: false,
      completed: true
    })
  })

  it('clears a cancelled deferred quit and does not replay it on a later navigation settlement', async () => {
    let navigating = true
    const confirmDrafts = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const state = shutdownFixture({
      getWindow: () => ({ isDestroyed: () => false }),
      getViewNavigationActive: () => navigating,
      confirmDrafts
    })
    // Direct system/programmatic quit requests must also survive navigation.
    state.app.quit()
    expect(state.runtime.snapshot()).toMatchObject({ quitRequested: true, deferredQuit: true })
    navigating = false
    expect(state.runtime.resumeDeferredQuit()).toBe(true)
    await drain()
    expect(state.runtime.snapshot()).toMatchObject({
      quitting: false,
      quitRequested: false,
      deferredQuit: false,
      checkingDrafts: false,
      startedAt: null
    })
    expect(state.runtime.isCheckingDrafts()).toBe(false)
    expect(state.runtime.resumeDeferredQuit()).toBe(false)
    expect(state.onBegin).not.toHaveBeenCalled()
    state.runtime.requestQuit('tray-menu')
    await drain()
    await drain()
    expect(confirmDrafts).toHaveBeenCalledTimes(2)
    expect(state.onBegin).toHaveBeenCalledOnce()
    expect(state.runtime.snapshot().completed).toBe(true)
  })

  it('restores normal admission after a quit preparation rejects and allows a fresh request', async () => {
    const failure = new Error('settings persistence unconfirmed')
    const confirmDrafts = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(true)
    const state = shutdownFixture({
      getWindow: () => ({ isDestroyed: () => false }),
      confirmDrafts
    })
    state.runtime.requestQuit('tray-menu')
    await drain()
    expect(state.runtime.snapshot()).toMatchObject({
      quitting: false,
      quitRequested: false,
      deferredQuit: false,
      checkingDrafts: false,
      startedAt: null
    })
    expect(state.runtime.isCheckingDrafts()).toBe(false)
    expect(state.onBegin).not.toHaveBeenCalled()
    expect(state.logger.error).toHaveBeenCalledWith('lifecycle.shutdown-drafts', failure)
    state.runtime.requestQuit('tray-menu')
    await drain()
    await drain()
    expect(confirmDrafts).toHaveBeenCalledTimes(2)
    expect(state.onBegin).toHaveBeenCalledOnce()
  })

  it('retains the legacy view-draft-check port when a complete navigation port is not supplied', async () => {
    let inspecting = true
    const confirmDrafts = vi.fn(async () => false)
    const state = shutdownFixture({
      getWindow: () => ({ isDestroyed: () => false }),
      isViewDraftCheckActive: () => inspecting,
      confirmDrafts
    })
    state.runtime.requestQuit()
    await drain()
    expect(confirmDrafts).not.toHaveBeenCalled()
    expect(state.runtime.isQuitting()).toBe(false)
    expect(state.runtime.isCheckingDrafts()).toBe(true)
    inspecting = false
    expect(state.runtime.resumeDeferredQuit()).toBe(true)
    await drain()
    expect(confirmDrafts).toHaveBeenCalledOnce()
    expect(state.runtime.isCheckingDrafts()).toBe(false)
    expect(state.runtime.snapshot()).toMatchObject({
      quitRequested: false,
      deferredQuit: false,
      trigger: 'user-request'
    })
  })

  it('does not let an old renderer rejection reopen admission after window loss starts cleanup', async () => {
    const decision = deferred()
    const capture = deferred()
    let window = { isDestroyed: () => false }
    const state = shutdownFixture({
      getWindow: () => window,
      confirmDrafts: () => decision.promise,
      stages: [{ name: 'capture', enabled: () => true, run: () => capture.promise }]
    })
    state.runtime.requestQuit('tray-menu')
    await drain()
    window = null
    state.app.quit()
    await drain()
    expect(state.onBegin).toHaveBeenCalledOnce()
    expect(state.runtime.isQuitting()).toBe(true)
    decision.resolve(false)
    await drain()
    expect(state.runtime.snapshot()).toMatchObject({
      quitting: true,
      quitRequested: true,
      deferredQuit: false,
      activeStage: 'capture',
      completed: false
    })
    capture.resolve()
    await drain()
    expect(state.runtime.snapshot().completed).toBe(true)
    expect(state.onBegin).toHaveBeenCalledOnce()
  })

  it('blocks repeated before-quit while a stage is pending and disposes each resource once', async () => {
    const capture = deferred()
    const dispose = vi.fn(() => capture.promise)
    const state = shutdownFixture({
      stages: [{ name: 'capture', enabled: () => true, run: dispose }]
    })
    state.app.quit()
    state.app.quit()
    await drain()
    expect(dispose).toHaveBeenCalledOnce()
    expect(state.order).toEqual([])
    capture.resolve()
    await drain()
    state.app.quit()
    await drain()
    expect(state.order).toEqual(['geometry', 'services', 'database', 'native', 'tray', 'logs'])
    expect(dispose).toHaveBeenCalledOnce()
    expect(state.runtime.snapshot()).toMatchObject({ completed: true, activeStage: null })
  })

  it('skips uncreated resources and still closes remaining owners after a service throws', async () => {
    const skipped = vi.fn()
    const failure = new Error('dispose failed')
    const state = shutdownFixture({
      stages: [{ name: 'capture', enabled: () => false, run: skipped }],
      cleanup: [
        {
          name: 'service',
          run: () => {
            throw failure
          }
        },
        { name: 'database', run: vi.fn() },
        { name: 'native', run: vi.fn() }
      ]
    })
    state.app.quit()
    await drain()
    expect(skipped).not.toHaveBeenCalled()
    expect(state.runtime.snapshot().stages).toEqual({
      capture: { status: 'not-created' },
      service: {
        status: 'failed',
        outcome: 'failed',
        error: 'dispose failed',
        settled: true,
        elapsedMs: expect.any(Number)
      },
      database: {
        status: 'complete',
        outcome: 'completed',
        result: undefined,
        settled: true,
        elapsedMs: expect.any(Number)
      },
      native: {
        status: 'complete',
        outcome: 'completed',
        result: undefined,
        settled: true,
        elapsedMs: expect.any(Number)
      },
      'on-begin': { status: 'complete', outcome: 'completed', result: undefined, settled: true }
    })
    expect(state.runtime.snapshot()).toMatchObject({
      completed: true,
      outcome: 'failed',
      success: false
    })
    expect(state.logger.error).toHaveBeenCalledWith('lifecycle.shutdown-cleanup', failure, {
      stage: 'service'
    })
  })

  it('keeps the database open until an in-flight startup stage has settled', async () => {
    const recovery = deferred()
    const entered = deferred()
    const bootstrap = createApplicationBootstrap({
      whenReady: async () => {},
      start: ({ runStage }) =>
        runStage('storage-recovery', () => {
          entered.resolve()
          return recovery.promise
        }),
      onFailure: vi.fn()
    })
    bootstrap.start()
    await entered.promise
    const closeDatabase = vi.fn()
    const state = shutdownFixture({
      onBegin: () => bootstrap.cancel(),
      stages: [{ name: 'startup', enabled: () => true, run: bootstrap.settled }],
      cleanup: [{ name: 'database', run: closeDatabase }]
    })
    state.app.quit()
    await drain()
    expect(closeDatabase).not.toHaveBeenCalled()
    recovery.resolve()
    await drain()
    await drain()
    expect(closeDatabase).toHaveBeenCalledOnce()
  })

  it.each([
    ['timeout', 'timed-out'],
    [{ complete: false, windows: 2 }, 'degraded'],
    [{ incomplete: true, reason: 'bounded-owner-result' }, 'degraded']
  ])('does not classify a fulfilled %j as complete', async (value, expected) => {
    const state = shutdownFixture({
      stages: [{ name: 'owner', enabled: () => true, run: () => value }],
      cleanup: [{ name: 'database', run: () => ({ closed: true }) }]
    })
    state.app.quit()
    await drain()
    expect(state.runtime.snapshot()).toMatchObject({
      completed: true,
      outcome: expected,
      success: false
    })
    expect(state.runtime.snapshot().stages.owner).toMatchObject({
      status: expected,
      outcome: expected,
      result: value,
      settled: true
    })
    expect(state.runtime.snapshot().stages.database).toMatchObject({
      status: 'complete',
      outcome: 'completed',
      result: { closed: true }
    })
    expect(state.app.exit).not.toHaveBeenCalled()
  })

  it('uses a narrow owner assessment and retains its original cleanup result', async () => {
    const owner = { closed: false, retained: 1 }
    const assess = vi.fn(() => ({ status: 'failed', resourcesClosed: false }))
    const state = shutdownFixture({
      stages: [],
      cleanup: [{ name: 'native', run: () => owner, assess }]
    })
    state.app.quit()
    await drain()
    expect(assess).toHaveBeenCalledExactlyOnceWith(owner)
    expect(state.runtime.snapshot()).toMatchObject({
      completed: true,
      outcome: 'failed',
      stages: {
        native: { status: 'failed', outcome: 'failed', resourcesClosed: false, result: owner }
      }
    })
  })

  it('does not enter resource stages through a synchronous reentrant onBegin quit', async () => {
    let state
    const run = vi.fn()
    const onBegin = vi.fn(() => state.app.quit())
    state = shutdownFixture({
      onBegin,
      stages: [{ name: 'owner', enabled: () => true, run }]
    })
    state.app.quit()
    await drain()
    expect(onBegin).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
    expect(state.runtime.snapshot()).toMatchObject({ completed: true, outcome: 'completed' })
  })

  it.each(['resolve', 'reject'])(
    'seals a deadline before a late stage can %s or start cleanup',
    async (finish) => {
      vi.useFakeTimers()
      const held = deferred()
      const later = vi.fn()
      const database = vi.fn()
      const onTerminal = vi.fn()
      const flushLogs = vi.fn()
      const state = shutdownFixture({
        timeoutMs: 30,
        onTerminal,
        stages: [
          { name: 'business', enabled: () => true, run: () => held.promise },
          { name: 'later', enabled: () => true, run: later }
        ],
        cleanup: [{ name: 'database', run: database }],
        flushLogs
      })
      state.app.quit()
      await drain()
      await vi.advanceTimersByTimeAsync(30)
      const frozen = state.runtime.snapshot()
      expect(frozen).toMatchObject({
        terminal: true,
        completed: false,
        outcome: 'timed-out',
        exitMode: 'deadline',
        activeStage: 'business',
        logFlush: { status: 'not-started' },
        stages: {
          business: { status: 'timed-out', outcome: 'timed-out', settled: false },
          later: { status: 'not-started' },
          database: { status: 'not-started' }
        }
      })
      expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
      expect(onTerminal).toHaveBeenCalledOnce()
      expect(onTerminal.mock.calls[0][0]).toEqual(frozen)
      const quits = state.app.quit.mock.calls.length
      if (finish === 'resolve') held.resolve({ complete: true })
      else held.reject(new Error('late owner failure'))
      await drain()
      state.runtime.requestQuit('late-request')
      state.runtime.setTrigger('late-trigger')
      expect(state.runtime.resumeDeferredQuit()).toBe(false)
      expect(state.runtime.snapshot()).toEqual(frozen)
      expect(state.app.quit).toHaveBeenCalledTimes(quits)
      expect(later).not.toHaveBeenCalled()
      expect(database).not.toHaveBeenCalled()
      expect(flushLogs).not.toHaveBeenCalled()
    }
  )

  it('uses one total budget across successive stages', async () => {
    vi.useFakeTimers()
    const first = deferred(),
      second = deferred()
    const state = shutdownFixture({
      timeoutMs: 30,
      stages: [
        { name: 'first', enabled: () => true, run: () => first.promise },
        { name: 'second', enabled: () => true, run: () => second.promise }
      ]
    })
    state.app.quit()
    await drain()
    await vi.advanceTimersByTimeAsync(20)
    first.resolve()
    await drain()
    expect(state.runtime.snapshot().activeStage).toBe('second')
    await vi.advanceTimersByTimeAsync(10)
    expect(state.runtime.snapshot()).toMatchObject({ outcome: 'timed-out', activeStage: 'second' })
    expect(state.runtime.snapshot().stages.first.status).toBe('complete')
    expect(state.order).toEqual([])
    second.resolve()
    await drain()
  })

  it('does not spend shutdown budget while the user is still deciding about drafts', async () => {
    vi.useFakeTimers()
    const decision = deferred(),
      work = deferred()
    const state = shutdownFixture({
      timeoutMs: 30,
      getWindow: () => ({ isDestroyed: () => false }),
      confirmDrafts: () => decision.promise,
      stages: [{ name: 'work', enabled: () => true, run: () => work.promise }]
    })
    state.app.quit()
    await drain()
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.runtime.snapshot()).toMatchObject({ startedAt: null, terminal: false })
    expect(state.app.exit).not.toHaveBeenCalled()
    decision.resolve(true)
    await drain()
    await vi.advanceTimersByTimeAsync(30)
    expect(state.runtime.snapshot()).toMatchObject({ outcome: 'timed-out', elapsedMs: 30 })
    work.resolve()
    await drain()
  })

  it('checks the deadline after a synchronous cleanup returns before entering the next owner', () => {
    let clock = 0
    const database = vi.fn()
    const state = shutdownFixture({
      timeoutMs: 30,
      now: () => clock,
      stages: [],
      cleanup: [
        {
          name: 'native',
          run: () => {
            clock = 31
            return { returned: true }
          }
        },
        { name: 'database', run: database }
      ]
    })
    state.app.quit()
    expect(state.runtime.snapshot()).toMatchObject({
      terminal: true,
      completed: false,
      outcome: 'timed-out',
      stages: { native: { status: 'timed-out', settled: true, result: { returned: true } } }
    })
    expect(database).not.toHaveBeenCalled()
    expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each(['hasRemoteSession', 'onBegin', 'enabled'])(
    'records a thrown %s and safely stops unknown cleanup',
    (port) => {
      const failure = new Error(`${port} failed`)
      const fail = () => {
        throw failure
      }
      const onTerminal = vi.fn()
      const database = vi.fn()
      const overrides = {
        onTerminal,
        stages: [{ name: 'owner', enabled: port === 'enabled' ? fail : () => true, run: vi.fn() }],
        cleanup: [{ name: 'database', run: database }]
      }
      if (port !== 'enabled') overrides[port] = fail
      const state = shutdownFixture(overrides)
      state.app.quit()
      const name =
        port === 'enabled' ? 'owner' : port === 'onBegin' ? 'on-begin' : 'has-remote-session'
      expect(state.runtime.snapshot()).toMatchObject({
        terminal: true,
        completed: false,
        outcome: 'failed',
        exitMode: 'failed-admission',
        stages: { [name]: { status: 'failed', error: failure.message } }
      })
      expect(database).not.toHaveBeenCalled()
      expect(onTerminal).toHaveBeenCalledOnce()
      expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
    }
  )

  it('still exits when both logging and the synchronous terminal observer throw', async () => {
    vi.useFakeTimers()
    const held = deferred()
    const failure = new Error('audit write EACCES')
    const logFailure = () => {
      throw new Error('logger unavailable')
    }
    const state = shutdownFixture({
      timeoutMs: 10,
      logger: { info: logFailure, error: logFailure },
      onTerminal: () => {
        throw failure
      },
      stages: [{ name: 'business', enabled: () => true, run: () => held.promise }]
    })
    state.app.quit()
    await drain()
    await vi.advanceTimersByTimeAsync(10)
    expect(state.runtime.snapshot()).toMatchObject({
      outcome: 'timed-out',
      reportError: 'audit write EACCES',
      loggingErrors: ['logger unavailable']
    })
    expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
    held.resolve()
    await drain()
  })

  it('does not discard an unexpected asynchronous cleanup or close the database underneath it', async () => {
    const work = deferred()
    const database = vi.fn()
    const state = shutdownFixture({
      stages: [],
      cleanup: [
        { name: 'async-owner', run: () => work.promise },
        { name: 'database', run: database }
      ]
    })
    state.app.quit()
    expect(state.runtime.snapshot()).toMatchObject({
      outcome: 'failed',
      completed: false,
      stages: { 'async-owner': { phase: 'cleanup-contract', settled: false } }
    })
    expect(database).not.toHaveBeenCalled()
    expect(state.app.exit).toHaveBeenCalledExactlyOnceWith(1)
    const frozen = state.runtime.snapshot()
    work.reject(new Error('late async cleanup'))
    await drain()
    expect(state.runtime.snapshot()).toEqual(frozen)
  })

  it('retains an independent fulfilled incomplete log result after normal owner results are sealed', async () => {
    const flush = deferred()
    const state = shutdownFixture({ stages: [], cleanup: [], flushLogs: () => flush.promise })
    state.app.quit()
    expect(state.runtime.snapshot()).toMatchObject({
      completed: true,
      terminal: true,
      outcome: 'completed',
      logFlush: { status: 'running' }
    })
    const owners = state.runtime.snapshot().stages
    flush.resolve({ incomplete: true, reason: 'flush-timeout' })
    await drain()
    expect(state.runtime.snapshot()).toMatchObject({
      outcome: 'completed',
      logFlush: {
        status: 'degraded',
        outcome: 'degraded',
        result: { incomplete: true, reason: 'flush-timeout' }
      }
    })
    expect(state.runtime.snapshot().stages).toEqual(owners)
    expect(state.app.exit).not.toHaveBeenCalled()
  })
})
