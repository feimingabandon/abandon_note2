<script setup>
import { computed } from 'vue'
import NumberStepper from '../ui/NumberStepper.vue'
import HelpButton from '../ui/HelpButton.vue'
import StyledSelect from '../ui/StyledSelect.vue'
import { NOTE_DURATION_KINDS } from '../../../../shared/calendar/calendar-date-rules.js'

const props = defineProps({
  kind: { type: String, default: NOTE_DURATION_KINDS.SINGLE_DAY },
  days: { type: Number, default: 1 },
  visible: { type: Boolean, default: false }
})

const emit = defineEmits(['update:kind', 'update:days'])
const durationOptions = Object.freeze([
  { label: '仅当天', value: NOTE_DURATION_KINDS.SINGLE_DAY },
  { label: '指定天数', value: NOTE_DURATION_KINDS.FIXED_DAYS },
  { label: '持续到完成', value: NOTE_DURATION_KINDS.UNTIL_COMPLETED }
])
const helpText = computed(() => {
  if (props.kind === NOTE_DURATION_KINDS.FIXED_DAYS) {
    return '在日历中连续显示指定天数，不改变便签完成状态。'
  }
  if (props.kind === NOTE_DURATION_KINDS.UNTIL_COMPLETED) {
    return '未完成时从生效日持续显示到今天，完成后以完成日期作为结束日。'
  }
  return '只在生效当天显示。'
})

function updateKind(kind) {
  emit('update:kind', kind)
  if (kind === NOTE_DURATION_KINDS.FIXED_DAYS) {
    if (props.days < 2) emit('update:days', 2)
  } else {
    emit('update:days', 1)
  }
}
</script>

<template>
  <Transition name="note-duration">
    <div v-if="visible" class="note-duration-field">
      <div class="note-duration-field__inner">
        <label class="note-duration-field__label">持续方式<HelpButton :text="helpText" /></label>
        <div class="note-duration-field__control">
          <StyledSelect
            :model-value="kind"
            :options="durationOptions"
            width="max(116rem, 8.5em)"
            size="sm"
            aria-label="持续方式"
            @update:model-value="updateKind"
          />
          <template v-if="kind === NOTE_DURATION_KINDS.FIXED_DAYS">
            <div class="note-duration-field__days">
              <NumberStepper
                :model-value="days"
                :min="2"
                :max="365"
                aria-label="指定持续天数"
                @update:model-value="emit('update:days', $event)"
              />
              <span>天</span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.note-duration-field {
  display: grid;
  grid-template-rows: 1fr;
  margin-top: 12rem;
}

.note-duration-field__inner {
  display: flex;
  flex-wrap: wrap;
  gap: 6rem 12rem;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  align-items: center;
  justify-content: space-between;
}

.note-duration-field__label {
  flex-shrink: 0;
  max-width: 100%;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 500;
}

.note-duration-field__control {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
  max-width: 100%;
  margin-left: auto;
  align-items: center;
  gap: 6rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.note-duration-field__days {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6rem;
  min-width: 0;
  max-width: 100%;
}

.note-duration-field__control :deep(.sel-trigger),
.note-duration-field__control :deep(.number-stepper) {
  min-height: max(32rem, 2em);
}
.note-duration-field__control :deep(.number-stepper) {
  height: max(32rem, 2em);
  max-width: 100%;
}
.note-duration-field__control :deep(.sel-label) {
  white-space: normal;
  overflow: visible;
  overflow-wrap: anywhere;
}

.note-duration-enter-active,
.note-duration-leave-active {
  transition:
    grid-template-rows 240ms var(--ease-standard),
    margin-top 240ms var(--ease-standard),
    opacity 180ms ease,
    transform 220ms var(--ease-standard);
}

.note-duration-enter-from,
.note-duration-leave-to {
  grid-template-rows: 0fr;
  margin-top: 0;
  opacity: 0;
  transform: translateY(-6rem);
}
</style>
