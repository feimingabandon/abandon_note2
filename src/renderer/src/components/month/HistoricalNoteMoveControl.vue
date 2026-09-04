<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DateRangePicker from '../ui/DateRangePicker.vue'
import { useMessage } from '../../composables/useMessage.js'
import {
  MIN_CALENDAR_DATE,
  addCalendarDays,
  localDateKey
} from '../../../../shared/calendar/calendar-date-rules.js'
import {
  HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE,
  HISTORICAL_NOTE_MOVE_SCOPES
} from '../../../../shared/historical-note-move-rules.js'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:open', 'moved'])
const { showMessage } = useMessage()

const triggerRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({})
const selectedPreset = ref('yesterday')
const indicatorPresetIndex = ref(0)
const selectionDirection = ref('forward')
const previewTransitionKey = ref(0)
const startDateKey = ref('')
const endDateKey = ref('')
const maxDateKey = ref('')
const previewContentRef = ref(null)
const previewContentHeight = ref(0)
const previewCount = ref(0)
const previewNotes = ref([])
const selectedNoteIds = ref(new Set())
const deselectedNoteIds = ref(new Set())
const allMatchingSelected = ref(true)
const previewHasMore = ref(false)
const previewLoading = ref(false)
const previewLoadingMore = ref(false)
const previewError = ref('')
const moving = ref(false)
let previewSequence = 0
let previewResizeObserver = null

const presets = Object.freeze([
  { value: 'yesterday', label: '昨天' },
  { value: 'recent3', label: '最近3天' },
  { value: 'all', label: '全部历史' }
])

const selectedPresetIndex = computed(() =>
  presets.findIndex((preset) => preset.value === selectedPreset.value)
)
const presetIndicatorStyle = computed(() => ({
  opacity: selectedPresetIndex.value < 0 ? 0 : 1,
  transform: `translateX(calc(${indicatorPresetIndex.value * 100}% + ${indicatorPresetIndex.value * 3}rem))`
}))
const selectionTransitionName = computed(() => `historical-note-move-${selectionDirection.value}`)
const selectionReady = computed(
  () => selectedPreset.value === 'all' || Boolean(startDateKey.value && endDateKey.value)
)
const selectedCount = computed(() =>
  allMatchingSelected.value
    ? Math.max(0, previewCount.value - deselectedNoteIds.value.size)
    : selectedNoteIds.value.size
)
const allNotesSelected = computed(
  () => previewCount.value > 0 && allMatchingSelected.value && deselectedNoteIds.value.size === 0
)
const previewGroups = computed(() => {
  const groups = []
  for (const note of previewNotes.value) {
    const dateKey = String(note?.dateKey || '')
    const previous = groups.at(-1)
    const group = previous?.dateKey === dateKey ? previous : { dateKey, notes: [] }
    if (group !== previous) groups.push(group)
    group.notes.push({
      id: Number(note?.id),
      content: String(note?.content || '').trim() || '（无正文）'
    })
  }
  return groups
})
const executeLabel = computed(() =>
  moving.value
    ? '正在移动…'
    : previewCount.value <= 0
      ? '没有可移动的未完成便签'
      : selectedCount.value <= 0
        ? '请选择要移动的便签'
        : `将 ${selectedCount.value} 条未完成便签移至今天`
)
const previewLabel = computed(() => {
  if (previewLoading.value) return '正在统计进行中的历史便签…'
  if (previewError.value) return previewError.value
  if (!selectionReady.value) return '请选择完整的开始和结束日期'
  if (selectedPreset.value === 'all') {
    return `全部历史中有 ${previewCount.value} 条进行中便签`
  }
  if (startDateKey.value === endDateKey.value) {
    return `${startDateKey.value} 有 ${previewCount.value} 条进行中便签`
  }
  return `${startDateKey.value} 至 ${endDateKey.value} 有 ${previewCount.value} 条进行中便签`
})

function yesterdayKey() {
  return addCalendarDays(localDateKey(), -1)
}

function resetDefaultSelection() {
  const yesterday = yesterdayKey()
  maxDateKey.value = yesterday
  selectedPreset.value = 'yesterday'
  indicatorPresetIndex.value = 0
  selectionDirection.value = 'forward'
  previewTransitionKey.value = 0
  startDateKey.value = yesterday
  endDateKey.value = yesterday
  previewCount.value = 0
  previewNotes.value = []
  selectedNoteIds.value = new Set()
  deselectedNoteIds.value = new Set()
  allMatchingSelected.value = true
  previewHasMore.value = false
  previewError.value = ''
}

