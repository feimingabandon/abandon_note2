<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'
import { normalizeYearDates } from '../../utils/templateRules.js'

const props = defineProps({
  modelValue: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:modelValue'])

const LEAP_YEAR = 2024
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const open = ref(false)
const triggerRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({})
const viewMonth = ref(0)
const monthDirection = ref('next')
const draftDates = ref([])

function dateKey(month, day) {
  return `${month}-${day}`
}

const selectedDates = computed(() => normalizeYearDates(props.modelValue))
const selectedKeys = computed(
  () => new Set(draftDates.value.map((date) => dateKey(date.month, date.day)))
)
const monthLabel = computed(() => `${viewMonth.value + 1}月`)
const calendarCells = computed(() => {
  const firstDay = new Date(LEAP_YEAR, viewMonth.value, 1).getDay()
  const mondayOffset = firstDay === 0 ? 6 : firstDay - 1
  const monthStart = new Date(LEAP_YEAR, viewMonth.value, 1)
  const monthEnd = new Date(LEAP_YEAR, viewMonth.value + 1, 0)
  const startDate = new Date(LEAP_YEAR, viewMonth.value, 1 - mondayOffset)

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate() + index
    )
    const month = date.getMonth() + 1
    const day = date.getDate()
    return {
      key: dateKey(month, day),
      month,
      day,
      currentMonth: date.getMonth() === viewMonth.value,
      monthDelta: date < monthStart ? -1 : date > monthEnd ? 1 : 0,
      selected: selectedKeys.value.has(dateKey(month, day))
    }
  })
})

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

function openPanel(month = selectedDates.value[0]?.month || 1) {
  draftDates.value = normalizeYearDates(props.modelValue)
  viewMonth.value = month - 1
  open.value = true
  nextTick(updatePosition)
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
}

function closePanel() {
  open.value = false
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
}

function togglePanel() {
  if (open.value) closePanel()
  else openPanel()
}

function moveMonth(delta) {
  monthDirection.value = delta > 0 ? 'next' : 'prev'
  viewMonth.value = (viewMonth.value + delta + 12) % 12
}

function toggleDate(cell) {
  if (!cell.currentMonth) {
    monthDirection.value = cell.monthDelta > 0 ? 'next' : 'prev'
    viewMonth.value = cell.month - 1
  }

  const next = new Map(draftDates.value.map((date) => [dateKey(date.month, date.day), { ...date }]))
  if (next.has(cell.key)) {
    if (next.size === 1) return
    next.delete(cell.key)
  } else next.set(cell.key, { month: cell.month, day: cell.day })
  draftDates.value = normalizeYearDates([...next.values()])
}

function applySelection() {
  emit('update:modelValue', normalizeYearDates(draftDates.value))
  closePanel()
}

function removeDate(date) {
  if (selectedDates.value.length <= 1) return
  emit(
    'update:modelValue',
    selectedDates.value.filter(
      (item) => dateKey(item.month, item.day) !== dateKey(date.month, date.day)
    )
  )
}

function onDocumentPointer(event) {
  if (!open.value) return
  if (triggerRef.value?.contains(event.target) || panelRef.value?.contains(event.target)) return
  closePanel()
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && open.value) closePanel()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointer)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointer)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
})
</script>

<template>
  <div ref="triggerRef" class="mdp-root">
    <TransitionGroup name="mdp-chip" tag="div" class="mdp-values">
      <span v-for="date in selectedDates" :key="dateKey(date.month, date.day)" class="mdp-chip">
        <button type="button" class="mdp-chip-label" @click="openPanel(date.month)">
          {{ date.month }}月{{ date.day }}日
        </button>
        <button
          type="button"
          class="mdp-chip-remove"
          :aria-label="`取消选择 ${date.month} 月 ${date.day} 日`"
          :disabled="selectedDates.length <= 1"
          @click="removeDate(date)"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6m0-6-6 6" /></svg>
        </button>
      </span>
    </TransitionGroup>

    <button
      type="button"
      class="mdp-trigger"
      :class="{ 'is-open': open }"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="togglePanel"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3 5.5h10M5 2.5v3m6-3v3M3.5 3.5h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"
        />
      </svg>
      选择日期
    </button>
  </div>

  <Teleport to="body">
    <Transition
      :css="false"
      @enter="(element, done) => enterPopover(element, done)"
      @leave="(element, done) => leavePopover(element, done)"
    >
      <section
        v-if="open"
        ref="panelRef"
        class="mdp-panel"
        :style="panelStyle"
        role="dialog"
        aria-label="选择每年生成日期"
      >
        <header class="mdp-header">
          <button type="button" aria-label="上个月" @click="moveMonth(-1)">
            <svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" /></svg>
          </button>
          <strong>{{ monthLabel }}</strong>
          <button type="button" aria-label="下个月" @click="moveMonth(1)">
            <svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>
          </button>
        </header>

        <div class="mdp-weekdays">
          <span v-for="weekday in WEEKDAYS" :key="weekday">{{ weekday }}</span>
        </div>

        <Transition :name="`mdp-month-${monthDirection}`" mode="out-in">
          <div :key="viewMonth" class="mdp-calendar">
            <button
              v-for="cell in calendarCells"
              :key="cell.key"
              type="button"
              class="mdp-day"
              :class="{ 'is-other': !cell.currentMonth, 'is-selected': cell.selected }"
              :aria-pressed="cell.selected"
              :aria-label="`${cell.month} 月 ${cell.day} 日`"
              :disabled="cell.selected && draftDates.length === 1"
              @click="toggleDate(cell)"
            >
              <span>{{ cell.day }}</span>
            </button>
          </div>
        </Transition>

        <footer class="mdp-footer">
          <span>已选 {{ draftDates.length }} 个日期</span>
          <div>
            <button type="button" class="mdp-cancel" @click="closePanel">取消</button>
            <button
              type="button"
              class="mdp-done"
              :disabled="draftDates.length === 0"
              @click="applySelection"
            >
              完成
            </button>
          </div>
        </footer>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mdp-root,
