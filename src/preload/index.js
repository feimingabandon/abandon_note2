/**
 * ============================================================
 * 链路第 2 环：preload 脚本 — 主进程与渲染进程的桥梁
 * ============================================================
 * 该文件在 BrowserWindow 创建时被注入（由 main/index.js 中
 * webPreferences.preload 指定），在渲染进程加载任何网页内容
 * 之前执行。它运行在拥有 Node.js 和 DOM 双重访问权限的上下
 * 文中，是 Electron 实现安全 IPC 通信的关键。
 *
 * 上一环 → src/main/index.js       (主进程创建窗口并注入 preload)
 * 下一环 → src/renderer/index.html (HTML 加载后渲染进程开始运行)
 *
 * ============================================================
 * 四个窗口共用一个 preload：
 *   主窗口、主窗口设置、灵动岛、灵动岛设置
 *   都通过本文件暴露的 window.api 与主进程通信
 * ============================================================
 */

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/**
 * ============================================================
 * 自定义 API 集合 — 暴露给渲染进程的窗口操作能力
 * ============================================================
 * 每个方法对应一个 IPC 通道，与 main/index.js 中的
 * ipcMain.on(...) 一一匹配。
 */
const api = {
  // ---- 窗口控制（关闭 / 最小化 / 最大化） ----
  // 由标题栏组件调用，主进程通过 event.sender 自动识别是哪个窗口

  /** 关闭当前窗口 */
  closeWindow: () => ipcRenderer.send('window-close'),

  /** 最小化当前窗口 */
  minimizeWindow: () => ipcRenderer.send('window-minimize'),

  /** 切换最大化 / 还原 */
  maximizeWindow: () => ipcRenderer.send('window-maximize'),

  // ---- 窗口缩放（自定义 resize 手柄） ----

  /**
   * 获取当前窗口的矩形区域 { x, y, width, height }
   * 由 ResizeHandles 组件在 mousedown 时调用，记录缩放起始状态
   * @returns {Promise<{x:number, y:number, width:number, height:number}>}
   */
  getWindowBounds: () => ipcRenderer.invoke('window-get-bounds'),

  /**
   * 设置当前窗口的矩形区域（位置 + 尺寸）
   * 由 ResizeHandles 组件在 mousemove 时高频调用，实时更新窗口大小
   * @param {{x:number, y:number, width:number, height:number}} bounds
   */
  setWindowBounds: (bounds) => ipcRenderer.send('window-set-bounds', bounds),

  // ---- 窗口切换 ----

  /**
   * 打开主窗口的设置窗口
   * 由主窗口「设置」按钮调用
   */
  openMainSettings: () => ipcRenderer.send('open-main-settings'),

  /**
   * 切换到灵动岛窗口（关闭主窗口，打开灵动岛）
   * 由主窗口「灵动岛」按钮调用
   */
  switchToIsland: () => ipcRenderer.send('open-island'),

  /**
   * 切换回主窗口（关闭灵动岛，打开主窗口）
   * 由灵动岛窗口「回到主窗口」按钮调用
   */
  switchToMain: () => ipcRenderer.send('open-main'),

  /**
   * 打开灵动岛的设置窗口
   * 由灵动岛窗口「设置」按钮调用
   */
  openIslandSettings: () => ipcRenderer.send('open-island-settings'),

  /**
   * 设置主窗口的字体大小（rem 值）
   * 由主窗口设置页面的字体滑动条调用
   * → 主进程收到后转发给主窗口渲染进程
   * @param {number} size - 字体大小（rem 值，如 14）
   */
  setMainFontSize: (size) => ipcRenderer.send('set-main-font-size', size),

  /**
   * 设置灵动岛窗口的字体大小（rem 值）
   * 由灵动岛设置页面的字体滑动条调用
   * → 主进程收到后转发给灵动岛渲染进程
   * @param {number} size - 字体大小（rem 值，如 14）
   */
  setIslandFontSize: (size) => ipcRenderer.send('set-island-font-size', size),

  /**
   * 监听字号更新事件（由目标窗口的渲染进程调用）
   * 主进程转发字号后，渲染进程通过此方法接收并应用
   * @param {Function} callback - 回调函数，参数为 (event, size)
   * @returns {Function} 清理函数，调用即可移除监听器
   */
  onFontSizeChanged: (callback) => {
    ipcRenderer.on('font-size-changed', callback)
    return () => ipcRenderer.removeListener('font-size-changed', callback)
  },

  /**
   * 查询某个窗口类型的持久化样式配置
   *
   * 这是一个异步接口（返回 Promise），渲染进程需要用 await 等待结果：
   *   const styles = await window.api.getWindowStyle('main')
   *   // styles = { font_size: '20', theme: 'dark' } 或 {}
   *
   * ipcRenderer.invoke() 会向主进程发送请求并等待返回值，
   * 类似 Java 中 HttpClient 发送 HTTP 请求并等待响应。
   * 对应主进程的 ipcMain.handle('get-window-style', ...) 处理器。
   *
   * @param {string} windowType - 窗口类型：'main'（主窗口组）或 'island'（灵动岛组）
   * @returns {Promise<Object>} 样式键值对，如 { font_size: '20' }
   */
  getWindowStyle: (windowType) => ipcRenderer.invoke('get-window-style', windowType)
}

/**
 * ============================================================
 * 安全检查：根据是否开启 contextIsolation 选择不同方式暴露 API
 * ============================================================
 * contextIsolation 开启时（推荐）：
 *   通过 contextBridge.exposeInMainWorld 安全地将 API 挂载到
 *   渲染进程的 window 对象上，以此隔离 preload 与网页的 JS 上下文。
 *
 * contextIsolation 关闭时：
 *   直接挂载到 window，兼容旧模式（不推荐）。
 */
if (process.contextIsolated) {
  try {
    // 暴露 electron API（包含 ipcRenderer、process.versions 等）
    contextBridge.exposeInMainWorld('electron', electronAPI)

    // 暴露自定义窗口操作 API，渲染进程通过 window.api.xxx() 调用
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
