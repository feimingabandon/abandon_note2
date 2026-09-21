<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import QuickNoteContentEditor from '../note/QuickNoteContentEditor.vue'
import NoteTextColorPopover from '../note/NoteTextColorPopover.vue'
import { useQuickNoteEditSetting } from '../../composables/useQuickNoteEditSetting.js'
import { useTagColorSetting } from '../../composables/useTagColorSetting.js'
import { useMessage } from '../../composables/useMessage.js'
import { pointerAnchorRect } from '../../utils/pointerAnchor.js'
import { getCalendarNoteAccent } from '../../utils/noteAppearance.js'
import { readTextSelection } from '../../utils/textSelection.js'
import {
  buildNoteTextColorSegments,
  normalizeNoteTextColorRanges
} from '../../../../shared/note-text-color-rules.js'

const props = defineProps({
  segment: { type: Object, required: true },
  note: { type: Object, required: true }
})
const emit = defineEmits(['open-context-menu', 'preview-images'])
const { showMessage } = useMessage()
const { enabled: doubleClickQuickEditEnabled } = useQuickNoteEditSetting()
const { enabled: tagColorEnabled } = useTagColorSetting()
const isRecurringPreview = computed(() => props.note.preview_kind === 'recurrence')
const isImageOnly = computed(
  () =>
    !isRecurringPreview.value &&
    !String(props.note.content || '').trim() &&
    Number(props.note.attachment_count) > 0
)
const accent = computed(() =>
  getCalendarNoteAccent(props.note, { tagColorEnabled: tagColorEnabled.value })
)
const scheduledTimeLabel = computed(() =>
  new Date(Number(props.note.effective_at)).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
)
const fullTitle = computed(() => {
  const content = String(props.note.content || '').trim()
  if (isImageOnly.value) return '查看图片'
  return isRecurringPreview.value
    ? `循环便签预览 · 预计 ${scheduledTimeLabel.value} 生成 · 只读\n${content}`
    : content
})
const previewSlice = computed(() => {
  const content = String(props.note.content || '')
  for (const match of content.matchAll(/([^\r\n]*)(?:\r\n|\n|\r|$)/g)) {
    const line = match[1]
    const text = line.trim()
    if (!text) continue
    return { text, start: Number(match.index) + line.indexOf(text) }
  }
  return { text: isImageOnly.value ? '查看图片' : '', start: -1 }
})
const previewText = computed(() => previewSlice.value.text)

const barRef = ref(null)
const tooltipRef = ref(null)
const tooltipContentRef = ref(null)
const tooltipVisible = ref(false)
const tooltipPlacement = ref('bottom')
const tooltipStyle = reactive({ top: '-9999px', left: '-9999px' })
const quickEditorVisible = ref(false)
const quickEditorAnchor = ref(null)
const textColorPopoverVisible = ref(false)
const textColorPopoverAnchor = ref(null)
const selectedTextRange = ref(null)
const savingTextColor = ref(false)
const colorRangeOverride = ref(null)
const TOOLTIP_GAP = 8
const VIEWPORT_PADDING = 8
const PLACEMENTS = ['bottom', 'top', 'right', 'left']
const SINGLE_CLICK_DELAY_MS = 220
let singleClickTimer = null

const effectiveColorRanges = computed(() =>
  normalizeNoteTextColorRanges(
    colorRangeOverride.value ?? props.note.content_color_ranges,
    String(props.note.content || '')
  )
)
const tooltipSegments = computed(() =>
  buildNoteTextColorSegments(String(props.note.content || ''), effectiveColorRanges.value)
)
const previewSegments = computed(() => {
  const preview = previewSlice.value
  if (preview.start < 0 || isRecurringPreview.value) return [{ text: preview.text }]
  const previewEnd = preview.start + preview.text.length
  const previewRanges = effectiveColorRanges.value.flatMap((range) => {
    const start = Math.max(range.start, preview.start)
    const end = Math.min(range.end, previewEnd)
    if (end <= start) return []
    return [
      {
        start: start - preview.start,
        end: end - preview.start,
        text: preview.text.slice(start - preview.start, end - preview.start),
        color: range.color
      }
    ]
  })
  return buildNoteTextColorSegments(preview.text, previewRanges)
})
const selectedTextColor = computed(() => {
  const selected = selectedTextRange.value
  if (!selected) return ''
  return (
    effectiveColorRanges.value.find(
      (range) => range.start <= selected.start && range.end >= selected.end
    )?.color || ''
  )
})

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function rawPosition(trigger, width, height, placement) {
  const centerX = trigger.left + trigger.width / 2
  const centerY = trigger.top + trigger.height / 2
  if (placement === 'top') {
    return { left: centerX - width / 2, top: trigger.top - height - TOOLTIP_GAP }
  }
  if (placement === 'right') {
    return { left: trigger.right + TOOLTIP_GAP, top: centerY - height / 2 }
  }
  if (placement === 'left') {
    return { left: trigger.left - width - TOOLTIP_GAP, top: centerY - height / 2 }
  }
  return { left: centerX - width / 2, top: trigger.bottom + TOOLTIP_GAP }
}

