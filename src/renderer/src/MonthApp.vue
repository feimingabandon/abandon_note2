<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppTitlebar from './components/system/AppTitlebar.vue'
import TitlebarActions from './components/system/TitlebarActions.vue'
import ResizeHandles from './components/system/ResizeHandles.vue'
import SettingsPanel from './components/system/SettingsPanel.vue'
import MessageToast from './components/system/MessageToast.vue'
import MonthWorkspace from './components/month/MonthWorkspace.vue'
import UpdateDialog from './components/system/UpdateDialog.vue'
import RemoteNoticeDialog from './components/system/RemoteNoticeDialog.vue'
import FirstUseNoticeDialog from './components/system/FirstUseNoticeDialog.vue'
import HolidayDataNoticeDialog from './components/system/HolidayDataNoticeDialog.vue'
import DailyReportDialog from './components/report/DailyReportDialog.vue'
import DailyReportButton from './components/report/DailyReportButton.vue'
import TemplatePage from './components/template/TemplatePage.vue'
import HelpPage from './components/help/HelpPage.vue'
import { createMessageProvider } from './composables/useMessage.js'
import { useSlidingWorkspace } from './composables/useSlidingWorkspace.js'
import { useTodayKey } from './composables/useTodayKey.js'
import { applySettingsSnapshot } from './utils/applySettingsSnapshot.js'
import { retainModalBlur } from './utils/modalBlur.js'
import {
  createDefaultSettings,
  FIRST_USE_NOTICE_VERSION,
  VIEW_MODES
} from '../../shared/settings-schema.js'

const props = defineProps({
  viewMode: {
    type: String,
    default: VIEW_MODES.MONTH,
    validator: (value) => value === VIEW_MODES.MONTH || value === VIEW_MODES.WEEK
  }
})
const isWeekView = computed(() => props.viewMode === VIEW_MODES.WEEK)
const viewLabel = computed(() => (isWeekView.value ? '周视图' : '月视图'))
const defaults = createDefaultSettings(props.viewMode)
const { showMessage } = createMessageProvider()
const locked = ref(defaults.window.lockState)
const alwaysOnTop = ref(defaults.window.alwaysOnTop)
const titlebarStyle = ref(defaults.appearance.titlebarStyle)
const showSettings = ref(false)
const showUpdateDialog = ref(false)
const showRemoteNoticeDialog = ref(false)
const showFirstUseNotice = ref(false)
const showHolidayDataNoticeDialog = ref(false)
const showDailyReportDialog = ref(false)
const templatePanelRef = ref(null)
const helpPanelRef = ref(null)
const templateWorkspace = useSlidingWorkspace({ getElement: () => templatePanelRef.value })
const helpWorkspace = useSlidingWorkspace({ getElement: () => helpPanelRef.value })
const {
  rendered: templatesRendered,
  active: templatePanelActive,
  phase: templatePhase,
  interactive: templateInteractive,
  close: closeTemplateWorkspace,
  onTransitionEnd: onTemplateTransitionEnd,
  onTransitionCancel: onTemplateTransitionCancel
} = templateWorkspace
const {
  rendered: helpRendered,
  active: helpPanelActive,
  phase: helpPhase,
  interactive: helpInteractive,
  close: closeHelpWorkspace,
  onTransitionEnd: onHelpTransitionEnd,
  onTransitionCancel: onHelpTransitionCancel
} = helpWorkspace
const pendingHolidayDataNotice = ref(null)
const holidayNoticeTodayKey = useTodayKey()
const calendarBusinessModalOpen = ref(false)
const calendarWorkspaceRef = ref(null)
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
let resolveCalendarWorkspaceReady = null
const calendarWorkspaceReady = new Promise((resolve) => {
  resolveCalendarWorkspaceReady = resolve
})

function onCalendarWorkspaceReady() {
  resolveCalendarWorkspaceReady?.()
  resolveCalendarWorkspaceReady = null
}

