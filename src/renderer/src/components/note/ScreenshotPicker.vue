<script setup>
/**
 * ScreenshotPicker.vue — 截图 + 图片选择组件
 *
 * 包裹 ImagePicker，在其首位添加截图按钮。
 * 点击截图 → 主进程打开独立全屏窗口 → 用户选区 → 裁切 → 添加到 ImagePicker。
 */
import { ref } from 'vue'
import ImagePicker from './ImagePicker.vue'

const emit = defineEmits(['count-change'])

defineProps({
  noteId: { type: Number, default: null },
  mode: { type: String, default: 'persist' }
})

const imagePickerRef = ref(null)
const capturing = ref(false)

async function onScreenshot() {
  capturing.value = true
  try {
    const cropped = await window.api.captureScreen()
    if (!cropped) { capturing.value = false; return }
    const ts = Date.now()
    imagePickerRef.value?.addImage(cropped, 'png', `截图_${ts}.png`, 0)
  } catch (e) {
    console.error('[ScreenshotPicker] 截图失败:', e)
  }
  capturing.value = false
}

// ---- 透传 ----
function getImages() {
  return imagePickerRef.value?.getImages() || []
}
function clearImages() {
  imagePickerRef.value?.clearImages()
}

defineExpose({ getImages, clearImages })
</script>

<template>
  <div class="sp-root">
    <!-- 截图按钮 — 始终在第一位 -->
    <div class="sp-btn" :class="{ 'sp-btn--busy': capturing }" title="截图" @click="capturing ? null : onScreenshot()">
      <Transition name="sp-content" mode="out-in">
        <div v-if="capturing" key="busy" class="sp-btn__content">
          <div class="sp-btn__spinner" />
          <span class="sp-btn__text">启动中…</span>
        </div>
        <div v-else key="idle" class="sp-btn__content">
          <svg class="sp-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
          <span class="sp-btn__text">截图</span>
        </div>
      </Transition>
    </div>

    <!-- 图片选择 -->
    <ImagePicker
      ref="imagePickerRef"
      :note-id="noteId"
      :mode="mode"
      class="sp-ip"
      @count-change="(n) => emit('count-change', n)"
    />
  </div>
</template>

<style scoped>
.sp-root {
  display: flex;
  flex-wrap: wrap;
  gap: 8rem;
  align-items: flex-start;
}

.sp-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rem;
  width: 100rem;
  aspect-ratio: 1;
  border: 1px dashed rgba(128, 128, 128, 0.2);
  border-radius: 6rem;
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.02);
}
.sp-btn:hover {
  border-color: rgba(128, 128, 128, 0.35);
  background: rgba(255, 255, 255, 0.04);
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
  transition: opacity var(--motion-fast) ease, transform var(--motion-control) var(--ease-standard);
}
.sp-content-enter-from,
.sp-content-leave-to {
  opacity: 0;
  transform: scale(0.94);
}
.sp-btn__icon {
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
  border-color: rgba(128, 128, 128, 0.12);
}
.sp-btn__spinner {
  width: 24rem;
  height: 24rem;
  border: 2.5rem solid rgba(128, 128, 128, 0.15);
  border-top-color: #0071e3;
  border-radius: 50%;
  animation: sp-spin 0.7s linear infinite;
}
@keyframes sp-spin {
  to { transform: rotate(360deg); }
}

.sp-ip {
  flex: 1;
  min-width: 0;
}
</style>
