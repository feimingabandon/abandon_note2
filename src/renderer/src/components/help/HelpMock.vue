<script setup>
/**
 * HelpMock.vue — 图解式帮助的「整机仿造舞台」
 *
 * 职责：把一个模块的完整界面仿造件（slot）框进一个只读、零交互的展示台，
 * 并在其上按百分比坐标叠加编号标注（①②③…），与下方 HelpFigureBlock 的编号一一对应。
 * 仿造件本身用纯 HTML/CSS 复刻真实外观，不含任何真实逻辑，故整台以 inert + pointer-events:none 隔离。
 */
defineProps({
  /** 舞台底部的说明文字（可选）。 */
  caption: { type: String, default: '' },
  /** 编号标注：[{ n, x, y }]，x/y 为相对舞台画布的百分比定位（0–100）。 */
  annotations: { type: Array, default: () => [] }
})
</script>

<template>
  <figure class="help-mock">
    <div class="help-mock-stage" inert aria-hidden="true">
      <div class="help-mock-canvas">
        <slot />
      </div>
      <span
        v-for="a in annotations"
        :key="a.n"
        class="help-mock-pin"
        :style="{ left: a.x + '%', top: a.y + '%' }"
        >{{ a.n }}</span
      >
    </div>
    <figcaption v-if="caption" class="help-mock-caption">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.help-mock {
  margin: 0 0 4rem;
}
.help-mock-stage {
  position: relative;
  padding: 14rem;
  border: 1px solid color-mix(in srgb, var(--text-color) 10%, transparent);
  border-radius: 16rem;
  background:
    linear-gradient(180deg, rgb(var(--bg-color) / 0.05), rgb(var(--bg-color) / 0.02)),
    color-mix(in srgb, var(--text-color) 3%, transparent);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04);
  overflow: hidden;
}
/* 仿造画布：整体只读，禁止一切指针/选择交互。 */
.help-mock-canvas {
  position: relative;
  pointer-events: none;
  user-select: none;
}
.help-mock-canvas :deep(*) {
  cursor: default !important;
}

/* ---- 编号标注圆点：叠加在仿造件之上，呼应真实截图的圈注 ---- */
.help-mock-pin {
  position: absolute;
  z-index: 5;
  display: grid;
  place-items: center;
  width: 20rem;
  height: 20rem;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: #ff453a;
  color: #fff;
  font-size: calc(var(--fs-secondary) * 0.86);
  font-weight: 700;
  line-height: 1;
  box-shadow:
    0 0 0 3rem rgb(255 69 58 / 0.22),
    0 2rem 6rem rgba(0, 0, 0, 0.28);
  pointer-events: none;
}

.help-mock-caption {
  margin-top: 8rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  text-align: center;
}
</style>
