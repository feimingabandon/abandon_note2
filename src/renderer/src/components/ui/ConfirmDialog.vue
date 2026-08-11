<script setup>
/**
 * ConfirmDialog.vue — Apple 风格确认弹窗
 *
 * 保持项目原有确认弹窗视觉，其他新弹窗以此为基准，不反向改造本组件。
 */

import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import BaseButton from './BaseButton.vue'
import { retainModalBlur } from '../../utils/modalBlur.js'
import {
  captureFocusedElement,
  focusModal,
  restoreFocusedElement,
  trapModalTab
} from '../../utils/modalFocus.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '确认' },
  cancelText: { type: String, default: '取消' },
  variant: { type: String, default: 'default' }
})

const emit = defineEmits(['update:visible', 'confirm', 'cancel'])
const rendered = ref(props.visible)
const active = ref(false)
const cardRef = ref(null)
let animTimer = null
let releaseBackgroundBlur = null
let focusFrame = null
let previouslyFocused = null

function acquireModalBlur() {
  if (releaseBackgroundBlur) return
  releaseBackgroundBlur = retainModalBlur()
}

function freeModalBlur() {
  releaseBackgroundBlur?.()
  releaseBackgroundBlur = null
}

function close(type) {
  if (animTimer) return
  active.value = false
  animTimer = setTimeout(() => {
    animTimer = null
    rendered.value = false
    freeModalBlur()
    const target = previouslyFocused
    previouslyFocused = null
    if (focusFrame !== null) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = null
      restoreFocusedElement(target)
    })
    emit('update:visible', false)
    if (type === 'confirm') emit('confirm')
    else emit('cancel')
  }, 250)
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
    return
  }
  trapModalTab(event, cardRef.value)
}

watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      if (animTimer) {
        clearTimeout(animTimer)
        animTimer = null
      }
      previouslyFocused = captureFocusedElement()
      acquireModalBlur()
      rendered.value = true
      await nextTick()
      if (focusFrame !== null) cancelAnimationFrame(focusFrame)
      focusFrame = requestAnimationFrame(() => {
        focusFrame = null
        active.value = true
        focusModal(cardRef.value)
      })
    } else if (rendered.value) {
      close()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (animTimer) clearTimeout(animTimer)
  if (focusFrame !== null) cancelAnimationFrame(focusFrame)
  restoreFocusedElement(previouslyFocused)
  freeModalBlur()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="rendered"
      class="confirm-overlay"
      data-modal-layer="confirm"
      :class="{ active }"
      data-keep-settings-open
      @click.self="close()"
    >
      <div
        ref="cardRef"
        class="confirm-card"
        :class="{ active }"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        :aria-label="title"
        @click.stop
        @keydown="onKeydown"
      >
        <h3 class="confirm-title">{{ title }}</h3>
        <p class="confirm-message">{{ message }}</p>
        <div class="confirm-actions">
          <BaseButton variant="default" size="md" @click="close()">
            {{ cancelText }}
          </BaseButton>
          <BaseButton :variant="variant" size="md" @click="close('confirm')">
            {{ confirmText }}
          </BaseButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-global-confirm);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--window-radius);
  background-color: rgba(0, 0, 0, 0);
  pointer-events: none;
  transition: background-color 220ms ease;
}

.confirm-overlay.active {
  background-color: var(--surface-modal-scrim);
  pointer-events: auto;
}

.confirm-card {
  width: 280rem;
  max-width: calc(100vw - 48rem);
  padding: 24rem;
  border-radius: 14rem;
  background-color: var(--surface-modal);
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.42);
  opacity: 0;
  transform: translateY(6rem);
  transition:
    opacity var(--motion-control) ease,
    transform 220ms var(--ease-standard);
}

.confirm-card.active {
  opacity: 1;
  transform: translateY(0);
}

.confirm-title {
  margin-bottom: 8rem;
  color: var(--text-color);
  font-size: var(--fs-title);
  font-weight: 600;
  letter-spacing: -0.2rem;
}

.confirm-message {
  margin-bottom: 22rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 500;
  line-height: 1.45;
  white-space: pre-line;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10rem;
}
</style>