.mdp-values {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6rem;
}
.mdp-values:empty {
  display: none;
}
.mdp-chip {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--ui-border-control);
  border-radius: 8rem;
  background: var(--ui-surface-control);
}
.mdp-chip button,
.mdp-trigger {
  border: 0;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.mdp-chip-label {
  padding: 6rem 3rem 6rem 9rem;
  background: transparent;
}
.mdp-chip-remove {
  display: grid;
  width: 24rem;
  padding: 0;
  place-items: center;
  background: transparent;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease;
}
.mdp-chip-remove:hover:not(:disabled) {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.mdp-chip-remove:disabled,
.mdp-day:disabled {
  cursor: default;
}
.mdp-chip-remove:disabled {
  opacity: 0.3;
}
.mdp-chip-remove svg {
  width: 9rem;
  height: 9rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.5;
}
.mdp-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5rem;
  min-height: 31rem;
  padding: 0 10rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 8rem;
  background: var(--ui-surface-control);
  transition:
    border-color var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.mdp-trigger:hover,
.mdp-trigger.is-open {
  border-color: var(--ui-border-hover);
  color: var(--text-color);
}
.mdp-trigger:active,
.mdp-chip button:active {
  transform: scale(0.98);
}
.mdp-trigger svg {
  width: 14rem;
  height: 14rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.35;
}
.mdp-chip-enter-active,
.mdp-chip-leave-active {
  transition:
    opacity var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}
.mdp-chip-enter-from,
.mdp-chip-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
.mdp-chip-leave-active {
  position: absolute;
}
.mdp-panel {
  position: fixed;
  z-index: var(--z-global-popover);
  width: min(310rem, calc(100vw - 24px));
  padding: 10rem;
  border: 1px solid var(--surface-float-border);
  border-radius: 13rem;
  background: var(--surface-float);
  box-shadow: 0 18rem 48rem rgba(0, 0, 0, 0.28);
  color: var(--text-color);
  transform-origin: top center;
  will-change: opacity, transform;
}
.mdp-header {
  display: grid;
  min-height: 34rem;
  grid-template-columns: 30rem 1fr 30rem;
  align-items: center;
}
.mdp-header strong {
  text-align: center;
  font-size: var(--fs-body);
  font-weight: 600;
}
.mdp-header button {
  display: grid;
  width: 28rem;
  height: 28rem;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.mdp-header button:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.mdp-header button:active {
  transform: scale(0.98);
}
.mdp-header svg {
  width: 16rem;
  height: 16rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
}
.mdp-weekdays,
.mdp-calendar {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
.mdp-weekdays {
  padding: 5rem 0 3rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-align: center;
}
.mdp-calendar {
  overflow: hidden;
}
.mdp-day {
  display: grid;
  height: 34rem;
  padding: 0;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.mdp-day span {
  display: grid;
  width: 27rem;
  height: 27rem;
  place-items: center;
  border-radius: 50%;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-standard);
}
.mdp-day:hover:not(:disabled) span {
  background: var(--ui-fill-hover);
}
.mdp-day:active span {
  transform: scale(0.98);
}
.mdp-day.is-other {
  color: color-mix(in srgb, var(--text-color) 28%, transparent);
}
.mdp-day.is-selected span {
  background: #0a84ff;
  color: white;
  font-weight: 600;
}
.mdp-day.is-selected:hover span {
  background: #0077ed;
}
.mdp-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  margin-top: 6rem;
  padding-top: 8rem;
  border-top: 1px solid var(--ui-border-divider);
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.mdp-footer > div {
  display: flex;
  gap: 6rem;
}
.mdp-footer button {
  min-width: 58rem;
  height: 30rem;
  border: 0;
  border-radius: 8rem;
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    opacity var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.mdp-cancel {
  background: transparent;
  color: var(--text-color-secondary);
}
.mdp-cancel:hover {
  background: var(--ui-fill-hover);
}
.mdp-done {
  background: #0a84ff;
  color: white;
}
.mdp-done:hover:not(:disabled) {
  background: #0077ed;
}
.mdp-footer button:active:not(:disabled) {
  transform: scale(0.98);
}
.mdp-done:disabled {
  opacity: 0.34;
  cursor: default;
}
.mdp-month-next-enter-active,
.mdp-month-next-leave-active,
.mdp-month-prev-enter-active,
.mdp-month-prev-leave-active {
  transition:
    opacity var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}
.mdp-month-next-enter-from,
.mdp-month-prev-leave-to {
  opacity: 0;
  transform: translateX(8rem);
}
.mdp-month-next-leave-to,
.mdp-month-prev-enter-from {
  opacity: 0;
  transform: translateX(-8rem);
}
</style>
