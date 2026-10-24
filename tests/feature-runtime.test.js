import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/sticky/ElectronStickyService.js', () => ({ ElectronStickyService: class {} }))
vi.mock('../src/main/services/NotificationService.js', () => ({ NotificationService: class {} }))
vi.mock('../src/main/services/ReminderWindow.js', () => ({ ReminderWindow: class {} }))
vi.mock('../src/main/ipc/register-weather-ipc.js', () => ({ registerWeatherIpcHandlers: vi.fn() }))
import { createFeatureRuntime } from '../src/main/application/feature-runtime.js'
import { createShutdownCoordinator } from '../src/main/application/shutdown-coordinator.js'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'

function fixture(overrides = {}) {
  const power = new EventEmitter(),
    window = new EventEmitter()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const admission = createBusinessMutationAdmission()
  const scheduler = {
    tasks: [],
    register(item) {
      this.tasks.push(item)
    },
    start: vi.fn(),
    stop: vi.fn(),
    tick: vi.fn(),
    getHealth: vi.fn(() => ({ alive: true })),
    retryFailed: vi.fn()
  }
  const sticky = {
    initialize: vi.fn(),
    restoreMissing: vi.fn(async () => 0),
    stopInitializations: vi.fn(() => ({
      stopped: true,
      alreadyStopped: false,
      cancelled: [],
      preserved: [],
      pendingCommit: [],
      cleanupErrors: []
    })),
    dispose: vi.fn(),
    close: vi.fn(),
    closeAll: vi.fn()
  }
  const stickyError = vi.fn()
  const notification = { dispose: vi.fn(), trySend: vi.fn(), notifyFailure: vi.fn() }
  const tray = { dispose: vi.fn() },
    popup = { dispose: vi.fn(), send: vi.fn(), stopPresentation: vi.fn() }
  const reminder = {
    tick: vi.fn(),
    nativeAction: vi.fn(),
    dispose: vi.fn(() => {
      popup.dispose()
      tray.dispose()
      notification.dispose()
    })
  }
  const weather = {
    refreshIfDue: vi.fn(async () => null),
    settingsChanged: vi.fn(),
    dispose: vi.fn()
  }
  const nativeImage = {
    createFromPath: () => ({ resize: () => ({ toBitmap: () => new Uint8Array(16 * 16 * 4) }) }),
    createFromBitmap: () => 'attention'
  }
  const activation = { reveal: vi.fn(), attachAction: vi.fn(), detachAction: vi.fn() }
  const commands = {
    runAutomaticNoteMove: vi.fn(() => ({ count: 0, skipped: false })),
    activateNotes: vi.fn(() => ({ count: 0, notified: [] })),
    runRecurringTemplates: vi.fn(() => ({
      count: 0,
      skipped: 0,
      generated: [],
      errors: [],
      autoPaused: []
    }))
  }
  const automaticMove = { enabled: false, onNotesMoved: vi.fn() }
  const owner = createFeatureRuntime({
    lifecycle: { powerMonitor: power, logger },
    reminders: {
      configuration: { capability: { supported: true }, nativeImage },
      ipcMain: {},
      windowPorts: {
        getMainWindow: () => window,
        getSettingsSnapshot: () => ({}),
        onNoteChanged: vi.fn()
      },
      activationPort: activation
    },
    stickies: {
      configuration: {},
      commands: { repository: {}, saveContent: vi.fn() },
      windowPorts: { onError: stickyError }
    },
    schedule: {
      admission,
      commands,
      getAutomaticNoteMoveEnabled: () => automaticMove.enabled,
      onNotesMoved: automaticMove.onNotesMoved,
      runtimeChecks: {
        blurDiagnostic: vi.fn(),
        shouldCheckDockHealth: () => false,
        dockHealthCheck: vi.fn()
      }
    },
    weather: {
      configuration: {},
      windowPorts: { getMainWindow: () => window, canPresentWeather: () => true },
      performancePort: { beginPerformanceOperation: () => vi.fn() }
    },
    factories: {
      scheduler: () => scheduler,
      sticky: () => sticky,
      notification: () => notification,
      trayReminder: () => tray,
      reminderPopup: () => popup,
      reminders: () => reminder,
      weatherRegistrar: () => weather,
      ...overrides
    }
  })
  return {
    owner,
    power,
    window,
    scheduler,
    sticky,
    stickyError,
    notification,
    tray,
    popup,
    reminder,
    weather,
    activation,
    admission,
    commands,
    automaticMove,
    logger
  }
}

