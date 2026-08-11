<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MonthCalendarToolbar from './MonthCalendarToolbar.vue'
import MonthCalendarGrid from './MonthCalendarGrid.vue'
import MonthDayPanel from './MonthDayPanel.vue'
import MonthNoteCreator from './MonthNoteCreator.vue'
import NoteEditor from '../note/NoteEditor.vue'
import { useMessage } from '../../composables/useMessage.js'
import { useTodayKey } from '../../composables/useTodayKey.js'
import {
  captureFocusedElement,
  focusModal,
  restoreFocusedElement,
  trapModalTab
} from '../../utils/modalFocus.js'
import {
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
  dateKeyFromParts,
  parseDateKey
} from '../../../../shared/calendar/calendar-date-rules.js'
import { notesCoveringDate } from '../../../../shared/calendar/calendar-event-layout.js'

const { showMessage } = useMessage()
const emit = defineEmits(['modal-state-change'])
const now = new Date()
const viewYear = ref(now.getFullYear())
const viewMonth = ref(now.getMonth() + 1)
const todayKey = useTodayKey()
const calendarData = ref({ days: [], notes: [] })
const loading = ref(true)
const refreshing = ref(false)
const transitioning = ref(false)
const loadError = ref('')
const selectedKey = ref('')
const panelOpen = ref(false)
const dayPanelSize = ref(34)
const creatorDate = ref('')
const editingNote = ref(null)
const editorRef = ref(null)
const workspaceBodyRef = ref(null)
const calendarSurfaceRef = ref(null)
const creatorRef = ref(null)
const creatorOverlayRef = ref(null)
const editorOverlayRef = ref(null)
let stopNotesListener = null
let loadSequence = 0
let resizeCleanup = null
let notesChangedTimer = null
let previouslyFocused = null
let modalFocusFrame = null

const selectedNotes = computed(() =>
  selectedKey.value ? notesCoveringDate(calendarData.value.notes, selectedKey.value) : []
)
const modalOpen = computed(() => Boolean(creatorDate.value || editingNote.value))

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

function selectedKeyForMonth(year, month) {
  if (!selectedKey.value) return ''
  const selected = parseDateKey(selectedKey.value)
  return dateKeyFromParts(year, month, Math.min(selected.day, daysInMonth(year, month)))
}

function monthIndex(year, month) {
  return year * 12 + month - 1
}

function motionDirection(targetYear, targetMonth) {
  const difference =
    monthIndex(targetYear, targetMonth) - monthIndex(viewYear.value, viewMonth.value)
  if (difference > 0) return 'forward'
  if (difference < 0) return 'backward'
  return null
}

function canAnimateCalendar() {
  return calendarSurfaceRef.value && typeof calendarSurfaceRef.value.animate === 'function'
}

function calendarKeyframes(direction, phase) {
  const outgoingX = direction === 'forward' ? '-7%' : '7%'
  const incomingX = direction === 'forward' ? '7%' : '-7%'
  return phase === 'out'
    ? [
        { opacity: 1, transform: 'translateX(0) scale(1)' },
        { opacity: 0, transform: `translateX(${outgoingX}) scale(0.994)` }
      ]
    : [
        { opacity: 0, transform: `translateX(${incomingX}) scale(0.994)` },
        { opacity: 1, transform: 'translateX(0) scale(1)' }
      ]
}

function startCalendarAnimation(direction, phase) {
  if (!canAnimateCalendar()) return null
  return calendarSurfaceRef.value.animate(calendarKeyframes(direction, phase), {
    duration: phase === 'out' ? 230 : 320,
    easing: phase === 'out' ? 'cubic-bezier(0.4, 0, 1, 1)' : 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'forwards'
  })
}

async function waitForAnimation(animation) {
  if (!animation) return
  await animation.finished.catch(() => {})
}

async function focusCalendarDate(dateKey) {
  await nextTick()
  const cell = calendarSurfaceRef.value?.querySelector(`.month-day-cell[data-date="${dateKey}"]`)
  if (!cell?.animate) return
  const animation = cell.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(0.975)', offset: 0.42 },
      { transform: 'scale(1)' }
    ],
    { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
  )
  await waitForAnimation(animation)
  animation.cancel()
}

