<script setup>
import { ref, reactive, nextTick, onMounted, onBeforeUnmount } from 'vue'

/**
 * HelpButton.vue — 问号帮助按钮 + 玻璃态 tooltip
 *
 * 触发：点击切换
 * 定位：Teleport 到 body → position:fixed → 视口 clamp
 * 方向优先级：下 → 上 → 右 → 左（自动 flip）
 */
defineProps({
  text: { type: String, required: true }
})

const visible = ref(false)
const placement = ref('bottom')
const tipStyle = reactive({ top: '0px', left: '0px' })
const triggerRef = ref(null)
const tipRef = ref(null)

const GAP = 8
const PAD = 4 // 视口安全边距

// ---- 方向优先级 ----
const DIRS = ['bottom', 'top', 'right', 'left']

// ---- 视口 clamp ----
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

function clampPos(left, top, tipW, tipH) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return {
    left: clamp(left, PAD, vw - tipW - PAD),
    top:  clamp(top,  PAD, vh - tipH - PAD)
  }
}

// ---- 计算某方向的原始坐标 ----
function rawPos(triggerRect, tipW, tipH, dir) {
  const cx = triggerRect.left + triggerRect.width / 2
  const cy = triggerRect.top + triggerRect.height / 2
  switch (dir) {
    case 'bottom': return { left: cx - tipW / 2, top: triggerRect.bottom + GAP }
    case 'right':  return { left: triggerRect.right + GAP, top: cy - tipH / 2 }
    case 'top':    return { left: cx - tipW / 2, top: triggerRect.top - tipH - GAP }
    case 'left':   return { left: triggerRect.left - tipW - GAP, top: cy - tipH / 2 }
  }
}

// ---- 检查 clamp 后是否还有足够空间（至少 50% 可见） ----
function hasEnoughSpace(clampedLeft, clampedTop, tipW, tipH) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const minVisible = 0.5
  const visibleW = clamp(clampedLeft + tipW, 0, vw) - clamp(clampedLeft, 0, vw)
  const visibleH = clamp(clampedTop + tipH, 0, vh) - clamp(clampedTop, 0, vh)
  return visibleW >= tipW * minVisible && visibleH >= tipH * minVisible
}

// ---- 主逻辑：选方向 + 算坐标 ----
function pickPosition(triggerRect, tipW, tipH) {
  for (const dir of DIRS) {
    const raw = rawPos(triggerRect, tipW, tipH, dir)
    const pos = clampPos(raw.left, raw.top, tipW, tipH)
    if (hasEnoughSpace(pos.left, pos.top, tipW, tipH)) {
      return { dir, ...pos }
    }
  }
  // 全部不够 → 取第一个方向强 clamp
  const raw = rawPos(triggerRect, tipW, tipH, DIRS[0])
  const pos = clampPos(raw.left, raw.top, tipW, tipH)
  return { dir: DIRS[0], ...pos }
}

// ---- 点击切换 ----
async function onClick(e) {
  e.stopPropagation()
  if (visible.value) {
    visible.value = false
    return
  }
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  // 先用预估尺寸选方向
  let result = pickPosition(rect, 280, 36)
  placement.value = result.dir
  tipStyle.top  = '-9999px'
  tipStyle.left = '-9999px'
  visible.value = true

  await nextTick()
  if (!tipRef.value) return
  const tw = tipRef.value.offsetWidth
  const th = tipRef.value.offsetHeight
  result = pickPosition(rect, tw, th)
  placement.value = result.dir
  tipStyle.top  = result.top + 'px'
  tipStyle.left = result.left + 'px'
}

// ---- 点击外部关闭 ----
function onDocClick(e) {
  if (!visible.value) return
  // 点击 tooltip 本身不关
  if (tipRef.value && tipRef.value.contains(e.target)) return
  // 点击触发按钮不关（onClick 已处理 toggle）
  if (triggerRef.value && triggerRef.value.contains(e.target)) return
  visible.value = false
}

