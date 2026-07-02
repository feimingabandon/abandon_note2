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
import MacTitlebar from './components/MacTitlebar.vue' // 自定义 Mac 风格标题栏
import ResizeHandles from './components/ResizeHandles.vue' // 自定义窗口缩放手柄
import SettingsPanel from './components/SettingsPanel.vue' // 底部弹出式设置面板
import MessageToast from './components/MessageToast.vue' // 消息弹窗（Apple 风格）
import { createMessageProvider } from './composables/useMessage.js' // 消息能力注册

// 注册全局消息通知能力（子孙组件通过 useMessage() 获取）
createMessageProvider()

/** 设置面板显隐状态 */
const showSettings = ref(false)

/** 窗口锁定状态 */
const locked = ref(false)

/** 窗口标识，与数据库中存储的 window_name 对应 */
const WINDOW_NAME = 'main'

onMounted(async () => {
  // 获取 HTML 根元素，用于设置 CSS 自定义属性
  const el = document.documentElement

  try {
    // === 拉取 CSS 类型的持久化设置 ===
    const cssSettings = await window.api.getSettings(WINDOW_NAME, 'css')
    cssSettings.forEach(({ key, value }) => {
      if (key === 'font_size_base') {
        el.style.setProperty('--font-size-base', value + 'rem')
      } else if (key === 'bg_color') {
        el.style.setProperty('--bg-color', value)
      } else if (key === 'win_opacity') {
        el.style.setProperty('--popup-opacity', value)
      } else if (key === 'bg_blur') {
        el.style.setProperty('--bg-blur', value)
      } else if (key === 'bg_border') {
        el.style.setProperty('--bg-border', value)
      } else if (key === 'text_color') {
        el.style.setProperty('--text-color', value)
      }
    })

    // 加载窗口圆角（来自系统模糊配置）
    try {
      const savedBlur = await window.api.getBlurConfig()
      if (savedBlur?.cornerRadius !== undefined) {
        el.style.setProperty('--window-radius', savedBlur.cornerRadius + 'px')
      }
    } catch (e) { /* 无模糊配置则使用 CSS 默认值 12px */ }
  } catch (err) {
    // 读取失败时使用 CSS 中定义的默认值，不影响应用正常运行
    console.warn('[App] 读取持久化设置失败，使用默认值:', err)
  }

  // 同步初始锁定状态
  try {
    locked.value = await window.api.getLockState()
  } catch (e) {
    console.warn('[App] 获取锁定状态失败:', e)
  }

  // 通知主进程渲染已完成，可以安全地显示窗口了
  // 主进程收到后会调用 mainWindow.show()
  window.api.rendererReady()
})

// ---- 贴边隐藏：鼠标悬停检测 ----
const onMouseEnter = () => window.api.windowHover(true)
const onMouseLeave = () => window.api.windowHover(false)
document.addEventListener('mouseenter', onMouseEnter)
document.addEventListener('mouseleave', onMouseLeave)
onUnmounted(() => {
  document.removeEventListener('mouseenter', onMouseEnter)
  document.removeEventListener('mouseleave', onMouseLeave)
})
</script>

<template>
  <!-- 应用根容器：同时承载背景样式（.app-bg）和布局（.app-root） -->
  <div class="app-root app-bg">
    <!-- 自定义缩放手柄，absolute 定位覆盖整个窗口，z-index 最高 -->
    <ResizeHandles :locked="locked" />
    <!-- Mac 风格标题栏，包含红绿灯按钮和标题文字 -->
    <MacTitlebar title="便签" v-model:locked="locked">
      <!-- 设置和帮助按钮组 -->
      <div class="titlebar-actions-group">
        <!-- 设置按钮 -->
        <button class="titlebar-btn titlebar-btn-settings" title="设置" @click="showSettings = true">
          <img class="btn-icon" src="@/resources/icons/settings.png" alt="设置" />
        </button>
        <!-- 帮助按钮 -->
        <button class="titlebar-btn titlebar-btn-help" title="帮助">
          <img class="btn-icon" src="@/resources/icons/help.png" alt="帮助" />
        </button>
      </div>
    </MacTitlebar>
    <!-- 主内容区域，flex:1 占据剩余空间，支持垂直滚动 -->
    <main class="content">
      <p>主页面内容区域</p>
    </main>

    <!-- 设置面板（底部弹出） -->
    <SettingsPanel v-model:visible="showSettings" />

    <!-- 消息弹窗（Apple 风格 Toast，固定顶部居中） -->
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
  border-radius: var(--window-radius, 12px); /* 用户可调的圆角，默认 12px */
  -electron-corner-smoothing: system-ui; /* macOS 连续曲率圆角，Win/Linux 自动为 0% */
  overflow: hidden; /* 裁剪超出圆角的内容 */
  box-shadow: none; /* 主窗口主动取消阴影 */

  /* 主窗口不使用 CSS 模糊（OS 已提供毛玻璃），覆写 .app-bg 的 backdrop-filter */
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}

/* 标题栏按钮通用样式 */
.titlebar-btn {
  width: 24rem; /* 与红绿灯按钮大小一致 */
  height: 24rem;
  border: none;
  border-radius: 50%; /* 圆形，与红绿灯按钮一致 */
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 150ms ease;
  background-color: #0071e3; /* 正常状态就是蓝色 */
}

/* 按钮图标 - 默认隐藏 */
.btn-icon {
  width: 18rem; /* 图标大小 */
  height: 18rem;
  opacity: 0; /* 默认隐藏 */
  transition: opacity 120ms ease;
  display: block; /* 确保正确居中 */
}

/* 悬停时显示图标 */
.titlebar-actions-group:hover .btn-icon {
  opacity: 1;
}

/* 按钮组容器 */
.titlebar-actions-group {
  display: flex;
  gap: 8px;
}

/* 主内容区域 */
.content {
  flex: 1; /* 占据标题栏之外的所有剩余空间 */
  padding: 16px; /* 内边距 */
  overflow-y: auto; /* 内容超出时显示垂直滚动条 */

  /* 阻止滚动链接：子元素滚到头不会导致父级抖动 */
  overscroll-behavior: contain;
}
</style>
