<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import HelpButton from '../ui/HelpButton.vue'
import { ownPopover, popoverStyle, releasePopover } from '../../utils/anchoredPopover.js'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'
import { isComposingInput } from '../../utils/inputComposition.js'

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  disabled: { type: Boolean, default: false },
  disabledReason: { type: String, default: '' },
  helpText: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])
const capability = window.api?.runtimeCapabilities?.systemNotifications || { supported: true }
const options = [
  { bit: 1, label: '系统提醒', short: '系统' },
  { bit: 2, label: '软件内弹窗', short: '弹窗' },
  { bit: 4, label: '托盘闪烁', short: '托盘' }
]
const id = useId()
const open = ref(false)
const triggerRef = ref(null)
const panelRef = ref(null)
const contentRef = ref(null)
const panelStyle = ref({})
let ownedPanel = null
let resizeObserver
let focusEdge = null

const displayLabel = computed(() => {
  if (props.disabled) return '无需提醒'
  const selected = options.filter((option) => props.modelValue & option.bit)
  if (!selected.length) return '不提醒'
  if (selected.length === 3) return '全部三种'
  return selected.length === 1 ? selected[0].label : selected.map((o) => o.short).join('、')
})
const isUnavailable = (option) => option.bit === 1 && !capability.supported

function isTriggerVisible(rect) {
  let left = Math.max(0, rect.left)
  let top = Math.max(0, rect.top)
  let right = Math.min(window.innerWidth, rect.right)
  let bottom = Math.min(window.innerHeight, rect.bottom)
  // Teleport escapes clipping, so intersect the anchor with every clipping ancestor.
  for (let ancestor = triggerRef.value.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const bounds = ancestor.getBoundingClientRect()
    if (style.overflowX !== 'visible') {
      left = Math.max(left, bounds.left + ancestor.clientLeft)
      right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth)
    }
    if (style.overflowY !== 'visible') {
      top = Math.max(top, bounds.top + ancestor.clientTop)
      bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight)
    }
  }
  return right > left && bottom > top
}