function selectionPayload() {
  if (selectedPreset.value === 'all') {
    return { scope: HISTORICAL_NOTE_MOVE_SCOPES.ALL }
  }
  return {
    scope: HISTORICAL_NOTE_MOVE_SCOPES.RANGE,
    startDateKey: startDateKey.value,
    endDateKey: endDateKey.value
  }
}

async function loadPreview({ append = false } = {}) {
  const sequence = append ? previewSequence : ++previewSequence
  if (!append) previewError.value = ''
  if (!selectionReady.value) {
    previewCount.value = 0
    previewNotes.value = []
    selectedNoteIds.value = new Set()
    deselectedNoteIds.value = new Set()
    allMatchingSelected.value = true
    previewHasMore.value = false
    previewLoading.value = false
    previewLoadingMore.value = false
    return
  }
  if (append) previewLoadingMore.value = true
  else {
    previewLoading.value = true
    previewNotes.value = []
    selectedNoteIds.value = new Set()
    deselectedNoteIds.value = new Set()
    allMatchingSelected.value = true
    previewHasMore.value = false
  }
  try {
    const result = await window.api.previewHistoricalNoteMove({
      ...selectionPayload(),
      limit: HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE,
      offset: append ? previewNotes.value.length : 0
    })
    if (sequence !== previewSequence || !props.open) return
    previewCount.value = Math.max(0, Number(result?.count) || 0)
    const notes = Array.isArray(result?.notes) ? result.notes : []
    previewNotes.value = append ? [...previewNotes.value, ...notes] : notes
    previewHasMore.value = Boolean(result?.hasMore)
  } catch (error) {
    if (sequence !== previewSequence || !props.open) return
    if (append) {
      showMessage('error', error?.message || '无法继续加载未完成便签')
    } else {
      previewCount.value = 0
      previewNotes.value = []
      selectedNoteIds.value = new Set()
      deselectedNoteIds.value = new Set()
      previewHasMore.value = false
      previewError.value = error?.message || '无法统计未完成便签'
    }
  } finally {
    if (sequence === previewSequence) {
      previewLoading.value = false
      previewLoadingMore.value = false
    }
  }
}

function selectPreset(value) {
  const nextIndex = presets.findIndex((preset) => preset.value === value)
  if (nextIndex < 0 || selectedPreset.value === value) return
  const yesterday = yesterdayKey()
  maxDateKey.value = yesterday
  selectionDirection.value = nextIndex >= indicatorPresetIndex.value ? 'forward' : 'backward'
  indicatorPresetIndex.value = nextIndex
  selectedPreset.value = value
  if (value === 'yesterday') {
    startDateKey.value = yesterday
    endDateKey.value = yesterday
  } else if (value === 'recent3') {
    startDateKey.value = addCalendarDays(yesterday, -2)
    endDateKey.value = yesterday
  } else {
    startDateKey.value = ''
    endDateKey.value = ''
  }
  previewTransitionKey.value += 1
  void loadPreview()
}

function applyCustomRange(range) {
  selectionDirection.value = 'forward'
  selectedPreset.value = 'custom'
  startDateKey.value = range.start
  endDateKey.value = range.end
  previewTransitionKey.value += 1
  void loadPreview()
}

function toggleNoteSelection(noteId) {
  if (moving.value) return
  const id = Number(noteId)
  if (allMatchingSelected.value) {
    const next = new Set(deselectedNoteIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    deselectedNoteIds.value = next
    return
  }
  const nextSelected = new Set(selectedNoteIds.value)
  if (nextSelected.has(id)) nextSelected.delete(id)
  else nextSelected.add(id)
  selectedNoteIds.value = nextSelected
}

function noteIsSelected(noteId) {
  const id = Number(noteId)
  return allMatchingSelected.value
    ? !deselectedNoteIds.value.has(id)
    : selectedNoteIds.value.has(id)
}

function selectAllNotes() {
  if (moving.value) return
  allMatchingSelected.value = true
  selectedNoteIds.value = new Set()
  deselectedNoteIds.value = new Set()
}

function clearNoteSelection() {
  if (moving.value) return
  allMatchingSelected.value = false
  selectedNoteIds.value = new Set()
  deselectedNoteIds.value = new Set()
}

function loadMorePreview() {
  if (previewLoading.value || previewLoadingMore.value || !previewHasMore.value) return
  void loadPreview({ append: true })
}

function updatePosition() {
  const triggerBounds = triggerRef.value?.getBoundingClientRect()
  const panelBounds = panelRef.value?.getBoundingClientRect()
  if (!triggerBounds || !panelBounds) return
  const margin = 12
  const left = Math.max(
    margin,
    Math.min(
      window.innerWidth - panelBounds.width - margin,
      triggerBounds.right - panelBounds.width
    )
  )
  const below = triggerBounds.bottom + 7
  const top =
    below + panelBounds.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, triggerBounds.top - panelBounds.height - 7)
  panelStyle.value = { left: `${left}px`, top: `${top}px` }
}

