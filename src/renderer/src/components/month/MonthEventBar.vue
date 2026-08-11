<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

const props = defineProps({
  segment: { type: Object, required: true },
  note: { type: Object, required: true }
})
const accent = computed(() => {
  const tagColor = props.note.tags?.[0]?.color
  if (tagColor) return tagColor
  return { initialized: '#0a84ff', in_progress: '#ff9f0a', completed: '#8e8e93' }[props.note.status]
})
const fullTitle = computed(() => String(props.note.content || '').trim())
const previewText = computed(() => {
  const lines = String(props.note.content || '').split(/\r?\n/)
  return lines.map((line) => line.trim()).find(Boolean) || ''
})

const barRef = ref(null)
const tooltipRef = ref(null)
const tooltipVisible = ref(false)
const tooltipPlacement = ref('bottom')
const tooltipStyle = reactive({ top: '-9999px', left: '-9999px' })
const TOOLTIP_GAP = 8
const VIEWPORT_PADDING = 8
const PLACEMENTS = ['bottom', 'top', 'right', 'left']

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function rawPosition(trigger, width, height, placement) {
  const centerX = trigger.left + trigger.width / 2
  const centerY = trigger.top + trigger.height / 2
  if (placement === 'top') {
    return { left: centerX - width / 2, top: trigger.top - height - TOOLTIP_GAP }
  }
  if (placement === 'right') {
    return { left: trigger.right + TOOLTIP_GAP, top: centerY - height / 2 }
  }
  if (placement === 'left') {
    return { left: trigger.left - width - TOOLTIP_GAP, top: centerY - height / 2 }
  }
  return { left: centerX - width / 2, top: trigger.bottom + TOOLTIP_GAP }
}

function positionFits(position, width, height) {
  return (
    position.left >= VIEWPORT_PADDING &&
    position.top >= VIEWPORT_PADDING &&
    position.left + width <= window.innerWidth - VIEWPORT_PADDING &&
    position.top + height <= window.innerHeight - VIEWPORT_PADDING
  )
}

