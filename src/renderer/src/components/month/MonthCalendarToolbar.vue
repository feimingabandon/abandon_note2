<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import NumberStepper from '../ui/NumberStepper.vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'
import {
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
  addCalendarDays,
  buildMonthGrid,
  buildWeekGrid,
  dateKeyFromParts,
  parseDateKey
} from '../../../../shared/calendar/calendar-date-rules.js'

const props = defineProps({
  viewMode: { type: String, default: 'month' },
  year: { type: Number, required: true },
  month: { type: Number, required: true },
  weekStart: { type: String, default: '' },
  weekEnd: { type: String, default: '' },
  selectedKey: { type: String, default: '' },
  refreshing: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  weatherLocationLabel: { type: String, default: '' },
  weatherSourceLabel: { type: String, default: '' }
})
const emit = defineEmits(['previous', 'next', 'today', 'jump', 'jump-date', 'refresh'])
const isWeekView = computed(() => props.viewMode === 'week')
const pickerOpen = ref(false)
const pickerGuardVisible = ref(false)
const pickerTriggerRef = ref(null)
const pickerPanelRef = ref(null)
const rollDirection = ref('forward')
const draftYear = ref(props.year)
const draftMonth = ref(props.month)
const pickerYear = ref(props.year)
const pickerMonth = ref(props.month)
const pickerMonthDirection = ref('forward')
const pickerPeriodOpen = ref(false)
const refreshSpinActive = ref(false)
let refreshSpinFinished = true

watch(
  () => props.refreshing,
  (refreshing) => {
    if (refreshing) {
      refreshSpinFinished = false
      refreshSpinActive.value = true
    } else if (refreshSpinFinished) {
      refreshSpinActive.value = false
    }
  },
  { immediate: true }
)

watch(
  () => props.weekStart,
  (current, previous) => {
    if (!current || !previous || current === previous) return
    rollDirection.value = current > previous ? 'forward' : 'backward'
  }
)

watch(
  () => [props.year, props.month],
  ([year, month]) => {
    draftYear.value = year
    draftMonth.value = month
  }
)

watch(
  () => props.busy,
  (busy, wasBusy) => {
    if (!busy && wasBusy) {
      draftYear.value = props.year
      draftMonth.value = props.month
    }
  }
)

watch(
  () => [props.year, props.month],
  ([year, month], [previousYear, previousMonth]) => {
    if (isWeekView.value) return
    const current = year * 12 + month
    const previous = previousYear * 12 + previousMonth
    rollDirection.value = current >= previous ? 'forward' : 'backward'
  }
)

const numberTransitionName = computed(() =>
  rollDirection.value === 'forward' ? 'month-number-up' : 'month-number-down'
)
const weekRangeLabel = computed(() => {
  if (!props.weekStart || !props.weekEnd) return ''
  const start = parseDateKey(props.weekStart)
  const end = parseDateKey(props.weekEnd)
  if (start.year !== end.year) {
    return `${start.year}年${start.month}月${start.day}日—${end.year}年${end.month}月${end.day}日`
  }
  if (start.month !== end.month) {
    return `${start.year}年${start.month}月${start.day}日—${end.month}月${end.day}日`
  }
  return `${start.year}年${start.month}月${start.day}日—${end.day}日`
})
const pickerMonthLabel = computed(() => `${pickerYear.value}年${pickerMonth.value}月`)
const pickerWeekdays = ['一', '二', '三', '四', '五', '六', '日']
const minDateKey = dateKeyFromParts(MIN_CALENDAR_YEAR, 1, 1)
const maxDateKey = dateKeyFromParts(MAX_CALENDAR_YEAR, 12, 31)
const maxWeekDateKey = buildWeekGrid(maxDateKey).weekEnd
const pickerNow = new Date()
const pickerTodayKey = dateKeyFromParts(
  pickerNow.getFullYear(),
  pickerNow.getMonth() + 1,
  pickerNow.getDate()
)
const weekPickerDays = computed(() => {
  return buildMonthGrid(pickerYear.value, pickerMonth.value).days.map((day) => ({
    ...day,
    inCurrentWeek: Boolean(
      props.weekStart && day.key >= props.weekStart && day.key <= props.weekEnd
    ),
    isSelected: day.key === props.selectedKey,
    isToday: day.key === pickerTodayKey,
    disabled: day.key < minDateKey || day.key > maxWeekDateKey
  }))
})
const previousDisabled = computed(() =>
  isWeekView.value
    ? Boolean(props.weekStart && addCalendarDays(props.weekStart, -7) < minDateKey)
    : props.year === MIN_CALENDAR_YEAR && props.month === 1
)
const nextDisabled = computed(() =>
  isWeekView.value
    ? Boolean(props.weekStart && addCalendarDays(props.weekStart, 7) > maxDateKey)
    : props.year === MAX_CALENDAR_YEAR && props.month === 12
)

