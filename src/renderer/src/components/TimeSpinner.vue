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

// 直接（无动画）把某个 index 定位到双横线中间
function jumpToIndex(index) {
  cancelAnimationFrame(snapAnimId)
  const el = listRef.value
  const h = itemH()
  if (!el || !h) return
  isSnapping = true
  el.scrollTop = clampIndex(index) * h
  activeIndex.value = clampIndex(index)
  requestAnimationFrame(() => { isSnapping = false })
}

// ---- 吸附逻辑 ----
let snapTimer = null
let snapAnimId = null
let isSnapping = false   // true 时忽略 scroll 回调，避免动画/程序滚动被误判

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

  const index = clampIndex(Math.round(el.scrollTop / h))
  const target = index * h
  const distance = Math.abs(el.scrollTop - target)

  activeIndex.value = index

  // 距离极小，直接到位
  if (distance < 1) {
    el.scrollTop = target
    if (index !== props.modelValue) emit('update:modelValue', index)
    return
  }

  // RAF + easeOutCubic（200ms，比浏览器 smooth 快且可控）
  cancelAnimationFrame(snapAnimId)
  isSnapping = true

  const from = el.scrollTop
  let start = null
  function animate(ts) {
    if (!start) start = ts
    const t = Math.min((ts - start) / 200, 1)
    // easeOutCubic: 1 - (1 - t)^3
    el.scrollTop = from + (target - from) * (1 - Math.pow(1 - t, 3))
    if (t < 1) {
      snapAnimId = requestAnimationFrame(animate)
    } else {
      isSnapping = false
      if (index !== props.modelValue) emit('update:modelValue', index)
    }
  }
  snapAnimId = requestAnimationFrame(animate)
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
    <div ref="listRef" class="ts-list scroll-y" @scroll="onScroll">
      <div
        v-for="v in items"
        :key="v"
        class="ts-item"
        :class="{ 'is-act': v === activeIndex }"
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
  transition: color 120ms, font-weight 120ms;
}
.ts-item.is-act { color: var(--text-color); font-weight: 700; }
</style>
