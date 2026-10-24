<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import BaseButton from '../../ui/BaseButton.vue'

const props = defineProps({ active: { type: Boolean, default: false } })
const emit = defineEmits(['show-logs'])
const report = ref(null)
const reading = ref(false)
const unavailable = ref(false)
const retrying = ref(false)
const retryOutcome = ref(null)
let generation = 0
let disposed = false
const statuses = [
  ['completed', '恢复完成'],
  ['cleanupPending', '仅待清理'],
  ['referenceMissing', '引用缺失'],
  ['preservedConflict', '冲突保留'],
  ['undetermined', '无法判定']
]
const titles = {
  completed: '本轮附件恢复已完成',
  cleanupPending: '本轮附件恢复仅待清理',
  referenceMissing: '本轮发现附件引用缺失',
  preservedConflict: '本轮附件恢复保留了冲突',
  undetermined: '本轮附件恢复仍有无法判定的操作'
}

function validReport(value) {
  return (
    value?.schemaVersion === 1 &&
    value.scope === 'pending-attachment-recovery-round' &&
    ['not-started', 'running', 'finished', 'failed'].includes(value.phase) &&
    Object.hasOwn(titles, value.status) &&
    typeof value.partial === 'boolean' &&
    Array.isArray(value.operations) &&
    statuses.every(([key]) => Number.isSafeInteger(value.counts?.[key]) && value.counts[key] >= 0)
  )
}

async function readReport(allowWhileRetrying = false) {
  if (!props.active || disposed || reading.value || (retrying.value && !allowWhileRetrying)) return
  const request = ++generation
  reading.value = true
  unavailable.value = false
  retryOutcome.value = null
  report.value = null
  try {
    const value = await window.api.getAttachmentRecoveryReport()
    if (disposed || !props.active || request !== generation) return
    if (!validReport(value)) throw new Error('Invalid attachment recovery report')
    report.value = value
  } catch {
    if (!disposed && props.active && request === generation) unavailable.value = true
  } finally {
    if (!disposed && props.active && request === generation) reading.value = false
  }
}

async function retryRecovery() {
  if (!props.active || disposed || reading.value || retrying.value) return
  const request = ++generation
  retrying.value = true
  retryOutcome.value = null
  unavailable.value = false
  report.value = null
  try {
    const result = await window.api.retryAttachmentRecovery()
    if (disposed || !props.active || request !== generation) return
    if (
      !['finished', 'failed'].includes(result?.outcome) ||
      !validReport(result.report) ||
      result.report.phase !== result.outcome ||
      result.report.partial !== (result.outcome === 'failed')
    )
      throw new Error('Invalid attachment recovery result')
    report.value = result.report
    retryOutcome.value = result.outcome
  } catch {
    if (!disposed && props.active && request === generation) retryOutcome.value = 'unavailable'
  } finally {
    // Closing the panel invalidates display only; main owns recovery until this promise settles.
    if (!disposed) retrying.value = false
  }
}

watch(
  () => props.active,
  (active) => {
    generation++
    report.value = null
    unavailable.value = false
    retryOutcome.value = null
    reading.value = false
    if (active) void readReport(true)
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  disposed = true
  generation++
})

const title = computed(() => {
  if (reading.value) return '正在读取附件恢复报告…'
  if (unavailable.value) return '报告暂不可用'
  if (retryOutcome.value === 'unavailable') return '恢复未开始或未完成'
  if (retryOutcome.value === 'finished') return '本轮附件恢复已结束'
  if (retryOutcome.value === 'failed') return '本轮附件恢复未完成'
  if (retrying.value && !report.value) return '正在尝试恢复附件…'
  const current = report.value
  if (!current) return '尚未读取附件恢复报告'
  if (current.phase === 'not-started') return '尚未运行本轮附件恢复'
  if (current.phase === 'running') return '本轮附件恢复进行中'
  if (current.phase === 'failed') return '本轮附件恢复未完成'
  if (current.status === 'completed' && current.operations.length === 0)
    return '本轮未发现待恢复操作'
  return titles[current.status]
})
const tone = computed(() => {
  if (retryOutcome.value === 'unavailable') return 'warning'
  if (report.value?.phase === 'not-started') return 'neutral'
  if (unavailable.value || report.value?.partial) return 'warning'
  if (!report.value || report.value.phase !== 'finished') return 'neutral'
  return report.value.status === 'completed' ? 'success' : 'warning'
})
const displayCounts = computed(() => report.value && report.value.phase !== 'not-started')
</script>

<template>
  <section
    class="settings-section attachment-recovery-status"
    data-attachment-recovery
    data-search-text="附件 存储 恢复 清理 冲突 引用缺失"
    :data-state="unavailable ? 'unavailable' : report?.status || 'unread'"
    :data-phase="report?.phase"
    aria-label="附件恢复报告"
  >
    <h4 class="section-title">附件恢复报告</h4>
    <p
      class="recovery-summary"
      :class="`recovery-summary--${tone}`"
      role="status"
      aria-live="polite"
    >
      {{ title }}
    </p>
    <p class="recovery-caption">仅反映本轮待恢复操作，不是全部附件完整性检查。</p>
    <p v-if="report?.partial && report.phase !== 'not-started'" class="recovery-caption">
      报告尚不完整，以下仅包含已观察到的结果。
    </p>
    <template v-if="displayCounts">
      <ul class="recovery-counts" aria-label="已观察到的恢复结果">
        <li v-for="[key, label] in statuses" :key="key" :data-recovery-count="key">
          {{ label }}：{{ report.counts[key] }}
        </li>
      </ul>
      <p class="recovery-caption">同一操作可能涉及多项结果，各项数量不能相加作为操作总数。</p>
    </template>
    <p v-if="unavailable || retryOutcome === 'unavailable'" class="recovery-caption">
      请重新读取报告，或查看日志了解详情。
    </p>
    <p v-if="retryOutcome === 'finished'" class="recovery-caption">请查看报告中的各项结果。</p>
    <div class="recovery-actions">
      <BaseButton
        size="sm"
        :disabled="!active || retrying"
        :loading="reading"
        data-attachment-recovery-read
        @click="readReport()"
        >重新读取报告</BaseButton
      >
      <BaseButton
        size="sm"
        :disabled="!active || reading"
        :loading="retrying"
        data-attachment-recovery-retry
        @click="retryRecovery"
        >尝试恢复</BaseButton
      >
      <BaseButton
        size="sm"
        :disabled="!active"
        data-attachment-recovery-logs
        @click="emit('show-logs')"
        >查看日志</BaseButton
      >
    </div>
  </section>
</template>

<style scoped src="./settings-form.css"></style>
<style scoped>
.attachment-recovery-status {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  overflow-wrap: anywhere;
}
.recovery-summary,
.recovery-caption {
  margin: 0 2rem 6rem;
}
.recovery-summary {
  color: var(--text-color);
}
.recovery-summary--warning {
  color: var(--ui-warning);
}
.recovery-summary--success {
  color: var(--ui-status-completed);
}
.recovery-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 4rem 12rem;
  margin: 0 2rem 6rem;
  padding: 0;
  list-style: none;
}
.recovery-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6rem;
  padding: 0 2rem;
}
</style>
