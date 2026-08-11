<script setup>
import { onBeforeUnmount, ref } from 'vue'

const props = defineProps({
  pinned: { type: Boolean, default: false },
  label: { type: String, default: '标签' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['toggle'])
const animating = ref(false)
let animationTimer = null

function toggle(event) {
  event.stopPropagation()
  if (props.disabled) return
  animating.value = false
  requestAnimationFrame(() => {
    animating.value = true
    clearTimeout(animationTimer)
    animationTimer = setTimeout(() => {
      animating.value = false
    }, 420)
  })
  emit('toggle')
}

onBeforeUnmount(() => clearTimeout(animationTimer))
</script>

<template>
  <button
    type="button"
    class="tag-pin-button"
    :class="{ active: pinned, animating }"
    :disabled="disabled"
    :title="pinned ? '取消置顶' : '置顶标签'"
    :aria-label="`${pinned ? '取消置顶' : '置顶'} ${label}`"
    @click="toggle"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m12 3 2.75 5.57 6.15.9-4.45 4.33 1.05 6.12L12 17.03l-5.5 2.89 1.05-6.12L3.1 9.47l6.15-.9L12 3Z"
      />
    </svg>
  </button>
</template>

<style scoped>
.tag-pin-button {
  display: grid;
  width: 30rem;
  height: 30rem;
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    color var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    transform 90ms ease;
}
.tag-pin-button:hover:not(:disabled) {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.tag-pin-button:active:not(:disabled) {
  transform: scale(0.94);
}
.tag-pin-button:disabled {
  opacity: 0.4;
  cursor: wait;
}
.tag-pin-button svg {
  width: 16rem;
  height: 16rem;
  overflow: visible;
  fill: transparent;
  stroke: currentColor;
  stroke-linejoin: round;
  stroke-width: 1.5;
  transform-origin: center;
  transition:
    fill 180ms ease,
    transform 220ms var(--ease-standard);
}
.tag-pin-button.active {
  color: #ff9500;
}
.tag-pin-button.active svg {
  fill: currentColor;
}
.tag-pin-button.animating svg {
  animation: tag-pin-pop 400ms cubic-bezier(0.2, 0.9, 0.25, 1.25);
}
@keyframes tag-pin-pop {
  0% {
    transform: scale(1) rotate(0deg);
  }
  30% {
    transform: scale(0.72) rotate(-9deg);
  }
  68% {
    transform: scale(1.22) rotate(4deg);
  }
  100% {
    transform: scale(1) rotate(0deg);
  }
}
</style>
