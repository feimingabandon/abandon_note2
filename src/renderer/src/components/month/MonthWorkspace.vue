<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQueuedModal } from '../../composables/useQueuedModal.js'
import { useCalendarWorkspaceModel } from '../../composables/useCalendarWorkspaceModel.js'
import { useCalendarWorkspacePreferences } from '../../composables/useCalendarWorkspacePreferences.js'
import { useNoteStatusActions } from '../../composables/useNoteStatusActions.js'
import { getSettingsSnapshotStore } from '../../utils/settingsSnapshots.js'
import { useSharedMinuteClock } from '../../composables/useSharedMinuteClock.js'
import { useWeatherRecovery } from '../../composables/useWeatherRecovery.js'
import MonthCalendarToolbar from './MonthCalendarToolbar.vue'
import MonthCalendarGrid from './MonthCalendarGrid.vue'
import MonthDayPanel from './MonthDayPanel.vue'
import MonthNoteCreator from './MonthNoteCreator.vue'
import NoteEditor from '../note/NoteEditor.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import { useMessage } from '../../composables/useMessage.js'
import { useTodayKey } from '../../composables/useTodayKey.js'
import {
  captureFocusedElement,
  focusModal,
  restoreFocusedElement,
  trapModalTab
} from '../../utils/modalFocus.js'
import { createDefaultSettings, VIEW_MODES } from '../../../../shared/settings-schema.js'
import { notesCoveringDate } from '../../../../shared/calendar/calendar-event-layout.js'
import {
  createRefreshCauses,
  traceViewRefresh,
  summarizeViewNotes,
  reportEvidence
} from '../../utils/diagnosticEvidence.js'

const { showMessage } = useMessage()
let stopNewNoteShortcut = null
useWeatherRecovery()
const props = defineProps({
  viewMode: {
    type: String,
    default: VIEW_MODES.MONTH,
    validator: (value) => value === VIEW_MODES.MONTH || value === VIEW_MODES.WEEK
  }
})
const emit = defineEmits(['modal-state-change', 'ready'])
const isWeekView = computed(() => props.viewMode === VIEW_MODES.WEEK)
const calendarViewLabel = computed(() => (isWeekView.value ? '周视图' : '月视图'))
const todayKey = useTodayKey()
const defaultDayPanelSize = createDefaultSettings(props.viewMode).ui.dayPanelSize
const settingsSnapshots = getSettingsSnapshotStore(window.api)
const calendarPreferences = useCalendarWorkspacePreferences({
  api: window.api,
  clock: useSharedMinuteClock(),
  refreshCalendar: () => refreshCalendarContent(),
  notify: showMessage
})
const {
  recurringPreviewEnabled,
  recurringPreviewSaving,
  quickCreateUntilCompleted,
  weatherEnabled,
  weatherForecast,
  weatherState,
  weatherError,
  weatherByDate,
  updateRecurringPreviewEnabled
} = calendarPreferences
const calendarModel = useCalendarWorkspaceModel({
  api: window.api,
  getViewMode: () => props.viewMode,
  todayKey,
  presentation: {
    requestOptions: calendarPreferences.requestOptions,
    replacePeriod: replaceCalendarData,
    refreshPeriod: presentCalendarRefresh,
    focusDate: focusCalendarDate
  }
})
const {
  viewYear,
  viewMonth,
  weekAnchorKey,
  calendarData,
  loading,
  refreshing,
  transitioning,
  loadError
} = calendarModel
const selectedKey = computed({
  get: () => calendarModel.selectedKey.value,
  set: (key) => calendarModel.selectDate(key)
})
const refreshCauses = createRefreshCauses(props.viewMode)
function traceCalendarLoad(metadata, work) {
  const expectedSequence = calendarModel.sequence + 1
  return traceViewRefresh(
    props.viewMode,
    metadata,
    work,
    () => ({
      year: viewYear.value,
      month: viewMonth.value,
      weekStart: calendarData.value.weekStart,
      ...summarizeViewNotes(calendarData.value.notes)
    }),
    () => calendarModel.sequence === expectedSequence
  )
}
watch(
  calendarData,
  (data) =>
    reportEvidence('view.data-committed', {
      view: props.viewMode,
      year: viewYear.value,
      month: viewMonth.value,
      ...summarizeViewNotes(data.notes)
    }),
  { flush: 'post' }
)
const panelOpen = ref(false)
const dayPanelSize = ref(defaultDayPanelSize)
const creatorDate = ref('')
const editingNote = ref(null)
const { visible: creatorDisplayed, finishLeave: finishCreatorLeave } = useQueuedModal(creatorDate)
const { visible: editorDisplayed, finishLeave: finishEditorLeave } = useQueuedModal(editingNote)
const editorRef = ref(null)
const workspaceBodyRef = ref(null)
const calendarSurfaceRef = ref(null)
const creatorRef = ref(null)
const creatorOverlayRef = ref(null)
const editorOverlayRef = ref(null)
const statusActions = useNoteStatusActions({
  api: window.api,
  onCommit(updated, _note, { from }) {
    calendarModel.patchNote(updated, { preserveEffectiveAt: from === 'initialized' })
  },
  onFinish() {
    queueNotesRefresh()
  },
  onError(error, note, { committed }) {
    console.error('[MonthWorkspace] 状态操作失败:', note.id, { committed }, error)
    if (committed) showMessage('warning', '便签状态已保存，但显示更新失败，请稍后核对。')
    else showMessage('error', `便签状态修改未确认：${error?.message || '请稍后重试'}`)
  }
})
const statusTransitions = statusActions.transitions
const executeCardStatusAction = statusActions.execute
const earlyStartConfirmVisible = ref(false)
const earlyStartNote = ref(null)
const deleteConfirmVisible = ref(false)
const deleteTargetNote = ref(null)
const deletingNote = ref(false)
let stopNotesListener = null
let stopTemplatesListener = null
let stopHolidayDataListener = null
let stopSettingsListener = null
let resizeCleanup = null
let notesChangedTimer = null
let previouslyFocused = null
let modalFocusFrame = null

