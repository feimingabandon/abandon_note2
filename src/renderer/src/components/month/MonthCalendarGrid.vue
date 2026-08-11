<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MonthEventBar from './MonthEventBar.vue'
import {
  buildCalendarEventSegments,
  hasHiddenCalendarNotes,
  noteCountsByDate
} from '../../../../shared/calendar/calendar-event-layout.js'

const props = defineProps({
  days: { type: Array, default: () => [] },
  notes: { type: Array, default: () => [] },
  selectedKey: { type: String, default: '' },
  todayKey: { type: String, required: true }
})
const emit = defineEmits(['select-date', 'create'])
const weekRefs = ref([])
const capacityByWeek = ref([0, 0, 0, 0, 0, 0])
const currentDays = computed(() => props.days.filter((day) => day.inCurrentMonth))
const segments = computed(() =>
  buildCalendarEventSegments(props.days, props.notes, {
    activeStartKey: currentDays.value[0]?.key,
    activeEndKey: currentDays.value.at(-1)?.key
  })
)
const noteById = computed(() => new Map(props.notes.map((note) => [Number(note.id), note])))
const noteCounts = computed(() => noteCountsByDate(currentDays.value, props.notes))
const visibleNoteCounts = computed(() => {
  const counts = new Map()
  for (const segment of segments.value) {
    if (!segmentIsVisible(segment)) continue
    for (let offset = 0; offset < segment.columnSpan; offset += 1) {
      const day = props.days[segment.weekIndex * 7 + segment.columnStart - 1 + offset]
      if (day?.inCurrentMonth) counts.set(day.key, (counts.get(day.key) || 0) + 1)
    }
  }
  return counts
})
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
let observer = null
let resizeFrame = null

function setWeekRef(element, index) {
  if (element) weekRefs.value[index] = element
}

function segmentIsVisible(segment) {
  return segment.lane < (capacityByWeek.value[segment.weekIndex] || 0)
}

function dayHasHiddenNotes(day) {
  return hasHiddenCalendarNotes(
    noteCounts.value.get(day.key) || 0,
    visibleNoteCounts.value.get(day.key) || 0
  )
}

function calculateCapacity() {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  const headerHeight = 35 * rem
  const footerHeight = 18 * rem
  const pitch = 22 * rem
  const next = weekRefs.value.map((element) => {
    const height = element?.getBoundingClientRect().height || 0
    return Math.max(0, Math.floor((height - headerHeight - footerHeight) / pitch))
  })
  capacityByWeek.value = Array.from({ length: 6 }, (_, index) => next[index] || 0)
}

function queueCapacityCalculation() {
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null
    calculateCapacity()
  })
}

function selectDay(day) {
  if (day.inCurrentMonth) emit('select-date', day)
}

function createForDay(day) {
  if (day.inCurrentMonth) emit('create', day)
}

watch([segments, () => props.days], async () => {
  await nextTick()
  queueCapacityCalculation()
})

onMounted(() => {
  observer = new ResizeObserver(queueCapacityCalculation)
  weekRefs.value.forEach((element) => element && observer.observe(element))
  queueCapacityCalculation()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
})
</script>

