import { isSettingsApplicationRetry } from '../../shared/settings-application-state.js'

/** Read current application metadata without refreshing values or invoking runtime ports. */
export function settingsApplicationStateForSource(coordinator, source) {
  const ledger = coordinator.snapshotLedger(source.scope)
  return {
    source: { token: source.token, scope: source.scope },
    ledgerRevision: ledger.ledgerRevision,
    ledger
  }
}

export function registerSettingsApplicationIpc({
  mainWindowIpc,
  removeHandler,
  settingsWriteSource,
  settingsOperations,
  coordinator
}) {
  const registered = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const channel of registered) removeHandler(channel)
  }
  const handle = (channel, listener) => {
    mainWindowIpc.handle(channel, listener)
    registered.push(channel)
  }
  try {
    handle('settings:application-state', (event, source) => {
      settingsWriteSource.assertDocument(event, source)
      return settingsApplicationStateForSource(coordinator, source)
    })
    handle('settings:retry-application', (event, targets, source) => {
      settingsWriteSource.assert(event, source)
      if (!isSettingsApplicationRetry(targets))
        throw new TypeError('应用重试只接受允许的领域和依赖名单')
      const context = { scope: source.scope, source: { token: source.token, scope: source.scope } }
      const domains = [...targets.domains]
      const dependencies = [...targets.dependencies]
      return settingsOperations.run(async () => {
        const receipt = await coordinator.retryAppliedSettings({ domains, dependencies, context })
        // A late result cannot borrow a replacement document's source or state.
        settingsWriteSource.assertDocument(event, context.source)
        return {
          ...receipt,
          applicationState: settingsApplicationStateForSource(coordinator, context.source)
        }
      })
    })
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
