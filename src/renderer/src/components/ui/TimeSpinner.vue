<script setup>
/**
 * TimeSpinner.vue — 以选择框中心为唯一判定基准的时间滚轮。
 *
 * 用户输入交给浏览器原生滚动；滚动过程中只读取 scrollTop 并投影出高亮项。
 * 点击、键盘、外部值同步和滚动收口共用同一个可取消对齐器。
 * modelValue 只在某一项精确进入中心后提交。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  max: { type: Number, default: 24 },
  visible: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue'])
const instanceId = useId()

const listRef = ref(null)
const activeIndex = ref(0)
const spacerHeight = ref(0)
const ready = ref(false)

const itemCount = computed(() => Math.max(0, Math.trunc(Number(props.max) || 0)))
const items = computed(() => Array.from({ length: itemCount.value }, (_, index) => index))
const spacerStyle = computed(() => ({ height: `${spacerHeight.value}px` }))

const ALIGN_EPSILON = 0.25
const FALLBACK_SETTLE_DELAY = 150
const MIN_ALIGN_DURATION = 180
const MAX_ALIGN_DURATION = 260
const WHEEL_PIXEL_STEP = 28
const WHEEL_RESET_DELAY = 140

let itemElements = []
let targetTops = []
let resizeObserver = null
let scrollFrame = null
let animationFrame = null
let settleTimer = null
let wheelResetTimer = null
let resizeFrame = null
let measureGeneration = 0
let animationGeneration = 0
let alignmentTargetIndex = null
let wheelAccumulator = 0
let initializing = false
let phase = 'idle'
let supportsScrollEnd = true

function pad(value) {
  return String(value).padStart(2, '0')
}

function clampIndex(index) {
  const last = itemCount.value - 1
  if (last < 0) return 0
  return Math.max(0, Math.min(last, Math.round(Number(index) || 0)))
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

function cancelSettleTimer() {
  if (settleTimer !== null) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
}

function cancelAlignment(nextPhase = 'idle') {
  animationGeneration += 1
  if (animationFrame !== null) {
    cancelAnimationFrame(animationFrame)
    animationFrame = null
  }
  alignmentTargetIndex = null
  if (phase === 'aligning') phase = nextPhase
}

function nearestIndex(scrollTop = listRef.value?.scrollTop ?? 0) {
  if (!targetTops.length) return clampIndex(props.modelValue)

  let low = 0
  let high = targetTops.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (targetTops[middle] < scrollTop) low = middle + 1
    else high = middle
  }

  if (low === 0) return 0
  const before = low - 1
  return scrollTop - targetTops[before] <= targetTops[low] - scrollTop ? before : low
}

function updateActiveFromGeometry() {
  if (!ready.value || initializing) return
  activeIndex.value = nearestIndex()
}

function queueActiveUpdate() {
  if (scrollFrame !== null) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null
    updateActiveFromGeometry()
  })
}

function commit(index) {
  const value = clampIndex(index)
  activeIndex.value = value
  if (value !== props.modelValue) emit('update:modelValue', value)
}

function buildGeometry() {
  const el = listRef.value
  itemElements = el ? Array.from(el.querySelectorAll('.ts-item')) : []
  if (!el || !itemElements.length || !el.clientHeight) {
    targetTops = []
    return false
  }

  const listRect = el.getBoundingClientRect()
  const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
  targetTops = itemElements.map((item) => {
    const rect = item.getBoundingClientRect()
    const contentCenter = el.scrollTop + (rect.top - listRect.top) + rect.height / 2
    return Math.max(0, Math.min(maxScrollTop, contentCenter - el.clientHeight / 2))
  })
  return targetTops.length === itemCount.value
}

function easeOutCubic(progress) {
  return 1 - Math.pow(1 - progress, 3)
}

function alignDuration(distance) {
  const rowDistance = targetTops.length > 1 ? Math.abs(targetTops[1] - targetTops[0]) : 1
  const rows = Math.abs(distance) / Math.max(1, rowDistance)
  return Math.min(MAX_ALIGN_DURATION, MIN_ALIGN_DURATION + rows * 14)
}

function alignTo(index, { animate = true, commitValue = true } = {}) {
  const el = listRef.value
  const targetIndex = clampIndex(index)
  const targetTop = targetTops[targetIndex]
  if (!el || !ready.value || initializing || !Number.isFinite(targetTop)) return

  cancelSettleTimer()
  cancelAlignment()

  const startTop = el.scrollTop
  const distance = targetTop - startTop

  if (!animate || Math.abs(distance) <= ALIGN_EPSILON) {
    el.scrollTop = targetTop
    phase = 'idle'
    if (commitValue) commit(targetIndex)
    else activeIndex.value = targetIndex
    return
  }

  phase = 'aligning'
  alignmentTargetIndex = targetIndex
  const generation = ++animationGeneration
  const duration = alignDuration(distance)
  let startedAt = null

  const step = (now) => {
    if (generation !== animationGeneration || !listRef.value) return
    if (startedAt === null) startedAt = now

    const progress = Math.min(1, (now - startedAt) / duration)
    el.scrollTop = startTop + distance * easeOutCubic(progress)
    queueActiveUpdate()

    if (progress < 1) {
      animationFrame = requestAnimationFrame(step)
      return
    }

    animationFrame = null
    el.scrollTop = targetTop
    alignmentTargetIndex = null
    phase = 'idle'
    if (commitValue) commit(targetIndex)
    else activeIndex.value = targetIndex
  }

  animationFrame = requestAnimationFrame(step)
}

function settleAtNearest() {
  if (!ready.value || initializing || phase === 'aligning') return
  cancelSettleTimer()
  alignTo(nearestIndex())
}

function scheduleFallbackSettle() {
  if (supportsScrollEnd) return
  cancelSettleTimer()
  settleTimer = setTimeout(settleAtNearest, FALLBACK_SETTLE_DELAY)
}

function onScroll() {
  if (!ready.value || initializing) return
  queueActiveUpdate()
  if (phase !== 'aligning') {
    phase = 'user-scrolling'
    scheduleFallbackSettle()
  }
}

function onScrollEnd() {
  if (!ready.value || initializing || phase === 'aligning') return
  settleAtNearest()
}

function onUserIntent() {
  if (!ready.value || initializing) return
  listRef.value?.focus({ preventScroll: true })
  cancelAlignment('user-scrolling')
  phase = 'user-scrolling'
}

/**
 * 鼠标滚轮使用离散步进，触控板的小 delta 则累积成步进。
 * 所有步进仍进入统一对齐器，因此连续滚动会从上一个目标继续，
 * 不会在每次 scrollend 时被吸回原值。
 */
