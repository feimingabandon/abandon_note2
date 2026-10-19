import { describe, expect, it, vi } from 'vitest'
import {
  createApplicationBootstrap,
  settleStartupRecoveries
} from '../src/main/application/bootstrap.js'
import { createShutdownCoordinator } from '../src/main/application/shutdown-coordinator.js'

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function drain() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

function shutdownFixture(overrides = {}) {
  let beforeQuit
  const event = { preventDefault: vi.fn() }
  const app = {
    on: vi.fn((_name, listener) => (beforeQuit = listener)),
    quit: vi.fn(() => beforeQuit(event))
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
    decision.resolve(false)
    await drain()
    expect(state.runtime.isQuitting()).toBe(false)
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
      service: { status: 'failed', error: 'dispose failed' },
      database: { status: 'complete' },
      native: { status: 'complete' }
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
})
