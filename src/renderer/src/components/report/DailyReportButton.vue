<script setup>
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
    title="导出日报"
    aria-haspopup="dialog"
    @click="emit('open')"
  >
    <img class="btn-icon" src="@/resources/icons/daily-report.svg" alt="导出日报" />
  </button>
</template>
