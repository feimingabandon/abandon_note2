<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TimeSpinner from './TimeSpinner.vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const props = defineProps({
  modelValue: { type: String, default: '09:00' },
  disabled: { type: Boolean, default: false },
  width: { type: [String, Number], default: '112rem' },
  ariaLabel: { type: String, default: '选择时间' },
  panelTitle: { type: String, default: '生成时间' }
})

const emit = defineEmits(['update:modelValue', 'change'])
const open = ref(false)
const wrapperRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({})
const hour = ref(9)
const minute = ref(0)

const wrapperStyle = computed(() => ({
  width: typeof props.width === 'number' ? `${props.width}px` : props.width
}))
const displayTime = computed(() => formatTime(hour.value, minute.value))

function formatTime(hourValue, minuteValue) {
  return `${String(hourValue).padStart(2, '0')}:${String(minuteValue).padStart(2, '0')}`
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const parsedHour = Number(match[1])
  const parsedMinute = Number(match[2])
  if (parsedHour > 23 || parsedMinute > 59) return null
  return { hour: parsedHour, minute: parsedMinute }
}

function syncDraft() {
  const parsed = parseTime(props.modelValue) || { hour: 9, minute: 0 }
  hour.value = parsed.hour
  minute.value = parsed.minute
}

function updatePanelPosition() {
  const triggerRect = wrapperRef.value?.getBoundingClientRect()
  if (!triggerRect) return

  const remSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  const panelRect = panelRef.value?.getBoundingClientRect()
  const panelWidth = panelRect?.width || 224 * remSize
  const panelHeight = panelRect?.height || 230 * remSize
  const left = Math.max(
    10,
    Math.min(window.innerWidth - panelWidth - 10, triggerRect.right - panelWidth)
  )
  const below = triggerRect.bottom + 6
  const top =
    below + panelHeight <= window.innerHeight - 10
      ? below
      : Math.max(10, triggerRect.top - panelHeight - 6)
  panelStyle.value = { left: `${left}px`, top: `${top}px` }
}

async function openPanel() {
  if (props.disabled || open.value) return
  syncDraft()
  updatePanelPosition()
  open.value = true
  await nextTick()
  updatePanelPosition()
  window.addEventListener('resize', updatePanelPosition)
  window.addEventListener('scroll', updatePanelPosition, true)
}

function closePanel() {
  open.value = false
  window.removeEventListener('resize', updatePanelPosition)
  window.removeEventListener('scroll', updatePanelPosition, true)
}

function togglePanel() {
  if (open.value) closePanel()
  else openPanel()
}

function commit() {
  const value = displayTime.value
  if (value !== props.modelValue) emit('update:modelValue', value)
  emit('change', value)
  closePanel()
}

function chooseNow() {
  const now = new Date()
  hour.value = now.getHours()
  minute.value = now.getMinutes()
  nextTick(commit)
}

function onDocumentPointer(event) {
  if (!open.value) return
  if (wrapperRef.value?.contains(event.target) || panelRef.value?.contains(event.target)) return
  closePanel()
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && open.value) closePanel()
}

watch(
  () => props.modelValue,
  () => {
    if (!open.value) syncDraft()
  },
  { immediate: true }
)

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointer)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointer)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('resize', updatePanelPosition)
  window.removeEventListener('scroll', updatePanelPosition, true)
})
</script>

