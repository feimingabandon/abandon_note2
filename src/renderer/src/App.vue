<script setup>
/**
 * ============================================================
 * App.vue — 主窗口（窗口 1 / 4）
 * ============================================================
 * 主窗口的 UI 起点，包含：
 *   - 窗口拖拽区域（-webkit-app-region: drag，替代原生标题栏）
 *   - 设置按钮 → openMainSettings()
 *   - 灵动岛按钮 → switchToIsland()
 *   - 复合样式案例展示区（按钮/卡片/徽章/输入框/毛玻璃/分割线）
 *
 * 上一环 → src/renderer/src/main.js  (Vue 实例创建并挂载此组件)
 * 连接   → main/index.js            (通过 IPC 与主进程通信)
 */

import { useFontSizeListener } from './composables/useFontSize'
import MacTitlebar from './components/MacTitlebar.vue'
import ResizeHandles from './components/ResizeHandles.vue'

/**
 * 打开主窗口的设置窗口
 * → 触发 IPC 'open-main-settings' → main/index.js 中 createMainSettingsWindow()
 */
const openSettings = () => window.api.openMainSettings()

/**
 * 切换到灵动岛窗口
 * → 触发 IPC 'open-island' → main/index.js 先创建灵动岛窗口再关闭本窗口
 */
const switchToIsland = () => window.api.switchToIsland()

/**
 * 注册字号变更 IPC 监听 + 启动时从数据库恢复字号
 * 传入 'main' 表示这是主窗口组
 */
useFontSizeListener('main')
</script>

<template>
  <div class="window-frame glass">
    <!-- 窗口缩放手柄（8 方向隐形热区） -->
    <ResizeHandles />

    <!-- 苹果风格标题栏 + 插槽注入自定义按钮 -->
    <MacTitlebar title="便签">
      <button class="btn-ghost titlebar-btn" @click="openSettings">⚙ 设置</button>
      <button class="btn-dark titlebar-btn" @click="switchToIsland">🏝️ 灵动岛</button>
    </MacTitlebar>

    <!-- ============================================================
         复合样式案例展示区
         ============================================================ -->
    <main class="showcase">
      <!-- 按钮系统 -->
      <section class="showcase-section">
        <h3 class="showcase-title">按钮系统</h3>
        <div class="showcase-row">
          <button class="btn-primary">主要按钮</button>
          <button class="btn-dark">深色按钮</button>
          <button class="btn-outline">描边按钮</button>
          <button class="btn-ghost">幽灵按钮</button>
        </div>
        <div class="showcase-row">
          <button class="btn-primary" disabled>禁用态</button>
          <button class="btn-dark" disabled>禁用态</button>
          <button class="btn-outline" disabled>禁用态</button>
        </div>
      </section>

      <hr class="divider" />

      <!-- 卡片 -->
      <section class="showcase-section">
        <h3 class="showcase-title">卡片组件</h3>
        <div class="showcase-cards">
          <div class="card">
            <h4>普通卡片</h4>
            <p>使用 .card 类，柔和背景 + 大圆角，无边框无阴影。</p>
          </div>
          <div class="card card-elevated">
            <h4>浮起卡片</h4>
            <p>使用 .card-elevated，增加阴影层次感。</p>
          </div>
        </div>
      </section>

      <hr class="divider" />

      <!-- 徽章 -->
      <section class="showcase-section">
        <h3 class="showcase-title">徽章标签</h3>
        <div class="showcase-row">
          <span class="badge">默认</span>
          <span class="badge badge-accent">强调</span>
          <span class="badge badge-danger">危险</span>
          <span class="badge badge-success">成功</span>
        </div>
      </section>

      <hr class="divider" />

      <!-- 输入控件 -->
      <section class="showcase-section">
        <h3 class="showcase-title">输入控件</h3>
        <input class="input" type="text" placeholder="文本输入框 — 点击查看聚焦效果" />
        <div class="showcase-slider-row">
          <span class="showcase-label">滑动条</span>
          <input class="slider" type="range" min="0" max="100" value="50" />
        </div>
        <label class="showcase-checkbox-row">
          <input class="checkbox" type="checkbox" checked />
          <span>复选框示例</span>
        </label>
      </section>

      <hr class="divider" />

      <!-- 毛玻璃 -->
      <section class="showcase-section">
        <h3 class="showcase-title">毛玻璃面板</h3>
        <div class="showcase-glass-demo">
          <div class="glass-demo-panel glass">
            暗色毛玻璃 .glass
          </div>
          <div class="glass-demo-panel glass-light">
            亮色毛玻璃 .glass-light
          </div>
        </div>
      </section>

      <hr class="divider" />

      <!-- 字号层级 -->
      <section class="showcase-section">
        <h3 class="showcase-title">字号层级</h3>
        <p class="demo-display">Display 超大标题</p>
        <p class="demo-h1">H1 一级标题</p>
        <p class="demo-h2">H2 二级标题</p>
        <p class="demo-h3">H3 三级标题</p>
        <p class="demo-body">Body 正文 — 默认阅读文字</p>
        <p class="demo-caption">Caption 辅助文字</p>
        <p class="demo-micro">Micro 极小文字</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
/**
 * ============================================================
 * 主窗口私有样式
 * ============================================================
 * 窗口根容器使用 base.css 的 .window-frame 复合样式，
 * 标题栏使用 MacTitlebar 公共组件，其余为本窗口私有样式。
 */

/* 插槽内按钮的尺寸微调 */
.titlebar-btn {
  font-size: var(--fs-caption);
  padding: var(--sp-2) var(--sp-3);
}

/* ----------------------------------------------------------
 * 案例展示区（可滚动的内容主体）
 * ---------------------------------------------------------- */
.showcase {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--sp-5) var(--sp-5);
}

.showcase-section {
  margin-bottom: var(--sp-3);
}

.showcase-title {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--color-text-2);
  margin-bottom: var(--sp-3);
}

.showcase-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.showcase-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4);
}

.showcase-cards h4 {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  margin-bottom: var(--sp-2);
}

.showcase-cards p {
  font-size: var(--fs-caption);
  color: var(--color-text-2);
  line-height: var(--lh-normal);
}

/* 输入控件展示 */
.showcase-slider-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-3);
}

.showcase-slider-row .slider {
  flex: 1;
}

.showcase-label {
  font-size: var(--fs-caption);
  color: var(--color-text-2);
  white-space: nowrap;
}

.showcase-checkbox-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
  font-size: var(--fs-body);
  cursor: pointer;
}

/* 毛玻璃演示 */
.showcase-glass-demo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4);
}

.glass-demo-panel {
  padding: var(--sp-5);
  border-radius: var(--radius-lg);
  font-size: var(--fs-caption);
  text-align: center;
}

/* 字号层级演示 */
.demo-display { font-size: var(--fs-display); font-weight: var(--fw-semibold); line-height: var(--lh-tight); letter-spacing: var(--ls-tight); }
.demo-h1      { font-size: var(--fs-h1);      font-weight: var(--fw-semibold); line-height: var(--lh-tight); }
.demo-h2      { font-size: var(--fs-h2);      font-weight: var(--fw-semibold); line-height: var(--lh-snug); }
.demo-h3      { font-size: var(--fs-h3);      font-weight: var(--fw-semibold); line-height: var(--lh-snug); }
.demo-body    { font-size: var(--fs-body);     color: var(--color-text-1); }
.demo-caption { font-size: var(--fs-caption);  color: var(--color-text-2); }
.demo-micro   { font-size: var(--fs-micro);    color: var(--color-text-3); }
</style>