function commitJump() {
  const year = Math.min(MAX_CALENDAR_YEAR, Math.max(MIN_CALENDAR_YEAR, Number(draftYear.value)))
  const month = Math.min(12, Math.max(1, Number(draftMonth.value)))
  draftYear.value = year
  draftMonth.value = month
  emit('jump', { year, month })
}

function updateYear(value) {
  draftYear.value = value
  commitJump()
}

function updateMonth(value) {
  draftMonth.value = value
  commitJump()
}

async function togglePicker() {
  if (pickerOpen.value) {
    closePicker()
    return
  }
  if (isWeekView.value) {
    const selected = parseDateKey(props.selectedKey || props.weekStart)
    // 上限年份最后一周会自然跨到下一年；年月面板停留在可构建的 2100 年 12 月，
    // 日期网格仍会显示并允许选择这一完整周的 2101-01-01/02。
    pickerYear.value = Math.min(MAX_CALENDAR_YEAR, Math.max(MIN_CALENDAR_YEAR, selected.year))
    pickerMonth.value = selected.year > MAX_CALENDAR_YEAR ? 12 : selected.month
    pickerPeriodOpen.value = false
  }
  pickerGuardVisible.value = true
  pickerOpen.value = true
  await nextTick()
  pickerPanelRef.value
    ?.querySelector('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
    ?.focus()
}

function closePicker() {
  pickerOpen.value = false
  pickerPeriodOpen.value = false
}

function closePickerAndRestoreFocus() {
  closePicker()
  void nextTick(() => pickerTriggerRef.value?.focus())
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && pickerOpen.value) closePickerAndRestoreFocus()
}

function finishPickerLeave() {
  if (!pickerOpen.value) pickerGuardVisible.value = false
}

function onPickerEnter(element, done) {
  enterPopover(element, done, 'dropdown')
}

function onPickerLeave(element, done) {
  leavePopover(element, done, 'dropdown')
}

function goPrevious() {
  if (previousDisabled.value) return
  emit('previous')
}

function goNext() {
  if (nextDisabled.value) return
  emit('next')
}

function movePickerMonth(delta) {
  const target = new Date(pickerYear.value, pickerMonth.value - 1 + delta, 1)
  if (target.getFullYear() < MIN_CALENDAR_YEAR || target.getFullYear() > MAX_CALENDAR_YEAR) {
    return
  }
  pickerMonthDirection.value = delta > 0 ? 'forward' : 'backward'
  pickerYear.value = target.getFullYear()
  pickerMonth.value = target.getMonth() + 1
}

function updatePickerYear(value) {
  pickerMonthDirection.value = value >= pickerYear.value ? 'forward' : 'backward'
  pickerYear.value = value
}

function choosePickerMonth(value) {
  pickerMonthDirection.value =
    pickerYear.value * 12 + value >= pickerYear.value * 12 + pickerMonth.value
      ? 'forward'
      : 'backward'
  pickerMonth.value = value
  pickerPeriodOpen.value = false
}

function selectWeekDate(day) {
  if (props.busy || day.disabled) return
  emit('jump-date', day.key)
  closePickerAndRestoreFocus()
}

function goToday() {
  emit('today')
}

function finishRefreshSpin() {
  refreshSpinFinished = true
  if (!props.refreshing) refreshSpinActive.value = false
}

document.addEventListener('keydown', onDocumentKeydown)
onBeforeUnmount(() => document.removeEventListener('keydown', onDocumentKeydown))
</script>

