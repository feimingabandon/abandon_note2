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
import { computed, nextTick, onBeforeUnmount, onUnmounted, ref, watch } from 'vue'
import { retainModalBlur } from '../../utils/modalBlur.js'
import { modalQueue } from '../../utils/modalQueue.js'
import { copyImageToClipboard, imageClipboardBusy } from '../../utils/imageClipboard.js'
import { useMessage } from '../../composables/useMessage.js'
import ImageCopyMenu from './ImageCopyMenu.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  src: { type: String, default: '' },
  sources: { type: Array, default: () => [] },
  initialIndex: { type: Number, default: 0 },
  resolveSource: { type: Function, default: null }
})

const emit = defineEmits(['close', 'change'])
const { showMessage } = useMessage()
const copyMenu = ref(null)
let displayedImage = null

/** 缩放比例（1 = 100%） */
const scale = ref(1)
/** 旋转角度（度） */
const rotate = ref(0)
/** 平移偏移（屏幕像素） */
const translateX = ref(0)
const translateY = ref(0)
const overlayRef = ref(null)
const activeIndex = ref(0)
const navigationDirection = ref('next')
const availableSources = computed(() =>
  props.sources.length ? props.sources : props.src ? [props.src] : []
)
const managed = computed(() => typeof props.resolveSource === 'function')
const activeEntry = ref(null)
const legacySource = ref('')
const activeSrc = computed(() =>
  managed.value ? activeEntry.value?.src || '' : legacySource.value
)
const imageKey = computed(() => (managed.value ? activeEntry.value?.id : activeIndex.value))
const renderOpen = ref(false)
const leases = new Map()
let entrySequence = 0
let epoch = 0
let preparing = null
let requestedIndex = 0
let closing = false
let openRequested = false
let disposed = false
let returnFocus = null
const hasMultiple = computed(() => availableSources.value.length > 1)
const imageTransitionName = computed(() =>
  navigationDirection.value === 'previous' ? 'ipv-image-previous' : 'ipv-image-next'
)
let releaseBackgroundBlur = null
let releaseQueueHold = null

function resetTransform() {
  scale.value = 1
  rotate.value = 0
  translateX.value = 0
  translateY.value = 0
}

function acquireModalBlur() {
  if (!releaseQueueHold) releaseQueueHold = modalQueue.hold()
  if (releaseBackgroundBlur) return
  releaseBackgroundBlur = retainModalBlur()
}

function freeModalBlur() {
  releaseBackgroundBlur?.()
  releaseBackgroundBlur = null
  const done = releaseQueueHold
  releaseQueueHold = null
  if (done) void nextTick(done)
}

/** 拖拽状态 */
const isDragging = ref(false)
let dragStartX = 0
let dragStartY = 0
let dragStartTX = 0
let dragStartTY = 0

function releaseEntry(entry) {
  if (!entry || !leases.has(entry.id)) return
  if (entry.copyHolds) {
    entry.releaseRequested = true
    return
  }
  leases.delete(entry.id)
  entry.src = ''
  const release = entry.release
  entry.release = null
  release?.()
}

function bindImage(element) {
  if (!element) return
  displayedImage = element
  const entry = leases.get(Number(element.dataset.previewLease))
  if (entry) entry.element = element
}

async function copyCurrentImage() {
  const entry = activeEntry.value
  const src = activeSrc.value
  const index = activeIndex.value
  const element = entry?.element || displayedImage
  const current = () =>
    !disposed &&
    !closing &&
    renderOpen.value &&
    props.visible &&
    activeSrc.value === src &&
    activeIndex.value === index &&
    requestedIndex === index
  try {
    const result = await copyImageToClipboard({
      isCurrent: current,
      acquire: () => {
        if (entry) entry.copyHolds = (entry.copyHolds || 0) + 1
        return {
          src,
          image: element?.src === src ? element : null,
          release() {
            if (!entry) return
            entry.copyHolds--
            if (entry.releaseRequested) releaseEntry(entry)
            if (closing || disposed) void overlayLeft()
            else void pump()
          }
        }
      }
    })
    if (result === 'copied' && !disposed) showMessage('success', '图片已复制')
  } catch (error) {
    if (current()) showMessage('warning', error.message || '图片复制失败，请重试')
  }
}

function openCopyMenu(event) {
  event.preventDefault()
  event.stopPropagation()
  if (
    event.currentTarget.getAttribute('aria-hidden') === 'true' ||
    event.currentTarget.getAttribute('src') !== activeSrc.value
  )
    return
  void copyMenu.value?.open(event)
}

function beforeImageLeave(element) {
  element.setAttribute('aria-hidden', 'true')
}

function releaseDetached() {
  for (const entry of leases.values()) {
    // A never-mounted prepared result has no DOM reader. Connected nodes retain
    // their lease even when a transition was cancelled.
    if (!entry.element || !entry.element.isConnected) releaseEntry(entry)
  }
}

