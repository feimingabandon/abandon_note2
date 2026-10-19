<script setup>
import BaseButton from '../ui/BaseButton.vue'
import { useDraftProtection } from '../../composables/useDraftProtection.js'
import { useNewTemplatePreferences } from '../../composables/useNewTemplatePreferences.js'
import { useTemplatePreviewClock } from '../../composables/useTemplatePreviewClock.js'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ResizableTextarea from '../ui/ResizableTextarea.vue'
import TagSelector from '../ui/TagSelector.vue'
import ReminderChannelPicker from '../note/ReminderChannelPicker.vue'
import AppToggle from '../ui/AppToggle.vue'
import HelpButton from '../ui/HelpButton.vue'
import TimePicker from '../ui/TimePicker.vue'
import DateTimePicker from '../ui/DateTimePicker.vue'
import TemplateFrequencySelector from './TemplateFrequencySelector.vue'
import {
  createTemplateFormSnapshot,
  createTemplatePreviewRequest,
  createTemplateRuleSnapshot,
  formatTemplateDateTime,
  formatTemplateTime,
  MAX_DAILY_INTERVAL,
  normalizeYearDates,
  parseTemplateRule,
  parseTemplateDateTime,
  resolveStoredTemplatePreviewAt
} from '../../utils/templateRules.js'
import { useMessage } from '../../composables/useMessage.js'
import { ownedPopovers } from '../../utils/anchoredPopover.js'
import { MAX_ASSIGNED_TAGS, NOTE_TAG_LIMIT_MESSAGE } from '../../../../shared/tag-rules.js'

const props = defineProps({
  initial: { type: Object, default: null },
  submitting: { type: Boolean, default: false },
  submitLabel: { type: String, default: '创建模板' },
  showCancel: { type: Boolean, default: false },
  editorMode: { type: Boolean, default: false },
  active: { type: Boolean, default: true }
})
const emit = defineEmits(['submit', 'cancel'])
const { showMessage } = useMessage()
function currentTimeOfDay() {
  const current = new Date()
  return `${String(current.getHours()).padStart(2, '0')}:${String(current.getMinutes()).padStart(2, '0')}`
}

const content = ref('')
const preferences = useNewTemplatePreferences({
  enabled: () => !props.initial,
  defaultTime: currentTimeOfDay()
})
const {
  frequency,
  interval,
  weekdays,
  monthDays,
  quarterMonth,
  quarterDays,
  yearDates,
  timeOfDay,
  startAt,
  endAt,
  reminderChannels,
  isPinned,
  tagIds
} = preferences.fields
const previewAt = ref(null)
const previewError = ref('')
const previewRevision = ref(0)
const previewNow = ref(Date.now())
const initialSnapshot = ref('')
const initialRuleSnapshot = ref('')
let previewTimer = null
let previewSequence = 0
const formRootRef = ref(null)
let entranceRaf = null
let entranceSequence = 0
let entranceAnimations = []
let hasActivated = false
let initialLoadSequence = 0
let forcePreview = false
let submittedFocus = null
const submissionLocked = ref(false)
const lockedSurfaces = new Map()
let submissionFrame = null
let restoreSubmissionFocus = false
let submittedReset = false
let disposed = false
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
      if (!hasActivated && !props.initial && !preferences.hasSavedChoices())
        timeOfDay.value = currentTimeOfDay()
      hasActivated = true
      replayEntrance()
    } else cancelEntrance()
  },
  { immediate: true }
)

