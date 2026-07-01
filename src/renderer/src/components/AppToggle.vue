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
})

const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <button
    class="switch"
    :class="{ on: modelValue }"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="switch-thumb" />
  </button>
</template>

<style scoped>
.switch {
  position: relative;
  width: 44rem;
  height: 24rem;
  border-radius: 12rem;
  border: none;
  padding: 0;
  cursor: pointer;
  background-color: rgba(255, 255, 255, 0.06);
  transition: background-color 200ms ease;
  flex-shrink: 0;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
}

.switch.on {
  background-color: #0071e3;
  border-color: #0071e3;
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
  width: 20rem;
  height: 20rem;
  border-radius: 50%;
  background: transparent;
  border: 3rem solid #ffffff;
  box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.2);
  transition: transform 200ms ease;
  transform: translateY(-50%);
}

.switch.on .switch-thumb {
  transform: translate(20rem, -50%);
}
</style>
