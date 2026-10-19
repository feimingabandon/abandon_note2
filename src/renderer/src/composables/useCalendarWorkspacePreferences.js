import { computed, readonly, ref } from 'vue'
import { buildDisplayableWeatherByDate } from '../utils/noteWeather.js'
import { weatherFreshness } from '../../../shared/weather-freshness.js'

/** Owns calendar preferences and weather requests; the root owns subscriptions and the clock. */
export function useCalendarWorkspacePreferences({ api, clock, refreshCalendar, notify }) {
  const recurringPreviewEnabled = ref(false)
  const recurringPreviewSaving = ref(false)
  const quickCreateUntilCompleted = ref(false)
  const weatherEnabled = ref(false)
  const weatherForecast = ref(null)
  const weatherLoading = ref(false)
  const weatherError = ref('')
  let disposed = false
  let weatherSequence = 0
  let previewSaveSequence = 0
  let previewRevision = 0

  // The minute tick schedules ageing; a newly received response is evaluated now.
  const weatherState = computed(() =>
    weatherFreshness(weatherForecast.value, Math.max(clock.value, Date.now()))
  )
  const weatherByDate = computed(() =>
    buildDisplayableWeatherByDate(weatherForecast.value, Math.max(clock.value, Date.now()))
  )
  const currentWeatherRequest = (sequence) => !disposed && sequence === weatherSequence
  const currentPreviewSave = (sequence) => !disposed && sequence === previewSaveSequence

  function applyPreview(value) {
    const next = Boolean(value)
    if (next === recurringPreviewEnabled.value) return false
    recurringPreviewEnabled.value = next
    previewRevision += 1
    return true
  }
  function clearWeather() {
    weatherSequence += 1
    weatherLoading.value = false
    weatherForecast.value = null
    weatherError.value = ''
  }
  function applyInitialSettings(snapshot) {
    if (disposed) return
    applyPreview(snapshot?.values?.calendar?.recurringPreviewEnabled)
    quickCreateUntilCompleted.value = Boolean(snapshot?.values?.notes?.quickCreateUntilCompleted)
    weatherEnabled.value = Boolean(snapshot?.values?.weather?.enabled)
  }
  function applySettings(snapshot) {
    if (disposed) return { previewChanged: false }
    const previewChanged = applyPreview(snapshot?.values?.calendar?.recurringPreviewEnabled)
    quickCreateUntilCompleted.value = Boolean(snapshot?.values?.notes?.quickCreateUntilCompleted)
    weatherEnabled.value = Boolean(snapshot?.values?.weather?.enabled)
    if (weatherEnabled.value && snapshot?.values?.weather?.location) {
      void loadWeather({ quiet: true })
    } else {
      clearWeather()
    }
    return { previewChanged }
  }
  function acceptForecast(forecast) {
    if (disposed || !weatherEnabled.value) return false
    weatherSequence += 1
    weatherLoading.value = false
    weatherForecast.value = forecast
    weatherError.value = forecast?.warning || ''
    return true
  }
  async function loadWeather({ quiet = false } = {}) {
    if (disposed || !weatherEnabled.value) return { status: 'cancelled' }
    const sequence = ++weatherSequence
    weatherLoading.value = true
    weatherError.value = ''
    try {
      const forecast = await api.getWeatherForecast()
      if (!currentWeatherRequest(sequence)) return { status: 'cancelled' }
      weatherForecast.value = forecast
      weatherError.value = forecast?.warning || ''
      return { status: 'success' }
    } catch (error) {
      if (!currentWeatherRequest(sequence)) return { status: 'cancelled' }
      weatherForecast.value = null
      weatherError.value = error?.message || '天气获取失败'
      if (!quiet) notify('warning', weatherError.value)
      return { status: 'error' }
    } finally {
      if (currentWeatherRequest(sequence)) weatherLoading.value = false
    }
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
    const previous = recurringPreviewEnabled.value
    if (next === previous) return { status: 'unchanged' }
    applyPreview(next)
    const revision = previewRevision
    const sequence = ++previewSaveSequence
    recurringPreviewSaving.value = true
    try {
      try {
        await api.setSettingValue('calendar.recurringPreviewEnabled', next)
      } catch (error) {
        if (!currentPreviewSave(sequence)) return { status: 'cancelled' }
        // A newer settings broadcast owns the current value and must survive rollback.
        if (revision === previewRevision) applyPreview(previous)
        console.error('[MonthWorkspace] 保存循环便签预览设置失败:', error)
        notify('error', error?.message || '无法切换循环便签预览')
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
    requestOptions: () => ({ includeRecurringPreviews: recurringPreviewEnabled.value }),
    applyInitialSettings,
    applySettings,
    acceptForecast,
    loadWeather,
    updateRecurringPreviewEnabled,
    dispose() {
      disposed = true
      weatherSequence += 1
      previewSaveSequence += 1
      weatherLoading.value = false
      recurringPreviewSaving.value = false
    }
  }
}
