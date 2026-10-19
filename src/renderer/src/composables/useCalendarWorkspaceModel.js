import { ref, computed, readonly } from 'vue'
import {
  MIN_CALENDAR_DATE,
  MAX_CALENDAR_DATE,
  buildWeekGrid,
  addCalendarDays,
  MIN_CALENDAR_YEAR,
  MAX_CALENDAR_YEAR,
  dateKeyFromParts,
  dateOrdinal,
  parseDateKey
} from '../../../shared/calendar/calendar-date-rules.js'
import { VIEW_MODES } from '../../../shared/settings-schema.js'

/** Calendar period/state and async lifetime have a single owner. */
export function useCalendarWorkspaceModel({ api, getViewMode, todayKey, presentation }) {
  const now = new Date()
  const viewYear = ref(now.getFullYear()),
    viewMonth = ref(now.getMonth() + 1)
  const weekAnchorKey = ref(dateKeyFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate()))
  const calendarData = ref({ days: [], notes: [], recurringPreviews: [] })
  const loading = ref(true),
    refreshing = ref(false),
    transitioning = ref(false),
    loadError = ref(''),
    selectedKey = ref('')
  const isWeekView = computed(() => getViewMode() === VIEW_MODES.WEEK)
  let disposed = false,
    loadSequence = 0
  function begin() {
    return ++loadSequence
  }
  function isCurrent(sequence) {
    return !disposed && sequence === loadSequence
  }
  function calendarRequestOptions() {
    return presentation.requestOptions()
  }
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

  function monthMotionDirection(targetYear, targetMonth) {
    const difference =
      monthIndex(targetYear, targetMonth) - monthIndex(viewYear.value, viewMonth.value)
    if (difference > 0) return 'forward'
    if (difference < 0) return 'backward'
    return null
  }

  function weekMotionDirection(targetKey) {
    const currentKey = calendarData.value.weekStart || weekAnchorKey.value
    const difference = dateOrdinal(targetKey) - dateOrdinal(currentKey)
    if (difference > 0) return 'forward'
    if (difference < 0) return 'backward'
    return null
  }

  function weekContains(dateKey) {
    return Boolean(
      calendarData.value.weekStart &&
      calendarData.value.weekEnd &&
      dateKey >= calendarData.value.weekStart &&
      dateKey <= calendarData.value.weekEnd
    )
  }

  function syncCalendarPeriod(data) {
    if (isWeekView.value) {
      weekAnchorKey.value = data.anchorDate || data.weekStart || weekAnchorKey.value
      const anchor = parseDateKey(weekAnchorKey.value)
      viewYear.value = anchor.year
      viewMonth.value = anchor.month
    } else {
      viewYear.value = data.year
      viewMonth.value = data.month
    }
  }

  async function loadMonthData(year, month) {
    const sequence = begin()
    loading.value = true
    loadError.value = ''
    try {
      const data = await api.getMonthCalendarData(year, month, calendarRequestOptions())
      if (!isCurrent(sequence)) return { status: 'cancelled' }
      calendarData.value = data
      syncCalendarPeriod(data)
      return { status: 'success' }
    } catch (error) {
      if (!isCurrent(sequence)) return { status: 'cancelled' }
      console.error('[MonthWorkspace] 加载月历失败:', error)
      loadError.value = error.message || '月历加载失败'
      return { status: 'error' }
    } finally {
      if (isCurrent(sequence)) loading.value = false
    }
  }

  async function navigateMonth(year, month, { shiftSelection = true, selectionKey = null } = {}) {
    if (disposed || transitioning.value) return false
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
    const direction = monthMotionDirection(targetYear, targetMonth)
    const nextSelection =
      selectionKey ??
      (shiftSelection ? selectedKeyForMonth(targetYear, targetMonth) : selectedKey.value)
    const sequence = begin()
    transitioning.value = true
    loading.value = true
    loadError.value = ''
    try {
      const data = await api.getMonthCalendarData(targetYear, targetMonth, calendarRequestOptions())
      if (!isCurrent(sequence)) return false
      return await presentation.replacePeriod(data, { direction, nextSelection, sequence })
    } catch (error) {
      if (!isCurrent(sequence)) return false
      console.error('[MonthWorkspace] 切换月历失败:', error)
      loadError.value = error.message || '月历加载失败'
      return false
    } finally {
      if (isCurrent(sequence)) loading.value = false
      if (!disposed) transitioning.value = false
    }
  }

  let pendingWeekNavigation = null,
    activeWeekNavigationSelection = ''
  const firstWeekDateKey = buildWeekGrid(MIN_CALENDAR_DATE).weekStart
  const lastWeekDateKey = buildWeekGrid(MAX_CALENDAR_DATE).weekEnd
  const calendarViewLabel = computed(() => (isWeekView.value ? '周视图' : '月视图'))
  async function loadWeekData(anchorDate) {
    const sequence = begin()
    loading.value = true
    loadError.value = ''
    try {
      const data = await api.getWeekCalendarData(anchorDate, calendarRequestOptions())
      if (disposed || sequence !== loadSequence) return { status: 'cancelled' }
      commitPeriod(data)
      if (!selectedKey.value) selectedKey.value = anchorDate
      return { status: 'success' }
    } catch (error) {
      if (disposed || sequence !== loadSequence) return { status: 'cancelled' }
      console.error('[MonthWorkspace] 加载周历失败:', error)
      loadError.value = error.message || '周历加载失败'
      return { status: 'error' }
    } finally {
      if (!disposed && sequence === loadSequence) loading.value = false
    }
  }

  async function navigateWeek(
    anchorDate,
    { selectionKey = anchorDate, focusIfCurrent = false } = {}
  ) {
    if (disposed) return false
    if (transitioning.value) {
      pendingWeekNavigation = { anchorDate, selectionKey, focusIfCurrent }
      return false
    }
    parseDateKey(anchorDate)
    activeWeekNavigationSelection = selectionKey
    if (weekContains(anchorDate)) {
      selectedKey.value = selectionKey
      if (focusIfCurrent) {
        transitioning.value = true
        try {
          await presentation.focusDate(selectionKey)
        } finally {
          if (!disposed) transitioning.value = false
          continuePendingWeekNavigation(anchorDate)
        }
      } else {
        activeWeekNavigationSelection = ''
      }
      return true
    }

    const direction = weekMotionDirection(anchorDate)
    const sequence = begin()
    transitioning.value = true
    loading.value = true
    loadError.value = ''
    try {
      const data = await api.getWeekCalendarData(anchorDate, calendarRequestOptions())
      if (disposed || sequence !== loadSequence) return false
      return await presentation.replacePeriod(data, {
        direction,
        nextSelection: selectionKey,
        sequence
      })
    } catch (error) {
      if (disposed || sequence !== loadSequence) return false
      console.error('[MonthWorkspace] 切换周历失败:', error)
      loadError.value = error.message || '周历加载失败'
      activeWeekNavigationSelection = ''
      return false
    } finally {
      if (!disposed && sequence === loadSequence) loading.value = false
      if (!disposed) transitioning.value = false
      continuePendingWeekNavigation(anchorDate)
    }
  }

  function continuePendingWeekNavigation(completedAnchor = '') {
    if (disposed) return
    const pending = pendingWeekNavigation
    pendingWeekNavigation = null
    if (pending && pending.anchorDate !== completedAnchor) {
      void navigateWeek(pending.anchorDate, pending)
    } else {
      activeWeekNavigationSelection = ''
    }
  }

  function currentWeekNavigationSelection() {
    return (
      pendingWeekNavigation?.selectionKey ||
      activeWeekNavigationSelection ||
      selectedKey.value ||
      weekAnchorKey.value
    )
  }

  function goPrevious() {
    if (isWeekView.value) {
      const currentSelection = currentWeekNavigationSelection()
      const target = addCalendarDays(currentSelection, -7)
      if (target < firstWeekDateKey) return
      void navigateWeek(target, { selectionKey: target })
    } else {
      void navigateMonth(viewYear.value, viewMonth.value - 1)
    }
  }
  function goNext() {
    if (isWeekView.value) {
      const currentSelection = currentWeekNavigationSelection()
      const target = addCalendarDays(currentSelection, 7)
      if (target > lastWeekDateKey) return
      void navigateWeek(target, { selectionKey: target })
    } else {
      void navigateMonth(viewYear.value, viewMonth.value + 1)
    }
  }
  function jumpTo({ year, month }) {
    void navigateMonth(year, month)
  }
  function jumpToDate(dateKey) {
    void navigateWeek(dateKey, { selectionKey: dateKey, focusIfCurrent: true })
  }

  async function refreshCalendarData({ manual = false } = {}) {
    if (disposed || refreshing.value || transitioning.value) return
    if (manual) refreshing.value = true
    transitioning.value = true
    const sequence = begin()
    loadError.value = ''
    try {
      const data = isWeekView.value
        ? await api.getWeekCalendarData(weekAnchorKey.value, calendarRequestOptions())
        : await api.getMonthCalendarData(viewYear.value, viewMonth.value, calendarRequestOptions())
      if (disposed || sequence !== loadSequence) return { status: 'cancelled' }
      return await presentation.refreshPeriod(data, { manual, sequence })
    } catch (error) {
      if (disposed || sequence !== loadSequence) return { status: 'cancelled' }
      console.error('[MonthWorkspace] 同步日历失败:', error)
      loadError.value = error.message || `${calendarViewLabel.value}同步失败`
      return { status: 'error' }
    } finally {
      if (!disposed && manual) refreshing.value = false
      if (!disposed) transitioning.value = false
      if (isWeekView.value) continuePendingWeekNavigation()
    }
  }

  async function goToday() {
    if (isWeekView.value) {
      await navigateWeek(todayKey.value, {
        selectionKey: todayKey.value,
        focusIfCurrent: true
      })
      return
    }
    const today = parseDateKey(todayKey.value)
    if (today.year === viewYear.value && today.month === viewMonth.value) {
      selectedKey.value = todayKey.value
      transitioning.value = true
      try {
        await presentation.focusDate(todayKey.value)
      } finally {
        if (!disposed) transitioning.value = false
      }
      return
    }
    await navigateMonth(today.year, today.month, {
      shiftSelection: false,
      selectionKey: todayKey.value
    })
  }

  function mergeCalendarNote(updated, { preserveEffectiveAt = false } = {}) {
    calendarData.value = {
      ...calendarData.value,
      notes: calendarData.value.notes.map((note) =>
        note.id === updated.id
          ? {
              ...note,
              ...updated,
              effective_at: preserveEffectiveAt ? note.effective_at : updated.effective_at,
              tags: Array.isArray(updated.tags) ? updated.tags : note.tags,
              attachment_count: Number.isFinite(Number(updated.attachment_count))
                ? Number(updated.attachment_count)
                : note.attachment_count
            }
          : note
      )
    }
  }

  function removeNote(id) {
    calendarData.value = {
      ...calendarData.value,
      notes: calendarData.value.notes.filter((note) => Number(note.id) !== Number(id))
    }
  }
  function addNote(note) {
    if (!note?.id || calendarData.value.notes.some((item) => Number(item.id) === Number(note.id)))
      return
    calendarData.value = { ...calendarData.value, notes: [...calendarData.value.notes, note] }
  }

  function commitPeriod(data, { nextSelection = '' } = {}) {
    calendarData.value = data
    syncCalendarPeriod(data)
    if (nextSelection) selectedKey.value = nextSelection
  }
  function replaceData(data) {
    calendarData.value = data
  }
  return {
    viewYear: readonly(viewYear),
    viewMonth: readonly(viewMonth),
    weekAnchorKey: readonly(weekAnchorKey),
    calendarData: readonly(calendarData),
    loading: readonly(loading),
    refreshing: readonly(refreshing),
    transitioning: readonly(transitioning),
    loadError: readonly(loadError),
    selectedKey: readonly(selectedKey),
    get sequence() {
      return loadSequence
    },
    get disposed() {
      return disposed
    },
    begin,
    isCurrent,
    dispose() {
      disposed = true
      loadSequence++
      pendingWeekNavigation = null
      activeWeekNavigationSelection = ''
    },
    loadMonth: loadMonthData,
    loadWeek: loadWeekData,
    navigateWeek,
    goPrevious,
    goNext,
    jumpTo,
    jumpToDate,
    goToday,
    refresh: refreshCalendarData,
    patchNote: mergeCalendarNote,
    removeNote,
    addNote,
    navigateMonth,
    commitPeriod,
    replaceData,
    selectDate(key) {
      selectedKey.value = key
    },
    weekContains,
    weekMotionDirection
  }
}