function positionFits(position, width, height) {
  return (
    position.left >= VIEWPORT_PADDING &&
    position.top >= VIEWPORT_PADDING &&
    position.left + width <= window.innerWidth - VIEWPORT_PADDING &&
    position.top + height <= window.innerHeight - VIEWPORT_PADDING
  )
}

function pickPosition(trigger, width, height) {
  for (const placement of PLACEMENTS) {
    const position = rawPosition(trigger, width, height, placement)
    if (positionFits(position, width, height)) return { placement, ...position }
  }
  const placement = PLACEMENTS[0]
  const position = rawPosition(trigger, width, height, placement)
  return {
    placement,
    left: clamp(position.left, VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
    top: clamp(position.top, VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING)
  }
}

function eventAnchor(event) {
  return pointerAnchorRect(event, barRef.value?.getBoundingClientRect())
}

async function toggleTooltip(anchor = eventAnchor()) {
  if (tooltipVisible.value) {
    tooltipVisible.value = false
    return
  }
  tooltipStyle.top = '-9999px'
  tooltipStyle.left = '-9999px'
  tooltipVisible.value = true
  await nextTick()
  const tooltip = tooltipRef.value?.getBoundingClientRect()
  if (!anchor || !tooltip) return
  const position = pickPosition(anchor, tooltip.width, tooltip.height)
  tooltipPlacement.value = position.placement
  tooltipStyle.top = `${position.top}px`
  tooltipStyle.left = `${position.left}px`
}

function scheduleTooltipToggle(event) {
  clearScheduledTooltipToggle()
  if (isImageOnly.value) {
    emit('preview-images', props.note)
    return
  }
  if (isRecurringPreview.value || !doubleClickQuickEditEnabled.value || event.detail === 0) {
    void toggleTooltip(eventAnchor(event))
    return
  }
  const anchor = eventAnchor(event)
  singleClickTimer = setTimeout(() => {
    singleClickTimer = null
    void toggleTooltip(anchor)
  }, SINGLE_CLICK_DELAY_MS)
}

function clearScheduledTooltipToggle() {
  if (singleClickTimer === null) return
  clearTimeout(singleClickTimer)
  singleClickTimer = null
}

function openQuickEditor(event) {
  if (
    isRecurringPreview.value ||
    isImageOnly.value ||
    !doubleClickQuickEditEnabled.value ||
    quickEditorVisible.value
  )
    return
  clearScheduledTooltipToggle()
  event.preventDefault()
  event.stopPropagation()
  closeTooltip()
  quickEditorAnchor.value = eventAnchor(event)
  quickEditorVisible.value = true
}

function closeQuickEditor() {
  quickEditorVisible.value = false
  quickEditorAnchor.value = null
}

function closeTextColorPopover() {
  textColorPopoverVisible.value = false
  selectedTextRange.value = null
}

function onTooltipPointerUp(event) {
  if (event.button !== 0 || isRecurringPreview.value) return
  const selected = readTextSelection(tooltipContentRef.value, String(props.note.content || ''))
  if (!selected) {
    closeTextColorPopover()
    return
  }
  selectedTextRange.value = selected
  textColorPopoverAnchor.value = selected.rect
  textColorPopoverVisible.value = true
}

async function saveTextColor(start, end, color, successMessage = '') {
  if (savingTextColor.value || isRecurringPreview.value) return
  savingTextColor.value = true
  try {
    const updated = await window.api.setNoteTextColor({
      id: props.note.id,
      start,
      end,
      color,
      expectedContent: String(props.note.content || ''),
      expectedColorRanges: effectiveColorRanges.value
    })
    if (!updated) throw new Error('便签不存在或已被删除')
    colorRangeOverride.value = updated.content_color_ranges || []
    window.getSelection?.()?.removeAllRanges()
    closeTextColorPopover()
    showMessage('success', successMessage || (color ? '文字颜色已保存' : '已清除所选文字颜色'))
  } catch (error) {
    console.error('[MonthEventBar] 保存文字颜色失败:', props.note.id, error)
    showMessage('error', error.message || '文字颜色保存失败，请重试')
  } finally {
    savingTextColor.value = false
  }
}

function applySelectedTextColor(color) {
  const selected = selectedTextRange.value
  if (!selected) return
  void saveTextColor(selected.start, selected.end, color)
}

function clearAllTextColors() {
  const content = String(props.note.content || '')
  if (!content.trim()) return
  void saveTextColor(0, content.length, null, '已清除当前便签的全部文字颜色')
}

function closeTooltip() {
  clearScheduledTooltipToggle()
  closeTextColorPopover()
  tooltipVisible.value = false
}

function openContextMenu(event) {
  closeTooltip()
  if (isRecurringPreview.value) return
  emit('open-context-menu', { event, note: props.note })
}

function onDocumentPointerDown(event) {
  if (
    barRef.value?.contains(event.target) ||
    tooltipRef.value?.contains(event.target) ||
    event.target.closest?.('[data-note-text-color-popover]')
  )
    return
  if (!tooltipVisible.value && singleClickTimer === null) return
  closeTooltip()
}

function onKeydown(event) {
  if (event.key === 'Escape') closeTooltip()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', closeTooltip)
  window.addEventListener('scroll', closeTooltip, true)
})

