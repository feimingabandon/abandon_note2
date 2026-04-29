<script setup>
/**
 * ============================================================
 * IslandApp.vue — 灵动岛窗口（窗口 3 / 4）
 * ============================================================
 * 用户点击主窗口的「灵动岛」按钮后，主窗口关闭、本窗口打开。
 * 包含「回到主窗口」和「设置」两个操作按钮。
 *
 * 透明窗口 + 毛玻璃效果，整个窗口看起来像一个浮动胶囊。
 *
 * 上一环 → island-main.js     (Vue 实例挂载此组件)
 * 下一环 → main/index.js      (通过 window.api 切换窗口)
 */

import { useFontSizeListener } from '../composables/useFontSize'
import ResizeHandles from '../components/ResizeHandles.vue'

/**
 * 切换回主窗口
 * → 触发 IPC 'open-main' → 主进程创建主窗口，关闭灵动岛
 */
const switchToMain = () => window.api.switchToMain()

/**
 * 打开灵动岛的设置窗口
 * → 触发 IPC 'open-island-settings' → 主进程创建设置窗口
 */
const openSettings = () => window.api.openIslandSettings()

/**
 * 注册字号变更 IPC 监听 + 启动时从数据库恢复字号
 * 传入 'island' 表示这是灵动岛组，从 window_styles 表中读取 window_type='island' 的配置
 */
useFontSizeListener('island')
</script>

<template>
  <!-- 整个灵动岛是一个毛玻璃胶囊 -->
  <div class="window-frame glass">
    <!-- 窗口缩放手柄 -->
    <ResizeHandles />

    <!-- 拖拽区域 + 标题 -->
    <div class="island-drag">
      <span class="island-icon">🏝️</span>
      <span class="island-title">灵动岛</span>
    </div>

    <!-- 操作按钮（no-drag 区域，可点击） -->
    <div class="island-actions">
      <button class="btn-ghost island-btn" @click="switchToMain">← 主窗口</button>
      <button class="btn-dark island-btn" @click="openSettings">⚙ 设置</button>
    </div>
  </div>
</template>

<style scoped>
/**
 * ============================================================
 * 灵动岛窗口私有样式
 * ============================================================
 * 基础框架使用 base.css 的 .window-frame（纵向 + 圆角 + 溢出裁剪），
 * 这里覆写为横向胶囊布局。
 */

/* 覆写 .window-frame 默认的纵向布局为横向胶囊
 * flex-direction: row — 图标、标题、按钮水平排列
 * border-radius: pill — 胶囊形（两端半圆）
 * overflow: visible — 胶囊不需要裁剪溢出 */
.window-frame {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-5);
  border-radius: var(--radius-pill);
  overflow: visible;
  gap: var(--sp-5);
}

/* 拖拽区域 — 用户可以按住这里移动整个灵动岛窗口 */
.island-drag {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  -webkit-app-region: drag;
  flex: 1;
}

.island-icon {
  font-size: var(--fs-h3);
}

.island-title {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--color-text-1);
}

/* 按钮区域 — no-drag 让按钮可以正常点击 */
.island-actions {
  display: flex;
  gap: var(--sp-2);
  -webkit-app-region: no-drag;
}

/* 按钮尺寸微调 */
.island-btn {
  font-size: var(--fs-caption);
  padding: var(--sp-2) var(--sp-3);
}
</style>
