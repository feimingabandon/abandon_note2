<script setup>
import { onBeforeUnmount, ref } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import DateContextDetails from './DateContextDetails.vue'
import { useTodayKey } from '../../composables/useTodayKey.js'
import {
  MAX_CALENDAR_DATE,
  MIN_CALENDAR_DATE,
  parseDateKey
} from '../../../../shared/calendar/calendar-date-rules.js'

defineProps({
  queue: { type: Object, default: null },
  visible: { type: Boolean, default: false }
})
const emit = defineEmits(['update:visible'])
const today = useTodayKey()
const date = ref(today.value)
function open(value = today.value) {
  try {
    parseDateKey(value)
  } catch {
    return
  }
  if (value < MIN_CALENDAR_DATE || value > MAX_CALENDAR_DATE) return
  date.value = value
  emit('update:visible', true)
}
function onOpen(event) {
  open(event.detail?.dateKey || today.value)
}
window.addEventListener('abandon:open-almanac', onOpen)
onBeforeUnmount(() => window.removeEventListener('abandon:open-almanac', onOpen))
</script>

<template>
  <AppModalShell
    :queue="queue"
    :visible="visible"
    title="天气与宜忌"
    subtitle="按日期查看天气 · 农历 · 传统黄历"
    width="min(520rem, calc(100vw - 24px))"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="almanac-window" :data-date="date">
      <DateContextDetails v-model="date" :active="visible" />
    </div>
  </AppModalShell>
</template>

<style scoped>
.almanac-window {
  min-width: 0;
  min-height: 0;
}
</style>
