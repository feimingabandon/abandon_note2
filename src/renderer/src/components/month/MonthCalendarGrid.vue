<script setup>
import { isComposingInput } from '../../utils/inputComposition.js'
import { useDraftProtection } from '../../composables/useDraftProtection.js'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import MonthEventBar from './MonthEventBar.vue'
import { animateCalendarPreview, calendarPreviewPosition } from './calendar-day-preview.js'
import {
  buildCalendarEventSegments,
  hasHiddenCalendarNotes,
  noteCountsByDate,
  notesCoveringDate
} from '../../../../shared/calendar/calendar-event-layout.js'
import {
  calendarGridNavigationTarget,
  calendarGridTabKey
} from '../../utils/calendar-grid-navigation.js'
import { useMessage } from '../../composables/useMessage.js'
import { combineLocalDateAndTime } from '../../../../shared/calendar/calendar-date-rules.js'
import { defaultMonthNoteEffectiveTime } from '../../../../shared/note-scheduling-rules.js'

const props = defineProps({
  viewMode: { type: String, default: 'month' },
  days: { type: Array, default: () => [] },
  notes: { type: Array, default: () => [] },
  selectedKey: { type: String, default: '' },
  todayKey: { type: String, required: true },
  weatherByDate: { type: Map, default: () => new Map() }
})
const emit = defineEmits([
  'select-date',
  'quick-create-opened',
  'quick-created',
  'context-select-date',
  'context-create',
  'context-edit',
  'context-delete',
  'context-status-action',
  'preview-open-day-panel'
])
const { showMessage } = useMessage()
const gridRef = ref(null)
const weekRefs = ref([])
const dayCellRefs = new Map()
const quickCreatorRefs = new Map()
const quickInputRefs = new Map()
const contextMenuRef = ref(null)
const dayPreviewRef = ref(null)
const quickDrafts = reactive(new Map())
const quickSavingKeys = reactive(new Set())
const activeQuickCreateKey = ref('')
const quickCreateReady = ref(false)
const contextMenuVisible = ref(false)
const contextMenuTarget = ref(null)
const contextMenuStyle = reactive({ left: '-9999px', top: '-9999px' })
const dayPreviewVisible = ref(false)
const dayPreviewKey = ref('')
const dayPreviewPlacement = ref('right')
const dayPreviewStyle = reactive({ left: '-9999px', top: '-9999px' })
const detachedEventBars = new Set()
const rowCount = computed(() => Math.ceil(props.days.length / 7))
const capacityByWeek = ref(Array.from({ length: rowCount.value }, () => 0))
const EVENT_MOTION_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
let quickCreateReadyTimer = null
let contextMenuTrigger = null
let dayPreviewTrigger = null
function isActiveDay(day) {
  return day?.isActive ?? day?.inCurrentMonth
}

const activeDays = computed(() => props.days.filter(isActiveDay))
const segments = computed(() =>
  buildCalendarEventSegments(props.days, props.notes, {
    activeStartKey: activeDays.value[0]?.key,
    activeEndKey: activeDays.value.at(-1)?.key
  })
)
const noteById = computed(() => new Map(props.notes.map((note) => [Number(note.id), note])))
const noteCounts = computed(() => noteCountsByDate(activeDays.value, props.notes))
const dayPreviewNotes = computed(() =>
  dayPreviewKey.value ? notesCoveringDate(props.notes, dayPreviewKey.value) : []
)
const contextMenuNote = computed(() => {
  if (contextMenuTarget.value?.type !== 'note') return null
  return noteById.value.get(Number(contextMenuTarget.value.noteId)) || null
})
const visibleNoteCounts = computed(() => {
  const counts = new Map()
  for (const segment of segments.value) {
    if (!segmentIsVisible(segment)) continue
    for (let offset = 0; offset < segment.columnSpan; offset += 1) {
      const day = props.days[segment.weekIndex * 7 + segment.columnStart - 1 + offset]
      if (isActiveDay(day)) counts.set(day.key, (counts.get(day.key) || 0) + 1)
    }
  }
  return counts
})
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
let observer = null
let fontObserver = null
let resizeFrame = null

function setWeekRef(element, index) {
  const previous = weekRefs.value[index]
  if (previous === element) return
  if (previous) observer?.unobserve(previous)
  weekRefs.value[index] = element
  if (element) observer?.observe(element)
}

function setDayCellRef(element, key) {
  if (element) dayCellRefs.set(key, element)
  else dayCellRefs.delete(key)
}

function setQuickCreatorRef(element, key) {
  if (element) quickCreatorRefs.set(key, element)
  else quickCreatorRefs.delete(key)
}

function setQuickInputRef(element, key) {
  if (element) quickInputRefs.set(key, element)
  else quickInputRefs.delete(key)
}

function segmentIsVisible(segment) {
  return segment.lane < (capacityByWeek.value[segment.weekIndex] || 0)
}

function visibleEventLayoutSignature(notes) {
  return buildCalendarEventSegments(props.days, notes, {
    activeStartKey: activeDays.value[0]?.key,
    activeEndKey: activeDays.value.at(-1)?.key
  })
    .filter(segmentIsVisible)
    .map(
      (segment) =>
        `${segment.noteId}:${segment.weekIndex}:${segment.lane}:${segment.columnStart}:${segment.columnSpan}`
    )
    .join('|')
}

function dayHasHiddenNotes(day) {
  return hasHiddenCalendarNotes(
    noteCounts.value.get(day.key) || 0,
    visibleNoteCounts.value.get(day.key) || 0
  )
}

function dayCountLabel(day) {
  const total = noteCounts.value.get(day.key) || 0
  return dayHasHiddenNotes(day)
    ? `${day.key} 共 ${total} 条便签，已显示 ${visibleNoteCounts.value.get(day.key) || 0} 条，点击预览全部`
    : `${day.key} 共 ${total} 条便签`
}

