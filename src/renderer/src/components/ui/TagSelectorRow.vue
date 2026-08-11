<script setup>
import TagPinButton from './TagPinButton.vue'

defineProps({
  tag: { type: Object, required: true },
  selected: { type: Boolean, default: false }
})
defineEmits(['toggle', 'pin'])
</script>

<template>
  <div class="ts-panel-row" :class="{ selected }">
    <button
      type="button"
      class="ts-panel-select"
      :title="tag.name"
      @click="$emit('toggle', tag.id)"
    >
      <span
        class="ts-panel-dot"
        :style="{
          backgroundColor: tag.color || 'color-mix(in srgb, var(--text-color) 45%, transparent)'
        }"
      />
      <span class="ts-panel-name">{{ tag.name }}</span>
      <svg v-if="selected" class="ts-check" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m3 8.5 3 3 7-7" />
      </svg>
    </button>
    <TagPinButton
      :pinned="Number(tag.is_pinned) === 1"
      :label="tag.name"
      @toggle="$emit('pin', tag)"
    />
  </div>
</template>
