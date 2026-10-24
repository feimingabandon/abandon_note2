import { parseSettingsReceipt } from '../shared/settings-receipt.js'
import {
  isSettingsApplicationRetry,
  isSettingsApplicationState
} from '../shared/settings-application-state.js'

/** Keep the main-issued source for this preload lifetime, including delayed writes. */
export function createSettingsClient(ipcRenderer) {
  let sourceRequest = null

  function source() {
    if (!sourceRequest) {
      const request = ipcRenderer.invoke('settings:write-context')
      sourceRequest = request
      void request.catch(() => {
        if (sourceRequest === request) sourceRequest = null
      })
    }
    return sourceRequest
  }

  function validSnapshot(snapshot, context) {
    return Boolean(
      snapshot &&
      snapshot.source?.token === context.token &&
      snapshot.source?.scope === context.scope &&
      Number.isSafeInteger(snapshot.revision) &&
      snapshot.revision >= 0 &&
      snapshot.values &&
      typeof snapshot.values === 'object' &&
      !Array.isArray(snapshot.values)
    )
  }

  function assertSnapshot(snapshot, context) {
    if (validSnapshot(snapshot, context)) return snapshot
    const error = new Error('设置快照不属于当前页面，请在当前页面重试')
    error.code = 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH'
    throw error
  }

  function assertApplicationState(state, context) {
    if (isSettingsApplicationState(state, { source: context })) return state
    const error = new Error('设置应用状态不属于当前页面，或缺少有效的版本和结果')
    error.code = 'SETTINGS_APPLICATION_STATE_INVALID'
    throw error
  }

  return {
    async getApplicationState() {
      const context = await source()
      return assertApplicationState(
        await ipcRenderer.invoke('settings:application-state', context),
        context
      )
    },
    subscribeApplication(callback) {
      let active = true
      const handler = (_event, state) => {
        void source().then(
          (context) => {
            if (active && isSettingsApplicationState(state, { source: context })) callback(state)
          },
          () => {}
        )
      }
      ipcRenderer.on('settings:application-changed', handler)
      void source().catch(() => {})
      return () => {
        if (!active) return
        active = false
        ipcRenderer.removeListener('settings:application-changed', handler)
      }
    },
    async retryApplication(targets) {
      if (!isSettingsApplicationRetry(targets))
        throw new TypeError('应用重试只接受允许的领域和依赖名单')
      const context = await source()
      const result = await ipcRenderer.invoke('settings:retry-application', targets, context)
      const receipt = parseSettingsReceipt(result, { source: context })
      if (!receipt.valid || receipt.persistence?.status !== 'unchanged') {
        const error = new Error('设置应用重试未返回有效的非写入结果')
        error.code = 'SETTINGS_APPLICATION_RETRY_INVALID'
        throw error
      }
      assertApplicationState(result.applicationState, context)
      return result
    },
    async getSnapshot() {
      // Establish the source before a settings form can queue its first intent.
      const context = await source()
      return assertSnapshot(await ipcRenderer.invoke('get-settings-snapshot', context), context)
    },
    subscribe(callback) {
      let active = true
      const handler = (_event, snapshot) => {
        void source().then(
          (context) => {
            if (active && validSnapshot(snapshot, context)) callback(snapshot)
          },
          () => {}
        )
      }
      ipcRenderer.on('settings:changed', handler)
      void source().catch(() => {})
      return () => {
        if (!active) return
        active = false
        ipcRenderer.removeListener('settings:changed', handler)
      }
    },
    async invoke(channel, ...args) {
      const context = await source()
      const result = await ipcRenderer.invoke(channel, ...args, context)
      if (
        result &&
        (result.values !== undefined || result.snapshot != null || result.persistence !== undefined)
      ) {
        const receipt = parseSettingsReceipt(result, { source: context })
        if (!receipt.valid) {
          const error = new Error(receipt.error.message)
          error.code = receipt.error.code
          throw error
        }
      }
      return result
    },
    async send(channel, ...args) {
      const context = await source()
      ipcRenderer.send(channel, ...args, context)
    }
  }
}