function startRefreshContentAnimation(phase) {
  const elements = calendarSurfaceRef.value?.querySelectorAll(
    '.month-week__events, .month-day-cell__count, .month-day-cell__overflow'
  )
  return Array.from(elements || [], (element) => {
    const finalOpacity = Number.parseFloat(getComputedStyle(element).opacity) || 1
    const restingOpacity = Math.max(0.24, finalOpacity * 0.52)
    const keyframes =
      phase === 'out'
        ? [
            { opacity: finalOpacity, filter: 'blur(0)' },
            { opacity: restingOpacity, filter: 'blur(0.8rem)' }
          ]
        : [
            { opacity: restingOpacity, filter: 'blur(0.8rem)' },
            { opacity: finalOpacity, filter: 'blur(0)' }
          ]
    return element.animate(keyframes, {
      duration: phase === 'out' ? 220 : 380,
      easing: phase === 'out' ? 'cubic-bezier(0.4, 0, 0.6, 1)' : 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'forwards'
    })
  })
}

async function waitForAnimations(animations) {
  await Promise.all(animations.map(waitForAnimation))
}

async function replaceCalendarData(data, { direction, nextSelection = '' } = {}) {
  const outgoing = startCalendarAnimation(direction, 'out')
  await waitForAnimation(outgoing)

  calendarData.value = data
  viewYear.value = data.year
  viewMonth.value = data.month
  if (nextSelection) selectedKey.value = nextSelection
  await nextTick()

  const incoming = startCalendarAnimation(direction, 'in')
  outgoing?.cancel()
  await waitForAnimation(incoming)
  incoming?.cancel()
}

