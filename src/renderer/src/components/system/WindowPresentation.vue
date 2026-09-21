<script setup>
import { computed, nextTick, watch } from 'vue'
import CompactIsland from './CompactIsland.vue'

const props = defineProps({
  mode: { type: String, default: 'expanded' },
  operation: { type: Object, default: null },
  locked: { type: Boolean, required: true }
})

const displayMode = computed(() => props.operation?.to || props.mode || 'expanded')
const expanded = computed(() => displayMode.value === 'expanded')
let acknowledgedOperationId = null

watch(
  () => props.operation?.id,
  async (operationId) => {
    if (!Number.isInteger(operationId) || acknowledgedOperationId === operationId) return
    await nextTick()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    if (props.operation?.id !== operationId) return
    acknowledgedOperationId = operationId
    window.api.notifyPresentationRendererReady(operationId)
  },
  { immediate: true, flush: 'post' }
)
</script>

<template>
  <section class="window-presentation" :class="[`is-${displayMode}`, { 'is-changing': operation }]">
    <div
      v-show="expanded"
      class="window-presentation__expanded"
      :inert="!expanded || Boolean(operation)"
      :aria-hidden="!expanded"
    >
      <slot />
    </div>

    <CompactIsland
      v-if="!expanded"
      class="window-presentation__compact"
      :locked="locked"
      :ready="!operation"
      :inert="Boolean(operation)"
      :aria-hidden="Boolean(operation)"
    />

    <div v-if="operation" class="window-presentation__input-shield" aria-hidden="true" />
  </section>
</template>

<style scoped>
.window-presentation,
.window-presentation__expanded,
.window-presentation__compact {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
}

.window-presentation {
  z-index: var(--z-local-content);
}

.window-presentation__expanded {
  z-index: var(--z-local-content);
  display: flex;
  flex-direction: column;
}

.window-presentation__compact {
  z-index: var(--z-local-raised);
}

.window-presentation__input-shield {
  position: absolute;
  z-index: var(--z-local-top);
  inset: 0;
  pointer-events: auto;
}
</style>
