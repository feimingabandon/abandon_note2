<script setup>
defineProps({
  styleVariant: {
    type: String,
    default: 'apple',
    validator: (value) => value === 'apple' || value === 'microsoft'
  }
})
</script>

<template>
  <div class="titlebar-actions-group" :class="`titlebar-actions-group--${styleVariant}`">
    <slot />
  </div>
</template>

<style scoped>
.titlebar-actions-group {
  display: flex;
  gap: 8px;
}

.titlebar-actions-group :deep(.titlebar-btn) {
  width: min(var(--titlebar-apple-control-size, 18rem), calc(18rem + 12px));
  height: min(var(--titlebar-apple-control-size, 18rem), calc(18rem + 12px));
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--text-color);
  background-color: #0071e3;
  cursor: pointer;
  transition:
    width var(--motion-control) var(--ease-standard),
    height var(--motion-control) var(--ease-standard),
    background-color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}

.titlebar-actions-group :deep(.btn-icon) {
  display: block;
  width: min(var(--titlebar-apple-icon-size, 14rem), calc(14rem + 9.333px));
  height: min(var(--titlebar-apple-icon-size, 14rem), calc(14rem + 9.333px));
  opacity: 0;
  transition:
    width var(--motion-control) var(--ease-standard),
    height var(--motion-control) var(--ease-standard),
    opacity 120ms ease;
}

.titlebar-actions-group:hover :deep(.btn-icon) {
  opacity: 1;
}

.titlebar-actions-group :deep(.titlebar-btn:active) {
  transform: scale(0.98);
  transition-duration: 70ms;
}

.titlebar-actions-group :deep(.titlebar-btn-template.is-active),
.titlebar-actions-group :deep(.titlebar-btn-help.is-active) {
  background-color: #34c759;
}

.titlebar-actions-group--microsoft {
  gap: 2rem;
}

.titlebar-actions-group--microsoft :deep(.titlebar-btn) {
  width: 32rem;
  height: 30rem;
  border-radius: 4rem;
  background-color: transparent;
}

.titlebar-actions-group--microsoft :deep(.btn-icon) {
  width: min(var(--titlebar-microsoft-icon-size, 15rem), 24rem);
  height: min(var(--titlebar-microsoft-icon-size, 15rem), 24rem);
  opacity: 0.72;
}

.titlebar-actions-group--microsoft :deep(.titlebar-btn:hover) {
  background-color: var(--ui-fill-hover);
}

.titlebar-actions-group--microsoft :deep(.titlebar-btn:hover .btn-icon) {
  opacity: 1;
}

.titlebar-actions-group--microsoft :deep(.titlebar-btn-template.is-active),
.titlebar-actions-group--microsoft :deep(.titlebar-btn-help.is-active) {
  background-color: color-mix(in srgb, #0078d4 18%, transparent);
}
</style>
