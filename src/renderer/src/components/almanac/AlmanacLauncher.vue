<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import DatePicker from '../ui/DatePicker.vue'
import { useTodayKey } from '../../composables/useTodayKey.js'
import { useAlmanac } from '../../composables/useAlmanac.js'
import { ALMANAC_GLOSSARY } from '../../../../shared/calendar/almanac-display.js'
import {
  addCalendarDays,
  MIN_CALENDAR_DATE,
  MAX_CALENDAR_DATE,
  parseDateKey
} from '../../../../shared/calendar/calendar-date-rules.js'
const props = defineProps({
  queue: { type: Object, default: null },
  visible: { type: Boolean, default: false }
})
const emit = defineEmits(['update:visible'])
const today = useTodayKey()
const date = ref(today.value)
const followsToday = ref(true)
const sourceOpen = ref(false)
const { result, loading, error, reload } = useAlmanac(() => (props.visible ? date.value : ''))
const almanac = computed(() => result.value?.almanac)
const metadata = computed(() => result.value?.metadata)
function choose(value) {
  date.value = value
  followsToday.value = false
  sourceOpen.value = false
}
function open(value = today.value) {
  try {
    parseDateKey(value)
  } catch {
    return
  }
  date.value = value
  followsToday.value = value === today.value
  sourceOpen.value = false
  emit('update:visible', true)
}
function jumpToday() {
  date.value = today.value
  followsToday.value = true
}
function onOpen(event) {
  open(event.detail?.dateKey || today.value)
}
window.addEventListener('abandon:open-almanac', onOpen)
onBeforeUnmount(() => window.removeEventListener('abandon:open-almanac', onOpen))
watch(today, (value) => {
  if (followsToday.value) date.value = value
})
</script>
<template>
  <AppModalShell
    :queue="queue"
    :visible="visible"
    title="万年历"
    subtitle="农历 · 节气 · 传统黄历"
    width="min(520rem, calc(100vw - 24px))"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="almanac-window" :data-date="date">
      <nav class="almanac-window__navigation" aria-label="万年历日期">
        <button
          type="button"
          aria-label="前一天"
          :disabled="date <= MIN_CALENDAR_DATE"
          @click="choose(addCalendarDays(date, -1))"
        >
          ‹
        </button>
        <DatePicker :model-value="date" aria-label="万年历选择日期" @update:model-value="choose" />
        <button
          type="button"
          aria-label="后一天"
          :disabled="date >= MAX_CALENDAR_DATE"
          @click="choose(addCalendarDays(date, 1))"
        >
          ›
        </button>
        <button type="button" @click="jumpToday">今天</button>
      </nav>
      <div class="almanac-window__content scroll-y" aria-live="polite" :aria-busy="loading">
        <p v-if="loading">正在读取 {{ date }}…</p>
        <p v-else-if="error" role="status">
          {{ error }} <button type="button" @click="reload">重试</button>
        </p>
        <div v-else-if="result" :key="result.dateKey" class="almanac-window__day">
          <p class="almanac-window__lunar">
            {{
              metadata?.lunar
                ? `农历${metadata.lunar.isLeap ? '闰' : ''}${metadata.lunar.monthText}${metadata.lunar.dayText}`
                : '该日期暂无农历信息'
            }}
          </p>
          <p v-if="metadata?.festivals?.length || metadata?.solarTerm">
            {{
              [
                ...new Set(
                  [
                    ...(metadata.festivals || []).map((item) => item.name),
                    metadata.solarTerm
                  ].filter(Boolean)
                )
              ].join(' · ')
            }}
          </p>
          <p v-if="metadata?.holiday?.type === 'off'">
            法定休假安排：{{ metadata.holiday.name || '休息日' }}
          </p>
          <p v-else-if="metadata?.holiday?.type === 'work'">调休工作日</p>
          <template v-if="almanac?.status === 'ok'">
            <p class="almanac-window__meta">
              {{ almanac.yearGanzhi }}年 · {{ almanac.monthGanzhi }}月 · {{ almanac.dayGanzhi }}日 ·
              {{ almanac.officer }}日
            </p>
            <section
              v-for="side in ['yi', 'ji']"
              :key="side"
              class="almanac-window__group"
              :class="`is-${side}`"
              :aria-label="side === 'yi' ? '宜' : '忌'"
            >
              <b>{{ side === 'yi' ? '宜' : '忌' }}</b>
              <div>
                <strong v-for="term in almanac[side].special" :key="term">{{ term }}</strong>
                <span v-for="term in almanac[side].items" :key="term" class="almanac-window__term"
                  >{{ term
                  }}<small v-if="ALMANAC_GLOSSARY[term]"
                    >（{{ ALMANAC_GLOSSARY[term] }}）</small
                  ></span
                >
                <span v-if="!almanac[side].items.length && !almanac[side].special.length">{{
                  side === 'yi' ? '无特别宜项' : '无特别忌项'
                }}</span>
              </div>
            </section>
            <p v-if="almanac.conflicts.length" class="almanac-window__meta">
              原规则存在交叠条目：{{ almanac.conflicts.join('、') }}，已保留两侧原文。
            </p>
            <section class="almanac-window__source">
              <button
                type="button"
                class="almanac-window__source-toggle"
                :aria-expanded="sourceOpen"
                aria-controls="almanac-source"
                @click="sourceOpen = !sourceOpen"
              >
                规则与来源 <span :class="{ 'is-open': sourceOpen }" aria-hidden="true">›</span>
              </button>
              <div
                id="almanac-source"
                class="almanac-window__source-reveal"
                :class="{ 'is-open': sourceOpen }"
                :aria-hidden="!sourceOpen"
                :inert="!sourceOpen"
              >
                <div class="almanac-window__source-content">
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
                ? '该日期暂不支持宜忌，农历与便签功能不受影响。'
                : '宜忌暂时无法计算，请稍后重试。'
            }}
          </p>
        </div>
      </div>
    </div>
  </AppModalShell>
