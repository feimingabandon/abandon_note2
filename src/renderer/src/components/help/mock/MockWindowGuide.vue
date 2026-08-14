<script setup>
defineProps({
  viewMode: { type: String, default: 'list' }
})
</script>

<template>
  <div class="mwg-shell">
    <div class="mwg-titlebar">
      <div class="mwg-lights" aria-hidden="true">
        <span class="mwg-light mwg-light--close"></span>
        <span class="mwg-light mwg-light--pin"></span>
        <span class="mwg-light mwg-light--lock"></span>
      </div>
      <div class="mwg-actions">
        <span>日报</span>
        <span v-if="viewMode === 'list'">循环模板</span>
        <span>设置</span>
        <span>帮助</span>
      </div>
    </div>
    <div class="mwg-legend">
      <span><i class="mwg-dot mwg-dot--close"></i>关闭窗口</span>
      <span><i class="mwg-dot mwg-dot--pin"></i>窗口置顶</span>
      <span><i class="mwg-dot mwg-dot--lock"></i>锁定窗口</span>
    </div>
  </div>
</template>

<style scoped>
.mwg-shell {
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--ui-border-control);
  border-radius: 12rem;
  background: var(--ui-surface-subtle);
}
.mwg-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
  min-height: 42rem;
  padding: 0 12rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.mwg-lights,
.mwg-actions,
.mwg-legend {
  display: flex;
  align-items: center;
}
.mwg-lights {
  gap: 7rem;
}
.mwg-light,
.mwg-dot {
  display: inline-block;
  flex-shrink: 0;
  border-radius: 50%;
}
.mwg-light {
  width: 14rem;
  height: 14rem;
}
.mwg-light--close,
.mwg-dot--close {
  background: #ff5f57;
}
.mwg-light--pin,
.mwg-dot--pin {
  background: #febc2e;
}
.mwg-light--lock,
.mwg-dot--lock {
  background: #28c840;
}
.mwg-actions {
  gap: 4rem;
  min-width: 0;
}
.mwg-actions span {
  padding: 4rem 7rem;
  border-radius: 7rem;
  background: var(--ui-fill-passive);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
  white-space: nowrap;
}
.mwg-legend {
  flex-wrap: wrap;
  gap: 8rem 14rem;
  padding: 10rem 12rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.88);
}
.mwg-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5rem;
}
.mwg-dot {
  width: 7rem;
  height: 7rem;
}
</style>
