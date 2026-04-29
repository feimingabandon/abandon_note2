/**
 * ============================================================
 * 链路第 4 环（灵动岛分支）：Vue 应用启动入口 — island-main.js
 * ============================================================
 * 此文件是灵动岛窗口的 JS 入口，由 island.html 中的
 * <script type="module" src="/src/island-main.js"> 加载执行。
 *
 * 在 Electron 链路中的位置：
 *   主进程 createIslandWindow()
 *   → island.html 被加载
 *   → 本文件被执行
 *   → IslandApp.vue 被挂载并渲染
 *
 * 类比 Java：
 *   相当于灵动岛模块的 main() 方法，是该窗口 Vue 应用的引导程序。
 *   类似 Spring Boot 中 @SpringBootApplication 标注的启动类。
 *
 * 上一环 → src/renderer/island.html      (HTML 加载并执行此模块)
 * 下一环 → src/renderer/src/views/IslandApp.vue  (Vue 根组件)
 */

// 导入全局样式（main.css 内部 @import 了 base.css）
// 确保灵动岛窗口也拥有与主窗口相同的基础样式和响应式字体
import './assets/main.css'

// createApp 是 Vue 3 的应用创建函数
// 类比 Vue 2：new Vue({ render: h => h(App) }).$mount('#app')
import { createApp } from 'vue'
import IslandApp from './views/IslandApp.vue'

/**
 * 创建 Vue 3 应用实例，以 IslandApp.vue 为根组件，
 * 挂载到 island.html 中的 <div id="app"> 元素上。
 *
 * .mount('#app') — 将 Vue 组件树渲染到 DOM 中
 *   类似 Vue 2 的 .$mount('#app')
 *   类似 Java Swing 的 frame.setVisible(true)
 */
createApp(IslandApp).mount('#app')
