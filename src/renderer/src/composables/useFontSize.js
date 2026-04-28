/**
 * ============================================================
 * useFontSize.js — 字体大小 Vue Composable
 * ============================================================
 * 封装字体大小相关的 Vue 响应式逻辑，消除各窗口组件中的重复代码。
 *
 * 提供两种使用模式：
 *   1. useFontSizeListener() — 目标窗口使用（主窗口 / 灵动岛）
 *      注册 IPC 监听器，接收设置窗口发来的字号变更并应用
 *
 *   2. useFontSizeEditor(ipcMethod) — 设置窗口使用
 *      提供 fontSize ref + watch，变化时更新本窗口预览 + IPC 通知目标窗口
 *
 * 依赖 → utils/fontUtils.js（applyFontSize / clampFontSize / 常量）
 * 使用方 → App.vue / IslandApp.vue / SettingsApp.vue / IslandSettingsApp.vue
 */

import { ref, watch, onMounted } from 'vue'
import { applyFontSize, clampFontSize, FONT_SIZE_DEFAULT } from '../utils/fontUtils'

/**
 * 目标窗口用：监听 IPC 字号变更事件
 * 在 onMounted 中注册 window.api.onFontSizeChanged 回调，
 * 收到设置窗口发来的字号后调用 applyFontSize 更新本窗口 CSS 变量。
 *
 * 使用示例（App.vue / IslandApp.vue）：
 *   import { useFontSizeListener } from '@/composables/useFontSize'
 *   useFontSizeListener()
 */
export function useFontSizeListener() {
  onMounted(() => {
    window.api.onFontSizeChanged((_event, size) => applyFontSize(size))
  })
}

/**
 * 设置窗口用：提供字号编辑能力（ref + watch + IPC 通知）
 *
 * @param {string} ipcMethod - preload 中暴露的 IPC 发送方法名
 *   主窗口设置页传 'setMainFontSize'
 *   灵动岛设置页传 'setIslandFontSize'
 *
 * @returns {{ fontSize: import('vue').Ref<number> }}
 *   fontSize — 响应式字号值，绑定到滑动条 / 输入框的 v-model
 *
 * 使用示例（SettingsApp.vue）：
 *   import { useFontSizeEditor } from '@/composables/useFontSize'
 *   const { fontSize } = useFontSizeEditor('setMainFontSize')
 */
export function useFontSizeEditor(ipcMethod) {
  /** 当前字号（rem 值），默认 14 */
  const fontSize = ref(FONT_SIZE_DEFAULT)

  /**
   * 监听字号变化：
   *   1. 限制范围（clampFontSize）
   *   2. 更新本设置窗口的预览（applyFontSize）
   *   3. 通过 IPC 通知目标窗口同步字号
   */
  watch(fontSize, (newVal) => {
    const val = clampFontSize(newVal)
    fontSize.value = val

    // 更新本窗口预览
    applyFontSize(val)

    // 通过 IPC 通知目标窗口（主窗口 或 灵动岛）
    window.api[ipcMethod](val)
  })

  return { fontSize }
}
