<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { quickNoteEditorPosition } from '../../utils/quickNoteEditorPosition.js'
import { ownPopover, releasePopover } from '../../utils/anchoredPopover.js'
import { ALMANAC_GLOSSARY } from '../../../../shared/calendar/almanac-display.js'

const props = defineProps({
  dateKey: { type: String, required: true },
  anchor: { type: Object, required: true },
  weather: { type: Object, default: null },
  currentWeather: { type: Object, default: null },
  result: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' }
})
const emit = defineEmits(['close', 'retry'])
const panel = ref(null)
const position = reactive({ left: '8px', top: '8px', visibility: 'hidden' })
const almanac = computed(() => props.result?.almanac)
const metadata = computed(() => props.result?.metadata)
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
let observer
let focusFrame
let disposed = false

function reposition() {
  if (!panel.value || !props.anchor.isConnected) return
  const anchor = props.anchor.getBoundingClientRect()
  const placed = quickNoteEditorPosition(anchor, panel.value.getBoundingClientRect(), {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    padding: 8
  })
  position.left = `${placed.left}px`
  position.top = `${placed.top}px`
  position.visibility = 'visible'
  position['--date-context-offset'] = placed.top < anchor.top ? '4px' : '-4px'
}
function dismiss() {
  emit('close', false)
}
function onOutside(event) {
  if (panel.value?.contains(event.target) || props.anchor.contains(event.target)) return
  dismiss()
}
function onKeydown(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  emit('close', true)
}
function onScroll(event) {
  if (!panel.value?.contains(event.target)) dismiss()
}
onMounted(async () => {
  ownPopover(panel.value, props.anchor)
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('focusin', onOutside)
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', reposition)
  window.addEventListener('blur', dismiss)
  window.addEventListener('abandon:date-context-open', dismiss)
  window.addEventListener('abandon:open-almanac', dismiss)
  await nextTick()
  if (disposed) return
  observer = new ResizeObserver(reposition)
  observer.observe(panel.value)
  // 列表筛选按钮收放时，摘要锚点的宽度和位置会同步变化。
  observer.observe(props.anchor)
  reposition()
  focusFrame = requestAnimationFrame(() =>
    panel.value?.querySelector('button')?.focus({ preventScroll: true })
  )
})
onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(focusFrame)
  observer?.disconnect()
  releasePopover(panel.value)
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('focusin', onOutside)
  document.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', reposition)
  window.removeEventListener('blur', dismiss)
  window.removeEventListener('abandon:date-context-open', dismiss)
  window.removeEventListener('abandon:open-almanac', dismiss)
})
</script>

