/**
 * ============================================================
 * 设置窗口的 Vue 应用入口
 * ============================================================
 * 由 settings.html 的 <script type="module"> 加载。
 * 根组件为 SettingsApp.vue，渲染到 #app。
 */

import './assets/main.css'

import { createApp } from 'vue'
import SettingsApp from './views/SettingsApp.vue'

createApp(SettingsApp).mount('#app')
