<script setup>
/**
 * App.vue — 应用根组件
 *
 * 职责：
 *   1. 在组件挂载时从数据库加载持久化的用户设置（字体缩放、玻璃态参数等）
 *   2. 将设置值应用为 CSS 自定义属性，驱动全局玻璃态样式
 *   3. 渲染完成后通知主进程显示窗口（避免白屏闪烁）
 *
 * 组件结构：
 *   .app-root（根容器，flex 纵向布局，充满视口）
 *     ├── ResizeHandles（八方向缩放手柄，覆盖在最上层）
 *     ├── AppTitlebar（可切换 Apple / Microsoft 视觉的自定义标题栏）
 *     └── main.content（主内容区域，可滚动）
 */

import { nextTick, ref, onMounted, onUnmounted } from 'vue'
import AppTitlebar from './components/system/AppTitlebar.vue'
import TitlebarActions from './components/system/TitlebarActions.vue'
import ResizeHandles from './components/system/ResizeHandles.vue' // 自定义窗口缩放手柄
import SettingsPanel from './components/system/SettingsPanel.vue' // 底部弹出式设置面板
import MessageToast from './components/system/MessageToast.vue'
import UpdateDialog from './components/system/UpdateDialog.vue'
import RemoteNoticeDialog from './components/system/RemoteNoticeDialog.vue'
import NoteList from './components/list/NoteList.vue'
import NoteEditor from './components/note/NoteEditor.vue'
import ActionBar from './components/list/ActionBar.vue'
import TemplatePage from './components/template/TemplatePage.vue'
import HelpPage from './components/help/HelpPage.vue'
import { createMessageProvider } from './composables/useMessage.js' // 消息能力注册
import { applySettingsSnapshot } from './utils/applySettingsSnapshot.js'
import { retainModalBlur } from './utils/modalBlur.js'
import {
  captureFocusedElement,
  focusModal,
  restoreFocusedElement,
  trapModalTab
} from './utils/modalFocus.js'
import { DEFAULT_SETTINGS } from '../../shared/settings-schema.js'

// 注册全局应用内消息通知能力（子孙组件通过 useMessage() 获取）
const { showMessage } = createMessageProvider()

/** 设置面板显隐状态 */
const showSettings = ref(false)
const showUpdateDialog = ref(false)
const showRemoteNoticeDialog = ref(false)
const pendingRemoteNotices = ref([])
const updateChecking = ref(false)
const updateResult = ref(null)
const UPDATE_CHECKING_MIN_DURATION_MS = 500
const templatesRendered = ref(false)
const templatePanelActive = ref(false)
const templateBlurActive = ref(false)
const templatePhase = ref('closed') // closed | opening | open | closing
const templatePanelRef = ref(null)
// 帮助页复用与模版页完全一致的滑入状态机，二者互斥（同一时刻只开一个）。
const helpRendered = ref(false)
const helpPanelActive = ref(false)
const helpBlurActive = ref(false)
const helpPhase = ref('closed') // closed | opening | open | closing
const helpPanelRef = ref(null)
let releaseSettingsBackgroundBlur = null
let releaseEditorBackgroundBlur = null

async function loadPendingRemoteNotices({ show = false } = {}) {
  try {
    pendingRemoteNotices.value = await window.api.listPendingRemoteNotices()
    if (show && pendingRemoteNotices.value.length) showRemoteNoticeDialog.value = true
  } catch (error) {
    console.warn('[App] 读取未确认通知失败:', error)
  }
}

function onRemoteNoticeAcknowledged(id) {
  pendingRemoteNotices.value = pendingRemoteNotices.value.filter((notice) => notice.id !== id)
  if (!pendingRemoteNotices.value.length) showRemoteNoticeDialog.value = false
}

function openSettings() {
  if (!releaseSettingsBackgroundBlur) releaseSettingsBackgroundBlur = retainModalBlur()
  showSettings.value = true
}

