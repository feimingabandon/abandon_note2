<script setup>
import { computed, ref, useId, watch } from 'vue'
import DatePicker from '../ui/DatePicker.vue'
import { useAlmanac } from '../../composables/useAlmanac.js'
import { useDateContextSettings } from '../../composables/useDateContextSettings.js'
import { useSharedMinuteClock } from '../../composables/useSharedMinuteClock.js'
import { useTodayKey } from '../../composables/useTodayKey.js'
import {
  buildDisplayableCurrentWeather,
  buildDisplayableWeatherByDate
} from '../../utils/noteWeather.js'
import { ALMANAC_GLOSSARY } from '../../../../shared/calendar/almanac-display.js'
import {
  addCalendarDays,
  MAX_CALENDAR_DATE,
  MIN_CALENDAR_DATE,
  parseDateKey
} from '../../../../shared/calendar/calendar-date-rules.js'

const props = defineProps({
  modelValue: { type: String, required: true },
  active: { type: Boolean, default: true }
})
const emit = defineEmits(['update:modelValue'])
const today = useTodayKey()
const minute = useSharedMinuteClock()
const { weatherEnabled, almanacEnabled, forecast } = useDateContextSettings()
const followsToday = ref(props.modelValue === today.value)
const sourceOpen = ref(false)
const sourceId = `date-context-source-${useId()}`
const { result, loading, error, reload } = useAlmanac(() =>
  props.active && almanacEnabled.value ? props.modelValue : ''
)
// A date change must never leave the previous day's result below the new heading.
const selectedResult = computed(() =>
  result.value?.dateKey === props.modelValue ? result.value : null
)
const almanac = computed(() => selectedResult.value?.almanac)
const metadata = computed(() => selectedResult.value?.metadata)
const festivals = computed(() =>
  [
    ...new Set(
      [
        ...(metadata.value?.festivals || []).map((item) => item.name),
        metadata.value?.solarTerm
      ].filter(Boolean)
    )
  ].join(' · ')
)
const weather = computed(() => {
  if (!props.active || !weatherEnabled.value) return null
  return (
    buildDisplayableWeatherByDate(forecast.value, Math.max(minute.value, Date.now())).get(
      props.modelValue
    ) || null
  )
})
const currentWeather = computed(() => {
  if (!props.active || !weatherEnabled.value || props.modelValue !== today.value) return null
  const current = buildDisplayableCurrentWeather(forecast.value, Math.max(minute.value, Date.now()))
  return current?.date === props.modelValue ? current : null
})

function choose(value) {
  try {
    parseDateKey(value)
  } catch {
    return
  }
  if (value < MIN_CALENDAR_DATE || value > MAX_CALENDAR_DATE) return
  followsToday.value = false
  emit('update:modelValue', value)
}
function moveDay(delta) {
  choose(addCalendarDays(props.modelValue, delta))
}
function jumpToday() {
  followsToday.value = true
  emit('update:modelValue', today.value)
}
watch(today, (value) => {
  if (followsToday.value) emit('update:modelValue', value)
})
watch(
  () => props.modelValue,
  () => {
    sourceOpen.value = false
  }
)
</script>

