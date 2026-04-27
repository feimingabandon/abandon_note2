<script setup>
/**
 * ============================================================
 * IslandSettingsApp.vue — 灵动岛的设置页面（窗口 4 / 4）
 * ============================================================
 * 当用户点击灵动岛窗口的「设置」按钮时，主进程创建设置窗口并加载此组件。
 * 可以放置灵动岛专属的配置项（如位置、大小、透明度等）。
 *
 * 上一环 → island-settings-main.js  (Vue 实例挂载此组件)
 * 连接   → main/index.js            (窗口由主进程管理)
 */
</script>

<template>
  <div class="settings-container">
    <h2>灵动岛设置</h2>
    <p>灵动岛窗口的专属设置面板。在此添加您的配置选项。</p>

    <div class="settings-section">
      <h3>显示</h3>
      <label>
        <input type="checkbox" /> 置顶显示（开发中）
      </label>
      <label>
        <input type="checkbox" /> 半透明模式（开发中）
      </label>
    </div>

    <div class="settings-section">
      <h3>行为</h3>
      <label>
        <input type="checkbox" /> 鼠标悬停时展开（开发中）
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
  margin-top: 6px;
  font-size: 14px;
  cursor: pointer;
}
</style>
