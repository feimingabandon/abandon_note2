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
  background-color: rgba(255, 255, 255, 0.06);
  cursor: pointer;
  outline: none;
  transition:
    background-color 150ms ease,
    border-color 150ms ease;
  white-space: nowrap;
}

.base-btn:hover:not(:disabled) {
  background-color: rgba(255, 255, 255, 0.12);
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
