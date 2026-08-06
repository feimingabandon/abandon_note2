<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  constrainFrameToVisibleBounds,
  fitAspectFrame,
  mapFrameToSource
} from '../../utils/wallpaperCrop.js'
import { retainModalBlur } from '../../utils/modalBlur.js'
import AppSlider from '../ui/AppSlider.vue'

const props = defineProps({
  sourceData: { type: String, required: true },
  sourceId: { type: Number, default: null },
  closing: { type: Boolean, default: false }
})
const emit = defineEmits(['cancel', 'saved'])
const releaseBackgroundBlur = retainModalBlur()

const stageRef = ref(null)
const overlayRef = ref(null)
const imageSize = reactive({ width: 1, height: 1 })
const stageSize = reactive({ width: 1, height: 1 })
const targetSize = reactive({ width: 1, height: 1 })
const frame = reactive({ x: 0, y: 0, width: 1, height: 1 })
const zoom = ref(1)
const saving = ref(false)
const ready = ref(false)
const error = ref('')
let resizeObserver = null
let drag = null

const baseScale = computed(() =>
  Math.min(stageSize.width / imageSize.width, stageSize.height / imageSize.height)
)
const renderScale = computed(() => baseScale.value * zoom.value)
const imageRect = computed(() => {
  const width = imageSize.width * renderScale.value
  const height = imageSize.height * renderScale.value
  return {
    x: (stageSize.width - width) / 2,
    y: (stageSize.height - height) / 2,
    width,
    height
  }
})
const imageStyle = computed(() => ({
  width: `${imageRect.value.width}px`,
  height: `${imageRect.value.height}px`,
  transform: `translate(${imageRect.value.x}px, ${imageRect.value.y}px)`
}))
const frameStyle = computed(() => ({
  width: `${frame.width}px`,
  height: `${frame.height}px`,
  transform: `translate(${frame.x}px, ${frame.y}px)`
}))

function constrainFrame() {
  const constrained = constrainFrameToVisibleBounds({
    frame,
    imageRect: imageRect.value,
    stage: stageSize
  })
  frame.x = constrained.x
  frame.y = constrained.y
}

function layoutFrame({ reset = false } = {}) {
  const bounds = imageRect.value
  const ratio = targetSize.width / targetSize.height
  const fitted = fitAspectFrame({ bounds, stage: stageSize, ratio })
  if (reset || frame.width <= 1) {
    frame.width = fitted.width
    frame.height = fitted.height
    frame.x = (stageSize.width - frame.width) / 2
    frame.y = (stageSize.height - frame.height) / 2
  }
  constrainFrame()
}

function onPointerDown(event) {
  if (saving.value || !ready.value) return
  event.currentTarget.setPointerCapture(event.pointerId)
  drag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    fx: frame.x,
    fy: frame.y
  }
}
function onPointerMove(event) {
  if (!drag || drag.pointerId !== event.pointerId) return
  frame.x = drag.fx + event.clientX - drag.x
  frame.y = drag.fy + event.clientY - drag.y
  constrainFrame()
}
function onPointerEnd(event) {
  if (drag?.pointerId === event.pointerId) drag = null
}

function onModalKeydown(event) {
  if (event.key === 'Escape' && !saving.value) {
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
    return
  }
  if (event.key !== 'Tab') return
  const focusable = [
    ...overlayRef.value.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  ]
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === overlayRef.value)
  ) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function dataExtension(dataUrl) {
  const mime = /^data:image\/([^;]+);base64,/.exec(dataUrl)?.[1]?.toLowerCase()
  return mime === 'jpeg' ? 'jpg' : mime || 'png'
}