function toggleCountPreview(day, event) {
  if (!dayHasHiddenNotes(day) || activeQuickCreateKey.value === day.key) return
  if (dayPreviewVisible.value && dayPreviewKey.value === day.key) {
    closeDayPreview()
    event.currentTarget.focus()
    return
  }
  closeQuickCreator()
  emit('context-select-date', day)
  void openDayPreview(day, event.currentTarget)
}

function calculateCapacity() {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  const headerHeight = 35 * rem
  const footerHeight = 18 * rem
  const base =
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--font-size-base')
    ) || 20
  const pitch = Math.max(22, base * 0.72 + 9) * rem
  const next = weekRefs.value.map((element) => {
    const height = element?.getBoundingClientRect().height || 0
    return Math.max(0, Math.floor((height - headerHeight - footerHeight) / pitch))
  })
  capacityByWeek.value = Array.from({ length: rowCount.value }, (_, index) => next[index] || 0)
}

function queueCapacityCalculation() {
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null
    calculateCapacity()
  })
}

function selectDay(day) {
  if (isActiveDay(day)) emit('select-date', day)
}

const tabStopKey = computed(() => calendarGridTabKey(props.days, props.selectedKey, props.todayKey))

async function handleDayKeydown(event, day) {
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    selectDay(day)
    return
  }
  const target = calendarGridNavigationTarget(props.days, day.key, event.key)
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
    return
  event.preventDefault()
  if (!target) return
  if (target.key !== day.key) selectDay(target)
  await nextTick()
  dayCellRefs.get(target.key)?.focus()
}

function quickDraft(key) {
  return quickDrafts.get(key) || ''
}

function updateQuickDraft(key, value) {
  quickDrafts.set(key, value)
}

function clearQuickCreateReadyTimer() {
  if (quickCreateReadyTimer !== null) clearTimeout(quickCreateReadyTimer)
  quickCreateReadyTimer = null
}

async function focusQuickCreator(key) {
  await nextTick()
  const input = quickInputRefs.get(key)
  if (!input || activeQuickCreateKey.value !== key) return
  input.focus()
  const end = input.value.length
  input.setSelectionRange?.(end, end)
}

function closeQuickCreator({ restoreFocus = false } = {}) {
  const key = activeQuickCreateKey.value
  if (!key) return
  clearQuickCreateReadyTimer()
  quickCreateReady.value = false
  activeQuickCreateKey.value = ''
  if (restoreFocus) {
    void nextTick(() =>
      dayCellRefs.get(key)?.querySelector('.month-day-cell__quick-activate')?.focus()
    )
  }
}

function closeContextMenu({ restoreFocus = false } = {}) {
  if (!contextMenuVisible.value) return
  contextMenuVisible.value = false
  contextMenuTarget.value = null
  if (restoreFocus) contextMenuTrigger?.focus?.()
  contextMenuTrigger = null
}

function closeDayPreview({ restoreFocus = false } = {}) {
  if (!dayPreviewVisible.value) return
  const trigger = dayPreviewTrigger?.isConnected
    ? dayPreviewTrigger
    : dayCellRefs.get(dayPreviewKey.value)
  dayPreviewTrigger = null
  dayPreviewVisible.value = false
  dayPreviewKey.value = ''
  if (restoreFocus) trigger?.focus()
}

function previewNoteText(note) {
  const content = String(note?.content || '').trim()
  if (content) return content
  return Number(note?.attachment_count) > 0 ? '图片便签' : '空便签'
}

function previewNoteAccent(note) {
  if (note?.status === 'completed') return '#8e8e93'
  if (note?.status === 'in_progress') return '#ff9f0a'
  return '#0a84ff'
}

function positionDayPreviewElement(element) {
  if (!dayPreviewVisible.value || !dayPreviewKey.value) return
  const anchor = dayCellRefs.get(dayPreviewKey.value)?.getBoundingClientRect()
  const preview = element?.getBoundingClientRect()
  if (!anchor || !preview) return
  const position = calendarPreviewPosition(anchor, preview, {
    width: window.innerWidth,
    height: window.innerHeight
  })
  dayPreviewPlacement.value = position.placement
  dayPreviewStyle.left = `${position.left}px`
  dayPreviewStyle.top = `${position.top}px`
  Object.assign(element.style, dayPreviewStyle)
}

async function positionDayPreview() {
  await nextTick()
  positionDayPreviewElement(dayPreviewRef.value)
}

function enterDayPreview(element, done) {
  positionDayPreviewElement(element)
  animateCalendarPreview(element, done, dayPreviewPlacement.value, true)
}

function leaveDayPreview(element, done) {
  animateCalendarPreview(element, done, dayPreviewPlacement.value, false)
}

async function openDayPreview(day, trigger = null) {
  if (!isActiveDay(day)) return
  closeContextMenu()
  dayPreviewTrigger = trigger
  dayPreviewKey.value = day.key
  dayPreviewVisible.value = true
  await positionDayPreview()
  dayPreviewRef.value?.querySelector('button')?.focus()
}

function openPreviewDayPanel() {
  const day = props.days.find((item) => item.key === dayPreviewKey.value)
  if (!day) return
  closeDayPreview({ restoreFocus: true })
  emit('preview-open-day-panel', day)
}

function onDayPreviewKeydown(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closeDayPreview({ restoreFocus: true })
}

function contextStatusLabel(note) {
  if (note?.status === 'initialized') return '切换为进行中'
  if (note?.status === 'in_progress') return '切换为已完成'
  if (note?.status === 'completed') return '重新进行'
  return ''
}

