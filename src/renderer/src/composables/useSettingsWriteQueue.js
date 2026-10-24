import { nextTick, readonly, ref, watch } from 'vue'
import { DOCK_EDGES, DOCK_REVEAL_HANDLE_MODES } from '../../../shared/settings-schema.js'
import { parseSettingsReceipt } from '../../../shared/settings-receipt.js'
import { getSettingsSnapshotStore } from '../utils/settingsSnapshots.js'
import { getSettingsApplicationStateStore } from '../utils/settingsApplicationState.js'

/** One owner for pending writes, native response generations and reset/dispose barriers. */
export function useSettingsWriteQueue({
  api,
  blur,
  autoStart,
  dock,
  snapshot,
  showMessage,
  reportEvidence = () => {},
  warn = (...args) => console.warn(...args)
}) {
  const isResetting = ref(false)
  const isLeaving = ref(false)
  const snapshotUnavailable = ref(false)
  const hasPendingWrites = ref(false)
  const hasUnconfirmedWrites = ref(false)
  const awaitingCanonical = ref(false)
  const applicationState = ref(null)
  const applicationAvailability = ref('unknown')
  const applicationError = ref(null)
  const applicationReading = ref(false)
  const applicationBusy = ref(false)
  const applicationTasks = new Set()
  let applicationGeneration = 0
  const domains = ['setting', 'blur', 'autoStart', 'dock']
  const inFlight = Object.fromEntries(domains.map((domain) => [domain, new Set()]))
  const ready = { setting: false, blur: false, autoStart: false, dock: false }
  const suppressed = Object.fromEntries(domains.map((domain) => [domain, 0]))
  const revision = { blur: 0, autoStart: 0, dock: 0, snapshot: 0 }
  const pending = new Map()
  const timers = new Map()
  const settingRequests = new Map()
  const failedSettings = ref([])
  // A native failure is safe to leave only after its actual state was read back and restored.
  const unconfirmedWrites = new Map()
  let leaveOperation = null
  let blurTimer = null
  let blurEnableFeedbackPending = false
  let hasLoadedSnapshot = false
  let hasStartedLoading = false
  let disposed = false
  const stopWatchers = []
  const snapshots = getSettingsSnapshotStore(api)
  const applications = getSettingsApplicationStateStore(api)
  const snapshotOwner = {}
  const domainProtections = new Map()
  const invalidatedDomains = new Set()
  let snapshotNotifications = 0
  let stopSnapshots = null
  let stopApplications = null

  function publishWriteState() {
    if (disposed) return
    hasPendingWrites.value = Boolean(
      pending.size ||
      blurTimer !== null ||
      domainProtections.size ||
      unconfirmedWrites.size ||
      Object.values(inFlight).some((tasks) => tasks.size)
    )
    awaitingCanonical.value = snapshots.status().awaitingCanonical
    hasUnconfirmedWrites.value = unconfirmedWrites.size > 0
  }

  function acceptApplicationReceipt(result) {
    if (disposed) return
    const state = result?.applicationState || result?.snapshot?.applicationState
    if (state) applications.accept(state)
  }

  function refreshSettingsApplicationState() {
    if (disposed) return Promise.resolve(null)
    applications.bindSource(snapshots.latest()?.source)
    return applications.read()
  }

  function retrySettingsApplication(targets) {
    if (
      disposed ||
      isResetting.value ||
      isLeaving.value ||
      leaveOperation ||
      !ready.setting ||
      suppressed.setting !== 0 ||
      applicationBusy.value ||
      hasPendingWrites.value
    )
      return Promise.resolve()
    const token = applicationGeneration
    applicationBusy.value = true
    const task = applications.retry(targets, {
      isCurrent: () => !disposed && !isResetting.value && token === applicationGeneration
    })
    applicationTasks.add(task)
    const complete = () => {
      applicationTasks.delete(task)
      if (!disposed && token === applicationGeneration) applicationBusy.value = false
    }
    task.then(complete, complete)
    return task
  }

  function canDispatch(domain) {
    return (
      !disposed &&
      !isResetting.value &&
      !snapshotUnavailable.value &&
      ready[domain] &&
      suppressed[domain] === 0
    )
  }

  function canWrite(domain = 'setting') {
    return !isLeaving.value && canDispatch(domain)
  }

  function isInFlight(domain) {
    return inFlight[domain].size > 0
  }

  function isProtected(domain, id) {
    if (domain === 'setting') return id === undefined ? pending.size > 0 : pending.has(id)
    return (
      domainProtections.has(domain) ||
      (domain === 'blur' && blurTimer !== null) ||
      (isInFlight(domain) && !invalidatedDomains.has(domain)) ||
      unconfirmedWrites.has(domain)
    )
  }

  function protectDomain(domain, values) {
    invalidatedDomains.delete(domain)
    const previous = domainProtections.get(domain)
    const protection = { release: null }
    domainProtections.set(domain, protection)
    protection.release = snapshots.protectDomain(snapshotOwner, domain, values)
    previous?.release?.()
    publishWriteState()
    return protection
  }

  function releaseDomain(domain, protection) {
    if (domainProtections.get(domain) === protection) domainProtections.delete(domain)
    protection?.release?.()
    publishWriteState()
  }

  function receiptError(receipt, fallback = '设置保存结果尚未确认') {
    return Object.assign(new Error(receipt.error?.message || fallback), receipt.error || {})
  }

  function settleDomain(domain, protection, result) {
    const receipt = parseSettingsReceipt(result, { source: snapshots.latest()?.source })
    if (receipt.valid) acceptApplicationReceipt(result)
    if (receipt.saved && domainProtections.get(domain) === protection)
      domainProtections.delete(domain)
    return snapshots.settleWrite(protection.release, result)
  }

  function current(domain, token) {
    return !disposed && !isResetting.value && revision[domain] === token
  }

  function track(domain, request) {
    const task = Promise.resolve(request)
    inFlight[domain].add(task)
    publishWriteState()
    task.then(
      () => {
        inFlight[domain].delete(task)
        publishWriteState()
      },
      () => {
        inFlight[domain].delete(task)
        publishWriteState()
      }
    )
    return task
  }

  async function withoutWrite(domain, assign) {
    suppressed[domain] += 1
    try {
      assign()
      await nextTick()
    } finally {
      suppressed[domain] -= 1
    }
  }

  async function assignSnapshot(result) {
    if (!result?.values) {
      snapshotUnavailable.value = true
      return
    }
    snapshotUnavailable.value = false
    for (const domain of domains) suppressed[domain] += 1
    try {
      if (!disposed) snapshot.assign(result)
      await nextTick()
    } finally {
      for (const domain of domains) suppressed[domain] -= 1
    }
  }

  function receiveSnapshot(result) {
    // A transport can emit synchronously while subscribing. Form callbacks may
    // refer back to the queue, so first assignment belongs to the load barrier.
    if (disposed || !hasStartedLoading) return
    applications.bindSource(result?.source)
    pruneInactiveIntents()
    snapshotNotifications += 1
    publishWriteState()
    if (!result?.values) {
      snapshotUnavailable.value = true
      return
    }
    void assignSnapshot(result).catch((error) => warn('[SettingsPanel] 同步设置快照失败:', error))
  }

  function publishSettingFailures() {
    if (disposed) return
    publishWriteState()
    failedSettings.value = [...pending.values()]
      .filter((entry) => entry.error)
      .map((entry) => ({ id: entry.id, error: entry.error.message || String(entry.error) }))
  }

  function pruneInactiveIntents() {
    for (const [id, entry] of pending) {
      if (entry.release.isActive()) continue
      entry.cancelled = true
      clearTimeout(timers.get(id))
      timers.delete(id)
      pending.delete(id)
    }
    publishSettingFailures()
    for (const [domain, protection] of domainProtections) {
      if (protection.release.isActive()) continue
      // A confirmed reset can revoke another participant's older preview.
      // Its timer and late native reply must not overwrite the reset state.
      revision[domain] += 1
      invalidatedDomains.add(domain)
      unconfirmedWrites.delete(domain)
      if (domain === 'blur') cancelPendingBlurConfig()
      releaseDomain(domain, protection)
    }
  }

  function queueSettingIntent({ id, value }) {
    const previous = pending.get(id)
    if (previous && !previous.started) previous.cancelled = true
    clearTimeout(timers.get(id))
    timers.delete(id)
    const entry = { id, value, error: null, task: null, started: false, cancelled: false }
    pending.set(id, entry)
    entry.release = snapshots.protectSetting(snapshotOwner, id, value)
    previous?.release?.()
    publishSettingFailures()
    return entry
  }

  function persistUnchecked(entry) {
    if (entry.task) return entry.task
    const previous = settingRequests.get(entry.id)
    const ownsLatestIntent = () =>
      !disposed && !isResetting.value && pending.get(entry.id) === entry && entry.release.isActive()
    const request = (async () => {
      try {
        // Serialize only the same ID: an old disk write cannot finish after its replacement.
        if (previous) await previous.catch(() => {})
        if (entry.cancelled || (!entry.release.isActive() && !(disposed && entry.drainOnDispose)))
          return
        entry.started = true
        reportEvidence('settings.save-requested', { id: entry.id, source: 'settings-panel' })
        const result = await api.setSettingValue(entry.id, entry.value)
        const receipt = parseSettingsReceipt(result, { source: snapshots.latest()?.source })
        if (!receipt.saved) throw receiptError(receipt)
        acceptApplicationReceipt(result)
        // Settlement may notify synchronously. Remove only this intent before
        // publishing; an older A receipt must leave the replacement B protected.
        if (pending.get(entry.id) === entry) {
          pending.delete(entry.id)
          publishSettingFailures()
        }
        snapshots.settleWrite(entry.release, result)
        return result
      } catch (error) {
        if (ownsLatestIntent()) {
          entry.error = error
          publishSettingFailures()
          warn(`[SettingsPanel] 保存设置 ${entry.id} 失败:`, error)
          showMessage('error', '保存设置失败，请在设置中重试未保存的修改', 4000)
        }
        throw error
      }
    })()
    entry.task = request
    settingRequests.set(entry.id, request)
    const release = () => {
      if (settingRequests.get(entry.id) === request) settingRequests.delete(entry.id)
      if (entry.task === request) entry.task = null
    }
    request.then(release, release)
    return track('setting', request)
  }

  function persistSetting(value) {
    return canWrite() ? persistUnchecked(queueSettingIntent(value)) : Promise.resolve()
  }

  function debouncedSave(id, value) {
    if (!canWrite()) return
    reportEvidence('settings.save-queued', {
      id,
      delayMs: 300,
      replacesPending: pending.has(id)
    })
    const entry = queueSettingIntent({ id, value })
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        if (pending.get(id) !== entry || !canWrite()) return
        void persistUnchecked(entry).catch(() => {})
      }, 300)
    )
  }

  function clearPendingSettingSaves({ cancelDispatched = true } = {}) {
    if (pending.size)
      reportEvidence('settings.queue-cleared', {
        ids: [...pending.keys()],
        reason: 'flush-or-reset'
      })
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const entry of pending.values()) {
      if (cancelDispatched || !entry.task) entry.cancelled = true
      entry.release()
    }
    pending.clear()
    failedSettings.value = []
    publishWriteState()
  }

  async function flushPendingSettingSaves() {
    const values = [...pending.values()]
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    if (disposed || isResetting.value) return
    const results = await Promise.allSettled(
      values.map(
        (entry) => entry.task || (entry.error ? Promise.resolve() : persistUnchecked(entry))
      )
    )
    const failed = [...pending.values()].find((entry) => entry.error)
    if (failed) throw failed.error
    // Forced unmount still reports a dispatched write failure to its caller without late UI changes.
    if (disposed) {
      const rejected = results.find((result) => result.status === 'rejected')
      if (rejected) throw rejected.reason
    }
  }

  async function retryFailedSettingSaves() {
    if (!canWrite()) return
    await waitForInFlightWrites()
    if (!canWrite()) return
    const values = [...pending.values()].filter((entry) => entry.error)
    for (const entry of values) entry.error = null
    publishSettingFailures()
    await Promise.allSettled(values.map(persistUnchecked))
    const failed = [...pending.values()].find((entry) => entry.error)
    if (failed) throw failed.error
  }

  function syncBlurConfig() {
    if (!canWrite('blur')) return Promise.resolve()
    return dispatchBlurConfig()
  }

  function dispatchBlurConfig() {
    const token = ++revision.blur
    unconfirmedWrites.delete('blur')
    const reportEnable = blurEnableFeedbackPending
    blurEnableFeedbackPending = false
    const config = {
      enabled: blur.enabled.value,
      radius: blur.radius.value,
      saturation: blur.saturation.value,
      cornerRadius: blur.cornerRadius.value
    }
    const protection = protectDomain('blur', { blur: config })
    const request = (async () => {
      try {
        const result = await api.setBlurConfig(config)
        if (result?.success === false && result.retirement) {
          // A visual failure did not commit this blur intent. Its independently
          // saved wallpaper effects must never settle our optimistic blur lease.
          if (!current('blur', token)) return result
          const receipt = parseSettingsReceipt(result, { source: snapshots.latest()?.source })
          const canonical = receipt.canonical
          const actual = canonical?.values?.blur
          const runtime = canonical?.runtime?.blur
          const confirmed =
            receipt.valid &&
            receipt.persistence?.status === 'unchanged' &&
            isCompleteBlurConfig(actual) &&
            isCompleteBlurConfig(result.config) &&
            ['enabled', 'radius', 'saturation', 'cornerRadius'].every(
              (key) => result.config[key] === actual[key]
            ) &&
            typeof runtime?.effectiveEnabled === 'boolean' &&
            result.runtime?.effectiveEnabled === runtime.effectiveEnabled
          if (confirmed) {
            releaseDomain('blur', protection)
            snapshots.acceptCommitted(canonical, { reconcile: true })
            const latest = snapshots.latest()
            if (
              current('blur', token) &&
              latest?.source?.token === canonical.source.token &&
              latest?.source?.scope === canonical.source.scope &&
              isCompleteBlurConfig(latest?.values?.blur)
            )
              await assignBlurConfig(latest.values.blur)
            if (!current('blur', token)) return result
            unconfirmedWrites.delete('blur')
          } else {
            unconfirmedWrites.set('blur', new Error(result.error || '毛玻璃实际设置尚未确认'))
          }
          blur.error.value = result.error || '壁纸退场未确认，未应用本次毛玻璃设置'
          if (reportEnable) showMessage('error', `毛玻璃启用失败：${blur.error.value}`, 5000)
          publishWriteState()
          return result
        }
        const settlement = settleDomain('blur', protection, result)
        if (!current('blur', token)) {
          return result
        }
        if (settlement.saved && !settlement.settled) return result
        const actualConfig = result?.config || settlement.canonical?.values?.blur
        const completeActualConfig = isCompleteBlurConfig(actualConfig)
        const confirmedRollback =
          result?.success === false &&
          completeActualConfig &&
          typeof result?.runtime?.effectiveEnabled === 'boolean'
        if ((settlement.saved || confirmedRollback) && completeActualConfig) {
          await assignBlurConfig(actualConfig)
        } else if (actualConfig && actualConfig.enabled !== blur.enabled.value) {
          await withoutWrite('blur', () => {
            blur.enabled.value = Boolean(actualConfig.enabled)
          })
        }
        if (!current('blur', token)) {
          return result
        }
        if (result?.runtime) blur.error.value = result.error ?? result.runtime.error ?? null
        if (!settlement.saved && !confirmedRollback) {
          unconfirmedWrites.set(
            'blur',
            new Error(result?.error || result?.runtime?.error || '毛玻璃设置尚未确认保存')
          )
        } else {
          unconfirmedWrites.delete('blur')
          if (!settlement.saved) releaseDomain('blur', protection)
        }
        // A newer canonical broadcast can already supersede this normalized
        // reply. The panel still guards this in-flight native domain, so the
        // queue also converges its refs after releasing its own preview.
        const committed = settlement.canonical
        // Without canonical values the store retains saved intent only. A leaf's
        // observed rollback/disable must not be overwritten by that projection.
        const latest = committed && settlement.settled ? snapshots.latest() : null
        if (
          current('blur', token) &&
          !domainProtections.has('blur') &&
          latest?.source?.token === committed?.source?.token &&
          latest?.source?.scope === committed?.source?.scope &&
          latest?.revision >= committed?.revision &&
          isCompleteBlurConfig(latest?.values?.blur)
        ) {
          await assignBlurConfig(latest.values.blur)
        }
        if (!current('blur', token)) return result
        if (reportEnable && !result?.success) {
          const codeSuffix = result?.nativeError?.code
            ? `（错误码 ${result.nativeError.code}）`
            : ''
          showMessage(
            'error',
            `毛玻璃启用失败：${result?.error || result?.runtime?.error || '原生模糊引擎不可用'}${codeSuffix}`,
            5000
          )
        }
        return result
      } catch (error) {
        if (!current('blur', token)) return
        unconfirmedWrites.set('blur', error)
        warn('[SettingsPanel] 同步模糊配置失败:', error)
        if (reportEnable && blur.enabled.value) {
          showMessage('error', `毛玻璃启用失败：${error.message || '主进程通信失败'}`, 5000)
        }
      }
    })()
    return track('blur', request)
  }

  function isCompleteBlurConfig(config) {
    return (
      typeof config?.enabled === 'boolean' &&
      ['radius', 'saturation', 'cornerRadius'].every((key) => Number.isFinite(config[key]))
    )
  }

  function assignBlurConfig(config) {
    return withoutWrite('blur', () => {
      for (const key of ['enabled', 'radius', 'saturation', 'cornerRadius'])
        blur[key].value = config[key]
    })
  }

  function debouncedSyncBlur() {
    if (!canWrite('blur')) return
    // Invalidate an older response immediately when a newer user intent is queued.
    revision.blur += 1
    unconfirmedWrites.delete('blur')
    protectDomain('blur', {
      blur: {
        enabled: blur.enabled.value,
        radius: blur.radius.value,
        saturation: blur.saturation.value,
        cornerRadius: blur.cornerRadius.value
      }
    })
    clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      blurTimer = null
      void syncBlurConfig()
    }, 150)
    publishWriteState()
  }

  function flushPendingBlurConfig() {
    if (blurTimer === null) return Promise.resolve()
    clearTimeout(blurTimer)
    blurTimer = null
    // Leaving seals new input, but the previously accepted debounced value still belongs to us.
    return canDispatch('blur') ? dispatchBlurConfig() : Promise.resolve()
  }

  function cancelPendingBlurConfig() {
    clearTimeout(blurTimer)
    blurTimer = null
    blurEnableFeedbackPending = false
    publishWriteState()
  }

  async function saveAutoStart(value) {
    if (!canWrite('autoStart')) return
    const token = ++revision.autoStart
    unconfirmedWrites.delete('autoStart')
    const protection = protectDomain('autoStart', {})
    const task = (async () => {
      try {
        const verified = await api.setAutoStart(value)
        if (!current('autoStart', token)) return
        if (typeof verified !== 'boolean') throw new Error('开机自启状态回读无效')
        if (verified === value) {
          autoStart.error.value = null
          showMessage('success', value ? '开机自启已开启' : '开机自启已关闭')
        } else {
          await withoutWrite('autoStart', () => {
            autoStart.enabled.value = Boolean(verified)
          })
          if (!current('autoStart', token)) return
          autoStart.error.value = value
            ? '开启失败，请检查系统安全软件是否拦截了开机启动权限'
            : '关闭失败，请检查系统权限设置'
        }
        releaseDomain('autoStart', protection)
      } catch (error) {
        if (!current('autoStart', token)) return
        unconfirmedWrites.set('autoStart', error)
        warn('[SettingsPanel] 设置开机自启失败:', error)
        try {
          const actual = await api.verifyAutoStart()
          if (!current('autoStart', token)) return
          if (typeof actual?.value !== 'boolean' || actual.error)
            throw new Error(actual?.error || '开机自启状态回读无效')
          await withoutWrite('autoStart', () => {
            autoStart.enabled.value = Boolean(actual.value)
          })
          if (current('autoStart', token)) {
            unconfirmedWrites.delete('autoStart')
            releaseDomain('autoStart', protection)
          }
        } catch (verifyError) {
          if (!current('autoStart', token)) return
          warn('[SettingsPanel] 开机自启写入失败后的系统状态回读也失败:', verifyError)
        }
        if (current('autoStart', token)) autoStart.error.value = '设置失败，请重试'
      }
    })()
    return track('autoStart', task)
  }

  function saveDockConfig(config) {
    if (!canWrite('dock')) return Promise.resolve()
    const token = ++revision.dock
    unconfirmedWrites.delete('dock')
    const protection = protectDomain('dock', { dock: config })
    const task = (async () => {
      try {
        const result = await api.setDockConfig(config)
        const settlement = settleDomain('dock', protection, result)
        if (!current('dock', token)) {
          return
        }
        if (!settlement.saved) {
          // Retain the existing readback validation before classifying an
          // incomplete native response as an unconfirmed persistence result.
          assignActualDockConfig(result)
          throw receiptError(settlement, '贴边隐藏设置保存结果尚未确认')
        }
        if (!settlement.settled) return
        unconfirmedWrites.delete('dock')
        if (isCompleteDockConfig(settlement.projection?.values?.dock))
          assignActualDockConfig(settlement.projection)
      } catch (error) {
        if (!current('dock', token)) return
        unconfirmedWrites.set('dock', error)
        warn('[SettingsPanel] 保存贴边隐藏设置失败:', error)
        try {
          // Read actual configuration without our failed optimistic mask. The
          // in-flight/unconfirmed guards still protect the form during recovery.
          releaseDomain('dock', protection)
          const result = await snapshots.read({ allowCachedOnError: false, protectIntents: false })
          if (!current('dock', token)) return
          assignActualDockConfig(result)
          unconfirmedWrites.delete('dock')
        } catch (reloadError) {
          if (current('dock', token)) {
            protectDomain('dock', { dock: config })
            warn('[SettingsPanel] 回读贴边隐藏设置失败:', reloadError)
          }
        }
        if (current('dock', token))
          showMessage(
            'error',
            unconfirmedWrites.has('dock')
              ? '贴边隐藏设置保存失败，无法确认实际配置，请重试'
              : '贴边隐藏设置保存失败，已恢复实际配置',
            4000
          )
      }
    })()
    return track('dock', task)
  }

  function isCompleteDockConfig(config) {
    return (
      Array.isArray(config?.enabledEdges) &&
      config.enabledEdges.every((edge) => DOCK_EDGES.includes(edge)) &&
      Object.values(DOCK_REVEAL_HANDLE_MODES).includes(config.revealHandleMode)
    )
  }

  function assignActualDockConfig(result) {
    const config = result?.values?.dock
    if (!isCompleteDockConfig(config)) throw new Error('贴边隐藏设置回读无效')
    dock.assign(config)
  }

  async function waitForInFlightWrites() {
    // Include recovery reads and nextTick suppression, rather than only raw IPC promises.
    while (applicationTasks.size || Object.values(inFlight).some((tasks) => tasks.size)) {
      await Promise.allSettled([
        ...applicationTasks,
        ...Object.values(inFlight).flatMap((tasks) => [...tasks])
      ])
    }
  }

  function suspend(options) {
    applicationGeneration += 1
    applicationBusy.value = false
    for (const domain of domains) ready[domain] = false
    for (const domain of Object.keys(revision)) revision[domain] += 1
    clearPendingSettingSaves(options)
    cancelPendingBlurConfig()
    unconfirmedWrites.clear()
    for (const [domain, protection] of domainProtections) releaseDomain(domain, protection)
    snapshots.clearOwner(snapshotOwner)
    publishWriteState()
  }

  async function loadSettingsSnapshot() {
    // A participant can mount during preparation, before its first onMounted snapshot load.
    // It must still initialize so cancellation leaves an editable, correctly populated form.
    if (disposed || (leaveOperation && hasLoadedSnapshot)) return
    hasStartedLoading = true
    suspend()
    const token = revision.snapshot
    const notificationsBefore = snapshotNotifications
    try {
      const result = await snapshots.read()
      if (disposed || token !== revision.snapshot) return
      if (snapshotNotifications === notificationsBefore) {
        await assignSnapshot(snapshots.latest() || result)
      }
    } catch (error) {
      if (disposed || token !== revision.snapshot) return
      const latest = snapshots.latest()
      if (snapshots.status().awaitingCanonical && !latest) {
        snapshotUnavailable.value = true
      } else if (snapshotNotifications === notificationsBefore) {
        await assignSnapshot(latest || snapshot.fallback())
      }
      warn(
        snapshots.status().awaitingCanonical && !latest
          ? '[SettingsPanel] 设置已保存但当前值读回不可用，保留待确认状态:'
          : latest
            ? '[SettingsPanel] 加载设置快照失败，保留最新设置:'
            : '[SettingsPanel] 加载设置快照失败，使用共享默认值:',
        error
      )
    }
    await nextTick()
    if (disposed || token !== revision.snapshot) return
    hasLoadedSnapshot = true
    for (const domain of domains) ready[domain] = true
    publishWriteState()
    void refreshSettingsApplicationState().catch((error) =>
      warn('[SettingsPanel] 读取设置应用状态失败:', error)
    )
  }

  async function resetSettings(beforeReset = () => {}) {
    if (disposed || isResetting.value || leaveOperation) return
    const checkpoint = snapshots.captureIntentCheckpoint()
    hasStartedLoading = true
    isResetting.value = true
    suspend()
    beforeReset()
    try {
      await waitForInFlightWrites()
      if (disposed) return
      const result = await api.resetSettings()
      if (disposed) return
      const notificationsBefore = snapshotNotifications
      const settlement = snapshots.settleReset(result, { checkpoint })
      if (!settlement.saved) throw receiptError(settlement, '恢复默认设置结果尚未确认')
      acceptApplicationReceipt(result)
      if (!settlement.settled) return
      if (snapshotNotifications === notificationsBefore) {
        await assignSnapshot(settlement.projection)
      }
      await nextTick()
      if (!disposed) {
        if (settlement.unavailable) showMessage('warning', '默认设置已保存，当前值尚待确认', 4000)
        else if (settlement.application?.status === 'failed')
          showMessage('warning', '默认设置已保存，部分设置应用失败', 4000)
        else if (settlement.application && settlement.application.status !== 'applied')
          showMessage('warning', '默认设置已保存，应用结果尚待确认', 4000)
        else showMessage('success', '已恢复默认设置')
      }
    } catch (error) {
      if (disposed) return
      warn('[SettingsPanel] 恢复默认设置失败:', error)
      showMessage('error', '恢复默认设置失败，请重试', 4000)
      await loadSettingsSnapshot()
    } finally {
      if (!disposed) for (const domain of domains) ready[domain] = true
      isResetting.value = false
      publishWriteState()
    }
  }

  async function flush() {
    const pendingResults = await Promise.allSettled([
      flushPendingSettingSaves(),
      flushPendingBlurConfig()
    ])
    await waitForInFlightWrites()
    const failed = pendingResults.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
    const latestFailure = [...pending.values()].find((entry) => entry.error)
    if (latestFailure) throw latestFailure.error
    const unconfirmed = unconfirmedWrites.values().next().value
    if (unconfirmed) throw unconfirmed
  }

  function leaveCancelled() {
    const error = new Error('页面离开准备已取消')
    error.code = 'PAGE_LEAVE_CANCELLED'
    return error
  }

  function resumeAfterLeave(operationId) {
    if (!leaveOperation || leaveOperation.id !== operationId) return
    leaveOperation = null
    isLeaving.value = false
  }

  function prepareToLeave(operationId) {
    if (leaveOperation?.id === operationId) return leaveOperation.promise
    const operation = { id: operationId, promise: null }
    leaveOperation = operation
    operation.promise = (async () => {
      try {
        // Let existing post-flush form watchers enqueue their final value before sealing input.
        await nextTick()
        if (disposed || leaveOperation !== operation) throw leaveCancelled()
        if (isResetting.value) throw new Error('设置正在恢复默认值，请稍后再离开')
        isLeaving.value = true
        await flush()
        if (disposed || leaveOperation !== operation) throw leaveCancelled()
        return { ready: true }
      } catch (error) {
        if (leaveOperation === operation) resumeAfterLeave(operationId)
        throw error
      }
    })()
    return operation.promise
  }

  function dispose() {
    if (disposed) return Promise.resolve()
    // Dispatch the last queued intent before closing the gate; late UI results are invalidated.
    for (const entry of pending.values()) entry.drainOnDispose = entry.release.isActive()
    const finished = flush()
    disposed = true
    stopSnapshots?.()
    stopSnapshots = null
    stopApplications?.()
    stopApplications = null
    leaveOperation = null
    isLeaving.value = false
    suspend({ cancelDispatched: false })
    for (const stop of stopWatchers) stop()
    return finished
  }

  stopWatchers.push(watch(autoStart.enabled, (value) => void saveAutoStart(value)))
  stopWatchers.push(
    watch(blur.enabled, () => {
      if (canWrite('blur')) blurEnableFeedbackPending = true
      debouncedSyncBlur()
    })
  )
  stopWatchers.push(watch(blur.radius, debouncedSyncBlur))
  stopWatchers.push(watch(blur.saturation, debouncedSyncBlur))
  stopWatchers.push(watch(blur.cornerRadius, debouncedSyncBlur))

  // Panel refs refer back to this queue; do not synchronously replay during its construction.
  stopSnapshots = snapshots.subscribe(receiveSnapshot, { replay: false, availabilityEvents: true })
  stopApplications = applications.subscribe((state, status) => {
    if (disposed) return
    applicationState.value = state
    applicationAvailability.value = status.availability
    applicationError.value = status.error
    applicationReading.value = status.reading
  })

  return {
    isResetting,
    snapshotUnavailable: readonly(snapshotUnavailable),
    hasPendingWrites: readonly(hasPendingWrites),
    hasUnconfirmedWrites: readonly(hasUnconfirmedWrites),
    awaitingCanonical: readonly(awaitingCanonical),
    applicationState: readonly(applicationState),
    applicationAvailability: readonly(applicationAvailability),
    applicationError: readonly(applicationError),
    applicationReading: readonly(applicationReading),
    applicationBusy: readonly(applicationBusy),
    refreshSettingsApplicationState,
    retrySettingsApplication,
    isLeaving: readonly(isLeaving),
    prepareToLeave,
    resumeAfterLeave,
    failedSettings: readonly(failedSettings),
    retryFailedSettingSaves,
    canWrite,
    isInFlight,
    isProtected,
    persistSetting,
    debouncedSave,
    syncBlurConfig,
    saveAutoStart,
    saveDockConfig,
    withoutWrite,
    loadSettingsSnapshot,
    resetSettings,
    flush,
    dispose,
    waitForInFlightWrites
  }
}
