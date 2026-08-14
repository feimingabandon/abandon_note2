<template>
  <div class="mcd-panel">
    <header class="mcd-header">
      <button aria-label="收起">‹</button>
      <div><strong>8月14日</strong><span>周五 · 农历廿一</span></div>
      <button aria-label="新建">＋</button>
    </header>
    <div class="mcd-weather">
      <span>多云</span><strong>29° / 32°</strong><small>降水概率 20%</small>
    </div>
    <div class="mcd-notes">
      <article>
        <i class="is-progress"></i>
        <div><strong>下午 3 点确认交互稿</strong><small>进行中 · 今天 15:00</small></div>
      </article>
      <article>
        <i class="is-complete">✓</i>
        <div><strong>整理本周报销单</strong><small>已完成 · 今天 10:30</small></div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.mcd-panel {
  display: flex;
  flex-direction: column;
  gap: 10rem;
  width: min(100%, 320rem);
  padding: 12rem;
  border-right: 1px solid var(--ui-border-divider);
  background: var(--ui-surface-subtle);
}
.mcd-header {
  display: grid;
  grid-template-columns: 28rem minmax(0, 1fr) 28rem;
  align-items: center;
  gap: 7rem;
}
.mcd-header button {
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
  font-size: 19rem;
}
.mcd-header div {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.mcd-header strong {
  font-size: var(--fs-secondary);
}
.mcd-header span,
.mcd-weather small,
.mcd-notes small {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.7);
}
.mcd-weather {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 3rem 8rem;
  padding: 9rem;
  border-radius: 9rem;
  background: var(--ui-fill-passive);
  font-size: calc(var(--fs-secondary) * 0.82);
}
.mcd-weather small {
  grid-column: 1 / -1;
}
.mcd-notes {
  display: flex;
  flex-direction: column;
  gap: 7rem;
}
.mcd-notes article {
  display: flex;
  align-items: flex-start;
  gap: 8rem;
  padding: 9rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 9rem;
}
.mcd-notes article > i {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 16rem;
  height: 16rem;
  border: 2px solid #ff9f0a;
  border-radius: 50%;
  color: #fff;
  font-style: normal;
  font-size: 9rem;
}
.mcd-notes article > i.is-complete {
  border-color: #30d158;
  background: #30d158;
}
.mcd-notes article div {
  display: flex;
  flex-direction: column;
  gap: 4rem;
  min-width: 0;
}
.mcd-notes article strong {
  overflow: hidden;
  font-size: calc(var(--fs-secondary) * 0.82);
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
