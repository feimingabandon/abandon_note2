import { onUnmounted, ref, watch } from 'vue'
import { FIRST_USE_NOTICE_VERSION } from '../../../shared/settings-schema.js'
import { useModalRequest } from './useQueuedModal.js'
import { useTodayKey } from './useTodayKey.js'

export function useWorkspaceNotices({ showMessage, openSettings, label, api = window.api }) {
  const noticeQueue = useModalRequest()
  const firstUseQueue = useModalRequest()
  const holidayQueue = useModalRequest()
  const showRemoteNoticeDialog = noticeQueue.requested
  const showFirstUseNotice = firstUseQueue.requested
  const showHolidayDataNoticeDialog = holidayQueue.requested
  const pendingRemoteNotices = ref([])
  const pendingHolidayDataNotice = ref(null)
  const todayKey = useTodayKey()
  let settingsTimer = null
  let disposed = false

  function revealFirstUseNoticeFromSnapshot(snapshot) {
    const pending = (snapshot?.values?.onboarding?.noticeVersion ?? 0) < FIRST_USE_NOTICE_VERSION
    if (!disposed && pending && !showFirstUseNotice.value) showFirstUseNotice.value = true
  }

  function applyInitialSnapshot(snapshot) {
    if (!disposed)
      showFirstUseNotice.value =
        (snapshot?.values?.onboarding?.noticeVersion ?? 0) < FIRST_USE_NOTICE_VERSION
  }

  async function loadPendingRemoteNotices({ show = false } = {}) {
    try {
      const notices = await api.listPendingRemoteNotices()
      if (disposed) return
      pendingRemoteNotices.value = notices
      if (show) showRemoteNoticeDialog.value = notices.length > 0
    } catch (error) {
      console.warn(`[${label}] 读取未确认通知失败:`, error)
    }
  }

  async function loadHolidayDataNotice() {
    try {
      const notice = await api.getHolidayDataNotice()
      if (disposed) return
      pendingHolidayDataNotice.value = notice?.required ? notice : null
      if (pendingHolidayDataNotice.value?.required) showHolidayDataNoticeDialog.value = true
    } catch (error) {
      console.warn(`[${label}] 读取节假日数据提醒失败:`, error)
    }
  }

  watch(todayKey, (nextDateKey, previousDateKey) => {
    if (nextDateKey.slice(0, 4) !== previousDateKey.slice(0, 4)) void loadHolidayDataNotice()
  })

  async function dismissHolidayDataNotice({ openSettingsAfter = false } = {}) {
    const year = pendingHolidayDataNotice.value?.year
    showHolidayDataNoticeDialog.value = false
    pendingHolidayDataNotice.value = null
    if (year) {
      await api
        .dismissHolidayDataNotice(year)
        .catch((error) => console.warn(`[${label}] 保存节假日提醒状态失败:`, error))
    }
    if (!disposed && openSettingsAfter) {
      clearTimeout(settingsTimer)
      settingsTimer = setTimeout(() => {
        settingsTimer = null
        if (!disposed) openSettings()
      }, 220)
    }
  }

  function closeRemoteNoticeDialog() {
    showRemoteNoticeDialog.value = false
  }
  function onRemoteNoticeAcknowledged(id) {
    pendingRemoteNotices.value = pendingRemoteNotices.value.filter((notice) => notice.id !== id)
    if (!pendingRemoteNotices.value.length) showRemoteNoticeDialog.value = false
  }
  function onFirstUseCompleted({ route } = {}) {
    showFirstUseNotice.value = false
    showMessage(
      'success',
      route === 'support'
        ? '感谢你的支持。你的认可，会成为 Abandon 便签继续前进的动力。'
        : '感谢你选择 Abandon 便签。你的使用，就是对我最大的肯定。',
      4200
    )
  }

  onUnmounted(() => {
    disposed = true
    clearTimeout(settingsTimer)
    settingsTimer = null
  })
  return {
    noticeQueue,
    firstUseQueue,
    holidayQueue,
    showRemoteNoticeDialog,
    showFirstUseNotice,
    showHolidayDataNoticeDialog,
    pendingRemoteNotices,
    pendingHolidayDataNotice,
    applyInitialSnapshot,
    revealFirstUseNoticeFromSnapshot,
    loadPendingRemoteNotices,
    loadHolidayDataNotice,
    dismissHolidayDataNotice,
    closeRemoteNoticeDialog,
    onRemoteNoticeAcknowledged,
    onFirstUseCompleted
  }
}
