<script setup>
/**
 * HelpFigureBlock.vue — 图解式帮助的「子模块图解块」
 *
 * 职责：呈现「一张聚焦当前功能的局部界面 + 一段解释文字」。
 * 不依赖整机编号，用户可以直接按功能标题连续阅读。
 */
defineProps({
  /** 子模块标题。 */
  title: { type: String, required: true }
})
</script>

<template>
  <section class="help-figure">
    <div class="help-figure-visual">
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
  grid-template-columns: minmax(240rem, 0.9fr) minmax(0, 1.1fr);
  gap: 16rem;
  align-items: start;
  padding: 14rem;
  border-radius: 14rem;
  background: rgb(var(--bg-color) / 0.03);
}
.help-figure + .help-figure {
  margin-top: 10rem;
}

/* ---- 左：聚焦当前功能的局部界面 ---- */
.help-figure-visual {
  padding: 12rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 12rem;
  background: color-mix(in srgb, var(--text-color) 3%, transparent);
}
.help-figure-mock {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40rem;
  pointer-events: none;
  user-select: none;
  container-type: inline-size;
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