const selectedNotes = computed(() =>
  selectedKey.value
    ? notesCoveringDate(calendarData.value.notes, selectedKey.value, todayKey.value)
    : []
)
const historicalMoveOpen = ref(false)
const modalOpen = computed(() =>
  Boolean(creatorDate.value || editingNote.value || historicalMoveOpen.value)
)
const selectedWeather = computed(() => weatherByDate.value.get(selectedKey.value) || null)
const earlyStartMessage = computed(() => {
  if (earlyStartNote.value?.duration_kind === 'until_completed') {
    return '该便签设置为持续到完成。提前执行后，生效时间将改为当前时间，并从今天开始连续显示，直到标记完成。是否确认提前执行？'
  }
  const durationDays = Math.max(1, Number(earlyStartNote.value?.duration_days) || 1)
  if (durationDays > 1) {
    return `该便签设置了持续 ${durationDays} 天。提前执行后，生效时间将改为当前时间，日历视图中的连续显示日期也会从今天重新计算。是否确认提前执行？`
  }
  return '该便签尚未到达生效时间。提前执行后，生效时间将改为当前时间。是否确认提前执行？'
})

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
    '.month-week__events, .month-day-cell__count, .month-day-cell__lunar, .month-day-cell__holiday'
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

async function replaceCalendarData(
  data,
  { direction, nextSelection = '', sequence = calendarModel.sequence } = {}
) {
  const outgoing = startCalendarAnimation(direction, 'out')
  await waitForAnimation(outgoing)
  if (calendarModel.disposed || sequence !== calendarModel.sequence) {
    outgoing?.cancel()
    return false
  }

  calendarModel.commitPeriod(data, { nextSelection })
  await nextTick()
  if (calendarModel.disposed || sequence !== calendarModel.sequence) {
    outgoing?.cancel()
    return false
  }

  const incoming = startCalendarAnimation(direction, 'in')
  outgoing?.cancel()
  await waitForAnimation(incoming)
  incoming?.cancel()
  return !calendarModel.disposed && sequence === calendarModel.sequence
}

