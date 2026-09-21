<script setup>
/**
 * ResizeHandles.vue — 自定义窗口缩放手柄组件
 *
 * 职责：
 *   由于窗口设置了 frame: false（无系统边框），系统原生的缩放功能失效。
 *   本组件在窗口四条边和四个角放置透明的拖拽区域，实现八方向缩放：
 *     - n（上）、s（下）、w（左）、e（右）
 *     - nw（左上）、ne（右上）、sw（左下）、se（右下）
 *
 * 实现原理：
 *   1. 鼠标按下时，通过 IPC 获取当前窗口的 bounds（位置 + 尺寸）
 *   2. 监听 document 上的 mousemove 事件，计算鼠标偏移量 dx/dy
 *   3. 根据拖拽方向计算新的 bounds，并通过 IPC 设置窗口新尺寸
 *   4. 鼠标松开时移除事件监听器
 *
 * 注意事项：
 *   - 整个容器设置 pointer-events: none，仅各手柄区域开启 pointer-events: auto
 *   - 使用组件局部最高层级，窗口级浮层仍可按统一全局顺序覆盖
 *   - 主视图与灵动岛分别使用自己的真实窗口尺寸范围
 */

import { computed, onBeforeUnmount } from 'vue'
import { COMPACT_WINDOW_LIMITS } from '../../../../shared/window-compact-geometry.js'

const EXPANDED_MIN_SIZE = 240

/** Props */
const props = defineProps({
  locked: {
    type: Boolean,
    required: true
  },
  mode: {
    type: String,
    default: 'expanded'
  }
})

const limits = computed(() =>
  props.mode === 'compact'
    ? COMPACT_WINDOW_LIMITS
    : {
        minWidth: EXPANDED_MIN_SIZE,
        minHeight: EXPANDED_MIN_SIZE,
        maxWidth: 16_384,
        maxHeight: 16_384
      }
)

let resizeSession = null
let resizeGeneration = 0

function setPointerCapture(target, pointerId) {
  try {
    target.setPointerCapture?.(pointerId)
  } catch {
    // 窗口切换或合成输入可能使 pointerId 失效；全局监听仍负责兜底收口。
  }
}

function releasePointerCapture(target, pointerId) {
  try {
    target.releasePointerCapture?.(pointerId)
  } catch {
    // pointerup、pointercancel 与 lostpointercapture 允许幂等竞争。
  }
}

function removeResizeListeners() {
  window.removeEventListener('pointermove', onPointerMove, true)
  window.removeEventListener('pointerup', finishResize, true)
  window.removeEventListener('pointercancel', finishResize, true)
  window.removeEventListener('blur', finishResize)
}

/**
 * 鼠标按下事件处理器 — 启动缩放拖拽
 * @param {PointerEvent} e - 原生指针事件
 * @param {string} direction - 拖拽方向标识，由方位字母组合而成
 *   如 'n'（上）、'se'（右下角）、'nw'（左上角）等
 */
async function onPointerDown(event, direction) {
  if (event.button !== 0 || resizeSession) return
  event.preventDefault()
  event.stopPropagation()

  const generation = ++resizeGeneration
  const session = {
    generation,
    pointerId: event.pointerId,
    target: event.currentTarget,
    direction,
    startX: event.screenX,
    startY: event.screenY,
    startBounds: null,
    moved: false
  }
  resizeSession = session
  setPointerCapture(session.target, session.pointerId)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', finishResize, true)
  window.addEventListener('pointercancel', finishResize, true)
  // 只在浏览器窗口本身失焦时收口；捕获阶段会误接收表单控件的 blur。
  window.addEventListener('blur', finishResize)

  const bounds = await window.api.getWindowBounds().catch(() => null)
  if (resizeSession !== session || generation !== resizeGeneration) return
  if (!bounds) {
    finishResize()
    return
  }
  session.startBounds = bounds
}

function onPointerMove(event) {
  const session = resizeSession
  if (!session || !session.startBounds || event.pointerId !== session.pointerId) return
  const dx = event.screenX - session.startX
  const dy = event.screenY - session.startY
  let { x, y, width, height } = session.startBounds

  if (session.direction.includes('e'))
    width = Math.min(limits.value.maxWidth, Math.max(limits.value.minWidth, width + dx))
  if (session.direction.includes('s'))
    height = Math.min(limits.value.maxHeight, Math.max(limits.value.minHeight, height + dy))
  if (session.direction.includes('w')) {
    const nextWidth = Math.min(limits.value.maxWidth, Math.max(limits.value.minWidth, width - dx))
    x += width - nextWidth
    width = nextWidth
  }
  if (session.direction.includes('n')) {
    const nextHeight = Math.min(
      limits.value.maxHeight,
      Math.max(limits.value.minHeight, height - dy)
    )
    y += height - nextHeight
    height = nextHeight
  }

  session.moved = true
  window.api.setWindowBounds({ x, y, width, height })
}