async function imageLeft(element) {
  const entry = leases.get(Number(element.dataset.previewLease))
  if (!entry) return
  if (element.isConnected) await nextTick()
  if (!element.isConnected) releaseEntry(entry)
  void pump()
}

async function overlayLeft() {
  await nextTick()
  releaseDetached()
  if (leases.size) return // No capacity is returned without a detached node ACK.
  activeEntry.value = null
  displayedImage = null
  legacySource.value = ''
  closing = false
  freeModalBlur()
  if (!disposed && openRequested && props.visible) void scheduleOpen()
  else {
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    returnFocus = null
  }
}

async function pump() {
  if (
    disposed ||
    !openRequested ||
    !props.visible ||
    closing ||
    !managed.value ||
    preparing ||
    leases.size > 1
  )
    return
  if (activeEntry.value?.index === requestedIndex) return
  const generation = epoch
  const index = requestedIndex
  const resolver = props.resolveSource
  const read = Promise.resolve().then(() => {
    // Navigation and close can occur in the same handler before this deferred
    // call runs. Do not start an IPC read for an already cancelled preparation.
    if (
      disposed ||
      !openRequested ||
      !props.visible ||
      closing ||
      generation !== epoch ||
      index !== requestedIndex
    )
      return null
    return resolver(index)
  })
  preparing = read
  let value
  try {
    value = await read
    if (
      !value ||
      typeof value.src !== 'string' ||
      !value.src ||
      typeof value.release !== 'function'
    )
      throw new Error('图片预览响应无效')
    if (
      disposed ||
      !openRequested ||
      !props.visible ||
      closing ||
      generation !== epoch ||
      index !== requestedIndex
    ) {
      value.release()
      return
    }
    const entry = {
      id: ++entrySequence,
      index,
      src: value.src,
      release: value.release,
      element: null
    }
    leases.set(entry.id, entry)
    activeEntry.value = entry
    activeIndex.value = index
    const opening = !renderOpen.value
    renderOpen.value = true
    resetTransform()
    if (opening) await nextTick(() => overlayRef.value?.focus({ preventScroll: true }))
  } catch {
    if (
      generation === epoch &&
      index === requestedIndex &&
      props.visible &&
      !closing &&
      !disposed
    ) {
      // A failed navigation keeps the displayed original. An initial failure has
      // no useful overlay and asks its owner to close the request.
      if (!activeEntry.value) emit('close')
      requestedIndex = activeEntry.value?.index ?? index
    }
  } finally {
    if (preparing === read) preparing = null
    // Discarded results may free the second slot; only the latest intent runs.
    if (
      !disposed &&
      props.visible &&
      !closing &&
      (!activeEntry.value || activeEntry.value.index !== requestedIndex) &&
      generation !== epoch
    )
      void pump()
    else if (!disposed && props.visible && !closing && index !== requestedIndex) void pump()
  }
}

function openSession() {
  if (disposed || closing || !openRequested || !props.visible) return
  epoch++
  if (!returnFocus) returnFocus = document.activeElement
  acquireModalBlur()
  requestedIndex = Math.max(
    0,
    Math.min(availableSources.value.length - 1, Number(props.initialIndex) || 0)
  )
  activeIndex.value = requestedIndex
  resetTransform()
  if (managed.value) void pump()
  else {
    legacySource.value = availableSources.value[activeIndex.value] || ''
    renderOpen.value = true
    nextTick(() => overlayRef.value?.focus({ preventScroll: true }))
  }
}

async function scheduleOpen() {
  const generation = epoch
  // Vue patches a child's props in order. A synchronous visible=true watcher
  // can otherwise see the previous sources/initialIndex from the same patch.
  await nextTick()
  if (!disposed && openRequested && props.visible && !closing && generation === epoch) openSession()
}

function closeSession() {
  copyMenu.value?.close()
  // A local close precedes the parent's next props patch. The still-true visible
  // prop is not a new opening request; only a subsequent true edge can reopen.
  openRequested = false
  if (closing) return
  epoch++
  onMouseUp()
  closing = true
  const hadOverlay = renderOpen.value
  renderOpen.value = false
  if (!hadOverlay) void overlayLeft()
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      openRequested = true
      void scheduleOpen()
    } else closeSession()
  },
  { immediate: true, flush: 'sync' }
)

watch(
  () => [props.src, props.sources],
  () => {
    copyMenu.value?.close()
    if (!managed.value && openRequested && props.visible && !closing)
      legacySource.value = availableSources.value[activeIndex.value] || ''
  }
)

function onClose() {
  closeSession()
  emit('close')
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    onClose()
    return
  }
  if (e.key === 'ArrowLeft' && hasMultiple.value) {
    e.preventDefault()
    showPrevious()
    return
  }
  if (e.key === 'ArrowRight' && hasMultiple.value) {
    e.preventDefault()
    showNext()
    return
  }
  if (e.key !== 'Tab') return
  const focusable = [
    ...overlayRef.value.querySelectorAll('button:not(:disabled), .ipv-image')
  ].filter((element) => element.getAttribute('aria-hidden') !== 'true')
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
  resetTransform()
}

