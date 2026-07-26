<script setup>
/**
 * HelpFigureBlock.vue — 图解式帮助的「子模块图解块」
 *
 * 职责：呈现「一张局部小图 + 一段解释文字」。左侧是聚焦某个编号标注对应区域的局部仿造件（figure 插槽），
 * 配一枚与整机舞台一致的编号徽标；右侧是标题与解释文字（默认插槽）。
 * 编号 n 与上方 HelpMock 舞台上的标注一一对应，形成「整机图 → 逐条局部图」的阅读节奏。
 */
defineProps({
  /** 编号，与整机舞台标注对应。 */
  n: { type: [Number, String], required: true },
  /** 子模块标题。 */
  title: { type: String, required: true }
})
</script>

<template>
  <section class="help-figure">
    <div class="help-figure-visual">
      <span class="help-figure-badge">{{ n }}</span>
      <div class="help-figure-mock" inert aria-hidden="true">
        <slot name="figure" />
      </div>
    </div>
    <div class="help-figure-text">
      <h4 class="help-figure-title">{{ title }}</h4>
      <div class="help-figure-desc"><slot /></div>
    </div>
  </section>
</template>

<style scoped>
.help-figure {
  display: grid;
  grid-template-columns: 200rem minmax(0, 1fr);
  gap: 16rem;
  align-items: start;
  padding: 14rem;
  border-radius: 14rem;
  background: rgb(var(--bg-color) / 0.03);
}
.help-figure + .help-figure {
  margin-top: 10rem;
}

/* ---- 左：局部小图 + 编号徽标 ---- */
.help-figure-visual {
  position: relative;
  padding: 12rem;
  border: 1px solid color-mix(in srgb, var(--text-color) 8%, transparent);
  border-radius: 12rem;
  background: color-mix(in srgb, var(--text-color) 3%, transparent);
}
.help-figure-badge {
  position: absolute;
  z-index: 2;
  top: -8rem;
  left: -8rem;
  display: grid;
  place-items: center;
  width: 20rem;
  height: 20rem;
  border-radius: 50%;
  background: #ff453a;
  color: #fff;
  font-size: calc(var(--fs-secondary) * 0.86);
  font-weight: 700;
  line-height: 1;
  box-shadow: 0 2rem 6rem rgba(0, 0, 0, 0.24);
}
.help-figure-mock {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40rem;
  pointer-events: none;
  user-select: none;
}
.help-figure-mock :deep(*) {
  cursor: default !important;
}

/* ---- 右：标题 + 解释 ---- */
.help-figure-text {
  min-width: 0;
  padding-top: 2rem;
}
.help-figure-title {
  margin: 0 0 6rem;
  font-size: var(--fs-body);
  font-weight: 600;
}
.help-figure-desc {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.7;
}
.help-figure-desc :deep(strong) {
  color: var(--text-color);
  font-weight: 600;
}
.help-figure-desc :deep(code) {
  padding: 1rem 5rem;
  border-radius: 5rem;
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  font-family: var(--font-family-mono, monospace);
  font-size: 0.92em;
}
.help-figure-desc :deep(p) {
  margin: 0 0 6rem;
}
.help-figure-desc :deep(p:last-child) {
  margin-bottom: 0;
}

/* 窄屏（内容区被压窄）时上下堆叠，局部图整宽显示。 */
@container (max-width: 460px) {
  .help-figure {
    grid-template-columns: 1fr;
  }
}
</style>
