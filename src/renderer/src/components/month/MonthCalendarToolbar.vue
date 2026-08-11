<script setup>
import { computed, ref, watch } from 'vue'
import NumberStepper from '../ui/NumberStepper.vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'
import {
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR
} from '../../../../shared/calendar/calendar-date-rules.js'

const props = defineProps({
  year: { type: Number, required: true },
  month: { type: Number, required: true },
  refreshing: { type: Boolean, default: false },
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['previous', 'next', 'today', 'jump', 'refresh'])
const pickerOpen = ref(false)
const pickerGuardVisible = ref(false)
const rollDirection = ref('forward')
const draftYear = ref(props.year)
const draftMonth = ref(props.month)
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
    const current = year * 12 + month
    const previous = previousYear * 12 + previousMonth
    rollDirection.value = current >= previous ? 'forward' : 'backward'
  }
)

const numberTransitionName = computed(() =>
  rollDirection.value === 'forward' ? 'month-number-up' : 'month-number-down'
)

function playControlAnimation(element, keyframes, duration = 280) {
  if (!element?.animate) return
  element.getAnimations().forEach((animation) => animation.cancel())
  element.animate(keyframes, {
    duration,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
  })
}

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

function togglePicker(event) {
  playControlAnimation(event?.currentTarget, [
    { transform: 'translateY(0) scale(1)' },
    { transform: 'translateY(2rem) scale(0.98)', offset: 0.38 },
    { transform: 'translateY(0) scale(1)' }
  ])
  if (pickerOpen.value) {
    closePicker()
    return
  }
  pickerGuardVisible.value = true
  pickerOpen.value = true
}

function closePicker() {
  pickerOpen.value = false
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
  if (props.year === MIN_CALENDAR_YEAR && props.month === 1) return
  emit('previous')
}

function goNext() {
  if (props.year === MAX_CALENDAR_YEAR && props.month === 12) return
  emit('next')
}

function goToday() {
  emit('today')
}

function finishRefreshSpin() {
  refreshSpinFinished = true
  if (!props.refreshing) refreshSpinActive.value = false
}
</script>

<template>
  <header class="month-toolbar" :class="{ 'is-busy': busy }">
    <div aria-hidden="true"></div>

    <div class="month-toolbar__navigation" aria-label="月份导航">
      <button
        type="button"
        class="month-toolbar__month-arrow"
        aria-label="上个月"
        title="上个月"
        :disabled="busy || (year === MIN_CALENDAR_YEAR && month === 1)"
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
        aria-label="选择年份和月份"
        aria-haspopup="dialog"
        :aria-expanded="pickerOpen"
        @click="togglePicker"
      >
        <span class="month-toolbar__title-label" aria-live="polite">
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
        aria-label="下个月"
        title="下个月"
        :disabled="busy || (year === MAX_CALENDAR_YEAR && month === 12)"
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
        @click.stop="closePicker"
      />

      <Transition
        :css="false"
        @enter="onPickerEnter"
        @leave="onPickerLeave"
        @after-leave="finishPickerLeave"
      >
        <section
          v-if="pickerOpen"
          class="month-toolbar__picker"
          role="dialog"
          aria-label="选择年月"
          :aria-busy="busy"
          :inert="busy"
          @click.stop
        >
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
        aria-label="刷新月视图"
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
  padding: 0 4rem 10rem;
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
.month-toolbar button:active:not(:disabled) {
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
