<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ResizableTextarea from '../ui/ResizableTextarea.vue'
import TagSelector from '../ui/TagSelector.vue'
import AppToggle from '../ui/AppToggle.vue'
import HelpButton from '../ui/HelpButton.vue'
import TimePicker from '../ui/TimePicker.vue'
import TemplateFrequencySelector from './TemplateFrequencySelector.vue'
import {
  createTemplateFormSnapshot,
  formatTemplateTime,
  MAX_DAILY_INTERVAL,
  normalizeYearDates,
  parseTemplateRule
} from '../../utils/templateRules.js'

const props = defineProps({
  initial: { type: Object, default: null },
  submitting: { type: Boolean, default: false },
  submitLabel: { type: String, default: '创建模板' },
  showCancel: { type: Boolean, default: false },
  editorMode: { type: Boolean, default: false },
  active: { type: Boolean, default: true }
})
const emit = defineEmits(['submit', 'cancel'])

function currentTimeOfDay() {
  const current = new Date()
  return `${String(current.getHours()).padStart(2, '0')}:${String(current.getMinutes()).padStart(2, '0')}`
}

const content = ref('')
const frequency = ref('daily')
const interval = ref(1)
const weekdays = ref([1])
const monthDays = ref([1])
const yearDates = ref([{ month: 1, day: 1 }])
const timeOfDay = ref(currentTimeOfDay())
const notifyEnabled = ref(true)
const isPinned = ref(false)
const tagNames = ref([])
const previewAt = ref(null)
const previewError = ref('')
const initialSnapshot = ref('')
let previewTimer = null
let previewSequence = 0
const formRootRef = ref(null)
let entranceRaf = null
let entranceSequence = 0
let entranceAnimations = []
let hasActivated = false
let initialLoadSequence = 0
const ENTER_DURATION = 250
const ENTER_TOTAL_WINDOW = 520

function entranceItems() {
  return Array.from(formRootRef.value?.querySelectorAll('.tf-fields > *, .tf-actions') || [])
}

function cancelEntrance() {
  entranceSequence += 1
  if (entranceRaf) cancelAnimationFrame(entranceRaf)
  entranceRaf = null
  for (const animation of entranceAnimations) animation.cancel()
  entranceAnimations = []
  for (const element of entranceItems()) {
    element.style.removeProperty('opacity')
    element.style.removeProperty('translate')
  }
}

async function replayEntrance() {
  cancelEntrance()
  const sequence = entranceSequence
  await nextTick()
  if (!props.active || sequence !== entranceSequence || !formRootRef.value) return
  const items = entranceItems()
  const step = items.length > 1 ? (ENTER_TOTAL_WINDOW - ENTER_DURATION) / (items.length - 1) : 0
  for (const item of items) {
    item.style.opacity = '0'
    item.style.translate = '0 6px'
  }
  entranceRaf = requestAnimationFrame(() => {
    entranceRaf = null
    if (!props.active || sequence !== entranceSequence) return
    entranceAnimations = items.map((item, index) =>
      item.animate(
        [
          { opacity: 0, translate: '0 6px' },
          { opacity: 1, translate: '0 0' }
        ],
        {
          duration: ENTER_DURATION,
          delay: index * step,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both'
        }
      )
    )
    Promise.allSettled(entranceAnimations.map((animation) => animation.finished)).then(() => {
      if (sequence !== entranceSequence) return
      for (const item of items) {
        item.style.removeProperty('opacity')
        item.style.removeProperty('translate')
      }
      entranceAnimations = []
    })
  })
}

watch(
  () => props.active,
  (active) => {
    if (active) {
      if (!hasActivated && !props.initial) timeOfDay.value = currentTimeOfDay()
      hasActivated = true
      replayEntrance()
    } else cancelEntrance()
  },
  { immediate: true }
)