function measurePreviewContent() {
  previewContentHeight.value = previewContentRef.value?.offsetHeight || 0
}

function observePreviewContent(element) {
  previewResizeObserver?.disconnect()
  previewResizeObserver = null
  if (!element) {
    previewContentHeight.value = 0
    return
  }
  measurePreviewContent()
  previewResizeObserver = new ResizeObserver(measurePreviewContent)
  previewResizeObserver.observe(element)
}

function onPreviewHeightTransitionEnd(event) {
  if (event.target !== event.currentTarget || event.propertyName !== 'height') return
  updatePosition()
}

function requestOpen() {
  if (!props.disabled && !moving.value) emit('update:open', !props.open)
}

function closePanel({ restoreFocus = false } = {}) {
  if (!props.open || moving.value) return
  emit('update:open', false)
  if (restoreFocus) nextTick(() => triggerRef.value?.focus({ preventScroll: true }))
}

async function executeMove() {
  if (moving.value || previewLoading.value || selectedCount.value <= 0 || !selectionReady.value) {
    return
  }
  moving.value = true
  try {
    const result = await window.api.moveHistoricalNotesToToday({
      ...selectionPayload(),
      ...(allMatchingSelected.value
        ? { excludedNoteIds: [...deselectedNoteIds.value] }
        : { noteIds: [...selectedNoteIds.value] })
    })
    const count = Math.max(0, Number(result?.count) || 0)
    if (count === 0) {
      previewCount.value = 0
      previewNotes.value = []
      selectedNoteIds.value = new Set()
      deselectedNoteIds.value = new Set()
      previewHasMore.value = false
      showMessage('warning', '所选日期范围内已没有可移动的未完成便签')
      return
    }
    showMessage('success', `已将 ${count} 条未完成便签移至今天`)
    emit('moved', result)
    emit('update:open', false)
  } catch (error) {
    showMessage('error', error?.message || '移动未完成便签失败')
  } finally {
    moving.value = false
  }
}

function onDocumentPointerDown(event) {
  if (!props.open) return
  if (triggerRef.value?.contains(event.target) || panelRef.value?.contains(event.target)) return
  // DateRangePicker 的日历通过 Teleport 挂到 body，仍属于当前操作浮层。
  if (event.target?.closest?.('.drp-panel')) return
  closePanel()
}

function onDocumentKeydown(event) {
  if (event.key !== 'Escape' || !props.open) return
  if (document.querySelector('.drp-panel')) return
  closePanel({ restoreFocus: true })
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      previewSequence += 1
      previewLoading.value = false
      return
    }
    resetDefaultSelection()
    await nextTick()
    updatePosition()
    void loadPreview()
  }
)

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled && props.open && !moving.value) emit('update:open', false)
  }
)

watch(previewContentRef, observePreviewContent, { flush: 'post' })

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
  window.addEventListener('resize', updatePosition)
})

onBeforeUnmount(() => {
  previewSequence += 1
  previewResizeObserver?.disconnect()
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('resize', updatePosition)
})
</script>