function onLostPointerCapture(event) {
  const session = resizeSession
  if (!session || event.pointerId !== session.pointerId) return
  // Windows 在重排置底窗口与毛玻璃 Overlay 时可能释放 DOM pointer capture；
  // 只要尚未收到 pointerup / pointercancel，就继续使用 window 级监听完成缩放。
  console.warn('[ResizeHandles] 缩放期间指针捕获丢失，继续使用窗口级监听', {
    pointerId: event.pointerId,
    buttons: event.buttons,
    direction: session.direction,
    moved: session.moved
  })
}

function finishResize(event) {
  const session = resizeSession
  if (!session) return
  if (event?.pointerId !== undefined && event.pointerId !== session.pointerId) return
  resizeSession = null
  resizeGeneration += 1
  removeResizeListeners()
  releasePointerCapture(session.target, session.pointerId)
  if (session.startBounds) void window.api.finishWindowResize()
}

onBeforeUnmount(() => finishResize())
</script>

<template>
  <!-- 缩放手柄容器：absolute 定位覆盖整个窗口，自身不捕获事件；锁定后禁用手柄 -->
  <div
    class="resize-handles"
    :class="{ locked: locked }"
    @lostpointercapture="onLostPointerCapture"
  >
    <!-- 上边缘手柄 -->
    <div class="rh rh-n" @pointerdown="onPointerDown($event, 'n')"></div>
    <!-- 下边缘手柄 -->
    <div class="rh rh-s" @pointerdown="onPointerDown($event, 's')"></div>
    <!-- 左边缘手柄 -->
    <div class="rh rh-w" @pointerdown="onPointerDown($event, 'w')"></div>
    <!-- 右边缘手柄 -->
    <div class="rh rh-e" @pointerdown="onPointerDown($event, 'e')"></div>
    <!-- 左上角手柄 -->
    <div class="rh rh-nw" @pointerdown="onPointerDown($event, 'nw')"></div>
    <!-- 右上角手柄 -->
    <div class="rh rh-ne" @pointerdown="onPointerDown($event, 'ne')"></div>
    <!-- 左下角手柄 -->
    <div class="rh rh-sw" @pointerdown="onPointerDown($event, 'sw')"></div>
    <!-- 右下角手柄 -->
    <div class="rh rh-se" @pointerdown="onPointerDown($event, 'se')"></div>
  </div>
</template>

<style scoped>
/* 手柄容器：覆盖整个窗口，不捕获鼠标事件（留给子元素） */
.resize-handles {
  position: absolute;
  inset: 0; /* 等同于 top:0; right:0; bottom:0; left:0 */
  pointer-events: none; /* 容器本身不响应鼠标事件 */
  z-index: var(--z-local-top);
}

/* 单个手柄的公共样式 */
.rh {
  position: absolute;
  pointer-events: auto; /* 手柄区域恢复鼠标事件响应 */
  touch-action: none;
}

/* 锁定状态下禁用手柄交互 */
.resize-handles.locked .rh {
  pointer-events: none;
}

/* ---- 边缘手柄（条形，宽度/高度 5px） ---- */
/* 上边缘：水平条形，留出 6px 避免与角手柄重叠 */
.rh-n {
  top: 0;
  left: 6px;
  right: 6px;
  height: 5px;
  cursor: ns-resize;
}
/* 下边缘 */
.rh-s {
  bottom: 0;
  left: 6px;
  right: 6px;
  height: 5px;
  cursor: ns-resize;
}
/* 左边缘：垂直条形 */
.rh-w {
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 5px;
  cursor: ew-resize;
}
/* 右边缘 */
.rh-e {
  right: 0;
  top: 6px;
  bottom: 6px;
  width: 5px;
  cursor: ew-resize;
}

/* ---- 角手柄（正方形 8x8px，对角线方向光标） ---- */
/* 左上角 */
.rh-nw {
  top: 0;
  left: 0;
  width: 8px;
  height: 8px;
  cursor: nwse-resize;
}
/* 右上角 */
.rh-ne {
  top: 0;
  right: 0;
  width: 8px;
  height: 8px;
  cursor: nesw-resize;
}
/* 左下角 */
.rh-sw {
  bottom: 0;
  left: 0;
  width: 8px;
  height: 8px;
  cursor: nesw-resize;
}
/* 右下角 */
.rh-se {
  bottom: 0;
  right: 0;
  width: 8px;
  height: 8px;
  cursor: nwse-resize;
}
</style>
