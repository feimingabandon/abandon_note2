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

import { ref, watch, onMounted, onUnmounted } from 'vue'
import { applyFontSize, clampFontSize, readFontSizeFromCSS } from '../utils/fontUtils'

/**
 * 目标窗口用：监听 IPC 字号变更事件 + 启动时从数据库恢复字号
 *
 * 做两件事：
 *   1. 注册 IPC 监听器 — 实时接收设置窗口发来的字号变更
 *   2. 主动拉取持久化字号 — 启动时从数据库读取上次保存的字号并应用
 *
 * @param {string} windowType - 窗口类型：'main' 或 'island'
 *   主窗口传 'main'，灵动岛传 'island'
 *   对应数据库 window_styles 表的 window_type 字段
 *
 * 使用示例（App.vue / IslandApp.vue）：
 *   import { useFontSizeListener } from '@/composables/useFontSize'
 *   useFontSizeListener('main')    // 主窗口
 *   useFontSizeListener('island')  // 灵动岛
 */
export function useFontSizeListener(windowType) {
  let cleanup = null

  onMounted(async () => {
    // --- 第 1 步：注册 IPC 监听器，接收实时字号变更 ---
    const handler = (_event, size) => applyFontSize(size)
    cleanup = window.api.onFontSizeChanged(handler)

    // --- 第 2 步：从数据库拉取持久化字号并应用 ---
    // window.api.getWindowStyle() 是异步方法（返回 Promise），需要 await
    // 类似 Java 中 CompletableFuture.get() 等待异步结果
    try {
      const styles = await window.api.getWindowStyle(windowType)
      // styles 是一个对象，如 { font_size: '20' }
      // styles.font_size 是字符串，需要用 Number() 转成数字
      if (styles && styles.font_size) {
        applyFontSize(Number(styles.font_size))
      }
    } catch (err) {
      // 首次启动时数据库可能没有记录，此时静默使用 CSS 默认值
      console.warn('[useFontSize] 读取持久化字号失败，使用默认值:', err)
    }
  })

  onUnmounted(() => {
    if (cleanup) {
      cleanup()
      cleanup = null
    }
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
  /** 当前字号（rem 值），默认从 CSS 变量 --font-size-base-raw 读取 */
  const fontSize = ref(readFontSizeFromCSS())

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
