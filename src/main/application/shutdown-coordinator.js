/** Serial shutdown gate. Each entered stage is completed once, including failure paths. */
export function createShutdownCoordinator({
  app,
  logger,
  getWindow,
  confirmDrafts,
  isViewDraftCheckActive,
  onBegin,
  hasRemoteSession,
  stages,
  cleanup,
  flushLogs,
  now = Date.now
}) {
  let quitting = false
  let checkingDrafts = false
  let draftsApproved = false
  let startedAt = null
  let trigger = null
  let activeStage = null
  let completed = false
  const results = new Map()

  function beforeQuit(event) {
    const window = getWindow()
    if (!draftsApproved && window && !window.isDestroyed()) {
      event.preventDefault()
      if (checkingDrafts || isViewDraftCheckActive()) return
      checkingDrafts = true
      void Promise.resolve()
        .then(() => confirmDrafts(window, '退出'))
        .then((allowed) => {
          if (allowed) {
            draftsApproved = true
            app.quit()
          } else quitting = false
        })
        .catch((error) => {
          quitting = false
          logger.error('lifecycle.shutdown-drafts', error)
        })
        .finally(() => {
          checkingDrafts = false
        })
      return
    }
    if (startedAt === null) {
      startedAt = now()
      trigger ||= quitting ? 'user-request' : 'system-or-programmatic'
      logger.info('lifecycle.shutdown-start', '应用开始退出清理', {
        trigger,
        remoteSessionActive: hasRemoteSession()
      })
      quitting = true
      onBegin()
    }
    if (activeStage) {
      event.preventDefault()
      return
    }
    for (const stage of stages) {
      if (results.has(stage.name)) continue
      if (!stage.enabled()) {
        results.set(stage.name, { status: 'not-created' })
        continue
      }
      event.preventDefault()
      activeStage = stage.name
      const stageStartedAt = now()
      void Promise.resolve()
        .then(stage.run)
        .then((result) => results.set(stage.name, { status: 'complete', result }))
        .catch((error) => {
          results.set(stage.name, { status: 'failed', error: error?.message || String(error) })
          logger.error(stage.errorScope || 'lifecycle.shutdown-stage', error, { stage: stage.name })
        })
        .finally(() => {
          logger.info('lifecycle.shutdown-wait', '退出清理阶段结束', {
            stage: stage.name,
            elapsedMs: now() - stageStartedAt,
            ...results.get(stage.name)
          })
          activeStage = null
          app.quit()
        })
      return
    }
    if (completed) return
    for (const stage of cleanup) {
      try {
        stage.run()
        results.set(stage.name, { status: 'complete' })
      } catch (error) {
        results.set(stage.name, { status: 'failed', error: error?.message || String(error) })
        logger.error('lifecycle.shutdown-cleanup', error, { stage: stage.name })
      }
    }
    completed = true
    logger.info('lifecycle.shutdown-complete', '应用退出清理完成', {
      trigger,
      elapsedMs: now() - startedAt,
      stages: Object.fromEntries(results)
    })
    // The logger owns the final bounded will-quit barrier and its worker termination.
    void flushLogs().catch((error) => logger.error('lifecycle.shutdown-logs', error))
  }

  app.on('before-quit', beforeQuit)
  return {
    isQuitting: () => quitting,
    isCheckingDrafts: () => checkingDrafts,
    setTrigger(value) {
      trigger = value
    },
    requestQuit(value) {
      if (value) trigger = value
      quitting = true
      app.quit()
    },
    snapshot() {
      return {
        quitting,
        checkingDrafts,
        draftsApproved,
        startedAt,
        trigger,
        activeStage,
        completed,
        stages: Object.fromEntries(results)
      }
    }
  }
}
