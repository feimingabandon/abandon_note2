<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import AppTitlebar from './components/system/AppTitlebar.vue'
import TitlebarActions from './components/system/TitlebarActions.vue'
import ResizeHandles from './components/system/ResizeHandles.vue'
import SettingsPanel from './components/system/SettingsPanel.vue'
import MessageToast from './components/system/MessageToast.vue'
import MonthWorkspace from './components/month/MonthWorkspace.vue'
import UpdateDialog from './components/system/UpdateDialog.vue'
import RemoteNoticeDialog from './components/system/RemoteNoticeDialog.vue'
import HolidayDataNoticeDialog from './components/system/HolidayDataNoticeDialog.vue'
import DailyReportDialog from './components/report/DailyReportDialog.vue'
import DailyReportButton from './components/report/DailyReportButton.vue'
import { createMessageProvider } from './composables/useMessage.js'
import { useTodayKey } from './composables/useTodayKey.js'
import { applySettingsSnapshot } from './utils/applySettingsSnapshot.js'
import { retainModalBlur } from './utils/modalBlur.js'
import { createDefaultSettings, VIEW_MODES } from '../../shared/settings-schema.js'

const defaults = createDefaultSettings(VIEW_MODES.MONTH)
const { showMessage } = createMessageProvider()
const locked = ref(defaults.window.lockState)
const alwaysOnTop = ref(defaults.window.alwaysOnTop)
const titlebarStyle = ref(defaults.appearance.titlebarStyle)
const showSettings = ref(false)
const showUpdateDialog = ref(false)
const showRemoteNoticeDialog = ref(false)
const showHolidayDataNoticeDialog = ref(false)
const showDailyReportDialog = ref(false)
const pendingHolidayDataNotice = ref(null)
const holidayNoticeTodayKey = useTodayKey()
const monthBusinessModalOpen = ref(false)
const monthWorkspaceRef = ref(null)
const pendingRemoteNotices = ref([])
const updateChecking = ref(false)
const updateResult = ref(null)
const wallpaperUrl = ref('')
const wallpaperVisible = ref(false)
const wallpaperBlurRadius = ref(defaults.wallpaper.blurRadius)
const wallpaperRenderKey = ref(null)
let wallpaperSequence = 0
let releaseSettingsBackgroundBlur = null
let stopSettingsListener = null
let stopAppMessageListener = null
let stopRemoteNoticesListener = null
let stopNotificationOpenListener = null
let resolveMonthWorkspaceReady = null
const monthWorkspaceReady = new Promise((resolve) => {
  resolveMonthWorkspaceReady = resolve
})

function onMonthWorkspaceReady() {
  resolveMonthWorkspaceReady?.()
  resolveMonthWorkspaceReady = null
}

function openSettings() {
  if (!releaseSettingsBackgroundBlur) releaseSettingsBackgroundBlur = retainModalBlur()
  showSettings.value = true
}

function releaseSettingsBlur() {
  releaseSettingsBackgroundBlur?.()
  releaseSettingsBackgroundBlur = null
}

async function syncWallpaper(snapshot) {
  const sequence = ++wallpaperSequence
  const wallpaper = snapshot?.values?.wallpaper || defaults.wallpaper
  wallpaperBlurRadius.value = wallpaper.blurRadius
  const visible = Boolean(
    wallpaper.enabled && wallpaper.activeId && !snapshot?.runtime?.blur?.effectiveEnabled
  )
  if (!visible) {
    wallpaperVisible.value = false
    wallpaperUrl.value = ''
    wallpaperRenderKey.value = null
    return
  }
  try {
    const data = await window.api.getWallpaperData(Number(wallpaper.activeId), false)
    if (sequence !== wallpaperSequence) return
    if (!data) {
      wallpaperVisible.value = false
      wallpaperUrl.value = ''
      wallpaperRenderKey.value = null
      return
    }
    wallpaperUrl.value = data
    wallpaperRenderKey.value = Number(wallpaper.activeId)
    wallpaperVisible.value = true
  } catch (error) {
    if (sequence === wallpaperSequence) wallpaperVisible.value = false
    console.warn('[MonthApp] 读取月视图壁纸失败:', error)
  }
}

function applySnapshot(snapshot) {
  applySettingsSnapshot(snapshot)
  titlebarStyle.value =
    snapshot?.values?.appearance?.titlebarStyle ?? defaults.appearance.titlebarStyle
  locked.value = snapshot?.values?.window?.lockState ?? defaults.window.lockState
  alwaysOnTop.value = snapshot?.values?.window?.alwaysOnTop ?? defaults.window.alwaysOnTop
  void syncWallpaper(snapshot)
}