onBeforeUnmount(() => {
  clearScheduledTooltipToggle()
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', closeTooltip)
  window.removeEventListener('scroll', closeTooltip, true)
})

watch(
  () => [props.note.content, props.note.updated_at],
  () => {
    colorRangeOverride.value = null
    closeTextColorPopover()
  }
)
</script>

<template>
  <button
    ref="barRef"
    type="button"
    class="month-event-bar"
    :class="[
      `is-${note.status}`,
      {
        'is-recurring-preview': isRecurringPreview,
        'continues-before': segment.continuesBefore,
        'continues-after': segment.continuesAfter
      }
    ]"
    :style="{
      '--event-accent': accent,
      '--event-lane': segment.lane,
      gridColumn: `${segment.columnStart} / span ${segment.columnSpan}`
    }"
    :data-preview="previewText"
    :data-note-id="note.id"
    :data-segment-key="`${note.id}:${segment.weekIndex}`"
    :aria-label="fullTitle"
    :aria-expanded="tooltipVisible"
    @click.stop="scheduleTooltipToggle"
    @dblclick="openQuickEditor"
    @contextmenu.prevent.stop="openContextMenu"
  >
    <span v-if="!segment.continuesBefore" class="month-event-bar__dot" aria-hidden="true" />
    <span class="month-event-bar__text">
      <span
        v-for="(colorSegment, index) in previewSegments"
        :key="`${index}:${colorSegment.start ?? 0}:${colorSegment.end ?? 0}:${colorSegment.color || 'default'}`"
        :style="colorSegment.color ? { color: colorSegment.color } : undefined"
        >{{ colorSegment.text }}</span
      >
    </span>
    <span v-if="segment.continuesAfter" class="month-event-bar__continuation" aria-hidden="true"
      >›</span
    >
  </button>

  <QuickNoteContentEditor
    v-if="!isRecurringPreview && quickEditorVisible && quickEditorAnchor"
    :note="note"
    :anchor-rect="quickEditorAnchor"
    @close="closeQuickEditor"
  />

  <Teleport to="body">
    <Transition name="month-event-tooltip">
      <section
        v-if="tooltipVisible"
        ref="tooltipRef"
        class="month-event-tooltip scroll-y"
        :class="`is-${tooltipPlacement}`"
        :style="tooltipStyle"
        role="dialog"
        :aria-label="isRecurringPreview ? '循环便签详情' : '便签详情，可选择文字设置颜色'"
      >
        <template v-if="isRecurringPreview">{{ fullTitle }}</template>
        <span
          v-else
          ref="tooltipContentRef"
          class="month-event-tooltip__content"
          @pointerup="onTooltipPointerUp"
        >
          <span
            v-for="colorSegment in tooltipSegments"
            :key="`${colorSegment.start}:${colorSegment.end}:${colorSegment.color || 'default'}`"
            :style="colorSegment.color ? { color: colorSegment.color } : undefined"
            >{{ colorSegment.text }}</span
          >
        </span>
      </section>
    </Transition>
  </Teleport>

  <NoteTextColorPopover
    v-if="!isRecurringPreview"
    v-model:visible="textColorPopoverVisible"
    :anchor-rect="textColorPopoverAnchor"
    :selected-color="selectedTextColor"
    :has-colors="effectiveColorRanges.length > 0"
    :busy="savingTextColor"
    @apply="applySelectedTextColor"
    @clear-all="clearAllTextColors"
  />
