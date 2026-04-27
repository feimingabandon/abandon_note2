/**
 * ============================================================
 * 灵动岛窗口的 Vue 应用入口
 * ============================================================
 * 由 island.html 的 <script type="module"> 加载。
 * 根组件为 IslandApp.vue，渲染到 #app。
 */

import './assets/main.css'

import { createApp } from 'vue'
import IslandApp from './views/IslandApp.vue'

createApp(IslandApp).mount('#app')
