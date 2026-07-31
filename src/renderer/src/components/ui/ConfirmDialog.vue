<script setup>
/**
 * ConfirmDialog.vue — Apple 风格确认弹窗
 *
 * 保持项目原有确认弹窗视觉，其他新弹窗以此为基准，不反向改造本组件。
 */

import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import BaseButton from './BaseButton.vue'
import { releaseModalBlur, retainModalBlur } from '../../utils/modalBlur.js'

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
let animTimer = null
let ownsModalBlur = false

function acquireModalBlur() {
  if (ownsModalBlur) return
  ownsModalBlur = true
  retainModalBlur()
}

function freeModalBlur() {
  if (!ownsModalBlur) return
  ownsModalBlur = false
  releaseModalBlur()
}

function close(type) {
  if (animTimer) return
  active.value = false
  freeModalBlur()
  animTimer = setTimeout(() => {
    animTimer = null
    rendered.value = false
    emit('update:visible', false)
    if (type === 'confirm') emit('confirm')
    else emit('cancel')
  }, 250)
}

watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      if (animTimer) {
        clearTimeout(animTimer)
        animTimer = null
      }
      acquireModalBlur()
      rendered.value = true
      await nextTick()
      requestAnimationFrame(() => {
        active.value = true
      })
    } else if (rendered.value) {
      close()
    }
  }
)

onBeforeUnmount(() => {
  if (animTimer) clearTimeout(animTimer)
  freeModalBlur()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="rendered"
      class="confirm-overlay"
      :class="{ active }"
      data-keep-settings-open
      @click.self="close()"
    >
      <div class="confirm-card" :class="{ active }" @click.stop>
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
  z-index: 40000;
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
  background-color: rgba(12, 14, 18, 0.14);
  pointer-events: auto;
}

.confirm-card {
  width: 280rem;
  max-width: calc(100vw - 48rem);
  padding: 24rem;
  border-radius: 14rem;
  background-color: rgb(var(--bg-color) / var(--glass-complex-opacity));
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
