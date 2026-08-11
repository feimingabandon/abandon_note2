<script setup>
import { computed } from 'vue'
import MonthDayNoteCard from './MonthDayNoteCard.vue'

const props = defineProps({
  dateKey: { type: String, required: true },
  notes: { type: Array, default: () => [] },
  canCreate: { type: Boolean, default: true }
})
const emit = defineEmits(['close', 'create', 'edit', 'resize-start'])
const title = computed(() => {
  const [year, month, day] = props.dateKey.split('-').map(Number)
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][
    new Date(year, month - 1, day).getDay()
  ]
  return `${month}月${day}日 · 周${weekday}`
})
</script>

<template>
  <aside class="month-day-panel" aria-label="所选日期便签">
    <header class="month-day-panel__header">
      <div>
        <strong>{{ title }}</strong>
        <span>{{ notes.length }} 条便签</span>
      </div>
      <div>
        <button
          type="button"
          class="month-day-panel__create"
          :disabled="!canCreate"
          :title="canCreate ? '新建便签' : '不能为过去日期新建便签'"
          @click="emit('create')"
        >
          + 新建
        </button>
        <button type="button" aria-label="折叠日期侧栏" title="折叠" @click="emit('close')">
          ‹
        </button>
      </div>
    </header>
    <div class="month-day-panel__list scroll-y">
      <TransitionGroup name="month-day-note">
        <MonthDayNoteCard
          v-for="note in notes"
          :key="note.id"
          :note="note"
          @edit="emit('edit', $event)"
        />
      </TransitionGroup>
      <div v-if="!notes.length" class="month-day-panel__empty">
        <span>这一天还没有便签</span>
        <button v-if="canCreate" type="button" @click="emit('create')">创建第一条</button>
      </div>
    </div>
    <div
      class="month-day-panel__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整日期侧栏宽度"
      @pointerdown="emit('resize-start', $event)"
    >
      <span />
    </div>
  </aside>
</template>

<style scoped>
.month-day-panel {
  position: relative;
  display: flex;
  min-width: 0;
  height: 100%;
  flex-direction: column;
  border-right: 1px solid var(--ui-border-divider);
  border-radius: 0 var(--window-radius) var(--window-radius) 0;
  background: rgb(var(--bg-color) / 0.035);
}
.month-day-panel__header {
  display: flex;
  min-height: 50rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  padding: 0 13rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.month-day-panel__header > div {
  display: flex;
  align-items: center;
  gap: 7rem;
}
.month-day-panel__header > div:first-child {
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 1rem;
}
.month-day-panel__header strong {
  color: var(--text-color);
  font-size: var(--fs-body);
  white-space: nowrap;
}
.month-day-panel__header span {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
}
.month-day-panel__header button {
  height: 27rem;
  padding: 0 8rem;
  border: 0;
  border-radius: 7rem;
  background: rgb(var(--bg-color) / 0.09);
  color: var(--text-color-secondary);
  cursor: pointer;
  font: inherit;
}
.month-day-panel__header button:hover:not(:disabled) {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.month-day-panel__header button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.month-day-panel__create {
  color: #0a84ff !important;
  font-size: var(--fs-secondary) !important;
}
.month-day-panel__list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 8rem;
  padding: 11rem 13rem 18rem;
}
.month-day-panel__empty {
  display: grid;
  flex: 1;
  place-content: center;
  justify-items: center;
  gap: 10rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.month-day-panel__empty button {
  padding: 6rem 12rem;
  border: 0;
  border-radius: 7rem;
  background: color-mix(in srgb, #0a84ff 14%, transparent);
  color: #0a84ff;
  cursor: pointer;
  font: inherit;
}
.month-day-panel__resize {
  position: absolute;
  z-index: var(--z-local-top);
  top: 0;
  right: -5rem;
  bottom: 0;
  width: 10rem;
  cursor: ew-resize;
  touch-action: none;
}
.month-day-panel__resize span {
  position: absolute;
  top: 50%;
  left: 4rem;
  width: 2rem;
  height: 38rem;
  border-radius: 2rem;
  background: rgb(var(--bg-color) / 0.15);
  opacity: 0;
  transform: translateY(-50%);
  transition: opacity 140ms ease;
}
.month-day-panel__resize:hover span {
  opacity: 1;
}
.month-day-note-enter-active,
.month-day-note-leave-active {
  transition:
    opacity 180ms ease,
    transform 200ms var(--ease-standard);
}
.month-day-note-enter-from,
.month-day-note-leave-to {
  opacity: 0;
  transform: translateY(5rem);
}
</style>