function releaseSettingsBlur() {
  releaseSettingsBackgroundBlur?.()
  releaseSettingsBackgroundBlur = null
}

async function checkForUpdates({ showResult = true } = {}) {
  if (updateChecking.value) return
  const startedAt = performance.now()
  updateChecking.value = true
  if (showResult) showUpdateDialog.value = true
  try {
    updateResult.value = await window.api.checkForUpdate()
    if (!showResult && updateResult.value?.status === 'available') {
      showUpdateDialog.value = true
    }
  } catch (error) {
    console.error('[App] 检查更新失败:', error)
    const appInfo = await window.api.getAppInfo().catch((infoError) => {
      console.warn('[App] 更新检查失败后读取应用版本也失败:', infoError)
      return null
    })
    updateResult.value = {
      status: 'error',
      currentVersion: appInfo?.version || '未知',
      platform: window.api.runtimeCapabilities?.platform,
      artifactName: null,
      onlineDownloadSupported: false,
      error: `检查更新失败：${error.message}`
    }
    if (showResult) showUpdateDialog.value = true
  } finally {
    if (showResult) {
      const remaining = UPDATE_CHECKING_MIN_DURATION_MS - (performance.now() - startedAt)
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining))
      }
    }
    updateChecking.value = false
  }
}

function openUpdateDialog() {
  checkForUpdates({ showResult: true })
}

async function openTemplates() {
  if (templatePhase.value === 'opening' || templatePhase.value === 'open') return
  closeHelp()
  templatePhase.value = 'opening'
  templateBlurActive.value = true
  if (!templatesRendered.value) {
    templatesRendered.value = true
    await nextTick()
    // 明确提交面板的初始位置，避免浏览器把挂载和进入态合并为同一帧。
    void templatePanelRef.value?.offsetWidth
  }
  if (templatePhase.value !== 'opening') return
  templatePanelActive.value = true
}

function closeTemplates() {
  if (templatePhase.value === 'closed' || templatePhase.value === 'closing') return
  templatePhase.value = 'closing'
  templatePanelActive.value = false
  templateBlurActive.value = false
}

function onTemplateTransitionEnd(event) {
  if (event.target !== templatePanelRef.value || event.propertyName !== 'transform') return
  if (templatePhase.value === 'opening' && templatePanelActive.value) {
    templatePhase.value = 'open'
  } else if (templatePhase.value === 'closing' && !templatePanelActive.value) {
    templatesRendered.value = false
    templatePhase.value = 'closed'
  }
}

function toggleTemplates() {
  if (templatePhase.value === 'closed' || templatePhase.value === 'closing') openTemplates()
  else closeTemplates()
}

async function openHelp() {
  if (helpPhase.value === 'opening' || helpPhase.value === 'open') return
  closeTemplates()
  helpPhase.value = 'opening'
  helpBlurActive.value = true
  if (!helpRendered.value) {
    helpRendered.value = true
    await nextTick()
    // 明确提交面板初始位置，避免挂载与进入态被合并到同一帧。
    void helpPanelRef.value?.offsetWidth
  }
  if (helpPhase.value !== 'opening') return
  helpPanelActive.value = true
}

function closeHelp() {
  if (helpPhase.value === 'closed' || helpPhase.value === 'closing') return
  helpPhase.value = 'closing'
  helpPanelActive.value = false
  helpBlurActive.value = false
}

function onHelpTransitionEnd(event) {
  if (event.target !== helpPanelRef.value || event.propertyName !== 'transform') return
  if (helpPhase.value === 'opening' && helpPanelActive.value) {
    helpPhase.value = 'open'
  } else if (helpPhase.value === 'closing' && !helpPanelActive.value) {
    helpRendered.value = false
    helpPhase.value = 'closed'
  }
}

function toggleHelp() {
  if (helpPhase.value === 'closed' || helpPhase.value === 'closing') openHelp()
  else closeHelp()
}