<template>
  <div class="date-context-details" :data-date="modelValue">
    <nav
      class="date-context-details__navigation almanac-window__navigation"
      aria-label="天气与宜忌日期"
    >
      <button
        type="button"
        class="date-context-details__day-arrow"
        aria-label="前一天"
        :disabled="modelValue <= MIN_CALENDAR_DATE"
        @click="moveDay(-1)"
      >
        ‹
      </button>
      <DatePicker
        :model-value="modelValue"
        aria-label="天气与宜忌选择日期"
        @update:model-value="choose"
      />
      <button
        type="button"
        class="date-context-details__day-arrow"
        aria-label="后一天"
        :disabled="modelValue >= MAX_CALENDAR_DATE"
        @click="moveDay(1)"
      >
        ›
      </button>
      <button type="button" class="date-context-details__today" @click="jumpToday">今天</button>
    </nav>
    <div class="date-context-details__content almanac-window__content scroll-y">
      <div :key="modelValue" class="date-context-details__day almanac-window__day">
        <section
          v-if="weatherEnabled"
          class="date-context-details__weather date-context-popover__weather"
          aria-label="当日天气"
        >
          <h3>天气</h3>
          <div v-if="currentWeather" class="date-context-details__current">
            <div class="date-context-details__reading">
              <div>
                <span class="date-context-details__eyebrow">
                  当前 {{ currentWeather.icon }} {{ currentWeather.label }}
                </span>
                <p class="date-context-details__temperature">{{ currentWeather.temperature }}°</p>
              </div>
            </div>
            <dl class="date-context-details__metrics">
              <div v-if="currentWeather.apparentTemperature != null">
                <dt>体感{{ ' ' }}</dt>
                <dd>{{ currentWeather.apparentTemperature }}°</dd>
              </div>
              <div v-if="currentWeather.windSpeed != null">
                <dt>当前风速{{ ' ' }}</dt>
                <dd>{{ currentWeather.windSpeed }} <small>km/h</small></dd>
              </div>
            </dl>
            <div class="date-context-details__provenance">
              <p v-if="currentWeather.updateLabel">
                {{ currentWeather.validTimeLabel }}<br />{{ currentWeather.updateLabel }}
              </p>
              <p v-if="currentWeather.sourceLabel">
                {{ currentWeather.sourceLabel }} · 当前模型估算
              </p>
            </div>
          </div>
          <div
            v-if="weather"
            class="date-context-details__forecast"
            :class="{ 'has-current': currentWeather }"
          >
            <div class="date-context-details__forecast-heading">
              <div>
                <span class="date-context-details__eyebrow">全天预报</span>
                <p class="date-context-details__condition">
                  <span aria-hidden="true">{{ weather.icon }}</span> {{ weather.label }}
                </p>
              </div>
              <p class="date-context-details__range">
                {{ weather.temperatureMin }}°<span>～</span>{{ weather.temperatureMax }}°
              </p>
            </div>
            <p v-if="weather.locationLabel" class="date-context-details__muted">
              {{ weather.locationLabel }}
            </p>
            <dl class="date-context-details__metrics">
              <div v-if="weather.precipitationProbability != null">
                <dt>降水概率{{ ' ' }}</dt>
                <dd>{{ weather.precipitationProbability }}<small>%</small></dd>
              </div>
              <div v-if="weather.precipitation != null">
                <dt>预计降水{{ ' ' }}</dt>
                <dd>{{ weather.precipitation }} <small>mm</small></dd>
              </div>
              <div v-if="weather.windSpeedMax != null">
                <dt>最大风速{{ ' ' }}</dt>
                <dd>{{ weather.windSpeedMax }} <small>km/h</small></dd>
              </div>
            </dl>
            <div class="date-context-details__provenance">
              <p v-if="weather.updateLabel">{{ weather.updateLabel }}</p>
              <p v-if="weather.sourceLabel">{{ weather.sourceLabel }}</p>
              <p v-if="weather.supplementLabel">{{ weather.supplementLabel }}</p>
              <p>全天预报概括当天最显著的天气，出现降雨不代表此刻或全天都在下雨。</p>
            </div>
          </div>
          <p v-else-if="!currentWeather" class="date-context-details__muted">
            该日期暂无可用天气预报
          </p>
        </section>
        <section
          v-if="almanacEnabled"
          class="date-context-details__almanac"
          :data-date="selectedResult?.dateKey"
          aria-label="当日宜忌"
          aria-live="polite"
          :aria-busy="loading"
        >
          <h3>宜忌</h3>
          <p v-if="loading">正在读取 {{ modelValue }}…</p>
          <p v-else-if="error" role="status">
            {{ error }}
            <button type="button" class="date-context-details__retry" @click="reload">重试</button>
          </p>
          <template v-else-if="selectedResult">
            <p class="date-context-details__lunar almanac-window__lunar">
              {{
                metadata?.lunar
                  ? `农历${metadata.lunar.isLeap ? '闰' : ''}${metadata.lunar.monthText}${metadata.lunar.dayText}`
                  : '该日期暂无农历信息'
              }}
            </p>
            <p v-if="festivals" class="date-context-details__festivals">{{ festivals }}</p>
            <p v-if="metadata?.holiday?.type === 'off'" class="date-context-details__muted">
              法定休假安排：{{ metadata.holiday.name || '休息日' }}
            </p>
            <p v-else-if="metadata?.holiday?.type === 'work'" class="date-context-details__muted">
              调休工作日
            </p>
            <template v-if="almanac?.status === 'ok'">
              <p class="date-context-details__muted">
                {{ almanac.yearGanzhi }}年 · {{ almanac.monthGanzhi }}月 · {{ almanac.dayGanzhi }}日
                · {{ almanac.officer }}日
              </p>
              <div
                v-for="side in ['yi', 'ji']"
                :key="side"
                class="date-context-details__group almanac-window__group date-context-popover__group"
                :class="`is-${side}`"
                :aria-label="side === 'yi' ? '宜' : '忌'"
              >
                <b>{{ side === 'yi' ? '宜' : '忌' }}</b>
                <div>
                  <strong
                    v-for="term in almanac[side].special"
                    :key="term"
                    class="date-context-details__term"
                    >{{ term }}</strong
                  >
                  <span
                    v-for="term in almanac[side].items"
                    :key="term"
                    class="date-context-details__term"
                    :title="ALMANAC_GLOSSARY[term]"
                  >
                    {{ term
                    }}<small v-if="ALMANAC_GLOSSARY[term]">（{{ ALMANAC_GLOSSARY[term] }}）</small>
                  </span>
                  <span v-if="!almanac[side].items.length && !almanac[side].special.length">
                    {{ side === 'yi' ? '无特别宜项' : '无特别忌项' }}
                  </span>
                </div>
              </div>
              <p v-if="almanac.conflicts.length" class="date-context-details__muted">
                原规则存在交叠条目：{{ almanac.conflicts.join('、') }}，已保留两侧原文。
              </p>
              <section class="date-context-details__source">
                <button
                  type="button"
                  class="date-context-details__source-toggle almanac-window__source-toggle"
                  :aria-expanded="sourceOpen"
                  :aria-controls="sourceId"
                  @click="sourceOpen = !sourceOpen"
                >
                  规则与来源 <span :class="{ 'is-open': sourceOpen }" aria-hidden="true">›</span>
                </button>
                <div
                  :id="sourceId"
                  class="date-context-details__source-reveal almanac-window__source-reveal"
                  :class="{ 'is-open': sourceOpen }"
                  :aria-hidden="!sourceOpen"
                  :inert="!sourceOpen"
                >
                  <div class="date-context-details__source-content">
                    <p>规则参考{{ almanac.source.reference }}；不同通书口径可能有差异。</p>
                    <p>
                      {{
                        almanac.source.convention
                      }}。日级结果固定采用所选日期，不提供个人择日或时辰吉凶。
                    </p>
                    <p>实现：{{ almanac.source.name }} · {{ almanac.source.rules }}</p>
                    <p>
                      宜忌支持 {{ almanac.source.minDate }} 至
                      {{ almanac.source.maxDate }}，可离线查询。
                    </p>
                  </div>
                </div>
              </section>
            </template>
            <p v-else>
              {{
                almanac?.status === 'unsupported'
                  ? '该日期暂不支持宜忌'
                  : '宜忌暂时无法计算，请稍后重试'
              }}
            </p>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.date-context-details {
  container: date-context / inline-size;
  display: flex;
  flex-direction: column;
  gap: 14rem;
  min-width: 0;
  min-height: 0;
  font-size: var(--fs-secondary);
  line-height: 1.6;
}
.date-context-details__navigation {
  display: grid;
  grid-template-columns: 32rem minmax(0, 1fr) 32rem auto;
  align-items: center;
  gap: 4rem;
  flex: 0 0 auto;
}
.date-context-details__navigation > button {
  min-height: 34rem;
  padding: 4rem 8rem;
  border: 0;
  border-radius: 8rem;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  cursor: pointer;
  transition: background var(--motion-fast) ease;
}
.date-context-details__navigation > button:hover:not(:disabled) {
  background: var(--ui-fill-hover);
}
.date-context-details__navigation > .date-context-details__day-arrow {
  display: grid;
  place-items: center;
  padding: 0;
  font-size: calc(var(--fs-secondary) * 1.25);
  line-height: 1;
}
.date-context-details__navigation > .date-context-details__today {
  margin-left: 4rem;
  padding-inline: 11rem;
  background: var(--ui-fill-passive);
  font-size: 0.9em;
  white-space: nowrap;
}
.date-context-details__navigation :deep(.date-picker__trigger) {
  min-height: 34rem;
  padding: 4rem 10rem;
  font-size: var(--fs-secondary);
  line-height: 1.4;
}
.date-context-details__navigation :deep(.date-picker__trigger span) {
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.date-context-details__navigation :deep(.date-picker__trigger svg:first-child) {
  width: 14rem;
  height: 14rem;
}
.date-context-details__navigation :deep(.date-picker__trigger:focus-visible) {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 2px;
}
.date-context-details__navigation > button:disabled {
  opacity: 0.4;
  cursor: default;
}
.date-context-details__navigation > button:focus-visible,
.date-context-details__retry:focus-visible,
.date-context-details__source-toggle:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 2px;
}
.date-context-details__retry {
  margin-left: 6rem;
  padding: 3rem 8rem;
  border: 1px solid var(--ui-border-control);
  border-radius: var(--ui-control-radius);
  background: var(--ui-surface-control);
  color: var(--text-color);
  font: inherit;
  cursor: pointer;
  transition: border-color var(--motion-fast) ease;
}
.date-context-details__retry:hover {
  border-color: var(--ui-border-hover);
}
.date-context-details__content {
  min-height: 0;
  max-height: min(440rem, 58vh);
  overflow-y: auto;
  overflow-wrap: anywhere;
  padding-right: 2rem;
}
.date-context-details__day > section + section {
  border-top: 1px solid var(--ui-border-divider);
  margin-top: 18rem;
  padding-top: 14rem;
}
.date-context-details h3 {
  margin: 0 0 10rem;
  color: var(--text-color-secondary);
  font-size: 0.9em;
  font-weight: 500;
}
.date-context-details p {
  margin: 5rem 0;
}
.date-context-details__reading {
  display: flex;
  align-items: center;
  gap: 12rem;
}
.date-context-details__eyebrow {
  color: var(--text-color-secondary);
  font-size: 0.88em;
}
.date-context-details .date-context-details__temperature {
  margin: 0;
  font-size: calc(var(--fs-body) * 1.8);
  font-weight: 500;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}
