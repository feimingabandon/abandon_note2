<script setup>
/**
 * AppToggle.vue — 开关切换组件
 *
 * Props:
 *   modelValue — 当前状态（v-model 绑定）
 *   disabled   — 是否禁用
 *
 * Events:
 *   update:modelValue — v-model 更新
 */

defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  size: { type: String, default: 'md' }
})

const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <button
    type="button"
    class="switch"
    :class="[{ on: modelValue }, `switch--${size}`]"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="switch-thumb" />
  </button>
</template>

<style scoped>
.switch {
  position: relative;
  --switch-width: 44rem;
  --switch-height: 24rem;
  width: var(--switch-width);
  height: var(--switch-height);
  border-radius: 99rem;
  border: none;
  padding: 0;
  cursor: pointer;
  background-color: var(--ui-fill-pressed);
  transition:
    background-color 220ms var(--ease-standard),
    transform var(--motion-fast) ease,
    opacity 170ms ease;
  flex-shrink: 0;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
}

.switch.on {
  background-color: var(--ui-primary);
  border-color: var(--ui-primary);
}
.switch--sm {
  --switch-width: 36rem;
  --switch-height: 20rem;
}
.switch::before {
  content: '';
  position: absolute;
  inset: -4px 0;
}
.switch:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 3px;
}

.switch:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.switch-thumb {
  position: absolute;
  top: 50%;
  left: 2rem;
  display: block;
  width: calc(var(--switch-height) - 4rem);
  height: calc(var(--switch-height) - 4rem);
  box-sizing: border-box;
  border-radius: 50%;
  background: var(--ui-on-primary);
  border: 1px solid var(--ui-border-control);
  box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.2);
  transition: transform 220ms var(--ease-standard);
  transform: translateY(-50%);
}

.switch.on .switch-thumb {
  transform: translate(calc(var(--switch-width) - var(--switch-height)), -50%);
}

.switch:active:not(:disabled) {
  transform: scale(0.98);
}
.switch:active:not(:disabled) .switch-thumb {
  transform: translateY(-50%);
}
.switch.on:active:not(:disabled) .switch-thumb {
  transform: translate(calc(var(--switch-width) - var(--switch-height)), -50%);
}
</style>