<template>
  <div class="historical-note-move">
    <button
      ref="triggerRef"
      type="button"
      class="historical-note-move__trigger"
      :class="{ 'is-open': open }"
      :disabled="disabled || moving"
      aria-haspopup="dialog"
      :aria-expanded="open"
      aria-controls="historical-note-move-panel"
      aria-label="将历史未完成便签移至今天"
      title="将历史未完成便签移至今天"
      @click="requestOpen"
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3.5 5h8.5M3.5 10h9M3.5 15h6.5M10 12l3 3 3-3M13 15V7" />
      </svg>
      <span class="historical-note-move__label">未完成移至今天</span>
    </button>

    <Teleport to="body">
      <Transition
        :css="false"
        @enter="(element, done) => enterPopover(element, done, 'dropdown')"
        @leave="(element, done) => leavePopover(element, done, 'dropdown')"
      >
        <section
          v-if="open"
          id="historical-note-move-panel"
          ref="panelRef"
          class="historical-note-move__panel"
          :style="panelStyle"
          role="dialog"
          aria-label="未完成便签移至今天"
          :aria-busy="previewLoading || moving"
        >
          <header class="historical-note-move__header">
            <strong>未完成便签移至今天</strong>
            <span>选择便签当前所在的历史日期</span>
          </header>

          <div class="historical-note-move__presets" aria-label="快捷选择日期范围">
            <span
              class="historical-note-move__preset-indicator"
              :style="presetIndicatorStyle"
              data-move-preset-indicator
              aria-hidden="true"
            />
            <button
              v-for="preset in presets"
              :key="preset.value"
              type="button"
              :class="{ 'is-active': selectedPreset === preset.value }"
              :aria-pressed="selectedPreset === preset.value"
              :data-preset="preset.value"
              :disabled="moving"
              @click="selectPreset(preset.value)"
            >
              {{ preset.label }}
            </button>
          </div>

          <div class="historical-note-move__range">
            <span class="historical-note-move__range-label">手动选择</span>
            <DateRangePicker
              v-model:start="startDateKey"
              v-model:end="endDateKey"
              :min-date="MIN_CALENDAR_DATE"
              :max-date="maxDateKey"
              :value-transition-direction="selectionDirection"
              @change="applyCustomRange"
            />
          </div>

          <div
            class="historical-note-move__preview-motion"
            :style="{ height: `${previewContentHeight}px` }"
            data-move-preview-motion
            @transitionend="onPreviewHeightTransitionEnd"
          >
            <div ref="previewContentRef" class="historical-note-move__preview-content">
              <Transition :name="selectionTransitionName">
                <div
                  :key="previewTransitionKey"
                  class="historical-note-move__preview-page"
                  data-move-preview-page
                >
                  <p
                    class="historical-note-move__preview"
                    :class="{ 'is-error': previewError }"
                    data-move-preview
                    aria-live="polite"
                  >
                    {{ previewLabel }}
                  </p>

                  <div
                    v-if="previewGroups.length > 0 && !previewLoading && !previewError"
                    class="historical-note-move__note-list"
                    data-move-note-list
                    aria-label="将被移动的便签"
                  >
                    <header class="historical-note-move__selection-bar">
                      <span class="historical-note-move__selection-summary">
                        <span data-move-selection-count>
                          已选 {{ selectedCount }} / {{ previewCount }} 条
                        </span>
                        <small v-if="previewNotes.length < previewCount">
                          已显示 {{ previewNotes.length }} 条
                        </small>
                      </span>
                      <span class="historical-note-move__selection-actions">
                        <button
                          type="button"
                          :disabled="allNotesSelected || moving"
                          data-move-select-all
                          @click="selectAllNotes"
                        >
                          全选
                        </button>
                        <button
                          type="button"
                          :disabled="selectedCount === 0 || moving"
                          data-move-clear-selection
                          @click="clearNoteSelection"
                        >
                          取消全选
                        </button>
                      </span>
                    </header>
                    <section
                      v-for="group in previewGroups"
                      :key="group.dateKey"
                      class="historical-note-move__note-group"
                    >
                      <header class="historical-note-move__note-date">
                        <time :datetime="group.dateKey">{{ group.dateKey }}</time>
                        <span>{{ group.notes.length }} 条</span>
                      </header>
                      <ul>
                        <li v-for="note in group.notes" :key="note.id">
                          <label
                            class="historical-note-move__note-option"
                            :class="{ 'is-selected': noteIsSelected(note.id) }"
                            :data-note-id="note.id"
                          >
                            <input
                              type="checkbox"
                              :checked="noteIsSelected(note.id)"
                              :disabled="moving"
                              @change="toggleNoteSelection(note.id)"
                            />
                            <span class="historical-note-move__checkbox" aria-hidden="true">
                              <svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-7" /></svg>
                            </span>
                            <span :title="note.content">{{ note.content }}</span>
                          </label>
                        </li>
                      </ul>
                    </section>
                    <button
                      v-if="previewHasMore"
                      type="button"
                      class="historical-note-move__load-more"
                      :disabled="previewLoadingMore || moving"
                      data-move-load-more
                      @click="loadMorePreview"
                    >
                      {{ previewLoadingMore ? '正在加载…' : '继续显示更多便签' }}
                    </button>
                  </div>
                </div>
              </Transition>
            </div>
          </div>

          <button
            type="button"
            class="historical-note-move__execute"
            :disabled="
              moving ||
              previewLoading ||
              selectedCount <= 0 ||
              !selectionReady ||
              Boolean(previewError)
            "
            data-move-action
            @click="executeMove"
          >
            {{ executeLabel }}
          </button>
        </section>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.historical-note-move {
  display: flex;
  min-width: 0;
}

