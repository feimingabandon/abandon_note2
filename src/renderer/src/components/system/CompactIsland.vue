<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import StatusRing from '../list/StatusRing.vue'

const props = defineProps({
  phase: { type: String, default: 'compact' }
})

const note = ref(null)
const dragging = ref(false)
const statusTransition = ref(null)
const completedSwapActive = ref(false)
const noteViewKey = ref('stable')
let pointerStart = null
let pointerLatest = null
let pointerMoved = false
let dragFrame = null
let dragStartPromise = null
let dragEndPromise = null
let stopNotesListener = null
let rootStyleObserver = null
let suppressDoubleClickUntil = 0
let lastCompactClick = null
let interactionGeneration = 0
let noteLoadGeneration = 0
let completedSwapRevision = 0
let deferredNoteReload = false
const statusTimers = new Set()

const DOUBLE_CLICK_MS = 420
const DOUBLE_CLICK_DISTANCE = 12
const STATUS_ANIMATION_MS = 1000
const DEFAULT_FONT_SIZE_PX = 18
const STATUS_RING_SIZE_PX = 24

const content = computed(
  () => note.value?.content?.trim() || (note.value ? '图片便签' : '长按拖动，双击展开')
)
const compactRootStyle = computed(() => ({
  '--compact-font-size': `${compactFontSize.value}px`,
  '--compact-status-ring-size': `${STATUS_RING_SIZE_PX}px`
}))
const showStatusRing = computed(() => Boolean(note.value))
const noteTransitionName = computed(() =>
  completedSwapActive.value ? 'compact-note-forward' : 'compact-note-static'
)
const statusTransitionClass = computed(() => {
  const state = statusTransition.value
  return state ? `is-${state.from}-to-${state.to}` : ''
})
const compactFontSize = ref(DEFAULT_FONT_SIZE_PX)

function readCompactFontSize() {
  const configured = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--font-size-base')
  )
  compactFontSize.value = Number.isFinite(configured) ? configured : DEFAULT_FONT_SIZE_PX
}

function scheduleStatusTimer(callback, delay) {
  const timer = setTimeout(() => {
    statusTimers.delete(timer)
    callback()
  }, delay)
  statusTimers.add(timer)
  return timer
}

function clearStatusTimers() {
  for (const timer of statusTimers) clearTimeout(timer)
  statusTimers.clear()
}

async function applyLoadedNote(nextNote, { completedSwap = false } = {}) {
  completedSwapActive.value = completedSwap
  if (completedSwap) {
    completedSwapRevision += 1
    noteViewKey.value = `completed-swap-${completedSwapRevision}`
  }
  note.value = nextNote
}

async function loadNote({ completedSwap = false } = {}) {
  if (statusTransition.value || completedSwapActive.value) {
    deferredNoteReload = true
    return
  }
  const generation = ++noteLoadGeneration
  try {
    const nextNote = await window.api.queryCompactNote()
    if (generation !== noteLoadGeneration) return
    await applyLoadedNote(nextNote, { completedSwap })
  } catch (error) {
    console.warn('[CompactIsland] 读取待处理便签失败:', error)
    note.value = null
  }
}

function onPointerDown(event) {
  if (event.button !== 0 || !['compact', 'dragging'].includes(props.phase)) return
  const now = Date.now()
  const currentPress = { at: now, x: event.screenX, y: event.screenY }
  const previousPress = lastCompactClick
  const isDoublePress =
    previousPress &&
    now >= suppressDoubleClickUntil &&
    now - previousPress.at <= DOUBLE_CLICK_MS &&
    Math.hypot(currentPress.x - previousPress.x, currentPress.y - previousPress.y) <=
      DOUBLE_CLICK_DISTANCE
  lastCompactClick = isDoublePress ? null : currentPress
  if (isDoublePress) {
    event.preventDefault()
    void expandAfterActiveDrag()
    return
  }
  if (props.phase !== 'compact') return
  const generation = ++interactionGeneration
  pointerStart = { x: event.screenX, y: event.screenY, pointerId: event.pointerId }
  pointerLatest = { x: event.screenX, y: event.screenY }
  pointerMoved = false
  event.currentTarget.setPointerCapture?.(event.pointerId)
  void startDragging(generation)
}

async function finishNativeDrag() {
  if (dragEndPromise) return dragEndPromise
  if (!dragging.value) return false
  dragging.value = false
  const task = window.api.endCompactWindowDrag().catch(() => false)
  dragEndPromise = task
  try {
    return await task
  } finally {
    if (dragEndPromise === task) dragEndPromise = null
  }
}