describe('feature creation and resource ownership ledger', () => {
  it('stops reminder presentation at approved shutdown while retaining resources for cleanup', () => {
    const f = fixture()
    f.reminder.showAll = vi.fn()
    f.owner.initializeReminders()
    f.owner.stopReminderPresentation()
    expect(f.popup.stopPresentation).toHaveBeenCalledOnce()
    expect(f.popup.dispose).not.toHaveBeenCalled()
    expect(f.reminder.dispose).not.toHaveBeenCalled()
    expect(f.owner.snapshot().resources.reminderPopup).toBe('transferred')
    expect(f.owner.showReminders()).toBe(false)
    expect(f.reminder.showAll).not.toHaveBeenCalled()
    expect(f.owner.initializeReminders()).toBe(false)
    f.owner.disposeCreated()
    expect(f.reminder.dispose).toHaveBeenCalledOnce()
    expect(f.popup.dispose).toHaveBeenCalledOnce()
  })

  it('seals reminder creation when approved shutdown begins before startup reaches it', () => {
    const factory = vi.fn()
    const f = fixture({ notification: factory })
    f.owner.stopReminderPresentation()
    expect(f.owner.initializeReminders()).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    f.owner.disposeCreated()
  })

  it.each(['notification', 'trayReminder', 'reminderPopup', 'reminders'])(
    'keeps reminder shutdown effective when it reenters the %s factory',
    (phase) => {
      const f = fixture({
        [phase]: () => {
          f.owner.stopReminderPresentation()
          return {
            notification: f.notification,
            trayReminder: f.tray,
            reminderPopup: f.popup,
            reminders: f.reminder
          }[phase]
        }
      })
      expect(f.owner.initializeReminders()).toBe(false)
      expect(f.activation.attachAction).not.toHaveBeenCalled()
      expect(f.owner.initializeReminders()).toBe(false)
      if (['reminderPopup', 'reminders'].includes(phase))
        expect(f.popup.stopPresentation).toHaveBeenCalledOnce()
      f.owner.disposeCreated()
      expect(f.notification.dispose).toHaveBeenCalledOnce()
    }
  )

  it('keeps reminder admission stopped after a popup cleanup error', () => {
    const f = fixture()
    f.owner.initializeReminders()
    const failure = new Error('native reminder destroy failed')
    f.popup.stopPresentation.mockImplementation(() => {
      throw failure
    })
    expect(() => f.owner.stopReminderPresentation()).not.toThrow()
    expect(f.logger.error).toHaveBeenCalledWith('reminders.shutdown-presentation', failure)
    expect(f.owner.initializeReminders()).toBe(false)
    f.owner.disposeCreated()
    expect(f.popup.dispose).toHaveBeenCalledOnce()
  })

  it('seals future sticky initialization even if shutdown starts before resource creation', () => {
    const factory = vi.fn()
    const f = fixture({ sticky: factory })
    expect(f.owner.stopStickyInitializations()).toEqual({
      stopped: true,
      alreadyStopped: false,
      cancelled: [],
      preserved: [],
      pendingCommit: [],
      cleanupErrors: []
    })
    expect(f.owner.initializeSticky()).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    expect(f.owner.getStickyCommands()).toBeNull()
    expect(f.owner.snapshot().resources).not.toHaveProperty('sticky')
    expect(f.owner.stopStickyInitializations().alreadyStopped).toBe(true)
    f.owner.disposeCreated()
  })

  it('delegates sticky stop without releasing the resource before drain and final disposal', async () => {
    const f = fixture()
    f.owner.initializeSticky()
    const cleanupFailure = new Error('sticky pending window cleanup failed')
    const serviceReport = {
      stopped: true,
      alreadyStopped: false,
      cancelled: ['pending'],
      preserved: ['complete'],
      pendingCommit: [],
      cleanupErrors: [{ stickyId: 'pending', error: cleanupFailure }]
    }
    f.sticky.stopInitializations.mockReturnValue(serviceReport)
    f.admission.preventNewMutations()
    expect(f.owner.stopStickyInitializations()).toEqual(serviceReport)
    expect(f.sticky.stopInitializations).toHaveBeenCalledOnce()
    expect(f.sticky.dispose).not.toHaveBeenCalled()
    expect(f.owner.snapshot().resources.sticky).toBe('created')
    expect(f.owner.getStickyCommands()).not.toBeNull()
    expect(f.owner.initializeSticky()).toBe(false)
    expect(f.sticky.initialize).toHaveBeenCalledOnce()
    expect(f.owner.stopStickyInitializations().alreadyStopped).toBe(true)
    expect(serviceReport.alreadyStopped).toBe(false)
    await f.admission.drain()
    f.owner.disposeStickyAfterDrain()
    expect(f.sticky.dispose).toHaveBeenCalledOnce()
    expect(f.owner.snapshot().resources.sticky).toBe('disposed')
    f.owner.disposeCreated()
    expect(f.sticky.dispose).toHaveBeenCalledOnce()
  })

  it('contains an unexpected stop failure while retaining the service for later disposal', async () => {
    const f = fixture()
    f.owner.initializeSticky()
    const failure = new Error('injected sticky stop failure')
    f.sticky.stopInitializations.mockImplementation(() => {
      throw failure
    })
    f.admission.preventNewMutations()
    const result = f.owner.stopStickyInitializations()
    expect(result).toEqual({
      stopped: true,
      alreadyStopped: false,
      cancelled: [],
      preserved: [],
      pendingCommit: [],
      cleanupErrors: [{ stickyId: null, error: failure }]
    })
    expect(f.owner.snapshot().resources.sticky).toBe('created')
    expect(f.sticky.dispose).not.toHaveBeenCalled()
    expect(f.owner.initializeSticky()).toBe(false)
    await f.admission.drain()
    f.owner.disposeStickyAfterDrain()
    expect(f.sticky.dispose).toHaveBeenCalledOnce()
    f.owner.disposeCreated()
  })

  it.each(['factory', 'initialize'])(
    'does not start startup restoration after stop reenters sticky %s',
    (phase) => {
      const f = fixture({
        sticky: () => {
          if (phase === 'factory') f.owner.stopStickyInitializations()
          return f.sticky
        }
      })
      if (phase === 'initialize') {
        f.sticky.initialize.mockImplementationOnce(() => f.owner.stopStickyInitializations())
      }
      expect(f.owner.initializeSticky()).toBe(false)
      expect(f.sticky.restoreMissing).not.toHaveBeenCalled()
      expect(f.sticky.stopInitializations).toHaveBeenCalledOnce()
      expect(f.sticky.initialize).toHaveBeenCalledTimes(phase === 'initialize' ? 1 : 0)
      expect(f.owner.snapshot().resources.sticky).toBe('created')
      expect(f.sticky.dispose).not.toHaveBeenCalled()
      f.owner.disposeCreated()
      expect(f.sticky.dispose).toHaveBeenCalledOnce()
    }
  )

  it('routes batch popup dismissal through business admission', async () => {
    let popupOptions
    const f = fixture({
      reminderPopup: (options) => {
        popupOptions = options
        return { dispose: vi.fn() }
      }
    })
    f.reminder.dismissAll = vi.fn(() => ({ dismissed: 2 }))
    f.owner.initializeReminders()
    expect(popupOptions.onDismissAll(['a', 'b'])).toEqual({ dismissed: 2 })
    expect(f.reminder.dismissAll).toHaveBeenCalledExactlyOnceWith(['a', 'b'])
    const clear = f.admission.clear(async () => {})
    expect(() => popupOptions.onDismissAll(['a'])).toThrow('正在清空便签数据')
    await clear
    f.admission.preventNewMutations()
    expect(() => popupOptions.onDismissAll(['a'])).toThrow('软件正在退出')
    expect(f.reminder.dismissAll).toHaveBeenCalledOnce()
    f.owner.disposeCreated()
  })

  it('runs an immediate check only when auto move is enabled and broadcasts committed moves', async () => {
    const f = fixture()
    f.owner.initializeReminders()
    f.owner.startScheduledTasks()
    const task = f.scheduler.tasks.find((item) => item.name === 'automaticNoteMoveTask')
    expect(task.shouldRun()).toBe(false)
    f.owner.settingsChanged()
    expect(f.commands.runAutomaticNoteMove).not.toHaveBeenCalled()
    f.automaticMove.enabled = true
    f.commands.runAutomaticNoteMove.mockReturnValue({ count: 2, targetDateKey: '2026-10-15' })
    f.owner.settingsChanged()
    expect(f.commands.runAutomaticNoteMove).toHaveBeenCalledWith({
      enabled: true,
      now: expect.any(Number),
      force: true
    })
    expect(f.automaticMove.onNotesMoved).toHaveBeenCalledWith({
      count: 2,
      targetDateKey: '2026-10-15'
    })
    f.owner.settingsChanged()
    expect(f.commands.runAutomaticNoteMove).toHaveBeenCalledTimes(1)
    task.execute({ now: 12345 })
    expect(f.commands.runAutomaticNoteMove).toHaveBeenLastCalledWith({
      enabled: true,
      now: 12345,
      force: false
    })
    f.automaticMove.enabled = false
    f.owner.settingsChanged()
    expect(task.shouldRun()).toBe(false)
    f.owner.disposeCreated()
  })

  it('defers enabling during business clear and retries failed immediate checks', async () => {
    const f = fixture()
    f.owner.initializeReminders()
    f.owner.startScheduledTasks()
    let release
    const clearing = f.admission.clear(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    for (let i = 0; i < 5; i++) await Promise.resolve()
    f.automaticMove.enabled = true
    f.owner.settingsChanged()
    expect(f.commands.runAutomaticNoteMove).not.toHaveBeenCalled()
    release()
    await clearing
    f.commands.runAutomaticNoteMove.mockImplementationOnce(() => {
      throw new Error('busy database')
    })
    f.owner.settingsChanged()
    expect(f.logger.error).toHaveBeenCalled()
    f.owner.settingsChanged()
    expect(f.commands.runAutomaticNoteMove).toHaveBeenCalledTimes(2)
    expect(f.commands.runAutomaticNoteMove).toHaveBeenLastCalledWith({
      enabled: true,
      now: expect.any(Number),
      force: true
    })
    f.owner.disposeCreated()
  })

  it('preserves tray false/Promise results and reports busy without an uncaught menu rejection', async () => {
    const f = fixture()
    f.owner.initializeSticky()
    await f.admission.drain()
    let resolveClear
    const clearing = f.admission.clear(
      () =>
        new Promise((resolve) => {
          resolveClear = resolve
        })
    )
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const commands = f.owner.getStickyCommands()
    expect(commands.close('old')).toBe(false)
    expect(commands.closeAll()).toBe(false)
    await expect(commands.restoreMissing({ source: 'tray' })).resolves.toBe(0)
    expect(f.sticky.close).not.toHaveBeenCalled()
    expect(f.sticky.closeAll).not.toHaveBeenCalled()
    expect(f.stickyError).toHaveBeenCalledTimes(3)
    expect(f.stickyError).toHaveBeenLastCalledWith(expect.stringContaining('正在清空'))
    resolveClear()
    await clearing
    f.owner.disposeCreated()
  })

  it('keeps core task order/thresholds, closes mutation tasks during clear, and removes all subscriptions', async () => {
    const f = fixture()
    f.owner.initializeSticky()
    f.owner.initializeReminders()
    f.owner.startScheduledTasks()
    f.owner.initializeWeather()
    expect(f.scheduler.tasks.map((item) => item.name)).toEqual([
      'activationTask',
      'automaticNoteMoveTask',
      'noteGenerationTask',
      'reminderTask',
      'blurRuntimeDiagnosticTask',
      'dockHealthTask',
      'weatherRefreshTask'
    ])
    expect(f.scheduler.tasks.every((item) => item.maxFailures === Infinity)).toBe(true)
    let release
    const clear = f.admission.clear(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    for (const name of [
      'activationTask',
      'automaticNoteMoveTask',
      'noteGenerationTask',
      'reminderTask'
    ])
      expect(
        f.scheduler.tasks.find((item) => item.name === name).shouldRun({ now: Date.now() })
      ).toBe(false)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    release()
    await clear
    f.power.emit('resume')
    expect(f.scheduler.tick).toHaveBeenCalledWith({ reason: 'resume' })
    f.owner.disposeCreated()
    f.owner.disposeCreated()
    expect(f.scheduler.stop).toHaveBeenCalledOnce()
    for (const service of [f.sticky, f.notification, f.tray, f.popup, f.reminder, f.weather])
      expect(service.dispose).toHaveBeenCalledOnce()
    expect(f.power.eventNames()).toEqual([])
    expect(f.window.eventNames()).toEqual([])
    expect(f.owner.snapshot().subscriptions).toBe(0)
  })

  it('releases all reminder children in reverse order when graph assembly fails', () => {
    const f = fixture({
      reminders: () => {
        throw new Error('assemble failed')
      }
    })
    expect(() => f.owner.initializeReminders()).toThrow('assemble failed')
    for (const service of [f.notification, f.tray, f.popup])
      expect(service.dispose).toHaveBeenCalledOnce()
    expect(f.activation.attachAction).not.toHaveBeenCalled()
    f.owner.disposeCreated()
    for (const service of [f.notification, f.tray, f.popup])
      expect(service.dispose).toHaveBeenCalledOnce()
  })

  it('tracks constructed sticky before a failing initialize and releases it once', () => {
    const f = fixture()
    f.sticky.initialize.mockImplementation(() => {
      throw new Error('initialize failed')
    })
    expect(() => f.owner.initializeSticky()).toThrow('initialize failed')
    expect(f.sticky.dispose).toHaveBeenCalledOnce()
    expect(f.owner.getStickyCommands()).toBeNull()
    f.owner.disposeCreated()
    expect(f.sticky.dispose).toHaveBeenCalledOnce()
  })

  it('stops a scheduler which allocated work before startup failed', () => {
    const f = fixture()
    f.owner.initializeReminders()
    f.scheduler.start.mockImplementation(() => {
      throw new Error('start failed')
    })
    expect(() => f.owner.startScheduledTasks()).toThrow('start failed')
    f.owner.disposeCreated()
    expect(f.scheduler.stop).toHaveBeenCalledOnce()
  })

  it('continues other resource disposal if one constructed resource cannot release', () => {
    const f = fixture()
    f.owner.initializeSticky()
    f.owner.initializeReminders()
    f.sticky.dispose.mockImplementation(() => {
      throw new Error('sticky dispose failed')
    })
    f.owner.disposeCreated()
    expect(f.reminder.dispose).toHaveBeenCalledOnce()
    expect(f.scheduler.stop).toHaveBeenCalledOnce()
    expect(f.owner.snapshot().resources.sticky).toBe('failed')
    expect(f.logger.error).toHaveBeenCalled()
  })

  it('carries a real feature disposal failure through the shutdown coordinator', () => {
    const f = fixture()
    f.owner.initializeSticky()
    f.sticky.dispose.mockImplementation(() => {
      throw new Error('sticky disposal failed')
    })
    let beforeQuit
    const app = {
      on: (_event, listener) => (beforeQuit = listener),
      quit: () => beforeQuit({ preventDefault: vi.fn() }),
      exit: vi.fn()
    }
    const shutdown = createShutdownCoordinator({
      app,
      logger: f.logger,
      getWindow: () => null,
      confirmDrafts: () => true,
      hasRemoteSession: () => false,
      onBegin: () => {},
      stages: [],
      cleanup: [{ name: 'features', run: f.owner.disposeCreated }],
      flushLogs: async () => ({ incomplete: false })
    })
    shutdown.requestQuit('feature-disposal')
    expect(shutdown.snapshot()).toMatchObject({
      terminal: true,
      completed: true,
      success: false,
      outcome: 'failed',
      stages: {
        features: {
          status: 'failed',
          outcome: 'failed',
          result: {
            status: 'failed',
            failedResources: ['sticky'],
            error: 'sticky disposal failed'
          }
        }
      }
    })
    expect(f.sticky.dispose).toHaveBeenCalledOnce()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('reports completed synchronous disposal for each group and repeated final cleanup', async () => {
    const f = fixture()
    f.owner.initializeSticky()
    f.owner.initializeReminders()
    f.owner.startScheduledTasks()
    f.owner.initializeWeather()
    f.admission.preventNewMutations()
    await f.admission.drain()
    for (const dispose of [
      f.owner.stopScheduledTasks,
      f.owner.disposeWeather,
      f.owner.disposeReminders,
      f.owner.disposeStickyAfterDrain
    ]) {
      expect(dispose()).toEqual({ status: 'completed' })
      expect(dispose()).toEqual({ status: 'completed' })
    }
    expect(f.owner.disposeCreated()).toEqual({ status: 'completed' })
    expect(f.owner.disposeCreated()).toEqual({ status: 'completed' })
    expect(f.scheduler.stop).toHaveBeenCalledOnce()
    for (const service of [f.sticky, f.notification, f.tray, f.popup, f.reminder, f.weather])
      expect(service.dispose).toHaveBeenCalledOnce()
    expect(f.owner.snapshot().subscriptions).toBe(0)
  })

  it.each([
    ['scheduler', 'stopScheduledTasks', 'stop'],
    ['weather', 'disposeWeather', 'dispose'],
    ['sticky', 'disposeStickyAfterDrain', 'dispose']
  ])(
    'retains the %s disposal failure on reentry and in final results',
    async (name, method, action) => {
      const f = fixture()
      f.owner.initializeSticky()
      f.owner.initializeReminders()
      f.owner.initializeWeather()
      const failure = new Error(`${name} disposal failed`)
      f[name][action].mockImplementation(() => {
        throw failure
      })
      f.admission.preventNewMutations()
      await f.admission.drain()
      const expected = {
        status: 'failed',
        failedResources: [name],
        error: failure.message
      }
      expect(f.owner[method]()).toEqual(expected)
      expect(f.owner[method]()).toEqual(expected)
      expect(f[name][action]).toHaveBeenCalledOnce()
      expect(f.owner.snapshot().resources[name]).toBe('failed')
      expect(f.owner.disposeReminders()).toEqual({ status: 'completed' })
      expect(f.owner.disposeCreated()).toEqual(expected)
      expect(f.owner.disposeCreated()).toEqual(expected)
      expect(f[name][action]).toHaveBeenCalledOnce()
      expect(f.logger.error).toHaveBeenCalledExactlyOnceWith('feature.dispose', failure, {
        resource: name
      })
      expect(f.reminder.dispose).toHaveBeenCalledOnce()
    }
  )

  it.each(['owner', 'child'])(
    'reports all uncertain reminder resources after a thrown %s disposal without retrying them',
    (source) => {
      const f = fixture()
      f.owner.initializeReminders()
      const failure = new Error(`${source} reminder disposal failed`)
      const disposer = source === 'owner' ? f.reminder.dispose : f.popup.dispose
      disposer.mockImplementation(() => {
        throw failure
      })
      const expected = {
        status: 'failed',
        failedResources: ['notification', 'trayReminder', 'reminderPopup', 'reminders'],
        error: failure.message
      }
      expect(f.owner.disposeReminders()).toEqual(expected)
      const ledger = f.owner.snapshot().resources
      expect(ledger).toMatchObject({
        reminders: 'failed',
        notification: 'parent-dispose-failed',
        trayReminder: 'parent-dispose-failed',
        reminderPopup: 'parent-dispose-failed'
      })
      expect(f.owner.disposeReminders()).toEqual(expected)
      expect(f.owner.disposeCreated()).toEqual(expected)
      expect(f.owner.disposeCreated()).toEqual(expected)
      expect(f.owner.snapshot().resources).toEqual({ ...ledger, scheduler: 'disposed' })
      expect(f.reminder.dispose).toHaveBeenCalledOnce()
      expect(f.popup.dispose).toHaveBeenCalledTimes(source === 'child' ? 1 : 0)
      expect(f.tray.dispose).not.toHaveBeenCalled()
      expect(f.notification.dispose).not.toHaveBeenCalled()
      expect(f.logger.error).toHaveBeenCalledExactlyOnceWith('feature.dispose', failure, {
        resource: 'reminders'
      })
    }
  )

  it('reports a previous partial-start child cleanup failure through reminder and final disposal', () => {
    const f = fixture({
      reminders: () => {
        throw new Error('reminder assembly failed')
      }
    })
    const failure = new Error('partial popup cleanup failed')
    f.popup.dispose.mockImplementation(() => {
      throw failure
    })
    expect(() => f.owner.initializeReminders()).toThrow('reminder assembly failed')
    const expected = {
      status: 'failed',
      failedResources: ['reminderPopup'],
      error: failure.message
    }
    expect(f.owner.disposeReminders()).toEqual(expected)
    expect(f.owner.disposeReminders()).toEqual(expected)
    expect(f.owner.disposeCreated()).toEqual(expected)
    expect(f.owner.disposeCreated()).toEqual(expected)
    expect(f.owner.snapshot().resources).toMatchObject({
      reminderPopup: 'failed',
      trayReminder: 'disposed',
      notification: 'disposed'
    })
    expect(f.popup.dispose).toHaveBeenCalledOnce()
    expect(f.tray.dispose).toHaveBeenCalledOnce()
    expect(f.notification.dispose).toHaveBeenCalledOnce()
    expect(f.activation.attachAction).not.toHaveBeenCalled()
  })
})
