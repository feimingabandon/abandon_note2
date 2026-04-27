<script setup>
/**
 * ============================================================
 * IslandApp.vue — 灵动岛窗口（窗口 3 / 4）
 * ============================================================
 * 用户点击主窗口的「灵动岛」按钮后，主窗口关闭、本窗口打开。
 * 包含「回到主窗口」和「设置」两个操作按钮。
 *
 * 上一环 → island-main.js     (Vue 实例挂载此组件)
 * 下一环 → main/index.js      (通过 window.api 切换窗口)
 */

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
</script>

<template>
  <div class="island-container">
    <div class="island-pill">
      <span class="island-icon">🏝️</span>
      <span class="island-title">灵动岛</span>
    </div>

    <div class="island-actions">
      <button class="island-btn" @click="switchToMain">
        ← 回到主窗口
      </button>
      <button class="island-btn" @click="openSettings">
        设置
      </button>
    </div>
  </div>
</template>

<style scoped>
.island-container {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 16px;
  gap: 24px;
  color: var(--color-text);
}

.island-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: var(--ev-c-black-mute);
  border-radius: 24px;
  font-size: 18px;
  font-weight: 600;
}

.island-icon {
  font-size: 24px;
}

.island-actions {
  display: flex;
  gap: 10px;
}

.island-btn {
  padding: 8px 18px;
  border: 1px solid var(--ev-c-gray-1);
  border-radius: 16px;
  background: var(--ev-c-gray-3);
  color: var(--ev-c-text-1);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s;
}

.island-btn:hover {
  background: var(--ev-c-gray-2);
}
</style>
