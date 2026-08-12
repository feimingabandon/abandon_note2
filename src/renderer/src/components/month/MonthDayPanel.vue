<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import NoteCard from '../list/NoteCard.vue'
import { useNotePresenceMotion } from '../../composables/useNotePresenceMotion.js'
import { dateOrdinal } from '../../../../shared/calendar/calendar-date-rules.js'
import { weatherLocationLabel } from '../../../../shared/weather-rules.js'

const props = defineProps({
  dateKey: { type: String, required: true },
  notes: { type: Array, default: () => [] },
  canCreate: { type: Boolean, default: true },
  weather: { type: Object, default: null },
  weatherLocation: { type: Object, default: null },
  weatherFetchedAt: { type: Number, default: null },
  weatherStale: { type: Boolean, default: false },
  weatherError: { type: String, default: '' },
  statusTransitions: { type: Object, default: () => new Map() }
})
const emit = defineEmits(['close', 'create', 'edit', 'resize-start', 'status-action'])
const listRef = ref(null)
const dayDirection = ref('forward')
const displayedWeather = ref(props.weather)
const displayedWeatherKey = ref(props.weather ? props.dateKey : '')
const weatherVisible = ref(Boolean(props.weather))
let weatherRemovalTimer = null
let contentMotionSequence = 0

const {
  captureVisibleCardLayout,
  animateRetainedCards,
  animateAuxiliaryIn,
  cancelCurrentPresenceExits,
  disposePresenceMotion
} = useNotePresenceMotion(() => listRef.value, {
  rootSelector: '.month-day-panel',
  auxiliarySelector: '.month-day-panel__empty'
})

