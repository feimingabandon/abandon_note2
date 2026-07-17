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
 *     ├── MacTitlebar（自定义标题栏，含红绿灯按钮）
 *     └── main.content（主内容区域，可滚动）
 */

import { ref, onMounted, onUnmounted } from 'vue'
import MacTitlebar from './components/system/MacTitlebar.vue' // 自定义 Mac 风格标题栏
import ResizeHandles from './components/system/ResizeHandles.vue' // 自定义窗口缩放手柄
import SettingsPanel from './components/system/SettingsPanel.vue' // 底部弹出式设置面板
import MessageToast from './components/system/MessageToast.vue'
import NoteList from './components/list/NoteList.vue'
import NoteEditor from './components/note/NoteEditor.vue'
import ActionBar from './components/list/ActionBar.vue'
import { createMessageProvider } from './composables/useMessage.js' // 消息能力注册
import { applySettingsSnapshot } from './utils/applySettingsSnapshot.js'
import { DEFAULT_SETTINGS } from '../../shared/settings-schema.js'

// 注册全局应用内消息通知能力（子孙组件通过 useMessage() 获取）
createMessageProvider()

/** 设置面板显隐状态 */
const showSettings = ref(false)
/** 与面板卸载动画解耦，使关闭动作开始时即可恢复底层清晰度。 */
const settingsBlurActive = ref(false)
/** 编辑弹窗沿用设置页策略：模糊底层场景，弹窗本身保持清晰。 */
const editorBlurActive = ref(false)
let editorBlurReleaseTimer = null

function openSettings() {
  settingsBlurActive.value = true
  showSettings.value = true
}

/** 当前选中的便签 */
const selectedNote = ref(null)
const noteEditorRef = ref(null)

/** NoteList 引用 */
const noteListRef = ref(null)

/** 窗口锁定状态 */
const locked = ref(DEFAULT_SETTINGS.window.lockState)

/** 窗口置顶状态 */
const alwaysOnTop = ref(DEFAULT_SETTINGS.window.alwaysOnTop)

let stopSettingsListener = null
let stopNotesChangedListener = null

function applyAppSettingsSnapshot(snapshot) {
  applySettingsSnapshot(snapshot)
  const windowSettings = snapshot?.values?.window
  if (windowSettings) {
    locked.value = windowSettings.lockState
    alwaysOnTop.value = windowSettings.alwaysOnTop
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

  // 通知主进程渲染已完成，可以安全地显示窗口了
  // 主进程收到后会调用 mainWindow.show()
  window.api.rendererReady()
})

// ---- 贴边隐藏：鼠标悬停检测 ----
const onMouseEnter = () => window.api.windowHover(true)
const onMouseLeave = () => window.api.windowHover(false)
document.addEventListener('mouseenter', onMouseEnter)
document.addEventListener('mouseleave', onMouseLeave)
// ---- 便签交互 ----
async function onEditNote(note) {
  if (!note?.id) return
  // 列表项是摘要数据；打开编辑器前重新读取完整记录，避免编辑旧标签或附件数据。
  const fullNote = await window.api.getNote(note.id)
  if (editorBlurReleaseTimer) {
    clearTimeout(editorBlurReleaseTimer)
    editorBlurReleaseTimer = null
  }
  editorBlurActive.value = true
  selectedNote.value = fullNote || note
}

function onCloseEditor() {
  selectedNote.value = null
  if (editorBlurReleaseTimer) clearTimeout(editorBlurReleaseTimer)
  // 让弹窗先开始退场，再恢复底层清晰度，避免视觉跳变。
  editorBlurReleaseTimer = setTimeout(() => {
    editorBlurReleaseTimer = null
    editorBlurActive.value = false
  }, 160)
}

function requestCloseEditor() {
  noteEditorRef.value?.requestClose?.()
}

async function onNoteSaved(updated) {
  if (updated?.id) await noteListRef.value?.refreshOne(updated)
  onCloseEditor()
}

async function onNoteUpdated(updated) {
  if (updated) selectedNote.value = updated
  if (updated?.id) await noteListRef.value?.refreshOne(updated)
}

async function onCreateNote() {
  noteListRef.value?.refresh()
}

onUnmounted(() => {
  stopSettingsListener?.()
  stopNotesChangedListener?.()
  document.removeEventListener('mouseenter', onMouseEnter)
  document.removeEventListener('mouseleave', onMouseLeave)
  if (editorBlurReleaseTimer) clearTimeout(editorBlurReleaseTimer)
})
</script>

