<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import StatusRing from '../list/StatusRing.vue'

defineProps({
  locked: { type: Boolean, required: true },
  ready: { type: Boolean, default: false }
})

const note = ref(null)
const dragging = ref(false)
const completing = ref(false)
let pointerStart = null
let pointerLatest = null
let pointerMoved = false
let dragFrame = null
let dragStartPromise = null
let stopNotesListener = null
let lastPress = null
let suppressDoubleClickUntil = 0
let expandPromise = null
let interactionRevision = 0
let loadRevision = 0

const DOUBLE_CLICK_MS = 420
const DOUBLE_CLICK_DISTANCE = 12
const content = computed(
  () => note.value?.content?.trim() || (note.value ? '图片便签' : '双击展开主视图')
)

async function loadNote() {
  const revision = ++loadRevision
  try {
    const next = await window.api.queryCompactNote()
    if (revision === loadRevision) note.value = next
  } catch (error) {
    if (revision === loadRevision) note.value = null
    console.warn('[CompactIsland] 读取进行中便签失败:', error)
  }
}

function requestDragUpdate() {
  if (dragFrame || !pointerLatest) return
  dragFrame = requestAnimationFrame(() => {
    dragFrame = null
    window.api.updateCompactWindowDrag(pointerLatest)
  })
}

function addPointerListeners() {
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', finishPointer, true)
  window.addEventListener('pointercancel', finishPointer, true)
  // 子元素焦点切换不能中断拖动，只处理 window 自身的失焦。
  window.addEventListener('blur', finishPointer)
}

function removePointerListeners() {
  window.removeEventListener('pointermove', onPointerMove, true)
  window.removeEventListener('pointerup', finishPointer, true)
  window.removeEventListener('pointercancel', finishPointer, true)
  window.removeEventListener('blur', finishPointer)
}

async function startDragging(revision) {
  const started = await window.api.beginCompactWindowDrag(pointerStart).catch(() => false)
  if (revision !== interactionRevision || !pointerStart) {
    if (started) await window.api.endCompactWindowDrag().catch(() => false)
    return false
  }
  dragging.value = Boolean(started)
  if (dragging.value && pointerMoved) requestDragUpdate()
  return dragging.value
}

async function finishActiveDrag() {
  if (dragStartPromise) await dragStartPromise.catch(() => false)
  if (!dragging.value) return false
  if (pointerMoved && pointerLatest) window.api.updateCompactWindowDrag(pointerLatest)
  dragging.value = false
  return window.api.endCompactWindowDrag().catch(() => false)
}

function onPointerDown(event) {
  if (event.button !== 0) return
  const now = Date.now()
  const press = { at: now, x: event.screenX, y: event.screenY }
  const doublePress =
    lastPress &&
    now >= suppressDoubleClickUntil &&
    now - lastPress.at <= DOUBLE_CLICK_MS &&
    Math.hypot(press.x - lastPress.x, press.y - lastPress.y) <= DOUBLE_CLICK_DISTANCE
  lastPress = doublePress ? null : press
  if (doublePress) {
    suppressDoubleClickUntil = now + 500
    event.preventDefault()
    void expandAfterDrag(press)
    return
  }

  const revision = ++interactionRevision
  pointerStart = {
    x: event.screenX,
    y: event.screenY,
    pointerId: event.pointerId,
    captureTarget: event.currentTarget
  }
  pointerLatest = { x: event.screenX, y: event.screenY }
  pointerMoved = false
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {
    // 合成输入或窗口层级切换可能让 pointerId 暂时不可捕获；窗口监听继续兜底。
  }
  addPointerListeners()
  dragStartPromise = startDragging(revision).finally(() => {
    dragStartPromise = null
  })
}

function onPointerMove(event) {
  if (!pointerStart || pointerStart.pointerId !== event.pointerId) return
  pointerLatest = { x: event.screenX, y: event.screenY }
  if (event.screenX !== pointerStart.x || event.screenY !== pointerStart.y) pointerMoved = true
  if (dragging.value) requestDragUpdate()
}

async function finishPointer(event) {
  if (!pointerStart) return
  if (event?.pointerId !== undefined && pointerStart.pointerId !== event.pointerId) return
  const { pointerId, captureTarget } = pointerStart
  const moved = pointerMoved
  pointerStart = null
  interactionRevision += 1
  removePointerListeners()
  try {
    captureTarget?.releasePointerCapture?.(pointerId)
  } catch {
    // lostpointercapture 和 pointerup 可能同时到达。
  }
  await finishActiveDrag()
  pointerLatest = null
  pointerMoved = false
  if (moved) suppressDoubleClickUntil = Date.now() + 600
}

