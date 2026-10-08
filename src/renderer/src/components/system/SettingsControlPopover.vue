<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { ownPopover, popoverStyle, releasePopover } from '../../utils/anchoredPopover.js'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'
import { isComposingInput } from '../../utils/inputComposition.js'

const props = defineProps({
  label: { type: String, required: true },
  summary: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  width: { type: Number, default: 300 }
})
const emit = defineEmits(['close'])
const id = useId()
const open = ref(false)
const triggerRef = ref(null)
const panelRef = ref(null)
const contentRef = ref(null)
const panelStyle = ref({})
let ownedPanel = null
let observer

function close(restoreFocus = false) {
  if (!open.value) return
  open.value = false
  emit('close')
  if (restoreFocus) triggerRef.value?.focus({ preventScroll: true })
}
function updatePosition() {
  if (!open.value || !triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const body = triggerRef.value.closest('.panel-body')?.getBoundingClientRect()
  if (body && (rect.bottom <= body.top || rect.top >= body.bottom)) {
    close(panelRef.value?.contains(document.activeElement))
    return
  }
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  const width = Math.min(props.width * rem, window.innerWidth - 16)
  const settings = triggerRef.value.closest('.settings-panel')
  panelStyle.value = {
    ...popoverStyle(
      { ...rect.toJSON(), left: rect.right - width },
      width,
      contentRef.value.scrollHeight + 2
    ),
    '--fs-body': getComputedStyle(settings || triggerRef.value).fontSize,
    '--fs-secondary': getComputedStyle(triggerRef.value).fontSize,
    fontSize: getComputedStyle(settings || triggerRef.value).fontSize
  }
}
function toggle() {
  if (props.disabled) return
  if (open.value) close(true)
  else open.value = true
}
function onOutside(event) {
  if (triggerRef.value?.contains(event.target) || panelRef.value?.contains(event.target)) return
  close()
}
function onScroll(event) {
  if (event.target === document || event.target?.contains?.(triggerRef.value)) updatePosition()
}
function onKeydown(event) {
  if (isComposingInput(event) || event.defaultPrevented) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  } else if (event.key === 'Tab') {
    const items = [
      ...panelRef.value.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
      )
    ]
    if (document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) close(true)
  }
}
function cleanup() {
  releasePopover(ownedPanel)
  ownedPanel = null
  observer?.disconnect()
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', updatePosition)
}
watch(open, async (value) => {
  if (!value) return cleanup()
  await nextTick()
  if (!open.value || !panelRef.value) return
  updatePosition()
  if (!open.value) return
  ownedPanel = panelRef.value
  ownPopover(ownedPanel, triggerRef.value)
  updatePosition()
  observer = new ResizeObserver(updatePosition)
  observer.observe(contentRef.value)
  observer.observe(triggerRef.value)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', updatePosition)
  panelRef.value
    .querySelector('button:not(:disabled), input:not(:disabled)')
    ?.focus({ preventScroll: true })
})
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close()
  }
)
onMounted(() => {
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('focusin', onOutside)
})
onBeforeUnmount(() => {
  cleanup()
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('focusin', onOutside)
})
</script>

<template>
  <div class="settings-control-popover">
    <button
      ref="triggerRef"
      type="button"
      class="settings-control-trigger"
      :class="{ 'is-open': open }"
      :disabled="disabled"
      :aria-label="`${label}：${summary}`"
      :title="`${label}：${summary}`"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="open ? id : undefined"
      @click="toggle"
      @keydown.down.prevent="open = !disabled"
    >
      <slot name="summary"
        ><span class="settings-control-summary">{{ summary }}</span></slot
      >
      <svg class="settings-control-arrow" viewBox="0 0 12 8" aria-hidden="true">
        <path d="m2 2 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </button>
    <Teleport to="body">
      <Transition
        :css="false"
        @enter="(el, done) => enterPopover(el, done, 'dropdown')"
        @leave="(el, done) => leavePopover(el, done, 'dropdown')"
      >
        <div
          v-if="open"
          :id="id"
          ref="panelRef"
          class="settings-control-panel"
          :style="panelStyle"
          data-keep-settings-open
          role="dialog"
          :aria-label="label"
          @keydown="onKeydown"
          @click.stop
        >
          <div ref="contentRef" class="settings-control-content scroll-y">
            <div class="settings-control-heading">
              <span>{{ label }}</span>
              <button type="button" aria-label="收起" @click="close(true)">×</button>
            </div>
            <slot />
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.settings-control-popover {
  min-width: 0;
  max-width: 100%;
}
.settings-control-trigger {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: max(26px, 1.85em);
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 3px 7px;
  border: 1px solid var(--ui-border-control);
  border-radius: 6rem;
  background: var(--ui-surface-control);
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
  transition: border-color var(--motion-control) ease;
}
.settings-control-trigger:hover:not(:disabled),
.settings-control-trigger.is-open {
  border-color: var(--ui-border-hover);
}
.settings-control-trigger:focus-visible,
.settings-control-heading button:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 2px;
}
.settings-control-trigger:disabled {
  opacity: 0.45;
  cursor: default;
}
.settings-control-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-control-arrow {
  flex: 0 0 9px;
  width: 9px;
  height: 6px;
  opacity: 0.6;
  transition: transform var(--motion-control) ease;
}
.is-open .settings-control-arrow {
  transform: rotate(180deg);
}
.settings-control-panel {
  z-index: var(--z-global-popover);
  overflow: hidden;
  border: 1px solid var(--surface-float-border);
  border-radius: 10rem;
  background: var(--surface-float);
  color: var(--text-color);
  font-size: var(--fs-body);
  box-shadow: 0 8rem 24rem rgb(0 0 0 / 18%);
}
.settings-control-content {
  max-height: calc(var(--popover-available-height) - 2px);
  padding: 10px;
}
.settings-control-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: var(--fs-secondary);
}
.settings-control-heading button {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.settings-control-heading button:hover {
  background: var(--ui-fill-hover);
}
.settings-control-panel :deep(.shortcut-recorder) {
  width: 100%;
}
.settings-control-panel :deep(.shortcut-recorder-field) {
  flex-basis: 100%;
  min-width: 0;
  font-size: var(--fs-secondary);
}
.settings-control-panel :deep(.shortcut-recorder-status) {
  font-size: var(--fs-secondary);
}
.settings-control-panel :deep(.base-btn) {
  padding: 5px 8px;
  font-size: var(--fs-secondary);
}
</style>