async function presentCalendarRefresh(data, { manual, sequence }) {
  const outgoing = manual ? startRefreshContentAnimation('out') : []
  if (manual) await waitForAnimations(outgoing)
  if (calendarModel.disposed || sequence !== calendarModel.sequence) {
    outgoing.forEach((animation) => animation.cancel())
    return { status: 'cancelled' }
  }
  calendarModel.replaceData(data)
  await nextTick()
  if (!calendarModel.isCurrent(sequence)) {
    outgoing.forEach((animation) => animation.cancel())
    return { status: 'cancelled' }
  }
  if (manual) {
    outgoing.forEach((animation) => animation.cancel())
    const incoming = startRefreshContentAnimation('in')
    await waitForAnimations(incoming)
    incoming.forEach((animation) => animation.cancel())
  }
  return { status: 'success' }
}

async function loadMonth(year = viewYear.value, month = viewMonth.value) {
  return traceCalendarLoad({ reason: 'load-month', year, month }, () =>
    calendarModel.loadMonth(year, month)
  )
}
async function loadWeek(anchorDate = weekAnchorKey.value) {
  return traceCalendarLoad({ reason: 'load-week', anchorDate }, () =>
    calendarModel.loadWeek(anchorDate)
  )
}
const { goPrevious, goNext, jumpTo, jumpToDate, goToday } = calendarModel

async function refreshCalendarContent({ manual = false, diagnosticCauses } = {}) {
  return traceCalendarLoad({ reason: manual ? 'manual' : 'refresh', ...diagnosticCauses }, () =>
    calendarModel.refresh({ manual })
  )
}
function refreshCalendar() {
  void refreshCalendarContent({ manual: true })
}

async function onHistoricalNotesMoved() {
  const today = todayKey.value
  const alreadyInPeriod = isWeekView.value
    ? today >= calendarData.value.weekStart && today <= calendarData.value.weekEnd
    : today.startsWith(`${viewYear.value}-${String(viewMonth.value).padStart(2, '0')}-`)
  // The command's broadcast is already queued. Navigation reads fresh data itself;
  // an unchanged period needs one content refresh after focusing today.
  clearTimeout(notesChangedTimer)
  notesChangedTimer = null
  const diagnosticCauses = refreshCauses.take()
  await goToday()
  if (alreadyInPeriod && !calendarModel.disposed) {
    await refreshCalendarContent({ diagnosticCauses })
  }
}

function onCardStatusAction(note) {
  if (note.status === 'initialized') {
    earlyStartNote.value = note
    earlyStartConfirmVisible.value = true
    return
  }
  void executeCardStatusAction(note)
}

function confirmEarlyStart() {
  const note = earlyStartNote.value
  earlyStartNote.value = null
  if (note) void executeCardStatusAction(note)
}

function cancelEarlyStart() {
  earlyStartNote.value = null
}

function selectContextDate(day) {
  if (!(day?.isActive ?? day?.inCurrentMonth)) return
  selectedKey.value = day.key
}

function openPreviewDayPanel(day) {
  if (!(day?.isActive ?? day?.inCurrentMonth)) return
  selectedKey.value = day.key
  panelOpen.value = true
}

function requestDeleteNote(note) {
  if (!note?.id || deletingNote.value) return
  deleteTargetNote.value = note
  deleteConfirmVisible.value = true
}

function cancelDeleteNote() {
  if (!deletingNote.value) deleteTargetNote.value = null
}

