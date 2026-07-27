/**
 * main.js — 渲染进程入口文件
 *
 * 职责：
 *   1. 导入全局样式文件（tokens.css 包含 CSS Reset + 变量 + 根字号）
 *   2. 创建 Vue 3 应用实例并挂载到 DOM
 *
 * 注意：此文件是 Vite 打包时渲染进程的入口点，
 * 对应 index.html 中的 <script type="module" src="./src/main.js">
 */

import './assets/tokens.css' // 导入全局基础样式（唯一的全局 CSS 文件）
import './utils/smoothScroll.js' // 导入全局速度驱动平滑滚动（一次性，全应用生效）
import { createApp } from 'vue' // Vue 3 应用创建函数
import App from './App.vue' // 根组件
import { DEFAULT_SETTINGS } from '../../shared/settings-schema.js'
import { applySettingsSnapshot } from './utils/applySettingsSnapshot.js'
import { installBrowserErrorCapture, installVueErrorCapture } from './utils/installErrorCapture.js'

// Vue 首次渲染前先应用共享默认值；App 挂载后再用数据库解析出的完整快照覆盖。
applySettingsSnapshot({ values: DEFAULT_SETTINGS })

// 在挂载前安装浏览器与 Vue 两层异常捕获，保证组件初始化阶段同样能够落盘。
const app = createApp(App)
installBrowserErrorCapture(window.api, { scope: 'main-renderer' })
installVueErrorCapture(app, window.api)
app.mount('#app')