</template>

<style scoped>
.month-event-bar {
  position: relative;
  z-index: var(--z-local-overlay);
  display: flex;
  grid-row: 1;
  height: max(19rem, calc(var(--fs-month-event) + 6rem));
  align-items: center;
  align-self: start;
  gap: 5rem;
  min-width: 0;
  margin-block: 0;
  margin-inline: 6rem;
  padding: 0 7rem;
  border: 0;
  border-radius: 5rem;
  background: color-mix(in srgb, var(--event-accent) 82%, transparent);
  box-shadow: 0 1rem 3rem color-mix(in srgb, var(--event-accent) 22%, transparent);
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-size: var(--fs-month-event);
  line-height: 1;
  pointer-events: auto;
  transform: translateY(calc(var(--event-lane) * max(22rem, calc(var(--fs-month-event) + 9rem))));
  transition: filter 140ms ease;
}
.month-event-bar:hover {
  filter: brightness(1.08);
}
.month-event-bar:active {
  filter: brightness(0.94);
}
.month-event-bar.continues-before {
  margin-inline-start: 0;
  border-top-left-radius: 1rem;
  border-bottom-left-radius: 1rem;
}
.month-event-bar.continues-after {
  margin-inline-end: 0;
  border-top-right-radius: 1rem;
  border-bottom-right-radius: 1rem;
}
.month-event-bar.is-completed {
  opacity: 0.72;
}
.month-event-bar.is-recurring-preview {
  background: color-mix(in srgb, var(--event-accent) 24%, var(--ui-surface-subtle));
  box-shadow: none;
  color: var(--text-color-secondary);
  cursor: help;
  opacity: 0.72;
}
.month-event-bar.is-recurring-preview:hover {
  filter: none;
  opacity: 0.88;
}
.month-event-bar.is-recurring-preview:active {
  filter: none;
}
.month-event-bar.is-recurring-preview .month-event-bar__dot {
  box-sizing: border-box;
  border: 1px solid currentColor;
  background: transparent;
}
.month-event-bar__dot {
  width: 5rem;
  height: 5rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentColor;
}
.month-event-bar__text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  white-space: nowrap;
}
.month-event-bar__continuation {
  margin-left: auto;
  opacity: 0.8;
}
</style>

<style>
.month-event-tooltip {
  position: fixed;
  z-index: var(--z-global-popover);
  width: max-content;
  max-width: min(320rem, calc(100vw - 16px));
  max-height: min(240rem, calc(100vh - 16px));
  padding: 9rem 12rem;
  overflow-wrap: anywhere;
  border: 1px solid var(--surface-float-border);
  border-radius: 8rem;
  background: var(--surface-float);
  box-shadow: 0 6rem 18rem rgba(0, 0, 0, 0.16);
  color: var(--text-color);
  font-size: var(--fs-secondary);
  font-weight: 500;
  line-height: 1.45;
  text-align: left;
  user-select: text;
  white-space: pre-wrap;
}
.month-event-tooltip::after {
  position: absolute;
  border: 5rem solid transparent;
  content: '';
}
.month-event-tooltip__content {
  display: inline;
}
.month-event-tooltip.is-bottom::after {
  bottom: 100%;
  left: 50%;
  border-bottom-color: var(--surface-float-border);
  transform: translateX(-50%);
}
.month-event-tooltip.is-top::after {
  top: 100%;
  left: 50%;
  border-top-color: var(--surface-float-border);
  transform: translateX(-50%);
}
.month-event-tooltip.is-right::after {
  top: 50%;
  right: 100%;
  border-right-color: var(--surface-float-border);
  transform: translateY(-50%);
}
.month-event-tooltip.is-left::after {
  top: 50%;
  left: 100%;
  border-left-color: var(--surface-float-border);
  transform: translateY(-50%);
}
.month-event-tooltip-enter-active,
.month-event-tooltip-leave-active {
  transition:
    opacity 150ms ease,
    transform 150ms ease;
}
.month-event-tooltip-enter-from,
.month-event-tooltip-leave-to {
  opacity: 0;
  transform: translateY(-3rem);
}
</style>
