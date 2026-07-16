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
  bgColor: {
    type: String,
    default: 'color-mix(in srgb, var(--text-color) 14%, transparent)'
  },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'change'])

const dragging = ref(false)
const trackRef = ref(null)
const thumbRef = ref(null)

/** RAF 节流标记——确保每帧最多更新一次 */
let rafId = null
/** 暂存最新的 clientX，供 RAF 回调消费 */
let pendingClientX = null

/** 百分比进度 */
const progress = computed(() => {
  if (props.max <= props.min) return 0
  return Math.max(0, Math.min(1, (props.modelValue - props.min) / (props.max - props.min)))
})

/**
 * 白色圆点位置：0 时圆点与左侧半圆帽重合（left=0），100 时与右侧半圆帽重合（left=100%-thumbSize）
 */
const thumbLeft = computed(() => `calc(${progress.value} * (100% - ${props.thumbSize}rem))`)

/** 渐变分界必须与圆点中心使用同一坐标系，避免高进度时颜色越过圆点。 */
const fillPosition = computed(() => {
  if (progress.value <= 0) return '0%'
  if (progress.value >= 1) return '100%'
  // p * (轨道宽 - 圆点宽) + 圆点半径
  return `calc(${progress.value * 100}% + ${(0.5 - progress.value) * props.thumbSize}rem)`
})

const cssVars = computed(() => ({
  '--s-h': props.thumbSize + 'rem',
  '--s-r': props.thumbSize / 2 + 'rem',
  '--s-track': props.trackColor,
  '--s-bg': props.bgColor,
  '--s-fill': fillPosition.value
}))

/**
 * 根据 track 内像素坐标计算对应值（已步长对齐）。
 * 圆点中心对准点击位置：clickX → 值映射与 thumbLeft 同尺度，扣除半径偏移消除跳变。
 */
function posToValue(clientX) {
  if (!trackRef.value || !thumbRef.value) return props.modelValue
  const rect = trackRef.value.getBoundingClientRect()
  const thumbPx = thumbRef.value.getBoundingClientRect().width
  // 圆点活动范围 = 轨道宽 - 圆点直径
  const rangePx = rect.width - thumbPx
  if (rangePx <= 0) return props.modelValue
  // 圆点中心 x 坐标 → 圆点左边缘 x = clientX - rect.left - thumbPx/2
  const thumbLeftX = clientX - rect.left - thumbPx / 2
  const t = Math.max(0, Math.min(1, thumbLeftX / rangePx))
  const raw = props.min + t * (props.max - props.min)
  const snapped = props.min + Math.round((raw - props.min) / props.step) * props.step
  const clamped = Math.min(props.max, Math.max(props.min, snapped))
  // 消除 0.1 步长产生的 1.799999999 等浮点尾数。
  return Number(clamped.toFixed(10))
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
  e.currentTarget.focus({ preventScroll: true })
  e.preventDefault()
  dragging.value = true
  const val = posToValue(e.clientX)
  emit('update:modelValue', val)
  e.currentTarget.setPointerCapture(e.pointerId)
}

function onMove(e) {
  if (!dragging.value) return
  // RAF 节流：暂存最新坐标，同一帧内只处理一次
  pendingClientX = e.clientX
  if (rafId !== null) return
  rafId = requestAnimationFrame(flushUpdate)
}

function onUp(e) {
  if (!dragging.value) return
  // 取消待执行的 RAF 回调
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  // pointerup 坐标是最终权威值，避免最后一帧尚未进入 pointermove。
  const finalX = Number.isFinite(e?.clientX) ? e.clientX : pendingClientX
  const val = finalX === null ? props.modelValue : posToValue(finalX)
  pendingClientX = null
  emit('update:modelValue', val)
  emit('change', val)
  dragging.value = false
}

function onKeydown(e) {
  if (props.disabled) return
  let value = props.modelValue
  if (e.key === 'Home') value = props.min
  else if (e.key === 'End') value = props.max
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') value -= props.step
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') value += props.step
  else return

  e.preventDefault()
  value = Number(Math.min(props.max, Math.max(props.min, value)).toFixed(10))
  emit('update:modelValue', value)
  emit('change', value)
}
</script>

<template>
  <div
    ref="trackRef"
    class="slider-root"
    :class="{ dragging, disabled }"
    :style="cssVars"
    role="slider"
    :tabindex="disabled ? -1 : 0"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="modelValue"
    :aria-disabled="disabled"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @lostpointercapture="onUp"
    @pointercancel="onUp"
    @keydown="onKeydown"
  >
    <!-- 单一完整轨道：硬分界渐变表示进度，不缩放圆角矩形。 -->
    <div class="slider-bg" />
    <!-- 白色圆点 -->
    <div ref="thumbRef" class="slider-thumb" :style="{ left: thumbLeft }" />
  </div>
</template>

<style scoped>
@property --s-fill {
  syntax: '<length-percentage>';
  inherits: true;
  initial-value: 0%;
}

.slider-root {
  position: relative;
  width: 100%;
  height: max(var(--s-h), 22rem);
  cursor: pointer;
  touch-action: none;
  flex-shrink: 0;
  overflow: visible;
  outline: none;
}
.slider-root:focus-visible {
  filter: drop-shadow(0 0 2rem color-mix(in srgb, var(--s-track) 70%, transparent));
}
.slider-root.disabled {
  opacity: 0.35;
  pointer-events: none;
}

/* 轨道背景（长圆条） */
.slider-bg {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: var(--s-h);
  transform: translateY(-50%);
  border-radius: var(--s-r);
  background: linear-gradient(
    to right,
    var(--s-track) 0 var(--s-fill),
    var(--s-bg) var(--s-fill) 100%
  );
  pointer-events: none;
}

/* 白色圆点 */
.slider-thumb {
  position: absolute;
  top: 50%;
  width: var(--s-h);
  height: var(--s-h);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1rem 4rem rgba(0, 0, 0, 0.3);
  transform: translateY(-50%);
  pointer-events: none;
}

/* 拖动中关闭过渡，保证跟手 */
.slider-root.dragging .slider-thumb {
  transition: none;
}
.slider-root:not(.dragging) {
  transition: --s-fill 80ms ease;
}
.slider-root:not(.dragging) .slider-thumb {
  transition: left 80ms ease;
}
</style>
