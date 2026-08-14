<template>
  <div class="msf-flow">
    <div class="msf-step">
      <div class="msf-icon">⌕</div>
      <strong>进入搜索模式</strong>
      <small>第一次点击</small>
    </div>
    <span class="msf-arrow" aria-hidden="true">→</span>
    <div class="msf-step">
      <div class="msf-searchbar">输入关键词</div>
      <strong>展开搜索面板</strong>
      <small>第二次点击</small>
    </div>
    <span class="msf-arrow" aria-hidden="true">→</span>
    <div class="msf-step">
      <div class="msf-filter">状态 · 标签 · 时间 · 已删除</div>
      <strong>高级筛选</strong>
      <small>条件可以叠加</small>
    </div>
  </div>
</template>

<style scoped>
.msf-flow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 8rem;
  width: 100%;
}
.msf-step {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5rem;
  min-width: 0;
  padding: 12rem 8rem;
  border-radius: 11rem;
  background: var(--ui-surface-subtle);
  text-align: center;
}
.msf-icon {
  display: grid;
  place-items: center;
  width: 32rem;
  height: 32rem;
  border-radius: 9rem;
  background: var(--ui-fill-passive);
  font-size: calc(var(--fs-body) * 1.2);
}
.msf-searchbar,
.msf-filter {
  width: 100%;
  overflow: hidden;
  padding: 6rem 8rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 8rem;
  background: var(--ui-surface-control);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.76);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msf-step strong {
  font-size: calc(var(--fs-secondary) * 0.9);
  font-weight: 600;
}
.msf-step small {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.76);
}
.msf-arrow {
  color: var(--text-color-secondary);
  font-size: var(--fs-body);
}
</style>
