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
 *   options     — [{ value }] 选项数组
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
      type="button"
      class="sg-btn"
      :class="[
        `sg-btn--${opt.value}`,
        { 'sg-btn--active': modelValue === opt.value, 'sg-btn--anim': animating === opt.value }
      ]"
      :aria-label="opt.label"
      :aria-pressed="modelValue === opt.value"
      :title="opt.label"
      @click="onClick(opt.value)"
      @animationend="animating = ''"
    >
      <svg
        v-if="opt.value === 'tags'"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        shape-rendering="geometricPrecision"
        aria-hidden="true"
      >
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
      <svg
        v-else-if="opt.value === 'taiji'"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        shape-rendering="geometricPrecision"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a4.5 4.5 0 0 1 0 9 4.5 4.5 0 0 0 0 9" />
        <circle cx="12" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
      </svg>
      <svg
        v-else-if="opt.value === 'status'"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        shape-rendering="geometricPrecision"
        aria-hidden="true"
      >
        <path d="M12 12C8 9.5 8 3.5 12 3.5C16 3.5 16 9.5 12 12Z" />
        <path d="M12 12C8 9.5 8 3.5 12 3.5C16 3.5 16 9.5 12 12Z" transform="rotate(120 12 12)" />
        <path d="M12 12C8 9.5 8 3.5 12 3.5C16 3.5 16 9.5 12 12Z" transform="rotate(240 12 12)" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.sg-root {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 3rem 4rem;
  border-radius: 8rem;
  background: var(--ui-surface-subtle);
}

.sg-btn {
  appearance: none;
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
    background-color 150ms ease,
    color 150ms ease,
    opacity 150ms ease;
}

.sg-btn:hover:not(.sg-btn--active) {
  border-radius: 6rem;
  background: var(--ui-fill-hover);
  color: var(--text-color);
  opacity: 0.82;
}

/* 图标随 rem 缩放（窗口变宽 → 图标变大）
   三个图标统一 viewBox=24 + stroke-width=2，同尺寸渲染保证像素线宽一致 */
.sg-btn :deep(svg) {
  display: block;
  width: 22rem;
  height: 22rem;
}

/* 选中态只提高图标对比度；分组容器已负责材质层级，不再叠加灰色胶囊。 */
.sg-btn--active {
  color: var(--text-color);
  opacity: 1;
  background: transparent;
}

/* ===== 点击动画 ===== */
/* 太极：缓入缓出旋转（起步慢→中段快→终点稳，飞轮手感） */
.sg-btn--taiji.sg-btn--anim :deep(svg) {
  animation: sg-spin 720ms cubic-bezier(0.76, 0, 0.24, 1);
}
/* 三叶草：同为缓入缓出旋转，时长略长一点保留两者的细微差异 */
.sg-btn--status.sg-btn--anim :deep(svg) {
  animation: sg-spin 760ms cubic-bezier(0.76, 0, 0.24, 1);
}
/* 标签：弹跳缩放 + 轻微摆动 */
.sg-btn--tags.sg-btn--anim :deep(svg) {
  animation: sg-pop 300ms var(--ease-standard);
}

@keyframes sg-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    /* 1080deg（转三圈）与静止态 0deg 视觉等价，动画结束移除 transform 时不会跳帧。 */
    transform: rotate(1080deg);
  }
}
@keyframes sg-pop {
  0% {
    transform: scale(1) rotate(0);
  }
  30% {
    transform: scale(0.92) rotate(-4deg);
  }
  62% {
    transform: scale(1.04) rotate(3deg);
  }
  100% {
    transform: scale(1) rotate(0);
  }
}
</style>