<template>
  <header class="month-toolbar" :class="{ 'is-busy': busy }">
    <button
      v-if="weatherLocationLabel"
      type="button"
      class="month-toolbar__weather-meta"
      title="查看天气数据来源"
      @click="window.api.openWeatherSource()"
    >
      <span>{{ weatherLocationLabel }}</span>
      <i aria-hidden="true">·</i>
      <small>{{ weatherSourceLabel }}</small>
    </button>
    <div v-else aria-hidden="true"></div>

    <div class="month-toolbar__navigation" :aria-label="isWeekView ? '周导航' : '月份导航'">
      <button
        ref="pickerTriggerRef"
        type="button"
        class="month-toolbar__month-arrow"
        :aria-label="isWeekView ? '上一周' : '上个月'"
        :title="isWeekView ? '上一周' : '上个月'"
        :disabled="previousDisabled || (!isWeekView && busy)"
        @click="goPrevious"
      >
        <svg class="month-toolbar__arrow-icon" viewBox="0 0 12 18" aria-hidden="true">
          <path d="m8.5 3-5 6 5 6" />
        </svg>
      </button>
      <button
        type="button"
        class="month-toolbar__title"
        :class="{ 'is-open': pickerOpen }"
        :aria-label="isWeekView ? '选择日期' : '选择年份和月份'"
        aria-haspopup="dialog"
        :aria-expanded="pickerOpen"
        @click="togglePicker"
      >
        <span v-if="isWeekView" class="month-toolbar__title-label is-week" aria-live="polite">
          <Transition :name="numberTransitionName">
            <span :key="weekRangeLabel" class="month-toolbar__week-range">
              {{ weekRangeLabel }}
            </span>
          </Transition>
        </span>
        <span v-else class="month-toolbar__title-label" aria-live="polite">
          <span class="month-toolbar__value-slot is-year">
            <Transition :name="numberTransitionName">
              <span :key="year" class="month-toolbar__value">{{ year }}</span>
            </Transition>
          </span>
          <span>年</span>
          <span class="month-toolbar__value-slot is-month">
            <Transition :name="numberTransitionName">
              <span :key="month" class="month-toolbar__value">{{ month }}</span>
            </Transition>
          </span>
          <span>月</span>
        </span>
        <svg viewBox="0 0 12 8" aria-hidden="true"><path d="m2 2 4 4 4-4" /></svg>
      </button>
      <button
        type="button"
        class="month-toolbar__month-arrow"
        :aria-label="isWeekView ? '下一周' : '下个月'"
        :title="isWeekView ? '下一周' : '下个月'"
        :disabled="nextDisabled || (!isWeekView && busy)"
        @click="goNext"
      >
        <svg class="month-toolbar__arrow-icon" viewBox="0 0 12 18" aria-hidden="true">
          <path d="m3.5 3 5 6-5 6" />
        </svg>
      </button>

      <div
        v-if="pickerGuardVisible"
        class="month-toolbar__picker-backdrop"
        aria-hidden="true"
        @pointerdown.stop
        @click.stop="closePickerAndRestoreFocus"
      />

      <Transition
        :css="false"
        @enter="onPickerEnter"
        @leave="onPickerLeave"
        @after-leave="finishPickerLeave"
      >
        <section
          v-if="pickerOpen"
          ref="pickerPanelRef"
          class="month-toolbar__picker"
          role="dialog"
          :aria-label="isWeekView ? '选择日期' : '选择年月'"
          :aria-busy="busy"
          :inert="busy"
          @click.stop
        >
          <template v-if="isWeekView">
            <header class="month-toolbar__date-picker-header">
              <button
                type="button"
                aria-label="上个月"
                :disabled="pickerYear === MIN_CALENDAR_YEAR && pickerMonth === 1"
                @click="movePickerMonth(-1)"
              >
                <svg viewBox="0 0 12 18" aria-hidden="true"><path d="m8.5 3-5 6 5 6" /></svg>
              </button>
              <button
                type="button"
                class="month-toolbar__date-picker-period"
                aria-haspopup="dialog"
                :aria-expanded="pickerPeriodOpen"
                @click="pickerPeriodOpen = !pickerPeriodOpen"
              >
                {{ pickerMonthLabel }}
                <svg viewBox="0 0 12 8" aria-hidden="true"><path d="m2 2 4 4 4-4" /></svg>
              </button>
              <button
                type="button"
                aria-label="下个月"
                :disabled="pickerYear === MAX_CALENDAR_YEAR && pickerMonth === 12"
                @click="movePickerMonth(1)"
              >
                <svg viewBox="0 0 12 18" aria-hidden="true"><path d="m3.5 3 5 6-5 6" /></svg>
              </button>
            </header>
            <div v-if="pickerPeriodOpen" class="month-toolbar__date-picker-period-panel">
              <div class="month-toolbar__date-picker-year">
                <span>年份</span>
                <NumberStepper
                  :model-value="pickerYear"
                  :min="MIN_CALENDAR_YEAR"
                  :max="MAX_CALENDAR_YEAR"
                  :disabled="busy"
                  aria-label="日期选择年份"
                  @update:model-value="updatePickerYear"
                />
              </div>
              <div class="month-toolbar__date-picker-months" aria-label="选择月份">
                <button
                  v-for="value in 12"
                  :key="value"
                  type="button"
                  class="month-toolbar__date-picker-month"
                  :class="{ 'is-active': pickerMonth === value }"
                  :data-value="value"
                  :aria-label="`选择${value}月`"
                  :aria-pressed="pickerMonth === value"
                  :disabled="busy"
                  @click="choosePickerMonth(value)"
                >
                  {{ value }}月
                </button>
              </div>
            </div>
            <template v-else>
              <div class="month-toolbar__date-picker-weekdays" aria-hidden="true">
                <span v-for="weekday in pickerWeekdays" :key="weekday">{{ weekday }}</span>
              </div>
              <Transition :name="`month-picker-${pickerMonthDirection}`" mode="out-in">
                <div :key="`${pickerYear}-${pickerMonth}`" class="month-toolbar__date-picker-days">
                  <button
                    v-for="day in weekPickerDays"
                    :key="day.key"
                    type="button"
                    class="month-toolbar__date-option"
                    :class="{
                      'is-other': !day.inCurrentMonth,
                      'is-week': day.inCurrentWeek,
                      'is-selected': day.isSelected,
                      'is-today': day.isToday
                    }"
                    :disabled="busy || day.disabled"
                    :aria-label="day.key"
                    :aria-pressed="day.isSelected"
                    :aria-current="day.isToday ? 'date' : undefined"
                    @click="selectWeekDate(day)"
                  >
                    {{ day.day }}
                  </button>
                </div>
              </Transition>
            </template>
          </template>
          <template v-else>
            <div class="month-toolbar__picker-year">
              <span>年份</span>
              <NumberStepper
                :model-value="draftYear"
                :min="MIN_CALENDAR_YEAR"
                :max="MAX_CALENDAR_YEAR"
                :disabled="busy"
                aria-label="年份"
                @update:model-value="updateYear"
              />
            </div>
            <div class="month-toolbar__months" aria-label="月份">
              <button
                v-for="value in 12"
                :key="value"
                type="button"
                class="month-toolbar__month-option"
                :class="{ 'is-active': draftMonth === value }"
                :data-value="value"
                :disabled="busy"
                @click="updateMonth(value)"
              >
                {{ value }} 月
              </button>
            </div>
          </template>
        </section>
      </Transition>
    </div>

    <div class="month-toolbar__actions">
      <button type="button" class="month-toolbar__today" :disabled="busy" @click="goToday">
        今天
      </button>
      <button
        type="button"
        class="month-toolbar__refresh"
        :disabled="busy || refreshing || refreshSpinActive"
        title="刷新"
        :aria-label="isWeekView ? '刷新周视图' : '刷新月视图'"
        @click="emit('refresh')"
      >
        <svg
          :class="{ 'is-spinning': refreshSpinActive }"
          viewBox="0 0 20 20"
          aria-hidden="true"
          @animationend="finishRefreshSpin"
        >
          <path d="M16 7a7 7 0 1 0 .4 5M16 3v4h-4" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.month-toolbar {
  display: grid;
  min-height: 42rem;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 12rem;
  padding: 0 4rem;
}
.month-toolbar__navigation,
.month-toolbar__actions {
  display: flex;
  align-items: center;
  gap: 5rem;
}
.month-toolbar__navigation {
  position: relative;
  z-index: var(--z-local-top);
  justify-self: center;
  gap: 9rem;
}
.month-toolbar__actions {
  justify-self: end;
}
.month-toolbar__weather-meta {
  display: flex !important;
  min-width: 0 !important;
  max-width: 100%;
  height: 30rem !important;
  align-items: center !important;
  justify-self: start;
  flex-direction: row;
  gap: 5rem;
  padding: 0 7rem !important;
  color: var(--text-color-secondary) !important;
  line-height: 1.15;
  text-align: left;
}
.month-toolbar__weather-meta:hover:not(:disabled) {
  background: transparent !important;
  color: var(--text-color) !important;
}
.month-toolbar__weather-meta span,
.month-toolbar__weather-meta small {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.month-toolbar__weather-meta span {
  min-width: 0;
  font-size: var(--fs-secondary);
  font-weight: 500;
}
.month-toolbar__weather-meta i {
  flex: 0 0 auto;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-style: normal;
  opacity: 0.55;
}
.month-toolbar__weather-meta small {
  flex: 0 1 auto;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.72);
  font-weight: 400;
  opacity: 0.72;
}
.month-toolbar button {
  display: grid;
  height: 30rem;
  place-items: center;
  border: 0;
  border-radius: 8rem;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  outline: none;
}
.month-toolbar button {
  min-width: 30rem;
  cursor: pointer;
  font-size: 18rem;
  transition:
    border-color 150ms ease,
    background-color 150ms ease,
    transform 120ms ease;
}
.month-toolbar button:hover:not(:disabled) {
  background: var(--ui-fill-hover);
}
.month-toolbar button:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, #0a84ff 24%, transparent);
}
.month-toolbar button:disabled {
  cursor: default;
  opacity: 0.35;
}
.month-toolbar.is-busy button:disabled {
  opacity: 1;
}
.month-toolbar button:not([aria-haspopup]):active:not(:disabled) {
  transform: scale(0.98);
}
.month-toolbar__today {
  padding: 0 11rem;
  background: var(--ui-surface-control);
  font-size: var(--fs-secondary) !important;
}
.month-toolbar__month-arrow {
  width: 34rem;
  height: 34rem !important;
  padding: 0;
}
.month-toolbar__arrow-icon {
  display: block;
  width: 12rem;
  height: 18rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}
