<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DateRangePicker from '../ui/DateRangePicker.vue'
import TagSelector from '../ui/TagSelector.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  statuses: { type: Array, default: () => [] },
  tagNames: { type: Array, default: () => [] },
  timePreset: { type: String, default: 'all' },
  customFrom: { type: String, default: '' },
  customTo: { type: String, default: '' },
  onlyPinned: { type: Boolean, default: false },
  hasAttachments: { type: Boolean, default: false },
  includeDeleted: { type: Boolean, default: true }
})

const emit = defineEmits([
  'toggle-status',
  'update-tags',
  'select-time',
  'change-date-range',
  'toggle-option',
  'reset'
])

const contentRef = ref(null)
const contentHeight = ref(0)
const resetAcknowledged = ref(false)
let resizeObserver = null
let resetTimer = null
let resetRaf = null

const statusOptions = [
  { value: 'initialized', label: '初始化', color: '#0a84ff' },
  { value: 'in_progress', label: '进行中', color: '#ff9f0a' },
  { value: 'completed', label: '已完成', color: '#30d158' }
]

const timeOptions = [
  { value: 'today', label: '今天' },
  { value: '3days', label: '近三天' }
]

function measureContent() {
  contentHeight.value = contentRef.value?.offsetHeight || 0
}

function handleReset() {
  emit('reset')
  resetAcknowledged.value = false
  if (resetTimer) clearTimeout(resetTimer)
  if (resetRaf) cancelAnimationFrame(resetRaf)
  resetRaf = requestAnimationFrame(() => {
    resetRaf = null
    resetAcknowledged.value = true
    resetTimer = setTimeout(() => {
      resetAcknowledged.value = false
      resetTimer = null
    }, 620)
  })
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    measureContent()
  }
)

