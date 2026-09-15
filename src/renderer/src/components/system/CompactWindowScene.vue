<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { COMPACT_PRESENTATION } from '../../../../shared/compact-presentation.js'
import CompactIsland from './CompactIsland.vue'

const props = defineProps({
  mode: { type: String, default: 'expanded' },
  phase: { type: String, default: 'expanded' },
  transition: { type: Object, default: null },
  presentation: { type: Object, default: null }
})

const hostRef = ref(null)
const expandedLayerRef = ref(null)
const compactLayerRef = ref(null)
const changing = computed(() => Boolean(props.transition))
const expandedInteractive = computed(() => props.mode === 'expanded' && !changing.value)
const compactInteractive = computed(() => props.mode === 'compact' && !changing.value)
const compactStyle = computed(() => {
  const rect = props.presentation?.compact
  if (!rect) return null
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  }
})

let animationRevision = 0
let animations = []
let watchdog = null
let notifiedGeneration = null

function cancelAnimations() {
  animationRevision += 1
  if (watchdog) clearTimeout(watchdog)
  watchdog = null
  for (const animation of animations) animation.cancel()
  animations = []
}

function clipPath(rect, carrier, radius) {
  const right = Math.max(0, carrier.width - rect.x - rect.width)
  const bottom = Math.max(0, carrier.height - rect.y - rect.height)
  return `inset(${rect.y}px ${right}px ${bottom}px ${rect.x}px round ${radius}px)`
}

function opacityFrames(fromMode, toMode, layerMode) {
  const startsVisible = fromMode === layerMode
  const endsVisible = toMode === layerMode
  if (startsVisible && !endsVisible) {
    return [
      { opacity: 1, offset: 0 },
      { opacity: 0, offset: 0.48 },
      { opacity: 0, offset: 1 }
    ]
  }
  if (!startsVisible && endsVisible) {
    return [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: 0.38 },
      { opacity: 1, offset: 1 }
    ]
  }
  return [{ opacity: endsVisible ? 1 : 0 }, { opacity: endsVisible ? 1 : 0 }]
}

function notifyFinished(generation) {
  if (notifiedGeneration === generation) return
  notifiedGeneration = generation
  window.api.notifyCompactPresentationFinished?.(generation)
}

async function runPresentation(transition) {
  const generation = Number(transition?.generation)
  const presentation = props.presentation
  if (!Number.isInteger(generation) || !presentation) return

  cancelAnimations()
  const revision = animationRevision
  await nextTick()
  if (revision !== animationRevision || Number(props.transition?.generation) !== generation) return

  const root = hostRef.value?.closest('.app-root, .month-root')
  const expandedLayer = expandedLayerRef.value
  const compactLayer = compactLayerRef.value
  const carrier = presentation.carrier
  const fromRect = presentation[transition.from]
  const toRect = presentation[transition.to]
  if (!root || !expandedLayer || !compactLayer || !carrier || !fromRect || !toRect) {
    notifyFinished(generation)
    return
  }

  const duration = Math.max(0, Number(presentation.durationMs) || COMPACT_PRESENTATION.durationMs)
  const easing = presentation.easing || COMPACT_PRESENTATION.easing
  const radius = Math.max(0, Number(presentation.cornerRadius) || 0)
  const options = { duration, easing, fill: 'forwards' }

  try {
    animations = [
      root.animate(
        [
          { clipPath: clipPath(fromRect, carrier, radius) },
          { clipPath: clipPath(toRect, carrier, radius) }
        ],
        options
      ),
      expandedLayer.animate(opacityFrames(transition.from, transition.to, 'expanded'), options),
      compactLayer.animate(opacityFrames(transition.from, transition.to, 'compact'), options)
    ]
  } catch (error) {
    console.warn('[CompactWindowScene] 呈现动画不可用，直接提交目标状态:', error)
    notifyFinished(generation)
    return
  }

  const completion = Promise.allSettled(animations.map((animation) => animation.finished))
  const timeout = new Promise((resolve) => {
    watchdog = setTimeout(resolve, duration + 300)
  })
  await Promise.race([completion, timeout])
  if (revision !== animationRevision || Number(props.transition?.generation) !== generation) return
  notifyFinished(generation)
}

watch(
  () => props.transition,
  (transition) => {
    if (transition?.generation) void runPresentation(transition)
  },
  { immediate: true, flush: 'post' }
)

watch(
  () => [props.mode, props.presentation],
  async () => {
    if (props.transition) return
    cancelAnimations()
    await nextTick()
    const root = hostRef.value?.closest('.app-root, .month-root')
    const carrier = props.presentation?.carrier
    const rect = props.presentation?.[props.mode]
    if (root && carrier && rect) {
      root.style.clipPath = clipPath(
        rect,
        carrier,
        Math.max(0, Number(props.presentation.cornerRadius) || 0)
      )
    } else if (root) {
      root.style.clipPath = ''
    }
  },
  { immediate: true, flush: 'post' }
)

onBeforeUnmount(cancelAnimations)

function requestOppositeMode() {
  void window.api.toggleCompactWindow().catch((error) => {
    console.warn('[CompactWindowScene] 切换窗口目标失败:', error)
  })
}
</script>

<template>
  <section
    ref="hostRef"
    class="compact-presentation-host"
    :class="[`is-${phase}`, `is-mode-${mode}`, { 'is-changing': changing }]"
  >
    <div
      ref="expandedLayerRef"
      class="compact-presentation-layer compact-presentation-layer--expanded"
      :aria-hidden="!expandedInteractive"
      :inert="!expandedInteractive"
    >
      <slot />
    </div>

    <aside
      ref="compactLayerRef"
      class="compact-presentation-layer compact-presentation-layer--compact compact-window-scene"
      :style="compactStyle"
      :aria-hidden="!compactInteractive"
      :inert="!compactInteractive"
    >
      <CompactIsland :phase="phase" />
    </aside>

    <div
      v-if="changing"
      class="compact-transition-input"
      aria-hidden="true"
      @dblclick.stop="requestOppositeMode"
    />
  </section>
</template>

<style scoped>
.compact-presentation-host {
  position: absolute;
  z-index: var(--z-local-content);
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}

.compact-presentation-layer {
  position: absolute;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}

.compact-presentation-layer--expanded {
  z-index: var(--z-local-content);
  inset: 0;
  flex-direction: column;
  opacity: 0;
}

.compact-presentation-layer--compact {
  z-index: var(--z-local-raised);
  opacity: 0;
}

.compact-presentation-host.is-mode-expanded:not(.is-changing) .compact-presentation-layer--expanded,
.compact-presentation-host.is-mode-compact:not(.is-changing) .compact-presentation-layer--compact {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
}

.compact-presentation-host.is-changing .compact-presentation-layer {
  visibility: visible;
  will-change: opacity;
}

.compact-transition-input {
  position: absolute;
  inset: 0;
  z-index: var(--z-local-top);
  pointer-events: auto;
}
</style>
