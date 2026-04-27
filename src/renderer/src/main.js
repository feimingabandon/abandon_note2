/**
 * ============================================================
 * 链路第 4 环：Vue 应用启动入口
 * ============================================================
 * 此文件是渲染进程的 JS 入口，由 index.html 中的
 * <script type="module" src="/src/main.js"> 加载执行。
 * 它负责初始化 Vue 3 应用并将其挂载到 DOM 中。
 *
 * 上一环 → src/renderer/index.html  (HTML 加载并执行此模块)
 * 下一环 → src/renderer/src/App.vue  (Vue 根组件)
 */

// 导入全局样式（base.css + main.css），确保样式在整个应用中生效
import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'

/**
 * 创建 Vue 3 应用实例，以 App.vue 为根组件，
 * 挂载到 index.html 中的 <div id="app"> 元素上。
 * 此时开始执行 Vue 的组件树渲染，窗口界面正式呈现。
 */
createApp(App).mount('#app')