function loadInitial(template) {
  if (!template) {
    content.value = ''
    return
  }
  const rule = parseTemplateRule(template?.recurrence_rule || template?.recurrenceRule)
  content.value = template?.content || ''
  frequency.value = rule?.frequency || 'daily'
  interval.value = Number(rule?.interval) || 1
  weekdays.value = rule?.days_of_week?.length ? [...rule.days_of_week] : [1]
  monthDays.value =
    rule?.frequency === 'monthly' && rule?.days_of_month?.length ? [...rule.days_of_month] : [1]
  quarterMonth.value =
    rule?.frequency === 'quarterly' && [1, 2, 3].includes(Number(rule.month_of_quarter))
      ? Number(rule.month_of_quarter)
      : 3
  quarterDays.value =
    rule?.frequency === 'quarterly' && rule?.days_of_month?.length ? [...rule.days_of_month] : [31]
  const normalizedYearDates = normalizeYearDates(rule?.dates_of_year)
  yearDates.value = normalizedYearDates.length ? normalizedYearDates : [{ month: 1, day: 1 }]
  timeOfDay.value = rule?.time_of_day || currentTimeOfDay()
  startAt.value = template
    ? formatTemplateDateTime(template.start_at ?? template.schedule_anchor_at)
    : ''
  endAt.value = template ? formatTemplateDateTime(template.end_at) : ''
  reminderChannels.value = Number(template.reminder_channels ?? (template.notify_enabled ? 1 : 0))
  isPinned.value = template ? Number(template.is_pinned) === 1 : false
  tagIds.value = (template?.tags || []).map((tag) => tag.id)
}

const recurrenceRule = computed(() => ({
  frequency: frequency.value,
  interval:
    frequency.value === 'daily'
      ? Math.min(MAX_DAILY_INTERVAL, Math.max(1, Math.trunc(Number(interval.value)) || 1))
      : 1,
  days_of_week: frequency.value === 'weekly' ? [...weekdays.value].sort((a, b) => a - b) : [],
  days_of_month:
    frequency.value === 'monthly'
      ? [...monthDays.value].sort((a, b) => a - b)
      : frequency.value === 'quarterly'
        ? [...quarterDays.value].sort((a, b) => a - b)
        : [],
  month_of_quarter: frequency.value === 'quarterly' ? Number(quarterMonth.value) : null,
  dates_of_year: frequency.value === 'yearly' ? normalizeYearDates(yearDates.value) : [],
  time_of_day: timeOfDay.value
}))
const parsedStartAt = computed(() => parseTemplateDateTime(startAt.value))
const parsedEndAt = computed(() => parseTemplateDateTime(endAt.value))
const timeRangeError = computed(() => {
  if (startAt.value && !Number.isFinite(parsedStartAt.value)) return '开始时间无效'
  if (endAt.value && !Number.isFinite(parsedEndAt.value)) return '结束时间无效'
  const effectiveStartAt = Number.isFinite(parsedStartAt.value)
    ? parsedStartAt.value
    : previewNow.value
  if (Number.isFinite(parsedEndAt.value) && parsedEndAt.value <= effectiveStartAt) {
    return '结束时间必须晚于开始时间'
  }
  return ''
})
const currentSnapshot = computed(() =>
  createTemplateFormSnapshot({
    content: content.value,
    recurrenceRule: recurrenceRule.value,
    startAt: parsedStartAt.value,
    endAt: parsedEndAt.value,
    reminderChannels: reminderChannels.value,
    isPinned: isPinned.value,
    tagIds: tagIds.value
  })
)
const currentRuleSnapshot = computed(() =>
  createTemplateRuleSnapshot({
    recurrenceRule: recurrenceRule.value,
    startAt: parsedStartAt.value,
    endAt: parsedEndAt.value
  })
)
const hasChanges = computed(() =>
  props.initial
    ? initialSnapshot.value !== '' && currentSnapshot.value !== initialSnapshot.value
    : !!content.value.trim()
)
const requiresSchedulePreview = computed(
  () => !props.initial || initialRuleSnapshot.value !== currentRuleSnapshot.value
)

watch(
  () => props.initial,
  async (template) => {
    const sequence = ++initialLoadSequence
    loadInitial(template)
    await nextTick()
    if (sequence === initialLoadSequence) {
      initialSnapshot.value = currentSnapshot.value
      initialRuleSnapshot.value = currentRuleSnapshot.value
    }
  },
  { immediate: true }
)