onMounted(() => {
  measureContent()
  resizeObserver = new ResizeObserver(measureContent)
  if (contentRef.value) resizeObserver.observe(contentRef.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (resetTimer) clearTimeout(resetTimer)
  if (resetRaf) cancelAnimationFrame(resetRaf)
})
</script>

<template>
  <div
    class="sfp-shell"
    :class="{ 'is-open': open }"
    :style="{ height: open ? `${contentHeight}px` : '0px' }"
    :inert="!open"
    :aria-hidden="!open"
  >
    <div ref="contentRef" class="sfp-content">
      <header class="sfp-header">
        <span>搜索范围</span>
        <button
          type="button"
          class="sfp-reset"
          :class="{ 'is-acknowledged': resetAcknowledged }"
          @click="handleReset"
        >
          <Transition name="sfp-reset-label" mode="out-in">
            <span :key="resetAcknowledged ? 'done' : 'idle'" aria-live="polite">
              {{ resetAcknowledged ? '✓ 已重置' : '重置' }}
            </span>
          </Transition>
        </button>
      </header>

      <div class="sfp-row">
        <span class="sfp-label">状态</span>
        <div class="sfp-options">
          <button
            v-for="item in statusOptions"
            :key="item.value"
            type="button"
            class="sfp-chip sfp-status"
            :class="{ 'is-selected': statuses.includes(item.value) }"
            :style="{ '--option-color': item.color }"
            :aria-pressed="statuses.includes(item.value)"
            @click="emit('toggle-status', item.value)"
          >
            <span class="sfp-status-dot" />
            {{ item.label }}
          </button>
        </div>
      </div>

      <div class="sfp-row sfp-row--tags">
        <span class="sfp-label">标签</span>
        <TagSelector :model-value="tagNames" @update:model-value="emit('update-tags', $event)" />
      </div>

      <div class="sfp-row">
        <span class="sfp-label">时间</span>
        <div class="sfp-options sfp-time-options">
          <button
            v-for="item in timeOptions"
            :key="item.value"
            type="button"
            class="sfp-chip"
            :class="{ 'is-selected': timePreset === item.value }"
            :aria-pressed="timePreset === item.value"
            @click="emit('select-time', item.value)"
          >
            {{ item.label }}
          </button>
          <div class="sfp-date" :class="{ 'is-selected': timePreset === 'custom' }">
            <DateRangePicker
              :start="customFrom"
              :end="customTo"
              @change="emit('change-date-range', $event)"
            />
          </div>
        </div>
      </div>

      <div class="sfp-row sfp-row--switches">
        <span class="sfp-label" aria-hidden="true" />
        <div class="sfp-options">
          <button
            type="button"
            class="sfp-toggle"
            :class="{ 'is-selected': onlyPinned }"
            :aria-pressed="onlyPinned"
            @click="emit('toggle-option', 'onlyPinned')"
          >
            仅看置顶
          </button>
          <button
            type="button"
            class="sfp-toggle"
            :class="{ 'is-selected': hasAttachments }"
            :aria-pressed="hasAttachments"
            @click="emit('toggle-option', 'hasAttachments')"
          >
            含附件
          </button>
          <button
            type="button"
            class="sfp-toggle"
            :class="{ 'is-selected': includeDeleted }"
            :aria-pressed="includeDeleted"
            @click="emit('toggle-option', 'includeDeleted')"
          >
            包含已删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sfp-shell {
  flex-shrink: 0;
  overflow: hidden;
  opacity: 0;
  transform: translateY(-4rem);
  visibility: hidden;
  transition:
    height 180ms var(--ease-standard),
    opacity 130ms ease,
    transform 180ms var(--ease-standard),
    visibility 0s linear 180ms;
}
.sfp-shell.is-open {
  opacity: 1;
  transform: translateY(0);
  visibility: visible;
  transition:
    height 220ms var(--ease-standard),
    opacity 160ms ease,
    transform 220ms var(--ease-standard),
    visibility 0s;
}
.sfp-content {
  box-sizing: border-box;
  padding: 4rem 7rem 8rem;
  border: 1px solid rgb(var(--bg-color) / 0.1);
  border-radius: 10rem;
  background: transparent;
}
.sfp-header {
  display: flex;
  align-items: center;
  min-height: 30rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.sfp-header button {
  margin-left: auto;
  padding: 3rem 5rem;
  border: 0;
  background: transparent;
  color: #0a84ff;
  font: inherit;
  font-size: inherit;
  cursor: pointer;
}
.sfp-reset {
  min-width: 54rem;
  min-height: 27rem;
  border-radius: 7rem;
  transition:
    background-color 160ms ease,
    color 160ms ease,
    transform 160ms var(--ease-standard);
}
.sfp-reset:hover {
  background: color-mix(in srgb, #0a84ff 8%, transparent);
}
.sfp-reset:active {
  transform: scale(0.95);
}
.sfp-reset.is-acknowledged {
  background: color-mix(in srgb, #0a84ff 11%, transparent);
  transform: scale(1);
}
.sfp-reset-label-enter-active,
.sfp-reset-label-leave-active {
  transition:
    opacity 130ms ease,
    transform 160ms var(--ease-standard);
}
.sfp-reset-label-enter-from {
  opacity: 0;
  transform: translateY(3rem);
}
.sfp-reset-label-leave-to {
  opacity: 0;
  transform: translateY(-3rem);
}
.sfp-row {
  display: grid;
  grid-template-columns: 50rem minmax(0, 1fr);
  align-items: center;
  min-height: 38rem;
}
.sfp-label {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.sfp-options {
  display: flex;
  align-items: center;
  gap: 6rem;
  min-width: 0;
}
.sfp-chip,
.sfp-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5rem;
  min-height: 27rem;
  padding: 0 10rem;
  border: 1rem solid rgba(255, 255, 255, 0.1);
  border-radius: 8rem;
  background: rgba(128, 128, 128, 0.05);
  background-clip: padding-box;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  white-space: nowrap;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease,
    color 150ms ease,
    transform 120ms ease;
}
.sfp-chip:hover,
.sfp-toggle:hover {
  background: rgba(128, 128, 128, 0.1);
  color: var(--text-color);
}
.sfp-chip:active,
.sfp-toggle:active {
  transform: scale(0.96);
}
.sfp-chip.is-selected,
.sfp-toggle.is-selected {
  border-color: rgba(255, 255, 255, 0.1);
  background: color-mix(in srgb, #0a84ff 16%, transparent);
  color: color-mix(in srgb, #0a84ff 80%, var(--text-color));
}
.sfp-chip.is-selected:hover,
.sfp-toggle.is-selected:hover {
  background: color-mix(in srgb, #0a84ff 21%, transparent);
}
.sfp-status.is-selected {
  border-color: rgba(255, 255, 255, 0.1);
  background: color-mix(in srgb, var(--option-color) 16%, transparent);
  color: var(--text-color);
}
.sfp-status.is-selected:hover {
  background: color-mix(in srgb, var(--option-color) 21%, transparent);
}
.sfp-status-dot {
  width: 7rem;
  height: 7rem;
  border-radius: 50%;
  background: var(--option-color);
  transition: transform 150ms var(--ease-standard);
}
.sfp-row--tags {
  padding: 5rem 0;
}
.sfp-row--tags :deep(.ts-root) {
  min-width: 0;
}
.sfp-row--tags :deep(.ts-chip) {
  border-radius: 8rem;
  font-size: calc(var(--fs-secondary) * 0.85);
}
.sfp-time-options {
  overflow: hidden;
}
.sfp-date {
  display: inline-flex;
  min-width: 0;
  width: fit-content;
  max-width: 100%;
  flex: 0 1 auto;
  min-height: 27rem;
  padding: 0;
  border: 1rem solid rgba(255, 255, 255, 0.1);
  border-radius: 8rem;
  background: rgba(128, 128, 128, 0.05);
  background-clip: padding-box;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
}
.sfp-date.is-selected {
  border-color: rgba(255, 255, 255, 0.1);
  background: color-mix(in srgb, #0a84ff 16%, transparent);
}
.sfp-date :deep(.drp-trigger) {
  justify-content: center;
  gap: 4rem;
  width: auto;
  max-width: 100%;
  min-height: 25rem;
  padding: 0 8rem;
  font-size: var(--fs-secondary);
}
.sfp-date :deep(.drp-control) {
  width: auto;
  max-width: 100%;
}
.sfp-date :deep(.drp-trigger span) {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sfp-date :deep(.drp-trigger svg) {
  flex: 0 0 14rem;
}
@media (max-width: 520px) {
  .sfp-row {
    grid-template-columns: 44rem minmax(0, 1fr);
  }
  .sfp-chip,
  .sfp-toggle {
    padding: 0 7rem;
  }
}
</style>
