<script setup>
/**
 * BaseButton.vue — 通用按钮组件
 *
 * Props:
 *   variant  — default / danger / primary
 *   size     — sm / md / lg
 *   disabled — 是否禁用
 *
 * Slots:
 *   default — 按钮内容
 */
defineProps({
  variant: { type: String, default: 'default' },
  size: { type: String, default: 'md' },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['click'])
</script>

<template>
  <button
    class="base-btn"
    :class="[`btn--${variant}`, `btn--${size}`]"
    :disabled="disabled"
    @click="emit('click', $event)"
  >
    <slot />
  </button>
</template>

<style scoped>
.base-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8rem;
  padding: 9rem 16rem;
  font-size: var(--fs-body);
  font-family: inherit;
  font-weight: 500;
  color: var(--text-color);
  background-color: var(--ui-surface-control);
  cursor: pointer;
  outline: none;
  transition:
    background-color var(--motion-fast) ease,
    border-color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
  white-space: nowrap;
}

.base-btn:hover:not(:disabled) {
  background-color: var(--ui-surface-control-hover);
}
.base-btn:active:not(:disabled) {
  transform: scale(0.98);
  transition-duration: 70ms;
}
.base-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* ---- 变体 ---- */
.btn--primary {
  background-color: #0071e3;
  border-color: #0071e3;
  color: var(--text-color);
}
.btn--primary:hover:not(:disabled) {
  background-color: #0077ed;
}

.btn--danger {
  background-color: rgba(255, 59, 48, 0.35);
  color: var(--text-color);
}
.btn--danger:hover:not(:disabled) {
  background-color: rgba(255, 59, 48, 0.55);
}

/* ---- 尺寸 ---- */
.btn--sm {
  padding: 6rem 12rem;
  font-size: var(--fs-secondary);
  border-radius: 6rem;
}
.btn--lg {
  padding: 12rem 24rem;
  font-size: var(--fs-body);
}
</style>
