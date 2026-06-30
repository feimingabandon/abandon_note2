<script setup>
/**
 * ConfirmDialog.vue — Apple 风格确认弹窗
 *
 * 职责：
 *   1. 居中弹出确认卡片，含标题、描述文字、确认/取消按钮
 *   2. 支持 danger / default 两种确认按钮风格
 *   3. 点击遮罩层 = 取消，避免误操作
 *
 * Props:
 *   visible      — Boolean  控制显隐，配合 v-model 使用
 *   title        — String   标题文字
 *   message      — String   描述文字
 *   confirmText  — String   确认按钮文字（默认「确认」）
 *   cancelText   — String   取消按钮文字（默认「取消」）
 *   variant      — String   确认按钮风格：'danger' | 'default'（默认 'default'）
 *
 * Events:
 *   update:visible — 关闭弹窗
 *   confirm        — 用户点击确认
 *   cancel         — 用户点击取消 / 遮罩
 */

import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import BaseButton from './BaseButton.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '确认' },
  cancelText: { type: String, default: '取消' },
  variant: { type: String, default: 'default' }
})

const emit = defineEmits(['update:visible', 'confirm', 'cancel'])

// ---- 动画控制 ----
const rendered = ref(props.visible)
const active = ref(false)
let animTimer = null

const close = (type) => {
  active.value = false
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
  async (val) => {
    if (val) {
      if (animTimer) { clearTimeout(animTimer); animTimer = null }
      rendered.value = true
      await nextTick()
      requestAnimationFrame(() => { active.value = true })
    } else if (rendered.value) {
      close()
    }
  }
)

onBeforeUnmount(() => {
  if (animTimer) clearTimeout(animTimer)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="rendered" class="confirm-overlay" :class="{ active }" @click.self="close()">
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
/* ---- 遮罩层 ---- */
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0);
  transition: background-color 250ms ease;
  pointer-events: none;
  border-radius: 12px;
  overflow: hidden;
}
.confirm-overlay.active {
  background-color: rgba(0, 0, 0, 0.35);
  pointer-events: auto;
}

/* ---- 卡片 ---- */
.confirm-card {
  width: 280rem;
  max-width: calc(100vw - 48rem);
  padding: 24rem;
  border-radius: 14rem;
  box-shadow:
    0 8px 40px rgba(0, 0, 0, 0.42),
    0 0 0 0.5px rgba(255, 255, 255, 0.12);

  /* 继承 .app-bg 的玻璃态风格 */
  background-color: rgb(var(--bg-color) / var(--popup-opacity));
  -webkit-backdrop-filter: blur(var(--bg-blur)) saturate(180%) contrast(100%) brightness(100%);
  backdrop-filter: blur(var(--bg-blur)) saturate(180%) contrast(100%) brightness(100%);
  border: calc(var(--bg-border) * 1px) solid rgba(255, 255, 255, 0.18);

  /* 入场动画 */
  transform: scale(0.92);
  opacity: 0;
  transition:
    transform 280ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity   220ms ease;
}
.confirm-card.active {
  transform: scale(1);
  opacity: 1;
}

/* ---- 标题 ---- */
.confirm-title {
  font-size: 16rem;
  font-weight: 600;
  color: var(--text-color);
  letter-spacing: -0.2rem;
  margin-bottom: 8rem;
}

/* ---- 描述文字 ---- */
.confirm-message {
  font-size: 13rem;
  font-weight: 400;
  color: var(--text-color);
  opacity: 0.6;
  line-height: 1.45;
  margin-bottom: 22rem;
}

/* ---- 按钮区 ---- */
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10rem;
}
</style>
