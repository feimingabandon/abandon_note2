import { serializeSetting, VIEW_MODES } from '../../shared/settings-schema.js'
import { isSettingsSnapshot, sameSettingsSource } from '../../shared/settings-receipt.js'
import { randomUUID } from 'node:crypto'
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
  refreshResolvedSettings,
  getResolvedSettingsSnapshot,
  broadcastSettingsChanged,
  beginWallpaperRetirement,
  persistSettingValues,
  readBlurState,
  setRequestedConfig,
  clearFailure,
  disableConfig,
  restoreFailure,
  initializeBlurRuntime,
  updateBlurDiagnostic,
  runBlurRuntimeDiagnostic,
  applicationOwnsBlurDiagnostic = false,
  notifySettled
}) {
  const receiptMetadata = (receipt) =>
    Object.fromEntries(
      ['persistence', 'application', 'verification', 'delivery']
        .filter((key) => receipt?.[key] !== undefined)
        .map((key) => [key, receipt[key]])
    )
  const unavailableReceipt = (receipt, error) => ({
    kind: 'settings-saved',
    source: receipt?.source ?? null,
    ...receiptMetadata(receipt),
    persistence: receipt?.persistence || { status: 'saved', commitId: randomUUID() },
    snapshot: null,
    snapshotError: { message: error?.message || String(error) }
  })
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
  let activeRetirement = null
  let suspendedWallpaper = null

  const sourceFor = (operation) =>
    operation.context?.source ?? getResolvedSettingsSnapshot()?.source ?? null
  const operationCurrent = (operation, revision, wallpaperRevision) =>
    !stopped &&
    (!operation.isCurrent || operation.isCurrent()) &&
    revision === blurConfigRequestRevision &&
    wallpaperRevision === wallpaperActivationRevision
  const canonicalOnly = (snapshot) => {
    const canonical = { ...snapshot }
    for (const key of [
      'persistence',
      'application',
      'verification',
      'delivery',
      'applicationState'
    ])
      delete canonical[key]
    return canonical
  }
  const effectsFor = (suspended, reason = 'not-required') => ({
    suspension: suspended?.receipt ?? null,
    compensation: suspended?.compensation ?? { status: 'skipped', reason }
  })
  function cancelRetirement(reason) {
    activeRetirement?.cancel(reason)
    activeRetirement = null
  }
  function beginRetirement(source) {
    const retirement = beginWallpaperRetirement(source)
    activeRetirement = retirement
    void retirement.finished.then(() => {
      if (activeRetirement === retirement) activeRetirement = null
    })
    return retirement
  }

  function assertCurrentOperation(operation) {
    if (operation.isCurrent && !operation.isCurrent())
      throw Object.assign(new Error('设置请求所属页面已失效，请在当前页面重试'), {
        code: 'SETTINGS_SOURCE_EXPIRED'
      })
  }

  function persistWallpaperState(
    { enabled, activeId = getSettings().wallpaper.activeId },
    operation = {}
  ) {
    assertCurrentOperation(operation)
    return persistSettingValues(
      [
        { id: 'wallpaper.enabled', value: Boolean(enabled) },
        { id: 'wallpaper.activeId', value: activeId }
      ],
      { applicationContext: operation.context }
    )
  }

  function deactivateWallpaperForGlass(source, operation) {
    if (
      suspendedWallpaper &&
      (!sameSettingsSource(suspendedWallpaper.source, source) ||
        suspendedWallpaper.wallpaperRevision !== wallpaperActivationRevision)
    )
      suspendedWallpaper = null
    if (!getSettings().wallpaper.enabled) return suspendedWallpaper
    assertCurrentOperation(operation)
    const suspended = {
      activeId: getSettings().wallpaper.activeId,
      source,
      wallpaperRevision: wallpaperActivationRevision,
      compensation: null
    }
    setSettingsBatch(source.scope, [serializeSetting('wallpaper.enabled', false)])
    // This receipt belongs only to the successfully committed wallpaper SQL,
    // never to the blur intent which is still waiting for its visual barrier.
    suspended.receipt = {
      kind: 'settings-saved',
      source: { ...source },
      persistence: { status: 'saved', commitId: randomUUID() },
      ids: ['wallpaper.enabled'],
      snapshot: null
    }
    suspendedWallpaper = suspended
    try {
      refreshResolvedSettings({ incrementRevision: true })
      const snapshot = getResolvedSettingsSnapshot()
      broadcastSettingsChanged(snapshot)
    } catch (error) {
      // Suspension SQL is committed. Continue the original blur write using its
      // captured request, rather than reporting this read/delivery as SQL failure.
      suspended.receipt.application = {
        status: 'failed',
        error: { message: error?.message || String(error) }
      }
    }
    return suspended
  }

  async function restoreSuspendedWallpaper(suspended, operation, revision, wallpaperRevision) {
    if (
      !suspended ||
      suspendedWallpaper !== suspended ||
      !operationCurrent(operation, revision, wallpaperRevision) ||
      !sameSettingsSource(suspended.source, sourceFor(operation))
    )
      return null
    if (getSettings().blur.enabled) {
      // A previous blur may already have committed while its application
      // receipt is pending. A later failed probe must not overlay that glass.
      suspended.compensation = { status: 'skipped', reason: 'blur-already-enabled' }
      return null
    }
    // Claim once before starting post-commit application. A successor may own a
    // new suspension while this receipt is still being delivered.
    suspendedWallpaper = null
    try {
      const receipt = await persistWallpaperState(
        { enabled: true, activeId: suspended.activeId },
        operation
      )
      suspended.compensation = receipt
      return receipt
    } catch (error) {
      suspended.compensation = {
        status: 'failed',
        error: { message: error?.message || String(error), code: error?.code }
      }
      return null
    }
  }

  async function retirementFailure({
    retirement,
    source,
    suspended,
    operation,
    revision,
    wallpaperRevision
  }) {
    if (operationCurrent(operation, revision, wallpaperRevision))
      await restoreSuspendedWallpaper(suspended, operation, revision, wallpaperRevision)
    let snapshot = null
    let snapshotError = { message: '当前请求或页面已失效，未确认实际背景状态' }
    if (operationCurrent(operation, revision, wallpaperRevision)) {
      try {
        refreshResolvedSettings({ notifyResolved: false })
        const actual = getResolvedSettingsSnapshot()
        if (
          operationCurrent(operation, revision, wallpaperRevision) &&
          isSettingsSnapshot(actual) &&
          sameSettingsSource(actual.source, source) &&
          typeof actual.values.blur?.enabled === 'boolean' &&
          ['radius', 'saturation', 'cornerRadius'].every((key) =>
            Number.isFinite(actual.values.blur[key])
          ) &&
          typeof actual.runtime?.blur?.effectiveEnabled === 'boolean'
        ) {
          snapshot = canonicalOnly(actual)
          snapshotError = null
        }
      } catch (error) {
        snapshotError = { message: error?.message || String(error) }
      }
    }
    return {
      success: false,
      source,
      persistence: { status: 'unchanged', commitId: null },
      snapshot,
      ...(snapshot
        ? { config: { ...snapshot.values.blur }, runtime: snapshot.runtime.blur }
        : { snapshotError }),
      retirement,
      backgroundEffects: effectsFor(suspended, retirement.reason),
      error: '壁纸退场未确认，未应用本次毛玻璃设置',
      nativeError: null
    }
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

  async function setBlur(config, operation = {}) {
    blurSettingsRequestsInFlight += 1
    try {
      assertCurrentOperation(operation)
      const requestRevision = ++blurConfigRequestRevision
      const activationRevision = wallpaperActivationRevision
      const source = sourceFor(operation)
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
      const enableRequested = requestedConfig.enabled
      let suspended = suspendedWallpaper
      if (enableRequested) {
        let retirement
        try {
          // Install and send before the closing settings broadcast. Even an
          // already disabled DB value can still have a real leaving element.
          retirement = beginRetirement(source)
        } catch (error) {
          return await retirementFailure({
            retirement: { status: 'failed', reason: error?.code || 'send-failed' },
            source,
            suspended,
            operation,
            revision: requestRevision,
            wallpaperRevision: activationRevision
          })
        }
        try {
          suspended = deactivateWallpaperForGlass(source, operation)
        } catch (error) {
          retirement.cancel('suspension-failed')
          throw error
        }
        const result = await retirement.finished
        if (
          result.status !== 'completed' ||
          !['left', 'absent'].includes(result.outcome) ||
          !operationCurrent(operation, requestRevision, activationRevision)
        )
          return await retirementFailure({
            retirement: operationCurrent(operation, requestRevision, activationRevision)
              ? result
              : { status: 'cancelled', reason: 'superseded', id: retirement.id },
            source,
            suspended,
            operation,
            revision: requestRevision,
            wallpaperRevision: activationRevision
          })
      } else {
        cancelRetirement('blur-disabled')
      }
      // Suspension refreshes DB-backed configuration; only the still-current
      // request may restore its captured intent after real visual completion.
      setRequestedConfig(requestedConfig)
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

      assertCurrentOperation(operation)
      let snapshot = await persistSettingValues(
        [
          { id: 'blur.enabled', value: readBlurState().config.enabled },
          { id: 'blur.radius', value: readBlurState().config.radius },
          { id: 'blur.saturation', value: readBlurState().config.saturation },
          { id: 'blur.cornerRadius', value: readBlurState().config.cornerRadius }
        ],
        // 新初始化路径已经在 initializeBlurRuntime 中提交过完整配置。
        { applyBlurRuntime: !initializationResult?.success, applicationContext: operation.context }
      )
      if (
        !isSettingsSnapshot(snapshot) ||
        !operationCurrent(operation, requestRevision, activationRevision)
      ) {
        return {
          success: false,
          snapshot,
          error: snapshot?.snapshotError?.message || '设置已保存，当前应用状态尚未确认',
          nativeError: initializationResult?.nativeError ?? null,
          backgroundEffects: effectsFor(suspended, 'superseded')
        }
      }
      let runtime = snapshot.runtime.blur

      // 重新启用时原生引擎通常已经初始化，因此不会再次经过
      // initializeBlurRuntime() 更新诊断状态。配置实际生效后立即执行完整健康
      // 检查，让界面拿到经过原生效果链验证的最终状态，而不是等待下一分钟调度。
      if (!applicationOwnsBlurDiagnostic && enableRequested && runtime.effectiveEnabled) {
        try {
          runBlurRuntimeDiagnostic({ reason: 'settings-change', now: Date.now() })
          snapshot = { ...getResolvedSettingsSnapshot(), ...receiptMetadata(snapshot) }
          runtime = snapshot.runtime.blur
        } catch (error) {
          return {
            success: false,
            config: { ...readBlurState().config },
            runtime,
            snapshot: unavailableReceipt(snapshot, error),
            error: error.message,
            nativeError: initializationResult?.nativeError ?? null,
            backgroundEffects: effectsFor(suspended)
          }
        }
      }

      if ((!enableRequested || !runtime.effectiveEnabled) && suspended) {
        const blurReceipt = snapshot
        const restored = await restoreSuspendedWallpaper(
          suspended,
          operation,
          requestRevision,
          activationRevision
        )
        if (!operationCurrent(operation, requestRevision, activationRevision))
          return {
            success: false,
            snapshot: blurReceipt,
            error: '背景请求已被后续操作取代，当前应用状态尚未确认',
            nativeError: initializationResult?.nativeError ?? null,
            backgroundEffects: effectsFor(suspended, 'superseded')
          }
        if (restored && isSettingsSnapshot(restored)) {
          snapshot = { ...canonicalOnly(restored), ...receiptMetadata(blurReceipt) }
          runtime = snapshot.runtime.blur
        } else if (suspended.compensation?.status === 'failed' || restored) {
          return {
            success: false,
            snapshot: unavailableReceipt(
              blurReceipt,
              suspended.compensation?.error || restored?.snapshotError || '壁纸恢复状态待确认'
            ),
            error: '壁纸恢复未完成，请检查当前背景设置',
            nativeError: initializationResult?.nativeError ?? null,
            backgroundEffects: effectsFor(suspended)
          }
        }
      } else if (suspendedWallpaper === suspended) {
        suspendedWallpaper = null
      }
      return {
        success: !enableRequested || runtime.effectiveEnabled,
        config: { ...readBlurState().config },
        runtime,
        snapshot,
        error: initializationResult?.error ?? runtime.error,
        nativeError: initializationResult?.nativeError ?? runtime.nativeError,
        backgroundEffects: effectsFor(suspended)
      }
    } finally {
      blurSettingsRequestsInFlight = Math.max(0, blurSettingsRequestsInFlight - 1)
      if (blurSettingsRequestsInFlight === 0) notifySettled()
    }
  }

  function activateWallpaper({ id }, operation = {}) {
    assertCurrentOperation(operation)
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
      const snapshot = persistSettingValues(
        [
          { id: 'blur.enabled', value: false },
          { id: 'wallpaper.enabled', value: true },
          { id: 'wallpaper.activeId', value: record.id }
        ],
        { applicationContext: operation.context }
      )
      suspendedWallpaper = null
      cancelRetirement('wallpaper-activated')
      return snapshot && typeof snapshot.then === 'function'
        ? Promise.resolve(snapshot).then((receipt) => ({ record, snapshot: receipt }))
        : { record, snapshot }
    } catch (error) {
      restoreFailure(previousFailureState)
      blurConfigRequestRevision = previousBlurRequestRevision
      wallpaperActivationRevision = previousWallpaperActivationRevision
      throw error
    }
  }

  function disableWallpaper(operation = {}) {
    assertCurrentOperation(operation)
    const previousBlurRevision = blurConfigRequestRevision
    const previousWallpaperRevision = wallpaperActivationRevision
    blurConfigRequestRevision += 1
    wallpaperActivationRevision += 1
    try {
      const receipt = persistWallpaperState({ enabled: false }, operation)
      suspendedWallpaper = null
      cancelRetirement('wallpaper-disabled')
      return receipt
    } catch (error) {
      blurConfigRequestRevision = previousBlurRevision
      wallpaperActivationRevision = previousWallpaperRevision
      throw error
    }
  }

  async function deleteWallpaper({ id }) {
    const parsedId = Number(id)
    const usedBy = getWallpaperUsage(parsedId)
    const deleted = await deleteWallpaperVersion(parsedId, {
      clearSelectionForWindows: usedBy.map(getViewSettingsScope)
    })
    if (deleted && suspendedWallpaper?.activeId === parsedId) {
      // The library deletion committed. A late blur completion must not
      // resurrect a selection whose underlying wallpaper no longer exists.
      wallpaperActivationRevision += 1
      blurConfigRequestRevision += 1
      suspendedWallpaper = null
      cancelRetirement('wallpaper-deleted')
    }
    if (deleted && usedBy.includes(getViewMode())) {
      refreshResolvedSettings({ incrementRevision: true })
      broadcastSettingsChanged()
    }
    return deleted
  }
  return {
    setBlur: (config, operation) => runRequest(() => setBlur(config, operation)),
    activateWallpaper: (payload, operation) =>
      runRequest(() => activateWallpaper(payload, operation)),
    disableWallpaper: (operation) => runRequest(() => disableWallpaper(operation)),
    deleteWallpaper: (payload) => runRequest(() => deleteWallpaper(payload)),
    saveWallpaper: (payload) => runRequest(() => saveWallpaperVersion(payload)),
    listWallpaperLibraryRecords,
    isInFlight: () => blurSettingsRequestsInFlight > 0,
    preventNewRequests: () => {
      stopped = true
      cancelRetirement('shutdown')
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
