<script setup>
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { ownPopover, pointerMenuStyle, releasePopover } from '../../utils/anchoredPopover.js'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

defineProps({ disabled: Boolean, inPreview: Boolean })
const emit = defineEmits(['copy'])
const visible = ref(false)
const panel = ref(null)
const position = ref({})
let trigger = null
let generation = 0

function close(restoreFocus = false) {
  generation++
  visible.value = false
  releasePopover(panel.value)
  document.removeEventListener('pointerdown', outside)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('scroll', dismiss, true)
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true })
  trigger = null
}
function dismiss(event) {
  if (event?.type === 'scroll' && panel.value?.contains(event.target)) return
  close()
}
function outside(event) {
  if (!panel.value?.contains(event.target)) close()
}
function onKeydown(event) {
  if (event.isComposing) return
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    panel.value?.querySelector('button')?.focus()
  }
}
async function open(event) {
  event.preventDefault()
  event.stopPropagation()
  close()
  trigger = event.currentTarget
  const ticket = generation
  position.value = { left: `${event.clientX}px`, top: `${event.clientY}px` }
  visible.value = true
  await nextTick()
  if (ticket !== generation || !panel.value || !trigger?.isConnected) return
  ownPopover(panel.value, trigger)
  position.value = pointerMenuStyle(event.clientX, event.clientY, panel.value)
  const focusTarget = panel.value.querySelector('button:not(:disabled)') || panel.value
  focusTarget.focus({ preventScroll: true })
  document.addEventListener('pointerdown', outside)
  window.addEventListener('resize', dismiss)
  window.addEventListener('scroll', dismiss, true)
}
function copy() {
  close(true)
  emit('copy')
}
defineExpose({ open, close })
onBeforeUnmount(() => close())
</script>

<template>
  <Teleport to="body" :disabled="inPreview">
    <Transition :css="false" @enter="enterPopover" @leave="leavePopover">
      <div
        v-if="visible"
        ref="panel"
        class="image-copy-menu"
        :class="{ 'image-copy-menu--preview': inPreview }"
        :style="position"
        role="menu"
        tabindex="-1"
        aria-label="图片操作"
        @keydown="onKeydown"
        @click.stop
        @contextmenu.prevent.stop
      >
        <button type="button" role="menuitem" :disabled="disabled" @click="copy">
          {{ disabled ? '正在复制…' : '复制图片' }}
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.image-copy-menu {
  position: fixed;
  z-index: var(--z-global-popover);
  width: max-content;
  min-width: 112rem;
  padding: 5rem;
  border: 1px solid var(--surface-float-border);
  border-radius: var(--ui-menu-radius);
  background: var(--surface-float);
  box-shadow: var(--ui-menu-shadow);
  overflow: auto;
}
.image-copy-menu--preview {
  z-index: var(--z-local-top);
}
.image-copy-menu button {
  width: 100%;
  min-height: var(--ui-menu-row-height);
  padding: 7rem 9rem;
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.image-copy-menu button:hover:not(:disabled),
.image-copy-menu button:focus-visible:not(:disabled) {
  outline: none;
  background: var(--ui-menu-highlight);
  color: var(--ui-menu-on-highlight);
}
.image-copy-menu button:disabled {
  opacity: 0.38;
  cursor: default;
}
</style>