async function confirmCrop() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    const img = new Image()
    img.src = props.sourceData
    await img.decode()
    const scale = renderScale.value
    const sourceCrop = mapFrameToSource({
      frame,
      imageRect: imageRect.value,
      renderScale: scale,
      imageSize
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(targetSize.width))
    canvas.height = Math.max(1, Math.round(targetSize.height))
    canvas
      .getContext('2d')
      .drawImage(
        img,
        sourceCrop.x,
        sourceCrop.y,
        sourceCrop.width,
        sourceCrop.height,
        0,
        0,
        canvas.width,
        canvas.height
      )
    const croppedData = canvas.toDataURL('image/jpeg', 0.92)
    const payload = {
      sourceId: props.sourceId,
      original: props.sourceId
        ? null
        : { base64: props.sourceData.split(',')[1], ext: dataExtension(props.sourceData) },
      cropped: { base64: croppedData.split(',')[1], ext: 'jpg' },
      crop: {
        x: sourceCrop.x,
        y: sourceCrop.y,
        width: sourceCrop.width,
        height: sourceCrop.height,
        scale: zoom.value,
        targetWidth: canvas.width,
        targetHeight: canvas.height
      }
    }
    const record = await window.api.saveWallpaper(payload)
    emit('saved', record)
  } catch (cause) {
    console.error('[WallpaperCropEditor] 保存裁剪结果失败:', cause)
    error.value = cause?.message || '壁纸裁剪保存失败'
  } finally {
    saving.value = false
  }
}

watch(zoom, async () => {
  await nextTick()
  constrainFrame()
})

