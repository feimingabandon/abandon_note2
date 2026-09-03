<script setup>
import AppIcon from '../ui/AppIcon.vue'

defineProps({
  monthView: { type: Boolean, default: false }
})
const emit = defineEmits(['open'])
</script>

<template>
  <button
    type="button"
    class="titlebar-btn titlebar-btn-daily-report"
    :class="{ 'month-titlebar-btn': monthView }"
    title="导出便签报表"
    aria-haspopup="dialog"
    @click="emit('open')"
  >
    <AppIcon class="btn-icon" name="daily-report" alt="导出便签报表" />
  </button>
</template>