<template>
  <div ref="wrapperRef" class="time-picker" :style="wrapperStyle">
    <button
      type="button"
      class="time-picker__trigger"
      :class="{ 'is-open': open }"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="togglePanel"
    >
      <span>{{ modelValue }}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 4.7V8l2.3 1.4" />
      </svg>
    </button>

    <Teleport to="body">
      <Transition
        :css="false"
        @enter="(element, done) => enterPopover(element, done, 'reveal')"
        @leave="(element, done) => leavePopover(element, done, 'reveal')"
      >
        <section
          v-if="open"
          ref="panelRef"
          class="time-picker__panel"
          :style="panelStyle"
          role="dialog"
          :aria-label="ariaLabel"
        >
          <header>
            <span>{{ panelTitle }}</span>
            <strong>{{ displayTime }}</strong>
          </header>

          <div class="time-picker__spinners">
            <div>
              <span>时</span>
              <TimeSpinner v-model="hour" :max="24" :visible="open" />
            </div>
            <i aria-hidden="true">:</i>
            <div>
              <span>分</span>
              <TimeSpinner v-model="minute" :max="60" :visible="open" />
            </div>
          </div>

          <footer>
            <button type="button" class="time-picker__now" @click="chooseNow">现在</button>
            <div>
              <button type="button" class="time-picker__cancel" @click="closePanel">取消</button>
              <button type="button" class="time-picker__done" @click="commit">完成</button>
            </div>
          </footer>
        </section>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.time-picker {
  position: relative;
  display: inline-block;
}
.time-picker__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  width: 100%;
  min-height: 32rem;
  padding: 0 9rem 0 11rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 7rem;
  background: var(--ui-surface-control);
  color: var(--text-color);
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  outline: none;
  transition:
    border-color var(--motion-fast) ease,
    background-color var(--motion-control) var(--ease-standard),
    box-shadow var(--motion-control) var(--ease-standard),
    transform var(--motion-fast) var(--ease-standard);
}
.time-picker__trigger:hover:not(:disabled) {
  border-color: var(--ui-border-hover);
}
.time-picker__trigger.is-open {
  border-color: color-mix(in srgb, #0a84ff 72%, transparent);
  box-shadow: 0 0 0 3rem color-mix(in srgb, #0a84ff 12%, transparent);
}
.time-picker__trigger:disabled {
  opacity: 0.4;
  cursor: default;
}
.time-picker__trigger svg {
  width: 15rem;
  height: 15rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.3;
  opacity: 0.55;
}
.time-picker__panel {
  position: fixed;
  z-index: var(--z-global-popover);
  display: flex;
  box-sizing: border-box;
  width: 224rem;
  height: 230rem;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--surface-float-border);
  border-radius: 13rem;
  background: var(--surface-float);
  box-shadow: 0 18rem 48rem rgba(0, 0, 0, 0.28);
  color: var(--text-color);
  transform-origin: top center;
  will-change: clip-path, opacity, transform;
}
.time-picker__panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 42rem;
  padding: 0 13rem;
  border-bottom: 1px solid var(--ui-border-divider);
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.time-picker__panel header strong {
  color: #0a84ff;
  font-size: var(--fs-body);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.time-picker__spinners {
  display: grid;
  flex: 1;
  min-height: 0;
  grid-template-columns: 1fr 14rem 1fr;
  align-items: stretch;
  padding: 5rem 18rem 2rem;
}
.time-picker__spinners > div {
  display: flex;
  min-height: 0;
  flex-direction: column;
}
.time-picker__spinners > div > span {
  flex-shrink: 0;
  padding: 2rem 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  text-align: center;
}
.time-picker__spinners > i {
  align-self: center;
  color: var(--text-color-secondary);
  font-size: var(--fs-title);
  font-style: normal;
  transform: translateY(8rem);
}
.time-picker__panel footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44rem;
  padding: 0 10rem;
  border-top: 1px solid var(--ui-border-divider);
}
.time-picker__panel footer > div {
  display: flex;
  gap: 5rem;
}
.time-picker__panel footer button {
  min-width: 52rem;
  height: 29rem;
  padding: 0 9rem;
  border: 0;
  border-radius: 7rem;
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-standard);
}
.time-picker__panel footer button:active {
  transform: scale(0.98);
}
.time-picker__now {
  background: color-mix(in srgb, #0a84ff 10%, transparent);
  color: #0a84ff;
}
.time-picker__now:hover {
  background: color-mix(in srgb, #0a84ff 17%, transparent);
}
.time-picker__cancel {
  background: transparent;
  color: var(--text-color-secondary);
}
.time-picker__cancel:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.time-picker__done {
  background: #0a84ff;
  color: #fff;
}
.time-picker__done:hover {
  background: #0077ed;
}
</style>
