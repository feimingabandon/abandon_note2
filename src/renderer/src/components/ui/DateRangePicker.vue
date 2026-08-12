<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const props = defineProps({
  start: { type: String, default: '' },
  end: { type: String, default: '' }
})

const emit = defineEmits(['update:start', 'update:end', 'change'])

const open = ref(false)
const triggerRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({})
const draftStart = ref('')
const draftEnd = ref('')
const now = new Date()
const viewYear = ref(now.getFullYear())
const viewMonth = ref(now.getMonth())
const monthDirection = ref('next')

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function pad(value) {
  return String(value).padStart(2, '0')
}

function dateKey(year, month, day) {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

function parseKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  const date = new Date(year, month, day)
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date
    : null
}

const displayValue = computed(() => {
  if (props.start && props.end) return `${props.start} — ${props.end}`
  if (props.start) return `${props.start} — 选择结束日期`
  return '选择自定义日期范围'
})
const hasAppliedRange = computed(() => Boolean(props.start && props.end))

const monthLabel = computed(() => `${viewYear.value}年 ${viewMonth.value + 1}月`)

const calendarCells = computed(() => {
  const firstDay = new Date(viewYear.value, viewMonth.value, 1).getDay()
  const mondayOffset = firstDay === 0 ? 6 : firstDay - 1
  const startDate = new Date(viewYear.value, viewMonth.value, 1 - mondayOffset)
  const todayKey = dateKey(now.getFullYear(), now.getMonth(), now.getDate())
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate() + index
    )
    const key = dateKey(date.getFullYear(), date.getMonth(), date.getDate())
    return {
      key,
      day: date.getDate(),
      currentMonth: date.getMonth() === viewMonth.value,
      today: key === todayKey,
      start: key === draftStart.value,
      end: key === draftEnd.value,
      inRange: Boolean(
        draftStart.value && draftEnd.value && key > draftStart.value && key < draftEnd.value
      )
    }
  })
})

function syncDraft() {
  draftStart.value = props.start
  draftEnd.value = props.end
  const initial = parseKey(props.start) || new Date()
  viewYear.value = initial.getFullYear()
  viewMonth.value = initial.getMonth()
}

function updatePosition() {
  const rect = triggerRef.value?.getBoundingClientRect()
  const panelRect = panelRef.value?.getBoundingClientRect()
  if (!rect || !panelRect) return
  const left = Math.max(
    12,
    Math.min(window.innerWidth - panelRect.width - 12, rect.right - panelRect.width)
  )
  const belowTop = rect.bottom + 7
  const top =
    belowTop + panelRect.height <= window.innerHeight - 12
      ? belowTop
      : Math.max(12, rect.top - panelRect.height - 7)
  panelStyle.value = { left: `${left}px`, top: `${top}px` }
}

function openPanel() {
  syncDraft()
  open.value = true
  nextTick(updatePosition)
  window.addEventListener('resize', updatePosition)
}

function closePanel() {
  open.value = false
  window.removeEventListener('resize', updatePosition)
}

function togglePanel() {
  if (open.value) closePanel()
  else openPanel()
}

function moveMonth(delta) {
  monthDirection.value = delta > 0 ? 'next' : 'prev'
  const next = new Date(viewYear.value, viewMonth.value + delta, 1)
  viewYear.value = next.getFullYear()
  viewMonth.value = next.getMonth()
}

function selectDate(cell) {
  if (!draftStart.value || draftEnd.value) {
    draftStart.value = cell.key
    draftEnd.value = ''
    return
  }
  if (cell.key < draftStart.value) {
    draftEnd.value = draftStart.value
    draftStart.value = cell.key
  } else {
    draftEnd.value = cell.key
  }
}

function clearRange() {
  draftStart.value = ''
  draftEnd.value = ''
  emit('update:start', '')
  emit('update:end', '')
  emit('change', { start: '', end: '' })
  closePanel()
}

function applyRange() {
  emit('update:start', draftStart.value)
  emit('update:end', draftEnd.value)
  emit('change', { start: draftStart.value, end: draftEnd.value })
  closePanel()
}

function onDocumentPointer(event) {
  if (!open.value) return
  if (triggerRef.value?.contains(event.target) || panelRef.value?.contains(event.target)) return
  closePanel()
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && open.value) closePanel()
}

watch(
  () => [props.start, props.end],
  () => {
    if (open.value) syncDraft()
  }
)

document.addEventListener('mousedown', onDocumentPointer)
document.addEventListener('keydown', onDocumentKeydown)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointer)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('resize', updatePosition)
})
</script>

