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
  let disposed = false

  async function checkForUpdates({ showResult = true } = {}) {
    if (disposed || updateChecking.value) return
    const display = policy === 'calendar' || showResult
    const startedAt = performance.now()
    updateChecking.value = true
    if (display) showUpdateDialog.value = true
    try {
      const result = await api.checkForUpdate()
      if (disposed) return
      updateResult.value = result
      if (!display && result?.status === 'available') showUpdateDialog.value = true
    } catch (error) {
      if (policy === 'list') console.error(`[${label}] 检查更新失败:`, error)
      const appInfo = await api.getAppInfo().catch((infoError) => {
        if (policy === 'list')
          console.warn(`[${label}] 更新检查失败后读取应用版本也失败:`, infoError)
        return null
      })
      if (disposed) return
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
      if (display) showUpdateDialog.value = true
    } finally {
      const remaining = 500 - (performance.now() - startedAt)
      if (!disposed && policy === 'list' && display && remaining > 0) {
        await new Promise((resolve) => {
          resolveMinimum = resolve
          minimumTimer = setTimeout(() => {
            minimumTimer = null
            resolveMinimum = null
            resolve()
          }, remaining)
        })
      }
      if (!disposed) updateChecking.value = false
    }
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
