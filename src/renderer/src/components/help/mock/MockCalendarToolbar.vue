<script setup>
defineProps({
  viewMode: { type: String, default: 'month' }
})
</script>

<template>
  <div class="mct-toolbar">
    <div class="mct-weather"><strong>杭州</strong><span>· 和风天气</span></div>
    <div class="mct-navigation">
      <button aria-label="上一页">‹</button>
      <div class="mct-period">
        <span v-if="viewMode === 'week'">2026年8月10日—8月16日</span>
        <span v-else>2026年 8月</span>
        <i>⌄</i>
      </div>
      <button aria-label="下一页">›</button>
    </div>
    <div class="mct-actions"><span>今天</span><button aria-label="刷新">↻</button></div>
  </div>
</template>

<style scoped>
.mct-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 10rem;
  width: 100%;
  min-height: 42rem;
}
.mct-weather,
.mct-navigation,
.mct-actions {
  display: flex;
  align-items: center;
}
.mct-weather {
  gap: 4rem;
  min-width: 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.78);
}
.mct-weather strong,
.mct-weather span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mct-weather strong {
  color: var(--text-color);
  font-weight: 500;
}
.mct-navigation {
  justify-content: center;
  gap: 7rem;
}
.mct-navigation button,
.mct-actions button {
  display: grid;
  place-items: center;
  width: 28rem;
  height: 28rem;
  padding: 0;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: 21rem;
}
.mct-period {
  display: flex;
  align-items: center;
  gap: 5rem;
  min-width: 126rem;
  justify-content: center;
  font-size: var(--fs-secondary);
  font-weight: 650;
  white-space: nowrap;
}
.mct-period i {
  color: var(--text-color-secondary);
  font-style: normal;
}
.mct-actions {
  justify-self: end;
  gap: 5rem;
}
.mct-actions span {
  padding: 5rem 9rem;
  border-radius: 7rem;
  background: var(--ui-surface-control);
  color: var(--text-color);
  font-size: calc(var(--fs-secondary) * 0.84);
}
.mct-actions button {
  color: var(--text-color-secondary);
  font-size: 17rem;
}
@container (max-width: 500px) {
  .mct-weather {
    display: none;
  }
  .mct-toolbar {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .mct-navigation {
    justify-self: start;
  }
}
</style>
