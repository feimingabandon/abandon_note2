<script setup>
/**
 * App.vue — 应用根组件
 *
 * 职责：
 *   1. 在组件挂载时从数据库加载持久化的用户设置（字体缩放、背景色、透明度等）
 *   2. 将设置值应用为 CSS 自定义属性（CSS Variables），驱动全局样式
 *   3. 处理磨砂玻璃效果（backdrop-filter）的开关
 *   4. 渲染完成后通知主进程显示窗口（避免白屏闪烁）
 *
 * 组件结构：
 *   .app-root（根容器，flex 纵向布局，充满视口）
 *     ├── ResizeHandles（八方向缩放手柄，覆盖在最上层）
 *     ├── MacTitlebar（自定义标题栏，含红绿灯按钮）
 *     └── main.content（主内容区域，可滚动）
 */

import { onMounted, onUnmounted } from 'vue'
import MacTitlebar from './components/MacTitlebar.vue' // 自定义 Mac 风格标题栏
import ResizeHandles from './components/ResizeHandles.vue' // 自定义窗口缩放手柄

/** 窗口标识，与数据库中存储的 window_name 对应 */
const WINDOW_NAME = 'main'

onMounted(async () => {
  // 获取 HTML 根元素，用于设置 CSS 自定义属性
  const el = document.documentElement

  try {
    // === 拉取 CSS 类型的持久化设置 ===
    // 从数据库获取 type='css' 的所有设置项
    const cssSettings = await window.api.getSettings(WINDOW_NAME, 'css')
    cssSettings.forEach(({ key, value }) => {
      if (key === 'font_scale') {
        // 字体缩放因子，影响全局 rem 计算（tokens.css 中 html font-size 使用此变量）
        el.style.setProperty('--font-scale', value)
      } else if (key === 'bg_color') {
        // 背景颜色（RGB 格式，如 "255 255 255"）
        el.style.setProperty('--bg-color', value)
      } else if (key === 'bg_opacity') {
        // 背景透明度（0~1）
        el.style.setProperty('--bg-opacity', value)
      } else if (key === 'text_color') {
        // 文字颜色
        el.style.setProperty('--text-color', value)
      }
    })

    // === 拉取系统类型的持久化设置 ===
    const systemSettings = await window.api.getSettings(WINDOW_NAME, 'system')
    // 查找磨砂玻璃效果的开关设置
    const glassRow = systemSettings.find((s) => s.key === 'css_glass')
    if (glassRow && glassRow.value === 'true') {
      // 启用磨砂效果：设置模糊半径变量
      el.style.setProperty('--bg-blur', '24px')
      // 直接操作 .app-bg 元素，应用 backdrop-filter 磨砂效果
      const appBgEl = document.querySelector('.app-bg')
      if (appBgEl) {
        appBgEl.style.webkitBackdropFilter = 'saturate(180%) blur(24px)' // Safari/旧版兼容
        appBgEl.style.backdropFilter = 'saturate(180%) blur(24px)' // 标准属性
      }
    }
  } catch (err) {
    // 读取失败时使用 CSS 中定义的默认值，不影响应用正常运行
    console.warn('[App] 读取持久化设置失败，使用默认值:', err)
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
    <ResizeHandles />
    <!-- Mac 风格标题栏，包含红绿灯按钮和标题文字 -->
    <MacTitlebar title="便签">
      <!-- 设置和帮助按钮组 -->
      <div class="titlebar-actions-group">
        <!-- 设置按钮 -->
        <button class="titlebar-btn titlebar-btn-settings" title="设置">
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
  </div>
</template>

<style scoped>
/* 根容器：flex 纵向布局，充满整个视口高度 */
.app-root {
  position: relative; /* 为 ResizeHandles 的 absolute 定位提供参考 */
  display: flex;
  flex-direction: column; /* 纵向排列：标题栏 → 内容区 */
  height: 100vh; /* 占满视口高度 */
  border-radius: 12px; /* 圆角边框，配合 transparent 窗口实现圆角窗口 */
  overflow: hidden; /* 裁剪超出圆角的内容 */
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
}
</style>