/** 当前选中的便签 */
const selectedNote = ref(null)
const noteEditorRef = ref(null)
const noteEditorOverlayRef = ref(null)
let noteEditorPreviousFocus = null

/** NoteList 引用 */
const noteListRef = ref(null)
/** ActionBar 引用：编辑保存后同步刷新仍处于会话中的搜索结果。 */
const actionBarRef = ref(null)

/** 窗口锁定状态 */
const locked = ref(DEFAULT_SETTINGS.window.lockState)

/** 窗口置顶状态 */
const alwaysOnTop = ref(DEFAULT_SETTINGS.window.alwaysOnTop)

/** 自定义导航栏视觉风格；窗口操作逻辑不随风格变化。 */
const titlebarStyle = ref(DEFAULT_SETTINGS.appearance.titlebarStyle)

/** 主页面壁纸只在原生毛玻璃未实际运行时进入渲染树。 */
const wallpaperUrl = ref('')
const wallpaperVisible = ref(false)
const wallpaperBlurRadius = ref(DEFAULT_SETTINGS.wallpaper.blurRadius)
const wallpaperRenderKey = ref(null)
let wallpaperLoadSequence = 0
let loadedWallpaperId = null
let pendingWallpaperId = null
let pendingWallpaperLoad = null
let wallpaperReleaseTimer = null

let stopSettingsListener = null
let stopNotesChangedListener = null
let stopAppMessageListener = null
let stopNotificationOpenListener = null
let stopRemoteNoticesListener = null
let startupUpdateTimer = null

function applyAppSettingsSnapshot(snapshot) {
  applySettingsSnapshot(snapshot)
  titlebarStyle.value =
    snapshot?.values?.appearance?.titlebarStyle ?? DEFAULT_SETTINGS.appearance.titlebarStyle
  const windowSettings = snapshot?.values?.window
  if (windowSettings) {
    locked.value = windowSettings.lockState
    alwaysOnTop.value = windowSettings.alwaysOnTop
  }
  syncWallpaperFromSnapshot(snapshot)
}

async function syncWallpaperFromSnapshot(snapshot) {
  const wallpaper = snapshot?.values?.wallpaper || DEFAULT_SETTINGS.wallpaper
  const glassActive = Boolean(snapshot?.runtime?.blur?.effectiveEnabled)
  wallpaperBlurRadius.value = wallpaper.blurRadius
  const shouldShow = Boolean(wallpaper.enabled && wallpaper.activeId && !glassActive)
  const sequence = ++wallpaperLoadSequence
  if (!shouldShow) {
    wallpaperVisible.value = false
    clearTimeout(wallpaperReleaseTimer)
    wallpaperReleaseTimer = setTimeout(() => {
      if (sequence !== wallpaperLoadSequence || wallpaperVisible.value) return
      wallpaperUrl.value = ''
      wallpaperRenderKey.value = null
      loadedWallpaperId = null
    }, 220)
    return
  }

  clearTimeout(wallpaperReleaseTimer)
  const requestedId = Number(wallpaper.activeId)
  if (loadedWallpaperId === requestedId && wallpaperUrl.value) {
    wallpaperVisible.value = true
    return
  }

  try {
    if (pendingWallpaperId !== requestedId || !pendingWallpaperLoad) {
      pendingWallpaperId = requestedId
      pendingWallpaperLoad = window.api.getWallpaperData(requestedId, false)
    }
    const currentLoad = pendingWallpaperLoad
    const data = await currentLoad
    if (currentLoad === pendingWallpaperLoad) {
      pendingWallpaperId = null
      pendingWallpaperLoad = null
    }
    if (sequence !== wallpaperLoadSequence) return
    if (!data) {
      wallpaperVisible.value = false
      return
    }
    wallpaperUrl.value = data
    wallpaperRenderKey.value = requestedId
    loadedWallpaperId = requestedId
    wallpaperVisible.value = true
  } catch (error) {
    if (pendingWallpaperId === requestedId) {
      pendingWallpaperId = null
      pendingWallpaperLoad = null
    }
    if (sequence === wallpaperLoadSequence) wallpaperVisible.value = false
    console.warn('[App] 读取主页面壁纸失败:', error)
  }
}

