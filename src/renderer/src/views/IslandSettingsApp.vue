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
import { useFontSizeEditor } from '../composables/useFontSize'
import { FONT_SIZE_MIN, FONT_SIZE_MAX } from '../utils/fontUtils'

/**
 * 使用字号编辑 composable
 * fontSize ref 绑定到滑动条/输入框，变化时自动更新本窗口预览 + IPC 通知灵动岛窗口
 */
const { fontSize } = useFontSizeEditor('setIslandFontSize')
</script>

<template>
  <div class="settings-container">
    <h2>灵动岛设置</h2>
    <p>灵动岛窗口的专属设置面板。在此添加您的配置选项。</p>

    <!-- 字体大小设置 -->
    <div class="settings-section">
      <h3>字体大小</h3>
      <div class="font-size-control">
        <input
          type="range"
          :min="FONT_SIZE_MIN"
          :max="FONT_SIZE_MAX"
          :step="1"
          v-model.number="fontSize"
          class="font-slider"
        />
        <div class="font-input-wrapper">
          <input
            type="number"
            :min="FONT_SIZE_MIN"
            :max="FONT_SIZE_MAX"
            v-model.number="fontSize"
            class="font-input"
          />
          <span class="font-unit">rem</span>
        </div>
      </div>
      <p class="font-preview">预览文字 — The quick brown fox（{{ fontSize }}rem）</p>
    </div>

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
/**
 * ============================================================
 * 灵动岛设置窗口样式（rem 响应式，W = 500）
 * ============================================================
 * 窗口 500px 时 1rem = 1px。
 * 1px 边框保留 px。
 */
.settings-container {
  padding: 20rem;
  color: var(--color-text);
}

h2 {
  margin-bottom: 10rem;
  font-size: var(--font-size-title);  /* 标题 */
}

.settings-section {
  margin-top: 20rem;
  padding: 12rem;
  border: 1px solid var(--ev-c-gray-1);
  border-radius: 8rem;
}

.settings-section h3 {
  margin-bottom: 8rem;
  font-size: var(--font-size-base);  /* 正文（小标题） */
  color: var(--ev-c-text-2);
}

label {
  display: flex;
  align-items: center;
  gap: 8rem;
  margin-top: 6rem;
  font-size: var(--font-size-caption);  /* 辅助文字（选项标签） */
  cursor: pointer;
}

/* ============================================================
 * 字体大小设置区域样式
 * ============================================================ */
.font-size-control {
  display: flex;
  align-items: center;
  gap: 12rem;
  margin-top: 8rem;
}

.font-slider {
  flex: 1;
  height: 6rem;
  -webkit-appearance: none;
  appearance: none;
  background: var(--ev-c-gray-3);
  border-radius: 3rem;
  outline: none;
  cursor: pointer;
}

.font-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16rem;
  height: 16rem;
  border-radius: 50%;
  background: #647eff;
  cursor: pointer;
}

.font-input-wrapper {
  display: flex;
  align-items: center;
  gap: 4rem;
}

.font-input {
  width: 50rem;
  padding: 4rem 6rem;
  border: 1px solid var(--ev-c-gray-1);
  border-radius: 4rem;
  background: var(--ev-c-gray-3);
  color: var(--ev-c-text-1);
  font-size: var(--font-size-caption);
  text-align: center;
  outline: none;
}

.font-input:focus {
  border-color: #647eff;
}

.font-unit {
  font-size: var(--font-size-caption);
  color: var(--ev-c-text-3);
}

.font-preview {
  margin-top: 10rem;
  padding: 8rem 12rem;
  background: var(--ev-c-gray-3);
  border-radius: 6rem;
  font-size: var(--font-size-base);
  color: var(--ev-c-text-2);
}
</style>
