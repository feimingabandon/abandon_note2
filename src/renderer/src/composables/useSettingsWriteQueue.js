import { nextTick, readonly, ref, watch } from 'vue'

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
  const domains = ['setting', 'blur', 'autoStart', 'dock']
  const inFlight = Object.fromEntries(domains.map((domain) => [domain, new Set()]))
  const ready = { setting: false, blur: false, autoStart: false, dock: false }
  const suppressed = Object.fromEntries(domains.map((domain) => [domain, 0]))
  const revision = { blur: 0, autoStart: 0, dock: 0, snapshot: 0 }
  const pending = new Map()
  const timers = new Map()
  const settingRequests = new Map()
  const failedSettings = ref([])
  let blurTimer = null
  let blurEnableFeedbackPending = false
  let disposed = false
  const stopWatchers = []

  function canWrite(domain = 'setting') {
    return !disposed && !isResetting.value && ready[domain] && suppressed[domain] === 0
  }

  function isInFlight(domain) {
    return inFlight[domain].size > 0
  }

  function current(domain, token) {
    return !disposed && !isResetting.value && revision[domain] === token
  }

  function track(domain, request) {
    const task = Promise.resolve(request)
    inFlight[domain].add(task)
    task.then(
      () => inFlight[domain].delete(task),
      () => inFlight[domain].delete(task)
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

  function publishSettingFailures() {
    if (disposed) return
    failedSettings.value = [...pending.values()]
      .filter((entry) => entry.error)
      .map((entry) => ({ id: entry.id, error: entry.error.message || String(entry.error) }))
  }

  function queueSettingIntent({ id, value }) {
    const previous = pending.get(id)
    if (previous && !previous.started) previous.cancelled = true
    clearTimeout(timers.get(id))
    timers.delete(id)
    const entry = { id, value, error: null, task: null, started: false, cancelled: false }
    pending.set(id, entry)
    publishSettingFailures()
    return entry
  }

  function persistUnchecked(entry) {
    if (entry.task) return entry.task
    const previous = settingRequests.get(entry.id)
    const ownsLatestIntent = () =>
      !disposed && !isResetting.value && pending.get(entry.id) === entry
    const request = (async () => {
      try {
        // Serialize only the same ID: an old disk write cannot finish after its replacement.
        if (previous) await previous.catch(() => {})
        if (entry.cancelled) return
        entry.started = true
        reportEvidence('settings.save-requested', { id: entry.id, source: 'settings-panel' })
        await api.setSettingValue(entry.id, entry.value)
        if (ownsLatestIntent()) {
          pending.delete(entry.id)
          publishSettingFailures()
        }
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
    }
    pending.clear()
    failedSettings.value = []
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
    const token = ++revision.blur
    const reportEnable = blurEnableFeedbackPending
    blurEnableFeedbackPending = false
    const config = {
      enabled: blur.enabled.value,
      radius: blur.radius.value,
      saturation: blur.saturation.value,
      cornerRadius: blur.cornerRadius.value
    }
    const request = (async () => {
      try {
        const result = await api.setBlurConfig(config)
        if (!current('blur', token)) return result
        if (result?.config && result.config.enabled !== blur.enabled.value) {
          await withoutWrite('blur', () => {
            blur.enabled.value = Boolean(result.config.enabled)
          })
        }
        if (!current('blur', token)) return result
        if (result?.runtime) blur.error.value = result.error ?? result.runtime.error ?? null
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
        warn('[SettingsPanel] 同步模糊配置失败:', error)
        if (reportEnable && blur.enabled.value) {
          showMessage('error', `毛玻璃启用失败：${error.message || '主进程通信失败'}`, 5000)
        }
      }
    })()
    return track('blur', request)
  }

  function debouncedSyncBlur() {
    if (!canWrite('blur')) return
    // Invalidate an older response immediately when a newer user intent is queued.
    revision.blur += 1
    clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      blurTimer = null
      void syncBlurConfig()
    }, 150)
  }

  function flushPendingBlurConfig() {
    if (blurTimer === null) return Promise.resolve()
    clearTimeout(blurTimer)
    blurTimer = null
    return syncBlurConfig()
  }

  function cancelPendingBlurConfig() {
    clearTimeout(blurTimer)
    blurTimer = null
    blurEnableFeedbackPending = false
  }

  async function saveAutoStart(value) {
    if (!canWrite('autoStart')) return
    const token = ++revision.autoStart
    const task = (async () => {
      try {
        const verified = await api.setAutoStart(value)
        if (!current('autoStart', token)) return
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
      } catch (error) {
        if (!current('autoStart', token)) return
        warn('[SettingsPanel] 设置开机自启失败:', error)
        try {
          const actual = await api.verifyAutoStart()
          if (!current('autoStart', token)) return
          await withoutWrite('autoStart', () => {
            autoStart.enabled.value = Boolean(actual.value)
          })
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
    const task = (async () => {
      try {
        const result = await api.setDockConfig(config)
        if (current('dock', token)) dock.assign(result?.values?.dock)
      } catch (error) {
        if (!current('dock', token)) return
        warn('[SettingsPanel] 保存贴边隐藏设置失败:', error)
        try {
          const result = await api.getSettingsSnapshot()
          if (current('dock', token)) dock.assign(result?.values?.dock)
        } catch (reloadError) {
          if (current('dock', token)) warn('[SettingsPanel] 回读贴边隐藏设置失败:', reloadError)
        }
        if (current('dock', token))
          showMessage('error', '贴边隐藏设置保存失败，已恢复实际配置', 4000)
      }
    })()
    return track('dock', task)
  }

  async function waitForInFlightWrites() {
    // Include recovery reads and nextTick suppression, rather than only raw IPC promises.
    while (Object.values(inFlight).some((tasks) => tasks.size)) {
      await Promise.allSettled(Object.values(inFlight).flatMap((tasks) => [...tasks]))
    }
  }

  function suspend(options) {
    for (const domain of domains) ready[domain] = false
    for (const domain of Object.keys(revision)) revision[domain] += 1
    clearPendingSettingSaves(options)
    cancelPendingBlurConfig()
  }

  async function loadSettingsSnapshot() {
    if (disposed) return
    suspend()
    const token = revision.snapshot
    try {
      const result = await api.getSettingsSnapshot()
      if (disposed || token !== revision.snapshot) return
      snapshot.assign(result)
    } catch (error) {
      if (disposed || token !== revision.snapshot) return
      snapshot.assign(snapshot.fallback())
      warn('[SettingsPanel] 加载设置快照失败，使用共享默认值:', error)
    }
    await nextTick()
    if (disposed || token !== revision.snapshot) return
    for (const domain of domains) ready[domain] = true
  }

  async function resetSettings(beforeReset = () => {}) {
    if (disposed || isResetting.value) return
    isResetting.value = true
    suspend()
    beforeReset()
    try {
      await waitForInFlightWrites()
      if (disposed) return
      const result = await api.resetSettings()
      if (disposed) return
      snapshot.assign(result)
      await nextTick()
      if (!disposed) showMessage('success', '已恢复默认设置')
    } catch (error) {
      if (disposed) return
      warn('[SettingsPanel] 恢复默认设置失败:', error)
      showMessage('error', '恢复默认设置失败，请重试', 4000)
      await loadSettingsSnapshot()
    } finally {
      if (!disposed) for (const domain of domains) ready[domain] = true
      isResetting.value = false
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
  }

  function dispose() {
    if (disposed) return Promise.resolve()
    // Dispatch the last queued intent before closing the gate; late UI results are invalidated.
    const finished = flush()
    disposed = true
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

  return {
    isResetting,
    failedSettings: readonly(failedSettings),
    retryFailedSettingSaves,
    canWrite,
    isInFlight,
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
