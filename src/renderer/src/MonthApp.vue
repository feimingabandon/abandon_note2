<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import AppTitlebar from './components/system/AppTitlebar.vue'
import ResizeHandles from './components/system/ResizeHandles.vue'
import SettingsPanel from './components/system/SettingsPanel.vue'
import MessageToast from './components/system/MessageToast.vue'
import UpdateDialog from './components/system/UpdateDialog.vue'
import RemoteNoticeDialog from './components/system/RemoteNoticeDialog.vue'
import { createMessageProvider } from './composables/useMessage.js'
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
    if (sequence !== wallpaperSequence || !data) return
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

function onRemoteNoticeAcknowledged(id) {
  pendingRemoteNotices.value = pendingRemoteNotices.value.filter((notice) => notice.id !== id)
  if (!pendingRemoteNotices.value.length) showRemoteNoticeDialog.value = false
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
  document.addEventListener('mouseenter', onMouseEnter)
  document.addEventListener('mouseleave', onMouseLeave)
  await loadPendingRemoteNotices({ show: true })
  window.api.rendererReady()
})

onUnmounted(() => {
  stopSettingsListener?.()
  stopAppMessageListener?.()
  stopRemoteNoticesListener?.()
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
      :class="{ 'is-ui-background-blurred': showSettings }"
      :inert="showSettings || showUpdateDialog || showRemoteNoticeDialog"
    >
      <ResizeHandles :locked="locked" />
      <AppTitlebar
        v-model:locked="locked"
        v-model:always-on-top="alwaysOnTop"
        title="月视图"
        :style-variant="titlebarStyle"
      >
        <div class="month-titlebar-actions" :class="`month-titlebar-actions--${titlebarStyle}`">
          <button class="month-titlebar-btn" title="设置" @click="openSettings">
            <img src="@/resources/icons/settings.png" alt="设置" />
          </button>
          <button class="month-titlebar-btn" title="帮助（暂未开放）" aria-disabled="true">
            <img src="@/resources/icons/help.svg" alt="帮助" />
          </button>
        </div>
      </AppTitlebar>
      <main class="month-content" aria-label="月视图内容区域" />
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
      @close="showRemoteNoticeDialog = false"
      @acknowledged="onRemoteNoticeAcknowledged"
    />
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
  z-index: 1;
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
  z-index: 0;
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

.month-titlebar-actions {
  display: flex;
  gap: 8rem;
}

.month-titlebar-btn {
  width: 28rem;
  height: 28rem;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8rem;
  color: var(--text-color);
  background: color-mix(in srgb, var(--text-color) 7%, transparent);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}

.month-titlebar-btn:hover {
  background: color-mix(in srgb, var(--text-color) 14%, transparent);
}

.month-titlebar-btn:active {
  transform: scale(0.92);
}

.month-titlebar-btn img {
  width: 16rem;
  height: 16rem;
  opacity: 0.78;
}

.month-titlebar-actions--microsoft {
  flex-direction: row-reverse;
}
</style>
