<script setup>
import { ref, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  rows: { type: Number, default: 4 },
  minHeight: { type: Number, default: 60 },
  maxHeight: { type: Number, default: 300 }
})

const emit = defineEmits(['update:modelValue'])
const textareaRef = ref(null)
let dragging = false
let startY = 0
let startHeight = 0
let dragRaf = null

function onDragStart(event) {
  dragging = true
  startY = event.clientY
  startHeight = textareaRef.value?.clientHeight || 90
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
  event.preventDefault()
}

function onDragMove(event) {
  if (!dragging || !textareaRef.value || dragRaf) return
  dragRaf = requestAnimationFrame(() => {
    dragRaf = null
    const height = Math.max(props.minHeight, Math.min(props.maxHeight, startHeight + event.clientY - startY))
    textareaRef.value.style.height = `${height}px`
  })
}

function onDragEnd() {
  dragging = false
  if (dragRaf) cancelAnimationFrame(dragRaf)
  dragRaf = null
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}

function focus() {
  textareaRef.value?.focus()
}

onBeforeUnmount(onDragEnd)
defineExpose({ focus })
</script>

<template>
  <div class="rt-root">
    <textarea
      ref="textareaRef"
      class="rt-textarea"
      :value="modelValue"
      :placeholder="placeholder"
      :rows="rows"
      @input="emit('update:modelValue', $event.target.value)"
    />
    <div class="rt-resize" @mousedown="onDragStart">
      <div class="rt-resize__bar" />
    </div>
  </div>
</template>

<style scoped>
.rt-root { min-width: 0; }
.rt-textarea {
  display: block;
  width: 100%;
  min-height: 90rem;
  padding: 10rem 12rem;
  resize: none;
  border: 1rem solid rgb(var(--bg-color) / 0.1);
  border-radius: 8rem;
  outline: none;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-color);
  font-family: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  line-height: 1.5;
  transition: border-color 150ms ease;
}
.rt-textarea:focus { border-color: rgb(var(--bg-color) / 0.18); }
.rt-textarea::placeholder { color: var(--text-color-secondary); opacity: 0.5; }
.rt-resize {
  display: flex;
  justify-content: center;
  padding: 2rem 0 4rem;
  cursor: row-resize;
  user-select: none;
}
.rt-resize__bar {
  width: 32rem;
  height: 3rem;
  border-radius: 2rem;
  background: color-mix(in srgb, var(--text-color) 10%, transparent);
  transition: background-color 150ms ease;
}
.rt-resize:hover .rt-resize__bar {
  background: color-mix(in srgb, var(--text-color) 22%, transparent);
}
</style>
