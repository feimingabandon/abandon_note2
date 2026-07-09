<script setup>
/**
 * AppSlider.vue — 自定义进度条组件
 *
 * 长圆条 + 白色圆点，圆点直径 = 轨道高度，
 * 可配置 thumbSize / trackColor / bgColor，滑动跟手。
 *
 * Props:
 *   modelValue — 当前值（v-model）
 *   min / max  — 取值范围
 *   step       — 步长
 *   thumbSize  — 圆点直径（同时决定轨道高度，默认 20rem，与 AppToggle 对齐）
 *   trackColor — 已走过颜色（默认蓝）
 *   bgColor    — 未走过颜色
 *   disabled   — 是否禁用
 *
 * 宽度自动占满父容器（width: 100%），无需手动指定。
 *
 * Events:
 *   update:modelValue — v-model 双向绑定，拖动中实时触发
 *   change            — 滑动停止（pointerup）时触发一次，携带最终值
 */
import { computed, ref } from 'vue'

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  thumbSize: { type: Number, default: 14 },
  trackColor: { type: String, default: '#0071e3' },
  bgColor: { type: String, default: 'rgba(255, 255, 255, 0.12)' },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'change'])

const dragging = ref(false)
const trackRef = ref(null)

/** RAF 节流标记——确保每帧最多更新一次 */
let rafId = null
/** 暂存最新的 clientX，供 RAF 回调消费 */
let pendingClientX = null

/** 百分比进度 */
const progress = computed(() => {
  if (props.max <= props.min) return 0
  return (props.modelValue - props.min) / (props.max - props.min)
})

/**
 * 白色圆点位置：0 时圆点与左侧半圆帽重合（left=0），100 时与右侧半圆帽重合（left=100%-thumbSize）
 */
const thumbLeft = computed(() => `calc(${progress.value} * (100% - ${props.thumbSize}rem))`)

/**
 * 蓝色填充宽度：0 时归零；>0 时覆盖到圆点中心 + 半圆收尾
 * 用与 thumbLeft 相同的线性映射，再加半个圆点覆盖其左半
 */
const fillW = computed(() => {
  if (progress.value <= 0) return '0'
  return `calc(${progress.value} * (100% - ${props.thumbSize}rem) + ${props.thumbSize}rem)`
})

const cssVars = computed(() => ({
  '--s-h': props.thumbSize + 'rem',
  '--s-r': props.thumbSize / 2 + 'rem',
  '--s-track': props.trackColor,
  '--s-bg': props.bgColor
}))

/**
 * 根据 track 内像素坐标计算对应值（已步长对齐）。
 * 圆点中心对准点击位置：clickX → 值映射与 thumbLeft 同尺度，扣除半径偏移消除跳变。
 */
function posToValue(clientX) {
  if (!trackRef.value) return props.modelValue
  const rect = trackRef.value.getBoundingClientRect()
  // 圆点直径（轨道等高），px
  const thumbPx = trackRef.value.offsetHeight
  // 圆点活动范围 = 轨道宽 - 圆点直径
  const rangePx = rect.width - thumbPx
  if (rangePx <= 0) return props.modelValue
  // 圆点中心 x 坐标 → 圆点左边缘 x = clientX - rect.left - thumbPx/2
  const thumbLeftX = clientX - rect.left - thumbPx / 2
  const t = Math.max(0, Math.min(1, thumbLeftX / rangePx))
  const raw = props.min + t * (props.max - props.min)
  const snapped = Math.round(raw / props.step) * props.step
  return Math.min(props.max, Math.max(props.min, snapped))
}

/** RAF 节流消费：每帧最多执行一次更新 */
function flushUpdate() {
  rafId = null
  if (pendingClientX === null) return
  const val = posToValue(pendingClientX)
  pendingClientX = null
  emit('update:modelValue', val)
}

function onDown(e) {
  if (props.disabled) return
  e.preventDefault()
  dragging.value = true
  const val = posToValue(e.clientX)
  emit('update:modelValue', val)
  e.target.setPointerCapture(e.pointerId)
}

function onMove(e) {
  if (!dragging.value) return
  // RAF 节流：暂存最新坐标，同一帧内只处理一次
  pendingClientX = e.clientX
  if (rafId !== null) return
  rafId = requestAnimationFrame(flushUpdate)
}

function onUp() {
  // 取消待执行的 RAF 回调
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  // 消费最后一次未处理的坐标 → 触发 change 事件
  if (pendingClientX !== null) {
    const val = posToValue(pendingClientX)
    pendingClientX = null
    emit('update:modelValue', val)
    emit('change', val)
  } else if (dragging.value) {
    // 纯点击（无拖拽）：onDown 已通过 emit 更新了值，此处补发 change
    emit('change', props.modelValue)
  }
  dragging.value = false
}
</script>

<template>
  <div
    ref="trackRef"
    class="slider-root"
    :class="{ dragging, disabled }"
    :style="cssVars"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @lostpointercapture="onUp"
  >
    <!-- 轨道背景 -->
    <div class="slider-bg" />
    <!-- 蓝色填充 -->
    <div class="slider-fill" :style="{ width: fillW }" />
    <!-- 白色圆点 -->
    <div class="slider-thumb" :style="{ left: thumbLeft }" />
  </div>
</template>

<style scoped>
.slider-root {
  position: relative;
  width: 100%;
  height: var(--s-h);
  cursor: pointer;
  touch-action: none;
  flex-shrink: 0;
  overflow: hidden;
}
.slider-root.disabled {
  opacity: 0.35;
  pointer-events: none;
}

/* 轨道背景（长圆条） */
.slider-bg {
  position: absolute;
  inset: 0;
  border-radius: var(--s-r);
  background: var(--s-bg);
}

/* 蓝色填充 */
.slider-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: var(--s-h);
  border-radius: var(--s-r);
  background: var(--s-track);
  pointer-events: none;
}

/* 白色圆点 */
.slider-thumb {
  position: absolute;
  top: 0;
  width: var(--s-h);
  height: var(--s-h);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1rem 4rem rgba(0, 0, 0, 0.3);
  pointer-events: none;
}

/* 拖动中关闭过渡，保证跟手 */
.slider-root.dragging .slider-fill,
.slider-root.dragging .slider-thumb {
  transition: none;
}
.slider-root:not(.dragging) .slider-fill,
.slider-root:not(.dragging) .slider-thumb {
  transition:
    width 80ms ease,
    left 80ms ease;
}
</style>
