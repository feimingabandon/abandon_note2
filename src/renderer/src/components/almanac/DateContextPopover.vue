<script setup>
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import DateContextDetails from './DateContextDetails.vue'
import { quickNoteEditorPosition } from '../../utils/quickNoteEditorPosition.js'
import {
  observePopover,
  ownPopover,
  ownedPopovers,
  releasePopover
} from '../../utils/anchoredPopover.js'
import { isComposingInput } from '../../utils/inputComposition.js'

const props = defineProps({
  dateKey: { type: String, required: true },
  anchor: { type: Object, required: true }
})
const emit = defineEmits(['close'])
const panel = ref(null)
const date = ref(props.dateKey)
const position = reactive({ left: '8px', top: '8px', visibility: 'hidden' })
let stopObserving
let focusFrame
let disposed = false

watch(
  () => props.dateKey,
  (value) => {
    date.value = value
  }
)

function reposition() {
  if (!panel.value || !props.anchor.isConnected) return
  const anchor = props.anchor.getBoundingClientRect()
  const placed = quickNoteEditorPosition(anchor, panel.value.getBoundingClientRect(), {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    padding: 8
  })
  position.left = `${placed.left}px`
  position.top = `${placed.top}px`
  position.visibility = 'visible'
  position['--date-context-offset'] = placed.top < anchor.top ? '4px' : '-4px'
}
function dismiss() {
  emit('close', false)
}
function containsTarget(target) {
  return (
    panel.value?.contains(target) ||
    ownedPopovers(panel.value).some((owned) => owned.contains(target))
  )
}
function onOutside(event) {
  if (containsTarget(event.target) || props.anchor.contains(event.target)) return
  dismiss()
}
function onKeydown(event) {
  if (event.key !== 'Escape' || event.defaultPrevented || isComposingInput(event)) return
  // DatePicker owns a Teleport surface. Its Escape must close only that inner surface.
  if (ownedPopovers(panel.value).length) return
  event.preventDefault()
  event.stopPropagation()
  emit('close', true)
}
function onScroll(event) {
  if (!containsTarget(event.target)) dismiss()
}
onMounted(async () => {
  ownPopover(panel.value, props.anchor)
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('focusin', onOutside)
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', reposition)
  window.addEventListener('blur', dismiss)
  window.addEventListener('abandon:date-context-open', dismiss)
  window.addEventListener('abandon:open-almanac', dismiss)
  await nextTick()
  if (disposed) return
  // 同步摘要锚点的几何、字号与主题，避免打开时切换深色后仍保留浅色文字。
  stopObserving = observePopover(panel.value, props.anchor, reposition, dismiss)
  reposition()
  focusFrame = requestAnimationFrame(() =>
    panel.value?.querySelector('button')?.focus({ preventScroll: true })
  )
})
onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(focusFrame)
  stopObserving?.()
  releasePopover(panel.value)
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('focusin', onOutside)
  document.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', reposition)
  window.removeEventListener('blur', dismiss)
  window.removeEventListener('abandon:date-context-open', dismiss)
  window.removeEventListener('abandon:open-almanac', dismiss)
})
</script>

<template>
  <section
    ref="panel"
    class="date-context-popover"
    :style="position"
    :data-date="date"
    role="dialog"
    :aria-label="`${date} 天气与宜忌`"
    @click.stop
    @dblclick.stop
    @pointerdown.stop
    @contextmenu.stop
    @keydown.stop
  >
    <header class="date-context-popover__header">
      <strong>天气与宜忌</strong>
      <button type="button" aria-label="关闭天气与宜忌详情" @click="emit('close', true)">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
      </button>
    </header>
    <DateContextDetails v-model="date" />
  </section>
</template>

<style scoped>
.date-context-popover {
  position: fixed;
  z-index: var(--z-global-popover);
  display: flex;
  flex-direction: column;
  gap: 12rem;
  width: min(480rem, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  padding: 14rem 16rem;
  box-sizing: border-box;
  border: 1px solid var(--ui-border-control);
  border-radius: 16rem;
  background: var(--surface-float);
  box-shadow: var(--ui-menu-shadow);
  color: var(--text-color);
  font-size: var(--fs-secondary);
  line-height: 1.5;
}
.date-context-popover__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  flex: 0 0 auto;
}
.date-context-popover__header strong {
  font-size: var(--fs-secondary);
  font-weight: 600;
  line-height: 1.4;
}
.date-context-popover__header button {
  display: grid;
  width: 28rem;
  height: 28rem;
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: background var(--motion-fast) ease;
}
.date-context-popover__header button:hover {
  background: var(--ui-fill-hover);
}
.date-context-popover__header button:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 2px;
}
.date-context-popover__header svg {
  width: 16rem;
  height: 16rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}
</style>