<template>
  <div ref="triggerRef" class="drp-control">
    <button
      type="button"
      class="drp-trigger"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="togglePanel"
    >
      <span>{{ displayValue }}</span>
      <svg
        v-if="!hasAppliedRange"
        class="drp-trigger-arrow"
        :class="{ 'is-open': open }"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <path d="M6 3l5 5-5 5" />
      </svg>
    </button>
    <button
      v-if="hasAppliedRange"
      type="button"
      class="drp-clear-action"
      aria-label="清除自定义日期范围"
      title="清除日期范围"
      @click.stop="clearRange"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
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
        class="drp-panel"
        :style="panelStyle"
        role="dialog"
        aria-label="选择日期范围"
      >
        <header class="drp-header">
          <button type="button" aria-label="上个月" @click="moveMonth(-1)">
            <svg viewBox="0 0 16 16"><path d="M10 3L5 8l5 5" /></svg>
          </button>
          <strong>{{ monthLabel }}</strong>
          <button type="button" aria-label="下个月" @click="moveMonth(1)">
            <svg viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" /></svg>
          </button>
        </header>

        <div class="drp-weekdays">
          <span v-for="weekday in WEEKDAYS" :key="weekday">{{ weekday }}</span>
        </div>

        <Transition :name="`drp-month-${monthDirection}`" mode="out-in">
          <div :key="`${viewYear}-${viewMonth}`" class="drp-calendar">
            <button
              v-for="cell in calendarCells"
              :key="cell.key"
              type="button"
              class="drp-day"
              :class="{
                'is-other': !cell.currentMonth,
                'is-today': cell.today,
                'is-start': cell.start,
                'is-end': cell.end,
                'is-range': cell.inRange
              }"
              @click="selectDate(cell)"
            >
              <span>{{ cell.day }}</span>
            </button>
          </div>
        </Transition>

        <div class="drp-selection">
          <span>{{ draftStart || '开始日期' }}</span>
          <span>—</span>
          <span>{{ draftEnd || '结束日期' }}</span>
        </div>

        <footer class="drp-footer">
          <button type="button" class="drp-clear" @click="clearRange">清除</button>
          <button
            type="button"
            class="drp-done"
            :disabled="!draftStart || !draftEnd"
            @click="applyRange"
          >
            完成
          </button>
        </footer>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drp-control {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}
.drp-trigger {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 34rem;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  text-align: left;
  cursor: pointer;
}
.drp-trigger span {
  flex: 1;
}
.drp-trigger svg,
.drp-header svg {
  width: 14rem;
  height: 14rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.drp-trigger-arrow {
  transform: rotate(0deg);
  transition: transform 180ms var(--ease-standard);
}
.drp-trigger-arrow.is-open {
  transform: rotate(90deg);
}
.drp-trigger:hover {
  color: var(--text-color);
}
.drp-clear-action {
  display: grid;
  place-items: center;
  flex: 0 0 24rem;
  width: 24rem;
  height: 24rem;
  padding: 0;
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease,
    transform 120ms ease;
}
.drp-clear-action svg {
  width: 12rem;
  height: 12rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}
.drp-clear-action:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.drp-clear-action:active {
  transform: scale(0.98);
}

.drp-panel {
  position: fixed;
  z-index: var(--z-global-popover);
  width: min(310rem, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  overflow-x: hidden;
  overflow-y: auto;
  padding: 10rem;
  border: 1px solid var(--surface-float-border);
  border-radius: 13rem;
  background: var(--surface-float);
  box-shadow: 0 18rem 48rem rgba(0, 0, 0, 0.28);
  color: var(--text-color);
}
.drp-header {
  display: grid;
  grid-template-columns: 30rem 1fr 30rem;
  align-items: center;
  min-height: 34rem;
}
.drp-header strong {
  text-align: center;
  font-size: var(--fs-body);
  font-weight: 600;
}
.drp-header button {
  display: grid;
  place-items: center;
  width: 28rem;
  height: 28rem;
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
.drp-header button:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.drp-header button:active {
  transform: scale(0.98);
}
.drp-weekdays,
.drp-calendar {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
.drp-weekdays {
  padding: 5rem 0 3rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-align: center;
}
.drp-calendar {
  overflow: hidden;
}
.drp-day {
  position: relative;
  display: grid;
  place-items: center;
  height: 34rem;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.drp-day::before {
  content: '';
  position: absolute;
  inset: 4rem 0;
  background: transparent;
  transition: background-color var(--motion-fast) ease;
}
.drp-day span {
  position: relative;
  z-index: var(--z-local-content);
  display: grid;
  place-items: center;
  width: 27rem;
  height: 27rem;
  border-radius: 50%;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.drp-day:hover span {
  background: var(--ui-fill-hover);
}
.drp-day:active span {
  transform: scale(0.98);
}
.drp-day.is-other {
  color: color-mix(in srgb, var(--text-color) 28%, transparent);
}
.drp-day.is-today span {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #0a84ff 54%, transparent);
  color: #0a84ff;
}
.drp-day.is-range::before {
  background: color-mix(in srgb, #0a84ff 13%, transparent);
}
.drp-day.is-start::before {
  left: 50%;
  background: color-mix(in srgb, #0a84ff 13%, transparent);
}
.drp-day.is-end::before {
  right: 50%;
  background: color-mix(in srgb, #0a84ff 13%, transparent);
}
.drp-day.is-start span,
.drp-day.is-end span {
  background: #0a84ff;
  box-shadow: none;
  color: white;
}
.drp-selection {
  display: flex;
  justify-content: center;
  gap: 7rem;
  min-height: 30rem;
  align-items: center;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.drp-footer {
  display: flex;
  justify-content: space-between;
  padding-top: 7rem;
  border-top: 1px solid var(--ui-border-divider);
}
.drp-footer button {
  min-width: 60rem;
  height: 30rem;
  border: 0;
  border-radius: 8rem;
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.drp-clear {
  background: transparent;
  color: var(--text-color-secondary);
}
.drp-done {
  background: #0a84ff;
  color: white;
}
.drp-done:disabled {
  opacity: 0.34;
  cursor: default;
}
.drp-month-next-enter-active,
.drp-month-next-leave-active,
.drp-month-prev-enter-active,
.drp-month-prev-leave-active {
  transition:
    opacity var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}
.drp-month-next-enter-from,
.drp-month-prev-leave-to {
  opacity: 0;
  transform: translateX(8rem);
}
.drp-month-next-leave-to,
.drp-month-prev-enter-from {
  opacity: 0;
  transform: translateX(-8rem);
}
</style>
