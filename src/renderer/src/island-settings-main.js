/**
 * ============================================================
 * 灵动岛设置窗口的 Vue 应用入口
 * ============================================================
 * 由 island-settings.html 的 <script type="module"> 加载。
 * 根组件为 IslandSettingsApp.vue，渲染到 #app。
 */

import './assets/main.css'

import { createApp } from 'vue'
import IslandSettingsApp from './views/IslandSettingsApp.vue'

createApp(IslandSettingsApp).mount('#app')
