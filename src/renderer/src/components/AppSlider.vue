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
 *   thumbSize  — 圆点直径（同时决定轨道高度）
 *   width      — 轨道宽度
 *   trackColor — 已走过颜色（默认蓝）
 *   bgColor    — 未走过颜色
 *   disabled   — 是否禁用
 *
 * Events:
 *   update:modelValue — v-model 双向绑定，拖动中实时触发
 *   input             — 拖动中实时触发，与 update:modelValue 同步
 *   change            — 滑动停止（pointerup）时触发一次，携带最终值
 */
import { computed, ref } from 'vue'

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  thumbSize: { type: Number, default: 14 },
  width: { type: Number, default: 120 },
  trackColor: { type: String, default: '#0071e3' },
  bgColor: { type: String, default: 'rgba(255, 255, 255, 0.12)' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'input', 'change'])

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

/** 有效轨道长度（去掉圆点半圆占位），仅用于渲染 fillW */
const trackLength = computed(() => props.width - props.thumbSize)

/** 蓝色填充宽度：半圆起点 + 进度 × 有效长度 */
const fillW = computed(() => {
  return (props.thumbSize / 2) + progress.value * trackLength.value
})

const cssVars = computed(() => ({
  '--s-h': props.thumbSize + 'rem',
  '--s-w': props.width + 'rem',
  '--s-r': (props.thumbSize / 2) + 'rem',
  '--s-track': props.trackColor,
  '--s-bg': props.bgColor,
}))

/**
 * 根据 track 内像素坐标计算对应值（已步长对齐）。
 * 使用 rect.width 做像素级精确换算，避免 rem/px 单位混算。
 */
function posToValue(clientX) {
  if (!trackRef.value) return props.modelValue
  const rect = trackRef.value.getBoundingClientRect()
  // 将 rem 尺寸换算为像素：pxPerRem = 元素实际像素宽 / props.width(rem)
  const pxPerRem = rect.width / props.width
  const thumbHalfPx = (props.thumbSize / 2) * pxPerRem
  const trackLenPx = trackLength.value * pxPerRem

  let x = clientX - rect.left
  // 限制在轨道有效范围内（考虑圆点半边留白）
  x = Math.max(thumbHalfPx, Math.min(x, rect.width - thumbHalfPx))
  const t = (x - thumbHalfPx) / trackLenPx
  const raw = props.min + Math.max(0, Math.min(1, t)) * (props.max - props.min)
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
  emit('input', val)
}

function onDown(e) {
  if (props.disabled) return
  e.preventDefault()
  dragging.value = true
  const val = posToValue(e.clientX)
  emit('update:modelValue', val)
  emit('input', val)
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
    emit('input', val)
    emit('change', val)
  }
  dragging.value = false
}
</script>

<template>
  <div
    class="slider-root"
    :class="{ dragging, disabled }"
    :style="cssVars"
    ref="trackRef"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @lostpointercapture="onUp"
  >
    <!-- 轨道背景 -->
    <div class="slider-bg" />
    <!-- 蓝色填充 -->
    <div class="slider-fill" :style="{ width: fillW + 'rem' }" />
    <!-- 白色圆点 -->
    <div class="slider-thumb" :style="{ left: (fillW - props.thumbSize / 2) + 'rem' }" />
  </div>
</template>

<style scoped>
.slider-root {
  position: relative;
  width: var(--s-w);
  height: var(--s-h);
  cursor: pointer;
  touch-action: none;
  flex-shrink: 0;
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
  transition: width 80ms ease, left 80ms ease;
}
</style>
