<script setup>
import { computed } from 'vue'
import DateContextBadge from './DateContextBadge.vue'
import OverflowFade from '../ui/OverflowFade.vue'
import { useTodayKey } from '../../composables/useTodayKey.js'
import { useSharedMinuteClock } from '../../composables/useSharedMinuteClock.js'
import {
  buildDisplayableWeatherByDate,
  buildDisplayableCurrentWeather
} from '../../utils/noteWeather.js'
import { almanacSummary } from '../../../../shared/calendar/almanac-display.js'

const props = defineProps({
  kind: { type: String, required: true },
  forecast: { type: Object, default: null }
})
const today = useTodayKey()
const minute = useSharedMinuteClock()
const weather = computed(
  () =>
    buildDisplayableWeatherByDate(props.forecast, Math.max(minute.value, Date.now())).get(
      today.value
    ) || null
)
const currentWeather = computed(() => {
  const current = buildDisplayableCurrentWeather(props.forecast, Math.max(minute.value, Date.now()))
  return current?.date === today.value ? current : null
})
const weatherHeadline = computed(() => {
  const current = currentWeather.value
  if (current)
    return `当前 ${current.icon} ${current.label} ${current.temperature}°${current.apparentTemperature != null ? ` · 体感 ${current.apparentTemperature}°` : ''}`
  const day = weather.value
  return day
    ? `全天预报 ${day.icon} ${day.label} ${day.temperatureMin}°～${day.temperatureMax}°`
    : '天气暂无数据'
})
const weatherDetail = computed(() => {
  const day = weather.value
  if (!day) return currentWeather.value?.updateLabel || '查看今日天气与宜忌'
  return (
    [
      currentWeather.value
        ? `全天 ${day.label} ${day.temperatureMin}°～${day.temperatureMax}°`
        : '',
      day.precipitation != null ? `降水 ${day.precipitation} mm` : '',
      day.precipitationProbability != null ? `降水概率 ${day.precipitationProbability}%` : '',
      day.windSpeedMax != null ? `最大风速 ${day.windSpeedMax} km/h` : ''
    ]
      .filter(Boolean)
      .join(' · ') || day.updateLabel
  )
})
const weatherTitle = computed(
  () =>
    `${today.value}\n${weatherHeadline.value}\n${weatherDetail.value}\n${currentWeather.value?.validTimeLabel || ''}\n${currentWeather.value?.updateLabel || weather.value?.updateLabel || ''}\n点击查看天气与宜忌详情`
)
function terms(group, fallback) {
  return almanacSummary(group, fallback, Infinity)
}
</script>

<template>
  <div
    class="date-context-summary"
    :class="kind === 'almanac' ? 'almanac-brief' : 'weather-brief'"
    :data-date="today"
  >
    <DateContextBadge
      class="date-context-summary__button"
      :class="kind === 'almanac' ? 'almanac-brief__button' : 'weather-brief__button'"
      :date-key="today"
      :weather="weather"
      :current-weather="currentWeather"
      :display-mode="kind"
      :summary-title="kind === 'weather' ? weatherTitle : ''"
    >
      <template #default="{ almanac, loading, error }">
        <span v-if="kind === 'weather'" class="date-context-summary__rows weather-brief__rows">
          <OverflowFade>{{ weatherHeadline }}</OverflowFade>
          <OverflowFade>{{ weatherDetail }}</OverflowFade>
        </span>
        <span
          v-else-if="almanac?.status === 'ok'"
          class="date-context-summary__rows almanac-brief__rows"
        >
          <span class="almanac-brief__line"
            ><b>宜</b><OverflowFade>{{ terms(almanac.yi, '无特别宜项') }}</OverflowFade></span
          >
          <span class="almanac-brief__line is-ji"
            ><b>忌</b><OverflowFade>{{ terms(almanac.ji, '无特别忌项') }}</OverflowFade></span
          >
        </span>
        <span v-else class="date-context-summary__rows">
          <span>今日宜忌</span>
          <OverflowFade>{{ loading ? '正在读取' : error || '该日期暂无宜忌' }}</OverflowFade>
        </span>
      </template>
    </DateContextBadge>
  </div>
</template>

<style scoped>
.date-context-summary {
  min-width: 0;
}
.date-context-summary__button {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 2rem 4rem;
  border-radius: 5rem;
  font-size: calc(var(--fs-secondary) * 0.8);
  line-height: 1.2;
  text-align: left;
}
.date-context-summary__button:focus-visible {
  outline-offset: -2px;
}
.date-context-summary__rows {
  display: grid;
  min-width: 0;
  gap: 1rem;
  animation: date-summary-reveal var(--motion-control) var(--ease-standard);
}
.almanac-brief__line {
  display: flex;
  min-width: 0;
  gap: 5rem;
}
.almanac-brief__line b {
  flex: 0 0 auto;
  color: var(--ui-accent);
  font-weight: 600;
}
.almanac-brief__line.is-ji b {
  color: var(--ui-warning);
}
@keyframes date-summary-reveal {
  from {
    opacity: 0;
    transform: translateY(3rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
