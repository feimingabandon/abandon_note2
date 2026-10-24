import { Scheduler } from '../services/scheduler.js'
import { TemplateSchedulerGuard } from '../services/template-scheduler-guard.js'
import { NotificationService } from '../services/NotificationService.js'
import { ReminderService } from '../services/ReminderService.js'
import { ReminderWindow } from '../services/ReminderWindow.js'
import { TrayReminderController } from '../services/TrayReminderController.js'
import { ElectronStickyService } from '../sticky/ElectronStickyService.js'
import { registerWeatherIpcHandlers } from '../ipc/register-weather-ipc.js'

/** Creates complete feature graphs and owns their partial-start/disposal ledger.
 * The five DTOs stay with their respective children; resource state is never mirrored.
 */
export function createFeatureRuntime({
  lifecycle,
  reminders,
  stickies,
  schedule,
  weather,
  factories = {}
}) {
  const { powerMonitor, logger, integrationTest = false } = lifecycle
  const admission = schedule.admission
  const created = new Map()
  const subscriptions = []
  let disposed = false
  let scheduled = false
  let automaticMoveEnabled = false
  let automaticMoveForceCheck = false
  let stickyInitializationsStopped = false
  let reminderPresentationStopped = false
  const weatherPauses = new Set()

  function resource(name) {
    return created.get(name)?.resource ?? null
  }
  function own(name, factory, dispose) {
    if (disposed) throw new Error('应用功能服务已退出')
    if (created.has(name)) throw new Error(`应用功能已经创建: ${name}`)
    const value = factory()
    created.set(name, { resource: value, dispose, status: 'created', parent: null })
    return value
  }
  function release(name) {
    const entry = created.get(name)
    if (!entry || entry.status !== 'created') return
    entry.status = 'disposing'
    try {
      entry.dispose(entry.resource)
      entry.status = 'disposed'
    } catch (error) {
      entry.status = 'failed'
      entry.error = error?.message || String(error)
      logger.error('feature.dispose', error, { resource: name })
    } finally {
      entry.resource = null
      for (const child of created.values()) {
        if (child.parent !== name) continue
        child.resource = null
        child.status = entry.status === 'disposed' ? 'disposed-by-parent' : 'parent-dispose-failed'
      }
    }
  }
  function disposalOutcome(names = created.keys()) {
    const group = new Set(names)
    const failures = [...created].filter(
      ([name, entry]) =>
        group.has(name) && ['failed', 'parent-dispose-failed'].includes(entry.status)
    )
    if (!failures.length) return { status: 'completed' }
    return {
      status: 'failed',
      failedResources: failures.map(([name]) => name),
      error: [
        ...new Set(
          failures.map(
            ([name, entry]) => entry.error || created.get(entry.parent)?.error || `${name} 清理失败`
          )
        )
      ].join('; ')
    }
  }
  function stage(operation) {
    const before = new Set(created.keys())
    const subscriptionCount = subscriptions.length
    try {
      return operation()
    } catch (error) {
      for (const item of subscriptions.splice(subscriptionCount).reverse()) {
        item.target.removeListener(item.event, item.listener)
      }
      for (const name of [...created.keys()].reverse()) if (!before.has(name)) release(name)
      throw error
    }
  }
  function subscribe(target, event, listener, group) {
    target.on(event, listener)
    subscriptions.push({ target, event, listener, group })
  }
  function unsubscribe(group) {
    for (let i = subscriptions.length - 1; i >= 0; i--) {
      const item = subscriptions[i]
      if (item.group !== group) continue
      item.target.removeListener(item.event, item.listener)
      subscriptions.splice(i, 1)
    }
  }

  const scheduler = own(
    'scheduler',
    () => factories.scheduler?.() || new Scheduler(),
    (value) => value.stop()
  )

  function trayStickyMutation(operation, failureValue) {
    try {
      return admission.run(operation)
    } catch (error) {
      logger.warn('sticky.tray-admission', error.message)
      stickies.windowPorts.onError?.(error.message)
      return failureValue
    }
  }

  const stickyCommands = Object.freeze({
    list: () => resource('sticky')?.list() || [],
    getRecoverableCount: () => resource('sticky')?.getRecoverableCount() || 0,
    focus: (id) => resource('sticky')?.focus(id),
    showAll: () => resource('sticky')?.showAll(),
    close: (id) => trayStickyMutation(() => resource('sticky')?.close(id), false),
    closeAll: () => trayStickyMutation(() => resource('sticky')?.closeAll(), false),
    create: (payload) => admission.run(() => resource('sticky')?.create(payload)),
    restoreMissing: (options) =>
      trayStickyMutation(
        () => resource('sticky')?.restoreMissing(options) || Promise.resolve(0),
        Promise.resolve(0)
      ),
    discardByNoteId: (id) => resource('sticky')?.discardByNoteId(id),
    discardAllRuntime: () => resource('sticky')?.discardAllRuntime()
  })

  function initializeSticky() {
    if (stickyInitializationsStopped) return false
    return stage(() => {
      const repository = Object.fromEntries(
        Object.entries(stickies.commands.repository).map(([name, command]) => [
          name,
          ['insert', 'update', 'delete', 'deleteAll'].includes(name)
            ? (...args) => admission.run(() => command(...args))
            : command
        ])
      )
      const value = own(
        'sticky',
        () => {
          const options = {
            ...stickies.configuration,
            ...stickies.windowPorts,
            getDefaultAppearance: stickies.windowPorts.getListAppearance,
            getNoteById: stickies.commands.getNoteById,
            stickyRepository: repository,
            saveContent: (payload) => admission.run(() => stickies.commands.saveContent(payload)),
            runMutation: admission.run,
            bindMutationContinuation: admission.bindContinuation,
            logger
          }
          return factories.sticky?.(options) || new ElectronStickyService(options)
        },
        (service) => service.dispose()
      )
      // A factory or initialize callback can synchronously begin shutdown. Keep
      // the resource owned, but never start its renderer or startup restore later.
      if (stickyInitializationsStopped) {
        stopStickyInitializations()
        return false
      }
      value.initialize()
      if (stickyInitializationsStopped) return false
      void stickyCommands
        .restoreMissing({ source: 'startup' })
        .catch((error) => logger.error('sticky.startup-restore', error))
      return true
    })
  }

  function stopStickyInitializations() {
    const alreadyStopped = stickyInitializationsStopped
    // This gate also covers shutdown before the sticky resource has been built.
    stickyInitializationsStopped = true
    const report = {
      stopped: true,
      alreadyStopped,
      cancelled: [],
      preserved: [],
      pendingCommit: [],
      cleanupErrors: []
    }
    const value = resource('sticky')
    if (!value) return report
    try {
      return { ...value.stopInitializations(), stopped: true, alreadyStopped }
    } catch (error) {
      // onBegin must continue stopping the other producers. The normal resource
      // ledger retains this service for the later drain/dispose cleanup attempt.
      report.cleanupErrors.push({ stickyId: null, error })
      return report
    }
  }

  function initializeReminders() {
    if (reminderPresentationStopped) return false
    return stage(() => {
      const configuration = reminders.configuration
      const ports = reminders.windowPorts
      const notification = own(
        'notification',
        () => {
          const options = {
            appProtocol: configuration.protocol,
            capability: configuration.capability,
            getMainWindow: ports.getMainWindow,
            icon: configuration.icon
          }
          return factories.notification?.(options) || new NotificationService(options)
        },
        (value) => value.dispose()
      )
      if (reminderPresentationStopped) return false
      const tray = own(
        'trayReminder',
        () => {
          const nativeImage = configuration.nativeImage
          const image = nativeImage
            .createFromPath(configuration.icon)
            .resize({ width: 16, height: 16 })
          const bitmap = image.toBitmap()
          // Amber is the original semantic attention marker over the app icon.
          for (let y = 8; y < 16; y++)
            for (let x = 8; x < 16; x++) {
              if ((x - 11.5) ** 2 + (y - 11.5) ** 2 <= 16)
                bitmap.set([10, 159, 255, 255], (y * 16 + x) * 4)
            }
          const options = {
            normalIcon: configuration.icon,
            alertIcon: nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 })
          }
          return factories.trayReminder?.(options) || new TrayReminderController(options)
        },
        (value) => value.dispose()
      )
      if (reminderPresentationStopped) return false
      const popup = own(
        'reminderPopup',
        () => {
          const options = {
            // eslint-disable-next-line no-restricted-syntax -- Injected logged IPC, not electron.ipcMain.
            ipcMain: reminders.ipcMain,
            preloadPath: configuration.preloadPath,
            rendererPath: configuration.rendererPath,
            rendererUrl: configuration.rendererUrl,
            getSettings: ports.getSettingsSnapshot,
            onAction: (payload) => admission.run(() => resource('reminders').action(payload)),
            onDismissAll: (ids) => admission.run(() => resource('reminders').dismissAll(ids)),
            reportError: (scene, error) => logger.error(scene, error)
          }
          return factories.reminderPopup?.(options) || new ReminderWindow(options)
        },
        (value) => value.dispose()
      )
      if (reminderPresentationStopped) {
        stopReminderPresentation()
        return false
      }
      const service = own(
        'reminders',
        () => {
          const options = {
            notifications: notification,
            popup,
            tray,
            onChanged: ports.onNoteChanged,
            onActiveChanged: ports.onRemindersChanged,
            runMutation: admission.run,
            canRunMutations: admission.canAdmit,
            reportError: (scene, error) => logger.error(scene, error)
          }
          return factories.reminders?.(options) || new ReminderService(options)
        },
        (value) => value.dispose()
      )
      for (const name of ['notification', 'trayReminder', 'reminderPopup']) {
        created.get(name).status = 'transferred'
        created.get(name).parent = 'reminders'
      }
      if (reminderPresentationStopped) return false
      reminders.activationPort.attachAction((payload) =>
        admission.run(() => service.nativeAction(payload))
      )
      return true
    })
  }

  function checkAutomaticNoteMove(now = Date.now()) {
    if (disposed || !admission.canAdmit()) return
    const enabled = Boolean(schedule.getAutomaticNoteMoveEnabled?.())
    if (!enabled) return
    automaticMoveEnabled = enabled
    const result = admission.run(() =>
      schedule.commands.runAutomaticNoteMove({ enabled, now, force: automaticMoveForceCheck })
    )
    automaticMoveForceCheck = false
    if (result.count > 0) {
      logger.info('scheduler.automatic-note-move', '昨天未完成的仅当天便签已移至今天', {
        movedCount: result.count,
        sourceDateKey: result.sourceDateKey,
        targetDateKey: result.targetDateKey
      })
      schedule.onNotesMoved?.(result)
    }
    return result
  }

  function registerCoreTasks() {
    const notificationService = resource('notification')
    const reminderService = resource('reminders')
    const getMainWindow = reminders.windowPorts.getMainWindow
    const activateNotes = () => admission.run(schedule.commands.activateNotes)
    const runRecurringTemplates = (context) =>
      admission.run(() => schedule.commands.runRecurringTemplates(context))
    const runBlurRuntimeDiagnostic = schedule.runtimeChecks.blurDiagnostic
    const runDockHealthCheck = schedule.runtimeChecks.dockHealthCheck
    // 3.3 生效便签激活任务（含通知）
    scheduler.register({
      name: 'activationTask',
      maxFailures: Infinity,
      retryBackoff: true,
      shouldRun: () => !admission.snapshot().clearing,
      execute: (context) => {
        const result = activateNotes()
        const remindersQueued = result.notified.length
        if (result.count > 0) {
          logger.info('scheduler.activation', '到期便签激活完成', {
            reason: context.reason,
            activatedCount: result.count,
            remindersQueued
          })
        }
        if (result.count > 0 && getMainWindow() && !getMainWindow().isDestroyed()) {
          getMainWindow().webContents.send('notes:changed', { reason: 'activation' })
        }
        return { performanceCounts: { activated: result.count, remindersQueued } }
      }
    })

    // 激活历史到期便签之后，再按同一资格规则执行每日移动。
    scheduler.register({
      name: 'automaticNoteMoveTask',
      maxFailures: Infinity,
      retryBackoff: true,
      shouldRun: () => admission.canAdmit() && Boolean(schedule.getAutomaticNoteMoveEnabled?.()),
      execute: (context) => {
        const result = checkAutomaticNoteMove(context.now)
        return { performanceCounts: { moved: result?.count || 0 } }
      }
    })

    // 3.5 循环模板生成任务（含通知）
    const templateSchedulerGuard = new TemplateSchedulerGuard({
      failureThreshold: 3,
      retryDelayMs: 5 * 60 * 1000,
      onAlert: (error) => {
        notificationService.trySend(error?.message || '无法读取或调度循环模板', {
          title: '模板调度服务异常'
        })
      }
    })
    scheduler.register({
      name: 'noteGenerationTask',
      maxFailures: Infinity,
      shouldRun: (context) =>
        !admission.snapshot().clearing && templateSchedulerGuard.shouldRun(context.now),
      execute: (context) => {
        const result = templateSchedulerGuard.run(() => runRecurringTemplates(context), context.now)
        const remindersQueued = result.generated.length
        for (const template of result.autoPaused) {
          const preview = (template.content || '').trim().slice(0, 20) || '空内容模板'
          notificationService.trySend(`模板“${preview}”连续生成失败 3 次：${template.error}`, {
            title: '循环模板已自动暂停'
          })
        }
        const templatesChanged =
          result.count > 0 ||
          result.skipped > 0 ||
          result.errors.length > 0 ||
          result.autoPaused.length > 0
        if (templatesChanged) {
          logger.info('scheduler.template-generation', '循环模板调度发生业务变化', {
            reason: context.reason,
            generatedCount: result.count,
            remindersQueued,
            skippedCount: result.skipped,
            errorCount: result.errors.length,
            errorTemplateIds: result.errors.map((item) => item.templateId),
            autoPausedTemplateIds: result.autoPaused.map((template) => template.id)
          })
        }
        if (templatesChanged && getMainWindow() && !getMainWindow().isDestroyed()) {
          getMainWindow().webContents.send('templates:changed', {
            reason: result.autoPaused.length > 0 ? 'auto-pause' : 'scheduler',
            ids: result.autoPaused.map((template) => template.id)
          })
        }
        if (result.count > 0 && getMainWindow() && !getMainWindow().isDestroyed()) {
          getMainWindow().webContents.send('notes:changed', { reason: 'recurrence' })
        }
        return {
          performanceCounts: {
            generated: result.count,
            skipped: result.skipped,
            errors: result.errors.length,
            autoPaused: result.autoPaused.length,
            remindersQueued
          }
        }
      }
    })

    scheduler.register({
      name: 'reminderTask',
      maxFailures: Infinity,
      retryBackoff: true,
      shouldRun: () => !admission.snapshot().clearing,
      execute: (context) => admission.run(() => reminderService.tick(context.now))
    })

    // 3.6 原生毛玻璃运行诊断：随统一调度器启动即检查，之后每分钟检查一次。
    scheduler.register({
      name: 'blurRuntimeDiagnosticTask',
      maxFailures: Infinity,
      shouldRun: () => true,
      execute: (context) => runBlurRuntimeDiagnostic(context)
    })

    // 3.7 每分钟只检查隐藏态结构；鼠标由 DLL 每 100ms 检测，异常在这里故障开放恢复。
    scheduler.register({
      name: 'dockHealthTask',
      maxFailures: Infinity,
      shouldRun: schedule.runtimeChecks.shouldCheckDockHealth,
      execute: () => runDockHealthCheck()
    })
  }

  function startScheduledTasks() {
    if (disposed || scheduled) return false
    if (!resource('reminders')) throw new Error('提醒功能尚未初始化')
    try {
      registerCoreTasks()
      scheduler.onAlertNotifyFailed = (title, body, error) =>
        resource('notification')?.notifyFailure('调度器告警通知', title, body, error)
      scheduler.start()
      scheduled = true
      subscribe(
        powerMonitor,
        'resume',
        () => {
          if (!disposed && scheduled) scheduler.tick({ reason: 'resume' })
        },
        'scheduler'
      )
      return true
    } catch (error) {
      stopScheduledTasks()
      throw error
    }
  }

  function refreshWeatherIfDue() {
    if (disposed || !resource('weather')) return
    const finish = weather.performancePort.beginPerformanceOperation(
      'background',
      'weather.refreshIfDue'
    )
    void resource('weather')
      .refreshIfDue()
      .then(
        () => finish(),
        (error) => {
          finish({ errors: 1 })
          logger.warn('weather.auto-refresh', error?.message || '天气更新失败')
        }
      )
  }
  function initializeWeather() {
    return stage(() => {
      const options = {
        ...weather.configuration,
        ...weather.windowPorts,
        canAutoRefresh: () =>
          !disposed &&
          !integrationTest &&
          weatherPauses.size === 0 &&
          weather.windowPorts.canPresentWeather(),
        logger
      }
      own(
        'weather',
        () => factories.weatherRegistrar?.(options) || registerWeatherIpcHandlers(options),
        (value) => value.dispose()
      )
      if (!integrationTest) {
        scheduler.register({
          name: 'weatherRefreshTask',
          maxFailures: Infinity,
          shouldRun: () => true,
          execute: refreshWeatherIfDue
        })
        const window = weather.windowPorts.getMainWindow()
        subscribe(window, 'show', refreshWeatherIfDue, 'weather')
        subscribe(window, 'restore', refreshWeatherIfDue, 'weather')
        for (const event of ['suspend', 'lock-screen'])
          subscribe(powerMonitor, event, () => weatherPauses.add(event), 'weather')
        for (const [event, pause] of [
          ['resume', 'suspend'],
          ['unlock-screen', 'lock-screen']
        ])
          subscribe(
            powerMonitor,
            event,
            () => {
              weatherPauses.delete(pause)
              refreshWeatherIfDue()
            },
            'weather'
          )
        refreshWeatherIfDue()
      }
      return true
    })
  }

  function stopScheduledTasks() {
    unsubscribe('scheduler')
    scheduled = false
    release('scheduler')
    return disposalOutcome(['scheduler'])
  }
  function disposeWeather() {
    unsubscribe('weather')
    weatherPauses.clear()
    release('weather')
    return disposalOutcome(['weather'])
  }
  function disposeReminders() {
    reminders.activationPort.detachAction()
    release('reminders')
    for (const name of ['reminderPopup', 'trayReminder', 'notification']) release(name)
    return disposalOutcome(['reminders', 'reminderPopup', 'trayReminder', 'notification'])
  }
  function stopReminderPresentation() {
    reminderPresentationStopped = true
    try {
      resource('reminderPopup')?.stopPresentation()
    } catch (error) {
      // Keep shutdown admission closed even if native window cleanup fails.
      logger.error('reminders.shutdown-presentation', error)
    }
  }
  return Object.freeze({
    initializeSticky,
    initializeReminders,
    startScheduledTasks,
    initializeWeather,
    getStickyCommands: () => (resource('sticky') ? stickyCommands : null),
    refreshReminders: () => resource('reminders')?.refresh(),
    showReminders: () => !reminderPresentationStopped && resource('reminders')?.showAll(),
    getReminderCount: () => resource('reminders')?.activeIds?.size || 0,
    applyNativeReminderAction: (payload) =>
      admission.run(() => resource('reminders')?.nativeAction(payload)),
    attachReminderTray: (tray) => resource('trayReminder')?.attach(tray),
    setReminderBaseIcon: (icon) => resource('trayReminder')?.setBaseIcon(icon),
    acknowledgeReminders: () => resource('trayReminder')?.acknowledge(),
    settingsChanged() {
      resource('weather')?.settingsChanged()
      resource('reminderPopup')?.send()
      const enabled = Boolean(schedule.getAutomaticNoteMoveEnabled?.())
      if (enabled && !automaticMoveEnabled) automaticMoveForceCheck = true
      automaticMoveEnabled = enabled
      if (!enabled) automaticMoveForceCheck = false
      if (enabled && scheduled && automaticMoveForceCheck) {
        try {
          checkAutomaticNoteMove()
        } catch (error) {
          // The setting has committed; retain the pending check for scheduler retry.
          logger.error('scheduler.automatic-note-move', error)
        }
      }
    },
    schedulerHealth: () => scheduler.getHealth(),
    retryScheduledTasks() {
      scheduler.retryFailed()
      return scheduler.getHealth()
    },
    observeRemindersForIntegration: () => resource('reminders'),
    stopScheduledTasks,
    stopStickyInitializations,
    stopReminderPresentation,
    disposeReminders,
    disposeSticky: () => release('sticky'),
    disposeStickyAfterDrain: () =>
      admission.runCleanup(() => {
        release('sticky')
        return disposalOutcome(['sticky'])
      }),
    disposeWeather,
    disposeCreated() {
      if (disposed) return disposalOutcome()
      disposed = true
      stopScheduledTasks()
      disposeWeather()
      disposeReminders()
      for (const name of [...created.keys()].reverse()) release(name)
      return disposalOutcome()
    },
    snapshot: () => ({
      disposed,
      scheduled,
      subscriptions: subscriptions.length,
      resources: Object.fromEntries([...created].map(([name, entry]) => [name, entry.status]))
    })
  })
}
