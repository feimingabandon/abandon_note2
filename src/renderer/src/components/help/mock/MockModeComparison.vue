<template>
  <div class="mmc-grid">
    <div class="mmc-mode">
      <strong>时间线</strong>
      <span class="mmc-line mmc-line--pin">置顶</span>
      <span class="mmc-line">未来</span>
      <span class="mmc-line">今天 · 昨天 · 前天</span>
      <span class="mmc-line mmc-line--muted">更早（展开加载）</span>
    </div>
    <div class="mmc-mode">
      <strong>自定义</strong>
      <span class="mmc-line mmc-line--pin">置顶 ↕</span>
      <span class="mmc-line">日常 ↕</span>
      <span class="mmc-line mmc-line--muted">两组分别排序</span>
    </div>
    <div class="mmc-mode">
      <strong>标签分组</strong>
      <span class="mmc-line"><i class="mmc-tag mmc-tag--blue"></i>工作</span>
      <span class="mmc-line"><i class="mmc-tag mmc-tag--green"></i>生活</span>
      <span class="mmc-line mmc-line--muted">未分类固定在最后</span>
    </div>
  </div>
</template>

<style scoped>
.mmc-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9rem;
  width: 100%;
}
.mmc-mode {
  display: flex;
  flex-direction: column;
  gap: 5rem;
  min-width: 0;
  padding: 10rem;
  border-radius: 11rem;
  background: var(--ui-surface-subtle);
}
.mmc-mode strong {
  margin-bottom: 2rem;
  font-size: calc(var(--fs-secondary) * 0.92);
  font-weight: 650;
}
.mmc-line {
  display: flex;
  align-items: center;
  gap: 5rem;
  min-height: 24rem;
  padding: 4rem 6rem;
  overflow: hidden;
  border-radius: 7rem;
  background: var(--ui-fill-passive);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.76);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mmc-line--pin {
  color: var(--text-color);
}
.mmc-line--muted {
  background: transparent;
}
.mmc-tag {
  width: 7rem;
  height: 7rem;
  flex-shrink: 0;
  border-radius: 50%;
}
.mmc-tag--blue {
  background: #0a84ff;
}
.mmc-tag--green {
  background: #30d158;
}
@container (max-width: 500px) {
  .mmc-grid {
    grid-template-columns: 1fr;
  }
}
</style>
