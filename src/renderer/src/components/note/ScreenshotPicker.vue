<script setup>
/**
 * ScreenshotPicker.vue — 截图 + 图片选择组件
 *
 * 包裹 ImagePicker，在其首位添加截图按钮。
 * 点击截图 → 主进程打开独立全屏窗口 → 用户选区 → 裁切 → 添加到 ImagePicker。
 */
import { ref } from 'vue'
import ImagePicker from './ImagePicker.vue'

const emit = defineEmits(['count-change', 'draft-change'])

defineProps({
  noteId: { type: Number, default: null },
  mode: { type: String, default: 'persist' }
})

const imagePickerRef = ref(null)
const capturing = ref(false)
const launching = ref(false)

async function onScreenshot() {
  if (capturing.value) return
  capturing.value = true
  launching.value = true
  const stopListening = window.api.onScreenshotReady(() => {
    launching.value = false
  })
  try {
    const cropped = await window.api.captureScreen()
    if (!cropped) return
    const ts = Date.now()
    imagePickerRef.value?.addImage(cropped, 'png', `截图_${ts}.png`, 0)
  } catch (e) {
    console.error('[ScreenshotPicker] 截图失败:', e)
  } finally {
    stopListening()
    launching.value = false
    capturing.value = false
  }
}

// ---- 透传 ----
function getImages() {
  return imagePickerRef.value?.getImages() || []
}
function clearImages() {
  imagePickerRef.value?.clearImages()
}

function getDraftChanges() {
  return imagePickerRef.value?.getDraftChanges() || { addedImages: [], deletedImageIds: [] }
}

defineExpose({ getImages, getDraftChanges, clearImages })
</script>

<template>
  <ImagePicker
    ref="imagePickerRef"
    :note-id="noteId"
    :mode="mode"
    @count-change="(n) => emit('count-change', n)"
    @draft-change="(changes) => emit('draft-change', changes)"
  >
    <template #leading>
      <!-- 与添加入口、缩略图共用同一个流式布局 -->
      <div
        class="sp-btn"
        :class="{ 'sp-btn--busy': capturing }"
        title="截图"
        role="button"
        :aria-disabled="capturing"
        @click="onScreenshot"
      >
        <Transition name="sp-content" mode="out-in">
          <div v-if="launching" key="busy" class="sp-btn__content">
            <div class="sp-btn__spinner" />
            <span class="sp-btn__text">启动中…</span>
          </div>
          <div v-else key="idle" class="sp-btn__content">
            <svg
              class="sp-btn__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M20 7h-3.2l-1.5-2.2H8.7L7.2 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z"
              />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <span class="sp-btn__text">截图</span>
          </div>
        </Transition>
      </div>
    </template>
  </ImagePicker>
</template>

<style scoped>
.sp-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rem;
  width: 100%;
  min-width: 0;
  aspect-ratio: 1;
  border: 1px dashed var(--ui-border-control);
  border-radius: 6rem;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
  flex-shrink: 0;
  background: transparent;
}
.sp-btn:hover {
  border-color: var(--ui-border-hover);
}
.sp-btn:active:not(.sp-btn--busy) {
  transform: scale(0.98);
  transition-duration: 70ms;
}
.sp-btn__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rem;
}
.sp-content-enter-active,
.sp-content-leave-active {
  transition:
    opacity var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}
.sp-content-enter-from,
.sp-content-leave-to {
  opacity: 0;
  transform: scale(0.94);
}
.sp-btn__icon {
  display: block;
  flex: none;
  width: 24rem;
  height: 24rem;
  color: var(--text-color-secondary);
}
.sp-btn__text {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  user-select: none;
}
.sp-btn--busy {
  cursor: default;
  border-color: var(--ui-border-hover);
}
.sp-btn__spinner {
  width: 24rem;
  height: 24rem;
  border: 2.5rem solid color-mix(in srgb, var(--text-color) 15%, transparent);
  border-top-color: #0071e3;
  border-radius: 50%;
  animation: sp-spin 0.7s linear infinite;
}
@keyframes sp-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
