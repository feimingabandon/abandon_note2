<script setup>
/**
 * TimeSpinner.vue — 时间滚轮选择器（滚动吸附版）
 *
 * 核心规则：
 *  1. 双横线（indicator）正中央的那一项 = 当前选中值。
 *  2. 允许自由滚动（含惯性）；滚动停止后自动“吸附”到最近一项，
 *     使其精确落在双横线中间，并把该值 emit 出去。
 *  3. 滚动过程中实时高亮双横线内的项，选中态跟随双横线。
 *
 * 几何：itemHeight = .ts-item 实际高度；list 上下 padding = (视口高 - itemHeight)/2，
 *      因此 scrollTop = index × itemHeight 时，第 index 项恰好居中。
 */
import { ref, nextTick, watch, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  max: { type: Number, default: 24 },
  visible: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue'])

const listRef = ref(null)
const activeIndex = ref(props.modelValue)

const items = []
for (let i = 0; i < props.max; i++) items.push(i)

function pad(n) { return String(n).padStart(2, '0') }

// ---- 几何 ----
function itemH() {
  const el = listRef.value?.querySelector('.ts-item')
  return el ? el.getBoundingClientRect().height : 0
}

function setPadding() {
  const el = listRef.value
  if (!el) return
  const h = itemH()
  if (!h || !el.clientHeight) return
  const p = (el.clientHeight - h) / 2
  el.style.paddingTop = p + 'px'
  el.style.paddingBottom = p + 'px'
}

function clampIndex(i) {
  return Math.max(0, Math.min(props.max - 1, i))
}

// ---- 状态 ----
let snapTimer = null
let snapAnimId = null
let isSnapping = false     // true 时忽略 scroll 回调，避免动画/程序滚动被误判
let animTargetIndex = props.modelValue  // 当前动画/定位的目标项，供连续滚轮链式步进使用
let wheelAccum = 0         // 触控板细碎 delta 的累加器

// 滚轮参数
const WHEEL_NOTCH_MIN = 50   // |deltaY| >= 此值视为鼠标滚轮的一个离散刻度
const TRACKPAD_STEP = 40     // 触控板累加达到此像素量走一步

// 直接（无动画）把某个 index 定位到双横线中间
function jumpToIndex(index) {
  cancelAnimationFrame(snapAnimId)
  const el = listRef.value
  const h = itemH()
  if (!el || !h) return
  isSnapping = true
  const idx = clampIndex(index)
  el.scrollTop = idx * h
  activeIndex.value = idx
  animTargetIndex = idx
  requestAnimationFrame(() => { isSnapping = false })
}

// ---- 统一的平滑滚动到某项（滚轮步进 / 点击定位 / 吸附 共用）----
// RAF + easeOutCubic（200ms，比浏览器 smooth 快且可控）；动画中可被新目标打断重定向
function animateToIndex(index) {
  const el = listRef.value
  const h = itemH()
  if (!el || !h) return

  const target = clampIndex(index)
  animTargetIndex = target
  const targetTop = target * h
  const from = el.scrollTop

  cancelAnimationFrame(snapAnimId)

  // 距离极小，直接到位
  if (Math.abs(from - targetTop) < 1) {
    isSnapping = true
    el.scrollTop = targetTop
    activeIndex.value = target
    requestAnimationFrame(() => { isSnapping = false })
    if (target !== props.modelValue) emit('update:modelValue', target)
    return
  }

  isSnapping = true
  let start = null
  function animate(ts) {
    if (!start) start = ts
    const t = Math.min((ts - start) / 200, 1)
    // easeOutCubic: 1 - (1 - t)^3
    el.scrollTop = from + (targetTop - from) * (1 - Math.pow(1 - t, 3))
    activeIndex.value = clampIndex(Math.round(el.scrollTop / h))
    if (t < 1) {
      snapAnimId = requestAnimationFrame(animate)
    } else {
      el.scrollTop = targetTop
      activeIndex.value = target
      isSnapping = false
      if (target !== props.modelValue) emit('update:modelValue', target)
    }
  }
  snapAnimId = requestAnimationFrame(animate)
}

// ---- 滚轮：接管步进，保证每个值都可达 ----
function onWheel(e) {
  let delta = e.deltaY
  if (e.deltaMode === 1) delta *= 16              // 行模式换算为像素
  else if (e.deltaMode === 2) delta *= (listRef.value?.clientHeight || 100)  // 页模式
  if (!delta) return

  const base = isSnapping ? animTargetIndex : activeIndex.value
  let step = 0

  if (Math.abs(delta) >= WHEEL_NOTCH_MIN) {
    // 鼠标滚轮：一个刻度 = 精确移动 1 项（忽略系统给的步进大小）
    step = Math.sign(delta)
    wheelAccum = 0
  } else {
    // 触控板：细碎 delta 累加，超过阈值才走一步，避免一滑飞太快
    if (Math.sign(delta) !== Math.sign(wheelAccum)) wheelAccum = 0
    wheelAccum += delta
    if (Math.abs(wheelAccum) >= TRACKPAD_STEP) {
      step = Math.sign(wheelAccum)
      wheelAccum -= step * TRACKPAD_STEP
    }
  }

  if (step !== 0) animateToIndex(base + step)
}

// ---- 点击某项：平滑滚动到中间并选中 ----
function onItemClick(index) {
  animateToIndex(index)
}

function onScroll() {
  const el = listRef.value
  const h = itemH()
  if (!el || !h) return

  // 实时更新双横线内的高亮项
  activeIndex.value = clampIndex(Math.round(el.scrollTop / h))

  if (isSnapping) return

  clearTimeout(snapTimer)
  snapTimer = setTimeout(snap, 110)
}

function snap() {
  const el = listRef.value
  const h = itemH()
  if (!el || !h) return
  animateToIndex(clampIndex(Math.round(el.scrollTop / h)))
}

// ---- 面板显示时初始化定位 ----
watch(() => props.visible, (vis) => {
  if (vis) {
    nextTick(() => {
      setPadding()
      jumpToIndex(props.modelValue)
    })
  }
})

// ---- 外部值变化时跟随定位（吸附中不打断动画）----
watch(() => props.modelValue, (v) => {
  if (!props.visible) return
  if (isSnapping) return
  if (v === activeIndex.value) return
  jumpToIndex(v)
})

onBeforeUnmount(() => {
  clearTimeout(snapTimer)
  cancelAnimationFrame(snapAnimId)
})
</script>

<template>
  <div class="ts-wrapper">
    <div ref="listRef" class="ts-list scroll-y" @scroll="onScroll" @wheel.prevent="onWheel">
      <div
        v-for="v in items"
        :key="v"
        class="ts-item"
        :class="{ 'is-act': v === activeIndex }"
        @click="onItemClick(v)"
      >
        {{ pad(v) }}
      </div>
    </div>
    <div class="ts-indicator" />
  </div>
</template>

<style scoped>
.ts-wrapper { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.ts-list {
  height: 100%;
  box-sizing: border-box;
  -webkit-overflow-scrolling: touch;
}
.ts-list::-webkit-scrollbar { display: none; }
.ts-indicator {
  position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
  height: 36rem; border-top: 1px solid color-mix(in srgb, var(--text-color) 20%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--text-color) 20%, transparent);
  pointer-events: none;
}
.ts-item {
  height: 36rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-title);
  font-family: inherit;
  font-weight: 500;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition: color 120ms, font-weight 120ms;
}
.ts-item.is-act { color: var(--text-color); font-weight: 700; }
</style>
