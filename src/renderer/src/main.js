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
import { createApp } from 'vue' // Vue 3 应用创建函数
import App from './App.vue' // 根组件

// 创建 Vue 应用实例并挂载到 index.html 中 id="app" 的 DOM 节点
createApp(App).mount('#app')