function pickPosition(trigger, width, height) {
  for (const placement of PLACEMENTS) {
    const position = rawPosition(trigger, width, height, placement)
    if (positionFits(position, width, height)) return { placement, ...position }
  }
  const placement = PLACEMENTS[0]
  const position = rawPosition(trigger, width, height, placement)
  return {
    placement,
    left: clamp(position.left, VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
    top: clamp(position.top, VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING)
  }
}

async function toggleTooltip() {
  if (tooltipVisible.value) {
    tooltipVisible.value = false
    return
  }
  tooltipStyle.top = '-9999px'
  tooltipStyle.left = '-9999px'
  tooltipVisible.value = true
  await nextTick()
  const trigger = barRef.value?.getBoundingClientRect()
  const tooltip = tooltipRef.value?.getBoundingClientRect()
  if (!trigger || !tooltip) return
  const position = pickPosition(trigger, tooltip.width, tooltip.height)
  tooltipPlacement.value = position.placement
  tooltipStyle.top = `${position.top}px`
  tooltipStyle.left = `${position.left}px`
}

function closeTooltip() {
  tooltipVisible.value = false
}

function onDocumentPointerDown(event) {
  if (!tooltipVisible.value) return
  if (barRef.value?.contains(event.target) || tooltipRef.value?.contains(event.target)) return
  closeTooltip()
}

function onKeydown(event) {
  if (event.key === 'Escape') closeTooltip()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', closeTooltip)
  window.addEventListener('scroll', closeTooltip, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', closeTooltip)
  window.removeEventListener('scroll', closeTooltip, true)
})
</script>

<template>
  <button
    ref="barRef"
    type="button"
    class="month-event-bar"
    :class="[
      `is-${note.status}`,
      { 'continues-before': segment.continuesBefore, 'continues-after': segment.continuesAfter }
    ]"
    :style="{
      '--event-accent': accent,
      '--event-lane': segment.lane,
      gridColumn: `${segment.columnStart} / span ${segment.columnSpan}`
    }"
    :data-preview="previewText"
    :aria-label="`${note.status === 'completed' ? '已完成：' : ''}${fullTitle}`"
    :aria-expanded="tooltipVisible"
    @click.stop="toggleTooltip"
  >
    <span v-if="!segment.continuesBefore" class="month-event-bar__dot" aria-hidden="true" />
    <span class="month-event-bar__text"
      >{{ note.status === 'completed' ? '已完成 · ' : '' }}{{ previewText }}</span
    >
    <span v-if="segment.continuesAfter" class="month-event-bar__continuation" aria-hidden="true"
      >›</span
    >
  </button>

  <Teleport to="body">
    <Transition name="month-event-tooltip">
      <section
        v-if="tooltipVisible"
        ref="tooltipRef"
        class="month-event-tooltip scroll-y"
        :class="`is-${tooltipPlacement}`"
        :style="tooltipStyle"
        role="tooltip"
      >
        {{ fullTitle }}
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.month-event-bar {
  position: relative;
  z-index: var(--z-local-overlay);
  display: flex;
  grid-row: 1;
  height: 19rem;
  align-items: center;
  align-self: start;
  gap: 5rem;
  min-width: 0;
  margin-block: 0;
  margin-inline: 6rem;
  padding: 0 7rem;
  border: 0;
  border-radius: 5rem;
  background: color-mix(in srgb, var(--event-accent) 82%, transparent);
  box-shadow: 0 1rem 3rem color-mix(in srgb, var(--event-accent) 22%, transparent);
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-size: var(--fs-month-event);
  line-height: 1;
  pointer-events: auto;
  transform: translateY(calc(var(--event-lane) * 22rem));
  transition:
    filter 140ms ease,
    transform 140ms ease;
}
.month-event-bar:hover {
  filter: brightness(1.08);
}
.month-event-bar:active {
  filter: brightness(0.94);
}
.month-event-bar.continues-before {
  margin-inline-start: 0;
  border-top-left-radius: 1rem;
  border-bottom-left-radius: 1rem;
}
.month-event-bar.continues-after {
  margin-inline-end: 0;
  border-top-right-radius: 1rem;
  border-bottom-right-radius: 1rem;
}
.month-event-bar.is-completed {
  opacity: 0.72;
}
.month-event-bar__dot {
  width: 5rem;
  height: 5rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentColor;
}
.month-event-bar__text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  white-space: nowrap;
}
.month-event-bar__continuation {
  margin-left: auto;
  opacity: 0.8;
}
</style>

<style>
.month-event-tooltip {
  position: fixed;
  z-index: var(--z-global-popover);
  width: max-content;
  max-width: min(320rem, calc(100vw - 16px));
  max-height: min(240rem, calc(100vh - 16px));
  padding: 9rem 12rem;
  overflow-wrap: anywhere;
  border: 1px solid var(--surface-float-border);
  border-radius: 8rem;
  background: var(--surface-float);
  box-shadow: 0 6rem 18rem rgba(0, 0, 0, 0.16);
  color: var(--text-color);
  font-size: var(--fs-secondary);
  font-weight: 500;
  line-height: 1.45;
  text-align: left;
  user-select: text;
  white-space: pre-wrap;
}
.month-event-tooltip::after {
  position: absolute;
  border: 5rem solid transparent;
  content: '';
}
.month-event-tooltip.is-bottom::after {
  bottom: 100%;
  left: 50%;
  border-bottom-color: var(--surface-float-border);
  transform: translateX(-50%);
}
.month-event-tooltip.is-top::after {
  top: 100%;
  left: 50%;
  border-top-color: var(--surface-float-border);
  transform: translateX(-50%);
}
.month-event-tooltip.is-right::after {
  top: 50%;
  right: 100%;
  border-right-color: var(--surface-float-border);
  transform: translateY(-50%);
}
.month-event-tooltip.is-left::after {
  top: 50%;
  left: 100%;
  border-left-color: var(--surface-float-border);
  transform: translateY(-50%);
}
.month-event-tooltip-enter-active,
.month-event-tooltip-leave-active {
  transition:
    opacity 150ms ease,
    transform 150ms ease;
}
.month-event-tooltip-enter-from,
.month-event-tooltip-leave-to {
  opacity: 0;
  transform: translateY(-3rem);
}
</style>
