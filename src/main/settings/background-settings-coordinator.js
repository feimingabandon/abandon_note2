import { serializeSetting, VIEW_MODES } from '../../shared/settings-schema.js'
import { getViewSettingsScope } from './application-settings.js'
import { setSettingsBatch } from '../db/db-settings-repository.js'
import {
  markWallpaperUsed,
  deleteWallpaperVersion,
  saveWallpaperVersion,
  listWallpaperRecords
} from '../db/db-wallpapers.js'

/** Owns background request ordering, compensation and settlement without duplicating settings values or navigation targets. */
export function createBackgroundSettingsCoordinator({
  getMainWindow,
  getSettings,
  getViewMode,
  getViewSettings,
  getActiveWindowName,
  refreshResolvedSettings,
  getResolvedSettingsSnapshot,
  broadcastSettingsChanged,
  persistSettingValues,
  readBlurState,
  setRequestedConfig,
  clearFailure,
  disableConfig,
  restoreFailure,
  initializeBlurRuntime,
  updateBlurDiagnostic,
  runBlurRuntimeDiagnostic,
  notifySettled
}) {
  let stopped = false
  const requests = new Set()
  const settlementWaiters = new Set()
  function settleRequests() {
    if (!requests.size) {
      for (const resolve of settlementWaiters) resolve()
      settlementWaiters.clear()
    }
  }
  function runRequest(operation) {
    if (stopped) throw new Error('应用正在退出，无法修改背景设置')
    const result = operation()
    if (!result || typeof result.then !== 'function') return result
    const tracked = Promise.resolve(result).finally(() => {
      requests.delete(tracked)
      settleRequests()
    })
    requests.add(tracked)
    return tracked
  }
  let blurConfigRequestRevision = 0

  let wallpaperActivationRevision = 0

  let blurSettingsRequestsInFlight = 0

  function persistWallpaperState({ enabled, activeId = getSettings().wallpaper.activeId }) {
    return persistSettingValues([
      { id: 'wallpaper.enabled', value: Boolean(enabled) },
      { id: 'wallpaper.activeId', value: activeId }
    ])
  }

  function deactivateWallpaperForGlass({ broadcast = true } = {}) {
    if (!getSettings().wallpaper.enabled) return null
    setSettingsBatch(getActiveWindowName(), [serializeSetting('wallpaper.enabled', false)])
    refreshResolvedSettings({ incrementRevision: true })
    const snapshot = getResolvedSettingsSnapshot()
    if (broadcast) broadcastSettingsChanged(snapshot)
    return {
      activeId: getSettings().wallpaper.activeId,
      wasEnabled: true
    }
  }

  function restoreSuspendedWallpaper(suspended) {
    if (!suspended?.wasEnabled || !suspended.activeId) return getResolvedSettingsSnapshot()
    return persistWallpaperState({ enabled: true, activeId: suspended.activeId })
  }

  function getWallpaperUsage(id) {
    return Object.values(VIEW_MODES).filter((viewMode) => {
      const wallpaper = getViewSettings(viewMode).wallpaper
      return wallpaper.activeId === Number(id)
    })
  }

  function greatestCommonDivisor(first, second) {
    let a = Math.abs(Math.round(first))
    let b = Math.abs(Math.round(second))
    while (b) [a, b] = [b, a % b]
    return a || 1
  }

  function listWallpaperLibraryRecords() {
    const bounds = getMainWindow()?.isDestroyed() ? null : getMainWindow()?.getBounds()
    const currentAspect =
      bounds?.width > 0 && bounds?.height > 0 ? bounds.width / bounds.height : null
    return listWallpaperRecords().map((record) => {
      const targetAspect = record.target_width / record.target_height
      const divisor = greatestCommonDivisor(record.target_width, record.target_height)
      return {
        ...record,
        aspectRatioLabel: `${record.target_width / divisor}:${record.target_height / divisor}`,
        usedBy: getWallpaperUsage(record.id),
        compatibleWithCurrentView:
          currentAspect === null ? null : Math.abs(Math.log(targetAspect / currentAspect)) <= 0.08
      }
    })
  }

  async function setBlur(config) {
    blurSettingsRequestsInFlight += 1
    try {
      const requestRevision = ++blurConfigRequestRevision
      const activationRevision = wallpaperActivationRevision
      // 本次请求必须持有独立快照。关闭壁纸会从 DB 刷新完整设置，而 DB 中的
      // blur.enabled 此时还是旧值，不能让它覆盖用户刚刚提交的启用请求。
      const requestedConfig = {
        enabled:
          config.enabled !== undefined ? Boolean(config.enabled) : readBlurState().config.enabled,
        radius: config.radius !== undefined ? config.radius : readBlurState().config.radius,
        saturation:
          config.saturation !== undefined ? config.saturation : readBlurState().config.saturation,
        cornerRadius:
          config.cornerRadius !== undefined
            ? config.cornerRadius
            : readBlurState().config.cornerRadius
      }
      setRequestedConfig(requestedConfig)

      // 启用时若启动阶段初始化失败，则现场重试一次，以便把详细错误反馈给用户。
      const enableRequested = readBlurState().config.enabled
      // 先让壁纸退场，再创建/启用原生层；失败时恢复刚才挂起的壁纸。
      const suspendedWallpaper = enableRequested ? deactivateWallpaperForGlass() : null
      if (suspendedWallpaper) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 190))
        if (requestRevision !== blurConfigRequestRevision) {
          const supersededByWallpaper = activationRevision !== wallpaperActivationRevision
          const snapshot =
            !supersededByWallpaper && !readBlurState().config.enabled && suspendedWallpaper
              ? restoreSuspendedWallpaper(suspendedWallpaper)
              : getResolvedSettingsSnapshot()
          return {
            success: snapshot.runtime.blur.effectiveEnabled,
            config: { ...readBlurState().config },
            runtime: snapshot.runtime.blur,
            error: snapshot.runtime.blur.error,
            nativeError: snapshot.runtime.blur.nativeError
          }
        }
        // deactivateWallpaperForGlass() 内部的完整设置刷新会恢复数据库旧值；
        // 退场完成且请求仍为最新时，重新提交本次请求自己的快照。
        setRequestedConfig(requestedConfig)
      }
      if (!enableRequested) {
        clearFailure()
        updateBlurDiagnostic(
          { status: 'disabled', lastCheckedAt: Date.now(), message: '系统毛玻璃未启用' },
          { notify: false }
        )
      }
      const initializationResult =
        enableRequested && readBlurState().caps.supported && !readBlurState().initialized
          ? initializeBlurRuntime()
          : null

      // 初始化失败时不能让持久化值继续显示为“已启用”，否则设置值会与实际效果不一致。
      if (enableRequested && initializationResult && !initializationResult.success) {
        disableConfig()
      }

      let snapshot = persistSettingValues(
        [
          { id: 'blur.enabled', value: readBlurState().config.enabled },
          { id: 'blur.radius', value: readBlurState().config.radius },
          { id: 'blur.saturation', value: readBlurState().config.saturation },
          { id: 'blur.cornerRadius', value: readBlurState().config.cornerRadius }
        ],
        // 新初始化路径已经在 initializeBlurRuntime 中提交过完整配置。
        { applyBlurRuntime: !initializationResult?.success }
      )
      let runtime = snapshot.runtime.blur

      // 重新启用时原生引擎通常已经初始化，因此不会再次经过
      // initializeBlurRuntime() 更新诊断状态。配置实际生效后立即执行完整健康
      // 检查，让界面拿到经过原生效果链验证的最终状态，而不是等待下一分钟调度。
      if (enableRequested && runtime.effectiveEnabled) {
        runBlurRuntimeDiagnostic({ reason: 'settings-change', now: Date.now() })
        snapshot = getResolvedSettingsSnapshot()
        runtime = snapshot.runtime.blur
      }

      if (enableRequested && !runtime.effectiveEnabled && suspendedWallpaper) {
        snapshot = restoreSuspendedWallpaper(suspendedWallpaper)
        runtime = snapshot.runtime.blur
      }
      return {
        success: !enableRequested || runtime.effectiveEnabled,
        config: { ...readBlurState().config },
        runtime,
        error: initializationResult?.error ?? runtime.error,
        nativeError: initializationResult?.nativeError ?? runtime.nativeError
      }
    } finally {
      blurSettingsRequestsInFlight = Math.max(0, blurSettingsRequestsInFlight - 1)
      if (blurSettingsRequestsInFlight === 0) notifySettled()
    }
  }

  function activateWallpaper({ id }) {
    const record = markWallpaperUsed(id)
    const previousFailureState = {
      failed: readBlurState().failed,
      error: readBlurState().error,
      nativeError: readBlurState().nativeError,
      diagnostic: { ...readBlurState().diagnostic }
    }
    const previousBlurRequestRevision = blurConfigRequestRevision
    const previousWallpaperActivationRevision = wallpaperActivationRevision

    // 三个互斥设置在同一个 SQLite 事务中提交，不能先关玻璃再单独开壁纸。
    // 同时使任何尚在等待壁纸退场的旧毛玻璃请求失效。
    wallpaperActivationRevision += 1
    blurConfigRequestRevision += 1
    clearFailure()
    updateBlurDiagnostic(
      { status: 'disabled', lastCheckedAt: Date.now(), message: '系统毛玻璃未启用' },
      { notify: false }
    )
    try {
      const snapshot = persistSettingValues([
        { id: 'blur.enabled', value: false },
        { id: 'wallpaper.enabled', value: true },
        { id: 'wallpaper.activeId', value: record.id }
      ])
      return { record, snapshot }
    } catch (error) {
      restoreFailure(previousFailureState)
      blurConfigRequestRevision = previousBlurRequestRevision
      wallpaperActivationRevision = previousWallpaperActivationRevision
      throw error
    }
  }

  async function deleteWallpaper({ id }) {
    const parsedId = Number(id)
    const usedBy = getWallpaperUsage(parsedId)
    const deleted = await deleteWallpaperVersion(parsedId, {
      clearSelectionForWindows: usedBy.map(getViewSettingsScope)
    })
    if (deleted && usedBy.includes(getViewMode())) {
      refreshResolvedSettings({ incrementRevision: true })
      broadcastSettingsChanged()
    }
    return deleted
  }
  return {
    setBlur: (config) => runRequest(() => setBlur(config)),
    activateWallpaper: (payload) => runRequest(() => activateWallpaper(payload)),
    disableWallpaper: () => runRequest(() => persistWallpaperState({ enabled: false })),
    deleteWallpaper: (payload) => runRequest(() => deleteWallpaper(payload)),
    saveWallpaper: (payload) => runRequest(() => saveWallpaperVersion(payload)),
    listWallpaperLibraryRecords,
    isInFlight: () => blurSettingsRequestsInFlight > 0,
    preventNewRequests: () => {
      stopped = true
    },
    settled: () =>
      requests.size ? new Promise((resolve) => settlementWaiters.add(resolve)) : Promise.resolve(),
    snapshot: () => ({
      stopped,
      pendingRequests: requests.size,
      blurInFlight: blurSettingsRequestsInFlight,
      blurRevision: blurConfigRequestRevision,
      wallpaperRevision: wallpaperActivationRevision
    })
  }
}
