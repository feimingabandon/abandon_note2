<script setup>
/**
 * MockStatusRing.vue — StatusRing 的静态只读复刻（帮助图解专用）
 *
 * 只呈现三种稳定状态的外观：初始化（蓝空心环）/ 进行中（橙空心环）/ 已完成（绿实心 + 白勾）。
 * 不含任何过渡/交互逻辑，仅用于帮助中心的仿造图。
 */
defineProps({
  status: { type: String, default: 'initialized' }
})

const COLOR = {
  initialized: '#0A84FF',
  in_progress: '#FF9F0A',
  completed: '#30D158'
}
</script>

<template>
  <span
    class="msr"
    :class="`msr--${status}`"
    :style="{ '--msr-color': COLOR[status] || COLOR.initialized }"
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle v-if="status === 'completed'" class="msr-fill" cx="10" cy="10" r="6.55" />
      <circle class="msr-track" cx="10" cy="10" r="7.6" />
      <path v-if="status === 'completed'" class="msr-check" d="m5.2 10.2 3.1 3.1 6.6-7" />
    </svg>
  </span>
</template>

<style scoped>
.msr {
  display: inline-block;
  width: 20rem;
  height: 20rem;
  color: var(--msr-color);
}
.msr svg {
  display: block;
  width: 20rem;
  height: 20rem;
  overflow: visible;
}
.msr-track {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
}
.msr--completed .msr-track {
  stroke: color-mix(in srgb, #30d158 72%, #8a8a8a);
}
.msr-fill {
  fill: #30d158;
}
.msr-check {
  fill: none;
  stroke: #fff;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