</template>
<style scoped>
.almanac-window {
  display: flex;
  flex-direction: column;
  gap: 14rem;
  min-width: 0;
}
.almanac-window__navigation {
  display: flex;
  align-items: center;
  gap: 6rem;
  flex-wrap: wrap;
}
.almanac-window__navigation button {
  border: 1px solid var(--ui-border-control);
  background: var(--ui-surface-control);
  color: var(--text-color);
  padding: 5rem 9rem;
  border-radius: 6rem;
  cursor: pointer;
}
.almanac-window__navigation button:disabled {
  opacity: 0.4;
  cursor: default;
}
.almanac-window__content {
  height: min(440rem, 48vh);
  max-height: min(440rem, 48vh);
  overflow-y: auto;
  overflow-wrap: anywhere;
}
.almanac-window__content p {
  margin: 8rem 0;
}
.almanac-window__lunar {
  font-size: var(--fs-body);
  font-weight: 600;
}
.almanac-window__meta,
.almanac-window__source {
  font-size: var(--fs-secondary);
  opacity: 0.8;
}
.almanac-window__group {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12rem;
  padding: 12rem 0;
  border-top: 1px solid var(--ui-border-divider);
}
.almanac-window__group > b {
  color: var(--ui-accent);
}
.almanac-window__group.is-ji > b {
  color: var(--ui-warning);
}
.almanac-window__group > div {
  display: flex;
  flex-wrap: wrap;
  gap: 6rem 12rem;
}
.almanac-window__term {
  font-size: var(--fs-body);
}
.almanac-window__term small {
  font-size: var(--fs-secondary);
  opacity: 0.72;
}
.almanac-window__source-toggle {
  display: flex;
  gap: 8rem;
  align-items: center;
  padding: 4rem 0;
  border: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  cursor: pointer;
}
.almanac-window__source-toggle > span {
  display: inline-block;
  transition: transform var(--motion-control) var(--ease-standard);
}
.almanac-window__source-toggle > span.is-open {
  transform: rotate(90deg);
}
.almanac-window__source-reveal {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows var(--motion-panel) var(--ease-standard),
    opacity var(--motion-control) ease;
}
.almanac-window__source-reveal.is-open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.almanac-window__source-content {
  min-height: 0;
  overflow: hidden;
}
.almanac-window__day {
  animation: almanac-day-reveal var(--motion-control) var(--ease-standard);
}
@keyframes almanac-day-reveal {
  from {
    opacity: 0;
    transform: translateY(4rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