async function confirmDeleteNote() {
  const note = deleteTargetNote.value
  if (!note?.id || deletingNote.value) return
  deletingNote.value = true
  try {
    const deleted = await window.api.deleteNote(note.id)
    if (!deleted) throw new Error('便签不存在或已被删除')
    calendarModel.removeNote(note.id)
    showMessage('success', '便签已删除')
  } catch (error) {
    console.error('[MonthWorkspace] 删除便签失败:', note.id, error)
    showMessage('error', error.message || '删除失败，请重试')
  } finally {
    deletingNote.value = false
    deleteTargetNote.value = null
  }
}

async function selectDate(day) {
  if (!(day?.isActive ?? day?.inCurrentMonth)) return
  selectedKey.value = day.key
}

function toggleDayPanel() {
  if (panelOpen.value) {
    panelOpen.value = false
    return
  }
  const visibleDays = calendarData.value.days || []
  if (!visibleDays.length) return
  const selectionVisible = visibleDays.some((day) => day.key === selectedKey.value)
  if (!selectionVisible) {
    selectedKey.value =
      visibleDays.find((day) => day.key === todayKey.value)?.key ||
      visibleDays.find((day) => day.inCurrentMonth)?.key ||
      ''
  }
  panelOpen.value = true
}

function openCreator(dayOrKey) {
  const dateKey = typeof dayOrKey === 'string' ? dayOrKey : dayOrKey?.key
  if (!dateKey) return
  creatorDate.value = dateKey
}

onMounted(() => {
  stopNewNoteShortcut = window.api.onNewNoteRequested?.(() => {
    const creatorDialog = creatorOverlayRef.value?.querySelector('.month-creator')
    const anotherModal = [...document.querySelectorAll('[aria-modal="true"]')].some(
      (modal) => modal !== creatorDialog
    )
    if (anotherModal) {
      showMessage('warning', '请先完成或关闭当前面板，再新建便签')
      return
    }
    if (creatorDate.value) {
      if (creatorDisplayed.value) focusModal(creatorOverlayRef.value)
      return
    }
    if (workspaceBodyRef.value?.closest('[inert]')) {
      showMessage('warning', '请先完成或关闭当前面板，再新建便签')
      return
    }
    openCreator(selectedKey.value || todayKey.value)
  })
})

function onQuickCreateOpened(day) {
  if (!(day?.isActive ?? day?.inCurrentMonth)) return
  selectedKey.value = day.key
}

const onQuickCreated = calendarModel.addNote

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

function queueNotesRefresh(payload) {
  if (calendarModel.disposed) return
  if (payload) refreshCauses.add(payload)
  clearTimeout(notesChangedTimer)
  notesChangedTimer = setTimeout(() => {
    notesChangedTimer = null
    if (transitioning.value || statusTransitions.size > 0) {
      refreshCauses.defer(transitioning.value ? 'calendar-transition' : 'status-transition')
      queueNotesRefresh()
      return
    }
    void refreshCalendarContent({ diagnosticCauses: refreshCauses.take() })
  }, 40)
}