function onWheel(event) {
  if (!ready.value || initializing || itemCount.value <= 1) return
  event.preventDefault()
  listRef.value?.focus({ preventScroll: true })

  let delta = event.deltaY
  if (event.deltaMode === 1) delta *= 16
  else if (event.deltaMode === 2) delta *= listRef.value?.clientHeight || 100
  if (!delta) return

  if (Math.sign(delta) !== Math.sign(wheelAccumulator)) wheelAccumulator = 0
  if (wheelResetTimer !== null) clearTimeout(wheelResetTimer)
  wheelResetTimer = setTimeout(() => {
    wheelAccumulator = 0
    wheelResetTimer = null
  }, WHEEL_RESET_DELAY)

  let steps = 0
  if (event.deltaMode !== 0 || Math.abs(delta) >= 50) {
    steps = Math.sign(delta)
    wheelAccumulator = 0
  } else {
    wheelAccumulator += delta
    steps = Math.trunc(wheelAccumulator / WHEEL_PIXEL_STEP)
    if (steps) wheelAccumulator -= steps * WHEEL_PIXEL_STEP
  }
  if (!steps) return

  const limitedSteps = Math.sign(steps) * Math.min(3, Math.abs(steps))
  const base = alignmentTargetIndex ?? nearestIndex()
  alignTo(base + limitedSteps)
}

function onItemClick(index) {
  alignTo(index)
}

function onKeydown(event) {
  let target = activeIndex.value
  if (event.key === 'ArrowUp') target -= 1
  else if (event.key === 'ArrowDown') target += 1
  else if (event.key === 'PageUp') target -= 5
  else if (event.key === 'PageDown') target += 5
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = itemCount.value - 1
  else return

  event.preventDefault()
  alignTo(target)
}