function changeImage(index, direction) {
  if (!availableSources.value.length || closing) return
  copyMenu.value?.close()
  navigationDirection.value = direction
  requestedIndex = (index + availableSources.value.length) % availableSources.value.length
  emit('change', requestedIndex)
  if (managed.value) void pump()
  else {
    activeIndex.value = requestedIndex
    legacySource.value = availableSources.value[activeIndex.value] || ''
    resetTransform()
  }
}

function showPrevious() {
  changeImage(requestedIndex - 1, 'previous')
}

function showNext() {
  changeImage(requestedIndex + 1, 'next')
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

onBeforeUnmount(() => {
  disposed = true
  epoch++
  onMouseUp()
})
onUnmounted(() => {
  // Vue has removed the component/Teleport subtree by this lifecycle hook.
  releaseDetached()
  activeEntry.value = null
  displayedImage = null
  legacySource.value = ''
  freeModalBlur()
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="ipv" appear @after-leave="overlayLeft" @leave-cancelled="overlayLeft">
      <div
        v-if="renderOpen"
        ref="overlayRef"
        class="ipv-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="图片预览"
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
          <button
            class="ipv-btn"
            type="button"
            :title="imageClipboardBusy ? '正在复制…' : '复制图片'"
            aria-label="复制图片"
            :disabled="imageClipboardBusy || !activeSrc"
            @click="copyCurrentImage"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V4H4v12h4" />
            </svg>
          </button>
          <div class="ipv-spacer" />
          <span class="ipv-info">
            <template v-if="hasMultiple"
              >{{ activeIndex + 1 }} / {{ availableSources.length }} ·
            </template>
            {{ Math.round(scale * 100) }}%
          </span>
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
          <button
            v-if="hasMultiple"
            class="ipv-nav ipv-nav--previous"
            type="button"
            title="上一张（←）"
            aria-label="上一张图片"
            @click.stop="showPrevious"
          >
            ‹
          </button>
          <div class="ipv-image-stage">
            <Transition
              :name="imageTransitionName"
              @before-leave="beforeImageLeave"
              @after-leave="imageLeft"
              @leave-cancelled="imageLeft"
            >
              <img
                :key="imageKey"
                :ref="bindImage"
                :data-preview-lease="managed ? activeEntry?.id : undefined"
                :src="activeSrc"
                class="ipv-image"
                :class="{ 'ipv-image--dragging': isDragging }"
                :style="{
                  transform: `translate(${translateX}px, ${translateY}px) scale(${scale}) rotate(${rotate}deg)`
                }"
                tabindex="0"
                aria-haspopup="menu"
                @mousedown="onMouseDown"
                @contextmenu="openCopyMenu"
                @click.stop
              />
            </Transition>
          </div>
          <button
            v-if="hasMultiple"
            class="ipv-nav ipv-nav--next"
            type="button"
            title="下一张（→）"
            aria-label="下一张图片"
            @click.stop="showNext"
          >
            ›
          </button>
        </div>
        <ImageCopyMenu
          ref="copyMenu"
          in-preview
          :disabled="imageClipboardBusy"
          @copy="copyCurrentImage"
        />
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
.ipv-btn:disabled {
  opacity: 0.38;
  cursor: default;
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

.ipv-image-stage {
  display: grid;
  width: 90vw;
  height: 90vh;
  place-items: center;
}

.ipv-image {
  grid-area: 1 / 1;
  max-width: 100%;
  max-height: 100%;
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
.ipv-image-next-enter-active,
.ipv-image-next-leave-active,
.ipv-image-previous-enter-active,
.ipv-image-previous-leave-active {
  transition:
    opacity 200ms ease,
    transform 240ms var(--ease-standard) !important;
}
.ipv-image-next-enter-from {
  opacity: 0;
  transform: translateX(36rem) scale(0.985) !important;
}
.ipv-image-next-leave-to {
  opacity: 0;
  transform: translateX(-36rem) scale(0.985) !important;
}
.ipv-image-previous-enter-from {
  opacity: 0;
  transform: translateX(-36rem) scale(0.985) !important;
}
.ipv-image-previous-leave-to {
  opacity: 0;
  transform: translateX(36rem) scale(0.985) !important;
}
.ipv-nav {
  position: absolute;
  z-index: var(--z-local-top);
  top: 50%;
  width: 42rem;
  height: 54rem;
  border: 0;
  border-radius: 10rem;
  background: rgba(0, 0, 0, 0.38);
  color: #fff;
  cursor: pointer;
  font-size: 34rem;
  line-height: 1;
  transform: translateY(-50%);
  transition: background-color 140ms ease;
}
.ipv-nav:hover {
  background: rgba(0, 0, 0, 0.58);
}
.ipv-nav:active {
  transform: translateY(-50%) scale(0.98);
}
.ipv-nav--previous {
  left: 18rem;
}
.ipv-nav--next {
  right: 18rem;
}
</style>
