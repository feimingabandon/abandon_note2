<script setup>
/**
 * ============================================================
 * SettingsApp.vue — 主窗口的设置页面（窗口 2 / 4）
 * ============================================================
 * 当用户点击主窗口的「设置」按钮时，主进程创建设置窗口并加载此组件。
 * 这里可以放置应用的各类设置项（主题、字体、快捷键等）。
 *
 * 透明窗口 + 毛玻璃背景，使用复合样式类构建 UI。
 *
 * 上一环 → settings-main.js   (Vue 实例挂载此组件)
 * 连接   → main/index.js      (窗口由主进程管理)
 */

// onMounted 是 Vue 3 的生命周期钩子，组件挂载到 DOM 后执行
// 类似 Java Swing 中组件 addNotify() 后的初始化，或 Vue 2 的 mounted()
import { onMounted } from 'vue'
import { useFontSizeEditor } from '../composables/useFontSize'
import { FONT_SIZE_MIN, FONT_SIZE_MAX } from '../utils/fontUtils'
import MacTitlebar from '../components/MacTitlebar.vue'
import ResizeHandles from '../components/ResizeHandles.vue'

/**
 * 使用字号编辑 composable
 * fontSize ref 绑定到滑动条/输入框，变化时自动更新本窗口预览 + IPC 通知主窗口
 */
const { fontSize } = useFontSizeEditor('setMainFontSize')

/**
 * 设置窗口打开时，从数据库拉取主窗口的持久化字号，同步到滑动条
 *
 * 为什么需要这一步？
 *   useFontSizeEditor 初始化时从 CSS 变量读取默认值（17），
 *   但用户上次可能已经调到了 20 并保存在数据库里。
 *   所以打开设置窗口时，需要从数据库读出 20，让滑动条显示在正确位置。
 *
 * async/await 说明：
 *   window.api.getWindowStyle() 是异步操作（需要通过 IPC 向主进程请求数据）
 *   async 表示这个函数内部有异步操作
 *   await 表示等待异步操作完成后再继续执行下一行
 *   类似 Java 中 Future.get() 阻塞等待结果（但 JS 的 await 不会阻塞 UI 线程）
 */
onMounted(async () => {
  try {
    // 'main' 表示读取主窗口组的样式配置
    const styles = await window.api.getWindowStyle('main')

    // styles.font_size 是字符串（如 '20'），Number() 转为数字
    // 只有数据库中确实有 font_size 记录时才更新滑动条
    if (styles && styles.font_size) {
      fontSize.value = Number(styles.font_size)
    }
  } catch (err) {
    // 首次启动数据库无记录时，静默使用默认值，不影响用户体验
    console.warn('[SettingsApp] 读取持久化字号失败:', err)
  }
})
</script>

<template>
  <div class="window-frame glass">
    <!-- 窗口缩放手柄 -->
    <ResizeHandles />

    <!-- 苹果风格标题栏 -->
    <MacTitlebar title="设置" />

    <main class="settings-body">
      <!-- 字体大小设置 — 使用 card 复合样式 -->
      <div class="card settings-card">
        <h3 class="settings-card-title">字体大小</h3>
        <div class="font-size-control">
          <input
            type="range"
            :min="FONT_SIZE_MIN"
            :max="FONT_SIZE_MAX"
            :step="1"
            v-model.number="fontSize"
            class="slider"
          />
          <div class="font-input-wrapper">
            <input
              type="number"
              :min="FONT_SIZE_MIN"
              :max="FONT_SIZE_MAX"
              v-model.number="fontSize"
              class="input font-input"
            />
            <span class="font-unit">rem</span>
          </div>
        </div>
        <p class="font-preview">预览文字 — The quick brown fox（{{ fontSize }}rem）</p>
      </div>

      <!-- 外观设置 -->
      <div class="card settings-card">
        <h3 class="settings-card-title">外观</h3>
        <label class="settings-option">
          <input class="checkbox" type="checkbox" />
          <span>暗色主题（开发中）</span>
        </label>
      </div>

      <!-- 通用设置 -->
      <div class="card settings-card">
        <h3 class="settings-card-title">通用</h3>
        <label class="settings-option">
          <input class="checkbox" type="checkbox" />
          <span>开机自启动（开发中）</span>
        </label>
      </div>
    </main>
  </div>
</template>

<style scoped>
/**
 * ============================================================
 * 主设置窗口私有样式
 * ============================================================
 * 窗口根容器使用 base.css 的 .window-frame 复合样式，
 * 标题栏使用 MacTitlebar 公共组件，其余为本窗口私有样式。
 */

/* 设置主体区域 */
.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--sp-5) var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

/* 设置卡片标题 */
.settings-card-title {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--color-text-2);
  margin-bottom: var(--sp-3);
}

/* 设置选项行（复选框 + 标签） */
.settings-option {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
  cursor: pointer;
  padding: var(--sp-1) 0;
}

/* ============================================================
 * 字体大小设置区域
 * ============================================================ */
.font-size-control {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}

.font-size-control .slider {
  flex: 1;
}

/* 数字输入框容器 */
.font-input-wrapper {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

/* 数字输入框 — 覆盖 .input 的 width:100%，设为固定宽度 */
.font-input {
  width: 50rem;
  padding: var(--sp-2) var(--sp-2);
  font-size: var(--fs-caption);
  text-align: center;
}

/* rem 单位标签 */
.font-unit {
  font-size: var(--fs-caption);
  color: var(--color-text-3);
}

/* 预览文字 */
.font-preview {
  margin-top: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  background: var(--color-bg-mute);
  border-radius: var(--radius-sm);
  font-size: var(--fs-body);
  color: var(--color-text-2);
}
</style>
