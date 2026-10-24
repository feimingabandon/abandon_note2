import { computed, readonly, ref } from 'vue'
import { buildDisplayableWeatherByDate } from '../utils/noteWeather.js'
import { weatherFreshness } from '../../../shared/weather-freshness.js'
import { getSettingsSnapshotStore } from '../utils/settingsSnapshots.js'
import { parseSettingsReceipt } from '../../../shared/settings-receipt.js'
import { acquireDateContextSettings } from './useDateContextSettings.js'

/** Owns calendar preferences and display derivations; weather belongs to its shared lease. */
export function useCalendarWorkspacePreferences({ api, clock, refreshCalendar, notify }) {
  const settingsSnapshots = getSettingsSnapshotStore(api)
  const dateContext = acquireDateContextSettings(api)
  const previewIntentOwner = Symbol('calendar-recurring-preview')
  const recurringPreviewEnabled = ref(false)
  const recurringPreviewSaving = ref(false)
  const quickCreateUntilCompleted = ref(false)
  const {
    weatherEnabled,
    forecast: weatherForecast,
    loading: weatherLoading,
    error: weatherError
  } = dateContext
  let disposed = false
  let previewSaveSequence = 0
  let previewIntent = null

  // The minute tick schedules ageing; a newly received response is evaluated now.
  const weatherState = computed(() =>
    weatherFreshness(weatherForecast.value, Math.max(clock.value, Date.now()))
  )
  const weatherByDate = computed(() =>
    buildDisplayableWeatherByDate(weatherForecast.value, Math.max(clock.value, Date.now()))
  )
  const currentPreviewSave = (sequence) => !disposed && sequence === previewSaveSequence

  function applyPreview(value) {
    const next = Boolean(value)
    if (next === recurringPreviewEnabled.value) return false
    recurringPreviewEnabled.value = next
    return true
  }
  function applyInitialSettings(snapshot) {
    if (disposed || !snapshot?.values) return
    applyPreview(snapshot?.values?.calendar?.recurringPreviewEnabled)
    quickCreateUntilCompleted.value = Boolean(snapshot?.values?.notes?.quickCreateUntilCompleted)
  }
  function applySettings(snapshot) {
    if (disposed || !snapshot?.values) return { previewChanged: false }
    const previewChanged = applyPreview(snapshot?.values?.calendar?.recurringPreviewEnabled)
    quickCreateUntilCompleted.value = Boolean(snapshot?.values?.notes?.quickCreateUntilCompleted)
    return { previewChanged }
  }
  async function loadWeather({ quiet = false } = {}) {
    if (disposed) return { status: 'cancelled' }
    const context = dateContext.captureWeatherContext()
    if (!context) return { status: 'cancelled' }
    const result = await dateContext.loadForecast()
    if (disposed || !dateContext.isWeatherContextCurrent(context)) return { status: 'cancelled' }
    if (result.status === 'error' && !quiet) notify('warning', weatherError.value)
    return result
  }
  async function refreshPreview(sequence) {
    if (!currentPreviewSave(sequence)) return { status: 'cancelled' }
    try {
      return await refreshCalendar()
    } catch (error) {
      if (!currentPreviewSave(sequence)) return { status: 'cancelled' }
      console.error('[MonthWorkspace] 同步循环便签预览失败:', error)
      notify('error', error?.message || '日历同步失败')
      return { status: 'error' }
    }
  }
  async function updateRecurringPreviewEnabled(value) {
    if (disposed || recurringPreviewSaving.value) return { status: 'cancelled' }
    const next = Boolean(value)
    if (next === recurringPreviewEnabled.value) return { status: 'unchanged' }
    const previousIntent = previewIntent
    const intent = {
      release: settingsSnapshots.protectSetting(
        previewIntentOwner,
        'calendar.recurringPreviewEnabled',
        next
      )
    }
    previewIntent = intent
    previousIntent?.release()
    applyPreview(next)
    const sequence = ++previewSaveSequence
    recurringPreviewSaving.value = true
    try {
      try {
        const result = await api.setSettingValue('calendar.recurringPreviewEnabled', next)
        const receipt = parseSettingsReceipt(result, { source: settingsSnapshots.latest()?.source })
        if (!receipt.saved)
          throw new Error(receipt.error?.message || '循环便签预览保存结果尚未确认')
        if (previewIntent === intent) previewIntent = null
        const settlement = settingsSnapshots.settleWrite(intent.release, result)
        if (!settlement.settled || !settlement.current) return { status: 'cancelled' }
      } catch (error) {
        if (!currentPreviewSave(sequence) || !intent.release.isActive())
          return { status: 'cancelled' }
        console.error('[MonthWorkspace] 保存循环便签预览设置失败:', error)
        notify('error', error?.message || '无法切换循环便签预览')
        try {
          // A rejected write can still have changed disk state. Only a fresh raw
          // read may settle rollback; cached or masked values cannot confirm it.
          const actual = await settingsSnapshots.read({
            allowCachedOnError: false,
            protectIntents: false
          })
          if (!currentPreviewSave(sequence) || !intent.release.isActive())
            return { status: 'cancelled' }
          if (previewIntent === intent) previewIntent = null
          intent.release()
          settingsSnapshots.acceptCommitted(actual, { reconcile: true })
        } catch {
          // Preserve the pending choice until actual state is known or disposed.
          if (!currentPreviewSave(sequence) || !intent.release.isActive())
            return { status: 'cancelled' }
        }
        if (!currentPreviewSave(sequence)) return { status: 'cancelled' }
        await refreshPreview(sequence)
        return { status: 'error' }
      }
      if (!currentPreviewSave(sequence)) return { status: 'cancelled' }
      const refresh = await refreshPreview(sequence)
      if (!currentPreviewSave(sequence)) return { status: 'cancelled' }
      return { status: 'success', refresh }
    } finally {
      if (currentPreviewSave(sequence)) recurringPreviewSaving.value = false
    }
  }

  return {
    recurringPreviewEnabled: readonly(recurringPreviewEnabled),
    recurringPreviewSaving: readonly(recurringPreviewSaving),
    quickCreateUntilCompleted: readonly(quickCreateUntilCompleted),
    weatherEnabled: readonly(weatherEnabled),
    weatherForecast: readonly(weatherForecast),
    weatherLoading: readonly(weatherLoading),
    weatherError: readonly(weatherError),
    weatherState,
    weatherByDate,
    settingsReady: dateContext.settingsReady,
    requestOptions: () => ({ includeRecurringPreviews: recurringPreviewEnabled.value }),
    applyInitialSettings,
    applySettings,
    loadWeather,
    updateRecurringPreviewEnabled,
    dispose() {
      disposed = true
      dateContext.dispose()
      previewSaveSequence += 1
      recurringPreviewSaving.value = false
      previewIntent = null
      settingsSnapshots.clearOwner(previewIntentOwner)
    }
  }
}
