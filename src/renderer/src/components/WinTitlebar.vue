<script setup>
/**
 * ============================================================
 * WinTitlebar.vue — Windows 风格标题栏（公共组件）
 * ============================================================
 * Windows 经典的右侧三按钮标题栏：
 *   ─  最小化
 *   □  最大化 / 还原
 *   ✕  关闭
 *
 * 整个标题栏可拖拽移动窗口（-webkit-app-region: drag）。
 * 按钮和插槽区域设为 no-drag，保证点击事件正常响应。
 *
 * Props：
 *   title — 标题文字（可选，默认不显示）
 *
 * Slots：
 *   default — 标题旁的自定义操作区域
 *
 * 使用示例：
 *   <WinTitlebar title="灵动岛设置">
 *     <span class="subtitle">专属设置</span>
 *   </WinTitlebar>
 *
 * 类比 Java Swing：
 *   相当于 Windows LAF 下的 JFrame 标题栏，
 *   右上角固定放关闭/最大化/最小化按钮。
 */

defineProps({
  title: {
    type: String,
    default: ''
  }
})

/** 窗口控制 — 通过 preload 暴露的 IPC API 调用主进程 */
const close = () => window.api.closeWindow()
const minimize = () => window.api.minimizeWindow()
const maximize = () => window.api.maximizeWindow()
</script>

<template>
  <header class="win-titlebar">
    <!-- 左侧：标题 + 插槽 -->
    <div class="win-titlebar-left">
      <span v-if="title" class="win-titlebar-title">{{ title }}</span>
      <slot />
    </div>

    <!-- 右侧：窗口控制按钮 -->
    <div class="win-controls">
      <button class="win-btn win-btn-minimize" @click="minimize" title="最小化">
        <span>─</span>
      </button>
      <button class="win-btn win-btn-maximize" @click="maximize" title="最大化">
        <span>□</span>
      </button>
      <button class="win-btn win-btn-close" @click="close" title="关闭">
        <span>✕</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
/**
 * ============================================================
 * Windows 风格标题栏样式
 * ============================================================
 */

/* 标题栏整体 — 可拖拽区域 */
.win-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0 0 var(--sp-4);
  -webkit-app-region: drag;
  flex-shrink: 0;
}

/* 左侧内容区 */
.win-titlebar-left {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  -webkit-app-region: no-drag;
  padding: var(--sp-2) 0;
}

/* 标题文字 */
.win-titlebar-title {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--color-text-1);
}

/* ----------------------------------------------------------
 * Windows 控制按钮组（右侧）
 * ----------------------------------------------------------
 * Windows 风格：矩形按钮紧贴窗口右上角，无圆角。
 * hover 时背景变亮，关闭按钮 hover 变红。
 * ---------------------------------------------------------- */
.win-controls {
  display: flex;
  -webkit-app-region: no-drag;
}

/* 单个控制按钮 */
.win-btn {
  width: 46rem;
  height: 32rem;
  border: none;
  background: transparent;
  color: var(--color-text-2);
  font-size: var(--fs-caption);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color var(--duration-fast) var(--ease-default),
    color var(--duration-fast) var(--ease-default);
  border-radius: 0;
}

.win-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
  color: var(--color-text-1);
}

/* 关闭按钮 — hover 变红（Windows 经典行为） */
.win-btn-close:hover {
  background-color: #e81123;
  color: #fff;
}

.win-btn:active {
  opacity: 0.7;
}
</style>