onMounted(async () => {
  try {
    // 主进程始终返回“数据库值覆盖共享默认值”后的完整快照。
    const snapshot = await window.api.getSettingsSnapshot()
    applyAppSettingsSnapshot(snapshot)
  } catch (err) {
    // IPC 异常时同样从唯一 schema 回退，不依赖 tokens.css 中的旧值。
    applyAppSettingsSnapshot({ values: DEFAULT_SETTINGS })
    console.warn('[App] 读取设置快照失败，使用共享默认值:', err)
  }

  // 主进程是设置权威源；其他入口修改或重置设置时统一刷新实际 CSS 效果。
  stopSettingsListener = window.api.onSettingsChanged?.((snapshot) => {
    applyAppSettingsSnapshot(snapshot)
  })
  stopNotesChangedListener = window.api.onNotesChanged?.((event) => {
    if (event?.reason === 'note-data-cleared') selectedNote.value = null
  })
  stopNotificationOpenListener = window.api.onNotificationOpenNote?.((payload) => {
    void openNoteFromNotification(payload)
  })

  // 主进程系统通知发送失败（如 macOS 未签名）时降级为应用内消息条。
  stopAppMessageListener = window.api.onAppMessage?.((payload) => {
    if (!payload?.text) return
    showMessage(payload.type || 'warning', payload.text, payload.duration ?? 2500)
  })
  stopRemoteNoticesListener = window.api.onRemoteNoticesChanged?.(() => {
    void loadPendingRemoteNotices({ show: true })
  })
  await loadPendingRemoteNotices({ show: true })

  // 通知主进程渲染已完成，可以安全地显示窗口了
  // 主进程收到后会调用 mainWindow.show()
  window.api.rendererReady()
  // 启动检查只在确有新版本时打扰用户；网络失败可在设置页手动查看和重试。
  startupUpdateTimer = setTimeout(() => {
    startupUpdateTimer = null
    checkForUpdates({ showResult: false })
  }, 1200)
})

// ---- 贴边隐藏：鼠标悬停检测 ----
const onMouseEnter = () => window.api.windowHover(true)
const onMouseLeave = () => window.api.windowHover(false)
document.addEventListener('mouseenter', onMouseEnter)
document.addEventListener('mouseleave', onMouseLeave)
// ---- 便签交互 ----
async function onEditNote(note) {
  if (!note?.id) return
  const openingFresh = !selectedNote.value
  if (openingFresh) noteEditorPreviousFocus = captureFocusedElement()
  // 列表项是摘要数据；打开编辑器前重新读取完整记录，避免编辑旧标签或附件数据。
  try {
    const fullNote = await window.api.getNote(note.id)
    if (!fullNote) throw new Error('便签不存在或已删除')
    if (!releaseEditorBackgroundBlur) releaseEditorBackgroundBlur = retainModalBlur()
    selectedNote.value = fullNote
    await nextTick()
    focusModal(noteEditorOverlayRef.value)
  } catch (error) {
    if (openingFresh) {
      restoreFocusedElement(noteEditorPreviousFocus)
      noteEditorPreviousFocus = null
    }
    showMessage('error', error.message || '无法打开便签')
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
  closeTemplates()
  closeHelp()
  await nextTick()
  if (closingModal) await new Promise((resolve) => setTimeout(resolve, 240))
  await onEditNote({ id: noteId })
}

function onCloseEditor() {
  selectedNote.value = null
}

function releaseEditorBlur() {
  releaseEditorBackgroundBlur?.()
  releaseEditorBackgroundBlur = null
}

function finishEditorClose() {
  releaseEditorBlur()
  restoreFocusedElement(noteEditorPreviousFocus)
  noteEditorPreviousFocus = null
}

function onEditorKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    requestCloseEditor()
    return
  }
  trapModalTab(event, noteEditorOverlayRef.value)
}

