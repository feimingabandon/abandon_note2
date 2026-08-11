<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  min: { type: Number, default: Number.NEGATIVE_INFINITY },
  max: { type: Number, default: Number.POSITIVE_INFINITY },
  step: { type: Number, default: 1 },
  ariaLabel: { type: String, required: true },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue'])
const draft = ref(String(props.modelValue))

function clamp(value) {
  return Math.min(props.max, Math.max(props.min, value))
}

function commit(value, fallback = props.modelValue) {
  if (props.disabled) return
  const parsed = Number(value)
  const normalized = Number.isFinite(parsed) ? Math.trunc(parsed) : Math.trunc(Number(fallback))
  const next = clamp(Number.isFinite(normalized) ? normalized : props.min)
  draft.value = String(next)
  if (next !== props.modelValue) emit('update:modelValue', next)
}

function handleInput(event) {
  if (props.disabled) return
  draft.value = event.target.value
  if (event.target.value.trim() === '') return

  const parsed = Number(event.target.value)
  if (Number.isInteger(parsed) && parsed >= props.min && parsed <= props.max) {
    emit('update:modelValue', parsed)
  }
}

function stepBy(direction) {
  if (props.disabled) return
  const current = Number(draft.value)
  const base = Number.isFinite(current) ? current : props.modelValue
  commit(base + props.step * direction)
}

watch(
  () => props.modelValue,
  (value) => {
    if (Number(draft.value) !== value) draft.value = String(value)
  }
)
</script>

<template>
  <div class="number-stepper" :class="{ 'is-disabled': disabled }">
    <input
      :value="draft"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      :aria-label="ariaLabel"
      :disabled="disabled"
      @input="handleInput"
      @blur="commit(draft)"
      @keydown.up.prevent="stepBy(1)"
      @keydown.down.prevent="stepBy(-1)"
      @keydown.enter="commit(draft)"
    />

    <div class="number-stepper__controls">
      <button
        type="button"
        :aria-label="`${ariaLabel}增加`"
        :disabled="disabled || modelValue >= max"
        @click="stepBy(1)"
      >
        <svg viewBox="0 0 12 8" aria-hidden="true">
          <path d="M2 6 6 2l4 4" />
        </svg>
      </button>
      <button
        type="button"
        :aria-label="`${ariaLabel}减少`"
        :disabled="disabled || modelValue <= min"
        @click="stepBy(-1)"
      >
        <svg viewBox="0 0 12 8" aria-hidden="true">
          <path d="m2 2 4 4 4-4" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.number-stepper {
  --stepper-controls-width: 24rem;

  position: relative;
  box-sizing: border-box;
  width: 88rem;
  height: 32rem;
  overflow: hidden;
  border: 1px solid var(--ui-border-control);
  border-radius: 8rem;
  background: var(--ui-surface-control);
  transition:
    border-color 160ms ease,
    background-color 160ms ease,
    box-shadow 160ms ease;
}

.number-stepper:hover {
  border-color: var(--ui-border-hover);
}

.number-stepper:focus-within {
  border-color: color-mix(in srgb, #0a84ff 72%, transparent);
  background: var(--ui-surface-control);
  box-shadow: 0 0 0 3rem color-mix(in srgb, #0a84ff 14%, transparent);
}

.number-stepper input {
  box-sizing: border-box;
  width: calc(100% - var(--stepper-controls-width) - 3rem);
  height: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.number-stepper__controls {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: grid;
  width: var(--stepper-controls-width);
  grid-template-rows: 1fr 1fr;
  overflow: hidden;
  border: 0;
  border-left: 1px solid var(--ui-border-divider);
  border-radius: 0;
  background: transparent;
}

.number-stepper__controls button {
  display: grid;
  min-width: 0;
  padding: 0;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--text-color);
  opacity: 0.45;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}

.number-stepper__controls button + button {
  border-top: 1px solid var(--ui-border-divider);
}

.number-stepper__controls button:hover:not(:disabled) {
  background: var(--ui-fill-hover);
  color: var(--text-color);
  opacity: 0.7;
}

.number-stepper__controls button:active:not(:disabled) {
  transform: scale(0.98);
}

.number-stepper__controls button:disabled {
  opacity: 0.28;
  cursor: default;
}

.number-stepper__controls svg {
  width: 8rem;
  height: 6rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}
</style>