<template>
  <section class="month-grid" role="grid" aria-label="月历" aria-rowcount="7" aria-colcount="7">
    <div class="month-grid__weekdays" role="row">
      <span v-for="weekday in weekdays" :key="weekday" role="columnheader">周{{ weekday }}</span>
    </div>

    <div class="month-grid__weeks">
      <div
        v-for="weekIndex in 6"
        :key="weekIndex"
        :ref="(element) => setWeekRef(element, weekIndex - 1)"
        class="month-week"
        role="row"
      >
        <div class="month-week__cells">
          <div
            v-for="day in days.slice((weekIndex - 1) * 7, weekIndex * 7)"
            :key="day.key"
            class="month-day-cell"
            :class="{
              'is-outside': !day.inCurrentMonth,
              'is-selected': day.inCurrentMonth && day.key === selectedKey,
              'is-today': day.inCurrentMonth && day.key === todayKey
            }"
            :data-date="day.key"
            role="gridcell"
            :aria-disabled="!day.inCurrentMonth"
            :tabindex="day.inCurrentMonth ? 0 : -1"
            @click="selectDay(day)"
            @keydown.enter.prevent="selectDay(day)"
            @keydown.space.prevent="selectDay(day)"
          >
            <div class="month-day-cell__header">
              <span class="month-day-cell__number">{{ day.day }}</span>
              <span
                v-if="day.inCurrentMonth && day.key === todayKey"
                class="month-day-cell__today"
                aria-label="今天"
              >
                今
              </span>
            </div>
            <button
              v-if="day.inCurrentMonth"
              type="button"
              class="month-day-cell__create"
              :disabled="day.key < todayKey"
              :title="day.key < todayKey ? '不能为过去日期新建便签' : '在这一天新建便签'"
              :aria-label="`在 ${day.key} 新建便签`"
              @click.stop="createForDay(day)"
            >
              +
            </button>
            <span
              v-if="day.inCurrentMonth && noteCounts.get(day.key)"
              class="month-day-cell__count"
              :title="
                dayHasHiddenNotes(day)
                  ? `共 ${noteCounts.get(day.key)} 条便签，部分未显示；点击日期查看全部`
                  : `共 ${noteCounts.get(day.key)} 条便签`
              "
              :aria-label="
                dayHasHiddenNotes(day)
                  ? `${day.key} 共 ${noteCounts.get(day.key)} 条便签，部分未在日期格中显示`
                  : `${day.key} 共 ${noteCounts.get(day.key)} 条便签`
              "
            >
              {{ noteCounts.get(day.key) }}
            </span>
            <span
              v-if="day.inCurrentMonth && dayHasHiddenNotes(day)"
              class="month-day-cell__overflow"
              aria-label="还有便签未显示，点击日期查看全部"
            >
              <i v-for="index in 3" :key="index" aria-hidden="true" />
            </span>
          </div>
        </div>

        <div class="month-week__events" aria-label="本周便签">
          <MonthEventBar
            v-for="segment in segments.filter(
              (item) => item.weekIndex === weekIndex - 1 && segmentIsVisible(item)
            )"
            :key="`${segment.noteId}-${segment.weekIndex}`"
            :segment="segment"
            :note="noteById.get(Number(segment.noteId))"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.month-grid {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  --calendar-gap: 7rem;
}
.month-grid__weekdays {
  display: grid;
  flex: 0 0 27rem;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: var(--calendar-gap);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  text-align: center;
}
.month-grid__weeks {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-rows: repeat(6, minmax(0, 1fr));
  row-gap: var(--calendar-gap);
}
.month-week {
  position: relative;
  min-height: 0;
}
.month-week__cells,
.month-week__events {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  column-gap: var(--calendar-gap);
}
.month-week__events {
  top: 32rem;
  bottom: 18rem;
  z-index: var(--z-local-raised);
  align-content: start;
  overflow: hidden;
  pointer-events: none;
}
.month-day-cell {
  position: relative;
  min-width: 0;
  overflow: hidden;
  padding: 5rem 7rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 9rem;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}
.month-day-cell:not(.is-outside):not(.is-selected):hover {
  border-color: var(--ui-border-control);
}
.month-day-cell.is-outside {
  border-color: var(--ui-border-divider);
  cursor: default;
  color: color-mix(in srgb, var(--text-color-secondary) 58%, transparent);
}
.month-day-cell__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}
.month-day-cell.is-selected {
  border-color: color-mix(in srgb, #0a84ff 58%, transparent);
  box-shadow: inset 0 0 0 1rem color-mix(in srgb, #0a84ff 24%, transparent);
}
.month-day-cell__number {
  display: inline-flex;
  width: 23rem;
  height: 23rem;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: var(--fs-secondary);
  font-variant-numeric: tabular-nums;
}
.month-day-cell__today {
  display: inline-grid;
  width: 20rem;
  height: 20rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 50%;
  background: #0a84ff;
  color: #fff;
  font-size: calc(var(--fs-secondary) * 0.76);
  font-weight: 650;
  line-height: 1;
  pointer-events: none;
}
.month-day-cell__count {
  position: absolute;
  right: 6rem;
  bottom: 4rem;
  display: inline-grid;
  min-width: 22rem;
  height: 16rem;
  place-items: center;
  padding: 0 5rem;
  border-radius: 5rem;
  background: var(--ui-fill-passive);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.72);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  pointer-events: none;
  white-space: nowrap;
}
.month-day-cell__overflow {
  position: absolute;
  bottom: 4rem;
  left: 50%;
  display: flex;
  height: 16rem;
  align-items: center;
  gap: 3rem;
  color: var(--text-color-secondary);
  opacity: 0.82;
  pointer-events: none;
  transform: translateX(-50%);
  transition:
    color 210ms ease,
    opacity 210ms ease,
    transform 260ms var(--ease-standard);
  white-space: nowrap;
}
.month-day-cell__overflow i {
  width: 3.5rem;
  height: 3.5rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 0 currentColor;
  transition: box-shadow 240ms ease;
}
.month-day-cell:hover .month-day-cell__overflow {
  color: var(--text-color);
  opacity: 1;
  transform: translateX(-50%) scale(1.12);
}
.month-day-cell:hover .month-day-cell__overflow i {
  box-shadow: 0 0 0 0.6rem currentColor;
}
.month-day-cell__create {
  position: absolute;
  z-index: var(--z-local-top);
  bottom: 3rem;
  left: 6rem;
  width: 22rem;
  height: 22rem;
  padding: 0;
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 18rem;
  opacity: 0;
  transform: translateY(4rem) scale(0.9);
  transition:
    opacity 210ms ease,
    background-color 150ms ease,
    color 150ms ease,
    transform 260ms var(--ease-standard);
}
.month-day-cell:hover .month-day-cell__create,
.month-day-cell__create:focus-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.month-day-cell__create:hover:not(:disabled) {
  background: var(--ui-fill-hover);
  color: #0a84ff;
}
.month-day-cell__create:disabled {
  cursor: not-allowed;
  opacity: 0;
}
</style>
