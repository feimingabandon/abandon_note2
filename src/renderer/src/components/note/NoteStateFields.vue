<script setup>
import DateTimePicker from '../ui/DateTimePicker.vue'
import HelpButton from '../ui/HelpButton.vue'
import StyledSelect from '../ui/StyledSelect.vue'

defineProps({
  status: { type: String, required: true },
  options: { type: Array, required: true },
  finishedAt: { type: String, default: '' },
  finishedPlaceholder: { type: String, default: '保存时完成' },
  completionHint: { type: String, default: '' },
  hint: { type: String, default: '' }
})
const emit = defineEmits(['update:status', 'update:finishedAt'])
</script>

<template>
  <div class="note-state-fields">
    <div class="note-state-fields__row">
      <label class="note-state-fields__label">
        状态<HelpButton
          text="当前或过去生效可选进行中、已完成；未来只能未开始。完成只由你明确选择，不补发过去的生效提醒。"
        />
      </label>
      <StyledSelect
        :model-value="status"
        :options="options"
        aria-label="便签状态"
        width="max(116rem, 8.5em)"
        size="sm"
        @update:model-value="emit('update:status', $event)"
      />
    </div>
    <p v-if="hint" class="note-state-fields__hint" aria-live="polite">{{ hint }}</p>
    <div v-if="status === 'completed'" class="note-state-fields__row note-state-fields__completion">
      <label class="note-state-fields__label">
        完成时间<HelpButton
          text="留空或选择现在，均为保存时完成；补录可以填写实际完成时间，不能早于生效或晚于现在。"
        />
      </label>
      <DateTimePicker
        :model-value="finishedAt"
        :placeholder="finishedPlaceholder"
        relative-now
        relative-now-label="保存时完成"
        aria-label="便签完成时间"
        @update:model-value="emit('update:finishedAt', $event)"
      />
    </div>
    <p
      v-if="status === 'completed' && completionHint"
      class="note-state-fields__hint"
      aria-live="polite"
    >
      {{ completionHint }}
    </p>
  </div>
</template>

<style scoped>
.note-state-fields {
  margin-top: 12rem;
  min-width: 0;
}
.note-state-fields__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6rem 12rem;
  min-width: 0;
}
.note-state-fields__label {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 500;
  max-width: 100%;
}
.note-state-fields__row > :last-child {
  margin-left: auto;
  max-width: 100%;
}
.note-state-fields__hint {
  margin: 5rem 0 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  line-height: 1.5;
}
.note-state-fields__completion {
  margin-top: 12rem;
}
</style>