function requestCloseEditor() {
  noteEditorRef.value?.requestClose?.()
}

async function onNoteSaved(updated) {
  if (updated?.id) await noteListRef.value?.refreshOne(updated)
  actionBarRef.value?.refreshSearch?.()
  onCloseEditor()
}

async function onNoteUpdated(updated) {
  if (updated) selectedNote.value = updated
  if (updated?.id) await noteListRef.value?.refreshOne(updated)
  actionBarRef.value?.refreshSearch?.()
}

async function onCreateNote() {
  noteListRef.value?.refresh()
  actionBarRef.value?.refreshSearch?.()
}

onUnmounted(() => {
  stopSettingsListener?.()
  stopNotesChangedListener?.()
  stopAppMessageListener?.()
  stopNotificationOpenListener?.()
  stopRemoteNoticesListener?.()
  document.removeEventListener('mouseenter', onMouseEnter)
  document.removeEventListener('mouseleave', onMouseLeave)
  releaseSettingsBlur()
  releaseEditorBlur()
  if (startupUpdateTimer) clearTimeout(startupUpdateTimer)
  clearTimeout(wallpaperReleaseTimer)
})
</script>

<template>
  <!-- 应用根容器：同时承载背景样式（.app-bg）和布局（.app-root） -->
  <div class="app-root app-bg">
    <Transition name="app-wallpaper">
      <div
        v-if="wallpaperVisible"
        :key="wallpaperRenderKey"
        class="app-wallpaper"
        aria-hidden="true"
      >
        <div
          class="app-wallpaper-image"
          :style="{
            backgroundImage: `url(${wallpaperUrl})`,
            '--wallpaper-blur': `${wallpaperBlurRadius}px`
          }"
        />
      </div>
    </Transition>
    <!-- 设置打开时，底层场景不可点击且不可获取键盘焦点。 -->
    <div
      class="app-scene"
      :inert="showSettings || !!selectedNote || showUpdateDialog || showRemoteNoticeDialog"
    >
      <!-- 自定义缩放手柄，absolute 定位覆盖整个窗口，z-index 最高 -->
      <ResizeHandles :locked="locked" />
      <!-- 同一套窗口功能通过 style 属性切换 Apple / Microsoft 视觉。 -->
      <AppTitlebar
        v-model:locked="locked"
        v-model:always-on-top="alwaysOnTop"
        :style-variant="titlebarStyle"
      >
        <!-- 设置和帮助按钮组 -->
        <TitlebarActions :style-variant="titlebarStyle">
          <button
            class="titlebar-btn titlebar-btn-template"
            :class="{ 'is-active': templatePanelActive }"
            :title="templatePanelActive ? '关闭循环模板' : '打开循环模板'"
            aria-controls="template-workspace"
            :aria-expanded="templatePanelActive"
            @click="toggleTemplates"
          >
            <img class="btn-icon" src="@/resources/icons/recurrence.svg" alt="循环模板" />
          </button>
          <!-- 设置按钮 -->
          <button class="titlebar-btn titlebar-btn-settings" title="设置" @click="openSettings">
            <img class="btn-icon" src="@/resources/icons/settings.png" alt="设置" />
          </button>
          <!-- 帮助按钮：从右滑入帮助中心（与循环模版互斥） -->
          <button
            class="titlebar-btn titlebar-btn-help"
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
      <div class="app-content-stage">
        <!-- 主内容区域，flex:1 占据导航栏下方空间。 -->
        <main
          class="content"
          :class="{ 'is-ui-background-blurred': templateBlurActive || helpBlurActive }"
          :inert="templatesRendered || helpRendered"
        >
          <ActionBar
            ref="actionBarRef"
            class="app-search"
            @create="onCreateNote"
            @edit="onEditNote"
          />
          <NoteList ref="noteListRef" class="app-list" @edit="onEditNote" @create="onCreateNote" />
        </main>

        <div v-if="templatesRendered" class="app-template-wrapper">
          <div
            id="template-workspace"
            ref="templatePanelRef"
            class="app-template-panel"
            :class="{ active: templatePanelActive }"
            role="region"
            aria-label="循环便签模版设置"
            @transitionend="onTemplateTransitionEnd"
          >
            <TemplatePage />
          </div>
        </div>

        <div v-if="helpRendered" class="app-help-wrapper">
          <div
            id="help-workspace"
            ref="helpPanelRef"
            class="app-help-panel"
            :class="{ active: helpPanelActive }"
            role="region"
            aria-label="帮助中心"
            @transitionend="onHelpTransitionEnd"
          >
            <HelpPage />
          </div>
        </div>
      </div>
    </div>

    <!-- 便签编辑弹窗：复用 NoteEditor，底层列表保持可见但不可交互。 -->
    <Transition name="app-editor-modal" @after-leave="finishEditorClose">
      <div
        v-if="selectedNote"
        ref="noteEditorOverlayRef"
        class="app-editor-overlay"
        data-modal-layer="note-editor"
        role="presentation"
        tabindex="-1"
        @keydown="onEditorKeydown"
      >
        <section class="app-editor-dialog" role="dialog" aria-modal="true" aria-label="修改便签">
          <header class="app-editor-header">
            <span>修改便签</span>
            <button
              class="app-editor-close"
              aria-label="关闭编辑"
              title="关闭"
              @click="requestCloseEditor"
            >
              ×
            </button>
          </header>
          <NoteEditor
            ref="noteEditorRef"
            :key="selectedNote.id"
            :note="selectedNote"
            class="app-editor"
            @saved="onNoteSaved"
            @updated="onNoteUpdated"
            @cancel="onCloseEditor"
          />
        </section>
      </div>
    </Transition>

    <!-- 设置面板关闭动画结束后将 visible 置为 false，随后真正卸载组件。 -->
    <SettingsPanel
      v-if="showSettings"
      v-model:visible="showSettings"
      @blur-release="releaseSettingsBlur"
      @check-update="openUpdateDialog"
    />

    <UpdateDialog
      v-model:visible="showUpdateDialog"
      :checking="updateChecking"
      :result="updateResult"
      @retry="checkForUpdates({ showResult: true })"
    />

    <RemoteNoticeDialog
      v-if="showRemoteNoticeDialog && pendingRemoteNotices.length"
      :notices="pendingRemoteNotices"
      @close="showRemoteNoticeDialog = false"
      @acknowledged="onRemoteNoticeAcknowledged"
    />

    <!-- 应用内消息弹窗（Apple 风格 Toast，固定顶部居中） -->
    <MessageToast />
  </div>