const noteSignature = computed(() =>
  props.notes
    .map(
      (note) =>
        `${note.id}:${note.status}:${Number(note.is_pinned)}:${note.effective_at}:${note.updated_at}`
    )
    .join('|')
)
const title = computed(() => {
  const [year, month, day] = props.dateKey.split('-').map(Number)
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][
    new Date(year, month - 1, day).getDay()
  ]
  return `${month}月${day}日 · 周${weekday}`
})
const weatherPlace = computed(() => weatherLocationLabel(props.weatherLocation))
const weatherUpdatedLabel = computed(() => {
  if (!props.weatherFetchedAt) return ''
  return new Date(props.weatherFetchedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
})
const weatherPrecipitationLabel = computed(() => {
  const weather = displayedWeather.value
  if (
    weather?.precipitationProbability !== null &&
    weather?.precipitationProbability !== undefined
  ) {
    return `降水概率 ${weather.precipitationProbability}%`
  }
  return weather?.precipitation !== null && weather?.precipitation !== undefined
    ? `预计降水 ${weather.precipitation} mm`
    : '暂无降水数据'
})

watch(
  [() => props.dateKey, noteSignature],
  async ([nextDate], [previousDate]) => {
    const sequence = ++contentMotionSequence
    const dateChanged = Boolean(previousDate && nextDate !== previousDate)
    if (dateChanged) {
      dayDirection.value =
        dateOrdinal(nextDate) > dateOrdinal(previousDate) ? 'forward' : 'backward'
    }

    cancelCurrentPresenceExits()
    const before = captureVisibleCardLayout()
    await nextTick()
    if (sequence !== contentMotionSequence) return
    if (dateChanged && listRef.value) listRef.value.scrollTop = 0
    const direction = dayDirection.value === 'forward' ? 1 : -1
    animateRetainedCards(before, {
      exitTranslateX: dateChanged ? -10 * direction : 10,
      enterTranslateX: dateChanged ? 10 * direction : 10
    })
    if (!props.notes.length) animateAuxiliaryIn()
  },
  { flush: 'pre' }
)

watch(
  [() => props.dateKey, () => props.weather],
  ([dateKey, weather], [previousDate]) => {
    if (weatherRemovalTimer) {
      clearTimeout(weatherRemovalTimer)
      weatherRemovalTimer = null
    }
    if (previousDate && dateKey !== previousDate) {
      dayDirection.value = dateOrdinal(dateKey) > dateOrdinal(previousDate) ? 'forward' : 'backward'
    }
    if (weather) {
      displayedWeather.value = weather
      displayedWeatherKey.value = dateKey
      weatherVisible.value = true
      return
    }
    weatherVisible.value = false
    weatherRemovalTimer = setTimeout(() => {
      displayedWeather.value = null
      displayedWeatherKey.value = ''
      weatherRemovalTimer = null
    }, 280)
  },
  { flush: 'pre' }
)

onBeforeUnmount(() => {
  contentMotionSequence += 1
  if (weatherRemovalTimer) clearTimeout(weatherRemovalTimer)
  disposePresenceMotion()
})
</script>

<template>
  <aside class="month-day-panel" :class="'is-day-' + dayDirection" aria-label="所选日期便签">
    <header class="month-day-panel__header">
      <div class="month-day-panel__identity-clip">
        <Transition name="month-day-identity">
          <div :key="dateKey" class="month-day-panel__identity">
            <strong>{{ title }}</strong>
            <span>{{ notes.length }} 条便签</span>
          </div>
        </Transition>
      </div>
      <div>
        <button
          type="button"
          class="month-day-panel__create"
          :disabled="!canCreate"
          :title="canCreate ? '新建便签' : '不能为过去日期新建便签'"
          :aria-label="canCreate ? '新建便签' : '不能为过去日期新建便签'"
          @click="emit('create')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <button
          type="button"
          class="month-day-panel__collapse"
          aria-label="折叠日期侧栏"
          title="折叠"
          @click="emit('close')"
        >
          <svg viewBox="0 0 12 18" aria-hidden="true">
            <path d="m8.5 3-5 6 5 6" />
          </svg>
        </button>
      </div>
    </header>
    <div
      class="month-day-panel__weather-slot"
      :class="{ 'is-visible': weatherVisible }"
      :aria-hidden="!weatherVisible"
    >
      <div class="month-day-panel__weather-clip">
        <Transition name="month-day-weather">
          <section
            v-if="displayedWeather"
            :key="displayedWeatherKey"
            class="month-day-panel__weather"
            aria-label="当日天气"
          >
            <span class="month-day-panel__weather-icon" aria-hidden="true">{{
              displayedWeather.icon
            }}</span>
            <div class="month-day-panel__weather-main">
              <strong>{{ displayedWeather.label }}</strong>
              <span>
                {{ weatherPlace }}·{{ displayedWeather.temperatureMin }}°～{{
                  displayedWeather.temperatureMax
                }}°
              </span>
            </div>
            <div class="month-day-panel__weather-details">
              <span>{{ weatherPrecipitationLabel }}</span>
              <span>最大风速 {{ displayedWeather.windSpeedMax ?? '—' }} km/h</span>
              <span :title="weatherError">
                {{ weatherStale ? '离线缓存' : `更新 ${weatherUpdatedLabel}` }}
              </span>
            </div>
          </section>
        </Transition>
      </div>
    </div>
    <div ref="listRef" class="month-day-panel__list scroll-y">
      <NoteCard
        v-for="note in notes"
        :key="note.id"
        :note="note"
        :status-transition="statusTransitions.get(note.id) || null"
        @edit="emit('edit', $event)"
        @status-action="emit('status-action', $event)"
      />
      <Transition name="month-day-empty">
        <div v-if="!notes.length" class="month-day-panel__empty">
          <span>这一天还没有便签</span>
          <button v-if="canCreate" type="button" @click="emit('create')">创建第一条</button>
        </div>
      </Transition>
    </div>
    <div
      class="month-day-panel__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整日期侧栏宽度"
      @pointerdown="emit('resize-start', $event)"
    >
      <span />
    </div>
  </aside>
</template>

<style scoped>
.month-day-panel {
  position: relative;
  display: flex;
  min-width: 0;
  height: 100%;
  flex-direction: column;
  border-right: 1px solid var(--ui-border-divider);
  border-radius: 0 var(--window-radius) var(--window-radius) 0;
  background: rgb(var(--bg-color) / 0.035);
}
.month-day-panel__header {
  display: flex;
  min-height: 50rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  padding: 0 13rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.month-day-panel__header > div {
  display: flex;
  align-items: center;
  gap: 7rem;
}
.month-day-panel__identity-clip,
.month-day-panel__identity {
  min-width: 0;
}
.month-day-panel__identity-clip {
  display: grid !important;
  overflow: hidden;
}
.month-day-panel__identity {
  grid-area: 1 / 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1rem;
}
.month-day-identity-enter-active,
.month-day-identity-leave-active {
  transition:
    opacity 160ms ease,
    transform 220ms var(--ease-standard);
}
.is-day-forward .month-day-identity-enter-from,
.is-day-backward .month-day-identity-leave-to {
  opacity: 0;
  transform: translateX(7rem);
}
.is-day-forward .month-day-identity-leave-to,
.is-day-backward .month-day-identity-enter-from {
  opacity: 0;
  transform: translateX(-7rem);
}
.month-day-panel__header strong {
  color: var(--text-color);
  font-size: var(--fs-body);
  white-space: nowrap;
}
.month-day-panel__header span {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
}
.month-day-panel__header button {
  height: 27rem;
  padding: 0 8rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  font: inherit;
}
.month-day-panel__header button:hover:not(:disabled) {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.month-day-panel__header button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.month-day-panel__create {
  display: grid;
  width: 27rem;
  padding: 0 !important;
  place-items: center;
  background: transparent !important;
  color: var(--text-color-secondary) !important;
}
.month-day-panel__create:hover:not(:disabled) {
  background: var(--ui-fill-hover) !important;
  color: var(--text-color) !important;
}
.month-day-panel__create svg {
  width: 15rem;
  height: 15rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.7;
}
.month-day-panel__collapse {
  display: grid;
  width: 27rem;
  padding: 0 !important;
  place-items: center;
}
.month-day-panel__collapse svg {
  display: block;
  width: 12rem;
  height: 18rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}
.month-day-panel__list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 8rem;
  padding: 11rem 13rem 18rem;
}
.month-day-panel__list :deep(.nl-card) {
  margin-bottom: 0;
}
.month-day-panel__weather-slot {
  display: grid;
  flex: 0 0 auto;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows 260ms var(--ease-standard),
    opacity 150ms ease;
}
.month-day-panel__weather-slot.is-visible {
  grid-template-rows: 1fr;
  opacity: 1;
}
.month-day-panel__weather-clip {
  position: relative;
  min-height: 0;
  overflow: hidden;
}
.month-day-panel__weather {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8rem;
  padding: 9rem 13rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.month-day-weather-enter-active,
.month-day-weather-leave-active {
  transition:
    opacity 170ms ease,
    transform 220ms var(--ease-standard);
}
.month-day-weather-leave-active {
  position: absolute;
  inset: 0;
  width: 100%;
}
.is-day-forward .month-day-weather-enter-from,
.is-day-backward .month-day-weather-leave-to {
  opacity: 0;
  transform: translateX(7rem);
}
.is-day-forward .month-day-weather-leave-to,
.is-day-backward .month-day-weather-enter-from {
  opacity: 0;
  transform: translateX(-7rem);
}
.month-day-panel__weather-icon {
  font-size: 24rem;
  line-height: 1;
}
.month-day-panel__weather-main,
.month-day-panel__weather-details {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2rem;
}
.month-day-panel__weather-main strong {
  color: var(--text-color);
  font-size: var(--fs-body);
}
.month-day-panel__weather-main span,
.month-day-panel__weather-details span {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
  white-space: nowrap;
}
.month-day-panel__weather-details {
  align-items: flex-end;
}
.month-day-panel__empty {
  display: grid;
  flex: 1;
  place-content: center;
  justify-items: center;
  gap: 10rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.month-day-panel__empty button {
  padding: 6rem 12rem;
  border: 0;
  border-radius: 7rem;
  background: color-mix(in srgb, #0a84ff 14%, transparent);
  color: #0a84ff;
  cursor: pointer;
  font: inherit;
}
.month-day-panel__resize {
  position: absolute;
  z-index: var(--z-local-top);
  top: 0;
  right: -5rem;
  bottom: 0;
  width: 10rem;
  cursor: ew-resize;
  touch-action: none;
}
.month-day-panel__resize span {
  position: absolute;
  top: 50%;
  left: 4rem;
  width: 2rem;
  height: 38rem;
  border-radius: 2rem;
  background: rgb(var(--bg-color) / 0.15);
  opacity: 0;
  transform: translateY(-50%);
  transition: opacity 140ms ease;
}
.month-day-panel__resize:hover span {
  opacity: 1;
}
.month-day-empty-enter-active,
.month-day-empty-leave-active {
  transition:
    opacity 180ms ease,
    transform 200ms var(--ease-standard);
}
.month-day-empty-enter-from,
.month-day-empty-leave-to {
  opacity: 0;
  transform: translateY(5rem);
}
</style>
