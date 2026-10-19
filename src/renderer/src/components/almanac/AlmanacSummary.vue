<script setup>
import DateContextSummary from './DateContextSummary.vue'
import { useDateContextSettings } from '../../composables/useDateContextSettings.js'

defineProps({ dateKey: { type: String, required: true } })
const { almanacEnabled, forecast } = useDateContextSettings()
</script>

<template>
  <section v-if="almanacEnabled" class="almanac-summary" aria-label="所选日期宜忌">
    <DateContextSummary kind="almanac" :date-key="dateKey" :forecast="forecast" />
  </section>
</template>

<style scoped>
.almanac-summary {
  padding: 8rem 12rem;
  border-bottom: 1px solid var(--ui-border-divider);
  min-width: 0;
}
</style>
