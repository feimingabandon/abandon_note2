import { computed, onScopeDispose, ref } from 'vue'

const SCHEDULER_TASK_LABELS = Object.freeze({
  activationTask: '便签生效',
  reminderTask: '便签提醒与稍后提醒',
  noteGenerationTask: '循环便签生成',
  blurRuntimeDiagnosticTask: '窗口模糊运行诊断',
  dockHealthTask: '贴边隐藏健康检查',
  weatherRefreshTask: '天气自动更新'
})

export function useSettingsDiagnostics({ api = window.api, showMessage }) {
  const schedulerHealth = ref(null)
  const blurDiagnostic = ref({
    status: 'pending',
    lastCheckedAt: null,
    message: '等待调度器执行首次诊断'
  })
  const remoteHealthStatus = ref('checking')
  const remoteHealthError = ref('')
  let active = true
  let started = false
  let blurStarted = false
  let schedulerTimer = null
  let schedulerPending = null
  let schedulerAction = null
  let queuedRetry = false
  let stopBlur = null
  let stopRemote = null
  let remoteRevision = 0
  let remotePending = null

  const blurDiagnosticMeta = computed(() => {
    const states = {
      healthy: { label: '● 正常', className: 'sched-badge--ok' },
      error: { label: '⚠ 异常', className: 'sched-badge--danger' },
      disabled: { label: '○ 未启用', className: 'sched-badge--warn' },
      unsupported: { label: '— 不支持', className: 'sched-badge--warn' },
      pending: { label: '… 待诊断', className: 'sched-badge--warn' }
    }
    return states[blurDiagnostic.value.status] || states.pending
  })
  const remoteHealthLabel = computed(() => {
    if (remoteHealthStatus.value === 'checking') return '检测中'
    if (remoteHealthStatus.value === 'available') return '● 连接正常'
    if (remoteHealthStatus.value === 'retired') return '○ 服务已停止'
    if (remoteHealthStatus.value === 'skipped') return '○ 本次未检测'
    return '○ 连接异常'
  })
  function applyRemoteHealth(result) {
    if (!active) return
    remoteHealthStatus.value = result?.retired
      ? 'retired'
      : result?.checking
        ? 'checking'
        : result?.available
          ? 'available'
          : result?.skipped
            ? 'skipped'
            : 'unavailable'
    remoteHealthError.value = result?.retired
      ? result?.message || '远程服务已正式停止，本地功能不受影响'
      : result?.available
        ? ''
        : result?.error || '连接失败'
  }
  function loadRemoteHealth() {
    if (!active) return Promise.resolve()
    if (remotePending) return remotePending
    const current = remoteRevision
    remoteHealthStatus.value = 'checking'
    remoteHealthError.value = ''
    remotePending = (async () => {
      await Promise.resolve()
      try {
        if (!active) return
        // Reads the startup result. It never starts a network health check.
        const result = await api.getRemoteHealth()
        if (active && current === remoteRevision) applyRemoteHealth(result)
      } catch (error) {
        if (!active || current !== remoteRevision) return
        console.error('[SettingsPanel] 检查远程服务健康状态失败:', error)
        remoteHealthStatus.value = 'unavailable'
        remoteHealthError.value = error?.message || '连接失败'
      } finally {
        remotePending = null
      }
    })()
    return remotePending
  }

  function requestScheduler(action) {
    if (!active) return Promise.resolve()
    if (schedulerPending) {
      // Polls/refreshes share one request. A user retry behind a read is retained
      // once, while repeated clicks during the retry share that same operation.
      if (action === 'retry' && schedulerAction !== 'retry') queuedRetry = true
      return schedulerPending
    }
    schedulerAction = action
    schedulerPending = (async () => {
      await Promise.resolve()
      try {
        if (!active) return
        do {
          const retry = schedulerAction === 'retry'
          try {
            const health = await (retry ? api.retryScheduler() : api.getSchedulerHealth())
            if (!active) return
            schedulerHealth.value = health
            if (retry) showMessage('info', '已重新检查核心任务，请查看诊断状态')
          } catch (error) {
            if (!active) return
            if (retry) showMessage('error', error?.message || '重试失败')
            else {
              console.warn('[SettingsPanel] 获取调度器健康数据失败:', error)
              schedulerHealth.value = null
            }
          }
          schedulerAction = queuedRetry ? 'retry' : null
          queuedRetry = false
        } while (active && schedulerAction)
      } finally {
        schedulerPending = null
        schedulerAction = null
      }
    })()
    return schedulerPending
  }
  function acceptBlurSnapshot(diagnostic) {
    if (active && diagnostic) blurDiagnostic.value = diagnostic
  }
  function startBlurDiagnostics() {
    if (!active || blurStarted) return
    blurStarted = true
    // Keep the existing panel timing: after its first settings/secondary reads.
    // Snapshot and broadcast diagnostics retain their existing mixed-source rule.
    stopBlur = api.onBlurDiagnosticChanged?.((diagnostic) => {
      if (!active || !diagnostic) return
      blurDiagnostic.value = diagnostic
    })
  }
  function start() {
    if (!active || started) return remotePending || Promise.resolve()
    started = true
    // Remote startup-result subscription precedes its initial local read.
    stopRemote = api.onRemoteHealthChanged?.((result) => {
      if (!active) return
      remoteRevision += 1
      applyRemoteHealth(result)
    })
    void requestScheduler('read')
    schedulerTimer = setInterval(() => void requestScheduler('read'), 10000)
    return loadRemoteHealth()
  }
  function dispose() {
    if (!active) return
    active = false
    queuedRetry = false
    if (schedulerTimer !== null) clearInterval(schedulerTimer)
    schedulerTimer = null
    stopBlur?.()
    stopRemote?.()
    stopBlur = null
    stopRemote = null
  }
  onScopeDispose(dispose)
  return {
    schedulerHealth,
    blurDiagnostic,
    blurDiagnosticMeta,
    remoteHealthStatus,
    remoteHealthError,
    remoteHealthLabel,
    loadSchedulerHealth: () => requestScheduler('read'),
    retryScheduler: () => requestScheduler('retry'),
    loadRemoteHealth,
    acceptBlurSnapshot,
    startBlurDiagnostics,
    schedulerTaskLabel: (name) => SCHEDULER_TASK_LABELS[name] || name,
    formatTickTime(ts) {
      return ts
        ? new Date(ts).toLocaleString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          })
        : '——'
    },
    tickTimeAgo(ts) {
      if (!ts) return '——'
      const diff = Date.now() - ts
      if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
      return `${Math.floor(diff / 3600000)} 小时前`
    },
    start,
    dispose
  }
}