function startPanelResize(event) {
  if (!workspaceBodyRef.value) return
  event.preventDefault()
  const bounds = workspaceBodyRef.value.getBoundingClientRect()
  const pointerId = event.pointerId
  const handle = event.currentTarget
  try {
    if (event.isTrusted) handle?.setPointerCapture?.(pointerId)
  } catch {
    // 指针已释放时继续使用 window 级监听，不影响拖拽与持久化。
  }
  document.body.classList.add('is-resizing-calendar-day-panel')

  const onMove = (moveEvent) => {
    const ratio = ((moveEvent.clientX - bounds.left) / bounds.width) * 100
    dayPanelSize.value = Math.min(50, Math.max(25, ratio))
  }
  const finish = async () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    try {
      if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
    } catch {
      // 捕获可能已由浏览器自动释放；结束逻辑仍需继续保存宽度。
    }
    document.body.classList.remove('is-resizing-calendar-day-panel')
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
  let bootstrappingSettings = true
  stopSettingsListener = settingsSnapshots.subscribe((snapshot) => {
    if (calendarModel.disposed) return
    if (bootstrappingSettings) {
      calendarPreferences.applyInitialSettings(snapshot)
      dayPanelSize.value = Math.min(
        50,
        Math.max(25, Number(snapshot?.values?.ui?.dayPanelSize) || defaultDayPanelSize)
      )
    } else if (calendarPreferences.applySettings(snapshot).previewChanged) queueNotesRefresh()
  })
  try {
    await calendarPreferences.settingsReady
  } catch (error) {
    console.warn('[MonthWorkspace] 读取日期侧栏设置失败:', error)
  }
  if (calendarModel.disposed) return
  bootstrappingSettings = false
  stopNotesListener = window.api.onNotesChanged?.(queueNotesRefresh)
  stopTemplatesListener = window.api.onTemplatesChanged?.(queueNotesRefresh)
  stopHolidayDataListener = window.api.onHolidayDataChanged?.(queueNotesRefresh)
  const calendarLoadPromise = isWeekView.value ? loadWeek(todayKey.value) : loadMonth()
  // 日历可见性只依赖本地数据；天气网络请求在后台补齐，不能阻塞窗口就绪。
  await calendarLoadPromise
  if (!calendarModel.disposed) emit('ready')
})

