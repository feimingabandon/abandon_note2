import { onUnmounted, ref } from 'vue'
import { useModalRequest } from './useQueuedModal.js'

export function useUpdateCheck({ policy = 'calendar', label, api = window.api }) {
  const updateQueue = useModalRequest()
  const showUpdateDialog = updateQueue.requested
  const updateChecking = ref(false)
  const updateResult = ref(null)
  let startupTimer = null
  let minimumTimer = null
  let resolveMinimum = null
  let activeCheck = null
  let disposed = false

  const isCurrent = (operation) => !disposed && activeCheck === operation

  function requestDisplay(operation) {
    operation.display = true
    if (policy === 'list') operation.minimumUntil = performance.now() + 500
    showUpdateDialog.value = true
  }

  async function runCheck(operation) {
    try {
      const result = await api.checkForUpdate()
      if (!isCurrent(operation)) return
      updateResult.value = result
      if (!operation.display && result?.status === 'available') showUpdateDialog.value = true
    } catch (error) {
      if (!isCurrent(operation)) return
      if (policy === 'list') console.error(`[${label}] 检查更新失败:`, error)
      let appInfo = null
      try {
        appInfo = await api.getAppInfo()
      } catch (infoError) {
        if (policy === 'list')
          console.warn(`[${label}] 更新检查失败后读取应用版本也失败:`, infoError)
      }
      if (!isCurrent(operation)) return
      updateResult.value = {
        status: 'error',
        currentVersion: appInfo?.version || '未知',
        ...(policy === 'list'
          ? { platform: api.runtimeCapabilities?.platform, artifactName: null }
          : {}),
        downloadAvailable: false,
        releaseLinks: null,
        error: `检查更新失败：${error.message}`
      }
      if (operation.display) showUpdateDialog.value = true
    } finally {
      // A manual request can join a silent check or its minimum-display wait.
      // Each click owns its own 500ms feedback boundary without restarting IPC.
      while (isCurrent(operation) && operation.minimumUntil > performance.now()) {
        await new Promise((resolve) => {
          resolveMinimum = resolve
          minimumTimer = setTimeout(() => {
            minimumTimer = null
            resolveMinimum = null
            resolve()
          }, operation.minimumUntil - performance.now())
        })
      }
      if (isCurrent(operation)) {
        activeCheck = null
        updateChecking.value = false
      }
    }
  }

  function checkForUpdates({ showResult = true } = {}) {
    if (disposed) return Promise.resolve()
    const display = policy === 'calendar' || showResult
    if (activeCheck) {
      if (display) requestDisplay(activeCheck)
      return activeCheck.promise
    }
    const operation = { display: false, minimumUntil: 0, promise: null }
    activeCheck = operation
    updateChecking.value = true
    if (display) requestDisplay(operation)
    operation.promise = runCheck(operation)
    return operation.promise
  }

  function scheduleStartup() {
    if (disposed || policy !== 'list' || startupTimer) return
    startupTimer = setTimeout(() => {
      startupTimer = null
      void checkForUpdates({ showResult: false })
    }, 1200)
  }

  onUnmounted(() => {
    disposed = true
    activeCheck = null
    clearTimeout(startupTimer)
    clearTimeout(minimumTimer)
    startupTimer = null
    minimumTimer = null
    resolveMinimum?.()
    resolveMinimum = null
  })
  return {
    updateQueue,
    showUpdateDialog,
    updateChecking,
    updateResult,
    checkForUpdates,
    scheduleStartup
  }
}