function openSettings() {
  closeTemplates()
  closeHelp()
  if (!releaseSettingsBackgroundBlur) releaseSettingsBackgroundBlur = retainModalBlur()
  showSettings.value = true
}

function openDailyReport() {
  closeTemplates()
  closeHelp()
  showDailyReportDialog.value = true
}

function openTemplates() {
  closeHelp()
  void templateWorkspace.open()
}

function closeTemplates() {
  closeTemplateWorkspace()
}

function toggleTemplates() {
  if (templatePhase.value === 'closed' || templatePhase.value === 'closing') openTemplates()
  else closeTemplates()
}

function openHelp() {
  closeTemplates()
  void helpWorkspace.open()
}

function closeHelp() {
  closeHelpWorkspace()
}

function toggleHelp() {
  if (helpPhase.value === 'closed' || helpPhase.value === 'closing') void openHelp()
  else closeHelpWorkspace()
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
    console.warn(`[MonthApp] 读取${viewLabel.value}壁纸失败:`, error)
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

function revealFirstUseNoticeFromSnapshot(snapshot) {
  const pending = (snapshot?.values?.onboarding?.noticeVersion ?? 0) < FIRST_USE_NOTICE_VERSION
  if (!pending || showFirstUseNotice.value) return

  showUpdateDialog.value = false
  showRemoteNoticeDialog.value = false
  showHolidayDataNoticeDialog.value = false
  showDailyReportDialog.value = false
  showFirstUseNotice.value = true
}

async function loadPendingRemoteNotices({ show = false } = {}) {
  try {
    pendingRemoteNotices.value = await window.api.listPendingRemoteNotices()
    if (show && !showFirstUseNotice.value && pendingRemoteNotices.value.length) {
      showRemoteNoticeDialog.value = true
    }
  } catch (error) {
    console.warn('[MonthApp] 读取未确认通知失败:', error)
  }
}

function maybeShowHolidayDataNotice() {
  if (
    pendingHolidayDataNotice.value?.required &&
    !showFirstUseNotice.value &&
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

function showNextStartupNotice() {
  if (pendingRemoteNotices.value.length) {
    showRemoteNoticeDialog.value = true
    return
  }
  maybeShowHolidayDataNotice()
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
  setTimeout(showNextStartupNotice, 240)
}

async function openNoteFromNotification(payload) {
  if (showFirstUseNotice.value) return
  const noteId = Number(payload?.id)
  if (!Number.isInteger(noteId) || noteId <= 0) return
  const closingModal = showSettings.value || showUpdateDialog.value || showRemoteNoticeDialog.value
  showSettings.value = false
  releaseSettingsBlur()
  showUpdateDialog.value = false
  showRemoteNoticeDialog.value = false
  await new Promise((resolve) => requestAnimationFrame(resolve))
  if (closingModal) await new Promise((resolve) => setTimeout(resolve, 240))
  await calendarWorkspaceRef.value?.openNote?.(noteId)
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
      downloadAvailable: false,
      releaseLinks: null,
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
    const snapshot = await window.api.getSettingsSnapshot()
    applySnapshot(snapshot)
    showFirstUseNotice.value =
      (snapshot?.values?.onboarding?.noticeVersion ?? 0) < FIRST_USE_NOTICE_VERSION
  } catch (error) {
    applySnapshot({ values: defaults })
    showFirstUseNotice.value = true
    console.warn(`[MonthApp] 读取设置失败，使用${viewLabel.value}默认值:`, error)
  }
  stopSettingsListener = window.api.onSettingsChanged?.((snapshot) => {
    applySnapshot(snapshot)
    revealFirstUseNoticeFromSnapshot(snapshot)
  })
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
  await calendarWorkspaceReady
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
  <div class="month-root app-bg" :class="{ 'is-week-view': isWeekView }">
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
      :class="{ 'is-ui-background-blurred': showSettings || calendarBusinessModalOpen }"
      :inert="
        showSettings ||
        calendarBusinessModalOpen ||
        showFirstUseNotice ||
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
          <DailyReportButton month-view @open="openDailyReport" />
          <button
            class="titlebar-btn titlebar-btn-template month-titlebar-btn"
            :class="{ 'is-active': templatePanelActive }"
            :title="templatePanelActive ? '关闭循环模板' : '打开循环模板'"
            aria-controls="template-workspace"
            :aria-expanded="templatePanelActive"
            @click="toggleTemplates"
          >
            <img class="btn-icon" src="@/resources/icons/recurrence.svg" alt="循环模板" />
          </button>
          <button
            class="titlebar-btn titlebar-btn-settings month-titlebar-btn"
            title="设置"
            @click="openSettings"
          >
            <img class="btn-icon" src="@/resources/icons/settings.png" alt="设置" />
          </button>
          <button
            class="titlebar-btn titlebar-btn-help month-titlebar-btn"
            :class="{ 'is-active': helpPanelActive }"
            :title="helpPanelActive ? '关闭帮助' : '帮助'"
            aria-controls="help-workspace"
            :aria-expanded="helpPanelActive"
            @click="toggleHelp"
          >
            <img class="btn-icon" src="@/resources/icons/help.svg" alt="帮助" />
          </button>
        </TitlebarActions>
      </AppTitlebar>
      <div class="month-content-stage">
        <main
          class="month-content"
          :class="{ 'is-ui-background-blurred': templateInteractive || helpInteractive }"
          :inert="templateInteractive || helpInteractive"
          :aria-label="`${viewLabel}内容区域`"
        >
          <MonthWorkspace
            ref="calendarWorkspaceRef"
            :view-mode="viewMode"
            @modal-state-change="calendarBusinessModalOpen = $event"
            @ready="onCalendarWorkspaceReady"
          />
        </main>

        <div
          v-if="templatesRendered"
          class="month-template-wrapper"
          :class="{ 'is-interactive': templateInteractive }"
        >
          <div
            id="template-workspace"
            ref="templatePanelRef"
            class="month-template-panel"
            :class="{ active: templatePanelActive }"
            role="region"
            aria-label="循环便签模板设置"
            @transitionend="onTemplateTransitionEnd"
            @transitioncancel="onTemplateTransitionCancel"
          >
            <TemplatePage />
          </div>
        </div>

        <div
          v-if="helpRendered"
          class="month-help-wrapper"
          :class="{ 'is-interactive': helpInteractive }"
        >
          <div
            id="help-workspace"
            ref="helpPanelRef"
            class="month-help-panel"
            :class="{ active: helpPanelActive }"
            role="region"
            :aria-label="`${viewLabel}帮助中心`"
            @transitionend="onHelpTransitionEnd"
            @transitioncancel="onHelpTransitionCancel"
          >
            <HelpPage :view-mode="viewMode" />
          </div>
        </div>
      </div>
    </div>

    <SettingsPanel
      v-if="showSettings"
      v-model:visible="showSettings"
      :view-mode="viewMode"
      @blur-release="releaseSettingsBlur"
      @check-update="checkForUpdates"
    />
    <FirstUseNoticeDialog
      v-if="showFirstUseNotice"
      :visible="showFirstUseNotice"
      @completed="onFirstUseCompleted"
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
  transition: filter 180ms ease;
}

.month-content-stage {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.month-template-wrapper,
.month-help-wrapper {
  position: absolute;
  z-index: var(--z-global-workspace);
  inset: 0;
  overflow: hidden;
  border-radius: var(--window-radius);
  pointer-events: none;
}

.month-template-wrapper.is-interactive,
.month-help-wrapper.is-interactive {
  pointer-events: auto;
}

.month-template-panel,
.month-help-panel {
  position: absolute;
  inset: 0;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: inherit;
  background-color: var(--surface-panel);
  box-shadow: -12px 0 36px rgba(0, 0, 0, 0.16);
  transform: translateX(100%);
  transition: transform 360ms var(--ease-standard);
  will-change: transform;
}

.month-template-panel.active,
.month-help-panel.active {
  transform: translateX(0);
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