</template>

<style scoped>
/* 根容器：flex 纵向布局，充满整个视口高度 */
.app-root {
  position: relative; /* 为 ResizeHandles 的 absolute 定位提供参考 */
  display: flex;
  flex-direction: column; /* 纵向排列：标题栏 → 内容区 */
  height: 100vh; /* 占满视口高度 */
  border-radius: var(--window-radius); /* 用户可调的圆角 */
  -electron-corner-smoothing: system-ui; /* macOS 连续曲率圆角，Win/Linux 自动为 0% */
  overflow: hidden; /* 裁剪超出圆角的内容 */
  box-shadow: none; /* 主窗口主动取消阴影 */

  /* 主窗口不使用 CSS 模糊（OS 已提供毛玻璃），覆写 .app-bg 的 backdrop-filter */
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;

  /* 主窗口独立透明度（--window-opacity），与弹窗的 --popup-opacity 分离 */
  background-color: rgb(var(--bg-color) / var(--window-opacity));
}

.app-wallpaper {
  position: absolute;
  z-index: var(--z-local-base);
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}
.app-wallpaper-image {
  position: absolute;
  inset: calc(var(--wallpaper-blur) * -2);
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  filter: blur(var(--wallpaper-blur));
  transition:
    inset 180ms ease,
    filter 180ms ease;
  will-change: filter;
}
.app-wallpaper-enter-active,
.app-wallpaper-leave-active {
  transition: opacity 180ms ease;
}
.app-wallpaper-enter-from,
.app-wallpaper-leave-to {
  opacity: 0;
}