async function measureAndAlign() {
  const generation = ++measureGeneration
  cancelSettleTimer()
  cancelAlignment()
  initializing = true
  ready.value = false

  await nextTick()
  await nextFrame()
  if (generation !== measureGeneration || !props.visible) return

  const el = listRef.value
  const firstItem = el?.querySelector('.ts-item')
  if (!el || !firstItem || !el.clientHeight) {
    initializing = false
    return
  }

  const rowHeight = firstItem.getBoundingClientRect().height
  if (!rowHeight) {
    initializing = false
    return
  }

  spacerHeight.value = Math.max(0, (el.clientHeight - rowHeight) / 2)
  await nextTick()
  await nextFrame()
  if (generation !== measureGeneration || !props.visible) return

  if (!buildGeometry()) {
    initializing = false
    return
  }

  const target = clampIndex(props.modelValue)
  el.scrollTop = targetTops[target]
  activeIndex.value = target
  phase = 'idle'
  initializing = false
  ready.value = true
}

function scheduleMeasure() {
  if (!props.visible) return
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null
    measureAndAlign()
  })
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) scheduleMeasure()
    else {
      measureGeneration += 1
      ready.value = false
      initializing = false
      cancelSettleTimer()
      cancelAlignment()
    }
  },
  { immediate: true, flush: 'post' }
)

watch(
  () => props.modelValue,
  (value) => {
    if (!props.visible || !ready.value || initializing) return
    const target = clampIndex(value)
    const targetTop = targetTops[target]
    const el = listRef.value
    if (!el || !Number.isFinite(targetTop)) return
    if (target !== activeIndex.value || Math.abs(el.scrollTop - targetTop) > ALIGN_EPSILON) {
      alignTo(target, { commitValue: false })
    }
  }
)

watch(itemCount, () => {
  if (props.visible) scheduleMeasure()
})

onMounted(() => {
  const el = listRef.value
  supportsScrollEnd = !!el && 'onscrollend' in el
  resizeObserver = new ResizeObserver(scheduleMeasure)
  if (el) resizeObserver.observe(el)
  if (props.visible) scheduleMeasure()
})

onBeforeUnmount(() => {
  measureGeneration += 1
  resizeObserver?.disconnect()
  cancelSettleTimer()
  if (wheelResetTimer !== null) clearTimeout(wheelResetTimer)
  cancelAlignment()
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
})
</script>

<template>
  <div class="ts-wrapper">
    <div
      ref="listRef"
      class="ts-list scroll-y"
      :class="{ 'is-ready': ready }"
      tabindex="0"
      role="listbox"
      :aria-activedescendant="`${instanceId}-time-option-${activeIndex}`"
      @scroll="onScroll"
      @scrollend="onScrollEnd"
      data-scroll-mode="self"
      @wheel.stop="onWheel"
      @pointerdown="onUserIntent"
      @touchstart="onUserIntent"
      @keydown="onKeydown"
    >
      <div class="ts-spacer" :style="spacerStyle" aria-hidden="true" />
      <div
        v-for="value in items"
        :id="`${instanceId}-time-option-${value}`"
        :key="value"
        class="ts-item"
        :class="{ 'is-act': value === activeIndex }"
        role="option"
        :aria-selected="value === activeIndex"
        @click="onItemClick(value)"
      >
        {{ pad(value) }}
      </div>
      <div class="ts-spacer" :style="spacerStyle" aria-hidden="true" />
    </div>
    <div class="ts-indicator" aria-hidden="true" />
  </div>
</template>

<style scoped>
.ts-wrapper {
  --ts-row-height: 36rem;
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 24%, black 76%, transparent);
  mask-image: linear-gradient(to bottom, transparent, black 24%, black 76%, transparent);
}
.ts-list {
  height: 100%;
  overscroll-behavior: contain;
  touch-action: pan-y;
  scrollbar-width: none;
  outline: none;
  opacity: 0;
  transition: opacity var(--motion-fast) ease;
}
.ts-list.is-ready {
  opacity: 1;
}
.ts-list::-webkit-scrollbar {
  display: none;
}
.ts-spacer {
  width: 100%;
  min-height: 0;
  pointer-events: none;
}
.ts-indicator {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: var(--ts-row-height);
  border-top: 1px solid color-mix(in srgb, var(--text-color) 20%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--text-color) 20%, transparent);
  transform: translateY(-50%);
  pointer-events: none;
}
.ts-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: var(--ts-row-height);
  color: var(--text-color-secondary);
  font-family: inherit;
  font-size: var(--fs-title);
  font-weight: 500;
  opacity: 0.5;
  cursor: pointer;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}
.ts-item.is-act {
  color: var(--text-color);
  opacity: 1;
  transform: scale(1.045);
}
.ts-list:focus-visible + .ts-indicator {
  border-color: color-mix(in srgb, #0071e3 54%, transparent);
}
</style>