async function loadPendingRemoteNotices({ show = false } = {}) {
  try {
    pendingRemoteNotices.value = await window.api.listPendingRemoteNotices()
    if (show && pendingRemoteNotices.value.length) showRemoteNoticeDialog.value = true
  } catch (error) {
    console.warn('[MonthApp] 读取未确认通知失败:', error)
  }
}

function maybeShowHolidayDataNotice() {
  if (
    pendingHolidayDataNotice.value?.required &&
    !showRemoteNoticeDialog.value &&
    !showSettings.value &&
    !showUpdateDialog.value
  ) {
    showHolidayDataNoticeDialog.value = true
  }
}

async function loadHolidayDataNotice() {
  try {
    const notice = await window.api.getHolidayDataNotice()
    pendingHolidayDataNotice.value = notice?.required ? notice : null
    maybeShowHolidayDataNotice()
  } catch (error) {
    console.warn('[MonthApp] 读取节假日数据提醒失败:', error)
  }
}

watch(holidayNoticeTodayKey, (nextDateKey, previousDateKey) => {
  if (nextDateKey.slice(0, 4) !== previousDateKey.slice(0, 4)) void loadHolidayDataNotice()
})

async function dismissHolidayDataNotice({ openSettingsAfter = false } = {}) {
  const year = pendingHolidayDataNotice.value?.year
  showHolidayDataNoticeDialog.value = false
  pendingHolidayDataNotice.value = null
  if (year) {
    await window.api
      .dismissHolidayDataNotice(year)
      .catch((error) => console.warn('[MonthApp] 保存节假日提醒状态失败:', error))
  }
  if (openSettingsAfter) setTimeout(openSettings, 220)
}

function closeRemoteNoticeDialog() {
  showRemoteNoticeDialog.value = false
  maybeShowHolidayDataNotice()
}

function onRemoteNoticeAcknowledged(id) {
  pendingRemoteNotices.value = pendingRemoteNotices.value.filter((notice) => notice.id !== id)
  if (!pendingRemoteNotices.value.length) {
    showRemoteNoticeDialog.value = false
    maybeShowHolidayDataNotice()
  }
}

async function openNoteFromNotification(payload) {
  const noteId = Number(payload?.id)
  if (!Number.isInteger(noteId) || noteId <= 0) return
  const closingModal = showSettings.value || showUpdateDialog.value || showRemoteNoticeDialog.value
  showSettings.value = false
  releaseSettingsBlur()
  showUpdateDialog.value = false
  showRemoteNoticeDialog.value = false
  await new Promise((resolve) => requestAnimationFrame(resolve))
  if (closingModal) await new Promise((resolve) => setTimeout(resolve, 240))
  await monthWorkspaceRef.value?.openNote?.(noteId)
}

async function checkForUpdates() {
  if (updateChecking.value) return
  updateChecking.value = true
  showUpdateDialog.value = true
  try {
    updateResult.value = await window.api.checkForUpdate()
  } catch (error) {
    updateResult.value = {
      status: 'error',
      currentVersion: (await window.api.getAppInfo().catch(() => null))?.version || '未知',
      error: `检查更新失败：${error.message}`
    }
  } finally {
    updateChecking.value = false
  }
}

const onMouseEnter = () => window.api.windowHover(true)
const onMouseLeave = () => window.api.windowHover(false)

onMounted(async () => {
  try {
    applySnapshot(await window.api.getSettingsSnapshot())
  } catch (error) {
    applySnapshot({ values: defaults })
    console.warn('[MonthApp] 读取设置失败，使用月视图默认值:', error)
  }
  stopSettingsListener = window.api.onSettingsChanged?.(applySnapshot)
  stopAppMessageListener = window.api.onAppMessage?.((payload) => {
    if (payload?.text)
      showMessage(payload.type || 'warning', payload.text, payload.duration ?? 2500)
  })
  stopRemoteNoticesListener = window.api.onRemoteNoticesChanged?.(() => {
    void loadPendingRemoteNotices({ show: true })
  })
  stopNotificationOpenListener = window.api.onNotificationOpenNote?.((payload) => {
    void openNoteFromNotification(payload)
  })
  document.addEventListener('mouseenter', onMouseEnter)
  document.addEventListener('mouseleave', onMouseLeave)
  await loadPendingRemoteNotices({ show: true })
  await loadHolidayDataNotice()
  await monthWorkspaceReady
  window.api.rendererReady()
})

