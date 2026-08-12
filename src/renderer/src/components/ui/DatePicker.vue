<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'
import {
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
  buildMonthGrid,
  localDateKey,
  parseDateKey
} from '../../../../shared/calendar/calendar-date-rules.js'

const props = defineProps({
  modelValue: { type: String, required: true },
  ariaLabel: { type: String, default: '选择日期' }
})
const emit = defineEmits(['update:modelValue', 'change'])

const open = ref(false)
const triggerRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({})
const viewYear = ref(new Date().getFullYear())
const viewMonth = ref(new Date().getMonth() + 1)
const monthDirection = ref('next')
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const selectedParts = computed(() => {
  try {
    return parseDateKey(props.modelValue)
  } catch {
    return null
  }
})
const displayValue = computed(() => {
  const value = selectedParts.value
  return value ? `${value.year}年${value.month}月${value.day}日` : '选择日期'
})
const monthLabel = computed(() => `${viewYear.value}年 ${viewMonth.value}月`)
const cells = computed(() => buildMonthGrid(viewYear.value, viewMonth.value).days)
const todayKey = computed(() => localDateKey())
const canMovePrevious = computed(() => viewYear.value > MIN_CALENDAR_YEAR || viewMonth.value > 1)
const canMoveNext = computed(() => viewYear.value < MAX_CALENDAR_YEAR || viewMonth.value < 12)

function syncView() {
  const selected = selectedParts.value
  const fallback = new Date()
  viewYear.value = selected?.year ?? fallback.getFullYear()
  viewMonth.value = selected?.month ?? fallback.getMonth() + 1
}

function updatePosition() {
  const triggerRect = triggerRef.value?.getBoundingClientRect()
  const panelRect = panelRef.value?.getBoundingClientRect()
  if (!triggerRect || !panelRect) return
  const left = Math.max(12, Math.min(window.innerWidth - panelRect.width - 12, triggerRect.left))
  const belowTop = triggerRect.bottom + 7
  const top =
    belowTop + panelRect.height <= window.innerHeight - 12
      ? belowTop
      : Math.max(12, triggerRect.top - panelRect.height - 7)
  panelStyle.value = { left: `${left}px`, top: `${top}px` }
}

async function openPanel() {
  syncView()
  open.value = true
  await nextTick()
  updatePosition()
  window.addEventListener('resize', updatePosition)
}

function closePanel() {
  open.value = false
  window.removeEventListener('resize', updatePosition)
}

function togglePanel() {
  if (open.value) closePanel()
  else void openPanel()
}

function moveMonth(delta) {
  if ((delta < 0 && !canMovePrevious.value) || (delta > 0 && !canMoveNext.value)) return
  monthDirection.value = delta > 0 ? 'next' : 'prev'
  const target = new Date(viewYear.value, viewMonth.value - 1 + delta, 1)
  viewYear.value = target.getFullYear()
  viewMonth.value = target.getMonth() + 1
}

function selectDate(dateKey) {
  const { year } = parseDateKey(dateKey)
  if (year < MIN_CALENDAR_YEAR || year > MAX_CALENDAR_YEAR) return
  emit('update:modelValue', dateKey)
  emit('change', dateKey)
  closePanel()
}

function selectToday() {
  selectDate(localDateKey())
}

function onDocumentPointerDown(event) {
  if (!open.value) return
  if (triggerRef.value?.contains(event.target) || panelRef.value?.contains(event.target)) return
  closePanel()
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && open.value) closePanel()
}

watch(
  () => props.modelValue,
  () => {
    if (open.value) syncView()
  }
)

document.addEventListener('pointerdown', onDocumentPointerDown)
document.addEventListener('keydown', onDocumentKeydown)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('resize', updatePosition)
})
</script>

