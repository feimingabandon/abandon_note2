<script setup>
/**
 * ============================================================
 * 链路第 5 环：Vue 根组件 — App.vue（主窗口，窗口 1 / 4）
 * ============================================================
 * main.js 将此组件作为 createApp 的根组件挂载。
 * 它是主窗口的 UI 起点，包含：
 *   - 设置按钮 → openMainSettings() → 弹出设置窗口
 *   - 灵动岛按钮 → switchToIsland()  → 关闭主窗口，打开灵动岛
 *
 * 上一环 → src/renderer/src/main.js  (Vue 实例创建并挂载此组件)
 * 下一环 → Versions.vue              (子组件，显示 Electron 版本信息)
 *        → main/index.js            (通过 IPC 与主进程通信)
 */

import Versions from './components/Versions.vue'

/**
 * 打开主窗口的设置窗口
 * 调用 preload 暴露的 window.api.openMainSettings()
 * → 触发 IPC 'open-main-settings' → main/index.js 中 createMainSettingsWindow()
 */
const openSettings = () => window.api.openMainSettings()

/**
 * 切换到灵动岛窗口
 * 调用 preload 暴露的 window.api.switchToIsland()
 * → 触发 IPC 'open-island' → main/index.js 先创建灵动岛窗口再关闭本窗口
 */
const switchToIsland = () => window.api.switchToIsland()
</script>

<template>
  <!-- Electron 标志图片 -->
  <img alt="logo" class="logo" src="./assets/electron.svg" />

  <!-- 构建工具标识 -->
  <div class="creator">主窗口 — Powered by electron-vite</div>

  <!-- 主标语 -->
  <div class="text">
    Build an Electron app with
    <span class="vue">Vue</span>
  </div>

  <!-- 调试提示 -->
  <p class="tip">Please try pressing <code>F12</code> to open the devTool</p>

  <!-- 操作按钮区 -->
  <div class="actions">
    <div class="action">
      <!-- 文档链接：target="_blank" 会被 setWindowOpenHandler 拦截，转由系统浏览器打开 -->
      <a href="https://electron-vite.org/" target="_blank" rel="noreferrer">Documentation</a>
    </div>
    <div class="action">
      <!-- 设置按钮：不加 target="_blank"，避免被 Electron 窗口拦截器误处理 -->
      <a @click="openSettings">设置</a>
    </div>
    <div class="action">
      <!-- 灵动岛按钮：点击后切换窗口 -->
      <a @click="switchToIsland">灵动岛</a>
    </div>
  </div>

  <!-- 版本信息子组件 -->
  <Versions />
</template>