function loadInitial(template) {
  const rule = parseTemplateRule(template?.recurrence_rule || template?.recurrenceRule)
  content.value = template?.content || ''
  frequency.value = rule?.frequency || 'daily'
  interval.value = Number(rule?.interval) || 1
  weekdays.value = rule?.days_of_week?.length ? [...rule.days_of_week] : [1]
  monthDays.value = rule?.days_of_month?.length ? [...rule.days_of_month] : [1]
  const normalizedYearDates = normalizeYearDates(rule?.dates_of_year)
  yearDates.value = normalizedYearDates.length ? normalizedYearDates : [{ month: 1, day: 1 }]
  timeOfDay.value = rule?.time_of_day || currentTimeOfDay()
  notifyEnabled.value = template ? Number(template.notify_enabled) === 1 : true
  isPinned.value = template ? Number(template.is_pinned) === 1 : false
  tagNames.value = (template?.tags || []).map((tag) => tag.name)
}

const recurrenceRule = computed(() => ({
  frequency: frequency.value,
  interval:
    frequency.value === 'daily'
      ? Math.min(MAX_DAILY_INTERVAL, Math.max(1, Math.trunc(Number(interval.value)) || 1))
      : 1,
  days_of_week: frequency.value === 'weekly' ? [...weekdays.value].sort((a, b) => a - b) : [],
  days_of_month: frequency.value === 'monthly' ? [...monthDays.value].sort((a, b) => a - b) : [],
  dates_of_year: frequency.value === 'yearly' ? normalizeYearDates(yearDates.value) : [],
  time_of_day: timeOfDay.value
}))
const currentSnapshot = computed(() =>
  createTemplateFormSnapshot({
    content: content.value,
    recurrenceRule: recurrenceRule.value,
    notifyEnabled: notifyEnabled.value,
    isPinned: isPinned.value,
    tagNames: tagNames.value
  })
)
const hasChanges = computed(
  () => initialSnapshot.value !== '' && currentSnapshot.value !== initialSnapshot.value
)

watch(
  () => props.initial,
  async (template) => {
    const sequence = ++initialLoadSequence
    loadInitial(template)
    await nextTick()
    if (sequence === initialLoadSequence) initialSnapshot.value = currentSnapshot.value
  },
  { immediate: true }
)

const ruleComplete = computed(() => {
  if (!/^\d{2}:\d{2}$/.test(timeOfDay.value)) return false
  if (frequency.value === 'weekly') return weekdays.value.length > 0
  if (frequency.value === 'monthly') return monthDays.value.length > 0
  if (frequency.value === 'yearly') return normalizeYearDates(yearDates.value).length > 0
  return (
    Number.isInteger(Number(interval.value)) &&
    Number(interval.value) >= 1 &&
    Number(interval.value) <= MAX_DAILY_INTERVAL
  )
})
const canSubmit = computed(
  () =>
    !!content.value.trim() &&
    ruleComplete.value &&
    !props.submitting &&
    (!props.editorMode || hasChanges.value)
)
const previewText = computed(
  () => previewError.value || (previewAt.value ? formatTemplateTime(previewAt.value) : '正在计算…')
)

watch(
  recurrenceRule,
  () => {
    const sequence = ++previewSequence
    clearTimeout(previewTimer)
    previewError.value = ''
    if (!ruleComplete.value) {
      previewAt.value = null
      return
    }
    previewTimer = setTimeout(async () => {
      try {
        const nextRunAt = await window.api.previewTemplateNextRun(recurrenceRule.value, Date.now())
        if (sequence !== previewSequence) return
        previewAt.value = nextRunAt
      } catch (error) {
        if (sequence !== previewSequence) return
        previewAt.value = null
        previewError.value = error.message || '规则暂不可用'
      }
    }, 140)
  },
  { deep: true, immediate: true }
)

function submit() {
  if (!canSubmit.value) return
  emit('submit', {
    content: content.value,
    recurrenceRule: recurrenceRule.value,
    notifyEnabled: notifyEnabled.value,
    isPinned: isPinned.value,
    tagNames: [...tagNames.value]
  })
}

function reset() {
  const sequence = ++initialLoadSequence
  loadInitial(null)
  nextTick(() => {
    if (sequence === initialLoadSequence) initialSnapshot.value = currentSnapshot.value
  })
}
defineExpose({ reset, hasChanges })
onBeforeUnmount(() => {
  clearTimeout(previewTimer)
  cancelEntrance()
})
</script>