<template>
  <div ref="triggerRef" class="date-picker">
    <button
      type="button"
      class="date-picker__trigger"
      :aria-label="ariaLabel"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="togglePanel"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="5.5" width="17" height="15" rx="3" />
        <path d="M7.5 3.5v4M16.5 3.5v4M3.5 9.5h17" />
      </svg>
      <span>{{ displayValue }}</span>
      <svg
        class="date-picker__chevron"
        :class="{ 'is-open': open }"
        viewBox="0 0 12 8"
        aria-hidden="true"
      >
        <path d="m2 2 4 4 4-4" />
      </svg>
    </button>

    <Teleport to="body">
      <Transition
        :css="false"
        @enter="(element, done) => enterPopover(element, done, 'dropdown')"
        @leave="(element, done) => leavePopover(element, done, 'dropdown')"
      >
        <section
          v-if="open"
          ref="panelRef"
          class="date-picker-panel"
          :style="panelStyle"
          role="dialog"
          :aria-label="ariaLabel"
        >
          <header class="date-picker-panel__header">
            <button
              type="button"
              aria-label="上个月"
              :disabled="!canMovePrevious"
              @click="moveMonth(-1)"
            >
              <svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" /></svg>
            </button>
            <strong>{{ monthLabel }}</strong>
            <button
              type="button"
              aria-label="下个月"
              :disabled="!canMoveNext"
              @click="moveMonth(1)"
            >
              <svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>
            </button>
          </header>

          <div class="date-picker-panel__weekdays">
            <span v-for="weekday in WEEKDAYS" :key="weekday">{{ weekday }}</span>
          </div>
          <Transition :name="`date-picker-month-${monthDirection}`" mode="out-in">
            <div :key="`${viewYear}-${viewMonth}`" class="date-picker-panel__calendar">
              <button
                v-for="cell in cells"
                :key="cell.key"
                type="button"
                class="date-picker-panel__day"
                :class="{
                  'is-other': !cell.inCurrentMonth,
                  'is-today': cell.key === todayKey,
                  'is-selected': cell.key === modelValue
                }"
                :aria-label="cell.key"
                :aria-pressed="cell.key === modelValue"
                :disabled="cell.year < MIN_CALENDAR_YEAR || cell.year > MAX_CALENDAR_YEAR"
                @click="selectDate(cell.key)"
              >
                <span>{{ cell.day }}</span>
              </button>
            </div>
          </Transition>
          <footer class="date-picker-panel__footer">
            <button type="button" @click="selectToday">今天</button>
          </footer>
        </section>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.date-picker {
  min-width: 0;
}
.date-picker__trigger {
  display: flex;
  width: 100%;
  min-height: 36rem;
  align-items: center;
  gap: 8rem;
  padding: 0 10rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 8rem;
  background: var(--ui-surface-control);
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-body);
  cursor: pointer;
  transition: border-color var(--motion-fast) ease;
}
.date-picker__trigger:hover,
.date-picker__trigger[aria-expanded='true'] {
  border-color: var(--ui-border-hover);
}
.date-picker__trigger span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.date-picker__trigger svg {
  width: 16rem;
  height: 16rem;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
  opacity: 0.62;
}
.date-picker__trigger .date-picker__chevron {
  width: 11rem;
  height: 8rem;
  transition: transform var(--motion-control) var(--ease-standard);
}
.date-picker__chevron.is-open {
  transform: rotate(180deg);
}
</style>

<style>
.date-picker-panel {
  position: fixed;
  z-index: var(--z-global-popover);
  width: min(310rem, calc(100vw - 24px));
  padding: 10rem;
  overflow: hidden;
  border: 1px solid var(--surface-float-border);
  border-radius: 13rem;
  background: var(--surface-float);
  box-shadow: 0 18rem 48rem rgba(0, 0, 0, 0.28);
  color: var(--text-color);
  transform-origin: top center;
}
.date-picker-panel__header {
  display: grid;
  min-height: 34rem;
  grid-template-columns: 30rem 1fr 30rem;
  align-items: center;
}
.date-picker-panel__header strong {
  font-size: var(--fs-body);
  font-weight: 600;
  text-align: center;
}
.date-picker-panel__header button {
  display: grid;
  width: 28rem;
  height: 28rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
}
.date-picker-panel__header button:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.date-picker-panel__header button:disabled {
  opacity: 0.28;
  cursor: default;
}
.date-picker-panel__header button:active {
  transform: scale(0.98);
}
.date-picker-panel__header svg {
  width: 14rem;
  height: 14rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.7;
}
.date-picker-panel__weekdays,
.date-picker-panel__calendar {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
.date-picker-panel__weekdays {
  padding: 5rem 0 3rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-align: center;
}
.date-picker-panel__calendar {
  overflow: hidden;
}
.date-picker-panel__day {
  display: grid;
  height: 34rem;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.date-picker-panel__day span {
  display: grid;
  width: 27rem;
  height: 27rem;
  place-items: center;
  border-radius: 50%;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.date-picker-panel__day:hover span {
  background: var(--ui-fill-hover);
}
.date-picker-panel__day:active span {
  transform: scale(0.98);
}
.date-picker-panel__day.is-other {
  color: color-mix(in srgb, var(--text-color) 28%, transparent);
}
.date-picker-panel__day:disabled {
  opacity: 0.22;
  cursor: default;
}
.date-picker-panel__day.is-today span {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #0a84ff 54%, transparent);
  color: #0a84ff;
}
.date-picker-panel__day.is-selected span {
  background: #0a84ff;
  box-shadow: none;
  color: #fff;
}
.date-picker-panel__footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 6rem;
  padding-top: 7rem;
  border-top: 1px solid var(--ui-border-divider);
}
.date-picker-panel__footer button {
  min-width: 58rem;
  height: 30rem;
  border: 0;
  border-radius: 8rem;
  background: transparent;
  color: #0a84ff;
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.date-picker-panel__footer button:hover {
  background: var(--ui-fill-hover);
}
.date-picker-month-next-enter-active,
.date-picker-month-next-leave-active,
.date-picker-month-prev-enter-active,
.date-picker-month-prev-leave-active {
  transition:
    opacity var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}
.date-picker-month-next-enter-from,
.date-picker-month-prev-leave-to {
  opacity: 0;
  transform: translateX(8rem);
}
.date-picker-month-next-leave-to,
.date-picker-month-prev-enter-from {
  opacity: 0;
  transform: translateX(-8rem);
}
</style>
