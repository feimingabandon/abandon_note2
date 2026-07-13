<script setup>
/**
 * FilterTabs.vue — 工具栏筛选选项卡（特调组件）
 *
 * 职责：
 *   1. 横向展示筛选模式图标（标签 / 太极图 / 状态）
 *   2. 通过 modelValue + update:modelValue 由父组件控制选中逻辑
 *   3. 点击时播放各自的图标动画（太极/风扇旋转、标签弹跳）
 *
 * Props:
 *   modelValue  — 当前选中值
 *   options     — [{ value, label }] 选项数组（label 为 SVG 字符串）
 *
 * Emits:
 *   update:modelValue — 选中值变更
 */
import { ref, nextTick } from 'vue'

defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:modelValue'])

/** 当前正在播放点击动画的选项值 */
const animating = ref('')

async function onClick(value) {
  emit('update:modelValue', value)
  // 重启动画：先清除再置位，保证重复点击同一项也能触发
  animating.value = ''
  await nextTick()
  animating.value = value
}
</script>

<template>
  <div class="sg-root">
    <button
      v-for="opt in options"
      :key="opt.value"
      class="sg-btn"
      :class="[
        `sg-btn--${opt.value}`,
        { 'sg-btn--active': modelValue === opt.value, 'sg-btn--anim': animating === opt.value }
      ]"
      @click="onClick(opt.value)"
      @animationend="animating = ''"
      v-html="opt.label"
    ></button>
  </div>
</template>

<style scoped>
.sg-root {
  display: flex;
  align-items: center;
  gap: 0;
  background: transparent;
}

.sg-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 2rem 6rem;
  border: none;
  background: transparent;
  color: var(--text-color-secondary);
  opacity: 0.6;
  cursor: pointer;
  transition:
    color 150ms ease,
    opacity 150ms ease;
}

/* 图标随 rem 缩放（窗口变宽 → 图标变大）
   三个图标统一 viewBox=24 + stroke-width=2，同尺寸渲染保证像素线宽一致 */
.sg-btn :deep(svg) {
  display: block;
  width: 22rem;
  height: 22rem;
}

/* 选中态：纯文本色、不透明；背景与未选中一致（均无背景） */
.sg-btn--active {
  color: var(--text-color);
  opacity: 1;
}

/* ===== 点击动画 ===== */
/* 太极：非匀速旋转（缓入缓出，速度全程变化） */
.sg-btn--taiji.sg-btn--anim :deep(svg) {
  animation: sg-spin 640ms cubic-bezier(0.5, 0, 0.2, 1);
}
/* 风扇：非匀速旋转（略带回弹缓动） */
.sg-btn--status.sg-btn--anim :deep(svg) {
  animation: sg-spin 760ms cubic-bezier(0.34, 1.32, 0.64, 1);
}
/* 标签：弹跳缩放 + 轻微摆动 */
.sg-btn--tags.sg-btn--anim :deep(svg) {
  animation: sg-pop 440ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes sg-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
@keyframes sg-pop {
  0% {
    transform: scale(1) rotate(0);
  }
  30% {
    transform: scale(0.82) rotate(-10deg);
  }
  62% {
    transform: scale(1.18) rotate(8deg);
  }
  100% {
    transform: scale(1) rotate(0);
  }
}
</style>