.month-toolbar__title {
  display: flex !important;
  min-width: 0 !important;
  align-items: center;
  justify-content: center;
  gap: 7rem;
  padding: 0 10rem;
  color: var(--text-color);
  font-size: calc(var(--fs-body) * 1.12) !important;
  font-weight: 650;
  line-height: 1;
  text-align: center;
  white-space: nowrap;
}
.month-toolbar__title.is-open {
  position: relative;
  z-index: var(--z-local-raised);
}
.month-toolbar__title-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.month-toolbar__title-label.is-week {
  display: inline-grid;
  width: 29ch;
  place-items: center;
}
.month-toolbar__week-range {
  grid-area: 1 / 1;
  line-height: 1.2;
}
.month-toolbar__value-slot {
  display: inline-grid;
  overflow: hidden;
  place-items: center;
}
.month-toolbar__value-slot.is-year {
  width: 4.2ch;
}
.month-toolbar__value-slot.is-month {
  width: 2.2ch;
}
.month-toolbar__value {
  grid-area: 1 / 1;
  line-height: 1.2;
}
.month-number-up-enter-active,
.month-number-up-leave-active,
.month-number-down-enter-active,
.month-number-down-leave-active {
  transition:
    opacity 260ms var(--ease-emphasized),
    transform 300ms cubic-bezier(0.2, 0, 0, 1);
}
.month-number-up-enter-from {
  opacity: 0;
  transform: translateY(85%);
}
.month-number-up-leave-to {
  opacity: 0;
  transform: translateY(-85%);
}
.month-number-down-enter-from {
  opacity: 0;
  transform: translateY(-85%);
}
.month-number-down-leave-to {
  opacity: 0;
  transform: translateY(85%);
}
.month-toolbar__title svg {
  width: 10rem;
  height: 7rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
  opacity: 0.5;
  transition:
    opacity 150ms ease,
    transform 220ms var(--ease-standard);
}
.month-toolbar__title:hover svg,
.month-toolbar__title.is-open svg {
  opacity: 0.85;
}
.month-toolbar__title.is-open svg {
  transform: rotate(180deg);
}
.month-toolbar__refresh {
  width: 30rem;
  padding: 0;
  color: var(--text-color-secondary) !important;
}
.month-toolbar__refresh:hover:not(:disabled) {
  color: var(--text-color) !important;
}
.month-toolbar__refresh svg {
  width: 17rem;
  height: 17rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}