async function loadMonth(year = viewYear.value, month = viewMonth.value) {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const data = await window.api.getMonthCalendarData(year, month)
    if (sequence !== loadSequence) return
    calendarData.value = data
    viewYear.value = data.year
    viewMonth.value = data.month
  } catch (error) {
    if (sequence !== loadSequence) return
    console.error('[MonthWorkspace] 加载月历失败:', error)
    loadError.value = error.message || '月历加载失败'
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function navigate(year, month, { shiftSelection = true, selectionKey = null } = {}) {
  if (transitioning.value) return false
  let targetYear = year
  let targetMonth = month
  while (targetMonth < 1) {
    targetMonth += 12
    targetYear -= 1
  }
  while (targetMonth > 12) {
    targetMonth -= 12
    targetYear += 1
  }
  if (targetYear < MIN_CALENDAR_YEAR || targetYear > MAX_CALENDAR_YEAR) return false
  if (targetYear === viewYear.value && targetMonth === viewMonth.value) return true
  const direction = motionDirection(targetYear, targetMonth)
  const nextSelection =
    selectionKey ??
    (shiftSelection ? selectedKeyForMonth(targetYear, targetMonth) : selectedKey.value)
  const sequence = ++loadSequence
  transitioning.value = true
  loading.value = true
  loadError.value = ''
  try {
    const data = await window.api.getMonthCalendarData(targetYear, targetMonth)
    if (sequence !== loadSequence) return false
    await replaceCalendarData(data, { direction, nextSelection })
    return true
  } catch (error) {
    if (sequence !== loadSequence) return false
    console.error('[MonthWorkspace] 切换月历失败:', error)
    loadError.value = error.message || '月历加载失败'
    return false
  } finally {
    if (sequence === loadSequence) loading.value = false
    transitioning.value = false
  }
}

function goPrevious() {
  void navigate(viewYear.value, viewMonth.value - 1)
}
function goNext() {
  void navigate(viewYear.value, viewMonth.value + 1)
}
function jumpTo({ year, month }) {
  void navigate(year, month)
}

async function refreshMonthContent({ manual = false } = {}) {
  if (refreshing.value || transitioning.value) return
  if (manual) refreshing.value = true
  transitioning.value = true
  const sequence = ++loadSequence
  loadError.value = ''
  try {
    const data = await window.api.getMonthCalendarData(viewYear.value, viewMonth.value)
    if (sequence !== loadSequence) return
    const outgoing = startRefreshContentAnimation('out')
    await waitForAnimations(outgoing)
    calendarData.value = data
    await nextTick()
    outgoing.forEach((animation) => animation.cancel())
    const incoming = startRefreshContentAnimation('in')
    await waitForAnimations(incoming)
    incoming.forEach((animation) => animation.cancel())
  } catch (error) {
    if (sequence !== loadSequence) return
    console.error('[MonthWorkspace] 同步月历失败:', error)
    loadError.value = error.message || '月历同步失败'
  } finally {
    if (manual) refreshing.value = false
    transitioning.value = false
  }
}

function refreshMonth() {
  void refreshMonthContent({ manual: true })
}

async function goToday() {
  const today = parseDateKey(todayKey.value)
  if (today.year === viewYear.value && today.month === viewMonth.value) {
    selectedKey.value = todayKey.value
    transitioning.value = true
    try {
      await focusCalendarDate(todayKey.value)
    } finally {
      transitioning.value = false
    }
    return
  }
  await navigate(today.year, today.month, {
    shiftSelection: false,
    selectionKey: todayKey.value
  })
}

async function selectDate(day) {
  if (!day?.inCurrentMonth) return
  if (panelOpen.value && selectedKey.value === day.key) {
    panelOpen.value = false
    return
  }
  selectedKey.value = day.key
  panelOpen.value = true
}

function openCreator(dayOrKey) {
  const dateKey = typeof dayOrKey === 'string' ? dayOrKey : dayOrKey?.key
  if (!dateKey || dateKey < todayKey.value) {
    showMessage('warning', '不能为过去日期新建便签')
    return
  }
  creatorDate.value = dateKey
}

function closeCreator() {
  creatorDate.value = ''
}

async function onCreated() {
  closeCreator()
}

async function openEditor(note) {
  try {
    const fullNote = await window.api.getNote(note.id)
    if (!fullNote) throw new Error('便签不存在或已删除')
    editingNote.value = fullNote
  } catch (error) {
    showMessage('error', error.message || '无法打开便签')
  }
}

function requestCloseEditor() {
  editorRef.value?.requestClose?.()
}

function closeEditor() {
  editingNote.value = null
}

async function onEditorSaved() {
  closeEditor()
}

function activeModalRoot() {
  return creatorOverlayRef.value || editorOverlayRef.value
}

function scheduleModalFocus() {
  if (modalFocusFrame !== null) cancelAnimationFrame(modalFocusFrame)
  modalFocusFrame = requestAnimationFrame(() => {
    modalFocusFrame = null
    focusModal(activeModalRoot())
  })
}

function scheduleModalFocusRestore() {
  const target = previouslyFocused
  previouslyFocused = null
  if (modalFocusFrame !== null) cancelAnimationFrame(modalFocusFrame)
  modalFocusFrame = requestAnimationFrame(() => {
    modalFocusFrame = null
    restoreFocusedElement(target)
  })
}

function onBusinessModalKeydown(event, type) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    if (type === 'creator') creatorRef.value?.requestClose?.()
    else requestCloseEditor()
    return
  }
  trapModalTab(event, event.currentTarget)
}

function queueNotesRefresh() {
  clearTimeout(notesChangedTimer)
  notesChangedTimer = setTimeout(() => {
    notesChangedTimer = null
    if (transitioning.value) {
      queueNotesRefresh()
      return
    }
    void refreshMonthContent()
  }, 40)
}

