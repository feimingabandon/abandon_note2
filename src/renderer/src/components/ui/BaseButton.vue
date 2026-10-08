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
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  type: { type: String, default: 'button' }
})

const emit = defineEmits(['click'])
</script>

<template>
  <button
    class="base-btn"
    :type="type"
    :class="[`btn--${variant}`, `btn--${size}`]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
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
  gap: 6rem;
  min-height: max(28px, 30rem);
  padding: 6rem 12rem;
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
.base-btn:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 2px;
}
.base-btn[aria-haspopup]:active:not(:disabled) {
  transform: none;
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
  background-color: var(--ui-primary);
  border-color: var(--ui-primary);
  color: var(--ui-on-primary);
}
.btn--primary:hover:not(:disabled) {
  background-color: var(--ui-primary-hover);
}

.btn--danger {
  background-color: var(--ui-danger-solid);
  color: var(--ui-on-danger);
}
.btn--danger:hover:not(:disabled) {
  background-color: var(--ui-danger-hover);
}
.btn--text,
.btn--icon {
  background: transparent;
}
.btn--icon {
  min-width: max(28px, 30rem);
  padding: 5rem;
}
.btn--text:hover:not(:disabled),
.btn--icon:hover:not(:disabled) {
  background: var(--ui-fill-hover);
}

/* ---- 尺寸 ---- */
.btn--sm {
  min-height: max(26px, 26rem);
  padding: 4rem 10rem;
  font-size: var(--fs-secondary);
  border-radius: 6rem;
}
.btn--lg {
  min-height: max(28px, 34rem);
  padding: 8rem 16rem;
  font-size: var(--fs-body);
}
</style>
