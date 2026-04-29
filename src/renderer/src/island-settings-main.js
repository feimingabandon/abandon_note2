/**
 * ============================================================
 * 链路第 4 环（灵动岛设置分支）：Vue 应用启动入口 — island-settings-main.js
 * ============================================================
 * 此文件是灵动岛设置页的 JS 入口，由 island-settings.html 中的
 * <script type="module" src="/src/island-settings-main.js"> 加载执行。
 *
 * 在 Electron 链路中的位置：
 *   主进程 createIslandSettingsWindow()
 *   → island-settings.html 被加载
 *   → 本文件被执行
 *   → IslandSettingsApp.vue 被挂载并渲染
 *
 * 类比 Java：
 *   相当于灵动岛设置模块的 main() 方法，是该窗口 Vue 应用的引导程序。
 *   类似 Spring Boot 中 @SpringBootApplication 标注的启动类。
 *
 * 上一环 → src/renderer/island-settings.html               (HTML 加载并执行此模块)
 * 下一环 → src/renderer/src/views/IslandSettingsApp.vue     (Vue 根组件)
 */

// 导入全局样式（main.css 内部 @import 了 base.css）
// 确保灵动岛设置窗口也拥有与主窗口相同的基础样式和响应式字体
import './assets/main.css'

// createApp 是 Vue 3 的应用创建函数
// 类比 Vue 2：new Vue({ render: h => h(App) }).$mount('#app')
import { createApp } from 'vue'
import IslandSettingsApp from './views/IslandSettingsApp.vue'

/**
 * 创建 Vue 3 应用实例，以 IslandSettingsApp.vue 为根组件，
 * 挂载到 island-settings.html 中的 <div id="app"> 元素上。
 *
 * .mount('#app') — 将 Vue 组件树渲染到 DOM 中
 *   类似 Vue 2 的 .$mount('#app')
 *   类似 Java Swing 的 frame.setVisible(true)
 */
createApp(IslandSettingsApp).mount('#app')