<template>
  <section
    ref="panel"
    class="date-context-popover"
    :style="position"
    :data-date="dateKey"
    role="dialog"
    :aria-label="`${dateKey} 天气与宜忌`"
    @click.stop
    @dblclick.stop
    @pointerdown.stop
    @contextmenu.stop
    @keydown.stop
  >
    <header class="date-context-popover__header">
      <strong>{{ dateKey }}</strong>
      <button type="button" aria-label="关闭天气与宜忌详情" @click="emit('close', true)">×</button>
    </header>
    <div class="date-context-popover__body scroll-y">
      <section class="date-context-popover__weather" aria-label="当日天气">
        <h3>天气</h3>
        <template v-if="currentWeather">
          <p>
            当前 {{ currentWeather.icon }} {{ currentWeather.label }}
            {{ currentWeather.temperature }}°
          </p>
          <p v-if="currentWeather.apparentTemperature != null">
            体感 {{ currentWeather.apparentTemperature }}°
          </p>
          <p v-if="currentWeather.windSpeed != null">
            当前风速 {{ currentWeather.windSpeed }} km/h
          </p>
          <p v-if="currentWeather.updateLabel" class="date-context-popover__muted">
            {{ currentWeather.validTimeLabel }}<br />
            {{ currentWeather.updateLabel }}
          </p>
          <p v-if="currentWeather.sourceLabel" class="date-context-popover__muted">
            {{ currentWeather.sourceLabel }} · 当前模型估算
          </p>
        </template>
        <template v-if="weather">
          <p>
            <span>全天预报 </span>
            {{ weather.icon }} {{ weather.label }} {{ weather.temperatureMin }}°～{{
              weather.temperatureMax
            }}°
          </p>
          <p v-if="weather.locationLabel" class="date-context-popover__muted">
            {{ weather.locationLabel }}
          </p>
          <p v-if="weather.precipitationProbability != null">
            降水概率 {{ weather.precipitationProbability }}%
          </p>
          <p v-if="weather.precipitation != null">预计降水 {{ weather.precipitation }} mm</p>
          <p v-if="weather.windSpeedMax != null">最大风速 {{ weather.windSpeedMax }} km/h</p>
          <p v-if="weather.updateLabel" class="date-context-popover__muted">
            {{ weather.updateLabel }}
          </p>
          <p v-if="weather.sourceLabel" class="date-context-popover__muted">
            {{ weather.sourceLabel }}
          </p>
          <p v-if="weather.supplementLabel" class="date-context-popover__muted">
            {{ weather.supplementLabel }}
          </p>
          <p class="date-context-popover__muted">
            全天预报概括当天最显著的天气，出现降雨不代表此刻或全天都在下雨。
          </p>
        </template>
        <p v-else class="date-context-popover__muted">该日期暂无可用天气预报</p>
      </section>
      <section aria-label="当日宜忌" aria-live="polite" :aria-busy="loading">
        <h3>宜忌</h3>
        <p v-if="loading">正在读取…</p>
        <p v-else-if="error" role="status">
          {{ error }} <button type="button" @click="emit('retry')">重试</button>
        </p>
        <template v-else-if="result">
          <p v-if="metadata?.lunar" class="date-context-popover__muted">
            农历{{ metadata.lunar.isLeap ? '闰' : '' }}{{ metadata.lunar.monthText
            }}{{ metadata.lunar.dayText }}
          </p>
          <p v-if="festivals" class="date-context-popover__muted">{{ festivals }}</p>
          <template v-if="almanac?.status === 'ok'">
            <p class="date-context-popover__muted">
              {{ almanac.yearGanzhi }}年 · {{ almanac.monthGanzhi }}月 · {{ almanac.dayGanzhi }}日 ·
              {{ almanac.officer }}日
            </p>
            <div
              v-for="side in ['yi', 'ji']"
              :key="side"
              class="date-context-popover__group"
              :class="`is-${side}`"
            >
              <b>{{ side === 'yi' ? '宜' : '忌' }}</b>
              <div>
                <strong v-for="term in almanac[side].special" :key="term">{{ term }}</strong>
                <span
                  v-for="term in almanac[side].items"
                  :key="term"
                  :title="ALMANAC_GLOSSARY[term]"
                  >{{ term
                  }}<small v-if="ALMANAC_GLOSSARY[term]"
                    >（{{ ALMANAC_GLOSSARY[term] }}）</small
                  ></span
                >
                <span v-if="!almanac[side].items.length && !almanac[side].special.length">{{
                  side === 'yi' ? '无特别宜项' : '无特别忌项'
                }}</span>
              </div>
            </div>
            <p class="date-context-popover__muted">
              规则参考{{ almanac.source.reference }}；不同通书口径可能有差异。
            </p>
          </template>
          <p v-else>
            {{ almanac?.status === 'unsupported' ? '该日期暂不支持宜忌' : '宜忌暂时无法计算' }}
          </p>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped>
.date-context-popover {
  position: fixed;
  z-index: var(--z-global-popover);
  display: flex;
  flex-direction: column;
  width: min(380rem, calc(100vw - 16px));
  max-height: min(540rem, calc(100vh - 16px));
  padding: 10rem 12rem;
  box-sizing: border-box;
  border: 1px solid var(--ui-border-control);
  border-radius: 14px;
  background: var(--surface-float);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--text-color) 16%, transparent);
  color: var(--text-color);
  font-size: var(--fs-secondary);
  line-height: 1.5;
}
.date-context-popover__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  flex: 0 0 auto;
}
.date-context-popover__header button {
  width: 26rem;
  height: 26rem;
  padding: 0;
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.date-context-popover__header button:hover {
  background: var(--ui-fill-hover);
}
.date-context-popover__body {
  min-height: 0;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
.date-context-popover__body section + section {
  border-top: 1px solid var(--ui-border-divider);
  margin-top: 10rem;
}
.date-context-popover h3 {
  margin: 8rem 0;
  font-size: inherit;
}
.date-context-popover p {
  margin: 5rem 0;
}
.date-context-popover__muted,
.date-context-popover small {
  color: var(--text-color-secondary);
  font-size: 0.9em;
  font-weight: normal;
}
.date-context-popover__group {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8rem;
  padding: 6rem 0;
}
.date-context-popover__group > b {
  color: var(--ui-accent);
}
.date-context-popover__group.is-ji > b {
  color: var(--ui-warning);
}
.date-context-popover__group > div {
  display: flex;
  flex-wrap: wrap;
  gap: 4rem 10rem;
}
</style>