onMounted(() => document.addEventListener('click', onDocClick, true))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick, true))
</script>

<template>
  <span ref="triggerRef" class="help-btn-wrap" @click="onClick">
    <span class="setting-help-btn" aria-label="帮助">?</span>
  </span>
  <Teleport to="body">
    <Transition name="tooltip-fade">
      <span
        v-if="visible"
        ref="tipRef"
        class="help-tooltip"
        :class="'help-tooltip--' + placement"
        :style="{ top: tipStyle.top, left: tipStyle.left }"
      >{{ text }}</span>
    </Transition>
  </Teleport>
</template>

<style>
.help-btn-wrap {
  display: inline-flex;
  line-height: 1;
}

/* ---- 问号按钮 ---- */
.setting-help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16rem;
  height: 16rem;
  border: none;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.12);
  color: var(--text-color-secondary, #999);
  font-size: 10rem;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  flex-shrink: 0;
  line-height: 1;
  padding: 0;
  transition: background 150ms ease, color 150ms ease;
}
.setting-help-btn:hover {
  background: rgba(128, 128, 128, 0.25);
  color: var(--text-color, #333);
}

/* ---- tooltip ---- */
.help-tooltip {
  position: fixed;
  z-index: 9999;
  max-width: 280rem;
  padding: 7rem 12rem;
  white-space: normal;
  line-height: 1.45;
  pointer-events: none;

  font-size: var(--fs-secondary);
  font-weight: 500;
  color: var(--text-color-secondary);

  background-color: rgb(var(--bg-color) / var(--popup-opacity));
  -webkit-backdrop-filter: blur(var(--bg-blur)) saturate(var(--bg-saturation));
  backdrop-filter: blur(var(--bg-blur)) saturate(var(--bg-saturation));
  border: calc(var(--bg-border) * 1px) solid rgba(255, 255, 255, 0.18);
  border-radius: 8rem;
  box-shadow: 0 2rem 12rem rgba(0, 0, 0, 0.15);
}

/* ---- 箭头 ---- */
.help-tooltip::after {
  content: '';
  position: absolute;
  border: 5rem solid transparent;
}
.help-tooltip--bottom::after {
  bottom: 100%; left: 50%; transform: translateX(-50%);
  border-bottom-color: rgb(var(--bg-color) / var(--popup-opacity));
}
.help-tooltip--right::after {
  right: 100%; top: 50%; transform: translateY(-50%);
  border-right-color: rgb(var(--bg-color) / var(--popup-opacity));
}
.help-tooltip--top::after {
  top: 100%; left: 50%; transform: translateX(-50%);
  border-top-color: rgb(var(--bg-color) / var(--popup-opacity));
}
.help-tooltip--left::after {
  left: 100%; top: 50%; transform: translateY(-50%);
  border-left-color: rgb(var(--bg-color) / var(--popup-opacity));
}

/* ---- 过渡 ---- */
.tooltip-fade-enter-active { transition: opacity 180ms ease, transform 180ms ease; }
.tooltip-fade-leave-active { transition: opacity 120ms ease, transform 120ms ease; }
.tooltip-fade-enter-from,
.tooltip-fade-leave-to { opacity: 0; }

.help-tooltip--bottom.tooltip-fade-enter-from,
.help-tooltip--bottom.tooltip-fade-leave-to { transform: translateY(-4rem); }
.help-tooltip--right.tooltip-fade-enter-from,
.help-tooltip--right.tooltip-fade-leave-to { transform: translateX(-4rem); }
.help-tooltip--top.tooltip-fade-enter-from,
.help-tooltip--top.tooltip-fade-leave-to { transform: translateY(4rem); }
.help-tooltip--left.tooltip-fade-enter-from,
.help-tooltip--left.tooltip-fade-leave-to { transform: translateX(4rem); }
</style>