async function openContextMenu(event, target) {
  event.preventDefault()
  event.stopPropagation()
  closeDayPreview()
  closeContextMenu()
  contextMenuTrigger = event.currentTarget
  contextMenuTarget.value = target
  contextMenuStyle.left = `${event.clientX}px`
  contextMenuStyle.top = `${event.clientY}px`
  contextMenuVisible.value = true
  await nextTick()

  const menu = contextMenuRef.value
  const rect = menu?.getBoundingClientRect()
  if (!menu || !rect) return
  const gap = 8
  contextMenuStyle.left = `${Math.max(gap, Math.min(event.clientX, window.innerWidth - rect.width - gap))}px`
  contextMenuStyle.top = `${Math.max(gap, Math.min(event.clientY, window.innerHeight - rect.height - gap))}px`
  const firstAction = menu.querySelector('button:not(:disabled)')
  if (firstAction) firstAction.focus()
  else menu.focus()
}

function openDayContextMenu(event, day) {
  if (!isActiveDay(day)) return
  if (event.target.closest?.('.month-day-cell__quick-create input')) return
  if (activeQuickCreateKey.value) closeQuickCreator()
  emit('context-select-date', day)
  void openContextMenu(event, { type: 'day', day })
}

function openNoteContextMenu({ event, note }) {
  if (!event || !note) return
  if (activeQuickCreateKey.value) closeQuickCreator()
  void openContextMenu(event, { type: 'note', noteId: Number(note.id) })
}

function runContextMenuAction(action) {
  const target = contextMenuTarget.value
  if (!target) return
  const note = target.type === 'note' ? contextMenuNote.value : null
  closeContextMenu({ restoreFocus: action !== 'preview' })
  if (action === 'create' && target.type === 'day') {
    emit('context-create', target.day)
    return
  }
  if (action === 'preview' && target.type === 'day') {
    void openDayPreview(target.day)
    return
  }
  if (target.type !== 'note' || !note) return
  if (action === 'status') emit('context-status-action', note)
  else if (action === 'edit') emit('context-edit', note)
  else if (action === 'delete') emit('context-delete', note)
}

function onContextMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeContextMenu({ restoreFocus: true })
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = [...(contextMenuRef.value?.querySelectorAll('button:not(:disabled)') || [])]
  if (!buttons.length) return
  event.preventDefault()
  const current = buttons.indexOf(document.activeElement)
  let targetIndex = 0
  if (event.key === 'End') targetIndex = buttons.length - 1
  else if (event.key === 'ArrowDown') targetIndex = current < 0 ? 0 : (current + 1) % buttons.length
  else if (event.key === 'ArrowUp') {
    targetIndex = current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length
  }
  buttons[targetIndex]?.focus()
}

async function openQuickCreator(day) {
  if (!isActiveDay(day)) return
  clearQuickCreateReadyTimer()
  activeQuickCreateKey.value = day.key
  quickCreateReady.value = false
  emit('quick-create-opened', day)
  await focusQuickCreator(day.key)
  quickCreateReadyTimer = setTimeout(() => {
    quickCreateReadyTimer = null
    if (activeQuickCreateKey.value === day.key) quickCreateReady.value = true
  }, 260)
}

function onQuickCreatorFocusOut(day, event) {
  const creator = event.currentTarget
  setTimeout(() => {
    if (activeQuickCreateKey.value !== day.key) return
    if (quickSavingKeys.has(day.key)) return
    if (!creator.contains(document.activeElement)) closeQuickCreator()
  }, 0)
}

function onQuickInputKeydown(event, day) {
  if (isComposingInput(event)) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeQuickCreator({ restoreFocus: true })
    return
  }
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    void submitQuickNote(day)
  }
}

async function submitQuickNote(day) {
  if (quickSavingKeys.has(day.key)) return
  const content = quickDraft(day.key)
  if (!content.trim()) {
    showMessage('warning', '请输入便签内容')
    await focusQuickCreator(day.key)
    return
  }
  const options = { content, durationDays: 1 }
  if (day.key !== props.todayKey) {
    const time = defaultMonthNoteEffectiveTime(day.key, props.todayKey, new Date())
    options.effectiveAt = combineLocalDateAndTime(day.key, time)
  }

  quickSavingKeys.add(day.key)
  try {
    const created = await window.api.createNote(options)
    if (!created?.id) throw new Error('创建接口未返回便签')
    quickDrafts.set(day.key, '')
    emit('quick-created', created)
    showMessage('success', day.key < props.todayKey ? '历史便签补录成功' : '便签创建成功')
    if (activeQuickCreateKey.value === day.key) await focusQuickCreator(day.key)
  } catch (error) {
    console.error('[MonthCalendarGrid] 快速创建失败:', error)
    showMessage('error', error.message || '创建失败，请重试')
    if (activeQuickCreateKey.value === day.key) await focusQuickCreator(day.key)
  } finally {
    quickSavingKeys.delete(day.key)
  }
}

function onDocumentPointerDown(event) {
  if (contextMenuVisible.value && !contextMenuRef.value?.contains(event.target)) closeContextMenu()
  // 数量按钮由 click 切换预览，不能在捕获阶段先关闭再被 click 重新打开。
  const countTrigger = event.target.closest?.('.month-day-cell__count.is-overflow')
  if (
    dayPreviewVisible.value &&
    !dayPreviewRef.value?.contains(event.target) &&
    !gridRef.value?.contains(countTrigger)
  )
    closeDayPreview()
  if (!activeQuickCreateKey.value) return
  const creator = quickCreatorRefs.get(activeQuickCreateKey.value)
  if (creator?.contains(event.target)) return
  closeQuickCreator()
}

function onWindowScroll(event) {
  if (dayPreviewRef.value?.contains(event.target)) return
  closeDayPreview()
}

function captureVisibleEventBars() {
  return new Map(
    [...(gridRef.value?.querySelectorAll('.month-event-bar[data-segment-key]') || [])].map(
      (element) => [
        element.dataset.segmentKey,
        {
          element,
          opacity: getComputedStyle(element).opacity,
          rect: element.getBoundingClientRect()
        }
      ]
    )
  )
}

function removeDetachedEventBar(clone) {
  detachedEventBars.delete(clone)
  clone.remove()
}

