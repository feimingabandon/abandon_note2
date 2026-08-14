<template>
  <div class="mdf-flow">
    <div class="mdf-step">
      <div class="mdf-screen"><span class="mdf-window"></span></div>
      <strong>拖到启用边缘</strong>
    </div>
    <span class="mdf-arrow">→</span>
    <div class="mdf-step">
      <div class="mdf-screen"><span class="mdf-hidden"></span></div>
      <strong>窗口自动收起</strong>
    </div>
    <span class="mdf-arrow">→</span>
    <div class="mdf-step">
      <div class="mdf-screen"><span class="mdf-handle"></span></div>
      <strong>触边或点击小黑条</strong>
    </div>
  </div>
</template>

<style scoped>
.mdf-flow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 8rem;
  width: 100%;
}
.mdf-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7rem;
  min-width: 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
  text-align: center;
}
.mdf-screen {
  position: relative;
  width: 100%;
  height: 66rem;
  overflow: hidden;
  border: 1px solid var(--ui-border-control);
  border-radius: 9rem;
  background: var(--ui-surface-subtle);
}
.mdf-window,
.mdf-hidden {
  position: absolute;
  top: 10rem;
  right: 0;
  width: 55%;
  height: 46rem;
  border-radius: 7rem 0 0 7rem;
  background: var(--ui-accent-subtle);
  box-shadow: inset 0 0 0 1px var(--ui-border-control);
}
.mdf-hidden {
  right: -49%;
}
.mdf-handle {
  position: absolute;
  top: 16rem;
  right: 0;
  width: 6rem;
  height: 34rem;
  border-radius: 4rem 0 0 4rem;
  background: color-mix(in srgb, var(--text-color) 84%, transparent);
}
.mdf-arrow {
  color: var(--text-color-secondary);
}
@container (max-width: 500px) {
  .mdf-flow {
    grid-template-columns: 1fr;
  }
  .mdf-arrow {
    transform: rotate(90deg);
    text-align: center;
  }
}
</style>