function updatePanelPosition() {
  if (!open.value || !triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  if (!isTriggerVisible(rect)) {
    // Keep keyboard focus in the form without scrolling the hidden anchor back into view.
    close(panelRef.value?.contains(document.activeElement))
    return
  }
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  const width = Math.min(232 * rem, window.innerWidth - 16)
  panelStyle.value = popoverStyle(
    { ...rect.toJSON(), left: rect.right - width },
    width,
    (contentRef.value?.scrollHeight || 190 * rem) + 2
  )
}

function close(restoreFocus = false) {
  open.value = false
  focusEdge = null
  if (restoreFocus) triggerRef.value?.focus({ preventScroll: true })
}
function toggle() {
  if (props.disabled) return
  if (open.value) close(true)
  else open.value = true
}
function change(option) {
  if (props.disabled || isUnavailable(option)) return
  emit('update:modelValue', props.modelValue ^ option.bit)
}
function enabledOptions() {
  return [...(panelRef.value?.querySelectorAll('button:not(:disabled)') || [])]
}
function onTriggerKeydown(event) {
  if (isComposingInput(event) || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  if (open.value) {
    const buttons = enabledOptions()
    buttons[event.key === 'ArrowUp' ? buttons.length - 1 : 0]?.focus({ preventScroll: true })
  } else {
    focusEdge = event.key === 'ArrowUp' ? 'last' : 'first'
    open.value = true
  }
}
function onPanelKeydown(event) {
  if (isComposingInput(event)) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  } else if (event.key === 'Tab') {
    // Return to the form's DOM order before the browser moves focus out of Teleport.
    close(true)
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const buttons = enabledOptions()
    const index = buttons.indexOf(document.activeElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus({ preventScroll: true })
    buttons[next]?.scrollIntoView({ block: 'nearest' })
  }
}
function onOutside(event) {
  if (
    !open.value ||
    triggerRef.value?.contains(event.target) ||
    panelRef.value?.contains(event.target)
  )
    return
  close()
}
function onScroll(event) {
  // Only scrolling the trigger's ancestors changes its anchor. Background lists
  // may scroll while a modal is open; those events must not dismiss this menu.
  if (event.target === document || event.target?.contains?.(triggerRef.value)) updatePanelPosition()
}
function cleanupPanel() {
  releasePopover(ownedPanel)
  ownedPanel = null
  resizeObserver?.disconnect()
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', updatePanelPosition)
}
watch(open, async (value) => {
  if (!value) {
    cleanupPanel()
    return
  }
  await nextTick()
  if (!open.value || !panelRef.value) return
  updatePanelPosition()
  if (!open.value) return
  ownedPanel = panelRef.value
  ownPopover(ownedPanel, triggerRef.value)
  resizeObserver = new ResizeObserver(updatePanelPosition)
  resizeObserver.observe(contentRef.value)
  resizeObserver.observe(triggerRef.value)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', updatePanelPosition)
  const buttons = enabledOptions()
  const target =
    focusEdge === 'last'
      ? buttons.at(-1)
      : focusEdge === 'first'
        ? buttons[0]
        : buttons.find((button) => button.getAttribute('aria-checked') === 'true') || buttons[0]
  focusEdge = null
  target?.focus({ preventScroll: true })
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
  cleanupPanel()
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('focusin', onOutside)
})
</script>

<template>
  <div class="reminder-channels">
    <div class="reminder-channels__row">
      <span class="reminder-channels__label"
        >提醒方式<HelpButton v-if="helpText" :text="helpText"
      /></span>
      <button
        ref="triggerRef"
        type="button"
        class="reminder-channels__trigger"
        :class="{ 'is-open': open }"
        :disabled="disabled"
        :aria-label="'提醒方式：' + displayLabel"
        :aria-describedby="disabled && disabledReason ? id + '-reason' : undefined"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-controls="open ? id + '-menu' : undefined"
        @click="toggle"
        @keydown="onTriggerKeydown"
      >
        <span>{{ displayLabel }}</span>
        <svg viewBox="0 0 12 8" class="reminder-channels__arrow" aria-hidden="true">
          <path
            d="m2 2 4 4 4-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
    <p v-if="disabled && disabledReason" :id="id + '-reason'" class="reminder-channels__reason">
      {{ disabledReason }}
    </p>
    <Teleport to="body">
      <Transition
        :css="false"
        @enter="(el, done) => enterPopover(el, done, 'dropdown')"
        @leave="(el, done) => leavePopover(el, done, 'dropdown')"
      >
        <div
          v-if="open"
          ref="panelRef"
          class="reminder-channels__panel"
          :style="panelStyle"
          @keydown="onPanelKeydown"
          @click.stop
        >
          <div ref="contentRef" class="reminder-channels__content scroll-y">
            <div class="reminder-channels__heading">
              <span :id="id + '-title'">提醒方式</span><span>可多选</span>
            </div>
            <div :id="id + '-menu'" role="menu" :aria-labelledby="id + '-title'">
              <button
                v-for="option in options"
                :key="option.bit"
                type="button"
                class="reminder-channels__option"
                role="menuitemcheckbox"
                tabindex="-1"
                :aria-checked="!!(modelValue & option.bit)"
                :disabled="isUnavailable(option)"
                :title="isUnavailable(option) ? capability.reason : undefined"
                :data-channel="option.bit"
                @click="change(option)"
              >
                <span>{{ option.label }}</span>
                <svg
                  viewBox="0 0 16 16"
                  class="reminder-channels__check"
                  :class="{ 'is-selected': modelValue & option.bit }"
                  aria-hidden="true"
                >
                  <path
                    d="m3 8 3 3 7-7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
            <p v-if="!capability.supported" class="reminder-channels__capability">
              {{ capability.reason }}
            </p>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.reminder-channels {
  width: 100%;
  min-width: 0;
}
.reminder-channels__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
  min-height: 32rem;
}
.reminder-channels__label {
  flex-shrink: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 500;
}
.reminder-channels__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  width: max-content;
  min-width: 116rem;
  max-width: 100%;
  padding: 5rem 10rem;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
  background: var(--ui-surface-control);
  border: 1px solid var(--ui-border-control);
  border-radius: 6rem;
  cursor: pointer;
  transition: border-color var(--motion-control) ease;
}
.reminder-channels__trigger > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.reminder-channels__trigger:hover:not(:disabled),
.reminder-channels__trigger.is-open {
  border-color: var(--ui-border-hover);
}
.reminder-channels__trigger:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 2px;
}
.reminder-channels__trigger:disabled {
  color: var(--text-color-secondary);
  cursor: default;
}
.reminder-channels__arrow {
  flex-shrink: 0;
  width: 10rem;
  height: 6rem;
  opacity: 0.5;
  transition: transform var(--motion-control) var(--ease-standard);
}
.reminder-channels__trigger.is-open .reminder-channels__arrow {
  transform: rotate(180deg);
}
.reminder-channels__trigger:disabled .reminder-channels__arrow {
  visibility: hidden;
}
.reminder-channels__reason {
  margin: 5rem 0 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  line-height: 1.5;
}
.reminder-channels__panel {
  z-index: var(--z-global-popover);
  overflow: hidden;
  border: 1px solid var(--surface-float-border);
  border-radius: 12rem;
  background: var(--surface-float);
  color: var(--text-color);
  font-size: var(--fs-secondary);
  box-shadow:
    0 12rem 32rem rgba(0, 0, 0, 0.18),
    0 2rem 8rem rgba(0, 0, 0, 0.08);
}
.reminder-channels__content {
  padding: 6rem;
  max-height: calc(var(--popover-available-height) - 2px);
}
.reminder-channels__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
  padding: 7rem 10rem 9rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.85);
}
.reminder-channels__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rem;
  width: 100%;
  min-height: 38rem;
  padding: 8rem 10rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: color var(--motion-fast) ease;
}
.reminder-channels__option:hover:not(:disabled) {
  color: var(--ui-accent);
}
.reminder-channels__option:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: -2px;
}
.reminder-channels__option:disabled {
  color: var(--text-color-secondary);
  opacity: 0.5;
  cursor: default;
}
.reminder-channels__check {
  width: 16rem;
  height: 16rem;
  flex-shrink: 0;
  color: var(--ui-accent);
  opacity: 0;
  transition: opacity var(--motion-fast) ease;
}
.reminder-channels__check.is-selected {
  opacity: 1;
}
.reminder-channels__capability {
  margin: 6rem 10rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  line-height: 1.5;
}
</style>