/* 主界面独立成场景，便于模态设置面板统一隔离交互。 */
.app-scene {
  position: relative;
  z-index: var(--z-local-content);
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  transition: filter 100ms ease-out;
}

/* 主内容区域 */
.app-content-stage {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.content {
  flex: 1; /* 占据标题栏之外的所有剩余空间 */
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 自身不滚动，滚动权交给内部的便签列表 */
  padding: 16rem; /* 内边距，统一使用 rem 跟随窗口缩放 */
  transition: filter 180ms ease-out;
}
.app-template-wrapper {
  position: absolute;
  z-index: var(--z-global-workspace);
  inset: 0;
  overflow: hidden;
  border-radius: var(--window-radius);
  pointer-events: auto;
}
.app-template-panel {
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
.app-template-panel.active {
  transform: translateX(0);
}

/* 帮助面板与模版面板互斥，共用同一工作区层级。 */
.app-help-wrapper {
  position: absolute;
  z-index: var(--z-global-workspace);
  inset: 0;
  overflow: hidden;
  border-radius: var(--window-radius);
  pointer-events: auto;
}
.app-help-panel {
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
.app-help-panel.active {
  transform: translateX(0);
}
/* 搜索框间距 */
.app-search {
  flex-shrink: 0;
}

/* 列表弹性填充 */
.app-list,
.app-editor {
  flex: 1;
  min-height: 0;
}

.app-editor-overlay {
  position: absolute;
  z-index: var(--z-global-editor);
  inset: 0;
  display: grid;
  place-items: center;
  padding: 22rem;
  background: var(--surface-modal-scrim);
}
.app-editor-dialog {
  display: flex;
  flex-direction: column;
  width: min(620rem, 100%);
  height: min(639rem, 100%);
  min-height: 0;
  overflow: hidden;
  background-color: var(--surface-modal);
  border: 1px solid var(--ui-border-control);
  border-radius: 16rem;
  box-shadow: 0 22rem 56rem rgba(0, 0, 0, 0.28);
}
.app-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  min-height: 42rem;
  padding: 0 12rem 0 16rem;
  border-bottom: 1px solid var(--ui-border-divider);
  color: var(--text-color);
  font-size: var(--fs-body);
  font-weight: 600;
}
.app-editor-close {
  display: grid;
  place-items: center;
  width: 26rem;
  height: 26rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: 22rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    transform 140ms var(--ease-standard);
}
.app-editor-close:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.app-editor-close:active {
  transform: scale(0.98);
}
.app-editor-modal-enter-active,
.app-editor-modal-leave-active {
  transition: opacity 180ms ease;
}
.app-editor-modal-enter-active .app-editor-dialog,
.app-editor-modal-leave-active .app-editor-dialog {
  transition:
    opacity 180ms ease,
    transform 240ms cubic-bezier(0.32, 0.72, 0, 1);
}
.app-editor-modal-enter-from,
.app-editor-modal-leave-to {
  opacity: 0;
}
.app-editor-modal-enter-from .app-editor-dialog,
.app-editor-modal-leave-to .app-editor-dialog {
  opacity: 0;
  transform: translateY(10rem) scale(0.985);
}
</style>