const ruleComplete = computed(() => {
  if (!/^\d{2}:\d{2}$/.test(timeOfDay.value)) return false
  if (frequency.value === 'weekly') return weekdays.value.length > 0
  if (frequency.value === 'monthly') return monthDays.value.length > 0
  if (frequency.value === 'quarterly') {
    return [1, 2, 3].includes(Number(quarterMonth.value)) && quarterDays.value.length > 0
  }
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
    !timeRangeError.value &&
    (!requiresSchedulePreview.value ||
      (previewAt.value > previewNow.value && !previewError.value)) &&
    !props.submitting &&
    !submissionLocked.value &&
    (!props.editorMode || hasChanges.value)
)
const previewText = computed(
  () => previewError.value || (previewAt.value ? formatTemplateTime(previewAt.value) : '正在计算…')
)
const previewLabel = computed(() =>
  Number(props.initial?.is_paused) === 1 ? '恢复后生成时间' : '下一次生成'
)

function refreshPreview() {
  forcePreview = true
  previewAt.value = null
  previewRevision.value += 1
}

watch(
  [
    recurrenceRule,
    startAt,
    endAt,
    () => props.initial?.id,
    () => props.initial?.next_run_at,
    () => props.initial?.nextRunAt,
    initialRuleSnapshot,
    previewRevision
  ],
  () => {
    const sequence = ++previewSequence
    clearTimeout(previewTimer)
    previewError.value = ''
    if (!ruleComplete.value || timeRangeError.value) {
      previewAt.value = null
      previewError.value = timeRangeError.value
      return
    }
    const storedPreviewAt = forcePreview
      ? null
      : resolveStoredTemplatePreviewAt({
          initialTemplate: props.initial,
          initialRuleSnapshot: initialRuleSnapshot.value,
          currentRuleSnapshot: currentRuleSnapshot.value
        })
    forcePreview = false
    if (storedPreviewAt !== null) {
      previewAt.value = storedPreviewAt
      return
    }
    previewAt.value = null
    previewTimer = setTimeout(async () => {
      try {
        const nextRunAt = await window.api.previewTemplateNextRun(
          createTemplatePreviewRequest({
            recurrenceRule: recurrenceRule.value,
            startAt: parsedStartAt.value,
            endAt: parsedEndAt.value,
            templateId: props.initial?.id
          })
        )
        if (sequence !== previewSequence) return
        if (nextRunAt === null) {
          previewAt.value = null
          previewError.value = '有效期内没有生成节点'
          return
        }
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

const previewClock = useTemplatePreviewClock({
  active: () => props.active,
  now: previewNow,
  previewAt,
  endAt: parsedEndAt,
  relativeStart: () => parsedStartAt.value === null,
  refresh: refreshPreview
})

function submit() {
  previewClock.sync()
  if (!canSubmit.value) return
  if (tagIds.value.length > MAX_ASSIGNED_TAGS) {
    showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)
    return
  }
  const root = formRootRef.value
  const surfaces = root ? [root, ...ownedPopovers(root)] : []
  submittedFocus = surfaces.some((surface) => surface.contains(document.activeElement))
    ? document.activeElement
    : null
  restoreSubmissionFocus = !!submittedFocus
  submittedReset = false
  lockSubmission()
  emit('submit', {
    content: content.value,
    recurrenceRule: recurrenceRule.value,
    startAt: Number.isFinite(parsedStartAt.value) ? parsedStartAt.value : null,
    endAt: Number.isFinite(parsedEndAt.value) ? parsedEndAt.value : null,
    reminderChannels: reminderChannels.value,
    isPinned: isPinned.value,
    tagIds: [...tagIds.value]
  })
  // A caller may reject the submission synchronously without entering its busy state.
  nextTick(() => {
    if (!props.submitting) void unlockSubmission()
  })
}

function lockSubmissionSurfaces() {
  if (!submissionLocked.value || !formRootRef.value) return
  // Teleport surfaces do not inherit the form's inert state. Keep scanning while
  // saving so panels registered after a pending nextTick, including leaving
  // panels, cannot edit the submitted draft.
  const surfaces = [
    formRootRef.value.querySelector('.tf-fields'),
    ...ownedPopovers(formRootRef.value)
  ]
  for (const surface of surfaces.filter(Boolean)) {
    if (!lockedSurfaces.has(surface)) lockedSurfaces.set(surface, surface.inert)
    surface.inert = true
  }
}

function onSubmissionPointerDown(event) {
  const root = formRootRef.value
  if (
    !root?.contains(event.target) &&
    ![...lockedSurfaces.keys()].some((surface) => surface.contains(event.target)) &&
    !(root && ownedPopovers(root).some((surface) => surface.contains(event.target)))
  )
    restoreSubmissionFocus = false
}

function lockSubmission() {
  if (submissionLocked.value) return
  submissionLocked.value = true
  document.addEventListener('pointerdown', onSubmissionPointerDown, true)
  const scan = () => {
    lockSubmissionSurfaces()
    if (submissionLocked.value) submissionFrame = requestAnimationFrame(scan)
  }
  scan()
}

async function unlockSubmission({ restoreFocus = true } = {}) {
  if (!submissionLocked.value) return
  submissionLocked.value = false
  if (submissionFrame !== null) cancelAnimationFrame(submissionFrame)
  submissionFrame = null
  document.removeEventListener('pointerdown', onSubmissionPointerDown, true)
  for (const [surface, wasInert] of lockedSurfaces) surface.inert = wasInert
  lockedSurfaces.clear()
  await nextTick()
  const root = formRootRef.value
  const focused = document.activeElement
  const focusStillBelongs =
    focused === document.body ||
    root?.contains(focused) ||
    (root && ownedPopovers(root).some((surface) => surface.contains(focused)))
  if (!disposed && restoreFocus && props.active && restoreSubmissionFocus && focusStillBelongs) {
    const target =
      submittedReset || !submittedFocus?.isConnected || submittedFocus.disabled
        ? root?.querySelector('textarea')
        : submittedFocus
    target?.focus({ preventScroll: true })
  }
  submittedFocus = null
  restoreSubmissionFocus = false
  submittedReset = false
}

watch(
  () => props.submitting,
  (submitting) => {
    if (submitting) lockSubmission()
    else void unlockSubmission()
  }
)

function reset() {
  const resettingSubmission = submissionLocked.value
  submittedReset = resettingSubmission
  protectedDraft.clear()
  protectedDraft.resume()
  const sequence = ++initialLoadSequence
  loadInitial(null)
  previewRevision.value += 1
  nextTick(() => {
    if (sequence === initialLoadSequence) {
      initialSnapshot.value = currentSnapshot.value
      initialRuleSnapshot.value = currentRuleSnapshot.value
      if (resettingSubmission) return
      const root = formRootRef.value
      const focused = document.activeElement
      const belongsToForm = root?.contains(focused)
      const disabledSubmitLostFocus =
        focused === document.body &&
        submittedFocus?.isConnected &&
        submittedFocus.disabled === true &&
        root?.contains(submittedFocus)
      if (props.active && !props.editorMode && (belongsToForm || disabledSubmitLostFocus))
        root?.querySelector('textarea')?.focus({ preventScroll: true })
      submittedFocus = null
    }
  })
}
defineExpose({ reset, hasChanges, clearDraft: () => protectedDraft.clear() })
onBeforeUnmount(() => {
  disposed = true
  void unlockSubmission({ restoreFocus: false })
  clearTimeout(previewTimer)
  cancelEntrance()
})
const protectedDraft = useDraftProtection({
  key: 'template:' + (props.initial?.id || 'new'),
  fields: {
    content,
    frequency,
    interval,
    weekdays,
    monthDays,
    quarterMonth,
    quarterDays,
    yearDates,
    timeOfDay,
    startAt,
    endAt,
    reminderChannels,
    isPinned,
    tagIds
  },
  dirty: () => hasChanges.value,
  busy: () => props.submitting,
  restoreExtra: () => {
    // Restored time is already a user choice; first expansion must not replace it.
    hasActivated = true
  }
})
</script>

<template>
  <form
    ref="formRootRef"
    class="tf-root"
    :class="{ 'tf-root--editor': editorMode }"
    :aria-busy="submitting || submissionLocked"
    @submit.prevent="submit"
  >
    <div class="tf-fields scroll-y" :inert="submitting || submissionLocked">
      <ResizableTextarea
        v-model="content"
        :initial-focus="editorMode"
        :rows="2"
        placeholder="请输入循环生成的便签内容…（Enter 换行）"
      />

      <TemplateFrequencySelector
        v-model:frequency="frequency"
        v-model:interval="interval"
        v-model:weekdays="weekdays"
        v-model:month-days="monthDays"
        v-model:quarter-month="quarterMonth"
        v-model:quarter-days="quarterDays"
        v-model:year-dates="yearDates"
      />

      <div class="tf-row">
        <label
          >生成时间<HelpButton
            text="每次在该时刻生成一条进行中的单日便签；上一条便签及其状态、稍后提醒保留。"
        /></label>
        <TimePicker v-model="timeOfDay" aria-label="选择模板生成时间" />
      </div>
      <div class="tf-time-range">
        <div class="tf-row">
          <label
            >开始时间<HelpButton
              text="限定循环有效期，未设置时从本次保存开始。第一条不会因保存立即生成，以“下一次生成”为准。"
          /></label>
          <DateTimePicker
            v-model="startAt"
            class="tf-date-picker"
            placeholder="保存后开始"
            :default-time="`${timeOfDay}:00`"
            aria-label="选择模板开始时间"
          />
        </div>
        <div class="tf-row">
          <label
            >结束时间<HelpButton text="可留空，表示模板持续循环；到达结束时间后不再生成。"
          /></label>
          <DateTimePicker
            v-model="endAt"
            class="tf-date-picker"
            placeholder="永不结束"
            :default-time="`${timeOfDay}:00`"
            aria-label="选择模板结束时间"
          />
        </div>
        <p v-if="timeRangeError" class="tf-range-error">{{ timeRangeError }}</p>
      </div>
      <div class="tf-preview">
        <span>{{ previewLabel }}</span>
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
      <div class="tf-notification-field">
        <ReminderChannelPicker
          v-model="reminderChannels"
          help-text="默认不提醒，开启后在每次生成时提醒。修改这里只影响之后生成的便签；稍后提醒只属于本次实例。"
        />
      </div>
      <div class="tf-row">
        <label
          >生成的便签是否置顶
          <HelpButton text="只决定以后生成的便签是否置顶，不会改变已经生成的便签。"
        /></label>
        <AppToggle v-model="isPinned" aria-label="生成的便签是否置顶" />
      </div>
      <div class="tf-field">
        <label>标签</label>
        <TagSelector
          v-model="tagIds"
          :max-selected="MAX_ASSIGNED_TAGS"
          @selection-limit-exceeded="showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)"
        />
      </div>
    </div>

    <div class="tf-actions">
      <BaseButton
        v-if="showCancel"
        type="button"
        class="tf-secondary"
        :disabled="submitting"
        variant="default"
        @click="emit('cancel')"
      >
        {{ hasChanges ? '放弃修改' : '关闭' }}
      </BaseButton>
      <BaseButton type="submit" class="tf-submit" :disabled="!canSubmit" variant="primary">
        {{ submitting ? '保存中…' : submitLabel }}
      </BaseButton>
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
.tf-notification-field {
  display: flex;
  flex-direction: column;
  gap: 5rem;
}
.tf-time-range {
  display: flex;
  flex-direction: column;
  gap: 9rem;
}
.tf-time-range .tf-row {
  display: flex;
  flex-wrap: wrap;
  gap: 5rem;
}
.tf-date-picker {
  flex: 1 1 12em;
  width: auto;
  min-width: 0;
}
.tf-range-error {
  margin: 0;
  color: var(--ui-danger);
  font-size: var(--fs-secondary);
  text-align: right;
}
.tf-platform-note {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.5;
  opacity: 0.72;
}
.tf-preview {
  min-height: 32rem;
  flex-wrap: wrap;
}
.tf-preview-value {
  display: grid;
  min-width: 0;
  max-width: 100%;
  margin-left: auto;
  justify-items: end;
}
.tf-preview-value strong {
  grid-area: 1 / 1;
  color: #0a84ff;
  font-weight: 600;
  overflow-wrap: anywhere;
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
  flex-wrap: wrap;
  gap: 9rem;
  padding-top: 2rem;
}
.tf-submit,
.tf-secondary {
  flex: 1 1 110rem;
}
.tf-row {
  flex-wrap: wrap;
}
.tf-row > label,
.tf-row > :deep(.time-picker) {
  min-width: 0;
  max-width: 100%;
}
input,
textarea {
  max-width: 100%;
}
</style>
