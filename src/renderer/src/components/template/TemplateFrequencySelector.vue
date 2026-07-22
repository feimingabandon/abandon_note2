<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import NumberStepper from '../ui/NumberStepper.vue'
import MonthDayPicker from '../ui/MonthDayPicker.vue'
import { FREQUENCY_OPTIONS } from '../../utils/templateRules.js'

const props = defineProps({
  frequency: { type: String, default: 'daily' },
  interval: { type: Number, default: 1 },
  weekdays: { type: Array, default: () => [1] },
  monthDays: { type: Array, default: () => [1] },
  yearDates: { type: Array, default: () => [{ month: 1, day: 1 }] }
})

const emit = defineEmits([
  'update:frequency',
  'update:interval',
  'update:weekdays',
  'update:monthDays',
  'update:yearDates'
])

const panelRef = ref(null)
const panelHeight = ref(0)
const direction = ref('forward')
let panelResizeObserver = null

const selectedIndex = computed(() =>
  Math.max(
    0,
    FREQUENCY_OPTIONS.findIndex((item) => item.value === props.frequency)
  )
)
const transitionName = computed(() => `tfs-panel-${direction.value}`)

function measurePanel() {
  panelHeight.value = panelRef.value?.offsetHeight || 0
}

async function observeCurrentPanel() {
  await nextTick()
  panelResizeObserver?.disconnect()
  measurePanel()
  if (panelRef.value) panelResizeObserver?.observe(panelRef.value)
}

function selectFrequency(value, index) {
  if (value === props.frequency) return
  direction.value = index > selectedIndex.value ? 'forward' : 'backward'
  emit('update:frequency', value)
}

function toggleNumber(values, value, eventName) {
  const next = new Set(values)
  if (next.has(value)) {
    if (next.size === 1) return
    next.delete(value)
  } else next.add(value)
  emit(eventName, [...next])
}

watch(() => props.frequency, observeCurrentPanel)

onMounted(() => {
  panelResizeObserver = new ResizeObserver(measurePanel)
  observeCurrentPanel()
})

onBeforeUnmount(() => panelResizeObserver?.disconnect())
</script>

<template>
  <section class="tfs-root" aria-labelledby="template-frequency-label">
    <span id="template-frequency-label" class="tfs-label">生成频率</span>

    <div class="tfs-segments" role="radiogroup" aria-label="生成频率">
      <span
        class="tfs-indicator"
        :style="{ transform: `translateX(${selectedIndex * 100}%)` }"
        aria-hidden="true"
      />
      <button
        v-for="(item, index) in FREQUENCY_OPTIONS"
        :key="item.value"
        type="button"
        role="radio"
        :class="{ active: frequency === item.value }"
        :aria-checked="frequency === item.value"
        @click="selectFrequency(item.value, index)"
      >
        {{ item.label }}
      </button>
    </div>

    <div class="tfs-panel-viewport" :style="{ height: `${panelHeight}px` }">
      <Transition :name="transitionName">
        <div :key="frequency" ref="panelRef" class="tfs-panel">
          <div v-if="frequency === 'daily'" class="tfs-inline-rule">
            <span>每</span>
            <NumberStepper
              :model-value="interval"
              :min="1"
              :max="3650"
              aria-label="间隔天数"
              @update:model-value="emit('update:interval', $event)"
            />
            <span>天生成一次</span>
          </div>

          <div v-else-if="frequency === 'weekly'" class="tfs-choice-grid tfs-weekdays">
            <button
              v-for="(label, index) in ['一', '二', '三', '四', '五', '六', '日']"
              :key="label"
              type="button"
              :class="{ active: weekdays.includes(index + 1) }"
              :aria-pressed="weekdays.includes(index + 1)"
              @click="toggleNumber(weekdays, index + 1, 'update:weekdays')"
            >
              周{{ label }}
            </button>
          </div>

          <div v-else-if="frequency === 'monthly'" class="tfs-field">
            <div class="tfs-choice-grid tfs-monthdays">
              <button
                v-for="day in 31"
                :key="day"
                type="button"
                :class="{ active: monthDays.includes(day) }"
                :aria-pressed="monthDays.includes(day)"
                @click="toggleNumber(monthDays, day, 'update:monthDays')"
              >
                {{ day }}
              </button>
            </div>
            <small>若当月没有所选日期，将在该月最后一天生成。</small>
          </div>

          <div v-else class="tfs-field">
            <MonthDayPicker
              :model-value="yearDates"
              @update:model-value="emit('update:yearDates', $event)"
            />
            <small>可以选择多个日期；2 月 29 日会在平年的 2 月最后一天生成。</small>
          </div>
        </div>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.tfs-root,