<template>
  <form
    ref="formRootRef"
    class="tf-root"
    :class="{ 'tf-root--editor': editorMode }"
    @submit.prevent="submit"
  >
    <div class="tf-fields scroll-y">
      <ResizableTextarea
        v-model="content"
        :rows="4"
        placeholder="请输入循环生成的便签内容…（Enter 换行）"
      />

      <TemplateFrequencySelector
        v-model:frequency="frequency"
        v-model:interval="interval"
        v-model:weekdays="weekdays"
        v-model:month-days="monthDays"
        v-model:year-dates="yearDates"
      />

      <div class="tf-row">
        <label>生成时间</label><TimePicker v-model="timeOfDay" aria-label="选择模板生成时间" />
      </div>
      <div class="tf-preview">
        <span>下一次生成</span>
        <span class="tf-preview-value" aria-live="polite">
          <Transition name="tf-preview-time">
            <strong
              :key="previewText"
              :class="{ 'is-time': !!previewAt && !previewError, 'is-error': !!previewError }"
            >
              {{ previewText }}
            </strong>
          </Transition>
        </span>
      </div>
      <div class="tf-row">
        <label
          >模板生成便签时是否通知
          <HelpButton text="到达生成节点时，由模板发送通知；生成的便签本身不带系统通知。"
        /></label>
        <AppToggle v-model="notifyEnabled" />
      </div>
      <div class="tf-row">
        <label
          >生成的便签是否置顶
          <HelpButton text="只决定以后生成的便签是否置顶，不会改变已经生成的便签。"
        /></label>
        <AppToggle v-model="isPinned" />
      </div>
      <div class="tf-field"><label>标签</label><TagSelector v-model="tagNames" /></div>
    </div>

    <div class="tf-actions">
      <button
        v-if="showCancel"
        type="button"
        class="tf-secondary"
        :disabled="submitting"
        @click="emit('cancel')"
      >
        {{ hasChanges ? '放弃修改' : '关闭' }}
      </button>
      <button type="submit" class="tf-submit" :disabled="!canSubmit">
        {{ submitting ? '保存中…' : submitLabel }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.tf-root {
  display: flex;
  flex-direction: column;
  gap: 13rem;
  min-width: 0;
  color: var(--text-color);
}
.tf-fields {
  display: flex;
  flex-direction: column;
  gap: 13rem;
  min-width: 0;
}
.tf-root--editor {
  flex: 1;
  min-height: 0;
  gap: 0;
}
.tf-root--editor .tf-fields {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  padding: 14rem 14rem 16rem;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}
.tf-root--editor .tf-actions {
  flex-shrink: 0;
  width: calc(100% - 28rem);
  margin: 0 14rem 14rem;
  padding-top: 0;
}
.tf-field {
  display: flex;
  flex-direction: column;
  gap: 7rem;
  min-width: 0;
}
label,
.tf-preview {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  font-weight: 500;
}
.tf-row,
.tf-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
}
.tf-preview {
  min-height: 32rem;
}
.tf-preview-value {
  display: grid;
  min-width: 92rem;
  justify-items: end;
}
.tf-preview-value strong {
  grid-area: 1 / 1;
  color: #0a84ff;
  font-weight: 600;
}
.tf-preview-value strong:not(.is-time) {
  color: var(--text-color-secondary);
  font-weight: 500;
  opacity: 0.72;
}
.tf-preview-value strong.is-error {
  color: #ff453a;
  opacity: 0.88;
}
.tf-preview-time-enter-active,
.tf-preview-time-leave-active {
  transition:
    opacity var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}
.tf-preview-time-enter-from {
  opacity: 0;
  transform: translateY(5rem);
}
.tf-preview-time-leave-to {
  opacity: 0;
  transform: translateY(-4rem);
}
.tf-actions {
  display: flex;
  gap: 9rem;
  padding-top: 2rem;
}
.tf-submit,
.tf-secondary {
  flex: 1;
  border: 0;
  border-radius: 8rem;
  padding: 10rem;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition:
    transform 120ms ease,
    opacity 160ms ease,
    background 160ms ease;
}
.tf-submit {
  background: #0071e3;
  color: white;
}
.tf-submit:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.tf-secondary:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.tf-submit:active:not(:disabled),
.tf-secondary:active {
  transform: scale(0.985);
}
.tf-secondary {
  background: color-mix(in srgb, var(--text-color) 7%, transparent);
  color: var(--text-color);
}
</style>