.historical-note-move__trigger {
  display: inline-flex;
  height: 30rem;
  align-items: center;
  gap: 6rem;
  padding: 0 9rem;
  border: 0;
  border-radius: 8rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease;
}

.historical-note-move__trigger:hover:not(:disabled) {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}

.historical-note-move__trigger.is-open {
  background: var(--ui-fill-pressed);
  color: var(--ui-accent);
}

.historical-note-move__trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--ui-accent-subtle);
}

.historical-note-move__trigger:disabled {
  cursor: default;
  opacity: 0.35;
}

.historical-note-move__trigger svg {
  width: 17rem;
  height: 17rem;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.55;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.historical-note-move__panel {
  position: fixed;
  z-index: var(--z-global-popover);
  width: min(350rem, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  padding: 14rem;
  border: 1px solid var(--surface-float-border);
  border-radius: 13rem;
  background: var(--surface-float);
  box-shadow: 0 18rem 48rem rgba(0, 0, 0, 0.28);
  color: var(--text-color);
}

.historical-note-move__header {
  display: flex;
  flex-direction: column;
  gap: 3rem;
}

.historical-note-move__header strong {
  font-size: var(--fs-body);
  font-weight: 650;
}

.historical-note-move__header span,
.historical-note-move__range-label,
.historical-note-move__preview {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.historical-note-move__presets {
  position: relative;
  display: grid;
  margin-top: 12rem;
  padding: 3rem;
  border-radius: 9rem;
  background: var(--ui-surface-subtle);
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3rem;
  isolation: isolate;
}

.historical-note-move__preset-indicator {
  position: absolute;
  z-index: var(--z-local-base);
  top: 3rem;
  bottom: 3rem;
  left: 3rem;
  width: calc((100% - 12rem) / 3);
  border-radius: 7rem;
  background: var(--ui-fill-pressed);
  transition:
    opacity var(--motion-control) ease,
    transform 260ms cubic-bezier(0.32, 0.72, 0, 1);
  will-change: transform;
}

.historical-note-move__presets button {
  position: relative;
  z-index: var(--z-local-content);
  min-width: 0;
  height: 31rem;
  padding: 0 6rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}

.historical-note-move__presets button:hover:not(:disabled) {
  color: var(--text-color);
}

.historical-note-move__presets button.is-active {
  color: var(--ui-accent);
  font-weight: 650;
}

.historical-note-move__range {
  margin-top: 12rem;
  padding: 8rem 10rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 9rem;
  background: var(--ui-surface-control);
}

.historical-note-move__range-label {
  display: block;
  margin-bottom: 2rem;
}

.historical-note-move__preview {
  min-height: 1.4em;
  margin: 10rem 2rem;
  line-height: 1.4;
}

.historical-note-move__preview-motion {
  overflow: hidden;
  transition: height 240ms var(--ease-emphasized);
  will-change: height;
}

.historical-note-move__preview-content {
  position: relative;
  display: flow-root;
}

.historical-note-move__preview-page {
  width: 100%;
}

.historical-note-move-forward-enter-active,
.historical-note-move-forward-leave-active,
.historical-note-move-backward-enter-active,
.historical-note-move-backward-leave-active {
  transition:
    opacity 160ms ease,
    transform 220ms var(--ease-standard);
}

.historical-note-move-forward-leave-active,
.historical-note-move-backward-leave-active {
  position: absolute;
  inset: 0 0 auto;
}

.historical-note-move-forward-enter-from,
.historical-note-move-backward-leave-to {
  opacity: 0;
  transform: translateX(14rem);
}

.historical-note-move-forward-leave-to,
.historical-note-move-backward-enter-from {
  opacity: 0;
  transform: translateX(-14rem);
}

.historical-note-move__preview.is-error {
  color: rgb(255, 59, 48);
}

.historical-note-move__note-list {
  max-height: 220rem;
  margin: 0 0 10rem;
  overflow-y: auto;
  border-radius: 9rem;
  background: var(--ui-surface-subtle);
  scrollbar-gutter: stable;
}

.historical-note-move__selection-bar {
  position: sticky;
  z-index: var(--z-local-raised);
  top: 0;
  display: flex;
  min-height: 34rem;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  padding: 3rem 6rem 3rem 10rem;
  border-bottom: 1px solid var(--ui-border-divider);
  background: var(--surface-float);
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.historical-note-move__selection-summary {
  display: grid;
  gap: 1rem;
}

.historical-note-move__selection-bar small {
  font-size: calc(var(--fs-secondary) * 0.88);
  opacity: 0.72;
}

.historical-note-move__selection-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 2rem;
}

.historical-note-move__selection-actions button {
  min-height: 27rem;
  padding: 0 6rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--ui-accent);
  font: inherit;
  cursor: pointer;
}

.historical-note-move__selection-actions button:hover:not(:disabled) {
  background: var(--ui-fill-hover);
}

.historical-note-move__selection-actions button:active:not(:disabled) {
  transform: scale(0.98);
}

.historical-note-move__selection-actions button:disabled {
  cursor: default;
  opacity: 0.32;
}

.historical-note-move__note-group + .historical-note-move__note-group {
  border-top: 1px solid var(--ui-border-divider);
}

.historical-note-move__note-date {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10rem;
  padding: 8rem 10rem 4rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-variant-numeric: tabular-nums;
}

.historical-note-move__note-date span {
  flex: 0 0 auto;
  opacity: 0.7;
}

.historical-note-move__note-group ul {
  margin: 0;
  padding: 0 10rem 7rem;
  list-style: none;
}

.historical-note-move__note-group li {
  padding: 0;
  color: var(--text-color);
  font-size: var(--fs-secondary);
  line-height: 1.45;
}

.historical-note-move__note-option {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 8rem;
  padding: 5rem 0;
  cursor: pointer;
}

.historical-note-move__note-option input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
}

.historical-note-move__checkbox {
  display: grid;
  width: 17rem;
  height: 17rem;
  flex: 0 0 auto;
  place-items: center;
  margin-top: 1rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 5rem;
  background: var(--ui-surface-control);
  transition:
    border-color var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}

.historical-note-move__note-option:hover .historical-note-move__checkbox {
  border-color: var(--ui-border-hover);
}

.historical-note-move__note-option input:focus-visible + .historical-note-move__checkbox {
  box-shadow: 0 0 0 2px var(--ui-accent-subtle);
}

.historical-note-move__note-option:active .historical-note-move__checkbox {
  transform: scale(0.94);
}

.historical-note-move__note-option.is-selected .historical-note-move__checkbox {
  border-color: var(--ui-accent);
  background: var(--ui-accent);
}

.historical-note-move__checkbox svg {
  width: 12rem;
  height: 12rem;
  fill: none;
  stroke: white;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  opacity: 0;
  transition: opacity var(--motion-fast) ease;
}

.historical-note-move__note-option.is-selected .historical-note-move__checkbox svg {
  opacity: 1;
}

.historical-note-move__note-option > span:last-child {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  flex: 1;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.historical-note-move__load-more {
  width: calc(100% - 20rem);
  min-height: 30rem;
  margin: 2rem 10rem 9rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--ui-accent);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}

.historical-note-move__load-more:hover:not(:disabled) {
  background: var(--ui-fill-hover);
}

.historical-note-move__load-more:disabled {
  cursor: default;
  opacity: 0.38;
}

.historical-note-move__execute {
  width: 100%;
  min-height: 34rem;
  padding: 0 10rem;
  border: 0;
  border-radius: 9rem;
  background: var(--ui-accent);
  color: white;
  font: inherit;
  font-size: var(--fs-secondary);
  font-weight: 650;
  cursor: pointer;
}

.historical-note-move__execute:disabled {
  cursor: default;
  opacity: 0.34;
}

@media (max-width: 760px) {
  .historical-note-move__trigger {
    width: 30rem;
    justify-content: center;
    padding: 0;
  }

  .historical-note-move__label {
    display: none;
  }
}
</style>
