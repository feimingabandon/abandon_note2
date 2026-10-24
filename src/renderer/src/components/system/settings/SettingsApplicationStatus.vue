<script setup>
import { computed } from 'vue'
import BaseButton from '../../ui/BaseButton.vue'
import {
  SETTINGS_APPLICATION_DOMAINS,
  SETTINGS_APPLICATION_DEPENDENCIES
} from '../../../../../shared/settings-application-state.js'

const props = defineProps({
  state: { type: Object, default: null },
  availability: { type: String, default: 'unknown' },
  stateError: { type: Object, default: null },
  hasPendingWrites: { type: Boolean, default: false },
  hasUnconfirmedWrites: { type: Boolean, default: false },
  hasSaveFailures: { type: Boolean, default: false },
  awaitingCanonical: { type: Boolean, default: false },
  applying: { type: Boolean, default: false },
  reading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['retry-application', 'read-state', 'read-values'])
const labels = {
  window: '窗口层级与锁定',
  blur: '窗口毛玻璃',
  dock: '贴边隐藏',
  blurConfig: '毛玻璃配置',
  theme: '截图主题',
  remote: '远程配置',
  resetBindings: '默认快捷键',
  resetGeometry: '默认窗口尺寸'
}
const statusLabels = {
  failed: '应用失败',
  deferred: '应用暂缓',
  unconfirmed: '应用尚待确认'
}
const ledger = computed(() => props.state?.ledger)
const current = computed(() => ledger.value?.current)
const saved = computed(() => ledger.value?.commitId != null)
const rows = computed(() => {
  const result = []
  for (const [kind, names] of [
    ['domains', SETTINGS_APPLICATION_DOMAINS],
    ['dependencies', SETTINGS_APPLICATION_DEPENDENCIES]
  ]) {
    for (const key of names) {
      const observation = ledger.value?.[kind]?.[key]
      if (!observation || !statusLabels[observation.status]) continue
      result.push({
        kind,
        key,
        label: labels[key],
        status: observation.status,
        message: statusLabels[observation.status],
        reason:
          key === 'theme' && observation.status === 'unconfirmed'
            ? '截图主题已请求，尚待确认'
            : errorMessage(observation.error) || observation.reason || '',
        retryable: observation.retryable === true
      })
    }
  }
  return result
})
const stages = computed(() => {
  const result = []
  const operation = current.value
  if (!operation) return result
  if (operation.resolve?.status === 'failed')
    result.push({ key: 'resolve', message: '已保存设置的读取失败', error: operation.resolve.error })
  if (operation.snapshot?.status === 'unavailable')
    result.push({
      key: 'snapshot',
      message: '保存后当前值读回不可用',
      error: operation.snapshot.error
    })
  if (operation.verification?.status === 'failed')
    result.push({
      key: 'verification',
      message: '应用后的检查未完成',
      error: operation.verification.error
    })
  if (operation.delivery?.status === 'failed')
    result.push({ key: 'delivery', message: '设置同步尚未完成', error: operation.delivery.error })
  return result
})
const running = computed(() => props.applying || current.value?.phase === 'running')
const hasFailure = computed(() => rows.value.some((row) => row.status === 'failed'))
const hasDeferred = computed(() => rows.value.some((row) => row.status === 'deferred'))
const awaitingResult = computed(
  () =>
    rows.value.length > 0 ||
    stages.value.length > 0 ||
    current.value?.superseded ||
    ['unconfirmed', 'pending'].includes(current.value?.verification?.status) ||
    ['unconfirmed', 'pending'].includes(current.value?.delivery?.status)
)
const title = computed(() => {
  if (props.hasPendingWrites) {
    if (props.hasSaveFailures) return '部分设置尚未保存'
    if (props.hasUnconfirmedWrites) return '部分设置的保存结果尚未确认，请检查对应设置'
    return '正在保存设置…'
  }
  if (props.awaitingCanonical) return '设置已保存，当前值尚待确认'
  const prefix = saved.value ? '设置已保存，' : '当前设置'
  if (props.availability === 'unavailable') return `${prefix}应用状态暂不可用`
  if (running.value) return `${prefix}正在应用`
  if (hasFailure.value) return `${prefix}部分设置应用失败`
  if (hasDeferred.value) return `${prefix}部分设置应用暂缓`
  if (awaitingResult.value) return `${prefix}应用结果尚待确认`
  if (props.reading) return '正在读取设置应用状态…'
  if (saved.value && current.value) return '设置已保存，已应用'
  return '尚未修改设置'
})
const tone = computed(() => {
  if (props.hasSaveFailures || hasFailure.value) return 'error'
  if (
    props.awaitingCanonical ||
    props.hasUnconfirmedWrites ||
    props.availability === 'unavailable' ||
    awaitingResult.value
  )
    return 'warning'
  if (saved.value && current.value && !props.hasPendingWrites && !running.value && !props.reading)
    return 'success'
  return 'neutral'
})
const visible = computed(() =>
  Boolean(
    props.hasPendingWrites ||
    props.awaitingCanonical ||
    props.availability === 'unavailable' ||
    props.reading ||
    current.value ||
    rows.value.length
  )
)
const displayState = computed(() => {
  if (props.hasPendingWrites)
    return props.hasSaveFailures || props.hasUnconfirmedWrites ? 'unsaved' : 'saving'
  if (props.awaitingCanonical) return 'unconfirmed'
  if (props.availability === 'unavailable') return 'unavailable'
  if (running.value) return 'applying'
  if (hasFailure.value) return 'failed'
  if (hasDeferred.value) return 'deferred'
  if (awaitingResult.value) return 'unconfirmed'
  return saved.value && current.value ? 'applied' : 'idle'
})
const retryTargets = computed(() => ({
  domains: rows.value
    .filter((row) => row.kind === 'domains' && row.retryable)
    .map((row) => row.key),
  dependencies: rows.value
    .filter((row) => row.kind === 'dependencies' && row.retryable)
    .map((row) => row.key)
}))
const hasRetryTargets = computed(
  () => retryTargets.value.domains.length > 0 || retryTargets.value.dependencies.length > 0
)
const canRetryReadback = computed(() =>
  stages.value.some((stage) => ['resolve', 'snapshot', 'delivery'].includes(stage.key))
)
const canRetry = computed(() => hasRetryTargets.value || canRetryReadback.value)
const retryLabel = computed(() => {
  if (props.applying) return hasRetryTargets.value ? '正在应用…' : '正在读取…'
  return hasRetryTargets.value ? '重试应用' : '重新读取应用结果'
})
const blocked = computed(
  () => props.disabled || props.hasPendingWrites || running.value || props.reading
)
function errorMessage(error) {
  return error?.message || error || ''
}
</script>

<template>
  <section
    v-if="visible"
    class="settings-application-status scroll-y"
    :class="`status--${tone}`"
    data-settings-application-status
    :data-state="displayState"
    aria-label="设置保存与应用状态"
  >
    <p class="status-title" role="status" aria-live="polite">{{ title }}</p>
    <p v-if="availability === 'unavailable' && stateError" class="status-detail">
      {{ errorMessage(stateError) }}
    </p>
    <ul v-if="rows.length || stages.length" class="status-details">
      <li
        v-for="row in rows"
        :key="`${row.kind}:${row.key}`"
        :data-application-target="`${row.kind === 'domains' ? 'domain' : 'dependency'}:${row.key}`"
      >
        <span :class="row.status === 'failed' ? 'detail-error' : 'detail-warning'">
          {{ row.label }}：{{ row.message }}
        </span>
        <span v-if="row.reason"> · {{ row.reason }}</span>
      </li>
      <li v-for="stage in stages" :key="stage.key" :data-application-stage="stage.key">
        {{ stage.message }}<span v-if="stage.error"> · {{ errorMessage(stage.error) }}</span>
      </li>
    </ul>
    <p v-if="hasRetryTargets" class="status-detail">重试应用会使用已保存的设置。</p>
    <div class="status-actions">
      <BaseButton
        v-if="canRetry"
        size="sm"
        :disabled="blocked"
        :loading="applying"
        data-settings-application-retry
        @click="emit('retry-application', retryTargets)"
      >
        {{ retryLabel }}
      </BaseButton>
      <BaseButton
        v-if="awaitingCanonical"
        size="sm"
        :disabled="blocked"
        data-settings-canonical-read
        @click="emit('read-values')"
        >重新读取当前值</BaseButton
      >
      <BaseButton
        v-if="availability === 'unavailable'"
        size="sm"
        :disabled="disabled || running"
        :loading="reading"
        data-settings-application-refresh
        @click="emit('read-state')"
        >重新读取应用状态</BaseButton
      >
    </div>
  </section>
</template>

<style scoped>
.settings-application-status {
  flex: 0 0 auto;
  max-height: 180px;
  padding: 0 var(--settings-gutter) 8rem var(--settings-gutter-start);
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  overflow-wrap: anywhere;
}
.status-title,
.status-detail {
  margin: 0 0 4rem;
}
.status-title {
  color: var(--text-color);
}
.status--error .status-title,
.detail-error {
  color: var(--ui-danger);
}
.status--warning .status-title,
.detail-warning {
  color: var(--ui-warning);
}
.status--success .status-title {
  color: var(--ui-status-completed);
}
.status-details {
  margin: 0 0 6rem;
  padding-inline-start: 18rem;
}
.status-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6rem;
}
</style>
