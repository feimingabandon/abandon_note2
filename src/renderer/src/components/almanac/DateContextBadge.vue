<script setup>
import { computed, ref, watch } from 'vue'
import OverflowFade from '../ui/OverflowFade.vue'
import DateContextPopover from './DateContextPopover.vue'
import { useAlmanac } from '../../composables/useAlmanac.js'
import { almanacSummary } from '../../../../shared/calendar/almanac-display.js'

const props = defineProps({
  dateKey: { type: String, required: true },
  weather: { type: Object, default: null },
  currentWeather: { type: Object, default: null },
  displayMode: { type: String, default: 'auto' },
  summaryTitle: { type: String, default: '' },
  compact: { type: Boolean, default: false },
  weatherClass: { type: String, default: '' }
})
const trigger = ref(null)
const visible = ref(false)
const resolvedCurrentWeather = computed(() => {
  const current = props.currentWeather || props.weather?.currentWeather
  return current?.date === props.dateKey ? current : null
})
const isAlmanac = computed(
  () => props.displayMode === 'almanac' || (props.displayMode === 'auto' && !props.weather)
)
const { result, loading, error, reload } = useAlmanac(() =>
  isAlmanac.value || visible.value ? props.dateKey : ''
)
const almanacTerms = computed(() => {
  const almanac = result.value?.almanac
  if (almanac?.status !== 'ok') return null
  return {
    yi: almanacSummary(almanac.yi, '无特别宜项', Infinity),
    ji: almanacSummary(almanac.ji, '无特别忌项', Infinity)
  }
})
const summary = computed(() => {
  if (almanacTerms.value) return `宜 ${almanacTerms.value.yi}  忌 ${almanacTerms.value.ji}`
  if (loading.value) return '正在读取宜忌'
  return (
    error.value ||
    (result.value?.almanac?.status === 'unsupported' ? '该日期暂无宜忌' : '宜忌暂不可用')
  )
})
const title = computed(() => {
  if (props.summaryTitle) return props.summaryTitle
  const weather = props.weather
  const description =
    !isAlmanac.value && weather
      ? `全天预报 ${weather.label} ${weather.temperatureMin}°～${weather.temperatureMax}° · ${weather.updateLabel || ''}`
      : summary.value
  return `${props.dateKey}\n${description}\n点击查看天气与宜忌详情`
})
const tooltip = computed(() =>
  isAlmanac.value ? `${props.dateKey}\n点击查看天气与宜忌详情` : title.value
)
function toggle() {
  if (!visible.value) window.dispatchEvent(new Event('abandon:date-context-open'))
  visible.value = !visible.value
}
function close(restoreFocus = false) {
  visible.value = false
  if (restoreFocus && trigger.value?.isConnected) trigger.value.focus({ preventScroll: true })
}
watch(
  () => props.dateKey,
  () => close()
)
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="date-context-badge"
    :class="isAlmanac ? 'is-almanac' : weatherClass"
    :data-date="dateKey"
    :title="tooltip"
    :aria-label="title"
    aria-haspopup="dialog"
    :aria-expanded="visible"
    @click.stop="toggle"
    @dblclick.stop
    @pointerdown.stop
    @keydown.stop
  >
    <slot :almanac="result?.almanac" :loading="loading" :error="error">
      <OverflowFade v-if="weather">
        <span aria-hidden="true">{{ weather.icon }}</span>
        <span v-if="!compact"> {{ weather.label }} </span>
        {{ weather.temperatureMin }}°～{{ weather.temperatureMax }}°
      </OverflowFade>
      <OverflowFade v-else class="date-context-badge__almanac">
        <template v-if="almanacTerms">
          <span class="date-context-badge__label">宜</span>{{ ' '
          }}<span class="date-context-badge__terms">{{ almanacTerms.yi }}</span
          >{{ '  ' }}<span class="date-context-badge__label is-ji">忌</span>{{ ' '
          }}<span class="date-context-badge__terms">{{ almanacTerms.ji }}</span>
        </template>
        <template v-else>{{ summary }}</template>
      </OverflowFade>
    </slot>
    <Teleport to="body">
      <Transition name="date-context">
        <DateContextPopover
          v-if="visible"
          :date-key="dateKey"
          :anchor="trigger"
          :weather="weather"
          :current-weather="resolvedCurrentWeather"
          :result="result"
          :loading="loading"
          :error="error"
          @close="close"
          @retry="reload"
        />
      </Transition>
    </Teleport>
  </button>
</template>

<style scoped>
.date-context-badge {
  display: block;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-control) var(--ease-standard);
}
.date-context-badge:hover {
  color: var(--text-color);
}
.date-context-badge:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: 1px;
}
.date-context-badge__almanac {
  width: 100%;
  white-space: nowrap;
}
.date-context-badge__label {
  color: var(--ui-accent);
  font-weight: 600;
}
.date-context-badge__label.is-ji {
  color: var(--ui-warning);
}
.date-context-badge__terms {
  color: var(--text-color-secondary);
  transition: color var(--motion-fast) ease;
}
.date-context-badge:hover .date-context-badge__terms,
.date-context-badge:focus-visible .date-context-badge__terms {
  color: var(--text-color);
}
.date-context-enter-active,
.date-context-leave-active {
  transition:
    opacity var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}
.date-context-enter-from,
.date-context-leave-to {
  opacity: 0;
  transform: translateY(var(--date-context-offset, -4px));
}
.date-context-leave-active {
  pointer-events: none;
}
</style>