.month-toolbar__refresh svg.is-spinning {
  animation: month-toolbar-spin 520ms var(--ease-emphasized);
}
.month-toolbar__picker {
  position: absolute;
  z-index: var(--z-local-overlay);
  top: calc(100% + 5rem);
  left: 50%;
  width: 260rem;
  overflow: hidden;
  padding: 12rem;
  border: 1px solid var(--surface-float-border);
  border-radius: 10rem;
  background: var(--surface-float);
  box-shadow: 0 10rem 30rem rgba(0, 0, 0, 0.24);
  transform: translateX(-50%);
  transform-origin: top center;
  will-change: clip-path;
}
.month-toolbar__date-picker-header {
  display: grid;
  grid-template-columns: 30rem minmax(0, 1fr) 30rem;
  align-items: center;
  color: var(--text-color);
}
.month-toolbar__date-picker-header button {
  width: 30rem;
  padding: 0;
}
.month-toolbar__date-picker-header svg {
  width: 10rem;
  height: 16rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.7;
}
.month-toolbar__date-picker-period {
  display: flex !important;
  width: auto !important;
  min-width: 0 !important;
  align-items: center;
  justify-content: center;
  gap: 6rem;
  padding: 0 8rem !important;
  font-size: var(--fs-body) !important;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}
