<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import { NOTE_TEXT_COLOR_PRESETS } from '../../../../shared/note-text-color-rules.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  anchorRect: { type: Object, default: null },
  selectedColor: { type: String, default: '' },
  hasColors: { type: Boolean, default: false },
  busy: { type: Boolean, default: false }
})

const emit = defineEmits(['update:visible', 'apply', 'clear-all'])
const popoverRef = ref(null)
const popoverStyle = ref({ left: '8px', top: '8px', visibility: 'hidden' })
const customColor = ref('#007aff')
const clearAllVisible = ref(false)

function close() {
  emit('update:visible', false)
}

function removeListeners() {
  document.removeEventListener('pointerdown', onOutsidePointerDown, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', close)
  window.removeEventListener('scroll', close, true)
}

function onOutsidePointerDown(event) {
  if (clearAllVisible.value || popoverRef.value?.contains(event.target)) return
  close()
}

function onKeydown(event) {
  if (event.key === 'Escape' && !clearAllVisible.value) close()
}

async function positionPopover() {
  const anchor = props.anchorRect
  if (!anchor) return
  popoverStyle.value = {
    left: `${Math.max(8, Number(anchor.left) || 0)}px`,
    top: `${Math.max(8, Number(anchor.bottom) + 8 || 0)}px`,
    visibility: 'hidden'
  }
  await nextTick()
  const panel = popoverRef.value
  if (!panel || !props.visible) return
  const panelRect = panel.getBoundingClientRect()
  const gap = 8
  const anchorWidth = Math.max(
    0,
    Number(anchor.width) || Number(anchor.right) - Number(anchor.left)
  )
  const centeredLeft = Number(anchor.left) + anchorWidth / 2 - panelRect.width / 2
  const left = Math.max(gap, Math.min(centeredLeft, window.innerWidth - panelRect.width - gap))
  const topCandidate = Number(anchor.top) - panelRect.height - gap
  const below = Number(anchor.bottom) + gap
  const top =
    topCandidate >= gap
      ? topCandidate
      : Math.min(below, window.innerHeight - panelRect.height - gap)
  popoverStyle.value = { left: `${left}px`, top: `${Math.max(gap, top)}px` }
}

function applyColor(color) {
  emit('apply', color)
}

function requestClearAll() {
  if (!props.hasColors || props.busy) return
  close()
  clearAllVisible.value = true
}

watch(
  () => props.selectedColor,
  (color) => {
    if (/^#[0-9a-f]{6}$/i.test(color || '')) customColor.value = color.toLowerCase()
  },
  { immediate: true }
)

watch(
  () => props.visible,
  async (visible) => {
    removeListeners()
    if (!visible) return
    await positionPopover()
    document.addEventListener('pointerdown', onOutsidePointerDown, true)
    document.addEventListener('keydown', onKeydown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
  },
  { flush: 'post' }
)

watch(
  () => props.anchorRect,
  () => {
    if (props.visible) void positionPopover()
  },
  { deep: true }
)

onBeforeUnmount(removeListeners)
</script>

<template>
  <Teleport to="body">
    <Transition name="nl-text-color-popover">
      <section
        v-if="visible"
        ref="popoverRef"
        class="nl-text-color-popover"
        :style="popoverStyle"
        data-note-text-color-popover
        role="dialog"
        aria-label="设置所选文字颜色"
        @pointerdown.stop
        @click.stop
      >
        <div class="nl-text-color-popover__header">文字颜色</div>
        <div class="nl-text-color-popover__presets" role="group" aria-label="预设文字颜色">
          <button
            v-for="color in NOTE_TEXT_COLOR_PRESETS"
            :key="color"
            type="button"
            class="nl-text-color-popover__swatch"
            :class="{ 'is-selected': selectedColor === color }"
            :style="{ '--swatch-color': color }"
            :aria-label="`设置文字颜色 ${color}`"
            :aria-pressed="selectedColor === color"
            :disabled="busy"
            @pointerdown.prevent
            @click="applyColor(color)"
          />
        </div>
        <label class="nl-text-color-popover__custom">
          <span>自定义</span>
          <input
            v-model="customColor"
            type="color"
            aria-label="自定义文字颜色"
            :disabled="busy"
            @change="applyColor(customColor)"
          />
        </label>
        <div class="nl-text-color-popover__actions">
          <button type="button" :disabled="busy" @pointerdown.prevent @click="applyColor(null)">
            清除所选颜色
          </button>
          <button
            type="button"
            class="nl-text-color-popover__clear-all"
            :disabled="busy || !hasColors"
            @pointerdown.prevent
            @click="requestClearAll"
          >
            清除本便签全部颜色
          </button>
        </div>
      </section>
    </Transition>
  </Teleport>

  <ConfirmDialog
    v-model:visible="clearAllVisible"
    title="清除全部文字颜色？"
    message="当前便签正文中设置的全部局部文字颜色都会被清除，正文内容不会改变。"
    confirm-text="全部清除"
    cancel-text="取消"
    variant="danger"
    @confirm="emit('clear-all')"
  />
</template>

<style scoped>
.nl-text-color-popover {
  position: fixed;
  z-index: var(--z-global-popover);
  width: 196px;
  padding: 9px;
  border: 1px solid var(--surface-float-border);
  border-radius: 10px;
  background: var(--surface-float);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.2);
  color: var(--text-color);
}
.nl-text-color-popover__header {
  margin: 0 2px 7px;
  font-size: var(--fs-secondary);
  font-weight: 650;
}
.nl-text-color-popover__presets {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 6px;
}
.nl-text-color-popover__swatch {
  position: relative;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--swatch-color) 65%, var(--text-color));
  border-radius: 50%;
  background: var(--swatch-color);
  cursor: pointer;
}
.nl-text-color-popover__swatch.is-selected::after {
  position: absolute;
  inset: 5px;
  border: 2px solid white;
  border-radius: 50%;
  content: '';
}
.nl-text-color-popover__custom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding: 5px 7px;
  border: 1px solid var(--ui-border-control);
  border-radius: 8px;
  background: var(--ui-surface-control);
  color: var(--text-color);
  font-size: var(--fs-secondary);
}
.nl-text-color-popover__custom:focus-within {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 2px var(--ui-accent-subtle);
}
.nl-text-color-popover__custom input {
  width: 34px;
  height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.nl-text-color-popover__actions {
  display: grid;
  gap: 2px;
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid var(--ui-border-divider);
}
.nl-text-color-popover__actions button {
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
  text-align: left;
  cursor: pointer;
}
.nl-text-color-popover__actions button:hover:not(:disabled),
.nl-text-color-popover__actions button:focus-visible:not(:disabled) {
  outline: none;
  background: var(--ui-fill-hover);
}
.nl-text-color-popover__actions button:disabled {
  opacity: 0.38;
  cursor: default;
}
.nl-text-color-popover__actions .nl-text-color-popover__clear-all {
  color: var(--ui-danger);
}
.nl-text-color-popover-enter-active,
.nl-text-color-popover-leave-active {
  transition:
    opacity var(--motion-fast) var(--ease-standard),
    transform var(--motion-control) var(--ease-standard);
}
.nl-text-color-popover-enter-from,
.nl-text-color-popover-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