onUnmounted(() => {
  stopSettingsListener?.()
  stopAppMessageListener?.()
  stopRemoteNoticesListener?.()
  stopNotificationOpenListener?.()
  document.removeEventListener('mouseenter', onMouseEnter)
  document.removeEventListener('mouseleave', onMouseLeave)
  releaseSettingsBlur()
})
</script>

<template>
  <div class="month-root app-bg">
    <Transition name="month-wallpaper">
      <div v-if="wallpaperVisible" :key="wallpaperRenderKey" class="month-wallpaper">
        <div
          class="month-wallpaper-image"
          :style="{
            backgroundImage: `url(${wallpaperUrl})`,
            '--wallpaper-blur': `${wallpaperBlurRadius}px`
          }"
        />
      </div>
    </Transition>

    <div
      class="month-scene"
      :class="{ 'is-ui-background-blurred': showSettings || monthBusinessModalOpen }"
      :inert="
        showSettings ||
        monthBusinessModalOpen ||
        showUpdateDialog ||
        showRemoteNoticeDialog ||
        showHolidayDataNoticeDialog ||
        showDailyReportDialog
      "
    >
      <ResizeHandles :locked="locked" />
      <AppTitlebar
        v-model:locked="locked"
        v-model:always-on-top="alwaysOnTop"
        :style-variant="titlebarStyle"
      >
        <TitlebarActions :style-variant="titlebarStyle">
          <DailyReportButton month-view @open="showDailyReportDialog = true" />
          <button
            class="titlebar-btn titlebar-btn-settings month-titlebar-btn"
            title="设置"
            @click="openSettings"
          >
            <img class="btn-icon" src="@/resources/icons/settings.png" alt="设置" />
          </button>
          <button
            class="titlebar-btn titlebar-btn-help month-titlebar-btn"
            title="帮助（暂未开放）"
            aria-disabled="true"
          >
            <img class="btn-icon" src="@/resources/icons/help.svg" alt="帮助" />
          </button>
        </TitlebarActions>
      </AppTitlebar>
      <main class="month-content" aria-label="月视图内容区域">
        <MonthWorkspace
          ref="monthWorkspaceRef"
          @modal-state-change="monthBusinessModalOpen = $event"
          @ready="onMonthWorkspaceReady"
        />
      </main>
    </div>

    <SettingsPanel
      v-if="showSettings"
      v-model:visible="showSettings"
      view-mode="month"
      @blur-release="releaseSettingsBlur"
      @check-update="checkForUpdates"
    />
    <UpdateDialog
      v-model:visible="showUpdateDialog"
      :checking="updateChecking"
      :result="updateResult"
      @retry="checkForUpdates"
    />
    <RemoteNoticeDialog
      v-if="showRemoteNoticeDialog && pendingRemoteNotices.length"
      :notices="pendingRemoteNotices"
      @close="closeRemoteNoticeDialog"
      @acknowledged="onRemoteNoticeAcknowledged"
    />
    <HolidayDataNoticeDialog
      v-if="pendingHolidayDataNotice"
      :visible="showHolidayDataNoticeDialog"
      :year="pendingHolidayDataNotice.year"
      @dismiss="dismissHolidayDataNotice()"
      @open-settings="dismissHolidayDataNotice({ openSettingsAfter: true })"
    />
    <DailyReportDialog v-model:visible="showDailyReportDialog" />
    <MessageToast />
  </div>
</template>

<style scoped>
.month-root,
.month-scene {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  border-radius: var(--window-radius);
}

.month-root {
  position: relative;
  background-color: rgb(var(--bg-color) / var(--window-opacity));
}

.month-scene {
  position: relative;
  z-index: var(--z-local-content);
  display: flex;
  flex-direction: column;
  transition: filter 180ms ease;
}

.month-content {
  flex: 1;
  min-height: 0;
}

.month-wallpaper {
  position: absolute;
  z-index: var(--z-local-base);
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}

.month-wallpaper-image {
  position: absolute;
  inset: calc(var(--wallpaper-blur) * -2);
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  filter: blur(var(--wallpaper-blur));
}

.month-wallpaper-enter-active,
.month-wallpaper-leave-active {
  transition: opacity 180ms ease;
}

.month-wallpaper-enter-from,
.month-wallpaper-leave-to {
  opacity: 0;
}
</style>
