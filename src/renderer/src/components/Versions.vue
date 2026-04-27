<script setup>
/**
 * ============================================================
 * 链路第 6 环（终点）：Versions 子组件
 * ============================================================
 * 被 App.vue 引用，是组件树的叶子节点。
 * 从 preload 脚本注入的 window.electron.process.versions
 * 中读取版本号并展示，是完整的 Electron 通信链路终点。
 *
 * 上一环 → App.vue  (父组件，在此被 <Versions /> 引用)
 *
 * 数据流向回顾：
 *   Electron 运行时 → preload → window.electron → Versions.vue → UI 渲染
 */

import { reactive } from 'vue'

/**
 * 从 window.electron.process.versions 获取运行时版本信息。
 * 使用 reactive 包裹使其成为 Vue 响应式对象（实际上这些值在运行
 * 期间不会变化，但使用 reactive 是 Vue 推荐的数据管理方式）。
 *
 * window.electron.process.versions 包含：
 *   - electron  : Electron 版本
 *   - chrome    : Chromium 内核版本
 *   - node      : Node.js 版本
 *   - v8        : V8 引擎版本（未显示）
 *   - ...       : 其他底层库版本
 */
const versions = reactive({ ...window.electron.process.versions })
</script>

<template>
  <!-- 版本信息列表，固定在窗口底部 -->
  <ul class="versions">
    <li class="electron-version">Electron v{{ versions.electron }}</li>
    <li class="chrome-version">Chromium v{{ versions.chrome }}</li>
    <li class="node-version">Node v{{ versions.node }}</li>
  </ul>
</template>