async function startDragging(generation = interactionGeneration) {
  if (dragging.value) return true
  if (dragStartPromise) return dragStartPromise
  const task = (async () => {
    const started = await window.api.beginCompactWindowDrag(pointerStart).catch(() => false)
    if (started && (generation !== interactionGeneration || !pointerStart)) {
      if (pointerMoved && pointerLatest) window.api.updateCompactWindowDrag(pointerLatest)
      await window.api.endCompactWindowDrag().catch(() => false)
      return false
    }
    dragging.value = Boolean(started)
    // 按下但没有移动属于普通单击，不应触发 setBounds；若 IPC 往返期间
    // 指针已经移动，则从第一次真实位移立即接管拖动。
    if (dragging.value && pointerMoved) requestDragUpdate()
    return dragging.value
  })()
  dragStartPromise = task
  try {
    return await task
  } finally {
    if (dragStartPromise === task) dragStartPromise = null
  }
}

function requestDragUpdate() {
  if (dragFrame) return
  dragFrame = requestAnimationFrame(() => {
    dragFrame = null
    window.api.updateCompactWindowDrag(pointerLatest)
  })
}

function onPointerMove(event) {
  if (!pointerStart) return
  pointerLatest = { x: event.screenX, y: event.screenY }
  if (event.screenX !== pointerStart.x || event.screenY !== pointerStart.y) pointerMoved = true
  if (dragging.value) requestDragUpdate()
}

async function finishPointerInteraction(event) {
  const activePointer = pointerStart
  const pendingDragStart = dragStartPromise
  const moved = pointerMoved
  pointerStart = null
  interactionGeneration += 1
  if (activePointer?.pointerId === event.pointerId) {
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }
  if (!activePointer) return
  if (pendingDragStart) await pendingDragStart.catch(() => false)
  if (dragging.value) await finishNativeDrag()
  else if (dragEndPromise) await dragEndPromise
  pointerLatest = null
  if (moved) suppressDoubleClickUntil = Date.now() + 600
}

async function expand(force = false) {
  if (Date.now() < suppressDoubleClickUntil || (!force && props.phase !== 'compact')) return
  await window.api
    .exitCompactWindow()
    .catch((error) => console.warn('[CompactIsland] 展开主视图失败:', error))
}

async function expandAfterActiveDrag() {
  if (dragStartPromise) await dragStartPromise.catch(() => false)
  if (dragging.value) await finishNativeDrag()
  else if (dragEndPromise) await dragEndPromise
  await expand(true)
}

async function activateStatus() {
  const current = note.value
  if (!current || current.status !== 'in_progress' || statusTransition.value) return
  const from = 'in_progress'
  const to = 'completed'

  deferredNoteReload = false
  statusTransition.value = { from, to, phase: 'acknowledging' }
  scheduleStatusTimer(() => {
    if (statusTransition.value?.phase === 'acknowledging') {
      statusTransition.value = { from, to, phase: 'waiting' }
    }
  }, 120)

  try {
    const updated = await window.api.completeNote(current.id)
    if (!updated) throw new Error('状态接口未返回更新后的便签')
    const replacementPromise = window.api
      .queryCompactNote()
      .then((replacement) => ({ replacement, error: null }))
      .catch((error) => ({ replacement: null, error }))
    clearStatusTimers()
    statusTransition.value = { from, to, phase: 'playing' }
    scheduleStatusTimer(() => {
      note.value = { ...current, ...updated }
    }, 920)
    scheduleStatusTimer(() => {
      void (async () => {
        statusTransition.value = null
        const mustReloadLatest = deferredNoteReload
        deferredNoteReload = false
        if (mustReloadLatest) {
          await loadNote({ completedSwap: true })
          return
        }
        const result = await replacementPromise
        if (result.error) {
          const error = result.error
          console.warn('[CompactIsland] 读取下一条进行中便签失败:', error)
          await loadNote({ completedSwap: true })
          return
        }
        await applyLoadedNote(result.replacement, { completedSwap: true })
      })()
    }, STATUS_ANIMATION_MS)
  } catch (error) {
    clearStatusTimers()
    console.warn('[CompactIsland] 修改便签状态失败:', error)
    statusTransition.value = { from, to, phase: 'error' }
    scheduleStatusTimer(() => {
      statusTransition.value = null
      if (deferredNoteReload) {
        deferredNoteReload = false
        void loadNote()
      }
    }, 320)
  }
}

function onKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (event.target !== event.currentTarget) return
  event.preventDefault()
  void expand()
}

function openContextMenu(event) {
  event.preventDefault()
  void window.api.showCompactWindowContextMenu()
}

function finishCompletedSwap() {
  completedSwapActive.value = false
  if (deferredNoteReload) {
    deferredNoteReload = false
    void loadNote()
    return
  }
}

onMounted(() => {
  readCompactFontSize()
  rootStyleObserver = new MutationObserver(readCompactFontSize)
  rootStyleObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style']
  })
  void loadNote()
  stopNotesListener = window.api.onNotesChanged?.(() => void loadNote())
})

onBeforeUnmount(() => {
  if (dragFrame) cancelAnimationFrame(dragFrame)
  if (dragging.value) void window.api.endCompactWindowDrag().catch(() => false)
  clearStatusTimers()
  rootStyleObserver?.disconnect()
  stopNotesListener?.()
})
</script>