function animateRemovedEventBar({ element, opacity, rect }, order) {
  const clone = element.cloneNode(true)
  clone.removeAttribute('tabindex')
  clone.removeAttribute('aria-expanded')
  clone.setAttribute('aria-hidden', 'true')
  clone.setAttribute('data-calendar-presence-clone', '')
  Object.assign(clone.style, {
    position: 'fixed',
    zIndex: 'var(--z-global-presence)',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    transform: 'none',
    transition: 'none'
  })
  document.body.appendChild(clone)
  detachedEventBars.add(clone)
  const animation = clone.animate(
    [
      { opacity, translate: '0 0', scale: '1 1' },
      { opacity: 0, translate: '0 -3px', scale: '0.985 0.88' }
    ],
    {
      duration: 220,
      delay: Math.min(order, 5) * 18,
      easing: EVENT_MOTION_EASING,
      fill: 'both'
    }
  )
  animation.finished.then(
    () => removeDetachedEventBar(clone),
    () => removeDetachedEventBar(clone)
  )
}

function animateEventBarChanges(before) {
  const after = captureVisibleEventBars()
  let removedIndex = 0
  for (const [key, snapshot] of before) {
    const current = after.get(key)
    if (!current) {
      animateRemovedEventBar(snapshot, removedIndex++)
      continue
    }
    const deltaX = snapshot.rect.left - current.rect.left
    const deltaY = snapshot.rect.top - current.rect.top
    if (Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5) {
      current.element.animate([{ translate: `${deltaX}px ${deltaY}px` }, { translate: '0 0' }], {
        duration: 300,
        easing: EVENT_MOTION_EASING
      })
    }
  }

  let addedIndex = 0
  for (const [key, current] of after) {
    if (before.has(key)) continue
    const targetOpacity = getComputedStyle(current.element).opacity
    current.element.animate(
      [
        { opacity: 0, translate: '0 4px', scale: '0.985 0.88' },
        { opacity: targetOpacity, translate: '0 0', scale: '1 1' }
      ],
      {
        duration: 260,
        delay: Math.min(addedIndex++, 5) * 22,
        easing: EVENT_MOTION_EASING,
        fill: 'backwards'
      }
    )
  }
}

function cancelEventBarMotion() {
  for (const element of gridRef.value?.querySelectorAll('.month-event-bar') || []) {
    for (const animation of element.getAnimations()) animation.cancel()
  }
  for (const clone of detachedEventBars) {
    for (const animation of clone.getAnimations()) animation.cancel()
    clone.remove()
  }
  detachedEventBars.clear()
}

function weatherPrecipitationLabel(weather) {
  if (
    weather?.precipitationProbability !== null &&
    weather?.precipitationProbability !== undefined
  ) {
    return `降水概率 ${weather.precipitationProbability}%`
  }
  return weather?.precipitation !== null && weather?.precipitation !== undefined
    ? `预计降水 ${weather.precipitation} mm`
    : '暂无降水数据'
}

watch([segments, () => props.days], async () => {
  await nextTick()
  weekRefs.value.length = rowCount.value
  queueCapacityCalculation()
  if (dayPreviewVisible.value) void positionDayPreview()
})

watch(
  [() => props.notes, () => props.days.map((day) => day.key).join('|')],
  async ([nextNotes, nextDayRange], [previousNotes, previousDayRange]) => {
    if (nextNotes === previousNotes) return
    if (nextDayRange !== previousDayRange) {
      cancelEventBarMotion()
      return
    }
    if (visibleEventLayoutSignature(nextNotes) === visibleEventLayoutSignature(previousNotes))
      return
    cancelEventBarMotion()
    const before = captureVisibleEventBars()
    await nextTick()
    animateEventBarChanges(before)
  },
  { flush: 'pre' }
)

watch(contextMenuNote, (note) => {
  if (contextMenuVisible.value && contextMenuTarget.value?.type === 'note' && !note) {
    closeContextMenu()
  }
})

watch(
  () => props.days.map((day) => day.key),
  (keys, previousKeys) => {
    if (keys.join('|') !== previousKeys.join('|')) closeContextMenu()
    if (activeQuickCreateKey.value && !keys.includes(activeQuickCreateKey.value)) {
      closeQuickCreator()
    }
    if (dayPreviewKey.value && !keys.includes(dayPreviewKey.value)) closeDayPreview()
  }
)

watch(
  () =>
    dayPreviewNotes.value.map((note) => `${note.id}:${note.status}:${note.updated_at}`).join('|'),
  () => {
    if (dayPreviewVisible.value) void positionDayPreview()
  }
)

onMounted(() => {
  fontObserver = new MutationObserver(queueCapacityCalculation)
  fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  observer = new ResizeObserver(queueCapacityCalculation)
  weekRefs.value.forEach((element) => element && observer.observe(element))
  queueCapacityCalculation()
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('resize', closeContextMenu)
  window.addEventListener('resize', positionDayPreview)
  window.addEventListener('scroll', closeContextMenu, true)
  window.addEventListener('scroll', onWindowScroll, true)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  fontObserver?.disconnect()
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
  clearQuickCreateReadyTimer()
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('resize', closeContextMenu)
  window.removeEventListener('resize', positionDayPreview)
  window.removeEventListener('scroll', closeContextMenu, true)
  window.removeEventListener('scroll', onWindowScroll, true)
  closeContextMenu()
  closeDayPreview()
  cancelEventBarMotion()
})
useDraftProtection({
  key: 'calendar:quick',
  fields: {},
  dirty: () => [...quickDrafts.values()].some((value) => !!value),
  busy: () => quickSavingKeys.size > 0,
  extra: () => ({ drafts: [...quickDrafts] }),
  restoreExtra: (data) => {
    for (const [key, value] of data.drafts || []) quickDrafts.set(key, value)
  }
})
</script>

