<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import NoteTextColorPopover from './NoteTextColorPopover.vue'
import {
  applyNoteTextColorRange,
  buildNoteTextColorSegments,
  normalizeNoteTextColorRanges,
  reconcileNoteTextColorRanges
} from '../../../../shared/note-text-color-rules.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  colorRanges: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  rows: { type: Number, default: 4 },
  minHeight: { type: Number, default: 60 },
  maxHeight: { type: Number, default: 300 },
  initialFocus: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'update:colorRanges'])
const textareaRef = ref(null)
const mirrorRef = ref(null)
const popoverVisible = ref(false)
const popoverAnchor = ref(null)
const selectedRange = ref(null)
let dragging = false
let startY = 0
let startHeight = 0
let dragRaf = null

const effectiveRanges = computed(() =>
  normalizeNoteTextColorRanges(props.colorRanges, props.modelValue)
)
const segments = computed(() => buildNoteTextColorSegments(props.modelValue, effectiveRanges.value))
const selectedColor = computed(() => {
  const selected = selectedRange.value
  if (!selected) return ''
  return (
    effectiveRanges.value.find(
      (range) => range.start <= selected.start && range.end >= selected.end
    )?.color || ''
  )
})

function syncScroll() {
  if (!textareaRef.value || !mirrorRef.value) return
  mirrorRef.value.scrollTop = textareaRef.value.scrollTop
  mirrorRef.value.scrollLeft = textareaRef.value.scrollLeft
}

function closePopover() {
  popoverVisible.value = false
  selectedRange.value = null
}

function selectionAnchor(event) {
  if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
    return {
      left: event.clientX,
      right: event.clientX,
      top: event.clientY,
      bottom: event.clientY,
      width: 0,
      height: 0
    }
  }
  const rect = textareaRef.value?.getBoundingClientRect()
  if (!rect) return null
  return {
    left: rect.left + rect.width / 2,
    right: rect.left + rect.width / 2,
    top: rect.top + Math.min(rect.height, 42),
    bottom: rect.top + Math.min(rect.height, 42),
    width: 0,
    height: 0
  }
}

function showSelectionPopover(event) {
  const textarea = textareaRef.value
  if (!textarea) return
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const text = props.modelValue.slice(start, end)
  if (end <= start || !text.trim()) {
    closePopover()
    return
  }
  selectedRange.value = { start, end, text }
  popoverAnchor.value = selectionAnchor(event)
  popoverVisible.value = true
}

function onKeyup(event) {
  if (event.shiftKey && textareaRef.value?.selectionStart !== textareaRef.value?.selectionEnd) {
    showSelectionPopover()
  }
}

function onInput(event) {
  const nextContent = event.target.value
  const nextRanges = reconcileNoteTextColorRanges(
    effectiveRanges.value,
    props.modelValue,
    nextContent
  )
  closePopover()
  emit('update:modelValue', nextContent)
  emit('update:colorRanges', nextRanges)
}

function applyColor(color) {
  const selected = selectedRange.value
  const textarea = textareaRef.value
  if (!selected || !textarea) return
  const nextRanges = applyNoteTextColorRange(effectiveRanges.value, {
    content: props.modelValue,
    start: selected.start,
    end: selected.end,
    color
  })
  emit('update:colorRanges', nextRanges)
  popoverVisible.value = false
  requestAnimationFrame(() => {
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(selected.start, selected.end)
  })
}

function clearAllColors() {
  emit('update:colorRanges', [])
  closePopover()
  requestAnimationFrame(() => textareaRef.value?.focus({ preventScroll: true }))
}

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
    const height = Math.max(
      props.minHeight,
      Math.min(props.maxHeight, startHeight + event.clientY - startY)
    )
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

function focus(options) {
  textareaRef.value?.focus(options)
}

onBeforeUnmount(onDragEnd)
defineExpose({ focus })
</script>

<template>
  <div class="rt-root colored-text-editor">
    <div class="colored-text-editor__shell">
      <div ref="mirrorRef" class="colored-text-editor__mirror" aria-hidden="true">
        <span v-if="!modelValue" class="colored-text-editor__placeholder">{{ placeholder }}</span>
        <span
          v-for="segment in segments"
          v-else
          :key="`${segment.start}:${segment.end}:${segment.color || 'default'}`"
          :style="segment.color ? { color: segment.color } : undefined"
          >{{ segment.text }}</span
        >
      </div>
      <textarea
        ref="textareaRef"
        class="rt-textarea colored-text-editor__textarea"
        :value="modelValue"
        :rows="rows"
        :aria-label="placeholder || '便签正文'"
        :data-modal-initial-focus="initialFocus ? '' : null"
        spellcheck="false"
        @input="onInput"
        @scroll="syncScroll"
        @pointerup="showSelectionPopover"
        @keyup="onKeyup"
      />
    </div>
    <div class="rt-resize" @mousedown="onDragStart">
      <div class="rt-resize__bar" />
    </div>

    <NoteTextColorPopover
      v-model:visible="popoverVisible"
      :anchor-rect="popoverAnchor"
      :selected-color="selectedColor"
      :has-colors="effectiveRanges.length > 0"
      @apply="applyColor"
      @clear-all="clearAllColors"
    />
  </div>
</template>

<style scoped>
.colored-text-editor {
  min-width: 0;
}
.colored-text-editor__shell {
  position: relative;
  min-width: 0;
}
.colored-text-editor__mirror,
.colored-text-editor__textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 90rem;
  padding: 10rem 12rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 8rem;
  font-family: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: break-word;
  white-space: pre-wrap;
}
.colored-text-editor__mirror {
  position: absolute;
  inset: 0;
  overflow: auto;
  border-color: transparent;
  background: var(--ui-surface-control);
  color: var(--text-color);
  pointer-events: none;
  scrollbar-width: none;
}
.colored-text-editor__mirror::-webkit-scrollbar {
  display: none;
}
.colored-text-editor__placeholder {
  color: var(--text-color-secondary);
  opacity: 0.5;
}
.colored-text-editor__textarea {
  position: relative;
  resize: none;
  outline: none;
  background: transparent;
  caret-color: var(--text-color);
  color: transparent;
  -webkit-text-fill-color: transparent;
  transition: border-color 150ms ease;
}
.colored-text-editor__textarea:focus {
  border-color: var(--ui-border-hover);
}
.colored-text-editor__textarea::selection {
  background: var(--ui-accent-subtle);
  color: transparent;
  -webkit-text-fill-color: transparent;
}
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
