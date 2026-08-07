<script setup>
import NumberStepper from '../ui/NumberStepper.vue'
import HelpButton from '../ui/HelpButton.vue'

defineProps({
  modelValue: { type: Number, default: 1 },
  visible: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <Transition name="note-duration">
    <div v-if="visible" class="note-duration-field">
      <div class="note-duration-field__inner">
        <label class="note-duration-field__label"
          >持续天数<HelpButton text="只决定月视图中这条便签连续占用的日期格数，不改变便签状态。"
        /></label>
        <div class="note-duration-field__control">
          <NumberStepper
            :model-value="modelValue"
            :min="1"
            :max="365"
            aria-label="持续天数"
            @update:model-value="emit('update:modelValue', $event)"
          />
          <span>天</span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.note-duration-field {
  max-height: 48rem;
  margin-top: 12rem;
  overflow: hidden;
}

.note-duration-field__inner {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
}

.note-duration-field__label {
  flex-shrink: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 500;
}

.note-duration-field__control {
  display: flex;
  align-items: center;
  gap: 6rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.note-duration-enter-active,
.note-duration-leave-active {
  transition:
    max-height 240ms var(--ease-standard),
    margin-top 240ms var(--ease-standard),
    opacity 180ms ease,
    transform 220ms var(--ease-standard);
}

.note-duration-enter-from,
.note-duration-leave-to {
  max-height: 0;
  margin-top: 0;
  opacity: 0;
  transform: translateY(-6rem);
}
</style>