<template>
  <!-- 应用根容器：同时承载背景样式（.app-bg）和布局（.app-root） -->
  <div class="app-root app-bg">
    <!-- 设置打开时，底层场景不可点击且不可获取键盘焦点。 -->
    <div
      class="app-scene"
      :class="{ 'is-settings-open': settingsBlurActive, 'is-editor-open': editorBlurActive }"
      :inert="showSettings || !!selectedNote"
    >
      <!-- 自定义缩放手柄，absolute 定位覆盖整个窗口，z-index 最高 -->
      <ResizeHandles :locked="locked" />
      <!-- Mac 风格标题栏，包含红绿灯按钮和标题文字 -->
      <MacTitlebar v-model:locked="locked" v-model:always-on-top="alwaysOnTop">
        <!-- 设置和帮助按钮组 -->
        <div class="titlebar-actions-group">
          <!-- 新增循环便签模板按钮（占位） -->
          <button class="titlebar-btn" title="新增循环便签模板">
            <svg class="btn-icon" viewBox="0 0 1024 1024">
              <path
                d="M 512 200 V 824"
                fill="none"
                stroke="currentColor"
                stroke-width="100"
                stroke-linecap="round"
              />
              <path
                d="M 200 512 H 824"
                fill="none"
                stroke="currentColor"
                stroke-width="100"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <!-- 设置按钮 -->
          <button
            class="titlebar-btn titlebar-btn-settings"
            title="设置"
            @click="openSettings"
          >
            <img class="btn-icon" src="@/resources/icons/settings.png" alt="设置" />
          </button>
          <!-- 帮助按钮（预留，暂未绑定功能） -->
          <button class="titlebar-btn titlebar-btn-help" title="帮助">
            <img class="btn-icon" src="@/resources/icons/help.svg" alt="帮助" />
          </button>
        </div>
      </MacTitlebar>
      <!-- 主内容区域，flex:1 占据剩余空间，支持垂直滚动 -->
      <main class="content">
        <!-- 操作栏（新建 + 搜索，双模切换） -->
        <ActionBar class="app-search" @create="onCreateNote" />

        <!-- 列表视图 -->
        <NoteList
          ref="noteListRef"
          class="app-list"
          @edit="onEditNote"
          @create="onCreateNote"
        />
      </main>
    </div>

    <!-- 便签编辑弹窗：复用 NoteEditor，底层列表保持可见但不可交互。 -->
    <Transition name="app-editor-modal">
      <div
        v-if="selectedNote"
        class="app-editor-overlay"
        role="presentation"
      >
        <section
          class="app-editor-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="修改便签"
        >
          <header class="app-editor-header">
            <span>修改便签</span>
            <button class="app-editor-close" aria-label="关闭编辑" title="关闭" @click="requestCloseEditor">×</button>
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
      @blur-release="settingsBlurActive = false"
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

/* 主界面独立成场景，便于模态设置面板统一隔离交互。 */
.app-scene {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  transition: filter 100ms ease-out;
}

/* 设置是模态界面：直接模糊已渲染好的底层场景，不再从透明窗口反向采样。 */
.app-scene.is-settings-open {
  filter: blur(var(--glass-blur-base));
  transition-duration: 180ms;
  will-change: filter;
}
.app-scene.is-editor-open {
  filter: blur(var(--glass-blur-base));
  transition-duration: 180ms;
  will-change: filter;
}

/* 标题栏按钮通用样式 */
.titlebar-btn {
  width: 18rem; /* 与红绿灯按钮大小一致 */
  height: 18rem;
  border: none;
  border-radius: 50%; /* 圆形，与红绿灯按钮一致 */
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
  background-color: #0071e3; /* 正常状态就是蓝色 */
}

/* 按钮图标 - 默认隐藏 */
.btn-icon {
  width: 14rem; /* 图标大小 */
  height: 14rem;
  opacity: 0; /* 默认隐藏 */
  transition: opacity 120ms ease;
  display: block; /* 确保正确居中 */
}

/* 悬停时显示图标 */
.titlebar-actions-group:hover .btn-icon {
  opacity: 1;
}

.titlebar-btn:active {
  transform: scale(0.9);
  transition-duration: 70ms;
}

/* 按钮组容器 */
.titlebar-actions-group {
  display: flex;
  gap: 8px;
}

/* 主内容区域 */
.content {
  flex: 1; /* 占据标题栏之外的所有剩余空间 */
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 自身不滚动，滚动权交给内部的便签列表 */
  padding: 16rem; /* 内边距，统一使用 rem 跟随窗口缩放 */
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
  z-index: 20000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 22rem;
  background: rgba(18, 20, 24, 0.04);
}
.app-editor-dialog {
  display: flex;
  flex-direction: column;
  width: min(620rem, 100%);
  height: min(620rem, 100%);
  min-height: 0;
  overflow: hidden;
  background-color: rgb(var(--bg-color) / var(--glass-opacity-base));
  border: 1px solid color-mix(in srgb, var(--text-color) 10%, transparent);
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
  border-bottom: 1px solid color-mix(in srgb, var(--text-color) 8%, transparent);
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
  transition: background-color 140ms ease, color 140ms ease, transform 140ms var(--ease-standard);
}
.app-editor-close:hover {
  background: color-mix(in srgb, var(--text-color) 9%, transparent);
  color: var(--text-color);
}
.app-editor-close:active { transform: scale(0.9); }
.app-editor-modal-enter-active,
.app-editor-modal-leave-active { transition: opacity 180ms ease; }
.app-editor-modal-enter-active .app-editor-dialog,
.app-editor-modal-leave-active .app-editor-dialog { transition: opacity 180ms ease, transform 240ms cubic-bezier(0.32, 0.72, 0, 1); }
.app-editor-modal-enter-from,
.app-editor-modal-leave-to { opacity: 0; }
.app-editor-modal-enter-from .app-editor-dialog,
.app-editor-modal-leave-to .app-editor-dialog { opacity: 0; transform: translateY(10rem) scale(0.985); }
</style>
