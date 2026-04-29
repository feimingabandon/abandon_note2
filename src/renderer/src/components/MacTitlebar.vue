<script setup>
/**
 * ============================================================
 * MacTitlebar.vue — 苹果风格标题栏（公共组件）
 * ============================================================
 * macOS 经典的"红绿灯"标题栏：
 *   🔴 红色 = 关闭窗口
 *   🟡 黄色 = 最小化窗口
 *   🟢 绿色 = 最大化 / 还原窗口
 *
 * 整个标题栏可拖拽移动窗口（-webkit-app-region: drag）。
 * 按钮和插槽区域设为 no-drag，保证点击事件正常响应。
 *
 * Props：
 *   title — 标题文字（可选，默认不显示）
 *
 * Slots：
 *   default — 右侧自定义操作区域（如设置按钮、切换窗口按钮等）
 *
 * 使用示例：
 *   <MacTitlebar title="便签">
 *     <button class="btn-ghost" @click="openSettings">⚙ 设置</button>
 *   </MacTitlebar>
 *
 * 类比 Java Swing：
 *   相当于一个 TitleBarPanel extends JPanel，
 *   左侧固定放红绿灯按钮，右侧通过 add(Component) 动态添加内容。
 */

/**
 * defineProps — Vue 3 组合式 API 的属性声明
 * 类似 Java 中构造函数的参数定义
 * 父组件通过 <MacTitlebar title="xxx"> 传入
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
  <header class="mac-titlebar">
    <!-- 红绿灯按钮组（左侧） -->
    <div class="traffic-lights">
      <button class="light light-close" @click="close" title="关闭">
        <span class="light-icon">✕</span>
      </button>
      <button class="light light-minimize" @click="minimize" title="最小化">
        <span class="light-icon">−</span>
      </button>
      <button class="light light-maximize" @click="maximize" title="最大化">
        <span class="light-icon">＋</span>
      </button>
    </div>

    <!-- 标题文字（居中或左侧，可选） -->
    <span v-if="title" class="mac-titlebar-title">{{ title }}</span>

    <!-- 右侧插槽 — 父组件注入自定义按钮 -->
    <div class="mac-titlebar-actions">
      <slot />
    </div>
  </header>
</template>

<style scoped>
/**
 * ============================================================
 * 苹果风格标题栏样式
 * ============================================================
 */

/* 标题栏整体 — 可拖拽区域 */
.mac-titlebar {
  display: flex;
  align-items: center;
  padding: var(--sp-3) var(--sp-4);
  -webkit-app-region: drag;
  flex-shrink: 0;
  gap: var(--sp-3);
}

/* ----------------------------------------------------------
 * 红绿灯按钮组
 * ----------------------------------------------------------
 * macOS 风格：三个 12px 小圆圈紧密排列，hover 时显示图标。
 * 默认纯色圆圈，鼠标悬停后圆圈内显示对应的符号（✕ − ＋）。
 * ---------------------------------------------------------- */
.traffic-lights {
  display: flex;
  gap: var(--sp-2);
  -webkit-app-region: no-drag;
}

/* 单个小圆灯基础样式 */
.light {
  width: 12rem;
  height: 12rem;
  border-radius: 50%;
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity var(--duration-fast) var(--ease-default);
}

/* 圆灯内的符号 — 默认隐藏，hover 时显示 */
.light-icon {
  font-size: 8rem;
  line-height: 1;
  color: rgba(0, 0, 0, 0.5);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

/* 鼠标悬停到任意一个灯上时，三个灯的图标都显示（macOS 行为） */
.traffic-lights:hover .light-icon {
  opacity: 1;
}

/* 三色 — macOS 标准交通灯色值 */
.light-close    { background-color: #ff5f57; }
.light-minimize { background-color: #febc2e; }
.light-maximize { background-color: #28c840; }

/* hover 强调 */
.light-close:hover    { background-color: #ff4136; }
.light-minimize:hover { background-color: #f5a623; }
.light-maximize:hover { background-color: #1db954; }

/* 标题文字 */
.mac-titlebar-title {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--color-text-2);
  flex: 1;
  /* macOS 标题栏标题通常居中，但在有左右内容时左对齐更实用 */
}

/* 右侧自定义操作区（插槽容器） */
.mac-titlebar-actions {
  display: flex;
  gap: var(--sp-2);
  -webkit-app-region: no-drag;
}
</style>