function startPanelResize(event) {
  if (!workspaceBodyRef.value) return
  event.preventDefault()
  const bounds = workspaceBodyRef.value.getBoundingClientRect()
  const pointerId = event.pointerId
  try {
    event.currentTarget?.setPointerCapture?.(pointerId)
  } catch {
    // 合成输入或指针已释放时继续使用 window 级监听，不影响拖拽与持久化。
  }
  document.body.classList.add('is-resizing-month-day-panel')

  const onMove = (moveEvent) => {
    const ratio = ((moveEvent.clientX - bounds.left) / bounds.width) * 100
    dayPanelSize.value = Math.min(50, Math.max(25, ratio))
  }
  const finish = async () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    document.body.classList.remove('is-resizing-month-day-panel')
    resizeCleanup = null
    try {
      await window.api.setSettingValue('ui.dayPanelSize', Number(dayPanelSize.value.toFixed(2)))
    } catch (error) {
      console.warn('[MonthWorkspace] 保存日期侧栏宽度失败:', error)
    }
  }
  resizeCleanup = finish
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', finish, { once: true })
  window.addEventListener('pointercancel', finish, { once: true })
}

onMounted(async () => {
  try {
    const snapshot = await window.api.getSettingsSnapshot()
    dayPanelSize.value = Math.min(
      50,
      Math.max(25, Number(snapshot?.values?.ui?.dayPanelSize) || 34)
    )
  } catch (error) {
    console.warn('[MonthWorkspace] 读取日期侧栏设置失败:', error)
  }
  stopNotesListener = window.api.onNotesChanged?.(queueNotesRefresh)
  await loadMonth()
})

watch(modalOpen, (open) => emit('modal-state-change', open), { immediate: true })
watch(
  () => [creatorDate.value, editingNote.value?.id || null],
  async ([nextCreator, nextEditor], [previousCreator, previousEditor]) => {
    const open = Boolean(nextCreator || nextEditor)
    const wasOpen = Boolean(previousCreator || previousEditor)
    if (open && !wasOpen) previouslyFocused = captureFocusedElement()
    if (open) {
      await nextTick()
      scheduleModalFocus()
    } else if (wasOpen) {
      scheduleModalFocusRestore()
    }
  }
)

defineExpose({
  openNote: (noteId) => openEditor({ id: Number(noteId) })
})

onBeforeUnmount(() => {
  stopNotesListener?.()
  clearTimeout(notesChangedTimer)
  if (modalFocusFrame !== null) cancelAnimationFrame(modalFocusFrame)
  restoreFocusedElement(previouslyFocused)
  resizeCleanup?.()
  emit('modal-state-change', false)
})
</script>

<template>
  <div class="month-workspace">
    <div ref="workspaceBodyRef" class="month-workspace__body" :inert="modalOpen">
      <Transition name="month-side-panel">
        <MonthDayPanel
          v-if="panelOpen && selectedKey"
          class="month-workspace__side"
          :style="{ width: `${dayPanelSize}%` }"
          :date-key="selectedKey"
          :notes="selectedNotes"
          :can-create="selectedKey >= todayKey"
          @close="panelOpen = false"
          @create="openCreator(selectedKey)"
          @edit="openEditor"
          @resize-start="startPanelResize"
        />
      </Transition>

      <section class="month-workspace__calendar">
        <MonthCalendarToolbar
          :year="viewYear"
          :month="viewMonth"
          :refreshing="refreshing"
          :busy="transitioning"
          @previous="goPrevious"
          @next="goNext"
          @today="goToday"
          @jump="jumpTo"
          @refresh="refreshMonth"
        />
        <div ref="calendarSurfaceRef" class="month-workspace__calendar-body">
          <MonthCalendarGrid
            :days="calendarData.days"
            :notes="calendarData.notes"
            :selected-key="selectedKey"
            :today-key="todayKey"
            @select-date="selectDate"
            @create="openCreator"
          />
          <div v-if="loading && !calendarData.days.length" class="month-workspace__state">
            正在加载月历…
          </div>
          <div v-else-if="loadError" class="month-workspace__state is-error">
            <span>{{ loadError }}</span
            ><button type="button" @click="loadMonth()">重试</button>
          </div>
        </div>
      </section>
    </div>

    <Teleport to="body">
      <Transition name="month-modal">
        <div
          v-if="creatorDate"
          ref="creatorOverlayRef"
          class="month-modal-overlay"
          data-modal-layer="month-note-creator"
          tabindex="-1"
          @keydown="onBusinessModalKeydown($event, 'creator')"
        >
          <MonthNoteCreator
            ref="creatorRef"
            :date-key="creatorDate"
            @created="onCreated"
            @close="closeCreator"
          />
        </div>
      </Transition>

      <Transition name="month-modal">
        <div
          v-if="editingNote"
          ref="editorOverlayRef"
          class="month-modal-overlay"
          data-modal-layer="month-note-editor"
          tabindex="-1"
          @keydown="onBusinessModalKeydown($event, 'editor')"
        >
          <section
            class="month-editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="修改便签"
          >
            <header>
              <strong>修改便签</strong
              ><button type="button" aria-label="关闭编辑" @click="requestCloseEditor">×</button>
            </header>
            <NoteEditor
              ref="editorRef"
              :key="editingNote.id"
              :note="editingNote"
              class="month-editor-dialog__editor"
              @saved="onEditorSaved"
              @cancel="closeEditor"
            />
          </section>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.month-workspace,
