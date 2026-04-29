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
 *
 * reactive() 是 Vue 3 的响应式 API，将普通对象包装成响应式对象。
 *   类比 Vue 2：相当于在 data() { return { versions: {...} } } 中声明。
 *   类比 Java：相当于一个被 @Observable 标注的 POJO，属性变化时自动通知视图更新。
 *
 * ...window.electron.process.versions — ES6 展开运算符
 *   将 versions 对象的所有属性展开并复制到新对象中。
 *   类比 Java：相当于 new HashMap<>(originalMap)，即浅拷贝。
 *
 * window.electron.process.versions 的来源：
 *   preload/index.js 通过 contextBridge 将 electronAPI 暴露到 window.electron，
 *   其中包含 process.versions 属性，记录了各运行时的版本号：
 *   - electron  : Electron 版本
 *   - chrome    : Chromium 内核版本（Electron 内置的浏览器引擎）
 *   - node      : Node.js 版本（Electron 内置的 JS 运行时）
 *   - v8        : V8 引擎版本（未显示）
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