.tfs-field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7rem;
}
.tfs-label,
.tfs-inline-rule {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 500;
}
.tfs-segments {
  position: relative;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  padding: 2rem;
  border: 1rem solid rgb(var(--bg-color) / 0.1);
  border-radius: 10rem;
  background: rgba(255, 255, 255, 0.05);
  isolation: isolate;
}
.tfs-indicator {
  position: absolute;
  z-index: 0;
  top: 2rem;
  bottom: 2rem;
  left: 2rem;
  width: calc((100% - 4rem) / 4);
  border-radius: 7rem;
  background: #0071e3;
  box-shadow: 0 2rem 8rem rgba(0, 113, 227, 0.22);
  transition: transform 260ms cubic-bezier(0.32, 0.72, 0, 1);
  will-change: transform;
}
.tfs-segments button,
.tfs-choice-grid button {
  min-width: 0;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  cursor: pointer;
  transition:
    border-color var(--motion-fast) ease,
    background-color var(--motion-control) var(--ease-standard),
    color var(--motion-fast) ease,
    box-shadow var(--motion-control) var(--ease-standard),
    transform var(--motion-fast) var(--ease-standard);
}
.tfs-segments button {
  position: relative;
  z-index: 1;
  padding: 7rem;
}
.tfs-segments button:hover:not(.active) {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-color);
}
.tfs-segments button.active {
  color: #fff;
}
.tfs-segments button:active,
.tfs-choice-grid button:active {
  transform: scale(0.95);
}
.tfs-panel-viewport {
  position: relative;
  min-width: 0;
  overflow: hidden;
  transition: height 240ms var(--ease-standard);
}
.tfs-panel {
  width: 100%;
}
.tfs-panel-forward-enter-active,
.tfs-panel-forward-leave-active,
.tfs-panel-backward-enter-active,
.tfs-panel-backward-leave-active {
  transition:
    opacity 160ms ease,
    transform 220ms var(--ease-standard);
}
.tfs-panel-forward-leave-active,
.tfs-panel-backward-leave-active {
  position: absolute;
  inset: 0 0 auto;
}
.tfs-panel-forward-enter-from,
.tfs-panel-backward-leave-to {
  opacity: 0;
  transform: translateX(14rem);
}
.tfs-panel-forward-leave-to,
.tfs-panel-backward-enter-from {
  opacity: 0;
  transform: translateX(-14rem);
}
.tfs-inline-rule {
  display: flex;
  align-items: center;
  gap: 8rem;
  min-height: 34rem;
}
.tfs-choice-grid {
  display: grid;
  gap: 5rem;
}
.tfs-weekdays {
  grid-template-columns: repeat(7, 1fr);
  align-items: center;
  min-height: 34rem;
}
.tfs-monthdays {
  grid-template-columns: repeat(8, 1fr);
}
.tfs-choice-grid button {
  min-height: 29rem;
  border: 1rem solid rgb(var(--bg-color) / 0.1);
  background: rgba(255, 255, 255, 0.04);
  font-size: var(--fs-secondary);
}
.tfs-choice-grid button:hover:not(.active) {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-color);
}
.tfs-choice-grid button.active {
  border-color: #0071e3;
  background: #0071e3;
  color: #fff;
  font-weight: 600;
  box-shadow: 0 2rem 7rem rgba(0, 113, 227, 0.2);
}
.tfs-choice-grid button.active:hover {
  border-color: #0077ed;
  background: #0077ed;
  box-shadow: 0 3rem 9rem rgba(0, 113, 227, 0.26);
}
.tfs-root small {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  line-height: 1.45;
  opacity: 0.72;
}
@media (max-width: 420px) {
  .tfs-monthdays {
    grid-template-columns: repeat(6, 1fr);
  }
  .tfs-weekdays {
    grid-template-columns: repeat(4, 1fr);
  }
}
</style>
