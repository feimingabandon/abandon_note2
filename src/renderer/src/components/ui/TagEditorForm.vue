<script setup>
import BaseButton from './BaseButton.vue'

defineProps({
  mode: { type: String, default: 'create' },
  name: { type: String, default: '' },
  color: { type: String, default: '' },
  colorText: { type: String, default: '' },
  error: { type: String, default: '' },
  usageText: { type: String, default: '' },
  saving: { type: Boolean, default: false },
  colorInvalid: { type: Boolean, default: false },
  colorPresets: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:name', 'update:color', 'update:color-text', 'cancel', 'save'])
</script>

<template>
  <div class="tm-editor-form">
    <div class="tm-editor-heading">
      <strong>{{ mode === 'edit' ? '修改标签' : '新建标签' }}</strong>
      <span v-if="mode === 'edit'">{{ usageText }}</span>
    </div>
    <input
      :value="name"
      maxlength="10"
      :disabled="saving"
      placeholder="标签名称"
      aria-label="标签名称"
      @input="emit('update:name', $event.target.value)"
    />
    <div class="tm-editor-color-row">
      <input
        type="color"
        :value="color || '#007aff'"
        :disabled="saving"
        aria-label="标签颜色"
        @input="emit('update:color', $event.target.value)"
      />
      <input
        :value="colorText"
        maxlength="7"
        :disabled="saving"
        placeholder="#007aff"
        aria-label="颜色值"
        @input="emit('update:color-text', $event.target.value)"
      />
    </div>
    <div class="tm-editor-colors" aria-label="预设颜色">
      <button
        v-for="preset in colorPresets"
        :key="preset"
        type="button"
        :disabled="saving"
        :class="{ active: color.toLowerCase() === preset }"
        :style="{ backgroundColor: preset }"
        :aria-label="`选择颜色 ${preset}`"
        @click="emit('update:color', preset)"
      />
    </div>
    <p v-if="error" class="tm-editor-error" role="alert">{{ error }}</p>
    <div class="tm-editor-actions">
      <BaseButton size="sm" :disabled="saving" @click="emit('cancel')">取消</BaseButton>
      <BaseButton
        variant="primary"
        size="sm"
        :disabled="!name.trim() || colorInvalid || saving"
        @click="emit('save')"
      >
        {{ saving ? '保存中…' : '保存' }}
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.tm-editor-form {
  padding: 12rem 16rem;
  border-bottom: 1px solid var(--ui-border-divider);
  background: var(--ui-surface-subtle);
}
.tm-editor-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12rem;
  margin-bottom: 8rem;
  font-size: var(--fs-secondary);
}
.tm-editor-heading span {
  overflow: hidden;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-editor-form > input,
.tm-editor-color-row input:not([type='color']) {
  min-width: 0;
  border: 1px solid var(--ui-border-control);
  border-radius: 7rem;
  outline: 0;
  background: var(--ui-surface-control);
  color: var(--text-color);
  font: inherit;
}
.tm-editor-form > input {
  width: 100%;
  padding: 7rem 10rem;
}
.tm-editor-form input:focus {
  border-color: #007aff;
}
.tm-editor-color-row {
  display: flex;
  gap: 8rem;
  margin-top: 8rem;
}
.tm-editor-color-row input[type='color'] {
  width: 30rem;
  height: 30rem;
  flex: 0 0 auto;
  padding: 2rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 6rem;
  background: var(--ui-surface-control);
}
.tm-editor-color-row input:not([type='color']) {
  flex: 1;
  padding: 6rem 9rem;
}
.tm-editor-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 7rem;
  margin-top: 9rem;
}
.tm-editor-colors button {
  width: 21rem;
  height: 21rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 120ms ease;
}
.tm-editor-colors button:hover:not(:disabled) {
  transform: scale(1.12);
}
.tm-editor-colors button:active:not(:disabled) {
  transform: scale(0.98);
}
.tm-editor-colors button.active {
  transform: scale(1.22);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text-color) 60%, transparent);
}
.tm-editor-colors button.active:active:not(:disabled) {
  transform: scale(1.18);
}
.tm-editor-colors button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.tm-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8rem;
  margin-top: 12rem;
}
.tm-editor-error {
  margin: 7rem 0 0;
  color: #ff3b30;
  font-size: calc(var(--fs-secondary) * 0.85);
}
</style>