<template>
  <section
    class="compact-island"
    :class="[
      `is-${phase}`,
      statusTransitionClass,
      {
        'is-dragging': dragging,
        'is-status-playing': statusTransition?.phase === 'playing'
      }
    ]"
    :style="compactRootStyle"
    role="button"
    tabindex="0"
    aria-label="灵动岛，按住拖动，双击展开主视图"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="finishPointerInteraction"
    @pointercancel="finishPointerInteraction"
    @lostpointercapture="finishPointerInteraction"
    @dblclick="expand()"
    @keydown="onKeydown"
    @contextmenu="openContextMenu"
  >
    <span class="compact-island__status-sweep" aria-hidden="true" />

    <Transition
      :name="noteTransitionName"
      @after-enter="finishCompletedSwap"
      @enter-cancelled="finishCompletedSwap"
    >
      <div
        :key="noteViewKey"
        class="compact-island__content"
        :class="{ 'has-note': note }"
        :data-note-id="note?.id || ''"
      >
        <div
          v-if="note"
          class="compact-island__status-ring"
          :class="{ 'is-visible': showStatusRing }"
          @pointerdown.stop
          @pointerup.stop
          @dblclick.stop
        >
          <StatusRing
            :status="note.status"
            :transition-state="statusTransition"
            @activate="activateStatus"
          />
        </div>

        <div class="compact-island__text-viewport">
          <span class="compact-island__text">{{ content }}</span>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.compact-island {
  position: absolute;
  z-index: var(--z-local-content);
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--text-color);
  background: transparent;
  border-radius: var(--window-radius);
  cursor: default;
  outline: none;
  user-select: none;
  -webkit-app-region: no-drag;
}

.compact-island.is-dragging {
  filter: brightness(1.055);
}

.compact-island.is-collapsing,
.compact-island.is-expanding {
  z-index: var(--z-local-raised);
  pointer-events: none;
}

.compact-island__content {
  position: absolute;
  z-index: var(--z-local-content);
  inset: 0;
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 6px 12px;
}

.compact-island__content.has-note {
  gap: 8px;
}

.compact-island__text-viewport {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  width: auto;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.compact-island__text {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  /* 单 Renderer 胶囊场景使用稳定字号，窗口尺寸变化只改变可用排版空间。 */
  font-size: var(--compact-font-size);
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact-island__status-ring {
  position: relative;
  z-index: var(--z-local-raised);
  display: grid;
  flex: 0 0 var(--compact-status-ring-size);
  width: var(--compact-status-ring-size);
  height: var(--compact-status-ring-size);
  place-items: center;
  opacity: 1;
  transform: none;
  pointer-events: auto;
}

.compact-island__status-ring.is-visible,
.compact-island.is-status-playing .compact-island__status-ring {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}

.compact-island__status-ring :deep(.sr-control),
.compact-island__status-ring :deep(.sr-visual) {
  width: 100%;
  height: 100%;
  margin: 0;
}

.compact-note-forward-enter-active,
.compact-note-forward-leave-active {
  transition:
    opacity 360ms ease,
    transform 420ms var(--ease-standard);
  will-change: opacity, transform;
}

.compact-note-forward-enter-from {
  opacity: 0;
  transform: translateX(38%);
}

.compact-note-forward-leave-to {
  opacity: 0;
  transform: translateX(-38%);
}

.compact-island__status-sweep {
  position: absolute;
  z-index: var(--z-local-raised);
  inset: 0;
  border-radius: inherit;
  opacity: 0;
  transform: scaleX(0);
  transform-origin: left center;
  pointer-events: none;
}

.compact-island.is-initialized-to-in_progress {
  --compact-status-sweep-color: #ff9f0a;
}

.compact-island.is-in_progress-to-completed {
  --compact-status-sweep-color: #30d158;
}

.compact-island.is-status-playing .compact-island__status-sweep {
  background:
    radial-gradient(
      ellipse 15% 94% at 100% 50%,
      color-mix(in srgb, #fff 14%, transparent) 0%,
      color-mix(in srgb, var(--compact-status-sweep-color) 16%, transparent) 28%,
      color-mix(in srgb, var(--compact-status-sweep-color) 8%, transparent) 58%,
      transparent 100%
    ),
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--compact-status-sweep-color) 2.5%, transparent) 0%,
      color-mix(in srgb, var(--compact-status-sweep-color) 4%, transparent) 34%,
      color-mix(in srgb, var(--compact-status-sweep-color) 6.5%, transparent) 68%,
      color-mix(in srgb, var(--compact-status-sweep-color) 10%, transparent) 90%,
      color-mix(in srgb, var(--compact-status-sweep-color) 14%, transparent) 100%
    );
  animation:
    compact-status-sweep-motion 1000ms cubic-bezier(0.55, 0, 0.45, 1) both,
    compact-status-sweep-opacity 1000ms linear both;
}

@keyframes compact-status-sweep-motion {
  0% {
    transform: scaleX(0.02);
  }
  90%,
  100% {
    transform: scaleX(1);
  }
}

@keyframes compact-status-sweep-opacity {
  0% {
    opacity: 0;
  }
  12%,
  92% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
</style>