.month-toolbar__date-picker-period svg {
  width: 9rem;
  height: 6rem;
  opacity: 0.55;
  transition: transform 220ms var(--ease-standard);
}
.month-toolbar__date-picker-period[aria-expanded='true'] svg {
  transform: rotate(180deg);
}
.month-toolbar__date-picker-period-panel {
  min-height: 226rem;
  padding-top: 12rem;
}
.month-toolbar__date-picker-year {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.month-toolbar__date-picker-year :deep(.number-stepper) {
  width: 104rem;
  height: 32rem;
}
.month-toolbar__date-picker-months {
  display: grid;
  margin-top: 12rem;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5rem;
}
.month-toolbar__date-picker-month {
  min-width: 0 !important;
  height: 35rem !important;
  border-radius: 7rem !important;
  color: var(--text-color-secondary) !important;
  font-size: var(--fs-secondary) !important;
}
.month-toolbar__date-picker-month.is-active {
  background: color-mix(in srgb, #0a84ff 14%, transparent);
  color: #0a84ff !important;
  font-weight: 650;
}
.month-toolbar__date-picker-weekdays,
.month-toolbar__date-picker-days {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 3rem;
}
.month-toolbar__date-picker-weekdays {
  margin: 9rem 0 4rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.78);
  text-align: center;
}
.month-toolbar__date-picker-days {
  min-height: 195rem;
}
.month-toolbar__date-option {
  position: relative;
  min-width: 0 !important;
  height: 30rem !important;
  border-radius: 7rem !important;
  color: var(--text-color) !important;
  font-size: var(--fs-secondary) !important;
  font-variant-numeric: tabular-nums;
}
.month-toolbar__date-option.is-other {
  color: var(--text-color-secondary) !important;
  opacity: 0.5;
}
.month-toolbar__date-option.is-week {
  background: color-mix(in srgb, #0a84ff 11%, transparent);
  color: #0a84ff !important;
}
.month-toolbar__date-option.is-selected {
  background: #0a84ff;
  color: #fff !important;
  font-weight: 650;
  opacity: 1;
}
.month-toolbar__date-option.is-today:not(.is-selected)::after {
  position: absolute;
  right: 50%;
  bottom: 2rem;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  background: #0a84ff;
  content: '';
  transform: translateX(50%);
}
.month-picker-forward-enter-active,
.month-picker-forward-leave-active,
.month-picker-backward-enter-active,
.month-picker-backward-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms var(--ease-standard);
}
.month-picker-forward-enter-from,
.month-picker-backward-leave-to {
  opacity: 0;
  transform: translateX(10rem);
}
.month-picker-forward-leave-to,
.month-picker-backward-enter-from {
  opacity: 0;
  transform: translateX(-10rem);
}
.month-toolbar__picker-backdrop {
  position: fixed;
  z-index: var(--z-local-content);
  inset: 0;
  cursor: default;
}
.month-toolbar.is-busy .month-toolbar__picker-year,
.month-toolbar.is-busy .month-toolbar__months {
  opacity: 0.55;
  pointer-events: none;
}
.month-toolbar__picker-year {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.month-toolbar__picker-year :deep(.number-stepper) {
  width: 104rem;
  height: 32rem;
}
.month-toolbar__months {
  display: grid;
  margin-top: 10rem;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5rem;
}
.month-toolbar__month-option {
  min-width: 0 !important;
  height: 30rem !important;
  border-radius: 7rem !important;
  color: var(--text-color-secondary) !important;
  font-size: var(--fs-secondary) !important;
}
.month-toolbar__month-option.is-active {
  background: color-mix(in srgb, #0a84ff 14%, transparent);
  color: #0a84ff !important;
  font-weight: 650;
}
@keyframes month-toolbar-spin {
  to {
    transform: rotate(720deg);
  }
}
@media (max-width: 760px) {
  .month-toolbar {
    gap: 6rem;
  }
  .month-toolbar__navigation {
    gap: 3rem;
  }
  .month-toolbar__title {
    min-width: 0 !important;
  }
}
</style>