function onLostPointerCapture(event) {
  if (!pointerStart || pointerStart.pointerId !== event.pointerId) return
  console.warn('[CompactIsland] 拖动期间指针捕获丢失，继续使用窗口级监听', {
    pointerId: event.pointerId,
    buttons: event.buttons,
    dragging: dragging.value,
    moved: pointerMoved
  })
}

function onDoubleClick(event) {
  if (Date.now() < suppressDoubleClickUntil) return
  void expandAfterDrag({ x: event.screenX, y: event.screenY })
}

async function expandAfterDrag(anchor) {
  if (expandPromise) return expandPromise
  expandPromise = (async () => {
    await finishActiveDrag()
    await window.api.exitCompactPresentation(anchor)
  })()
  try {
    await expandPromise
  } catch (error) {
    console.warn('[CompactIsland] 展开主视图失败:', error)
  } finally {
    expandPromise = null
  }
}

async function expandFromKeyboard() {
  const bounds = await window.api.getWindowBounds().catch(() => null)
  const anchor = bounds
    ? {
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2)
      }
    : null
  await expandAfterDrag(anchor)
}

async function completeCurrentNote() {
  if (!note.value || note.value.status !== 'in_progress' || completing.value) return
  completing.value = true
  try {
    await window.api.completeNote(note.value.id)
    await loadNote()
  } catch (error) {
    console.warn('[CompactIsland] 完成便签失败:', error)
  } finally {
    completing.value = false
  }
}

function onKeydown(event) {
  if (!['Enter', ' '].includes(event.key) || event.target !== event.currentTarget) return
  event.preventDefault()
  void expandFromKeyboard()
}

function openContextMenu(event) {
  event.preventDefault()
  void window.api.showCompactWindowContextMenu()
}

onMounted(() => {
  void loadNote()
  stopNotesListener = window.api.onNotesChanged?.(() => void loadNote())
})

onBeforeUnmount(() => {
  interactionRevision += 1
  removePointerListeners()
  if (dragFrame) cancelAnimationFrame(dragFrame)
  if (dragging.value || dragStartPromise) void window.api.endCompactWindowDrag().catch(() => false)
  stopNotesListener?.()
})
</script>

<template>
  <section
    class="compact-island"
    :class="{ 'is-dragging': dragging, 'is-ready': ready }"
    role="button"
    tabindex="0"
    aria-label="灵动岛，按住拖动，双击展开主视图"
    @pointerdown="onPointerDown"
    @lostpointercapture="onLostPointerCapture"
    @dblclick="onDoubleClick"
    @keydown="onKeydown"
    @contextmenu="openContextMenu"
  >
    <div class="compact-island__content" :class="{ 'has-note': note }">
      <div
        v-if="note"
        class="compact-island__status"
        @pointerdown.stop
        @pointerup.stop
        @dblclick.stop
      >
        <StatusRing
          :status="note.status"
          :interactive="!completing"
          @activate="completeCurrentNote"
        />
      </div>
      <span class="compact-island__text">{{ content }}</span>
    </div>
  </section>
</template>

<style scoped>
.compact-island {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-color);
  background: transparent;
  border-radius: var(--window-radius);
  outline: none;
  user-select: none;
  cursor: default;
  -webkit-app-region: no-drag;
}

.compact-island.is-dragging {
  filter: brightness(1.055);
}

.compact-island__content {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 100%;
  padding: 4px 14px;
  transform-origin: center;
}

.compact-island.is-ready .compact-island__content {
  animation: compact-island-content-enter var(--motion-panel) var(--ease-standard) both;
}

@keyframes compact-island-content-enter {
  0% {
    opacity: 0;
    transform: scale(0.86);
  }
  68% {
    opacity: 1;
    transform: scale(1.035);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

.compact-island__content.has-note {
  gap: 8px;
}

.compact-island__status {
  position: relative;
  z-index: var(--z-local-raised);
  display: grid;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  place-items: center;
}

.compact-island__status :deep(.sr-control),
.compact-island__status :deep(.sr-visual) {
  width: 100%;
  height: 100%;
  margin: 0;
}

.compact-island__text {
  min-width: 0;
  overflow: hidden;
  font-size: var(--compact-content-font-size);
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