<template>
  <section
    ref="gridRef"
    class="month-grid"
    :class="{ 'is-week-view': viewMode === 'week' }"
    role="grid"
    :aria-label="viewMode === 'week' ? '周历' : '月历'"
    :aria-rowcount="rowCount + 1"
    aria-colcount="7"
  >
    <div class="month-grid__weekdays" role="row">
      <span v-for="weekday in weekdays" :key="weekday" role="columnheader">周{{ weekday }}</span>
    </div>

    <div class="month-grid__weeks" :style="{ '--calendar-rows': rowCount }">
      <div
        v-for="weekIndex in rowCount"
        :key="weekIndex"
        :ref="(element) => setWeekRef(element, weekIndex - 1)"
        class="month-week"
        role="row"
      >
        <div class="month-week__cells">
          <div
            v-for="day in days.slice((weekIndex - 1) * 7, weekIndex * 7)"
            :key="day.key"
            :ref="(element) => setDayCellRef(element, day.key)"
            class="month-day-cell"
            :class="{
              'is-outside': !day.inCurrentMonth,
              'is-unavailable': !isActiveDay(day),
              'is-selected': isActiveDay(day) && day.key === selectedKey,
              'is-today': isActiveDay(day) && day.key === todayKey
            }"
            :data-date="day.key"
            role="gridcell"
            :aria-label="`${day.year}年${day.month}月${day.day}日`"
            :aria-disabled="!isActiveDay(day)"
            :aria-selected="isActiveDay(day) && day.key === selectedKey"
            :aria-current="isActiveDay(day) && day.key === todayKey ? 'date' : undefined"
            :tabindex="isActiveDay(day) && day.key === tabStopKey ? 0 : -1"
            @click="selectDay(day)"
            @contextmenu="openDayContextMenu($event, day)"
            @keydown="handleDayKeydown($event, day)"
          >
            <div class="month-day-cell__header">
              <span class="month-day-cell__number">{{ day.day }}</span>
              <span
                v-if="isActiveDay(day) && day.metadata?.displayLabel"
                class="month-day-cell__lunar"
                :class="{
                  'is-festival': day.metadata.festival,
                  'is-public-holiday-festival': day.metadata.hasPublicHolidayFestival,
                  'is-solar-term': !day.metadata.festival && day.metadata.solarTerm
                }"
                :title="
                  day.metadata.detailLabel ||
                  `农历${day.metadata.lunar?.monthText}${day.metadata.lunar?.dayText}`
                "
              >
                {{ day.metadata.displayLabel }}
              </span>
              <span
                v-if="isActiveDay(day) && weatherByDate.get(day.key)"
                class="month-day-cell__weather"
                :title="`${weatherByDate.get(day.key).label}，${weatherByDate.get(day.key).temperatureMin}°～${weatherByDate.get(day.key).temperatureMax}°，${weatherPrecipitationLabel(weatherByDate.get(day.key))}`"
              >
                <span aria-hidden="true">{{ weatherByDate.get(day.key).icon }}</span>
                <span class="month-day-cell__weather-temperature">
                  {{ weatherByDate.get(day.key).temperatureMin }}°·{{
                    weatherByDate.get(day.key).temperatureMax
                  }}°
                </span>
              </span>
              <span class="month-day-cell__badges">
                <span
                  v-if="isActiveDay(day) && day.metadata?.holiday"
                  class="month-day-cell__holiday"
                  :class="`is-${day.metadata.holiday.type}`"
                  :title="`${day.metadata.holiday.name} · ${day.metadata.holiday.type === 'off' ? '休息' : '调班'}`"
                  :aria-label="`${day.metadata.holiday.name}，${day.metadata.holiday.type === 'off' ? '休息' : '调班工作'}`"
                >
                  {{ day.metadata.holiday.type === 'off' ? '休' : '班' }}
                </span>
                <span
                  v-if="isActiveDay(day) && day.key === todayKey"
                  class="month-day-cell__today"
                  aria-label="今天"
                >
                  今
                </span>
              </span>
            </div>
            <button
              v-if="isActiveDay(day) && activeQuickCreateKey !== day.key"
              type="button"
              class="month-day-cell__quick-activate"
              :tabindex="day.key === tabStopKey ? 0 : -1"
              title="在这一天快速新建便签"
              :aria-label="`在 ${day.key} 快速新建便签${noteCounts.get(day.key) ? `，当前 ${noteCounts.get(day.key)} 条` : ''}`"
              @click.stop="openQuickCreator(day)"
            />
            <form
              v-if="isActiveDay(day)"
              :ref="(element) => setQuickCreatorRef(element, day.key)"
              class="month-day-cell__quick-create"
              :class="{
                'is-active': activeQuickCreateKey === day.key,
                'is-ready': activeQuickCreateKey === day.key && quickCreateReady,
                'is-saving': quickSavingKeys.has(day.key)
              }"
              :aria-hidden="activeQuickCreateKey !== day.key"
              @click.stop
              @submit.prevent="submitQuickNote(day)"
              @focusout="onQuickCreatorFocusOut(day, $event)"
            >
              <input
                v-if="activeQuickCreateKey === day.key"
                :ref="(element) => setQuickInputRef(element, day.key)"
                :value="quickDraft(day.key)"
                type="text"
                autocomplete="off"
                :readonly="quickSavingKeys.has(day.key)"
                placeholder="新建便签"
                :aria-label="`在 ${day.key} 输入新便签`"
                @input="updateQuickDraft(day.key, $event.target.value)"
                @contextmenu.stop
                @keydown="onQuickInputKeydown($event, day)"
              />
              <button
                type="submit"
                :tabindex="activeQuickCreateKey === day.key ? 0 : -1"
                :disabled="quickSavingKeys.has(day.key)"
                :aria-label="quickSavingKeys.has(day.key) ? '正在创建便签' : '创建便签'"
                title="创建便签"
                @pointerdown.prevent.stop
              >
                <span class="month-day-cell__quick-plus" aria-hidden="true">+</span>
                <svg class="month-day-cell__quick-submit" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
                </svg>
                <span class="month-day-cell__quick-spinner" aria-hidden="true" />
              </button>
            </form>
            <component
              :is="dayHasHiddenNotes(day) ? 'button' : 'span'"
              v-if="isActiveDay(day) && noteCounts.get(day.key)"
              class="month-day-cell__count"
              :class="{
                'is-hidden': activeQuickCreateKey === day.key,
                'is-overflow': dayHasHiddenNotes(day)
              }"
              :type="dayHasHiddenNotes(day) ? 'button' : undefined"
              :tabindex="
                dayHasHiddenNotes(day)
                  ? day.key === tabStopKey && activeQuickCreateKey !== day.key
                    ? 0
                    : -1
                  : undefined
              "
              :disabled="
                dayHasHiddenNotes(day) && activeQuickCreateKey === day.key ? true : undefined
              "
              :title="dayCountLabel(day)"
              :aria-label="dayCountLabel(day)"
              :aria-haspopup="dayHasHiddenNotes(day) ? 'dialog' : undefined"
              :aria-expanded="
                dayHasHiddenNotes(day) ? dayPreviewVisible && dayPreviewKey === day.key : undefined
              "
              @click.stop="toggleCountPreview(day, $event)"
            >
              <span class="month-day-cell__count-label">{{ noteCounts.get(day.key) }}</span>
            </component>
          </div>
        </div>

        <div class="month-week__events" aria-label="本周便签">
          <MonthEventBar
            v-for="segment in segments.filter(
              (item) => item.weekIndex === weekIndex - 1 && segmentIsVisible(item)
            )"
            :key="`${segment.noteId}-${segment.weekIndex}`"
            :segment="segment"
            :note="noteById.get(Number(segment.noteId))"
            @open-context-menu="openNoteContextMenu"
          />
        </div>
      </div>
    </div>

    <Teleport to="body">
      <Transition name="month-cell-context-menu">
        <div
          v-if="contextMenuVisible"
          ref="contextMenuRef"
          class="month-cell-context-menu-shell"
          :style="contextMenuStyle"
          role="menu"
          tabindex="-1"
          :aria-label="contextMenuTarget?.type === 'note' ? '便签操作' : '日期操作'"
          @click.stop
          @contextmenu.prevent
          @keydown="onContextMenuKeydown"
        >
          <div class="month-cell-context-menu">
            <template v-if="contextMenuTarget?.type === 'note'">
              <button role="menuitem" type="button" @click="runContextMenuAction('status')">
                {{ contextStatusLabel(contextMenuNote) }}
              </button>
              <button role="menuitem" type="button" @click="runContextMenuAction('edit')">
                修改便签
              </button>
              <div class="month-cell-context-menu__divider" role="separator" />
              <button
                class="month-cell-context-menu__delete"
                role="menuitem"
                type="button"
                @click="runContextMenuAction('delete')"
              >
                删除便签
              </button>
            </template>
            <template v-else>
              <button role="menuitem" type="button" @click="runContextMenuAction('create')">
                新建便签…
              </button>
              <button role="menuitem" type="button" @click="runContextMenuAction('preview')">
                预览当日全部便签
              </button>
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition :css="false" @enter="enterDayPreview" @leave="leaveDayPreview">
        <aside
          v-if="dayPreviewVisible"
          ref="dayPreviewRef"
          class="month-day-preview"
          role="dialog"
          :class="`is-${dayPreviewPlacement}`"
          :style="dayPreviewStyle"
          :aria-label="`${dayPreviewKey} 全部便签预览`"
          @click.stop
          @keydown="onDayPreviewKeydown"
        >
          <header class="month-day-preview__header">
            <button
              type="button"
              title="展开左侧操作列表"
              aria-label="展开左侧操作列表"
              @click="openPreviewDayPanel"
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <rect x="2.5" y="3" width="13" height="12" rx="2" />
                <path d="M6.5 3v12M10 9h3M11.5 7.5 13 9l-1.5 1.5" />
              </svg>
            </button>
            <button
              type="button"
              title="关闭预览"
              aria-label="关闭预览"
              @click="closeDayPreview({ restoreFocus: true })"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m3.5 3.5 9 9m0-9-9 9" />
              </svg>
            </button>
          </header>
          <div class="month-day-preview__list scroll-y">
            <article
              v-for="note in dayPreviewNotes"
              :key="note.id"
              class="month-day-preview__note"
              :style="{ '--preview-note-accent': previewNoteAccent(note) }"
            >
              <span aria-hidden="true" />
              <p>{{ previewNoteText(note) }}</p>
            </article>
            <p v-if="!dayPreviewNotes.length" class="month-day-preview__empty">这一天还没有便签</p>
          </div>
        </aside>
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
.month-grid {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  --calendar-gap: 7rem;
}
.month-grid__weekdays {
  display: grid;
  flex: 0 0 27rem;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: var(--calendar-gap);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  text-align: center;
}
.month-grid__weeks {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-rows: repeat(var(--calendar-rows), minmax(0, 1fr));
  row-gap: var(--calendar-gap);
}
.month-grid.is-week-view .month-grid__weeks {
  grid-template-rows: minmax(0, 1fr);
}
.month-week {
  position: relative;
  min-height: 0;
}
.month-week__cells,
.month-week__events {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  column-gap: var(--calendar-gap);
}
.month-week__events {
  top: 32rem;
  bottom: 18rem;
  z-index: var(--z-local-raised);
  align-content: start;
  overflow: hidden;
  pointer-events: none;
}
.month-day-cell {
  position: relative;
  container-type: inline-size;
  min-width: 0;
  overflow: hidden;
  padding: 5rem 7rem;
  border: 1px solid var(--calendar-grid-line);
  border-radius: 9rem;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}