onMounted(async () => {
  await nextTick()
  overlayRef.value?.focus({ preventScroll: true })
  try {
    const [bounds] = await Promise.all([
      window.api.getWindowBounds(),
      new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => {
          imageSize.width = image.naturalWidth
          imageSize.height = image.naturalHeight
          resolve()
        }
        image.onerror = () => reject(new Error('无法读取待裁剪图片'))
        image.src = props.sourceData
      })
    ])
    targetSize.width = Math.max(240, Number(bounds?.width) || 600)
    targetSize.height = Math.max(240, Number(bounds?.height) || 800)
    resizeObserver = new ResizeObserver(([entry]) => {
      stageSize.width = entry.contentRect.width
      stageSize.height = entry.contentRect.height
      layoutFrame({ reset: frame.width <= 1 })
      ready.value = true
    })
    resizeObserver.observe(stageRef.value)
  } catch (cause) {
    console.error('[WallpaperCropEditor] 初始化裁剪界面失败:', cause)
    error.value = cause?.message || '初始化裁剪界面失败'
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  releaseBackgroundBlur()
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="overlayRef"
      class="wc-overlay"
      data-modal-layer="wallpaper-crop"
      :class="{ 'is-closing': closing }"
      role="presentation"
      data-keep-settings-open
      tabindex="-1"
      @keydown="onModalKeydown"
    >
      <section class="wc-dialog" role="dialog" aria-modal="true" aria-label="裁剪主页面壁纸">
        <header class="wc-header">
          <div>
            <h3>裁剪主页面壁纸</h3>
            <p>移动亮色区域，缩放图片以确定最终画面</p>
          </div>
          <button class="wc-close" :disabled="saving" aria-label="关闭" @click="emit('cancel')">
            ×
          </button>
        </header>

        <div ref="stageRef" class="wc-stage">
          <div v-if="!ready && !error" class="wc-loading">正在准备图片…</div>
          <img
            class="wc-image"
            :src="sourceData"
            alt="待裁剪壁纸"
            :style="imageStyle"
            draggable="false"
          />
          <div
            class="wc-frame"
            :style="frameStyle"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerEnd"
            @pointercancel="onPointerEnd"
          >
            <span class="wc-grid wc-grid-v1" /><span class="wc-grid wc-grid-v2" />
            <span class="wc-grid wc-grid-h1" /><span class="wc-grid wc-grid-h2" />
          </div>
        </div>

        <footer class="wc-footer">
          <label class="wc-zoom">
            <span>缩放</span>
            <AppSlider v-model="zoom" :min="1" :max="3" :step="0.01" />
            <span>{{ Math.round(zoom * 100) }}%</span>
          </label>
          <span v-if="error" class="wc-error">{{ error }}</span>
          <div class="wc-actions">
            <button class="wc-button" :disabled="saving" @click="emit('cancel')">取消</button>
            <button class="wc-button wc-primary" :disabled="saving || !ready" @click="confirmCrop">
              {{ saving ? '正在保存…' : '确认壁纸' }}
            </button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.wc-overlay {
  position: fixed;
  z-index: 60000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24rem;
  background: rgba(10, 12, 16, 0.48);
  animation: wc-in 180ms ease both;
}
.wc-overlay.is-closing {
  pointer-events: none;
  animation: wc-out 180ms ease both;
}
.wc-overlay.is-closing .wc-dialog {
  animation: wc-drop 180ms ease both;
}
.wc-dialog {
  display: flex;
  flex-direction: column;
  width: min(760rem, 94vw);
  height: min(660rem, 90vh);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--text-color) 12%, transparent);
  border-radius: 18rem;
  background: rgb(var(--bg-color));
  box-shadow: 0 28rem 80rem rgba(0, 0, 0, 0.38);
  animation: wc-rise 260ms cubic-bezier(0.32, 0.72, 0, 1) both;
}
.wc-header,
.wc-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rem;
  padding: 14rem 18rem;
}
.wc-header h3 {
  margin: 0;
  color: var(--text-color);
  font-size: var(--fs-body);
}
.wc-header p {
  margin: 3rem 0 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.wc-close {
  width: 28rem;
  height: 28rem;
  border: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  color: var(--text-color);
  font-size: 22rem;
  cursor: pointer;
}
.wc-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #17191d;
  touch-action: none;
}
.wc-image {
  position: absolute;
  inset: 0;
  max-width: none;
  max-height: none;
  object-fit: fill;
  user-select: none;
  pointer-events: none;
}
.wc-loading {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: grid;
  place-items: center;
  background: #17191d;
  color: rgba(255, 255, 255, 0.58);
  font-size: var(--fs-secondary);
}
.wc-frame {
  position: absolute;
  inset: 0;
  cursor: move;
  touch-action: none;
  border: 1.5px solid rgba(255, 255, 255, 0.92);
  box-shadow:
    0 0 0 9999px rgba(0, 0, 0, 0.62),
    0 0 0 1px rgba(0, 113, 227, 0.8);
  will-change: transform;
}
.wc-grid {
  position: absolute;
  background: rgba(255, 255, 255, 0.28);
  pointer-events: none;
}
.wc-grid-v1,
.wc-grid-v2 {
  top: 0;
  bottom: 0;
  width: 1px;
}
.wc-grid-v1 {
  left: 33.333%;
}
.wc-grid-v2 {
  left: 66.666%;
}
.wc-grid-h1,
.wc-grid-h2 {
  left: 0;
  right: 0;
  height: 1px;
}
.wc-grid-h1 {
  top: 33.333%;
}
.wc-grid-h2 {
  top: 66.666%;
}
.wc-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-height: 62rem;
}
.wc-zoom {
  display: flex;
  align-items: center;
  gap: 10rem;
  min-width: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.wc-zoom > span {
  white-space: nowrap;
}
.wc-zoom :deep(.slider-root) {
  flex: 1 1 auto;
  min-width: 60rem;
  width: auto;
}
.wc-error {
  grid-column: 1 / -1;
  grid-row: 2;
  color: #ff453a;
  font-size: var(--fs-secondary);
}
.wc-actions {
  display: flex;
  grid-column: 2;
  grid-row: 1;
  gap: 8rem;
}
.wc-button {
  padding: 7rem 15rem;
  border: 0;
  border-radius: 8rem;
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  color: var(--text-color);
  cursor: pointer;
}
.wc-primary {
  background: #0071e3;
  color: #fff;
}
.wc-button:disabled {
  opacity: 0.55;
  cursor: default;
}
@keyframes wc-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes wc-rise {
  from {
    opacity: 0;
    transform: translateY(12rem) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes wc-out {
  to {
    opacity: 0;
  }
}
@keyframes wc-drop {
  to {
    opacity: 0;
    transform: translateY(8rem) scale(0.985);
  }
}
</style>