.date-context-details__forecast.has-current {
  margin-top: 14rem;
  padding-top: 14rem;
  border-top: 1px solid var(--ui-border-divider);
}
.date-context-details__forecast-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 5rem 14rem;
}
.date-context-details .date-context-details__condition {
  margin: 2rem 0 0;
  font-size: var(--fs-body);
  font-weight: 500;
}
.date-context-details .date-context-details__range {
  margin: 0;
  font-size: calc(var(--fs-body) * 1.2);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.date-context-details__range > span {
  margin-inline: 3rem;
  color: var(--text-color-secondary);
  font-size: 0.75em;
}
.date-context-details__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 6.5em), 1fr));
  gap: 10rem 16rem;
  margin: 12rem 0;
}
.date-context-details__metrics > div {
  min-width: 0;
}
.date-context-details__metrics dt {
  margin-bottom: 2rem;
  color: var(--text-color-secondary);
  font-size: 0.84em;
}
.date-context-details__metrics dd {
  margin: 0;
  font-size: 1.05em;
  font-variant-numeric: tabular-nums;
}
.date-context-details__provenance {
  margin-top: 8rem;
  color: var(--text-color-secondary);
  font-size: 0.86em;
  line-height: 1.65;
}
.date-context-details__provenance p {
  margin: 3rem 0;
}
.date-context-details__metrics:empty,
.date-context-details__provenance:empty {
  display: none;
}
.date-context-details__lunar {
  font-size: calc(var(--fs-body) * 1.05);
  font-weight: 600;
}
.date-context-details__festivals {
  color: var(--ui-accent);
}
.date-context-details__muted,
.date-context-details__source,
.date-context-details small {
  color: var(--text-color-secondary);
  font-size: 0.9em;
  font-weight: normal;
}
.date-context-details__group {
  display: grid;
  grid-template-columns: 20rem minmax(0, 1fr);
  align-items: baseline;
  gap: 12rem;
  padding: 12rem 0;
}
.date-context-details__group + .date-context-details__group {
  border-top: 1px solid var(--ui-border-divider);
}
.date-context-details__group > b {
  color: var(--ui-accent);
  font-size: 1.05em;
  font-weight: 600;
}
.date-context-details__group.is-ji > b {
  color: var(--ui-warning);
}
.date-context-details__group > div {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 7rem 14rem;
}
.date-context-details__term {
  min-width: 0;
  max-width: 100%;
  font-weight: 500;
  line-height: 1.7;
}
.date-context-details__term > small {
  margin-left: 3rem;
  font-size: 0.84em;
}
.date-context-details__source {
  padding-top: 4rem;
}
.date-context-details__source-toggle {
  display: flex;
  gap: 6rem;
  align-items: center;
  min-height: 28rem;
  padding: 4rem 0;
  border: 0;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  cursor: pointer;
  transition: color var(--motion-fast) ease;
}
.date-context-details__source-toggle:hover {
  color: var(--text-color);
}
.date-context-details__source-toggle > span {
  display: inline-block;
  transition: transform var(--motion-control) var(--ease-standard);
}
.date-context-details__source-toggle > span.is-open {
  transform: rotate(90deg);
}
.date-context-details__source-reveal {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows var(--motion-panel) var(--ease-standard),
    opacity var(--motion-control) ease;
}
.date-context-details__source-reveal.is-open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.date-context-details__source-content {
  min-height: 0;
  overflow: hidden;
}
.date-context-details__day {
  animation: date-context-day-reveal var(--motion-control) var(--ease-standard);
}
@keyframes date-context-day-reveal {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (max-width: 380px) {
  .date-context-details__navigation {
    grid-template-columns: 30rem minmax(0, 1fr) 30rem;
  }
  .date-context-details__today {
    grid-column: 2;
    justify-self: center;
    margin-left: 0;
  }
}
@container date-context (max-width: 26em) {
  .date-context-details__navigation {
    grid-template-columns: 30rem minmax(0, 1fr) 30rem;
  }
  .date-context-details__navigation > .date-context-details__today {
    grid-column: 2;
    justify-self: center;
    margin-left: 0;
  }
}
</style>