.month-day-cell:not(.is-unavailable):not(.is-selected):hover {
  border-color: var(--ui-border-control);
}
.month-day-cell.is-outside {
  border-color: var(--calendar-grid-line);
  color: color-mix(in srgb, var(--text-color-secondary) 58%, transparent);
}
.month-day-cell.is-unavailable {
  cursor: default;
}
.month-day-cell__header {
  display: grid;
  min-width: 0;
  grid-template-columns: max(23rem, calc(var(--fs-secondary) * 1.35)) minmax(0, 1fr) auto auto;
  align-items: center;
  column-gap: 3rem;
}
.month-day-cell__badges {
  display: inline-flex;
  min-width: 0;
  flex: 0 0 auto;
  grid-column: 4;
  align-items: center;
  gap: 4rem;
  justify-self: end;
}
.month-day-cell.is-selected {
  border-color: color-mix(in srgb, #0a84ff 58%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #0a84ff 24%, transparent);
}
.month-day-cell__number {
  display: inline-flex;
  width: max(23rem, calc(var(--fs-secondary) * 1.35));
  height: 23rem;
  flex: 0 0 23rem;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: var(--fs-secondary);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  grid-column: 1;
}
.month-day-cell__today {
  display: inline-grid;
  width: 20rem;
  height: 20rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 50%;
  background: #0a84ff;
  color: #fff;
  font-size: calc(var(--fs-secondary) * 0.76);
  font-weight: 650;
  line-height: 1;
  pointer-events: none;
}
.month-day-cell__count {
  position: absolute;
  z-index: var(--z-local-raised);
  right: 6rem;
  bottom: 5rem;
  display: inline-flex;
  min-width: 22rem;
  height: 18rem;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0 5rem;
  border: 0;
  border-radius: 5rem;
  background: var(--ui-fill-passive);
  color: var(--text-color-secondary);
  font-family: inherit;
  font-size: calc(var(--fs-secondary) * 0.72);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-align: center;
  text-indent: 0;
  letter-spacing: normal;
  appearance: none;
  pointer-events: none;
  transition:
    opacity 140ms ease,
    transform 220ms var(--ease-standard);
  white-space: nowrap;
}
.month-day-cell__count.is-overflow {
  background: var(--ui-accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  pointer-events: auto;
}
.month-day-cell__count.is-overflow:hover {
  background: color-mix(in srgb, var(--ui-accent) 90%, #fff);
}
.month-day-cell__count-label {
  display: block;
  line-height: 1;
  pointer-events: none;
}
.month-day-cell__count.is-overflow:focus-visible {
  outline: 1px solid var(--ui-accent);
  outline-offset: 2px;
}
.month-day-cell__count.is-hidden {
  pointer-events: none;
  opacity: 0;
  transform: translateX(4rem) scale(0.92);
}
.month-day-cell__holiday {
  display: inline-grid;
  width: 18rem;
  height: 18rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 5rem;
  font-size: calc(var(--fs-secondary) * 0.68);
  font-weight: 650;
  line-height: 1;
  pointer-events: none;
}
.month-day-cell__holiday.is-off {
  background: color-mix(in srgb, #34c759 14%, transparent);
  color: #34c759;
}
.month-day-cell__holiday.is-work {
  background: color-mix(in srgb, #ff9f0a 14%, transparent);
  color: #ff9f0a;
}
.month-day-cell__lunar {
  display: block;
  min-width: 0;
  flex: 1;
  grid-column: 2;
  overflow: hidden;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.15;
  opacity: 0.82;
  pointer-events: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.month-day-cell__weather {
  display: inline-flex;
  min-width: 0;
  grid-column: 3;
  align-items: center;
  gap: 2rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.75);
  line-height: 1;
  pointer-events: none;
  white-space: nowrap;
}
.month-day-cell__weather-temperature {
  font-variant-numeric: tabular-nums;
}
.month-day-cell__lunar.is-festival,
.month-day-cell__lunar.is-solar-term {
  color: #0a84ff;
  opacity: 1;
}
.month-day-cell__lunar.is-public-holiday-festival {
  color: #34c759;
  opacity: 1;
}
.month-day-cell__quick-activate {
  position: absolute;
  z-index: var(--z-local-raised);
  right: 0;
  bottom: 0;
  left: 0;
  height: 28rem;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  cursor: pointer;
}
.month-day-cell__quick-activate:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--ui-accent) 72%, transparent);
  outline-offset: -3rem;
  border-radius: 7rem;
}
.month-day-cell__quick-create {
  position: absolute;
  z-index: var(--z-local-top);
  bottom: 3rem;
  left: 6rem;
  width: 22rem;
  height: 22rem;
  box-sizing: border-box;
  padding: 0;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color-secondary);
  pointer-events: none;
  opacity: 1;
  transform: translateY(0) scale(1);
  transition:
    width 280ms var(--ease-standard),
    border-color 180ms ease,
    background-color 180ms ease,
    opacity 210ms ease,
    transform 260ms var(--ease-standard);
}
.month-day-cell__quick-create.is-active {
  width: calc(100% - 12rem);
  border-color: var(--ui-border-control);
  background: var(--ui-surface-control);
  pointer-events: auto;
}
.month-day-cell__quick-create.is-active:focus-within {
  border-color: var(--ui-accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-accent) 16%, transparent);
}
.month-day-cell__quick-create input {
  position: absolute;
  inset: 0 23rem 0 0;
  width: calc(100% - 23rem);
  min-width: 0;
  padding: 0 6rem;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: calc(var(--fs-secondary) * 0.82);
  line-height: 20rem;
}
.month-day-cell__quick-create input::placeholder {
  color: transparent;
  transition: color 130ms ease;
}
.month-day-cell__quick-create.is-ready input::placeholder {
  color: var(--text-color-secondary);
}
.month-day-cell__quick-create > button {
  position: absolute;
  top: 0;
  right: 0;
  display: grid;
  width: 21rem;
  height: 20rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-left: 1px solid transparent;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 18rem;
  transition:
    border-color 160ms ease,
    color 160ms ease;
}
.month-day-cell__quick-create.is-active > button {
  border-left-color: var(--ui-border-divider);
}
.month-day-cell__quick-create > button:hover:not(:disabled) {
  color: var(--ui-accent);
}
.month-day-cell__quick-create > button:disabled {
  cursor: wait;
}
.month-day-cell__quick-plus,
.month-day-cell__quick-submit,
.month-day-cell__quick-spinner {
  position: absolute;
  transition:
    opacity 130ms ease,
    transform 180ms var(--ease-standard);
}
.month-day-cell__quick-plus {
  opacity: 1;
  transform: rotate(0deg) scale(1);
}
.month-day-cell__quick-submit {
  width: 14rem;
  height: 14rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
  opacity: 0;
  transform: translateY(3rem) scale(0.84);
}
.month-day-cell__quick-create.is-ready .month-day-cell__quick-plus {
  opacity: 0;
  transform: rotate(45deg) scale(0.82);
}
.month-day-cell__quick-create.is-ready .month-day-cell__quick-submit {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.month-day-cell__quick-spinner {
  width: 11rem;
  height: 11rem;
  box-sizing: border-box;
  border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  opacity: 0;
}
.month-day-cell__quick-create.is-saving .month-day-cell__quick-plus,
.month-day-cell__quick-create.is-saving .month-day-cell__quick-submit {
  opacity: 0;
}
.month-day-cell__quick-create.is-saving .month-day-cell__quick-spinner {
  animation: month-quick-create-spin 700ms linear infinite;
  opacity: 1;
}
@keyframes month-quick-create-spin {
  to {
    transform: rotate(360deg);
  }
}

@container (max-width: 90rem) {
  .month-day-cell__header {
    grid-template-columns: max(20rem, calc(var(--fs-secondary) * 1.35)) minmax(0, 1fr) auto;
    column-gap: 2rem;
  }

  .month-day-cell__number {
    width: max(20rem, calc(var(--fs-secondary) * 1.35));
    height: 20rem;
    flex-basis: 20rem;
  }

  .month-day-cell__badges {
    gap: 2rem;
  }

  .month-day-cell__today {
    width: 18rem;
    height: 18rem;
  }

  .month-day-cell__holiday {
    width: 16rem;
    height: 16rem;
  }
}

@container (max-width: 150rem) {
  .month-day-cell__weather-temperature {
    display: none;
  }
}

@container (max-width: 112rem) {
  .month-day-cell__weather {
    display: none;
  }
  .month-day-cell__header {
    grid-template-columns: max(20rem, calc(var(--fs-secondary) * 1.35)) minmax(0, 1fr) auto;
  }
  .month-day-cell__badges {
    grid-column: 3;
  }
}
</style>

<style>
.month-cell-context-menu-shell {
  position: fixed;
  z-index: var(--z-global-popover);
  width: 176rem;
  overflow: hidden;
  border-radius: 10rem;
  box-shadow: 0 12rem 34rem rgba(0, 0, 0, 0.22);
  outline: none;
}
.month-cell-context-menu {
  display: grid;
  gap: 1rem;
  padding: 5rem;
  border: 1px solid var(--surface-float-border);
  border-radius: inherit;
  background: var(--surface-float);
}
.month-cell-context-menu button {
  width: 100%;
  padding: 7rem 9rem;
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
  font: inherit;
  font-size: var(--fs-secondary);
  text-align: left;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.month-cell-context-menu button:hover:not(:disabled),
.month-cell-context-menu button:focus-visible:not(:disabled) {
  outline: none;
  background: var(--ui-fill-hover);
}
.month-cell-context-menu button:disabled {
  cursor: default;
  opacity: 0.38;
}
.month-cell-context-menu__divider {
  height: 1px;
  margin: 3rem 4rem;
  background: color-mix(in srgb, var(--text-color) 10%, transparent);
}
.month-cell-context-menu .month-cell-context-menu__delete {
  color: #ff453a;
}
.month-cell-context-menu .month-cell-context-menu__delete:hover,
.month-cell-context-menu .month-cell-context-menu__delete:focus-visible {
  background: color-mix(in srgb, #ff453a 11%, transparent);
}
.month-cell-context-menu-enter-active,
.month-cell-context-menu-leave-active {
  transition:
    opacity 130ms ease,
    transform 180ms cubic-bezier(0.32, 0.72, 0, 1);
}
.month-cell-context-menu-enter-from,
.month-cell-context-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

.month-day-preview {
  position: fixed;
  z-index: var(--z-global-popover);
  display: flex;
  width: min(340rem, calc(100vw - 16px));
  max-height: min(480rem, calc(100vh - 16px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--surface-float-border);
  border-radius: 12rem;
  background: var(--surface-float);
  box-shadow: 0 16rem 42rem rgba(0, 0, 0, 0.24);
  color: var(--text-color);
}
.month-day-preview__header {
  display: flex;
  min-height: 38rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  padding: 4rem 6rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.month-day-preview__header button {
  display: grid;
  width: 28rem;
  height: 28rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
}
.month-day-preview__header button:hover,
.month-day-preview__header button:focus-visible {
  outline: none;
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.month-day-preview__header svg {
  width: 16rem;
  height: 16rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.4;
}
.month-day-preview__list {
  min-height: 0;
  padding: 8rem;
  overflow-y: auto;
}
.month-day-preview__note {
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr);
  align-items: start;
  gap: 8rem;
  padding: 9rem 8rem;
  border-radius: 8rem;
}
.month-day-preview__note + .month-day-preview__note {
  margin-top: 3rem;
}
.month-day-preview__note > span {
  width: 5rem;
  height: 5rem;
  margin-top: 6rem;
  border-radius: 50%;
  background: var(--preview-note-accent);
}
.month-day-preview__note p {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: var(--fs-secondary);
  line-height: 1.48;
  white-space: pre-wrap;
}
.month-day-preview__empty {
  margin: 0;
  padding: 26rem 12rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-align: center;
}
</style>
