<script setup>
/**
 * ============================================================
 * SettingsApp.vue — 主窗口的设置页面（窗口 2 / 4）
 * ============================================================
 * 当用户点击主窗口的「设置」按钮时，主进程创建设置窗口并加载此组件。
 * 这里可以放置应用的各类设置项（主题、字体、快捷键等）。
 *
 * 上一环 → settings-main.js   (Vue 实例挂载此组件)
 * 连接   → main/index.js      (窗口由主进程管理)
 */
</script>

<template>
  <div class="settings-container">
    <h2>设置</h2>
    <p>主窗口的设置面板。在此添加您的配置选项。</p>

    <div class="settings-section">
      <h3>外观</h3>
      <label>
        <input type="checkbox" /> 暗色主题（开发中）
      </label>
    </div>

    <div class="settings-section">
      <h3>通用</h3>
      <label>
        <input type="checkbox" /> 开机自启动（开发中）
      </label>
    </div>
  </div>
</template>

<style scoped>
.settings-container {
  padding: 20px;
  color: var(--color-text);
}

h2 {
  margin-bottom: 10px;
  font-size: 20px;
}

.settings-section {
  margin-top: 20px;
  padding: 12px;
  border: 1px solid var(--ev-c-gray-1);
  border-radius: 8px;
}

.settings-section h3 {
  margin-bottom: 8px;
  font-size: 15px;
  color: var(--ev-c-text-2);
}

label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  cursor: pointer;
}
</style>