watch(modalOpen, (open) => emit('modal-state-change', open), { immediate: true })
watch(todayKey, (next, previous) => {
  if (next !== previous) queueNotesRefresh()
})
watch(
  () => [creatorDisplayed.value, editorDisplayed.value],
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

onBeforeUnmount(() => {
  stopNewNoteShortcut?.()
  statusActions.dispose()
  calendarModel.dispose()
  calendarPreferences.dispose()
  stopNotesListener?.()
  stopTemplatesListener?.()
  stopHolidayDataListener?.()
  stopSettingsListener?.()
  clearTimeout(notesChangedTimer)
  if (modalFocusFrame !== null) cancelAnimationFrame(modalFocusFrame)
  restoreFocusedElement(previouslyFocused)
  resizeCleanup?.()
  emit('modal-state-change', false)
})
</script>

<template>
  <div class="month-workspace" :class="{ 'is-week-view': isWeekView }">
    <div ref="workspaceBodyRef" class="month-workspace__body" :inert="modalOpen">
      <Transition name="month-side-panel">
        <MonthDayPanel
          v-if="panelOpen && selectedKey"
          class="month-workspace__side"
          :style="{ width: `${dayPanelSize}%` }"
          :date-key="selectedKey"
          :notes="selectedNotes"
          :weather="selectedWeather"
          :weather-current="selectedWeather?.currentWeather || null"
          :weather-location="weatherForecast?.location || null"
          :weather-fetched-at="weatherForecast?.fetchedAt || null"
          :weather-stale="weatherState.stale || Boolean(weatherError)"
          :weather-error="weatherError"
          :status-transitions="statusTransitions"
          @close="panelOpen = false"
          @create="openCreator(selectedKey)"
          @edit="openEditor"
          @status-action="onCardStatusAction"
          @resize-start="startPanelResize"
        />
      </Transition>

      <section class="month-workspace__calendar">
        <MonthCalendarToolbar
          :view-mode="viewMode"
          :year="viewYear"
          :month="viewMonth"
          :week-start="calendarData.weekStart || ''"
          :week-end="calendarData.weekEnd || ''"
          :selected-key="selectedKey || weekAnchorKey"
          :day-panel-open="panelOpen"
          :refreshing="refreshing"
          :busy="transitioning"
          :forecast="weatherEnabled ? weatherForecast : null"
          :recurring-preview-enabled="recurringPreviewEnabled"
          :recurring-preview-saving="recurringPreviewSaving"
          @previous="goPrevious"
          @next="goNext"
          @today="goToday"
          @jump="jumpTo"
          @jump-date="jumpToDate"
          @refresh="refreshCalendar"
          @update:recurring-preview-enabled="updateRecurringPreviewEnabled"
          @toggle-day-panel="toggleDayPanel"
          @historical-move-open-change="historicalMoveOpen = $event"
          @historical-notes-moved="onHistoricalNotesMoved"
        />
        <div ref="calendarSurfaceRef" class="month-workspace__calendar-body scroll-y">
          <MonthCalendarGrid
            :view-mode="viewMode"
            :days="calendarData.days"
            :notes="calendarData.notes"
            :recurring-previews="calendarData.recurringPreviews || []"
            :selected-key="selectedKey"
            :today-key="todayKey"
            :quick-create-until-completed="quickCreateUntilCompleted"
            :weather-by-date="weatherByDate"
            :status-transitions="statusTransitions"
            @select-date="selectDate"
            @quick-create-opened="onQuickCreateOpened"
            @quick-created="onQuickCreated"
            @context-select-date="selectContextDate"
            @context-create="openCreator"
            @context-edit="openEditor"
            @context-delete="requestDeleteNote"
            @context-status-action="onCardStatusAction"
            @preview-open-day-panel="openPreviewDayPanel"
          />
          <div v-if="loading && !calendarData.days.length" class="month-workspace__state">
            正在加载{{ isWeekView ? '周历' : '月历' }}…
          </div>
          <div v-else-if="loadError" class="month-workspace__state is-error">
            <span>{{ loadError }}</span
            ><button type="button" @click="isWeekView ? loadWeek() : loadMonth()">重试</button>
          </div>
        </div>
      </section>
    </div>

    <Teleport to="body">
      <Transition name="month-modal" appear @after-leave="finishCreatorLeave">
        <div
          v-if="creatorDisplayed"
          ref="creatorOverlayRef"
          class="month-modal-overlay"
          data-modal-layer="month-note-creator"
          tabindex="-1"
          @keydown="onBusinessModalKeydown($event, 'creator')"
        >
          <MonthNoteCreator
            ref="creatorRef"
            :date-key="creatorDate"
            :view-label="calendarViewLabel"
            @created="onCreated"
            @close="closeCreator"
          />
        </div>
      </Transition>

      <Transition name="month-modal" appear @after-leave="finishEditorLeave">
        <div
          v-if="editorDisplayed"
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

    <ConfirmDialog
      v-model:visible="earlyStartConfirmVisible"
      title="提前执行便签？"
      :message="earlyStartMessage"
      confirm-text="提前执行"
      cancel-text="取消"
      @confirm="confirmEarlyStart"
      @cancel="cancelEarlyStart"
    />
    <ConfirmDialog
      v-model:visible="deleteConfirmVisible"
      title="删除便签？"
      message="便签会从列表、月视图和周视图中移除，但正文和图片仍会保留，可在搜索中启用“包含已删除”查看。"
      confirm-text="删除"
      cancel-text="取消"
      variant="danger"
      @confirm="confirmDeleteNote"
      @cancel="cancelDeleteNote"
    />
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
  container: calendar-workspace / inline-size;
  display: flex;
  overflow: hidden;
  transition: filter 180ms ease;
}
.month-workspace__side {
  flex: 0 0 auto;
}
.month-workspace__calendar {
  isolation: isolate;
  container: calendar-pane / inline-size;
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  padding: 12rem 15rem 15rem;
}
.month-workspace__calendar-body {
  overflow: auto;
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
/* Preserve seven readable columns; scroll only the calendar canvas. */
.month-workspace__calendar-body :deep(.month-grid) {
  min-width: max(560rem, 42em);
}
@container calendar-workspace (max-width: 900px) {
  .month-workspace__side {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: var(--z-local-top);
    width: min(380rem, 100%) !important;
    max-width: 100%;
    background: rgb(var(--bg-color));
    box-shadow: var(--ui-menu-shadow);
  }
  .month-workspace__side :deep(.month-day-panel__resize) {
    display: none;
  }
}
</style>

<style>
body.is-resizing-calendar-day-panel {
  cursor: ew-resize !important;
  user-select: none !important;
}
</style>
