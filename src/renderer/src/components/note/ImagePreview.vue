<script setup>
/**
 * ImagePreview.vue — 图片大图预览
 *
 * 功能：
 *   - 全屏遮罩预览
 *   - 滚轮缩放
 *   - 放大/缩小/旋转按钮
 *   - ESC / 点击遮罩关闭
 */
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { retainModalBlur } from '../../utils/modalBlur.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  src: { type: String, default: '' }
})

const emit = defineEmits(['close'])

/** 缩放比例（1 = 100%） */
const scale = ref(1)
/** 旋转角度（度） */
const rotate = ref(0)
/** 平移偏移（屏幕像素） */
const translateX = ref(0)
const translateY = ref(0)
const overlayRef = ref(null)
let releaseBackgroundBlur = null

function acquireModalBlur() {
  if (releaseBackgroundBlur) return
  releaseBackgroundBlur = retainModalBlur()
}

function freeModalBlur() {
  releaseBackgroundBlur?.()
  releaseBackgroundBlur = null
}

/** 拖拽状态 */
const isDragging = ref(false)
let dragStartX = 0
let dragStartY = 0
let dragStartTX = 0
let dragStartTY = 0

/** 打开时重置状态 */
watch(
  () => props.visible,
  (v) => {
    if (v) {
      acquireModalBlur()
      scale.value = 1
      rotate.value = 0
      translateX.value = 0
      translateY.value = 0
      nextTick(() => overlayRef.value?.focus({ preventScroll: true }))
    }
  },
  { immediate: true }
)

function onClose() {
  emit('close')
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    onClose()
    return
  }
  if (e.key !== 'Tab') return
  const focusable = [...overlayRef.value.querySelectorAll('button:not(:disabled)')]
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (
    e.shiftKey &&
    (document.activeElement === first || document.activeElement === overlayRef.value)
  ) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

/** 滚轮缩放 */
function onWheel(e) {
  e.preventDefault()
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  scale.value = Math.max(0.1, Math.min(10, scale.value + delta))
}

/** 放大 */
function zoomIn() {
  scale.value = Math.min(10, scale.value + 0.25)
}
/** 缩小 */
function zoomOut() {
  scale.value = Math.max(0.1, scale.value - 0.25)
}
/** 旋转 90° */
function rotate90() {
  rotate.value = (rotate.value + 90) % 360
}
/** 重置 */
function reset() {
  scale.value = 1
  rotate.value = 0
  translateX.value = 0
  translateY.value = 0
}

// ============================================================
// 拖拽平移
// ============================================================

function onMouseDown(e) {
  if (e.button !== 0) return
  e.preventDefault()
  isDragging.value = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragStartTX = translateX.value
  dragStartTY = translateY.value
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(e) {
  if (!isDragging.value) return
  const dx = e.clientX - dragStartX
  const dy = e.clientY - dragStartY
  translateX.value = dragStartTX + dx
  translateY.value = dragStartTY + dy
}

function onMouseUp() {
  isDragging.value = false
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
}

onUnmounted(() => {
  freeModalBlur()
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="ipv" @after-leave="freeModalBlur">
      <div
        v-if="visible"
        ref="overlayRef"
        class="ipv-overlay"
        data-modal-layer="image-preview"
        data-keep-settings-open
        tabindex="-1"
        @click.self="onClose"
        @keydown="onKeydown"
      >
        <!-- 顶部工具栏 -->
        <div class="ipv-toolbar">
          <button class="ipv-btn" title="缩小" @click="zoomOut">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <button class="ipv-btn" title="放大" @click="zoomIn">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <button class="ipv-btn" title="旋转" @click="rotate90">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <button class="ipv-btn" title="重置" @click="reset">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </button>
          <div class="ipv-spacer" />
          <span class="ipv-info">{{ Math.round(scale * 100) }}%</span>
          <button class="ipv-btn ipv-btn--close" title="关闭 (ESC)" @click="onClose">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <!-- 图片容器 -->
        <div class="ipv-viewport" @wheel="onWheel">
          <img
            :src="src"
            class="ipv-image"
            :class="{ 'ipv-image--dragging': isDragging }"
            :style="{
              transform: `translate(${translateX}px, ${translateY}px) scale(${scale}) rotate(${rotate}deg)`
            }"
            @mousedown="onMouseDown"
            @click.stop
          />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ipv-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-global-preview);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.8);
  outline: none;
}
.ipv-enter-active,
.ipv-leave-active {
  transition: opacity 180ms ease;
}
.ipv-enter-active .ipv-image,
.ipv-leave-active .ipv-image,
.ipv-enter-active .ipv-toolbar,
.ipv-leave-active .ipv-toolbar {
  transition:
    opacity 180ms ease,
    transform 220ms var(--ease-standard);
}
.ipv-enter-from,
.ipv-leave-to,
.ipv-enter-from .ipv-toolbar,
.ipv-leave-to .ipv-toolbar {
  opacity: 0;
}
.ipv-enter-from .ipv-image,
.ipv-leave-to .ipv-image {
  opacity: 0;
  transform: scale(0.96) !important;
}
.ipv-enter-from .ipv-toolbar,
.ipv-leave-to .ipv-toolbar {
  transform: translateY(-6rem);
}

/* 工具栏 */
.ipv-toolbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 6rem;
  padding: 10rem 16rem;
  z-index: var(--z-local-top);
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.55), transparent);
  user-select: none;
}

.ipv-spacer {
  flex: 1;
}

.ipv-info {
  font-size: var(--fs-secondary);
  color: rgba(255, 255, 255, 0.65);
  min-width: 40rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.ipv-btn {
  width: 36rem;
  height: 36rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  transition: background 120ms ease;
}
.ipv-btn:hover {
  background: rgba(255, 255, 255, 0.22);
}
.ipv-btn:active {
  transform: scale(0.98);
  transition: transform 70ms ease;
}
.ipv-btn svg {
  width: 18rem;
  height: 18rem;
}
.ipv-btn--close:hover {
  background: rgba(255, 59, 48, 0.4);
}

/* 图片视口 */
.ipv-viewport {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.ipv-image {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 8rem;
  box-shadow: 0 8rem 40rem rgba(0, 0, 0, 0.5);
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: center center;
  cursor: grab;
  user-select: none;
}
.ipv-image--dragging {
  transition: none;
  cursor: grabbing;
}
</style>