.month-workspace__body {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.month-workspace__body {
  display: flex;
  overflow: hidden;
  transition: filter 180ms ease;
}
.month-workspace__side {
  flex: 0 0 auto;
}
.month-workspace__calendar {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  padding: 12rem 15rem 15rem;
}
.month-workspace__calendar-body {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
.month-workspace__state {
  position: absolute;
  z-index: var(--z-local-top);
  inset: 0;
  display: grid;
  place-content: center;
  gap: 8rem;
  border-radius: 11rem;
  background: rgb(var(--bg-color) / 0.25);
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  backdrop-filter: blur(5px);
}
.month-workspace__state.is-error {
  color: #ff453a;
}
.month-workspace__state button {
  justify-self: center;
  padding: 5rem 11rem;
  border: 0;
  border-radius: 7rem;
  background: rgb(var(--bg-color) / 0.12);
  color: var(--text-color);
  cursor: pointer;
  font: inherit;
}
.month-side-panel-enter-active,
.month-side-panel-leave-active {
  transition:
    width 250ms cubic-bezier(0.32, 0.72, 0, 1),
    opacity 180ms ease,
    transform 250ms cubic-bezier(0.32, 0.72, 0, 1);
}
.month-side-panel-enter-from,
.month-side-panel-leave-to {
  width: 0 !important;
  opacity: 0;
  transform: translateX(-10rem);
}
.month-modal-overlay {
  position: fixed;
  z-index: var(--z-global-editor);
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20rem;
  background: var(--surface-modal-scrim);
}
.month-editor-dialog {
  display: flex;
  width: min(620rem, 100%);
  height: min(660rem, 100%);
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border-control);
  border-radius: 16rem;
  background: var(--surface-modal);
  box-shadow: 0 22rem 56rem rgba(0, 0, 0, 0.28);
}
.month-editor-dialog > header {
  display: flex;
  min-height: 44rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 0 13rem 0 17rem;
  border-bottom: 1px solid var(--ui-border-divider);
  color: var(--text-color);
}
.month-editor-dialog > header button {
  display: grid;
  width: 27rem;
  height: 27rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 22rem;
}
.month-editor-dialog > header button:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.month-editor-dialog__editor {
  min-height: 0;
  flex: 1;
}
.month-modal-enter-active,
.month-modal-leave-active {
  transition: opacity 180ms ease;
}
.month-modal-enter-active > *,
.month-modal-leave-active > * {
  transition:
    opacity 180ms ease,
    transform 240ms cubic-bezier(0.32, 0.72, 0, 1);
}
.month-modal-enter-from,
.month-modal-leave-to {
  opacity: 0;
}
.month-modal-enter-from > *,
.month-modal-leave-to > * {
  opacity: 0;
  transform: translateY(10rem) scale(0.985);
}
</style>

<style>
body.is-resizing-month-day-panel {
  cursor: ew-resize !important;
  user-select: none !important;
}
</style>
