<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { getTransitionTotalMs } from '../../composables/useSlidingWorkspace.js'
import CompactIsland from './CompactIsland.vue'

const props = defineProps({
  phase: { type: String, default: 'expanded' },
  transition: { type: Object, default: null }
})

const expandedLayerRef = ref(null)
const compactLayerRef = ref(null)
const stage = computed(() => props.transition?.stage || 'stable')
const direction = computed(() =>
  props.phase === 'collapsing' ? 'collapse' : props.phase === 'expanding' ? 'expand' : 'none'
)
const sourceMode = computed(() => (direction.value === 'expand' ? 'compact' : 'expanded'))
const targetMode = computed(() => (direction.value === 'collapse' ? 'compact' : 'expanded'))
const stableMode = computed(() =>
  ['compact', 'dragging'].includes(props.phase) ? 'compact' : 'expanded'
)
const expandedInteractive = computed(
  () => stage.value === 'stable' && stableMode.value === 'expanded'
)
const compactInteractive = computed(
  () => stage.value === 'stable' && stableMode.value === 'compact'
)

let completionRevision = 0
let completionTimer = null
let lastNotifiedStageKey = ''

function clearCompletion() {
  completionRevision += 1
  if (completionTimer !== null) clearTimeout(completionTimer)
  completionTimer = null
}

function currentStageLayer(currentStage) {
  const mode = currentStage === 'content-exit' ? sourceMode.value : targetMode.value
  return mode === 'compact' ? compactLayerRef.value : expandedLayerRef.value
}

function isCurrentTransition(generation, expectedStage) {
  return (
    Number(props.transition?.generation) === generation &&
    stage.value === expectedStage &&
    ['collapsing', 'expanding'].includes(props.phase)
  )
}

function notifyReady(generation, expectedStage) {
  if (!isCurrentTransition(generation, expectedStage)) return
  const stageKey = `${generation}:${expectedStage}`
  if (lastNotifiedStageKey === stageKey) return
  lastNotifiedStageKey = stageKey
  window.api.notifyCompactTransitionReady?.(generation, expectedStage)
}

async function armStageCompletion(expectedStage, generation) {
  const revision = ++completionRevision
  if (completionTimer !== null) clearTimeout(completionTimer)
  completionTimer = null

  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  if (revision !== completionRevision || !isCurrentTransition(generation, expectedStage)) return

  if (expectedStage === 'shell-transform') {
    notifyReady(generation, expectedStage)
    return
  }

  const layer = currentStageLayer(expectedStage)
  const duration = getTransitionTotalMs(layer, 'opacity')
  if (duration <= 0) {
    notifyReady(generation, expectedStage)
    return
  }
  completionTimer = setTimeout(() => {
    completionTimer = null
    if (revision === completionRevision) notifyReady(generation, expectedStage)
  }, duration + 100)
}

function onLayerTransitionComplete(event) {
  if (event.target !== event.currentTarget || event.propertyName !== 'opacity') return
  const expectedStage = stage.value
  if (!['content-exit', 'content-enter'].includes(expectedStage)) return
  const expectedLayer = currentStageLayer(expectedStage)
  if (event.currentTarget !== expectedLayer) return
  if (completionTimer !== null) clearTimeout(completionTimer)
  completionTimer = null
  notifyReady(Number(props.transition?.generation), expectedStage)
}

watch(
  () => [props.transition?.generation, props.transition?.stage],
  ([generation, nextStage]) => {
    if (!Number.isInteger(Number(generation))) {
      clearCompletion()
      return
    }
    if (['content-exit', 'shell-transform', 'content-enter'].includes(nextStage)) {
      void armStageCompletion(nextStage, Number(generation))
    }
  },
  { immediate: true, flush: 'post' }
)

onBeforeUnmount(clearCompletion)
</script>

<template>
  <section
    class="compact-presentation-host"
    :class="[
      `is-${phase}`,
      `is-stage-${stage}`,
      `is-direction-${direction}`,
      `is-source-${sourceMode}`,
      `is-target-${targetMode}`,
      `is-stable-${stableMode}`
    ]"
  >
    <div
      ref="expandedLayerRef"
      class="compact-presentation-layer compact-presentation-layer--expanded"
      :aria-hidden="!expandedInteractive"
      :inert="!expandedInteractive"
      @transitionend="onLayerTransitionComplete"
      @transitioncancel="onLayerTransitionComplete"
    >
      <slot />
    </div>

    <aside
      ref="compactLayerRef"
      class="compact-presentation-layer compact-presentation-layer--compact compact-window-scene"
      :aria-hidden="!compactInteractive"
      :inert="!compactInteractive"
      @transitionend="onLayerTransitionComplete"
      @transitioncancel="onLayerTransitionComplete"
    >
      <CompactIsland :phase="phase" />
    </aside>
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
  inset: 0;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: inherit;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(0);
}

.compact-presentation-layer--expanded {
  z-index: var(--z-local-content);
  flex-direction: column;
}

.compact-presentation-layer--compact {
  z-index: var(--z-local-raised);
}

.compact-presentation-host.is-stage-stable.is-stable-expanded .compact-presentation-layer--expanded,
.compact-presentation-host.is-stage-stable.is-stable-compact .compact-presentation-layer--compact {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

.compact-presentation-host.is-stage-content-exit.is-source-expanded
  .compact-presentation-layer--expanded,
.compact-presentation-host.is-stage-content-exit.is-source-compact
  .compact-presentation-layer--compact {
  opacity: 0;
  visibility: visible;
  transition:
    opacity 140ms var(--ease-standard),
    transform 160ms var(--ease-standard);
  transform: translateY(8px);
  will-change: opacity, transform;
}

.compact-presentation-host.is-stage-content-enter.is-target-expanded
  .compact-presentation-layer--expanded {
  opacity: 1;
  visibility: visible;
  transition: opacity 300ms var(--ease-standard);
  will-change: opacity;
}

.compact-presentation-host.is-stage-content-enter.is-target-compact
  .compact-presentation-layer--compact {
  opacity: 1;
  visibility: visible;
  transition: opacity 170ms var(--ease-standard);
  will-change: opacity;
}

.compact-presentation-host.is-stage-shell-transform .compact-presentation-layer {
  opacity: 0;
  visibility: hidden;
}
</style>
